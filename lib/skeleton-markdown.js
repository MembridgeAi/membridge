'use strict';
// Structure extractor for prose documents (markdown), the third engine behind
// lib/skeleton.js's skeletonize() alongside tree-sitter and the brace/indent
// strip.
//
// WHY THIS EXISTS. The other two engines look for CODE structure: tree-sitter
// needs a vendored grammar (ts/tsx/js/jsx/py/go only) and the strip engine
// looks for brace or indent signatures. A markdown file has neither, so it
// fell to strip(), came back with output ~= input, failed the compression
// floor, and returned ok:false. lib/recall-store.js's warm() treats ok:false
// as "no structure here", bumps the noStructure counter and stores nothing --
// so a markdown hot path could never be warmed, never be served, and the
// avoided-tokens total it fed could never leave zero. Measured on a live
// install: the project's ONLY hot path was a markdown plan doc and the
// noStructure counter had reached 61 with the recall layer permanently inert.
//
// A prose document's signatures are its HEADINGS. Keeping them and eliding
// everything between is the exact analogue of keeping function signatures and
// eliding bodies, and it yields the one thing a re-reading agent actually
// needs from a doc it has seen before: where things are.

// One elision marker per contiguous run of dropped lines, never one per line
// -- the run collapse is what produces the compression, and a marker per line
// would be strictly larger than the source.
const ELISION = '…';

// A fence opens/closes on ``` or ~~~ (at least three), optionally indented up
// to three spaces. Tracked because a '#' inside a fenced block is a comment in
// whatever language is fenced, not a heading -- without this, code comments
// leak into the skeleton as though they were document structure.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// ATX heading: 1-6 '#' followed by whitespace. The trailing-space requirement
// is what keeps '#!/usr/bin/env' and '#hashtag' out.
const ATX_RE = /^ {0,3}#{1,6}\s+\S/;

// Setext underline: a run of '=' or '-' under a non-blank line promotes that
// line to a heading. '-' is ambiguous with a list item and an hr, so the
// candidate line above it must itself be ordinary text (checked at the call
// site, which has that context).
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;

const isBlank = line => !line.trim();

// outline(content) -> { text, headings }
//
// text     the skeleton: every heading in document order, each run of dropped
//          lines replaced by a single marker.
// headings how many headings were found. Zero means the document genuinely has
//          no structure to extract, and the caller must refuse rather than
//          serve a body made of nothing but markers -- see skeletonize().
function outline(content) {
  const lines = String(content).split('\n');
  const out = [];
  let headings = 0;
  let fence = null; // the opening fence marker, while inside a fenced block
  let elided = false;

  // Emit exactly one marker for a run of dropped lines.
  const drop = () => {
    if (elided) return;
    out.push(ELISION);
    elided = true;
  };
  const keep = line => {
    out.push(line);
    elided = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      // Inside a fence: everything is body. Only a matching closing fence of
      // the same character ends it (a ``` cannot close a ~~~ block).
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      drop();
      continue;
    }

    const fenceOpen = FENCE_RE.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      drop();
      continue;
    }

    if (ATX_RE.test(line)) {
      keep(line.trimEnd());
      headings++;
      continue;
    }

    // Setext: look ahead one line. The underline itself is kept with the text
    // so the heading LEVEL survives ('=' is h1, '-' is h2) without rewriting
    // the author's markup into ATX.
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (next !== null && !isBlank(line) && SETEXT_RE.test(next) && !ATX_RE.test(line)) {
      keep(line.trimEnd());
      keep(next.trimEnd());
      headings++;
      i++; // the underline is consumed
      continue;
    }

    drop();
  }

  return { text: out.join('\n'), headings };
}

module.exports = { outline, ELISION };
