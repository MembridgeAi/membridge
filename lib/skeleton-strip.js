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

function braceDelta(line) {
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '{') d++;
    else if (line[i] === '}') d--;
  }
  return d;
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

  let braceDepth = 0;
  const out = [];
  let runMarkerAdded = false;

  for (const line of lines) {
    const trimmed = line.trim();
    let depth;
    let keep;

    if (indentMode) {
      depth = indentUnit > 0 ? Math.floor(leadingWhitespaceLen(line) / indentUnit) : 0;
      keep = depth === 0 || (depth <= 1 && isIndentSignatureLine(trimmed));
    } else {
      depth = braceDepth; // depth BEFORE this line's own braces take effect
      keep = depth === 0 || (depth <= 1 && isBraceSignatureLine(trimmed));
      braceDepth += braceDelta(line);
      if (braceDepth < 0) braceDepth = 0; // defensive: unbalanced input never goes negative
    }

    if (keep) {
      out.push(line);
      runMarkerAdded = false;
    } else if (!runMarkerAdded) {
      if (out.length) out[out.length - 1] += MARKER;
      else out.push(MARKER);
      runMarkerAdded = true;
    }
    // else: already represented by the marker for this run — drop silently.
  }

  const outText = out.join('\n');
  return { text: outText, ok: computeOk(text, outText) };
}

module.exports = { strip, computeOk, looksDegenerate, isBraceSignatureLine, isIndentSignatureLine };
