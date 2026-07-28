'use strict';
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const redundancy = require('./redundancy');
const { DIR_NAME } = require('./memorydb');

const FILE = 'ledger.json';
const ledgerPath = projectPath => path.join(projectPath, DIR_NAME, FILE);

function buildProjectLedger(events) {
  const requests = ledger.buildRequests(events);
  const vol = ledger.sessionVolume(requests);
  const reads = events.filter(e => e && e.kind === 'read');
  const classified = redundancy.classifyReads(reads, events.filter(e => e && e.kind === 'edit'));

  // Hot set: paths more than one session has read. These are exactly the
  // paths a recall layer could serve, so they drive pre-warming later.
  const byFile = new Map();
  for (const r of classified) {
    let rec = byFile.get(r.file);
    if (!rec) { rec = { file: r.file, readers: new Set(), reads: 0 }; byFile.set(r.file, rec); }
    rec.readers.add(r.session);
    rec.reads++;
  }
  const hotPaths = Array.from(byFile.values())
    .filter(r => r.readers.size > 1)
    .map(r => ({ file: r.file, readers: r.readers.size, reads: r.reads }))
    .sort((a, b) => b.reads - a.reads);

  return {
    updatedAt: new Date().toISOString(),
    sessions: new Set(requests.map(r => r.session)).size,
    requests: vol.nRequests,
    volume: vol.volume,
    inCost: vol.inCost,
    outCost: vol.outCost,
    reads: redundancy.tally(classified),
    hotPaths,
  };
}

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

module.exports = { buildProjectLedger, writeLedger, readLedger, ledgerPath };
