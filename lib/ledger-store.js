'use strict';
const fs = require('fs');
const path = require('path');
const { foldProjectLedger, LIMITS } = require('./ledger-fold');
const { DIR_NAME } = require('./memorydb');

const FILE = 'ledger.json';
const ledgerPath = projectPath => path.join(projectPath, DIR_NAME, FILE);

// Pure one-shot build: a fold onto nothing. Kept for tests and for anything
// that wants a ledger for a set of events without touching disk. Production
// scanning goes through readLedger -> foldProjectLedger -> writeLedger so
// totals accumulate instead of being recomputed from a sliding window.
// plumbingCap is optional -- omit it to get the default-config key horizon
// (see keyHorizonFor in lib/ledger-fold-state.js).
const buildProjectLedger = (events, plumbingCap) => foldProjectLedger(null, events, plumbingCap);

// Monotonic per-process counter so two writeLedger calls in the same tick
// never collide on the temp path; combined with the pid, two daemons (app +
// CLI) writing the same ledger.json at once can't collide on it either.
let writeLedgerCounter = 0;

// Atomic write: ledger.json is the only file in the repo whose contents
// cannot be rebuilt (its dedupe evidence has no other source once lost), so
// it gets the same tmp-file + rename treatment lib/util.js's saveState uses
// for state.json. Serialize first, write to a throwaway temp file in the
// same directory, then rename into place -- rename on the same filesystem is
// atomic on POSIX/macOS, so a crash or write error can only ever leave a
// stray temp file behind, never a half-written ledger.json.
function writeLedger(projectPath, data) {
  const p = ledgerPath(projectPath);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(data, null, 1); // throws before anything touches disk
  const tmp = path.join(dir, `.ledger.json.${process.pid}.${writeLedgerCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
  return p;
}

function readLedger(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Read the project's persisted ledger, fold this pass's window into it, write
// it back. The single entry point production scanning uses. `config` (the
// effective config for this sync pass) supplies maxPlumbingEvents so the
// fold's dedupe horizon scales with the user's actual window instead of a
// fixed guess -- see the INVARIANT comment on keyHorizonFor.
function updateLedger(projectPath, events, config) {
  const plumbingCap = config && config.maxPlumbingEvents;
  const next = foldProjectLedger(readLedger(projectPath), events, plumbingCap);
  writeLedger(projectPath, next);
  return next;
}

module.exports = {
  buildProjectLedger, foldProjectLedger, updateLedger,
  writeLedger, readLedger, ledgerPath, LIMITS,
};
