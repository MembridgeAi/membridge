'use strict';
// Your own work, coming back from the backend as a second row nothing folds.
//
// THE DEFECT. A local entry's ts is a JS toISOString() Z-form string
// (lib/scan.js), pushed verbatim (lib/teamsync.js) into a `timestamptz`
// column. team_feed RETURNS TABLE declares that column timestamptz, and
// PostgREST renders its JSON through Postgres's own to_json. That is NOT the
// string that went up. Verified against Postgres 17 (Supabase runs 17.6.1):
//
//   input:   '2026-08-05T12:00:00.550Z'::timestamptz
//   to_json: "2026-08-05T12:00:00.55+00:00"
//
// Two transformations at once: the Z becomes +00:00, AND the trailing zero is
// trimmed. So every dedupe that compares a local ts to its own synced-back
// twin AS A STRING compares two spellings of the same instant and concludes
// they are different rows. Both of the daemon's self-twin dedupes did:
// feed.dedupeKey and the (session, ts) self filter in server.js.
//
// WHAT IT LOOKED LIKE. Nothing, until now. The UI's collapseSessionCheckpoints
// keys on session id alone, so it folded the duplicate pair by accident, and
// the feed rewrite removes that collapse. Underneath it, one afternoon on a
// linked project renders every entry twice, once with your prompt and once as
// "(prompt not shared)".
//
// WHY THE EXISTING SUITE COULD NOT SEE IT. test/mock-supabase.js stored and
// returned pushed rows verbatim out of a JS array, so its ts was byte-identical
// to the local one and both dedupes appeared to work. The mock now renders ts
// and created_at through pgTimestamptz on the way out -- the same rendering
// Postgres does -- so a string-keyed dedupe fails there the way it fails in
// production. A green run against a mock that does not round-trip its own
// values is not evidence of anything.
//
// Run directly, or via `node test/run.js feed-twin-dedupe`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const feed = require('../../lib/feed');
const { pgTimestamptz } = require('../mock-supabase');

// One local entry and the team row it comes back as. `ts` goes up as the
// local Z-form and returns in Postgres's spelling.
function pair(over = {}) {
  const ts = over.ts || '2026-08-05T12:00:00.550Z';
  const local = feed.normalizeLocal(
    { ts, session: 'sess-1', ask: 'wire up the export button', source: 'Claude Code', summary: 'Did the thing.' },
    { projectName: 'membridge', projectPath: '/repos/membridge', projectId: 'proj-uuid', authorId: 'me' });
  const team = feed.normalizeTeam({
    ts: pgTimestamptz(ts),
    created_at: pgTimestamptz(ts),
    id: 7,
    author_id: 'me',
    author_name: 'Andrew',
    project_id: 'proj-uuid',
    project_name: 'Membridge',              // the backend capitalises it
    session: 'sess-1',
    source: 'Claude Code',
    ask: over.sharedPrompt === false ? null : 'wire up the export button',
    summary: 'Did the thing.',
  }, { selfUserId: 'me' });
  return { local, team };
}

async function main() {
  check('feed: the mock renders a timestamptz the way Postgres actually does', () => {
    // The fixture the rest of this file rests on. If this is wrong, every
    // check below is testing a format that does not exist.
    assert.strictEqual(pgTimestamptz('2026-08-05T12:00:00.550Z'), '2026-08-05T12:00:00.55+00:00');
    assert.strictEqual(pgTimestamptz('2026-08-05T12:00:00.000Z'), '2026-08-05T12:00:00+00:00',
      'an all-zero fraction is dropped entirely, not rendered as .000');
    assert.strictEqual(pgTimestamptz('2026-08-05T12:00:00.123Z'), '2026-08-05T12:00:00.123+00:00');
    assert.strictEqual(pgTimestamptz('2026-08-05T12:00:00.100Z'), '2026-08-05T12:00:00.1+00:00');
  });

  check('feed: a shared self-twin folds even though its ts is spelled differently', () => {
    const raw = '2026-08-05T12:00:00.550Z';
    // The premise, asserted where it actually lives now: the backend really
    // does hand this instant back spelled differently from the way it went up.
    // This used to be checked on the NORMALIZED pair, but normalizeTeam
    // canonicalises ts on the way in (feed.js), so by then the two spellings
    // agree by construction -- which is the point of the fix, and would have
    // made the old assertion prove nothing rather than fail loudly. It failed
    // loudly, which is why the guard was worth having.
    assert.notStrictEqual(pgTimestamptz(raw), raw,
      'fixture check: the wire spelling must actually differ, or this proves nothing');

    const { local, team } = pair();
    // The canonicalisation itself, so a regression that removed it is caught
    // here rather than surfacing as a mis-ordered feed under a rarer condition
    // (two entries in the SAME SECOND, where a raw string compare orders by
    // punctuation -- '+' sorts before '.' -- instead of by time).
    assert.strictEqual(team.ts, local.ts,
      'normalizeTeam must canonicalise the wire spelling to the local Z-form');
    assert.strictEqual(feed.dedupeKey(local), feed.dedupeKey(team),
      'the same instant on the same project must produce the same collision key');
    const out = feed.buildFeed({ local: [local], team: [team] });
    assert.strictEqual(out.entries.length, 1, 'your own work rendered twice in the feed');
  });

  check('feed: two spellings of ONE second sort by time, not by punctuation', () => {
    // The npm-publish blocker on v0.4.0: get_recent_activity returned entries
    // "not sorted newest-first" because a team row spelled '...49+00:00' and a
    // local row spelled '...49.000Z' were compared as strings, and '+' (0x2B)
    // sorts before '.' (0x2E). Same instant, so the order was decided by
    // format. Only reproducible when two entries share a second, which is why
    // it lurked until a busy release day.
    const second = '2026-08-13T16:11:49.000Z';
    const { team } = pair({ ts: second });
    const newer = feed.normalizeLocal({ ts: '2026-08-13T16:12:04.095Z', session: 's2', summary: 'later' },
      { projectName: 'other', projectPath: '/repos/other', projectId: 'other-uuid', authorId: 'me' });
    const out = feed.buildFeed({ local: [newer], team: [team] });
    assert.deepStrictEqual(out.entries.map(e => e.ts), ['2026-08-13T16:12:04.095Z', second],
      'the newer entry must lead regardless of how either ts is spelled');
  });

  check('feed: an UNSHARED self-twin (null ask) folds on session and instant', () => {
    // This one dodges dedupeKey on purpose: the ask is null because the
    // prompt was never shared, so the keys legitimately differ. The
    // (session, instant) filter is what catches it.
    const { local, team } = pair({ sharedPrompt: false });
    assert.notStrictEqual(feed.dedupeKey(local), feed.dedupeKey(team),
      'fixture check: the null-ask twin must dodge the ask-level key');
    const kept = feed.dropSelfTwins([local], [team]);
    assert.deepStrictEqual(kept, [],
      'the unshared twin renders a second "(prompt not shared)" row for a prompt the local copy shows in full');
  });

  check('feed: a self row from ANOTHER machine is kept, not swallowed by the fold', () => {
    // Same person, same project, no local twin: this is real work done
    // elsewhere and it is the only record of it. Over-folding here would
    // silently delete a machine's history from the feed.
    const { team } = pair();
    const kept = feed.dropSelfTwins([], [team]);
    assert.strictEqual(kept.length, 1);
  });

  check('feed: a teammate\'s row at the same instant and session is never folded into yours', () => {
    const { local, team } = pair();
    const theirs = { ...team, self: false, authorId: 'marco', author: 'marco' };
    const kept = feed.dropSelfTwins([local], [theirs]);
    assert.strictEqual(kept.length, 1, 'only SELF rows may be dropped as twins');
  });

  check('feed: a different second of the same session is a different entry', () => {
    // The inverse guard. Comparing instants must not become "close enough":
    // two prompts a second apart in one session are two entries.
    const { local } = pair({ ts: '2026-08-05T12:00:00.550Z' });
    const later = pair({ ts: '2026-08-05T12:00:01.550Z' }).team;
    const kept = feed.dropSelfTwins([local], [later]);
    assert.strictEqual(kept.length, 1, 'distinct instants must survive');
  });

  check('feed: an unparseable ts is compared as itself, never folded with every other bad one', () => {
    // Date.parse returns NaN for junk. Keying on the parsed number would make
    // every unparseable row collide with every other, silently deleting rows.
    const a = { ...pair().local, ts: 'not a date' };
    const b = { ...pair().team, ts: 'also not a date' };
    assert.notStrictEqual(feed.dedupeKey(a), feed.dedupeKey(b),
      'two different junk timestamps must not be treated as the same instant');
    assert.strictEqual(feed.dropSelfTwins([a], [b]).length, 1);
  });

  check('feed: a SESSION-LESS self twin folds too, because the key is the backend\'s own row identity', () => {
    // The one shape with no accidental protection anywhere else in the stack:
    // the UI's collapse keys on session id, so a session-less pair was never
    // folded by anything. Safe to fold because memory_entries carries
    // `unique (project_id, author_id, ts, source)` and the push upserts on
    // exactly that key -- for a row already known to be self, project +
    // instant + source IS what the backend treats as one row, so no two
    // distinct rows can hide behind it.
    const { local, team } = pair();
    const kept = feed.dropSelfTwins(
      [{ ...local, session: null }],
      [{ ...team, session: null }]);
    assert.deepStrictEqual(kept, [], 'the session-less twin still renders twice');
  });

  check('feed: a different SOURCE at the same instant is a different row to the backend', () => {
    // source is in the unique key, so two tools writing at the same instant
    // are two rows upstream and must stay two rows here.
    const { local, team } = pair();
    const kept = feed.dropSelfTwins([local], [{ ...team, source: 'Codex' }]);
    assert.strictEqual(kept.length, 1);
  });

  check('feed: an unlinked local project can never swallow a team row', () => {
    // No projectId, so the key falls back to a path no team row carries.
    const { local, team } = pair();
    const kept = feed.dropSelfTwins([{ ...local, projectId: null }], [team]);
    assert.strictEqual(kept.length, 1);
  });

  h.finish();
}

main();
