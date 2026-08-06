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
  // Credentials embedded in a connection URI — keep scheme+host, drop user:pass.
  { name: 'connection-uri', repl: '$1[redacted:credentials]@',
    rx: /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/)[^\s:@/]+:[^\s:@/]+@/gi },
  // Authorization header (consume the whole value, not just the scheme word)
  // and bare Bearer tokens elsewhere.
  { name: 'authorization', repl: '$1[redacted:authorization]', rx: /\b(Authorization\s*[:=]\s*)\S[^\r\n]*/gi },
  { name: 'bearer', repl: 'Bearer [redacted:bearer]', rx: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g },
  // Cloud / provider key formats.
  { name: 'aws-access-key', rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', rx: /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-pat', rx: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'google-api-key', rx: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // xoxe- (refresh/rotation) and xapp- (app-level) were missing: xoxe fell
  // outside the [abprs] class and xapp does not start with "xox" at all.
  { name: 'slack-token', rx: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g },
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
  // Generic assignment: keep the key name, redact the value. Runs last, and
  // the (?!\[redacted:) guard stops it re-wrapping a marker from above.
  //
  // The leading boundary is a lookbehind, NOT \b: \b does not match between
  // '_' and a letter, so every prefixed name sailed straight through —
  // DB_PASSWORD=, STRIPE_API_KEY=, GOOGLE_CLIENT_SECRET=, PGPASSWORD=, and
  // camelCase dbPassword — while the bare PASSWORD= was caught. High-entropy
  // values were still caught by the entropy backstop, so what leaked was
  // precisely the low-entropy secrets people paste into prompts. The optional
  // [A-Za-z0-9_.-]* prefix absorbs the qualifier; requiring an actual
  // assignment after it is what keeps prose about passwords untouched.
  { name: 'secret-assignment', repl: '$1$2[redacted:secret-assignment]',
    rx: /(?<![A-Za-z0-9])([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret))(\s*[=:]\s*)(?!\[redacted:)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi },
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
  // Appears more than once in the surrounding text → a recurring identifier,
  // not a one-off credential.
  if (text.split(token).length - 1 >= 2) return false;
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
