# Runbook — move `membridge.app` DNS to Cloudflare

**Why:** `membridge.app` is on name.com nameservers, so Cloudflare cannot serve
any hostname under it. That blocks two things: the anonymous counters endpoint
(whose URL gets compiled into every shipped client, so the hostname choice is
close to permanent) and invite links, which currently live on `.me` — the domain
we already moved away from.

**Do it now rather than later.** The counters URL is baked into releases and old
installs never update it. Today, with essentially no installs, moving is free.
Once clients ship with a URL compiled in, "forever" starts.

**Risk: low, and unusually so.** The whole zone is 4 A records, 1 CNAME, 1 TXT.
**There are no MX records** — no email runs on this domain, which removes the
single most common way a nameserver move causes real damage.

---

## The zone as it stands (captured 2026-07-29)

```
membridge.app        A      185.199.108.153
membridge.app        A      185.199.109.153
membridge.app        A      185.199.110.153
membridge.app        A      185.199.111.153
membridge.app        TXT    "google-site-verification=021csjlwPNeBcA8Mf2vnA1zf4W6GoN2eAH_Y76hkPRY"

www.membridge.app    CNAME  mmelika.github.io.
```

The four A records are GitHub Pages. The `www` CNAME is the same site. The TXT
is Search Console verification — **losing it silently de-verifies the property**,
which matters given the indexing history on this domain.

Nameservers today: `ns1psw / ns2fkr / ns3gnv / ns4hmp .name.com`

---

## Before you start

Take a fresh baseline — the capture above could be stale by the time you do this:

```bash
scripts/dns-snapshot.sh membridge.app /tmp/dns-before.txt
```

That file is what makes the whole thing verifiable. Keep it.

---

## Steps

### 1. Add the zone in Cloudflare *without* changing nameservers

Cloudflare dashboard → **Add a site** → `membridge.app` → **Free** plan.

Cloudflare scans the existing zone and imports what it finds. **This import is
best-effort and can miss records.** That is the entire reason for the snapshot.

### 2. Check the imported records against the baseline — before switching

In Cloudflare → **DNS → Records**, confirm every line below exists:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `membridge.app` | 185.199.108.153 | **Proxied** |
| A | `membridge.app` | 185.199.109.153 | **Proxied** |
| A | `membridge.app` | 185.199.110.153 | **Proxied** |
| A | `membridge.app` | 185.199.111.153 | **Proxied** |
| CNAME | `www` | mmelika.github.io | **Proxied** |
| TXT | `membridge.app` | `google-site-verification=021csjlwPNeBcA8Mf2vnA1zf4W6GoN2eAH_Y76hkPRY` | n/a |

Add anything missing by hand. **Do not proceed until this table matches**, because
after the switch Cloudflare is authoritative and anything absent simply stops
existing.

> **On proxying:** orange-cloud the A and CNAME records. That is what lets
> Workers and Pages claim hostnames on this zone later — the entire point of the
> move. GitHub Pages works fine behind Cloudflare's proxy.

> **This actually happened, 2026-07-29.** Cloudflare's import did not merely
> miss records — it invented wrong ones. The zone came up with the apex and
> `www` both pointing at `91.195.240.94`, a **Sedo domain-parking IP**, and with
> the `google-site-verification` TXT record absent entirely. Had the nameservers
> been switched without checking, `membridge.app` would have started serving a
> parking page as caches expired, and Search Console would have silently
> de-verified.
>
> It was caught because the zone was queried directly at Cloudflare's own
> nameservers *before* propagation reached anyone:
>
> ```bash
> dig +noall +answer A membridge.app @camilo.ns.cloudflare.com
> dig +noall +answer TXT membridge.app @camilo.ns.cloudflare.com
> ```
>
> Do this. Public resolvers keep serving the old delegation for hours, which
> means the site looks fine long after the new zone is live and wrong. Asking
> Cloudflare's nameservers directly is the only way to see what is about to be
> served.
>
> One ordering detail from the cleanup: a name cannot hold both an A record and
> a CNAME, so the parking `www` A record must be **deleted before** the CNAME
> can be added. Cloudflare rejects it with "a record with that host already
> exists", which reads like a duplicate rather than a type conflict.

### 3. Set SSL mode to Full

Cloudflare → **SSL/TLS → Overview → Full**.

Not Flexible. Flexible makes Cloudflare talk to GitHub Pages over plain HTTP,
which GitHub redirects to HTTPS, which produces a redirect loop that looks like
the site is down. This is the single most common way this move goes wrong.

### 4. Change the nameservers at name.com

name.com → `membridge.app` → **Nameservers** → replace all four with the two
Cloudflare gives you on the zone's overview page.

Propagation is usually minutes; allow up to a few hours.

### 5. Verify

```bash
scripts/dns-snapshot.sh membridge.app /tmp/dns-after.txt
diff /tmp/dns-before.txt /tmp/dns-after.txt
```

**Expected diff:** the `NS` lines change to Cloudflare's, and the apex `A`
records change to Cloudflare proxy IPs (104.x / 172.67.x) because the records
are now proxied. **Nothing else should differ.** In particular:

- the TXT verification record must still be present, byte for byte
- both HTTP checks must still return `200` and `301`

If the TXT line vanished, re-add it before doing anything else.

### 6. Confirm the site actually serves

```bash
curl -sI https://membridge.app/ | head -3
curl -sI https://www.membridge.app/ | head -3
```

Apex should be `200`, `www` should redirect. If you get a redirect loop, go back
to step 3 — it is the SSL mode.

---

## Rollback

Set the nameservers at name.com back to the original four:

```
ns1psw.name.com
ns2fkr.name.com
ns3gnv.name.com
ns4hmp.name.com
```

name.com keeps the old zone, so this restores the previous state within the
propagation window. Nothing is destroyed by the move — it is reversible right up
until you delete records at name.com, which you should not do for at least a
week.

---

## After the move — what this unblocks

Once `membridge.app` is on Cloudflare:

1. **Counters endpoint.** Deploy `cloudflare/counters-worker` and route it at
   `counters.membridge.app`. Then create `lib/counters-backend.json`:

   ```json
   { "url": "https://counters.membridge.app" }
   ```

   Remember this URL is compiled into every release from that point on. It has
   to keep answering for as long as any client from that era is running.

2. **Invite links.** Move the join page to `join.membridge.app` and flip
   `JOIN_BASE` in `cloudflare/ops-dashboard/public/index.html`. Keep
   `join.membridge.me` answering too — any invite already sent points there.

3. **Optionally the ops panel.** `ops.membridge.me` works fine and there is a
   reasonable argument for keeping internal tooling off the brand domain
   entirely. No need to move it.

---

## What this does not change

The marketing site still lives in the `mmelika/membridge-site` GitHub Pages
repo and still deploys the same way. Cloudflare sits in front of it; it does not
replace it.
