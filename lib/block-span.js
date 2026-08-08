'use strict';
// Where the FIRST managed block starts and ends in a context file — the one
// rule every READ path needs and each had guessed at differently.
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
// lib/digest.js grew the same rule independently for the WRITE path
// (blockSpan). When both live on one branch, collapse them onto this module —
// two copies of a rule this subtle is how one of them drifts back into a bug.
//
// KNOWN GAP, deliberately not fixed here. A marker is recognized anywhere in
// the text, including mid-line, so a CLAUDE.md whose PROSE names the markers
// above the real block ("we keep memory between <begin> and <end>") resolves
// to the prose fragment instead of the block. Requiring a structural marker to
// sit alone on its line would fix that, but it changes what counts as a marker
// for the WRITER too, so it belongs with digest.js rather than here. Today's
// only caller is lib/hooks-prime.js, where a wrong span costs a redundant
// injection and never hides anything; do not adopt this for a surface that
// DISPLAYS the block until that gap is closed.
const digest = require('./digest');

/**
 * Span of the first managed block, or null when the text carries no usable
 * pair. `begin` is the index of the begin marker; `end` is one past the
 * closing marker, so text.slice(begin, end) is the whole block.
 */
function firstBlockSpan(text) {
  const s = String(text);
  const b = s.indexOf(digest.BEGIN);
  if (b === -1) return null;
  const nextBegin = s.indexOf(digest.BEGIN, b + digest.BEGIN.length);
  // A negative fromIndex is clamped to 0 by lastIndexOf, which is the wanted
  // behaviour: a BEGIN that early cannot have a complete pair before it.
  let e = nextBegin === -1 ? -1 : s.lastIndexOf(digest.END, nextBegin - digest.END.length);
  if (e <= b) e = s.lastIndexOf(digest.END);
  if (e <= b) return null;
  return { begin: b, end: e + digest.END.length };
}

/** The text BETWEEN the markers of the first block, or null when there is none. */
function firstBlockInner(text) {
  const span = firstBlockSpan(text);
  if (!span) return null;
  return String(text).slice(span.begin + digest.BEGIN.length, span.end - digest.END.length);
}

module.exports = { firstBlockSpan, firstBlockInner };
