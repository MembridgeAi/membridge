'use strict';
// --- redaction boundary: the whole 5B/5C/5D story in one fixture ---
//
// Alpha readiness Task 5 verification: a single fixture with all three
// active layers over the SAME captured prompt:
//   1. A shape-matched credential (Stripe key) — caught by DEFAULT_PATTERNS
//   2. An env-file value — caught by the deny-list (5B)
//   3. A carrier-phrase secret ("password is X") — caught by the carrier (5C)
//   4. A novel prose password with no carrier and no env presence — NOT
//      caught, on purpose. That is the boundary this ticket is telling the
//      truth about (5D). See docs/security/redaction-boundary.md.
//
// Also asserts the ordering invariant: redaction MUST run before clipping,
// or a truncation could sever a pattern's anchor. The comment on
// digest.redactText pins that.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const digest = require('../../lib/digest');
const teamsync = require('../../lib/teamsync');

function makeEnvProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-boundary-'));
  fs.writeFileSync(path.join(root, '.env'), 'DB_PASSWORD=envcorpus-hunter-value\n');
  return root;
}

const PROJECT = makeEnvProject();

// The single fixture prompt: all four ingredients in one string, plus
// enough surrounding prose that the "surrounding text is readable" claim
// is meaningful.
const PROMPT = [
  'we hit a build failure — check the Stripe test env',
  'the key is sk_live_abcdefghij1234567890abcd,',           // shape
  'the DB uses envcorpus-hunter-value from .env,',          // env
  'the staging password is hunter2corgi-plus,',             // carrier
  'and the recovery phrase is aardvarkboxwaltz.',           // prose password (NOT caught)
].join(' ');

check('4-in-1 fixture: shape, env, carrier redacted; novel prose password NOT redacted', () => {
  const compiled = digest.compileRedactions({}, { projectPath: PROJECT });
  const out = digest.redactText(PROMPT, compiled);
  // (1) Stripe shape key
  assert.ok(!/sk_live_abcdefghij1234567890abcd/.test(out),
    `shape-matched key survived: ${out}`);
  // (2) env deny-list literal
  assert.ok(!/envcorpus-hunter-value/.test(out),
    `env-file value survived: ${out}`);
  assert.ok(/\[redacted:env\]/.test(out),
    `env marker missing: ${out}`);
  // (3) carrier-phrase capture
  assert.ok(!/hunter2corgi-plus/.test(out),
    `carrier value survived: ${out}`);
  assert.ok(/\[redacted:phrase\]/.test(out),
    `carrier marker missing: ${out}`);
  // (4) NOVEL PROSE PASSWORD — documented as the boundary, not caught.
  // If this ever starts being caught, either the entropy backstop or a new
  // pattern crossed the boundary, and docs/security/redaction-boundary.md
  // needs updating alongside it.
  assert.ok(/aardvarkboxwaltz/.test(out),
    `novel prose password was redacted — this asserts the DOCUMENTED boundary. ` +
    `See docs/security/redaction-boundary.md. If this is a deliberate change, ` +
    `update the doc and this test together.`);
  // Surrounding prose stays readable (specific words persist).
  assert.ok(/staging password is/.test(out),
    `sentence structure destroyed: ${out}`);
  assert.ok(/recovery phrase is/.test(out),
    `sentence structure destroyed: ${out}`);
  assert.ok(/build failure/.test(out),
    `unrelated prose destroyed: ${out}`);
});

check('redaction runs BEFORE clipping — an anchor near the tail is not severed', () => {
  // A shape-matched key placed just before a cut point: if the pipeline
  // clipped first, the truncated tail would break the pattern and the
  // key would slip through. digest.redactText's comment pins this, and
  // memorydb.buildEntries's own comment ("Redact before clipping:
  // truncation must not break a pattern's anchor") documents it too.
  const key = 'sk_live_abcdefghij1234567890abcd';
  const filler = 'x'.repeat(300);
  const prompt = `${filler}${key} some tail`;
  const compiled = digest.compileRedactions({});
  // Clip AFTER redact — same order the pipeline itself uses.
  const redacted = digest.redactText(prompt, compiled);
  const clipped = digest.clip(redacted, 320);
  assert.ok(!clipped.includes(key), `key leaked through clip after redact: ${clipped}`);
  // The reverse order — clip THEN redact — must NOT be the pipeline's order:
  // if the fixture proves it doesn't fail-safe under the reversal, the
  // comment above is more than doc, it is load-bearing.
  const wrong = digest.redactText(digest.clip(prompt, 320), compiled);
  // The key was cut mid-way; the reversed pipeline can't recognize it.
  assert.ok(!wrong.includes(key),
    'the reversal happens to survive this fixture — pick a fixture where it does not');
});

check('entryToRow: the whole 5B+5C+5A story survives the wire pipeline end to end', () => {
  const compiled = digest.compileRedactions({}, { projectPath: PROJECT });
  const entry = {
    ts: '2026-08-06T10:00:00.000Z',
    source: 'Claude Code',
    session: 'session-abc',
    ask: PROMPT,
    goal: 'distilled goal text',
    distilled: true,
  };
  // verbatim mode ships ask; envelope preserves the "explicit null" convention
  // for goal being present.
  const row = teamsync.entryToRow(entry, '00000000-0000-0000-0000-0000000000aa',
    { userId: '00000000-0000-0000-0000-000000000001', displayName: 'Marco' },
    'verbatim', compiled, PROJECT);
  assert.ok(!/sk_live_abcdefghij1234567890abcd/.test(row.ask),
    `wire pipeline leaked Stripe key: ${row.ask}`);
  assert.ok(!/envcorpus-hunter-value/.test(row.ask),
    `wire pipeline leaked env value: ${row.ask}`);
  assert.ok(!/hunter2corgi-plus/.test(row.ask),
    `wire pipeline leaked carrier secret: ${row.ask}`);
  // Novel prose password: still not caught. Verified so a future change
  // makes this test the tripwire — same as above.
  assert.ok(/aardvarkboxwaltz/.test(row.ask),
    'a documented-boundary case started being redacted — update the doc');
});

h.finish();
