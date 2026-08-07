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
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const mcpTools = require('../../lib/mcp');
const activityLib = require('../../lib/activity');

const LIB = path.join(__dirname, '..', '..', 'lib');
const src = f => fs.readFileSync(path.join(LIB, f), 'utf8');

// TWO KINDS OF CHECK LIVE IN THIS FILE, and the difference is the point.
//
// SOURCE READS (activitySrc/mcpSrc/feedSrc below) stay for the structural
// properties: "this call is still here", "this reader is still the only one".
// Those must hold for EVERY input, the failure mode is a future edit deleting a
// line, and no single executed input could prove them. They are weaker evidence
// than an executed test and that is stated here rather than left implied.
//
// EXECUTED CHECKS, converted in this commit, cover the property a source read
// cannot reach: a source read proves a field is PASSED to the redactor; only an
// executed test proves a planted secret does not come out the other side. This
// session found two content-bearing fields on the wire that never reached the
// redactor at all, so that consequence is proven rather than theoretical.
//
// WHAT THE EXECUTED VERSION NOW PROVES THAT THE SOURCE READ DID NOT:
//   1. The rendered payload of get_project_memory contains no planted secret —
//      across BOTH halves (own sessions and teammate rows), in every free-text
//      field AND inside the structured change model's free-text `note`.
//   2. It proves that while the payload is still POPULATED. Every leak
//      assertion is paired with a survival assertion on a neighbouring
//      non-secret marker word, so a redactor that returned null (or '') for
//      everything — the cheapest possible way to make a leak test green —
//      fails instead of passing.
//   3. The teammate half is the sharpest of the two: raw teamEntries reach
//      lib/mcp.js unredacted (digest.teamInjectSlice does not redact), so
//      redactedOrNull at that boundary is the ONLY thing standing between a
//      teammate's planted secret and the agent. Breaking it leaks immediately,
//      which the mutation run confirmed.
//   4. search_memory's rendered results are clean over the same corpus — the
//      normalizer path, not the MCP-boundary path, so the two mechanisms this
//      file has always described separately are now separately executed.
//
// The previous attempt stopped here rather than shipping, because its fixture
// rendered nothing: the assertions would have been VACUOUSLY green, which reads
// as stronger evidence than the source read it replaced while being weaker. The
// answer is the FIXTURE PRECONDITIONS block below — named checks that go red on
// their own if nothing rendered, not a comment asking the reader to trust it.
const activitySrc = src('activity.js');
const mcpSrc = src('mcp.js');
const feedSrc = src('feed.js');

// ---------------------------------------------------------------------------
// THE FIXTURE
// ---------------------------------------------------------------------------
// SYNTHETIC, and visibly so. The "key material" below is an English sentence
// naming this file — not base64, not derived from any real key, and nothing is
// revealed if it ever did leak. lib/redact.js's `private-key` pattern keys on
// the BEGIN/END markers and nothing whatsoever about the body, so a readable
// body exercises exactly the rule a real key would.
//
// NEEDLE is what every leak assertion greps for. If redaction stops working it
// appears verbatim in the payload; when redaction works the whole block
// collapses to the single token `[redacted:private-key]`.
const NEEDLE = 'SYNTHETIC NOT A REAL KEY';
const SECRET = [
  '-----BEGIN RSA PRIVATE KEY-----',
  `${NEEDLE} planted by test/suites/mcp-surface.test.js`,
  '-----END RSA PRIVATE KEY-----',
].join('\n');

// The survival markers. Short and lowercase on purpose: lib/redact.js's entropy
// backstop only fires at 24+ characters, so these cannot be swept up by it and
// their absence always means a builder dropped the field, never that redaction
// was over-eager.
const LOCAL_MARK = 'localbeacon';
const TEAM_MARK = 'teambeacon';

// Long enough that digest.clip(…, 300) actually truncates AFTER redaction, so
// buildEntries populates the unclipped askFull twin. Without this the twin is
// null and the twin check below would be the vacuous kind this file exists to
// refuse.
const PAD = 'considered the rotation window carefully. '.repeat(12);

const PROJECT = path.join(ROOT, 'projects', 'mcp-surface-app');
const LOCAL_SESSION = 'mcp-surface-local';
const TEAM_SESSION = 'mcp-surface-team';
const EDITED_FILE = 'lib/vault.js';

// Everything digest.sessionGroups and memorydb.buildEntries need to yield ONE
// rendered session, established by driving them rather than by reading them:
//   - the project tracked in state AND present on disk;
//   - a prompt, so buildEntries opens an entry;
//   - an in-project edit whose absolute path resolves UNDER the project root
//     (an out-of-root file is cleared and the session drops entirely — see
//     test/suites/capture-containment.test.js, which pins that on purpose);
//   - a distilled summary carrying the four why-fields, since goal/headline/
//     decisions/gotchas ride on the summary event and not on the prompt;
//   - `highlights`, which is the only way a structured change gets a free-text
//     `note` — the field redactChanges exists for.
// The teammate half is a RAW row, exactly as lib/teamsync.js pullProject
// stores it: unredacted on disk, which is what makes the MCP boundary the only
// redactor in its path.
function plantFixture() {
  fs.mkdirSync(path.join(PROJECT, '.membridge'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, EDITED_FILE), '// fixture file\n');

  const state = util.loadState();
  state.projects[PROJECT] = {
    events: [
      {
        kind: 'prompt', session: LOCAL_SESSION, source: 'Claude Code',
        ts: '2026-08-01T00:00:00.000Z',
        text: `${LOCAL_MARK} rotate the signing key. ${PAD} here it is:\n${SECRET}\ndone`,
      },
      {
        kind: 'edit', session: LOCAL_SESSION, source: 'Claude Code',
        ts: '2026-08-01T00:01:00.000Z',
        file: path.join(PROJECT, EDITED_FILE),
      },
      {
        kind: 'summary', session: LOCAL_SESSION, source: 'Claude Code',
        ts: '2026-08-01T00:02:00.000Z', distilled: true,
        text: `${LOCAL_MARK} summary. ${PAD} the retired key was ${SECRET} and is revoked.`,
        headline: `${LOCAL_MARK} headline ${SECRET}`,
        goal: `${LOCAL_MARK} goal ${SECRET}`,
        decisions: `${LOCAL_MARK} decisions ${SECRET}`,
        gotchas: `${LOCAL_MARK} gotchas ${SECRET}`,
        highlights: [{ file: EDITED_FILE, note: `${LOCAL_MARK} note ${SECRET}` }],
      },
    ],
    // digest.teamInjectSlice drops anything older than teamMaxAgeHours (72h by
    // default), so this row is dated relative to now. A fixed past date here
    // would silently empty `teammates` and take the teammate checks with it —
    // the precondition below is what would catch that.
    teamEntries: [{
      author: 'Teammate', authorId: 'mcp-surface-teammate',
      ts: new Date(Date.now() - 3600000).toISOString(),
      source: 'Claude Code', session: TEAM_SESSION,
      ask: `${TEAM_MARK} ask ${SECRET}`,
      goal: `${TEAM_MARK} goal ${SECRET}`,
      headline: `${TEAM_MARK} headline ${SECRET}`,
      summary: `${TEAM_MARK} summary ${SECRET}`,
      decisions: `${TEAM_MARK} decisions ${SECRET}`,
      gotchas: `${TEAM_MARK} gotchas ${SECRET}`,
      distilled: true,
      files: [EDITED_FILE],
      changes: [{
        file: EDITED_FILE, status: 'edited', add: 1, del: 0,
        note: `${TEAM_MARK} note ${SECRET}`, dep: false,
      }],
    }],
  };
  util.saveState(state);
}

// Grep the WHOLE serialized payload, not a field list: a leak through a field
// nobody thought to enumerate is exactly the class this session already found
// twice, and a per-field loop would miss it by construction.
const leaks = payload => JSON.stringify(payload).includes(NEEDLE);

async function main() {
  // CONTAINMENT. Revocation reaches this path two ways, and both must stay.
  // teamAccessLost is what makes a laptop that has not synced since losing
  // access stop answering; teamRowsFor is the only reader that applies the
  // per-row revocation filter. Either one alone leaves a hole.
  //
  // These three stay SOURCE READS. "This call is still here" and "this is the
  // only reader" are claims about every possible input, and the executed
  // teamAccessLost check further down proves the behaviour for one input
  // without replacing them.
  await check('the search corpus drops team rows when access was lost', () => {
    assert.match(activitySrc, /teamAccessLost\s*\?\s*\[\]/,
      'projectEntries must contribute NOTHING from the team side once ' +
      'teamAccessLost is set — otherwise a machine that has not checked in ' +
      'keeps answering from a project it may no longer read');
  });

  await check('team rows on the search path are read only via util.teamRowsFor', () => {
    assert.match(activitySrc, /util\.teamRowsFor\(proj\)/,
      'util.teamRowsFor is the only supported reader; reading proj.teamEntries ' +
      'directly bypasses the revocation filter — the exact bug in the recovered ' +
      'person-filter draft');
    assert.ok(!/proj\.teamEntries\b/.test(activitySrc.replace(/\/\/[^\n]*/g, '')),
      'no code path in activity.js may reach proj.teamEntries directly');
  });

  // The durable archive is the half that reaches PAST the local cache, so it is
  // the half most likely to be forgotten when redaction or scoping changes.
  await check('the durable archive is read through the same redacting mapper', () => {
    assert.match(activitySrc, /loadArchive\([^)]*\)\.rows\.map\(e => mapTeamRow\(e, name, redact/,
      'archive rows must go through mapTeamRow with the redact closure, like ' +
      'live-cached rows — the archive is not a second, unredacted door');
  });

  // -------------------------------------------------------------------------
  // FIXTURE PRECONDITIONS — these come FIRST, and they fail loudly.
  // -------------------------------------------------------------------------
  // A test whose subject is "no secret came out" has to prove something came
  // out. The previous attempt's fixture rendered zero sessions; every leak
  // assertion below it would have passed while proving nothing. These are named
  // checks rather than comments precisely so that failure is visible in the
  // tally instead of being inferred from a suspiciously green run.
  plantFixture();
  const memory = mcpTools.getProjectMemory(PROJECT);

  await check('fixture precondition: get_project_memory renders exactly one local session', () => {
    assert.ok(!memory.error, `the tool refused the fixture project: ${memory.error}`);
    assert.strictEqual(memory.recentAsks.length, 1,
      'the planted project produced no rendered session — every leak assertion ' +
      'below would be VACUOUSLY green. Check the shape digest.sessionGroups ' +
      'groups on: a prompt, an in-project edit, and a summary in one session.');
    const s = memory.recentAsks[0];
    for (const field of ['ask', 'goal', 'headline', 'result', 'decisions', 'gotchas']) {
      assert.ok(s[field], `the rendered session has no ${field} — nothing to leak, nothing proven`);
    }
    assert.deepStrictEqual(s.files, [EDITED_FILE],
      'the in-project edit did not resolve under the project root, so the ' +
      'session rendered without its file');
    assert.strictEqual(s.changes.length, 1, 'the structured change model is empty');
    assert.ok(s.changes[0].note, 'the change carries no free-text note — redactChanges would have nothing to do');
  });

  await check('fixture precondition: get_project_memory renders exactly one teammate row', () => {
    assert.strictEqual(memory.teammates.length, 1,
      'the planted teammate row did not survive digest.teamInjectSlice — most ' +
      'likely its ts fell outside teamMaxAgeHours. The teammate leak checks ' +
      'below would be vacuous.');
    const t = memory.teammates[0];
    for (const field of ['ask', 'goal', 'headline', 'result', 'decisions', 'gotchas']) {
      assert.ok(t[field], `the rendered teammate row has no ${field}`);
    }
    assert.ok(t.changes.length && t.changes[0].note, 'the teammate change carries no free-text note');
  });

  const localHit = activityLib.searchMemory({ query: LOCAL_MARK });
  const teamHit = activityLib.searchMemory({ query: TEAM_MARK });
  const localRow = localHit.results.find(r => r.session === LOCAL_SESSION);
  const teamRow = teamHit.results.find(r => r.session === TEAM_SESSION);

  await check('fixture precondition: search_memory returns the planted local and team entries', () => {
    assert.ok(localRow, `search returned no local entry for ${LOCAL_MARK} — the search leak checks would be vacuous`);
    assert.strictEqual(localRow.origin, 'local');
    assert.ok(teamRow, `search returned no team entry for ${TEAM_MARK} — the search leak checks would be vacuous`);
    assert.strictEqual(teamRow.origin, 'team');
    assert.ok(localRow.askFull,
      'buildEntries did not populate the unclipped askFull twin — the planted ' +
      'ask must be long enough that clip(…, 300) truncates it, or the twin ' +
      'check below proves nothing');
  });

  // -------------------------------------------------------------------------
  // REDACTION, per tool — EXECUTED.
  // -------------------------------------------------------------------------
  // The mechanism differs by tool, which is itself the risk: get_project_memory
  // and why redact field-by-field at the MCP boundary, while search_memory and
  // get_recent_activity inherit it from the feed normalizers. Both paths are
  // driven below so neither can be dropped quietly.
  //
  // Each check is a PAIR: the secret is absent, AND the ordinary text beside it
  // survived. The pairing is what stops a builder that nulled every field —
  // the cheapest possible way to make a leak assertion green — from passing.
  await check('get_project_memory: a planted secret in every own-session field does not come back', () => {
    const s = memory.recentAsks[0];
    for (const field of ['ask', 'goal', 'headline', 'result', 'decisions', 'gotchas']) {
      assert.ok(!s[field].includes(NEEDLE),
        `get_project_memory returned the planted secret verbatim in ${field}`);
      assert.ok(s[field].includes(LOCAL_MARK),
        `${field} lost its surrounding text — redaction must remove the secret, ` +
        'not the field. A builder returning null here would otherwise pass.');
    }
  });

  await check("get_project_memory: the change model's free-text note is re-redacted", () => {
    // deriveChanges copies `note` straight off the summary event's highlights
    // with no redaction of its own, so redactChanges at the MCP boundary is the
    // only thing in this path.
    const note = memory.recentAsks[0].changes[0].note;
    assert.ok(!note.includes(NEEDLE), 'a secret planted in a change note came back verbatim');
    assert.ok(note.includes(LOCAL_MARK), 'the change note lost its surrounding text');
  });

  await check('get_project_memory: a planted secret in a raw TEAMMATE row does not come back', () => {
    // The sharpest of the redaction checks. digest.teamInjectSlice hands raw
    // rows straight off disk to lib/mcp.js — nothing redacted them on the way
    // in — so redactedOrNull here is the ONLY redactor in this path, and this
    // is the one field set where a break leaks a real teammate's secret.
    const t = memory.teammates[0];
    for (const field of ['ask', 'goal', 'headline', 'result', 'decisions', 'gotchas']) {
      assert.ok(!t[field].includes(NEEDLE),
        `get_project_memory returned a teammate's planted secret verbatim in ${field}`);
      assert.ok(t[field].includes(TEAM_MARK), `the teammate ${field} lost its surrounding text`);
    }
    assert.ok(!t.changes[0].note.includes(NEEDLE), "a teammate's change note leaked its secret");
    assert.ok(t.changes[0].note.includes(TEAM_MARK), 'the teammate change note lost its surrounding text');
  });

  await check('get_project_memory: nothing anywhere in the payload carries the planted secret', () => {
    // The per-field loops above enumerate; this greps the whole serialized
    // payload. A leak through a field nobody listed is the exact class this
    // session already found twice on the wire.
    assert.ok(!leaks(memory),
      'the planted secret appears somewhere in the get_project_memory payload ' +
      'outside the fields checked individually above');
  });

  await check('search_memory: the normalizer path returns no planted secret, on either origin', () => {
    for (const [label, row, mark] of [['local', localRow, LOCAL_MARK], ['team', teamRow, TEAM_MARK]]) {
      for (const field of ['ask', 'summary', 'goal', 'headline', 'decisions', 'gotchas']) {
        if (!row[field]) continue;
        assert.ok(!row[field].includes(NEEDLE),
          `search_memory leaked the planted secret in the ${label} row's ${field}`);
        assert.ok(row[field].includes(mark),
          `the ${label} row's ${field} lost its surrounding text`);
      }
    }
    assert.ok(!leaks(localHit) && !leaks(teamHit),
      'the planted secret appears somewhere in a search_memory payload');
  });

  await check('why: the file-provenance rows return no planted secret', () => {
    const why = mcpTools.whyFile(PROJECT, EDITED_FILE);
    assert.ok(why.sessions.length >= 1,
      'why found no sessions for the edited file — the assertion below would be vacuous');
    assert.ok(!leaks(why), 'the why payload carries the planted secret');
    assert.ok(why.sessions.some(s => (s.ask || '').includes(LOCAL_MARK) || (s.summary || '').includes(LOCAL_MARK)),
      'no why row kept its surrounding text');
  });

  // The unclipped twins are the sibling-field trap: `ask` is clipped for the
  // wire while `askFull` is the machine-local full text, and an agent asking
  // through MCP gets the full one. If redaction had been wired to the clipped
  // field only, the tool would return more secret than the wire ever could.
  await check('the unclipped askFull/summaryFull twins come back clean and POPULATED', () => {
    assert.ok(localRow.askFull.includes(LOCAL_MARK) && !localRow.askFull.includes(NEEDLE),
      'askFull is the full text an MCP caller receives; it must keep its prose and lose the secret');
    assert.ok(localRow.summaryFull && localRow.summaryFull.includes(LOCAL_MARK) && !localRow.summaryFull.includes(NEEDLE),
      'summaryFull likewise');
    assert.ok(localRow.ask.length < localRow.askFull.length,
      'the twin is not actually the unclipped one — this check would be testing ' +
      'the clipped field twice');
  });

  // KEPT AS A SOURCE READ, with the reason, because the executed check above
  // cannot isolate it. These two fields are redacted TWICE by design (once in
  // memorydb.buildEntries, again here), so deleting the feed.js half leaves the
  // output clean and the executed assertion green. Only reading the source
  // pins the defence-in-depth layer itself — and it is the layer that matters
  // the day a caller reaches normalizeLocal with an entry buildEntries did not
  // build.
  await check('feed.js still applies the redactor to askFull/summaryFull (defence in depth)', () => {
    assert.match(feedSrc, /askFull: applyRedact\(redact, e\.askFull\)/,
      'askFull must stay wired to the redactor even though buildEntries also redacts it');
    assert.match(feedSrc, /summaryFull: applyRedact\(redact, e\.summaryFull\)/,
      'summaryFull likewise');
  });

  // CONTAINMENT, EXECUTED — the same fixture, one field flipped. Proves the
  // consequence the source read at the top only describes: a machine told it
  // may no longer read a project stops answering about it. Restored afterwards
  // so nothing below inherits a revoked project.
  await check('a revoked project stops answering: teamAccessLost empties the team half', () => {
    const st = util.loadState();
    st.projects[PROJECT].teamAccessLost = new Date().toISOString();
    util.saveState(st);
    try {
      const after = activityLib.searchMemory({ query: TEAM_MARK });
      assert.ok(!after.results.some(r => r.origin === 'team'),
        'a project flagged teamAccessLost still served teammate rows through ' +
        'search_memory — the flag is read locally with no network call, so ' +
        'nothing else stops a revoked machine answering');
      const stillLocal = activityLib.searchMemory({ query: LOCAL_MARK });
      assert.ok(stillLocal.results.some(r => r.origin === 'local'),
        "revocation must not touch the user's OWN entries — they are their own work");
    } finally {
      const back = util.loadState();
      delete back.projects[PROJECT].teamAccessLost;
      util.saveState(back);
    }
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
  // or a sibling `totalIsFloor: true`, or the coverage the archive actually
  // has — the predicate below accepts any of the three.
  //
  // CONVERTED to an executed check: it now asserts on the PAYLOAD an agent
  // receives rather than on a source string. That matters here more than
  // elsewhere, because the defect is the shape of the returned object, and a
  // source read of the return expression would keep passing if the field were
  // reintroduced by any other line.
  //
  // STATUS (2026-08-05): FIXED ELSEWHERE — `agent-backend2`, commit c49c9cc
  // ("fix(mcp): name the search count for what it is, and frame results as
  // evidence"). searchMemory there returns `totalKnownHere` plus a
  // `totalIsFloor: true` sibling instead of a bare `total`, which is the first
  // of the three fixes this check's message offered.
  //
  // Verified by execution: substituting that branch's lib/activity.js (then
  // reverting) runs this suite 18/18 — this check goes green under the real
  // fix, and the predicate below accepts it without modification. Left exactly
  // as written; it goes green on merge and that transition is the proof.
  await check('the search result does not present a local floor as a total', () => {
    const keys = Object.keys(localHit);
    const hasBare = keys.includes('total');
    const qualified = keys.some(k => k !== 'total' && /floor|coverage|knownhere/i.test(k));
    assert.ok(!hasBare || qualified,
      'search_memory returns a bare `total` counting only locally-held rows ' +
      '(ranked + backfilled). Team history not yet pulled or backfilled is not ' +
      'in it, so it is a FLOOR presented as a total. Rename it or ship a ' +
      `companion flag saying so — an agent will state this number as fact. Payload keys: ${JSON.stringify(keys)}`);
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
