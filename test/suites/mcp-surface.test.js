'use strict';
// The MCP tool surface — what another team's AI agent can pull, and under what
// bounds. Six tools: search_memory, why, get_project_memory, recall,
// get_recent_activity, list_projects.
//
// This surface has a different shape from the app. A person clicks one project;
// an agent asks for everything, phrases it a hundred ways, and acts on whatever
// comes back. So the properties worth pinning are containment (what bounds a
// query) and honesty (what a returned number licenses an agent to conclude).
//
// Most of what follows PASSES and is pinned because nothing else stated it.
// Containment on this path is genuinely correct and was verified rather than
// assumed — the recovered person-filter draft read rows directly instead of
// going through util.teamRowsFor, and that is exactly the regression these
// guards would catch.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', '..', 'lib');
const src = f => fs.readFileSync(path.join(LIB, f), 'utf8');

// Read the source rather than driving the tools. Driving them needs a populated
// state fixture per tool and would prove the behaviour for ONE shaped input;
// these are structural properties that must hold for every input, and the
// failure mode being guarded is a future edit dropping a call, not a bad value.
// Stated plainly because a source-reading test is weaker evidence than an
// executed one, and the difference matters when reading a green result.
//
// CONVERSION ATTEMPTED, AND WHERE IT STOPPED. The redaction checks below are
// the ones worth executing rather than reading: a source read proves a field is
// PASSED to the redactor, only an executed test proves a planted secret does not
// come out the other side — and this session already found two content-bearing
// fields on the wire that never reached the redactor at all, so the consequence
// is proven rather than theoretical.
//
// The tools are drivable in-process (lib/mcp.js exports getProjectMemory,
// searchMemory, whyFile and the rest specifically for tests), and a first pass
// with a planted PEM in a prompt event returned no leak. That pass was NOT
// trustworthy: the fixture produced `sessions: 0`, so nothing was rendered and
// the assertion would have been vacuous — the same shape as this session's
// JSON.stringify defect, caught before it was committed rather than after.
//
// WHAT IT WOULD TAKE, for whoever picks this up. The blocker is not the MCP
// layer, it is building state that memorydb.buildEntries will actually turn into
// a session: the project must be tracked in config AND on disk, and the event
// stream needs the shape buildEntries groups on (a prompt plus at least one
// in-project edit, with the file path resolving under the project root — see
// the capture-containment suite for why an out-of-root file clears the project
// and drops the session entirely). Roughly an hour, and it is worth doing
// because the SAME fixture unlocks the executed version of several checks here
// and the failing-prune case named in destructive-paths.test.js. Not attempted
// further here rather than shipping a green test that proves nothing.
const activity = src('activity.js');
const mcp = src('mcp.js');
const feed = src('feed.js');

async function main() {
  // CONTAINMENT. Revocation reaches this path two ways, and both must stay.
  // teamAccessLost is what makes a laptop that has not synced since losing
  // access stop answering; teamRowsFor is the only reader that applies the
  // per-row revocation filter. Either one alone leaves a hole.
  await check('the search corpus drops team rows when access was lost', () => {
    assert.match(activity, /teamAccessLost\s*\?\s*\[\]/,
      'projectEntries must contribute NOTHING from the team side once ' +
      'teamAccessLost is set — otherwise a machine that has not checked in ' +
      'keeps answering from a project it may no longer read');
  });

  await check('team rows on the search path are read only via util.teamRowsFor', () => {
    assert.match(activity, /util\.teamRowsFor\(proj\)/,
      'util.teamRowsFor is the only supported reader; reading proj.teamEntries ' +
      'directly bypasses the revocation filter — the exact bug in the recovered ' +
      'person-filter draft');
    assert.ok(!/proj\.teamEntries\b/.test(activity.replace(/\/\/[^\n]*/g, '')),
      'no code path in activity.js may reach proj.teamEntries directly');
  });

  // The durable archive is the half that reaches PAST the local cache, so it is
  // the half most likely to be forgotten when redaction or scoping changes.
  await check('the durable archive is read through the same redacting mapper', () => {
    assert.match(activity, /loadArchive\([^)]*\)\.rows\.map\(e => mapTeamRow\(e, name, redact/,
      'archive rows must go through mapTeamRow with the redact closure, like ' +
      'live-cached rows — the archive is not a second, unredacted door');
  });

  // REDACTION, per tool. The mechanism differs by tool, which is itself the
  // risk: get_project_memory and why redact field-by-field at the MCP boundary,
  // while search_memory and get_recent_activity inherit it from the feed
  // normalizers. Both are pinned so neither can be dropped quietly.
  await check('get_project_memory redacts every free-text field it returns', () => {
    for (const field of ['ask', 'goal', 'headline', 'result', 'decisions', 'gotchas']) {
      assert.ok(new RegExp(`${field}: redactedOrNull\\(regexes`).test(mcp),
        `get_project_memory must redact ${field} at the MCP boundary`);
    }
    assert.match(mcp, /changes: redactChanges\(regexes/,
      'the structured change model has a free-text note and must be re-redacted');
  });

  await check('the search path threads a redact closure into the normalizers', () => {
    assert.match(activity, /const redact = t => digest\.redactText\(t, regexes\)/,
      'projectEntries must build a redactor');
    assert.match(activity, /normalizeLocal\(e, \{ projectPath: key, projectName: name, redact/,
      'local entries must be normalized WITH the redactor');
  });

  // The unclipped twins are the sibling-field trap: `ask` is clipped for the
  // wire while `askFull` is the machine-local full text, and an agent asking
  // through MCP gets the full one. If redaction had been wired to the clipped
  // field only, the tool would return more secret than the wire ever could.
  await check('the unclipped askFull/summaryFull twins are redacted too', () => {
    assert.match(feed, /askFull: applyRedact\(redact, e\.askFull\)/,
      'askFull is the full text an MCP caller receives and must be redacted');
    assert.match(feed, /summaryFull: applyRedact\(redact, e\.summaryFull\)/,
      'summaryFull likewise');
  });

  // THE HONESTY GAP, and the only failing check here.
  //
  // searchMemory returns `total: ranked.length + backfilled.length` — a count
  // of matches in THIS MACHINE's corpus: what it has pulled, plus what its
  // durable archive has backfilled so far. It is a floor, not a total. The tool
  // DESCRIPTION is honest ("everything MemBridge remembers on this machine"),
  // but the payload field is not, and an agent quoting a number quotes the
  // number, not the description around it.
  //
  // This is the same class the app spent today closing — a count the UI now
  // marks as a floor, returned flat to an agent that will state it as fact.
  // "There are 29 sessions about the auth rotation" is a conclusion the app
  // deliberately refuses to state and this payload licenses.
  //
  // Product code, so found not fixed. The fix is naming it: `totalKnownHere`,
  // or a sibling `totalIsFloor: true`, or the coverage the archive actually has.
  await check('the search result does not present a local floor as a total', () => {
    assert.ok(!/total: ranked\.length \+ backfilled\.length/.test(activity),
      'searchMemory returns a bare `total` counting only locally-held rows ' +
      '(ranked + backfilled). Team history not yet pulled or backfilled is not ' +
      'in it, so it is a FLOOR presented as a total. Rename it or ship a ' +
      'companion flag saying so — an agent will state this number as fact.');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
