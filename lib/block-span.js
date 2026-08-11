'use strict';
// Where the managed block starts and ends in a context file — the one rule
// every reader and the writer need, and which four call sites had each guessed
// at differently (ticket #61). This module owns it, and owns the markers
// themselves so there is nothing left to disagree about; lib/digest.js
// re-exports BEGIN/END for its existing callers.
//
// The subtle part is which end marker closes the block. Both obvious answers
// are wrong for a case the other gets right:
//
//   - indexOf(END) — the first end marker — is wrong on a FORGED marker. An
//     end marker smuggled into the block (by a prompt-injected agent, or left
//     by a version before digest.renderBlock neutralized markers, or added by
//     hand) would close the block early, so everything after it reads as
//     ordinary file content: outside the block, never re-absorbed on rewrite,
//     and invisible to any surface that shows a human "what the block says"
//     while the AI tools reading the raw file still see all of it.
//
//   - lastIndexOf(END) — the last end marker — is wrong on a DUPLICATED
//     block, which is what a git merge of a tracked CLAUDE.md produces when
//     both sides brought their own. The span then runs across the first
//     block, the user's own lines, and the second block as if all of it were
//     one block.
//
// The begin marker that FOLLOWS is exactly what tells the two apart: a forged
// END has no BEGIN after it, a duplicated block does. So the block ends at the
// last END that precedes the next BEGIN, falling back to the last END in the
// file when this BEGIN never closes before the next one (a nested pair, which
// is treated as one block).
//
// A MARKER MUST OWN ITS LINE. Matching a marker anywhere in the text, mid-line
// included, is what made a CLAUDE.md whose PROSE names the markers ("we keep
// memory between <begin> and <end>") resolve to the prose fragment instead of
// the real block below it — the reader then returned a FABRICATED block built
// out of the prose between two inline mentions, which is strictly worse than
// returning nothing on the surface whose whole job is proving the memory is
// really there. renderBlock() always emits the markers on their own lines and
// neutralizes any marker appearing in block content, so no block this product
// ever wrote is missed by the stricter rule; only prose that merely talks
// about the markers stops counting as one. Surrounding horizontal whitespace
// is tolerated so a hand-indented marker still reads as structural.
const BEGIN = '<!-- membridge:begin -->';
const END = '<!-- membridge:end -->';

/** Does the marker at `i` sit alone on its line (bar horizontal whitespace)? */
function ownsItsLine(s, i, marker) {
  let a = i - 1;
  while (a >= 0 && (s[a] === ' ' || s[a] === '\t')) a--;
  if (a >= 0 && s[a] !== '\n') return false;
  let b = i + marker.length;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b++;
  return b >= s.length || s[b] === '\n' || s[b] === '\r';
}

/** First structural `marker` at or after `from`, or -1. */
function indexOfMarker(s, marker, from = 0) {
  let i = s.indexOf(marker, from);
  while (i !== -1 && !ownsItsLine(s, i, marker)) i = s.indexOf(marker, i + 1);
  return i;
}

/**
 * Last structural `marker` at or before `from` (the whole string when `from`
 * is undefined), or -1. A negative `from` is clamped to 0 exactly as
 * String#lastIndexOf clamps it, which is the wanted behaviour: a BEGIN that
 * early cannot have a complete pair before it.
 */
function lastIndexOfMarker(s, marker, from) {
  let i = from === undefined ? s.lastIndexOf(marker) : s.lastIndexOf(marker, from);
  while (i > 0 && !ownsItsLine(s, i, marker)) i = s.lastIndexOf(marker, i - 1);
  return i !== -1 && ownsItsLine(s, i, marker) ? i : -1;
}

/**
 * Span of the first managed block, or null when the text carries no usable
 * pair. `begin` is the index of the begin marker; `end` is one past the
 * closing marker, so text.slice(begin, end) is the whole block.
 */
function firstBlockSpan(text) {
  const s = String(text);
  const b = indexOfMarker(s, BEGIN);
  if (b === -1) return null;
  const nextBegin = indexOfMarker(s, BEGIN, b + BEGIN.length);
  let e = nextBegin === -1 ? -1 : lastIndexOfMarker(s, END, nextBegin - END.length);
  if (e <= b) e = lastIndexOfMarker(s, END);
  if (e <= b) return null;
  return { begin: b, end: e + END.length };
}

/** The text BETWEEN the markers of the first block, or null when there is none. */
function firstBlockInner(text) {
  const span = firstBlockSpan(text);
  if (!span) return null;
  return String(text).slice(span.begin + BEGIN.length, span.end - END.length);
}

module.exports = { BEGIN, END, firstBlockSpan, firstBlockInner };
