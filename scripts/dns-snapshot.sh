#!/usr/bin/env bash
# Capture a domain's public DNS to a file, so a nameserver migration can be
# verified by DIFF rather than by memory.
#
# The failure this exists to prevent: Cloudflare auto-imports records when a
# zone is added, but the import is best-effort — it can silently miss records,
# and nobody notices until the thing that record pointed at stops working.
# Taking a snapshot BEFORE the move and again AFTER turns "looks fine" into a
# diff that is either empty or not.
#
#   scripts/dns-snapshot.sh membridge.app before.txt
#   # ... move nameservers, wait for propagation ...
#   scripts/dns-snapshot.sh membridge.app after.txt
#   diff before.txt after.txt      # NS lines should differ; nothing else should
#
# Queries 1.1.1.1 explicitly so a local resolver's cache (or a router that
# hijacks NXDOMAIN — see the AT&T gateway note in cloudflare/README.md) cannot
# quietly change the answer between runs.
set -euo pipefail

DOMAIN="${1:-}"
OUT="${2:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: $0 <domain> [output-file]" >&2
  exit 1
fi

RESOLVER="@1.1.1.1"

# Subdomains worth probing. A wildcard-free zone has no way to enumerate its
# own records over public DNS, so this is a fixed list of the names that
# actually matter: web, mail, and the verification records providers use.
SUBS="www mail smtp imap pop autodiscover autoconfig _dmarc _domainkey
      ops join counters api app docs blog cdn static assets mx1 mx2"

emit() { if [ -n "$OUT" ]; then echo "$1" >> "$OUT"; else echo "$1"; fi; }

[ -n "$OUT" ] && : > "$OUT"

emit "# DNS snapshot: $DOMAIN"
emit "# resolver: 1.1.1.1"
emit ""

# `dig +short` resolves through a CNAME and prints the target for EVERY type
# asked, so a CNAME'd name appears to have MX and TXT records it does not have.
# A baseline that invents records is worse than none — it makes the post-move
# diff noisy in exactly the places (mail, verification) that matter most. Parse
# the answer section and keep only records whose type actually matches.
query() {
  local name="$1" type="$2"
  # shellcheck disable=SC2086
  dig +noall +answer "$type" "$name" $RESOLVER 2>/dev/null \
    | awk -v t="$type" '$4 == t { $1=$2=$3=$4=""; sub(/^[ \t]+/, ""); print }' \
    | sort || true
}

emit "## apex"
for t in A AAAA CNAME MX TXT NS CAA; do
  ans=$(query "$DOMAIN" "$t")
  if [ -n "$ans" ]; then
    while IFS= read -r line; do emit "$DOMAIN	$t	$line"; done <<< "$ans"
  fi
done

emit ""
emit "## subdomains"
for s in $SUBS; do
  for t in A CNAME MX TXT; do
    ans=$(query "$s.$DOMAIN" "$t")
    if [ -n "$ans" ]; then
      while IFS= read -r line; do emit "$s.$DOMAIN	$t	$line"; done <<< "$ans"
    fi
  done
done

emit ""
emit "## reachability"
for host in "$DOMAIN" "www.$DOMAIN"; do
  code=$(curl -s -o /dev/null --max-time 15 -w "%{http_code}" "https://$host/" 2>/dev/null || echo "000")
  emit "https://$host/	HTTP	$code"
done

[ -n "$OUT" ] && echo "wrote $OUT" >&2
exit 0
