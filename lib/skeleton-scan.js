'use strict';
// Comment/string/template-aware brace counting for lib/skeleton-strip.js's
// brace balancer (see the "fail-closed on real mismatches" comment there for
// the incident this fixes). braceDelta() used to count every literal `{`/`}`
// character in a line, including ones sitting inside comments or string/
// template literals -- harmless back when a miscount only cost compression
// quality, but the openBraces stack it now feeds turns a single miscounted
// line into structurally wrong output for every line that follows. This
// module scans a line for the braces that actually matter to code
// structure, skipping regions that are line/block comments or quoted
// strings, while still counting braces INSIDE a `${...}` template
// interpolation, since those are real code (e.g. `${ fn({a: 1}) }`).
//
// No parser: a tiny state object carries just enough context between lines
// to tell "code" from "not code" one character at a time.

// Context-stack frame kinds (see scanLineBraces):
//   'template' -- inside a template literal's raw text (backtick string)
//   'expr'     -- inside the code of a `${ ... }` interpolation; opened by
//                 `${`, closed by the `}` that ends it -- neither of those
//                 two characters is a real brace pair
//   'brace'    -- an ordinary counted `{` awaiting its `}` (a plain
//                 top-level brace, or an object literal inside a template
//                 expression -- both count)

function createScanState() {
  return { stack: [], inBlockComment: false };
}

// Scans one line against carried-over state. Returns { opens, closes,
// mismatch, state }. `mismatch` is true only when a `}` arrives with no
// counted brace/expr frame to close -- genuinely unbalanced input, as
// opposed to a `}` sitting inside a comment/string/template that we
// correctly skipped without ever touching the stack.
function scanLineBraces(line, prevState) {
  const stack = prevState.stack.slice();
  let inBlockComment = prevState.inBlockComment;
  let opens = 0;
  let closes = 0;
  let mismatch = false;
  let stringQuote = null; // '\'' or '"' while skipping a quoted string; never carried across lines

  const top = () => stack[stack.length - 1];

  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (inBlockComment) {
      if (ch === '*' && line[i + 1] === '/') { inBlockComment = false; i += 2; continue; }
      i++; continue;
    }

    if (stringQuote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === stringQuote) stringQuote = null;
      i++; continue;
    }

    if (top() === 'template') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { stack.pop(); i++; continue; }
      if (ch === '$' && line[i + 1] === '{') { stack.push('expr'); i += 2; continue; }
      i++; continue;
    }

    // "code" mode: not inside a string, block comment, or a template's raw
    // text -- this also covers the code inside a `${...}` interpolation.
    if (ch === '/' && line[i + 1] === '/') break; // line comment: rest of line ignored
    if (ch === '#') break; // shell/python-style line comment
    if (ch === '/' && line[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === '\'' || ch === '"') { stringQuote = ch; i++; continue; }
    if (ch === '`') { stack.push('template'); i++; continue; }

    if (ch === '{') { stack.push('brace'); opens++; i++; continue; }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame === 'brace') closes++;
      else if (frame !== 'expr') mismatch = true; // stray `}`: nothing counted to close
      i++; continue;
    }
    i++;
  }

  return { opens, closes, mismatch, state: { stack, inBlockComment } };
}

module.exports = { createScanState, scanLineBraces };
