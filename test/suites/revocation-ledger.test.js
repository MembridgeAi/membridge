'use strict';
// The durable revocation ledger itself (lib/revocation-ledger.js).
//
// revocation-state-reset.test.js next door pins the BUG this exists for: a
// state.json rebuild silently un-revoking a project, and the two caches that
// resume serving when it does. This suite pins the ledger's own contract --
// the parts a fix can get wrong in the other direction, none of which that
// suite would notice:
//
//   * it costs a machine that has never had a revocation nothing, and writes
//     no file (a security mechanism that leaves debris on every install gets
//     turned off);
//   * a re-grant still works -- a writer that SAW the revocation may lift it,
//     which is the path lib/teamsync.js takes when the backend lists the
//     project again. Get this wrong and a re-added teammate is locked out of
//     their own team forever, with nothing on screen to say why;
//   * a writer that did NOT see it cannot lift it, which is the whole
//     asymmetry the fix rests on;
//   * an unreadable ledger fails CLOSED, unlike almost every other local cache
//     in this repo, because the only thing a wrong "closed" withholds is other
//     people's content and the next good read hands it back;
//   * the seen-revoked tag never reaches disk.
//
// Run directly, or via `node test/run.js revocation-ledger`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const ledger = require('../../lib/revocation-ledger');

const REVOKED_AT = '2026-08-05T12:00:00.000Z';

function projectPath(name) {
  const key = path.join(h.ROOT, 'ledger-projects', name);
  fs.mkdirSync(key, { recursive: true });
  return key;
}

function main() {
  util.ensureConfig();

  // ---- 1. a machine with no revocation pays nothing and leaves no file ----
  {
    const key = projectPath('clean');
    const st = util.loadState();
    st.projects = st.projects || {};
    st.projects[key] = { events: [] };
    util.saveState(st);

    check('clean machine: no ledger file is created', () => {
      assert.strictEqual(fs.existsSync(ledger.ledgerPath()), false,
        'a machine that has never had a revocation grew a revocations.ndjson');
      assert.strictEqual(util.mayServeTeammateNotes(key), true);
      assert.deepStrictEqual(ledger.revokedPaths(), []);
    });
    check('clean machine: the seen-revoked tag never reaches state.json', () => {
      const raw = fs.readFileSync(util.statePath(), 'utf8');
      assert.ok(!/seenRevoked/i.test(raw),
        'the load-time revocation tag was serialized into state.json');
    });
  }

  // ---- 2. the mirror: any save that carries the flag makes it durable ----
  // Deliberately NOT keyed on lib/teamsync.js being the writer: an install
  // that was already revoked before this shipped becomes durable on its next
  // ordinary save, with no sync pass and no network.
  {
    const key = projectPath('revoked');
    const st = util.loadState();
    st.projects[key] = { events: [], teamAccessLost: REVOKED_AT };
    util.saveState(st);

    check('mirror: an ordinary save records the revocation', () => {
      assert.strictEqual(ledger.isRevoked(key), true, 'the revocation was not mirrored out of state');
      assert.strictEqual(util.mayServeTeammateNotes(key), false);
      assert.ok(ledger.revokedPaths().includes(util.normPath(key)));
    });
    check('mirror: the ledger keeps the revocation timestamp, not the save time', () => {
      const lines = fs.readFileSync(ledger.ledgerPath(), 'utf8').trim().split('\n').map(JSON.parse);
      const mine = lines.filter(r => util.normPath(r.project) === util.normPath(key));
      assert.strictEqual(mine.length, 1, 'the mirror appended more than once for one revocation');
      assert.strictEqual(mine[0].ts, REVOKED_AT);
      assert.strictEqual(mine[0].event, 'revoked');
    });

    // ---- 3. a writer that DID see it may lift it (the re-grant path) ----
    check('re-grant: a writer that saw the revocation can lift it', () => {
      const back = util.loadState();
      delete back.projects[key].teamAccessLost;
      util.saveState(back);
      assert.strictEqual(ledger.isRevoked(key), false,
        'a writer that loaded the flag and removed it could not un-revoke — a re-added teammate would stay locked out');
      assert.strictEqual(util.mayServeTeammateNotes(key), true);
      assert.ok(!util.loadState().projects[key].teamAccessLost, 'the flag was stamped back over a legitimate re-grant');
    });
  }

  // ---- 4. a writer that did NOT see it cannot lift it ----
  // A state assembled from scratch (no load behind it) carries no tag, which
  // is the same position a writer is in after loadState discarded the file.
  // Its silence about access is not consent, and the flag comes back.
  {
    const key = projectPath('untagged');
    const st = util.loadState();
    st.projects[key] = { events: [], teamAccessLost: REVOKED_AT };
    util.saveState(st);

    check('untagged writer: cannot un-revoke, and state.json is repaired', () => {
      const prior = util.loadState();
      util.saveState({
        version: util.STATE_VERSION,
        files: prior.files || {},
        projects: { ...prior.projects, [key]: { events: [] } }, // flag dropped, no tag
        catchup: prior.catchup,
        feedback: prior.feedback,
      });
      assert.strictEqual(ledger.isRevoked(key), true,
        'a state built without loading one was allowed to un-revoke a project');
      assert.ok(util.loadState().projects[key].teamAccessLost,
        'the kept revocation was not stamped back into the project record');
      assert.strictEqual(util.mayServeTeammateNotes(key), false);
    });
  }

  // ---- 5. an unreadable ledger fails CLOSED ----
  // Opposite rule to the rest of this repo's local caches, on purpose: a
  // ledger we cannot read is not evidence that nothing was revoked. Simulated
  // with a directory in its place (EISDIR) rather than a chmod, because a
  // chmod changes neither mtime nor size and so would be answered from the
  // parse cache — which is correct behaviour, and would test nothing here.
  {
    const key = projectPath('never-revoked');
    const p = ledger.ledgerPath();
    const saved = fs.readFileSync(p, 'utf8');
    fs.rmSync(p);
    fs.mkdirSync(p);
    try {
      check('unreadable ledger: every project is refused', () => {
        assert.strictEqual(ledger.isRevoked(key), true,
          'an unreadable ledger was read as "nothing was ever revoked"');
        assert.strictEqual(util.mayServeTeammateNotes(key), false);
      });
    } finally {
      fs.rmSync(p, { recursive: true });
      fs.writeFileSync(p, saved);
    }
    check('unreadable ledger: recovers the moment it can be read again', () => {
      assert.strictEqual(ledger.isRevoked(key), false, 'the ledger stayed closed after it became readable');
      assert.strictEqual(util.mayServeTeammateNotes(key), true);
    });
  }

  // ---- 6. a torn tail does not take the good lines with it ----
  // The file is append-only precisely so a crash mid-append can only ever cost
  // the line it was writing.
  {
    const key = projectPath('torn');
    const st = util.loadState();
    st.projects[key] = { events: [], teamAccessLost: REVOKED_AT };
    util.saveState(st);
    fs.appendFileSync(ledger.ledgerPath(), '{"ts":"2026-08-0');

    check('torn tail: earlier revocations survive an incomplete last line', () => {
      assert.strictEqual(ledger.isRevoked(key), true,
        'a half-written last line discarded every revocation before it');
    });
  }

  h.finish();
}

main();
