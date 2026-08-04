'use strict';
// --- decisions/gotchas keep their line structure end to end ---
//
// The Stop hook asks for decisions and gotchas as SHORT BULLETS, one per line,
// and writes them to summaries.jsonl exactly that way. Every reader then saw
// one paragraph, because all four paths out of storage funnel through
// digest.clip, whose first act is `String(text).replace(/\s+/g, ' ')` -- which
// does not distinguish a newline from a space. The bullets were written
// correctly and destroyed in transit, on the local feed, the team wire, the
// provenance payload and the injected block alike.
//
// These checks are a round trip, not a unit test of the helper, because the
// helper was never the thing that was wrong: the assertion that matters is
// "four bullets in, four bullets out of the reader a teammate actually looks
// at". Nothing in the suite covered that, which is why a whole release shipped
// with the feature silently inert.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const digest = require('../../lib/digest');

const FOUR = [
  'Removed the transfer-ownership menu item, no RPC can perform it',
  'Day cards group per person per project per day',
  'Search query now lives in the URL',
  'Redacted code and token values in URL query params',
].join('\n');

check('bulletClip keeps one line per bullet, and collapses only WITHIN a line', () => {
  const out = digest.bulletClip(FOUR, digest.NOTE_MAX);
  assert.strictEqual(out.split('\n').length, 4, 'the four bullets did not survive as four lines');
  assert.strictEqual(out.split('\n')[0], 'Removed the transfer-ownership menu item, no RPC can perform it');
  // Runs of spaces and tabs inside a bullet are still noise and still collapse.
  const messy = digest.bulletClip('one   \t  bullet\nsecond    bullet', digest.NOTE_MAX);
  assert.strictEqual(messy, 'one bullet\nsecond bullet', 'intra-line whitespace must still collapse');
});

check('bulletClip drops blank lines rather than emitting empty bullets', () => {
  const out = digest.bulletClip('first\n\n\nsecond\n   \nthird', digest.NOTE_MAX);
  assert.deepStrictEqual(out.split('\n'), ['first', 'second', 'third']);
});

check('bulletClip leaves a single-line value exactly as clip would', () => {
  // Every entry written before this change is stored collapsed, and Andrew's
  // call was to leave those as they are. A prose value must therefore come out
  // of bulletClip byte-identical to what clip already produced, so the legacy
  // rendering path cannot shift under it.
  const prose = 'One sentence. Then another sentence about the same work.';
  assert.strictEqual(digest.bulletClip(prose, 240), digest.clip(prose, 240));
});

check('bulletClip caps the whole value, and never leaves a dangling separator', () => {
  const many = Array.from({ length: 40 }, (_, i) => `bullet number ${i}`).join('\n');
  const out = digest.bulletClip(many, 100);
  assert.ok(out.length <= 100, `expected <= 100 chars, got ${out.length}`);
  assert.ok(!out.endsWith('\n'), 'a trailing newline would render as an empty bullet');
});

check('clip itself is unchanged: it still flattens, because summary and goal are one line', () => {
  // goal, ask, summary and headline are single-line by contract. If clip ever
  // stops flattening, a multi-line goal would break the injected block's
  // one-entry-per-line shape, so this pins the OLD behaviour deliberately.
  assert.strictEqual(digest.clip('a\nb', 240), 'a b');
});

check('a four-bullet decisions survives storage and reaches the reader as four lines', () => {
  const util = require('../../lib/util');
  const memorydb = require('../../lib/memorydb');
  const path = require('path');
  const fs = require('fs');
  const { ROOT } = h;

  const proj = path.join(ROOT, 'projects', 'bullet-app');
  fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Bullet app\n');

  const projState = {
    events: [{
      ts: '2026-08-04T05:00:00.000Z', source: 'Distilled', kind: 'summary',
      session: 'bullet-sess', distilled: true, text: 'Did the work.',
      headline: 'Did the work', goal: 'prove bullets survive',
      decisions: FOUR, gotchas: '',
    }],
  };

  const entries = memorydb.buildEntries(proj, projState, util.getConfig());
  const withNotes = entries.find(e => e.decisions);
  assert.ok(withNotes, 'no entry carried decisions at all');
  assert.strictEqual(
    withNotes.decisions.split('\n').length, 4,
    `decisions reached the reader as ${withNotes.decisions.split('\n').length} line(s), not 4`,
  );
});

h.finish();
