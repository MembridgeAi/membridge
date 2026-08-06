'use strict';
// Source-scanning primitives shared by every tool here that reads JavaScript as
// TEXT: test/mutate.js and test/suites/checks-can-fail.test.js.
//
// SHARED BECAUSE THE DUPLICATE VERSION BROKE TWICE, THE SAME WAY. blankNonCode
// began life without a regex-literal arm. lib/redact.js:109 contains
//
//     rx: /([?&])(...)(?![0-9]+(?:[&#\s'"]|$))[^&#\s'"<>]{8,}/gi
//
// and the apostrophe inside that character class opened a "string" that
// swallowed the remaining 9k characters of the file. In mutate.js that yielded
// ZERO mutants and printed `0 killed, 0 SURVIVED` over a green baseline —
// indistinguishable from a clean result. It was fixed there.
//
// It was NOT fixed in checks-can-fail.test.js's private copy, because there was
// no reason to look at a second copy. The very next suite to contain a regex
// with a quote in it (test/suites/test-files-declare-themselves.test.js, whose
// require-scanner matches `(['"])`) parsed to zero checks, and the gate's own
// "finds every check in the files it scans" assertion went red — which is the
// only reason anyone noticed.
//
// So: one implementation, one place to fix, and the teeth for it live in
// checks-can-fail.test.js.
//
// NOT_RUN_BY_CI is NOT needed here: this file is require()d by a discovered
// suite, so it runs in CI as infrastructure.

// A `/` opens a regex when the previous significant character is an operator,
// an opening bracket, a comma, a colon, a semicolon, or the start of input —
// never an identifier, a literal, or a closing bracket, which mean division.
const REGEX_CAN_FOLLOW = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?',
  '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);

// Replace comments, string bodies and regex literals with spaces, PRESERVING
// offsets and line breaks, so callers can map any index back to a line number
// and can search for syntax without matching it inside prose.
//
// Length is an invariant: output.length === input.length. A desync means an
// unterminated construct swallowed the rest of the file, which is exactly how
// both failures above presented — so callers that care can assert it, and
// checks-can-fail.test.js does.
function blankNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSignificant = '\n';
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      const start = i;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      // Only consume the terminator if it is actually there; an unterminated
      // block comment must not add two characters that were never in the input.
      if (i < n) { out += '  '; i += 2; } else { void start; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q; i++;
      let closed = false;
      while (i < n) {
        if (src[i] === q) { closed = true; break; }
        if (src[i] === '\\') { out += ' '; i++; if (i >= n) break; }
        out += src[i] === '\n' ? '\n' : ' '; i++;
      }
      // Same rule as the block comment: emit the closing quote only if one was
      // found. Emitting it unconditionally is what made a mis-detected quote
      // cost exactly one character and desync every offset after it.
      if (closed) { out += q; i++; }
      lastSignificant = q;
      continue;
    }
    if (c === '/' && REGEX_CAN_FOLLOW.has(lastSignificant)) {
      out += ' '; i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += '  '; i += 2; continue; }
        if (ch === '\n') break;          // unterminated: bail rather than swallow the file
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { out += ' '; i++; break; }
        out += ' '; i++;
      }
      while (i < n && /[gimsuyd]/.test(src[i])) { out += ' '; i++; }
      lastSignificant = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    else if (c === '\n') lastSignificant = '\n';
    i++;
  }
  return out;
}

// Index of the `}` closing the `{` at openIdx, or -1.
function matchingBrace(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

module.exports = { blankNonCode, matchingBrace, REGEX_CAN_FOLLOW };
