'use strict';
// The fs layer for <project>/.membridge/teammate-notes.json -- the single
// source of truth every delivery point reads (spec §4).
//
// FAIL-OPEN, like lib/recall-store.js's get(): any read or parse error is a
// MISS (null), never a thrown error. A hook that cannot read this file must
// behave exactly as if there were no teammate notes at all.
//
// One file, not a directory of blobs: the hook path reads it ahead of
// lib/hooks-recall.js's storeEntry gate on every Read, so it must be a single
// small parse and nothing more (spec §4.1).
const fs = require('fs');
const path = require('path');
const { DIR_NAME } = require('./memorydb');
const notes = require('./teammate-notes');

const notesPath = projectPath => path.join(projectPath, DIR_NAME, 'teammate-notes.json');

// Same tmp + rename pattern as lib/util.js's saveState, lib/ledger-store.js's
// writeLedger and lib/recall-store.js's put: a crash mid-write can only ever
// leave a stray temp file behind, never a half-written index.
let writeCounter = 0;

function write(projectPath, index) {
  const target = notesPath(projectPath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(index); // throws before anything touches disk
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
}

function read(projectPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(notesPath(projectPath), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

// Read-modify-write. A missing or corrupt index starts from empty rather than
// aborting: a hook marking a note as delivered must not fail just because the
// file was damaged -- worst case it re-delivers once.
function update(projectPath, fn) {
  try {
    const current = read(projectPath) || notes.emptyIndex();
    const next = fn(current);
    write(projectPath, next);
    return next;
  } catch {
    return null;
  }
}

module.exports = { notesPath, read, write, update };
