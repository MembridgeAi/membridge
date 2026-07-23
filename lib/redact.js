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
  { name: 'slack-token', rx: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'anthropic-key', rx: /\bsk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: 'openai-key', rx: /\bsk-[A-Za-z0-9]{20,}/g },
  // Payment / mail / registry / OAuth secrets with distinctive prefixes (so the
  // regexes stay tight and false-positive-safe). Stripe SECRET/restricted keys
  // use sk_/rk_ (underscore) — distinct from openai's sk- above; the publishable
  // pk_ key is intentionally NOT matched (it is not a secret).
  { name: 'stripe-key', rx: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'stripe-webhook-secret', rx: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-oauth-secret', rx: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  { name: 'sendgrid-key', rx: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: 'npm-token', rx: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Incoming-webhook URLs carry their secret in the path, so the entropy backstop
  // (which skips path segments) would miss them — redact the whole URL by shape.
  { name: 'slack-webhook-url', rx: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: 'discord-webhook-url', rx: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  // Generic assignment: keep the key name, redact the value. Runs last, and
  // the (?!\[redacted:) guard stops it re-wrapping a marker from above.
  { name: 'secret-assignment', repl: '$1$2[redacted:secret-assignment]',
    rx: /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[=:]\s*)(?!\[redacted:)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi },
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

module.exports = { DEFAULT_PATTERNS, redactDefault, entropy };
