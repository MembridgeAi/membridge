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
const buildProjectLedger = events => foldProjectLedger(null, events);

function writeLedger(projectPath, data) {
  const p = ledgerPath(projectPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 1));
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
// it back. The single entry point production scanning uses.
function updateLedger(projectPath, events) {
  const next = foldProjectLedger(readLedger(projectPath), events);
  writeLedger(projectPath, next);
  return next;
}

module.exports = {
  buildProjectLedger, foldProjectLedger, updateLedger,
  writeLedger, readLedger, ledgerPath, LIMITS,
};
