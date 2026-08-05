'use strict';
// The per-author-per-LOCAL-DAY digest: one sentence describing a person's
// whole day across every project they touched, generated daemon-side.
//
// WHY IT CANNOT BE COMPOSED IN THE CLIENT. ui/src/features/feed/dayCards.ts
// deliberately PICKS one existing entry's outcome verbatim and documents that
// it must never concatenate several rows into "a sentence nobody wrote".
// That rule is right for the input it has. Every /api/feed row is one captured
// prompt, and a session lands SEVERAL checkpoint rows whose text is mostly a
// restatement of the previous one (the Stop hook asks each line to restate the
// whole session so far -- lib/hooks.js). Measured on the real repo, one day
// held 7 checkpoints across 3 sessions; joining those 7 outcomes produces the
// same sentence three times over. That is the garbage the comment is about.
//
// The daemon has two things the client does not:
//   1. it can collapse a day to ONE statement PER SESSION first, using the
//      same supersede rule the rest of the codebase already uses
//      (digest.pickSummary: distilled beats harvested, newest wins in tier),
//      which turns 7 near-duplicates into 2 or 3 real statements;
//   2. it holds every project at once, so a person's day is not split by the
//      project boundary the feed page happens to fall on.
//
// After the collapse, and only after it, every remaining clause is a distinct
// thing a human or an agent actually wrote, and joining them is a listing of
// verbatim statements rather than an invented summary. Nothing here ever
// paraphrases, and a day with nothing to say says so.
//
// LOCAL DAY, never UTC: the UI keys its cards on ui/src/data/localTime.ts's
// localDayKey (viewer-local calendar fields). A UTC key files an evening
// session west of Greenwich under tomorrow. The parity check below is what
// keeps the two implementations honest about each other.
//
// Run directly, or via `node test/run.js day-digest`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const digest = require('../../lib/digest');

const REPO = path.join(__dirname, '..', '..');

// A normalized feed entry (lib/feed.js shape), with only the fields the digest
// reads. Defaults are the "nothing was captured" state on purpose, so every
// test states exactly what it is exercising.
function entry(over = {}) {
  return {
    ts: '2026-08-05T18:00:00.000Z',
    author: 'You', authorId: 'me',
    session: 's1', source: 'Claude Code',
    project: 'membridge', projectId: 'p1',
    headline: null, summary: null, goal: null,
    distilled: false, undecryptable: false,
    ...over,
  };
}

const only = digests => {
  assert.strictEqual(digests.length, 1, `expected exactly one digest, got ${digests.length}`);
  return digests[0];
};

// ---------------------------------------------------------------------------
// The UI's own day-keying, extracted from ui/src/data/localTime.ts and run as
// JavaScript. Reading the file rather than restating its algorithm is the
// point: a daemon-side copy of a rule that lives in the UI is exactly how the
// UTC bug ended up in four places at once (localTime.ts's own header says so).
// If this ever cannot find the function, the contract moved and the daemon's
// day-keying needs re-syncing BY HAND -- that is a failure, not a skip.
// ---------------------------------------------------------------------------
function uiLocalDayKey() {
  const candidates = [path.join(REPO, 'ui', 'src', 'data', 'localTime.ts')];
  let src = null;
  for (const c of candidates) {
    try { src = fs.readFileSync(c, 'utf8'); break; } catch { /* try the next */ }
  }
  if (src === null) {
    // Last resort: the file moved. Find whoever defines it now.
    const root = path.join(REPO, 'ui', 'src');
    const walk = dir => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { const hit = walk(p); if (hit) return hit; }
        else if (/\.tsx?$/.test(name)) {
          const text = fs.readFileSync(p, 'utf8');
          if (/export function localDayKey/.test(text)) return text;
        }
      }
      return null;
    };
    src = walk(root);
  }
  assert.ok(src, 'no file under ui/src defines localDayKey -- the UI day-key contract moved, re-sync lib/digest.js dayKeyLocal by hand');
  const m = /export function localDayKey\s*\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'localDayKey was found but its shape changed -- re-read it and re-sync lib/digest.js dayKeyLocal by hand');
  // The body is plain JS once the parameter annotation is gone; it only uses
  // String/padStart and Date getters.
  return new Function('d', m[1]); // eslint-disable-line no-new-func
}

async function main() {
  // -------------------------------------------------------------------------
  // Local calendar day
  // -------------------------------------------------------------------------

  check('digest: the day key uses LOCAL calendar fields, matching the UI byte for byte', () => {
    const ui = uiLocalDayKey();
    const instants = [
      '2026-08-05T18:00:00.000Z',
      '2026-08-05T02:00:00.000Z',  // evening of the 4th in US Pacific
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
      '2026-03-08T10:30:00.000Z',  // US DST transition weekend
      '2026-11-01T08:30:00.000Z',
    ];
    for (const iso of instants) {
      const d = new Date(iso);
      assert.strictEqual(digest.dayKeyLocal(d), ui(d),
        `dayKeyLocal disagrees with the UI's localDayKey for ${iso}`);
    }
  });

  check('digest: an evening west of Greenwich is filed on the day it happened, not tomorrow', () => {
    // 02:00Z on the 5th is 19:00 on the 4th in US Pacific. toISOString().slice(0,10)
    // -- the bug localTime.ts exists to replace -- answers 2026-08-05.
    const out = execFileSync(process.execPath, ['-e',
      "process.stdout.write(require('./lib/digest').dayKeyLocal(new Date('2026-08-05T02:00:00.000Z')))"],
    { cwd: REPO, env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' });
    assert.strictEqual(out, '2026-08-04',
      'the daemon filed an evening Pacific session under tomorrow -- this is the UTC-day bug');
  });

  check('digest: the same instant is a different local day in a different zone', () => {
    const run = tz => execFileSync(process.execPath, ['-e',
      "process.stdout.write(require('./lib/digest').dayKeyLocal(new Date('2026-08-05T02:00:00.000Z')))"],
    { cwd: REPO, env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.strictEqual(run('UTC'), '2026-08-05');
    assert.strictEqual(run('America/Los_Angeles'), '2026-08-04');
    assert.strictEqual(run('Australia/Sydney'), '2026-08-05');
  });

  // -------------------------------------------------------------------------
  // Grouping
  // -------------------------------------------------------------------------

  check('digest: one digest per author per day, spanning every project they touched', () => {
    const out = digest.buildDayDigests([
      entry({ session: 'a', project: 'membridge', projectId: 'p1', headline: 'Fixed the installer', distilled: true }),
      entry({ session: 'b', project: 'membridge-site', projectId: 'p2', headline: 'Rewrote the pricing page', distilled: true }),
      entry({ session: 'c', author: 'marco', authorId: 'marco-id', project: 'membridge', headline: 'Shipped 0.3.2', distilled: true }),
    ]);
    assert.strictEqual(out.length, 2, 'two people, one day: two digests');
    const mine = out.find(d => d.authorId === 'me');
    assert.deepStrictEqual(mine.projects, ['membridge', 'membridge-site'],
      'the digest spans the projects, it does not split on them');
    assert.strictEqual(mine.sessions, 2);
  });

  check('digest: the same person on two local days gets two digests', () => {
    const out = digest.buildDayDigests([
      entry({ ts: '2026-08-05T18:00:00.000Z', session: 'a', headline: 'Day two work', distilled: true }),
      entry({ ts: '2026-08-04T18:00:00.000Z', session: 'b', headline: 'Day one work', distilled: true }),
    ]);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].day > out[1].day, true, 'newest day first');
  });

  check('digest: an author with no id keys on their display name, like the UI card does', () => {
    // Reachable via a SIGNED-OUT machine: server.js passes
    // `authorId: creds ? creds.userId : null`, so every local entry arrives
    // with a null id. (NOT via "team rows that predate author_id" -- that
    // column is `not null` in the original CREATE TABLE and no migration
    // added it. The myth is documented in lib/digest.js digestAuthorPart.)
    const out = digest.buildDayDigests([
      entry({ author: 'marco', authorId: null, session: 'a', headline: 'Marco did a thing', distilled: true }),
      entry({ author: 'jo', authorId: null, session: 'b', headline: 'Jo did another', distilled: true }),
    ]);
    assert.strictEqual(out.length, 2, 'two id-less teammates are two people, not one');
  });

  // -------------------------------------------------------------------------
  // The sentence
  // -------------------------------------------------------------------------

  check('digest: a one-session day is the headline VERBATIM, byte for byte', () => {
    const HL = 'Worked on UI fixes, app install and dmg';
    const d = only(digest.buildDayDigests([entry({ headline: HL, distilled: true })]));
    assert.strictEqual(d.text, HL, 'a single statement must survive untouched');
    assert.strictEqual(d.kind, 'distilled');
    assert.strictEqual(d.omittedSessions, 0);
    assert.strictEqual(d.coverageNote, null, 'nothing is hidden, so nothing is disclosed');
  });

  check('digest: several checkpoints of ONE session collapse to one clause', () => {
    // The exact shape measured on the real repo: session af8d0a wrote three
    // checkpoints, each restating the session so far. Concatenating them is
    // the garbage dayCards.ts forbids; the per-session collapse is what makes
    // joining safe at all.
    const d = only(digest.buildDayDigests([
      entry({ session: 'af8d0a', ts: '2026-08-05T10:00:00.000Z', distilled: true, headline: 'Rejoined the team, and made the session brief skimmable' }),
      entry({ session: 'af8d0a', ts: '2026-08-05T12:00:00.000Z', distilled: true, headline: 'Rejoined the team; brief and sign-in reworked on two branches' }),
      entry({ session: 'af8d0a', ts: '2026-08-05T14:00:00.000Z', distilled: true, headline: 'Landed four agent waves of UI fixes on master' }),
    ]));
    assert.strictEqual(d.text, 'Landed four agent waves of UI fixes on master',
      'the newest checkpoint supersedes its own earlier ones, exactly as pickSummary already rules');
    assert.strictEqual(d.sessions, 1);
    assert.strictEqual(d.sources.length, 1, 'one session contributes one clause');
  });

  check('digest: several SESSIONS become several verbatim clauses, oldest first', () => {
    const A = 'Landed four agent waves of UI fixes on master';
    const B = 'Fixed stale teammate liveness and the model-authored summary timestamp';
    const d = only(digest.buildDayDigests([
      entry({ session: 'af8d0a', ts: '2026-08-05T14:00:00.000Z', distilled: true, headline: A }),
      entry({ session: '07e07a', ts: '2026-08-05T16:00:00.000Z', distilled: true, headline: B }),
    ]));
    assert.strictEqual(d.text, `${A}; ${B}`,
      'the day reads in the order it happened, and every clause is verbatim');
    assert.strictEqual(d.sessions, 2);
    assert.strictEqual(d.summarized, 2);
  });

  check('digest: every clause appears verbatim in the input -- nothing is paraphrased', () => {
    const inputs = [
      'Worked on UI fixes, app install and dmg',
      'Verified 0.2.5 signing, fixed the stale curl installer',
    ];
    const d = only(digest.buildDayDigests([
      entry({ session: 'a', ts: '2026-08-05T10:00:00.000Z', distilled: true, headline: inputs[0] }),
      entry({ session: 'b', ts: '2026-08-05T11:00:00.000Z', distilled: true, headline: inputs[1] }),
    ]));
    for (const clause of d.text.split('; ')) {
      assert.ok(inputs.includes(clause), `clause "${clause}" was not written by anyone -- it was invented`);
    }
  });

  check('digest: the clause count is capped, and the day SAYS how much it is not showing', () => {
    const es = [];
    for (let i = 1; i <= 6; i++) {
      es.push(entry({ session: `s${i}`, ts: `2026-08-05T1${i}:00:00.000Z`, distilled: true, headline: `Statement number ${i}` }));
    }
    const d = only(digest.buildDayDigests(es));
    assert.strictEqual(d.sources.length, digest.DAY_CLAUSE_LIMIT, 'the sentence is bounded');
    assert.strictEqual(d.omittedSessions, 6 - digest.DAY_CLAUSE_LIMIT);
    assert.ok(/3 more sessions/.test(d.coverageNote),
      `a capped view must say it is capped (renderBlock's own rule); got ${JSON.stringify(d.coverageNote)}`);
    // Newest work supersedes, so the ones kept are the LATEST, rendered
    // in the order they happened.
    assert.strictEqual(d.text, 'Statement number 4; Statement number 5; Statement number 6');
  });

  check('digest: a distilled statement beats a harvested one within the same session', () => {
    const d = only(digest.buildDayDigests([
      entry({ session: 'a', ts: '2026-08-05T14:00:00.000Z', distilled: false, summary: 'A harvested trailing line.' }),
      entry({ session: 'a', ts: '2026-08-05T10:00:00.000Z', distilled: true, headline: 'The distilled statement' }),
    ]));
    assert.strictEqual(d.text, 'The distilled statement',
      'distilled beats harvested even when older -- the same tiering pickSummary already applies');
    assert.strictEqual(d.kind, 'distilled');
  });

  check('digest: with no headline it falls back to the summary\'s first sentence', () => {
    const d = only(digest.buildDayDigests([
      entry({ distilled: true, summary: 'Rewrote the feed grouping. Then spent an hour on the cursor seam, which is still open.' }),
    ]));
    assert.strictEqual(d.text, 'Rewrote the feed grouping.');
  });

  check('digest: a mix of distilled and harvested statements is reported as a mix, not as distilled', () => {
    const d = only(digest.buildDayDigests([
      entry({ session: 'a', ts: '2026-08-05T10:00:00.000Z', distilled: true, headline: 'The distilled one' }),
      entry({ session: 'b', ts: '2026-08-05T11:00:00.000Z', distilled: false, summary: 'The harvested one.' }),
    ]));
    assert.strictEqual(d.kind, 'summary',
      'kind may only claim distilled when every clause in the sentence is');
  });

  // -------------------------------------------------------------------------
  // Degrading honestly
  // -------------------------------------------------------------------------

  check('digest: a day with nothing to summarise SAYS so instead of inventing one', () => {
    const d = only(digest.buildDayDigests([
      entry({ session: 'a', goal: 'wire up the export button', headline: null, summary: null }),
    ]));
    assert.strictEqual(d.kind, 'none');
    assert.strictEqual(d.text, digest.NO_DAY_SUMMARY);
    assert.strictEqual(d.sources.length, 0, 'a placeholder has no provenance because nothing wrote it');
    assert.strictEqual(d.summarized, 0);
  });

  check('digest: an intent is never promoted into an outcome', () => {
    // goal says what the session was FOR. Rendering it as what the day
    // ACHIEVED is a claim nobody made, and it is the most tempting shortcut
    // available here.
    const d = only(digest.buildDayDigests([
      entry({ goal: 'Make the installer stop failing on Windows' }),
    ]));
    assert.strictEqual(d.text, digest.NO_DAY_SUMMARY);
    assert.ok(!/installer/i.test(d.text), 'the intent leaked into the outcome sentence');
  });

  check('digest: a day of unreadable rows says THAT, which is a different fact from "no summary"', () => {
    const d = only(digest.buildDayDigests([
      entry({ session: 'a', undecryptable: true, headline: null }),
      entry({ session: 'b', undecryptable: true, headline: null }),
    ]));
    assert.strictEqual(d.kind, 'undecryptable');
    assert.strictEqual(d.text, digest.OPAQUE_DAY_SUMMARY);
  });

  check('digest: server-supplied text on an unreadable row can never become the day sentence', () => {
    // Fail-closed: an undecryptable row's content fields are nulled on purpose
    // (lib/feed.js), so text on one could only have come from the untrusted
    // server columns. dayCards.ts guards the same thing belt-and-braces.
    const d = only(digest.buildDayDigests([
      entry({ session: 'a', undecryptable: true, headline: 'ATTACKER SUPPLIED HEADLINE', distilled: true }),
      entry({ session: 'b', headline: 'The real one this machine can read', distilled: true }),
    ]));
    assert.strictEqual(d.text, 'The real one this machine can read');
    assert.strictEqual(d.undecryptableEntries, 1, 'the unreadable row is still counted, just never quoted');
  });

  check('digest: a session-less row is its own session, never folded with the others', () => {
    const d = only(digest.buildDayDigests([
      entry({ session: null, ts: '2026-08-05T10:00:00.000Z', distilled: true, headline: 'One bare row' }),
      entry({ session: null, ts: '2026-08-05T11:00:00.000Z', distilled: true, headline: 'Another bare row' }),
    ]));
    assert.strictEqual(d.sessions, 2, 'falling back to a shared key would count these as one session');
  });

  // -------------------------------------------------------------------------
  // Coverage honesty
  // -------------------------------------------------------------------------

  check('digest: the day a truncated page ends on is marked incomplete', () => {
    const es = [
      entry({ ts: '2026-08-05T18:00:00.000Z', session: 'a', distilled: true, headline: 'Today so far' }),
      entry({ ts: '2026-08-04T09:00:00.000Z', session: 'b', distilled: true, headline: 'The tail of yesterday' }),
    ];
    const out = digest.buildDayDigests(es, { truncatedBefore: '2026-08-04T09:00:00.000Z' });
    const today = out.find(d => d.day === digest.dayKeyLocal(new Date(es[0].ts)));
    const older = out.find(d => d.day === digest.dayKeyLocal(new Date(es[1].ts)));
    assert.strictEqual(today.complete, true, 'a day wholly inside the page is complete');
    assert.strictEqual(older.complete, false,
      'the boundary day may have earlier entries the page never carried, and must not pretend otherwise');
    assert.ok(/only the part of this day/i.test(older.coverageNote || ''),
      `an incomplete day must disclose it; got ${JSON.stringify(older.coverageNote)}`);
  });

  check('digest: an untruncated page marks every day complete', () => {
    const out = digest.buildDayDigests([entry({ distilled: true, headline: 'All of it' })]);
    assert.strictEqual(out[0].complete, true);
  });

  // -------------------------------------------------------------------------
  // The join key the UI card renders against
  // -------------------------------------------------------------------------

  check('digest: the key is day + author, the day card key with the project part removed', () => {
    const d = only(digest.buildDayDigests([entry({ authorId: 'ME-UPPER', distilled: true, headline: 'x' })]));
    assert.strictEqual(d.key, `${d.day} id:me-upper`,
      'the key must normalize exactly as dayCards.ts authorPart does (lowercased, id: namespace)');
  });

  check('digest: every source names an entry the UI can find by the id it already builds', () => {
    // mappers.ts streamEntryId is `${session || 'none'}|${ts}`. Emitting the
    // same string means the card can link its sentence at the session it
    // describes without the daemon inventing a second identity scheme.
    const d = only(digest.buildDayDigests([
      entry({ session: 'sess-1', ts: '2026-08-05T14:00:00.000Z', distilled: true, headline: 'A thing' }),
    ]));
    assert.strictEqual(d.sources[0].entryId, 'sess-1|2026-08-05T14:00:00.000Z');
    assert.strictEqual(d.sources[0].session, 'sess-1');
    assert.strictEqual(d.sources[0].distilled, true);
    assert.strictEqual(d.sources[0].project, 'membridge');
  });

  check('digest: a session-less row still produces a findable entry id', () => {
    const d = only(digest.buildDayDigests([
      entry({ session: null, ts: '2026-08-05T14:00:00.000Z', distilled: true, headline: 'A thing' }),
    ]));
    assert.strictEqual(d.sources[0].entryId, 'none|2026-08-05T14:00:00.000Z');
  });

  // -------------------------------------------------------------------------
  // Degenerate input
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // How it reaches the UI
  // -------------------------------------------------------------------------

  await check('/api/feed serves the digests alongside the entries they describe', async () => {
    // Signed out, local entries only: exactly the state a first-run machine
    // is in, and the one where authorId is null and the name key is used.
    process.env.MEMBRIDGE_HOME = path.join(h.ROOT, 'home-digest');
    fs.mkdirSync(process.env.MEMBRIDGE_HOME, { recursive: true });
    const util = require('../../lib/util');
    util.ensureConfig();

    const proj = path.join(h.ROOT, 'projects', 'digest-app');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    const slug = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-digest');
    fs.mkdirSync(slug, { recursive: true });
    const at = new Date(Date.now() - 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(slug, 'sess.jsonl'), h.jsonl([
      { type: 'user', message: { role: 'user', content: 'Wire up the export button' }, cwd: proj, timestamp: at },
    ]));
    require('../../lib/scan').syncOnce();

    const port = h.P(72);
    const srv = require('../../lib/server').startServer(port, { retries: 0 });
    try {
      await h.waitForHttp(`http://127.0.0.1:${port}/api/status`);
      const body = await h.httpGet(port, '/api/feed');
      assert.ok(Array.isArray(body.dayDigests), `/api/feed carried no dayDigests: ${JSON.stringify(Object.keys(body))}`);
      assert.ok(body.entries.length > 0, 'fixture: the feed served no entries, so there is nothing to digest');
      assert.strictEqual(body.dayDigests.length, 1, 'one person, one day, one digest');

      const d = body.dayDigests[0];
      // The join the UI performs: recompute the card's own key from an entry
      // and find the digest by it. If these ever disagree the card renders a
      // sentence about somebody else's day.
      const e = body.entries[0];
      const authorPart = e.authorId ? `id:${String(e.authorId).trim().toLowerCase()}` : `name:${String(e.author).trim().toLowerCase()}`;
      assert.strictEqual(d.key, `${digest.dayKeyLocal(new Date(e.ts))} ${authorPart}`,
        'the digest key does not match the key the UI builds from the entry');
      // Nothing was summarised (a bare prompt, no Stop hook), so it must say
      // so rather than dress the prompt up as an outcome.
      assert.strictEqual(d.kind, 'none');
      assert.strictEqual(d.text, digest.NO_DAY_SUMMARY);
      assert.deepStrictEqual(d.projects, ['digest-app']);
      assert.strictEqual(typeof d.tz, 'string');
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  check('digest: no entries produce no digests, and never a placeholder day', () => {
    assert.deepStrictEqual(digest.buildDayDigests([]), []);
    assert.deepStrictEqual(digest.buildDayDigests(null), []);
  });

  check('digest: an entry with an unparseable ts is dropped rather than filed under NaN', () => {
    const out = digest.buildDayDigests([
      entry({ ts: 'not a date', headline: 'nonsense', distilled: true }),
      entry({ ts: '2026-08-05T14:00:00.000Z', session: 'ok', headline: 'real', distilled: true }),
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].text, 'real');
  });

  h.finish();
}

main();
