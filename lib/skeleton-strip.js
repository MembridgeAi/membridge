'use strict';
// Dependency-free, language-agnostic fallback skeleton extractor. Used
// directly for extensions lib/skeleton.js has no grammar for, and as the
// permanent fallback there when tree-sitter/wasm is unavailable. Zero
// requires beyond core Node so it carries no startup cost of its own —
// every recall-layer module can afford to load this eagerly.
//
// Strategy: a depth counter (brace nesting for most languages, leading
// indentation for python/yaml) decides which lines look like top-level
// structure (declarations, signatures, imports, top-level comments) worth
// keeping verbatim, and collapses everything deeper into a single `…`
// elision marker appended to the line that precedes the collapsed run.

const { createScanState, scanLineBraces } = require('./skeleton-scan');

const NUL = '\0';
const MAX_LINE_LEN = 2000;
const COMPRESSION_CEILING = 0.6; // ok requires output lines < 60% of input lines
const MARKER = '  …';

const INDENT_EXTS = new Set(['.py', '.yml', '.yaml']);

// Statement keywords that must never be mistaken for a declaration/signature
// even though they can look like one at a glance (`if (x) {` almost matches
// the generic "identifier(args) {" method-signature shape below).
const CONTROL_KEYWORDS_RX = /^(if|for|while|switch|catch|else|do|try|finally|return|throw|break|continue)\b/;

// Brace-language "is this depth<=1 line worth keeping" test: declarations,
// signatures, imports/exports, decorators, and comments. Deliberately loose —
// false positives here just mean slightly worse compression, not incorrect
// output, since anything kept is still real source text.
function isBraceSignatureLine(trimmed) {
  if (!trimmed) return false;
  if (CONTROL_KEYWORDS_RX.test(trimmed)) return false;
  if (/^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(function\b|class\b|interface\b|enum\b)/.test(trimmed)) return true;
  if (/^(export\s+)?type\s+[\w$]+\s*=/.test(trimmed)) return true;
  // const/let/var assigned to a function value — a signature in disguise.
  if (/^(export\s+)?(const|let|var)\s+[\w$]+\s*[:=]\s*(async\s*)?\(/.test(trimmed)) return true;
  if (/^import\b/.test(trimmed)) return true;
  if (/^(module\.exports\b|exports\.[\w$]+)/.test(trimmed)) return true;
  if (/^(\/\/|\/\*|\*)/.test(trimmed)) return true;
  if (/^@[\w$]/.test(trimmed)) return true;
  // Method-like signature, e.g. `render() {` or `getName(): string {`.
  if (/^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(:\s*[^{;]+)?\{?\s*$/.test(trimmed)) return true;
  // Interface/class field type declaration, e.g. `id: string;`.
  if (/^(readonly\s+|public\s+|private\s+|protected\s+|static\s+)*[A-Za-z_$][\w$]*\??\s*:\s*[^={]+;?\s*$/.test(trimmed)) return true;
  return false;
}

// Indent-language (python/yaml) "is this depth<=1 line worth keeping at
// depth 1" test — narrower than the brace version: only def/class signature
// lines and comments earn the depth-1 allowance; everything else at depth 1
// is body content and gets collapsed same as depth 2+.
function isIndentSignatureLine(trimmed) {
  return /^(async\s+def\s|def\s|class\s|@[\w.]+)/.test(trimmed) || /^#/.test(trimmed);
}

function leadingWhitespaceLen(line) {
  let n = 0;
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++;
  return n;
}

function detectIndentUnit(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    const w = leadingWhitespaceLen(line);
    if (w > 0) return w;
  }
  return 4;
}

// Comment/string/template-aware pass over the WHOLE file (see
// lib/skeleton-scan.js), producing per-line depth bookkeeping plus one
// safety verdict: synthesizeCloses. Real code brace nesting is always
// non-negative and every `}` closes something we counted; if the scan ever
// disagrees (negative depth, or a mismatch flagged by scanLineBraces), that
// means our depth tracking can't be trusted for this file (an edge case our
// scanner doesn't handle, or genuinely unbalanced source), and synthesizing
// closing braces from untrustworthy depth bookkeeping would produce
// confidently-wrong structure -- worse than just not synthesizing them.
// synthesizeCloses=false tells strip() to fall back to the pre-brace-
// balancer behaviour: keep/collapse lines exactly as it always did, but
// never emit a synthetic `}`.
function computeBraceScan(lines) {
  let state = createScanState();
  let depth = 0;
  let synthesizeCloses = true;
  const perLine = [];
  for (const line of lines) {
    const result = scanLineBraces(line, state);
    state = result.state;
    const depthBefore = depth;
    depth += result.opens - result.closes;
    if (result.mismatch || depth < 0) synthesizeCloses = false;
    if (depth < 0) depth = 0; // keep/collapse decisions still need a non-negative running depth
    perLine.push({ depthBefore, opens: result.opens, closes: result.closes });
  }
  return { perLine, synthesizeCloses };
}

// Binary/minified guard: content this degenerate is never worth (or safe)
// to skeletonize — refuse up front regardless of what compression would say.
function looksDegenerate(content) {
  if (content.indexOf(NUL) !== -1) return true;
  return content.split('\n').some(l => l.length > MAX_LINE_LEN);
}

// Shared compression-floor check: also used by lib/skeleton.js to decide
// whether its tree-sitter rendering is worth keeping before falling back.
function computeOk(content, outputText) {
  if (looksDegenerate(content)) return false;
  const inputLines = content.split('\n').length;
  const outputLines = outputText.split('\n').length;
  return outputLines < inputLines * COMPRESSION_CEILING;
}

function strip(content, ext) {
  const text = String(content);
  if (looksDegenerate(text)) return { text, ok: false };

  const lines = text.split('\n');
  const indentMode = INDENT_EXTS.has(String(ext || '').toLowerCase());
  const indentUnit = indentMode ? detectIndentUnit(lines) : 0;
  // Comment/string/template-aware brace scan of the whole file, done up
  // front so we know BEFORE emitting anything whether synthesizing closing
  // braces is safe for this file (see computeBraceScan above).
  const braceScan = indentMode ? null : computeBraceScan(lines);

  const out = [];
  let runMarkerAdded = false;
  // Brace-language mode only: stack of braces we KEPT in the output (a
  // function/method/if/etc. signature line ending in `{`, or an object
  // literal opener). A bare `}` closing line never matches
  // isBraceSignatureLine, so without this every kept opening brace would
  // come out unbalanced in the skeleton — this stack lets us synthesize the
  // matching close, at the opening line's own indent, once nesting returns
  // to that line's depth. Not used in indent mode, where nesting has no
  // braces to balance, or when braceScan.synthesizeCloses is false (the
  // fail-closed safety valve -- see computeBraceScan).
  const openBraces = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    let depth;
    let keep;
    let lineScan = null;

    if (indentMode) {
      depth = indentUnit > 0 ? Math.floor(leadingWhitespaceLen(line) / indentUnit) : 0;
      keep = depth === 0 || (depth <= 1 && isIndentSignatureLine(trimmed));
    } else {
      lineScan = braceScan.perLine[i];
      depth = lineScan.depthBefore; // depth BEFORE this line's own braces take effect
      keep = depth === 0 || (depth <= 1 && isBraceSignatureLine(trimmed));
    }

    if (keep) {
      out.push(line);
      runMarkerAdded = false;
      // Net positive real braces on this line (not a raw `endsWith('{')`
      // text check, which a `{` living inside a trailing comment would
      // also satisfy) is what actually needs a synthesized close later.
      if (!indentMode && braceScan.synthesizeCloses && lineScan.opens > lineScan.closes) {
        openBraces.push({ depth, indent: line.slice(0, leadingWhitespaceLen(line)) });
      }
    } else if (!runMarkerAdded) {
      if (out.length) out[out.length - 1] += MARKER;
      else out.push(MARKER);
      runMarkerAdded = true;
    }
    // else: already represented by the marker for this run — drop silently.

    if (!indentMode && braceScan.synthesizeCloses) {
      const depthAfter = Math.max(0, depth + lineScan.opens - lineScan.closes);
      while (openBraces.length && depthAfter <= openBraces[openBraces.length - 1].depth) {
        const frame = openBraces.pop();
        out.push(frame.indent + '}');
        runMarkerAdded = false; // the synthetic close is a fresh boundary for the next run
      }
    }
  }

  const outText = out.join('\n');
  return { text: outText, ok: computeOk(text, outText) };
}

module.exports = {
  strip, computeOk, looksDegenerate, isBraceSignatureLine, isIndentSignatureLine,
  // Exported for lib/skeleton.js's markdown branch, which applies the same
  // compression floor but checks degeneracy against its OUTPUT rather than its
  // input -- see the comment at that call site for why.
  COMPRESSION_CEILING,
};
