'use strict';
// The append side of the recall measurement queue
// (.membridge/recall/events.jsonl): where it lives, and how one row is added.
//
// Split out of lib/hooks-recall.js for the reason lib/token-estimate.js was
// split out of lib/skeleton.js -- so a caller that only needs to append a
// measurement row does not pay for the graph behind the module that happens
// to own the read path. lib/hooks-notes.js is exactly that caller: it runs on
// every SessionStart and needs four lines of this, not recall-store,
// ledger-store, teamsync and diagnostics (measured: ~22ms of extra require
// time, and a dependency edge from the smallest hook in the feature to the
// largest). lib/hooks-recall.js re-exports recallDir/eventsPath so its own
// public surface is unchanged.
//
// The fold half of this queue -- reading, settling and REWRITING it -- lives
// in lib/ledger-fold-recall.js. Anything appended here that the fold does not
// recognise is dropped by that rewrite, so a new row `kind` must always be
// taught to lib/ledger-fold-recall-settle.js's settleRows in the same change.
const fs = require('fs');
const path = require('path');
const memorydb = require('./memorydb');
const { rotateEvents } = require('./hooks-recall-rotate');

const recallDir = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'recall');
const eventsPath = projectPath => path.join(recallDir(projectPath), 'events.jsonl');

function appendEvent(projectPath, event) {
  fs.mkdirSync(recallDir(projectPath), { recursive: true });
  const file = eventsPath(projectPath);
  rotateEvents(file);
  fs.appendFileSync(file, JSON.stringify(event) + '\n');
}

module.exports = { recallDir, eventsPath, appendEvent };
