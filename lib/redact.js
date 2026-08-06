'use strict';
// Built-in secret redaction: a backstop so that even with an empty config,
// obvious credentials never reach an injected block, memory.md/json, the copy
// digest, or a team-sync push. This is defense in depth, NOT a guarantee —
// regexes and entropy heuristics miss novel shapes, so treat it as a safety
// net on top of not putting secrets in prompts, never as a reason to relax.
//
// Everything runs through digest.redactText, which layers these defaults
// (unless config.redactDefaults === false) under the user's config.redact and
// config.redactExtra patterns. Matches become [redacted:<name>].

// ---------------------------------------------------------------------------
// Pattern table. Order matters: specific credential formats first (so they
// carry a precise name), the generic key=value assignment LAST with a guard
// so it never re-redacts a marker an earlier pattern already produced.
// ---------------------------------------------------------------------------
const DEFAULT_PATTERNS = [
  // Whole PEM/OpenSSH private-key blocks (may span lines, or be flattened to
  // spaces by plainText before we see them).
  { name: 'private-key', rx: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  // JSON Web Tokens: header.payload.signature, both first parts base64url of a
  // JSON object (so they start with eyJ).
  { name: 'jwt', rx: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  // Credentials embedded in a URI — keep scheme+host, drop user:pass.
  //
  // The scheme is a SHAPE, not an allowlist. It used to name six database
  // schemes, which left http, https, ftp and every git transport uncovered:
  // `https://ci-bot:PW@github.com/acme/app.git` shipped verbatim. The reason
  // that survived review is worth keeping in mind — `git+https://x-token:PW@…`
  // IS redacted, but only by accident, because the USERNAME ends in "token"
  // and the secret-assignment pattern below fires on it. Any example built
  // from a realistic token-ish username passes while the general case leaks.
  //
  // `user:pass@` immediately after `://` is userinfo by definition (RFC 3986),
  // so matching any scheme adds no ambiguity and covers schemes nobody has
  // thought of yet. That is the direction this file should go generally:
  // protected by shape, exempt explicitly.
  { name: 'connection-uri', repl: '$1[redacted:credentials]@',
    rx: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/gi },
  // npmrc credentials. `_authToken` already matches the secret-assignment
  // pattern below (it ends in "token"); bare `_auth` — which carries a
  // base64 user:password — matches nothing there. Kept narrow deliberately:
  // broadening that pattern to the word "auth" would redact `auth: true` and
  // every `oauth_url=` in prose. A leading underscore makes this a config key,
  // not English.
  { name: 'npmrc-auth', repl: '$1[redacted:credentials]', rx: /\b(_auth\s*=\s*)\S+/gi },
  // Authorization header (consume the whole value, not just the scheme word)
  // and bare Bearer tokens elsewhere.
  { name: 'authorization', repl: '$1[redacted:authorization]', rx: /\b(Authorization\s*[:=]\s*)\S[^\r\n]*/gi },
  // Case-insensitive, like the authorization sibling above. It was /g, so a
  // lowercase `bearer <token>` — the spelling that appears in curl
  // transcripts, log lines and prose, outside any Authorization header —
  // matched nothing, and a token under 24 chars clears no entropy bar either.
  { name: 'bearer', repl: 'Bearer [redacted:bearer]', rx: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  // Cloud / provider key formats. AWS issues ASIA (STS/assume-role), ABIA and
  // ACCA alongside AKIA; all four are exactly 20 characters, which is BELOW
  // ENTROPY_MIN_LEN, so the backstop is structurally guaranteed not to cover
  // the ones this pattern misses.
  { name: 'aws-access-key', rx: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', rx: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat', rx: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'google-api-key', rx: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // xoxe- (refresh/rotation) and xapp- (app-level) were missing: xoxe fell
  // outside the [abprs] class and xapp does not start with "xox" at all.
  // xoxc- (browser session) and xoxd- (cookie) were the next two off the end
  // of the same class, and both are full-account credentials whose
  // digit-and-dash bodies sit well under the entropy bar.
  { name: 'slack-token', rx: /\bxox[abcdeprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'slack-app-token', rx: /\bxapp-[A-Za-z0-9-]{10,}\b/g },
  { name: 'anthropic-key', rx: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  // Real OpenAI keys are dash-bearing (sk-proj-..., sk-live-...) -- the old
  // alnum-only class missed them entirely, a genuine gap now that skeletons
  // derive from raw source where such keys actually appear. Allowing
  // internal dashes/underscores closes it; the \bsk- anchor plus a 20+ char
  // run still makes false positives on ordinary hyphenated prose unlikely,
  // since real sentences break the run with spaces long before 20 chars.
  { name: 'openai-key', rx: /\bsk-[A-Za-z0-9_-]{20,}/g },
  // Payment / mail / registry / OAuth secrets with distinctive prefixes (so the
  // regexes stay tight and false-positive-safe). Stripe SECRET/restricted keys
  // use sk_/rk_ (underscore) — distinct from openai's sk- above; the publishable
  // pk_ key is intentionally NOT matched (it is not a secret).
  { name: 'stripe-key', rx: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'stripe-webhook-secret', rx: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-oauth-secret', rx: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { name: 'sendgrid-key', rx: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: 'npm-token', rx: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Cloudflare user API tokens. Added after a live incident: a token pasted
  // into an agent session survived every layer here — no prefix rule matched
  // it, and the entropy backstop skips it because the mixed-case-and-digits
  // body sits behind an underscore-separated prefix that reads as a word.
  // Anyone deploying Workers or Pages from an agent will paste one of these
  // eventually, so shape-matching it is worth more than the backstop.
  { name: 'cloudflare-token', rx: /\bcfut_[A-Za-z0-9]{20,}/g },
  // Cloudflare Origin CA keys, same family, different shape.
  { name: 'cloudflare-origin-ca', rx: /\bv1\.0-[A-Za-z0-9-]{20,}/g },
  // Incoming-webhook URLs carry their secret in the path, so the entropy backstop
  // (which skips path segments) would miss them — redact the whole URL by shape.
  { name: 'slack-webhook-url', rx: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: 'discord-webhook-url', rx: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  // Credentials carried in a URL QUERY PARAMETER. Added after a live leak: a
  // sign-in callback of the form https://host/auth/cli?code=<uuid> reached
  // memory with every pattern above already running. Nothing caught it, and
  // each near-miss was deliberate:
  //   * no pattern named `code` at all, and the auth code has no prefix or
  //     shape of its own to match on;
  //   * the entropy backstop explicitly exempts UUIDs (looksLikeSecret's
  //     UUID_RX check, which exists so session ids survive) -- and the auth
  //     codes the sign-in flow actually mints are UUIDs, so the one layer
  //     that might have caught it was guaranteed not to;
  //   * a hex code clears no entropy bar either (hex tops out near 4.0 bits
  //     against a 4.5 threshold).
  // So this is shape-matching, not entropy: a value sitting behind a
  // credential-named query parameter is a credential whatever it looks like.
  //
  // It runs BEFORE secret-assignment on purpose. `?access_token=X&next=Y`
  // does match secret-assignment, but that pattern's value class ([^\s'"]+)
  // runs to the next SPACE, so it swallowed `&next=Y` and the rest of the
  // URL with it. Stopping at & and # instead keeps the URL readable, which
  // is the whole point of naming the parameter rather than nuking the line.
  //
  // Not matched, deliberately:
  //   * anything not in query position. The ([?&]) anchor is what keeps
  //     ordinary prose ("returns code=200", "set exit code=1", "error
  //     code=INTERNAL") out, since prose does not put a ? or & in front of
  //     the word. Matching a bare `code=` would fire on ordinary sentences.
  //   * values under 8 characters (`?code=ref`, `?code=42`) -- too short to
  //     be a credential and overwhelmingly likely to be a status, a flag, or
  //     a country code.
  //   * all-digit values of ANY length, via the (?![0-9]+...) lookahead, so
  //     a long numeric id or `?code=20000000` survives the length floor.
  //   * parameters that merely END in one of these names -- `?csrf_token=`
  //     is a public anti-forgery value, not a bearer credential, and the
  //     anchor requires the name to start immediately after the ? or &.
  //     (secret-assignment still covers it as a backstop.)
  // The (?!\[redacted:) guard leaves a marker an earlier, more specific
  // pattern already produced alone, so `?token=ghp_...` keeps the precise
  // github-token name rather than being relabelled here.
  { name: 'url-credential-param', repl: '$1$2[redacted:url-credential-param]',
    rx: /([?&])((?:access_token|token|code)=)(?!\[redacted:)(?![0-9]+(?:[&#\s'"]|$))[^&#\s'"<>]{8,}/gi },
  // Generic assignment: keep the key name, redact the value. The
  // (?!['"]?\[redacted:) guard stops it re-wrapping a marker from above —
  // including one wrapped in quotes by the carrier-phrase pattern below.
  //
  // The leading boundary is a lookbehind, NOT \b: \b does not match between
  // '_' and a letter, so every prefixed name sailed straight through —
  // DB_PASSWORD=, STRIPE_API_KEY=, GOOGLE_CLIENT_SECRET=, PGPASSWORD=, and
  // camelCase dbPassword — while the bare PASSWORD= was caught. High-entropy
  // values were still caught by the entropy backstop, so what leaked was
  // precisely the low-entropy secrets people paste into prompts. The optional
  // [A-Za-z0-9_.-]* prefix absorbs the qualifier; requiring an actual
  // assignment after it is what keeps prose about passwords untouched.
  // Value alternation captures the wrapping quote so it can be re-emitted:
  // `password: "hunter2corgi"` becomes `password: "[redacted:secret-assignment]"`,
  // not `password: [redacted:secret-assignment]` — Task 5C pinned the
  // quote-preserving convention. Bare (unquoted) values still just replace
  // with the marker as before.
  //
  // The `["']?` in group 2 is what makes the JSON form work. The value
  // alternation already handled a quoted VALUE, but nothing absorbed the
  // closing quote of the NAME, so the separator never sat immediately after
  // the name and the whole pattern missed. The practical effect was that
  // `PGPASSWORD=hunter2` was redacted while `{"password": "hunter2"}` was
  // not — and the JSON form is exactly what an agent's tool arguments, an MCP
  // server config and a pasted settings.json all look like. Absorbing the
  // quote into group 2 keeps it in the output, so the key stays readable.
  { name: 'secret-assignment',
    rx: /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret))(["']?\s*[=:]\s*)(?!['"]?\[redacted:)(?:(")([^"]*)"|(')([^']*)'|[^\s'"]+)/gi,
    repl: function (_match, key, sep, dq, dqVal, sq, sqVal) {
      const marker = '[redacted:secret-assignment]';
      if (dq) return `${key}${sep}${dq}${marker}${dq}`;
      if (sq) return `${key}${sep}${sq}${marker}${sq}`;
      return `${key}${sep}${marker}`;
    } },
  // Carrier-phrase: prose that INTRODUCES a secret, like
  //   the staging password is hunter2corgi
  //   password: "hunter2corgi"
  //   api key -> zzz-9999
  // Runs AFTER secret-assignment above on purpose — the tight `KEY=value`
  // form has its own marker ([redacted:secret-assignment]) and downstream
  // tests + docs already treat that name as authoritative for that shape.
  // Carrier's guard against re-wrapping a marker keeps them from colliding.
  //
  // Also defers to the high-entropy backstop (redactHighEntropy runs after
  // this whole table) for values that look like random blobs — that marker
  // [redacted:high-entropy] is more precise than [redacted:phrase] for a
  // shape that entropy alone would have caught, and downstream tests pin
  // that name.
  //
  // Skip-list on the captured value keeps ordinary prose alive:
  //   the password field is empty     — "empty" skip-listed
  //   the token is set                — "set"   skip-listed
  //   the secret is required          — "required" skip-listed
  // Plus a hard 4-character minimum on the value, since a 1-character
  // "secret" is never a secret and always readable prose.
  //
  // A function replacement (not a string template) is what makes the
  // skip-list, the length gate, the quote-preservation, and the deferral
  // to the entropy backstop possible in one place — redactDefault below
  // already tolerates a function repl.
  { name: 'carrier-phrase',
    rx: /\b(pwd|passwd|password|passphrase|secret|token|api[ _-]?key|apikey|access[ _-]?key|credential|creds|auth)(\s*(?:is|are|was|=|:|->|→)\s*)(?:"([^"\n\r]{1,200}?)"|'([^'\n\r]{1,200}?)'|(?!\[redacted:)([^\s"'\[][^\s"'\n\r]{1,100}))/gi,
    repl: function (_match, carrier, sep, dquoted, squoted, bare) {
      const value = dquoted != null ? dquoted : squoted != null ? squoted : bare;
      if (value == null) return _match;
      // 6-char minimum for the value. Anything below is either a stub
      // ("set", "kept", "yes") or a UI placeholder — never a real secret
      // worth mangling prose for. Bumped from 4 after a corpus audit
      // (scratchpad/carrier-fp.js) showed three false positives, all on
      // 4-character English verbs after "is" ("kept", "kept", "used").
      // A minimum of 6 kills the whole class deterministically.
      if (value.length < 6) return _match;
      // A skip-list value is prose about a secret's STATE, or an ordinary
      // English adverb/adjective/verb that happens to sit after "is".
      // Redacting these produces "the password field is [redacted:phrase]"
      // over "empty" or "obviously" over "obvious", which reads as a data
      // corruption bug — the same class of harm we're trying to prevent.
      //
      // The corpus audit turned up "obviously" as the sole ≥6-char FP; the
      // list below is that word plus the neighboring set of adverbs,
      // status words, and common verbs a reasonable person would write
      // right after "the token is" / "the auth is" in prose. Not
      // exhaustive — the length gate above is what stops the long tail.
      const SKIP = new Set([
        // status
        'empty', 'blank', 'required', 'wrong', 'incorrect', 'correct',
        'missing', 'null', 'undefined', 'unset',
        'valid', 'invalid', 'expired', 'active', 'inactive',
        'enabled', 'disabled', 'unavailable', 'available',
        'optional', 'mandatory',
        // handling verbs (found in the corpus)
        'obviously', 'obvious', 'separate', 'separately', 'entirely',
        'kept', 'stored', 'saved', 'shared', 'protected', 'given', 'known',
        'automatic', 'manual', 'default', 'configured',
        // transitions
        'always', 'never', 'sometimes', 'often', 'usually',
        'different', 'common', 'similar', 'identical',
      ]);
      if (SKIP.has(value.toLowerCase())) return _match;
      // Never re-wrap an existing marker. The alternation's own
      // (?!\[redacted:) covers the bare branch; the quoted branches need
      // this because a quote followed by a marker slips past it.
      if (value.startsWith('[redacted:')) return _match;
      // Defer to the entropy backstop when the value is a high-entropy blob
      // long enough to matter. redactHighEntropy runs after this whole
      // table; leaving these to it gives them the more precise
      // [redacted:high-entropy] marker (downstream tests pin that name).
      if (value.length >= ENTROPY_MIN_LEN && entropy(value) > ENTROPY_THRESHOLD) return _match;
      const marker = '[redacted:phrase]';
      if (dquoted != null) return `${carrier}${sep}"${marker}"`;
      if (squoted != null) return `${carrier}${sep}'${marker}'`;
      return `${carrier}${sep}${marker}`;
    },
  },
];

// ---------------------------------------------------------------------------
// Shannon entropy in bits per character.
// ---------------------------------------------------------------------------
function entropy(str) {
  const s = String(str);
  if (!s.length) return 0;
  const freq = Object.create(null);
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  let e = 0;
  for (const ch in freq) {
    const p = freq[ch] / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTROPY_MIN_LEN = 24;
const ENTROPY_THRESHOLD = 4.5; // bits/char; hex alphabets top out near 4.0, so
                               // only fuller base64-ish tokens clear this bar.

// A standalone high-entropy blob that is not obviously an identifier, path,
// SHA, or UUID. Deliberately conservative: false positives here would eat
// session ids, so anything ambiguous is left alone.
function looksLikeSecret(token, text) {
  if (token.length < ENTROPY_MIN_LEN) return false;
  if (/^[0-9a-f]{40}$/i.test(token) || /^[0-9a-f]{64}$/i.test(token)) return false; // git SHA / hash
  if (UUID_RX.test(token)) return false; // session ids and the like
  // There used to be a recurrence exemption here: a token appearing twice or
  // more was treated as "a recurring identifier, not a one-off credential" and
  // left in the clear. It inverted the incentive — a generated 40-character
  // key redacted when mentioned once and SHIPPED when mentioned twice, so
  // "here is the key: X, now use X" leaked while the terser version did not.
  // Echoing a secret is the most natural way to write about one.
  //
  // Removing it costs less than it looks. The identifier shapes it was
  // protecting are already exempt ABOVE and by shape rather than by
  // repetition: UUIDs (session ids, the case its comment named), 40- and
  // 64-char hex (git SHAs and hashes), and — in redactHighEntropy — path
  // segments and filenames. What remains is a repeated high-entropy base64-ish
  // blob that is not a UUID, not a hash, and not a path, and redacting that is
  // the behaviour a redaction tool should have.
  return entropy(token) > ENTROPY_THRESHOLD;
}

function redactHighEntropy(text) {
  return text.replace(/[A-Za-z0-9+/][A-Za-z0-9+/=_-]{23,}/g, (m, offset) => {
    const before = text[offset - 1] || '';
    const after = text.slice(offset + m.length);
    // A path segment (preceded by a separator, e.g. a URL path or a filesystem
    // path) or a filename (immediately followed by an extension) is not a secret.
    if (before === '/' || before === '\\') return m;
    if (/^\.[A-Za-z0-9]/.test(after)) return m;
    if (m.includes('/') && /\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/.test(m)) return m;
    return looksLikeSecret(m, text) ? '[redacted:high-entropy]' : m;
  });
}

// Apply every default pattern, then the entropy backstop. Pure string in,
// redacted string out.
function redactDefault(text) {
  let t = String(text);
  for (const p of DEFAULT_PATTERNS) {
    t = t.replace(p.rx, p.repl || `[redacted:${p.name}]`);
  }
  return redactHighEntropy(t);
}

// ---------------------------------------------------------------------------
// Home-directory / username scrubbing — TEAM BOUNDARY ONLY.
//
// DELIBERATELY NOT IN DEFAULT_PATTERNS. redactDefault runs on the LOCAL
// injected block, memory.md and the copy digest, where absolute paths are the
// product: an agent told "you edited ~/x" instead of the real path cannot open
// the file. The privacy problem is one-directional — a path that is useful at
// home is an identity disclosure once it crosses to a teammate and to the
// server, because `/Users/andrewbrown/...` names the human and their machine
// layout. So this is a separate export, applied by lib/teamsync.js entryToRow
// on the way OUT and nowhere else.
//
// The tail is kept and only the home prefix collapses to `~`: a teammate
// reading "~/.claude/settings.json" learns the useful part and not who you
// are. Windows keeps its own separator so the path still reads as a Windows
// path.
//
// A username is [^/\\<sep>] up to the next separator, quote or whitespace —
// the empty-name case (`/Users/` with nothing after) is excluded by the `+`,
// so the literal string "/Users/" in prose survives untouched.
// Windows names really do contain spaces ("C:\Users\Andrew Brown\..."), so the
// first Windows pattern takes everything up to the NEXT backslash — but only
// when there is one, which is what stops it from eating the rest of a sentence
// after a bare `C:\Users\bob`. The second is that bare case, space-free.
const HOME_PATTERNS = [
  { rx: /\b[A-Za-z]:\\Users\\[^\\/\r\n'"<>|:*?]+(?=\\)/g, repl: '~' },
  { rx: /\b[A-Za-z]:\\Users\\[^\\/\s'"<>|:*?]+/g, repl: '~' },
  // The lookbehind is what keeps URLs intact: `https://example.com/home/index.html`
  // has a host character immediately before the `/home`, a real filesystem path
  // never does (it follows whitespace, a quote, `=`, `(`, `file://`, or nothing).
  // Without it this scrub silently rewrote any URL carrying a /home/ or /Users/
  // path segment, which is a correctness bug wearing a privacy fix's clothes.
  { rx: /(?<![A-Za-z0-9._~-])\/(?:Users|home)\/[^/\\\s'"<>|:*?]+/g, repl: '~' },
];

// Also scrub the WSL/container shape /mnt/c/Users/<name> — same disclosure,
// different mount point. Kept separate so the two path families above stay
// readable.
const WSL_HOME_RX = /(?<![A-Za-z0-9._~-])\/mnt\/[a-z]\/Users\/[^/\\\s'"<>|:*?]+/gi;

function scrubHomePaths(text) {
  if (text == null) return text;
  let t = String(text).replace(WSL_HOME_RX, '~');
  for (const p of HOME_PATTERNS) t = t.replace(p.rx, p.repl);
  return t;
}

module.exports = { DEFAULT_PATTERNS, redactDefault, entropy, scrubHomePaths };
