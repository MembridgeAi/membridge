'use strict';
// The redaction BOUNDARY — which fields on the outbound row go through
// redaction at all.
//
// SCOPE, deliberately narrow. This suite is about `entryToRow` in
// lib/teamsync.js, the single point where a local entry becomes a row bound for
// other people's machines. It is NOT about what lib/redact.js's patterns
// recognise — that surface is owned by the redaction lane and covered by
// test/suites/redaction.test.js. The two questions are different, and the
// second is the worse one: a pattern that fails to match is a gap in a net, but
// a field that never enters the net is not protected at all, and no improvement
// to the patterns will ever reach it.
//
// STATUS: five checks FAIL, on purpose. They are a confirmed finding in product
// code, not a broken test — `files` and `changes[].file` never pass through
// redactText, and this suite is find-only. Do not "fix" them by relaxing the
// assertions; the fix is a scrub() call in lib/teamsync.js entryToRow.
//
// STILL OPEN AS OF 2026-08-05, and re-checked rather than assumed. Every other
// branch carrying fixes this evening was read directly:
//   agent-backend2 — lib/teamsync.js entryToRow still reads
//                    `files: Array.isArray(e.files) ? e.files.map(wire) : e.files`
//                    and `file: wire(c.file)`, both unchanged
//   agent-revoke   — entryToRow untouched
//   agent-sec, agent-removal — do not touch lib/teamsync.js entryToRow at all
// So this is the one finding on this branch that no other lane has closed. It
// is genuinely live, and the ciphertext check above is the reason it should not
// wait for a quiet moment.
//
// The failures are EXECUTED, not inferred: each plants a synthetic secret and
// drives the real code. Three prove it in the row object entryToRow returns.
// The other two close the two objections that survive that, because "somebody
// forgot to wrap this field" is easy to wave away and "a secret placed here
// ships" is not:
//   - encryption does NOT contain it. plaintextOff nulls the plaintext column,
//     so the database reads clean, while encryptRow seals the RAW value into
//     the ciphertext every teammate decrypts.
//   - the direct entryToRow call is not a lab artefact. Driving the real push
//     (signup, link, syncTeams) lands the secret in the backend's table, with
//     `files` built by memorydb.buildEntries and translated by wireKeyFor —
//     which also rules out path translation quietly sanitizing it.
//
// Each of those two asserts a secret is ABSENT, so each one first proves the
// payload EXISTS — a sealed payload was handed over, a row actually arrived.
// Without that, an empty result would satisfy the assertion and turn a real
// finding green, which is the one outcome worse than not testing it.
//
// HOW THE FIXTURE IS BUILT, AND HOW YOU CAN TELL IT IS SYNTHETIC. Every secret
// below is generated here, at test time, by the seeded PRNG in `gen()` — a
// plain LCG with a literal seed, visible in this file. No value was copied from
// a real credential, a real config, or a real transcript, and none has ever been
// valid anywhere. The PEM marker is a real *format* wrapped around generated
// bytes, chosen because the `private-key` default pattern matches it
// unambiguously: that isolates "did this field pass through redaction" from
// "does some pattern happen to match this shape", which is the whole point.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const digest = require('../../lib/digest');
const teamsync = require('../../lib/teamsync');
const util = require('../../lib/util');
const { createMockSupabase } = require('../mock-supabase');

const MOCK_PORT = P(62);

// Deterministic, obviously machine-generated. Same output every run.
let seed = 20260805;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gen = n => Array.from({ length: n },
  () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 62)]).join('');

// A PEM block. The format is real so the `private-key` pattern matches it
// unambiguously; the body is generated noise. NEEDLE is one line of that body,
// and it is what every assertion searches for — see the note on `leaks` below
// for why the needle must not contain a newline.
const NEEDLE = gen(48);
const SECRET = `-----BEGIN RSA PRIVATE KEY-----\n${gen(64)}\n${NEEDLE}\n-----END RSA PRIVATE KEY-----`;

// A SECOND synthetic secret, shaped for the fields the finding is about.
// A PEM in a filesystem path is a fair unit-test probe but an easy thing to
// wave away ("nobody puts a private key in a path"). This one is the realistic
// version of the same leak: a file whose NAME carries a credential —
// `secrets/<token>.pem` — which is an ordinary thing to find in a repo and is
// exactly what a path-shaped field ships.
//
// Synthetic by the same seeded LCG above: `ghp_` plus 36 generated alphanumeric
// characters. The prefix is a real FORMAT so the `github-token` default pattern
// matches it unambiguously; the body has never been a valid token anywhere.
const TOKEN = `ghp_${gen(36)}`;
const TOKEN_FILE = `secrets/${TOKEN}.pem`;

const regexes = digest.compileRedactions({});
const creds = { userId: 'user-1', displayName: 'Tester' };

// Sanity: the marker must actually be redactable on its own, or every
// assertion below would pass or fail for the wrong reason.
const selfCheck = digest.redactText(SECRET, regexes);

function rowWith(entry) {
  return teamsync.entryToRow(
    { ts: '2026-08-05T00:00:00.000Z', source: 'Claude Code', session: 's1', ...entry },
    'project-1', creds, true, regexes, null);
}

// Walk every string in the row and look for the secret. Whole-row rather than
// field-by-field on purpose: named assertions silently stop covering a field
// that gets RENAMED, and this suite exists because fields get added and renamed
// without the habit following them.
//
// It walks the object rather than serializing it, and that is not a style
// choice. The first version of this helper was
// `JSON.stringify(row).includes(NEEDLE)`, and it reported the whole row clean
// — including the two fields this suite was written to catch. JSON.stringify
// escapes the newlines inside the PEM fixture to a literal backslash-n, so the
// needle could never match and every check passed vacuously. A leak detector
// that cannot detect the leak is worse than none, so: compare raw string against
// raw string, and keep the NEEDLE newline-free so the failure mode cannot recur.
const collectStrings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => collectStrings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => collectStrings(x, out));
  return out;
};
const leaks = row => collectStrings(row).some(s => s.includes(NEEDLE));

async function main() {
  await check('the fixture marker is redactable at all (guards every assertion below)', () => {
    assert.ok(!selfCheck.includes(NEEDLE),
      'the synthetic PEM marker must be caught by the default patterns, or this ' +
      'suite proves nothing about the boundary');
  });

  // Same guard for the second fixture secret. Without it, "the token did not
  // appear" could mean the boundary is fine OR that no pattern would ever have
  // caught this token — and those are opposite conclusions.
  await check('the synthetic token is redactable at all (guards the two findings below)', () => {
    const scrubbed = digest.redactText(`ref ${TOKEN} end`, regexes);
    assert.ok(!scrubbed.includes(TOKEN),
      'the synthetic github-token marker must be caught by the default patterns, ' +
      'or the filename findings prove nothing');
    assert.match(scrubbed, /^ref .* end$/,
      'and it must remove the token WITHOUT eating the text around it');
  });

  // The fields that DO go through scrub(). These pass today and are pinned so
  // the habit cannot be dropped from any one of them unnoticed. Each is asserted
  // individually rather than in a loop so a failure names the field.
  for (const field of ['ask', 'goal', 'summary', 'headline', 'decisions', 'gotchas']) {
    await check(`${field} is redacted on the outbound row`, () => {
      assert.ok(!leaks(rowWith({ [field]: `context ${SECRET} more` })),
        `${field} reached the wire carrying the secret`);
    });
  }

  await check('changes[].note is redacted on the outbound row', () => {
    assert.ok(!leaks(rowWith({ changes: [{ file: 'a.js', status: 'edited', note: SECRET }] })),
      'changes[].note reached the wire carrying the secret');
  });

  // THE FINDING. `files` is built as `e.files.map(wire)` — wireKeyFor translates
  // the path for cross-machine identity and nothing redacts it. It is one of two
  // content-bearing fields on the row that never touch redactText, and it is the
  // demonstration that the boundary has no structural guarantee: every protected
  // field is protected because somebody remembered to wrap it in scrub(), one
  // field at a time.
  //
  // How much this matters on its own is bounded — a filesystem path is a poor
  // hiding place for a credential, and the realistic case is narrow (a path that
  // embeds a token, a URL-shaped entry, a tool that records something
  // path-like that isn't a path). It is filed for the structure rather than the
  // scenario: this is what "a field added later missed the habit" looks like
  // when it has already happened, and the same omission in a future free-text
  // field would be severe.
  await check('files[] is redacted on the outbound row', () => {
    assert.ok(!leaks(rowWith({ files: [`secrets/${SECRET}`] })),
      'files[] reached the wire unredacted — it is path-translated by wireKeyFor ' +
      'and never passed through redactText');
  });

  await check('changes[].file is redacted on the outbound row', () => {
    assert.ok(!leaks(rowWith({ changes: [{ file: `secrets/${SECRET}`, status: 'edited', note: 'x' }] })),
      'changes[].file reached the wire unredacted — same omission as files[]');
  });

  // A non-array `files` bypasses even the path translation and ships whatever it
  // holds, unredacted and unclipped: `Array.isArray(e.files) ? … : e.files`.
  // Nothing produces that shape today, so this is a latent type gap rather than
  // a live leak — but it is the branch that would carry free text if anything
  // ever did.
  await check('a non-array files value is redacted rather than passed through', () => {
    assert.ok(!leaks(rowWith({ files: `notes: ${SECRET}` })),
      'a non-array files value passes through the ternary untouched');
  });

  // -------------------------------------------------------------------------
  // THE SAME FINDING, WITH THE TWO OBJECTIONS TO IT CLOSED.
  // -------------------------------------------------------------------------
  // The three checks above prove the secret is in the ROW OBJECT entryToRow
  // returns. Two reasonable objections survive that, and both are answered
  // below by execution rather than by argument — because "the wrap is missing"
  // is easy to shrug off and "a secret placed here ships" is not.
  //
  // OBJECTION 1: "encryption contains it." It does not. plaintextOff (the
  // shipped default — plaintextOffFor returns true unless explicitly set false)
  // nulls the plaintext `files` column, which is what makes this look contained
  // when reading the database. But encryptRow seals `files` and `changes` INTO
  // the ciphertext, and every teammate decrypts that. So the effect of
  // encryption here is to hide the leak from the operator while delivering it
  // intact to exactly the people the redactor exists to protect it from.
  //
  // This is the mirror image of the ordering check further down. That one seals
  // a secret in `summary` and proves the ciphertext carries the REDACTED text.
  // This one seals a secret in `files` and finds the raw text. Same instrument,
  // same payload, opposite answer — which is the clearest possible statement of
  // what "this field never enters the net" costs.
  await check('encryption does not contain the finding: files[] rides RAW inside the ciphertext', () => {
    let sealed = null;
    const row = rowWith({ files: [TOKEN_FILE] });
    const out = teamsync.encryptRow(row, 'team-key', 1, {
      teamcrypto: {
        encrypt: payload => { sealed = payload; return { ciphertext: 'c', nonce: 'n' }; },
      },
      plaintextOff: true,
    });
    // PRECONDITIONS, and they matter more here than usual: this check asserts a
    // secret is ABSENT, so anything that quietly produced an empty payload would
    // make it pass and hide the finding. Both are asserted before the claim.
    assert.ok(sealed, 'encryptRow must hand a payload to teamcrypto.encrypt');
    assert.strictEqual(out.files, null,
      'fixture: plaintextOff must null the plaintext files column — if it did ' +
      'not, this check would be about the wrong column');
    assert.ok(collectStrings(sealed).some(s => s.includes('secrets/')),
      'fixture: the sealed payload must actually carry the files field');

    assert.ok(!collectStrings(sealed).some(s => s.includes(TOKEN)),
      'a credential embedded in a FILENAME is sealed into the ciphertext ' +
      'unredacted. plaintextOff nulls the plaintext column, so the database ' +
      'looks clean while every teammate who decrypts the row gets the raw ' +
      'token. Encryption hides this leak; it does not contain it.');
  });

  // OBJECTION 2: "entryToRow called directly is not the real path." Also no.
  // The check below drives the actual push — signup, createTeam, linkProject,
  // syncTeams — against the mock backend, with a real captured edit event whose
  // FILENAME carries the token, and reads the row that lands in the backend's
  // table. Nothing is hand-built: `files` here is whatever memorydb.buildEntries
  // derived and whatever wireKeyFor translated it into, which also closes the
  // narrower objection that path translation might sanitize the value.
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    util.ensureConfig();
    // The documented escape hatch every other team suite uses: keeps the mock
    // round trip off the real macOS keychain. It also puts the row on the wire
    // in PLAINTEXT, which is the weaker of the two shipping modes for this
    // finding — the ciphertext case is covered by the check above, so between
    // them both modes are accounted for.
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), encrypt: false };
    util.saveUserConfig(cfg);

    await teamsync.signup(util.getConfig(), 'wire@test.dev', 'pw-wire', 'Wirer');
    const team = await teamsync.createTeam(util.getConfig(), 'WireCo');

    const projectKey = path.join(ROOT, 'projects', 'wire-leak-app');
    fs.mkdirSync(projectKey, { recursive: true });
    {
      const st = util.loadState();
      st.projects = {
        ...(st.projects || {}),
        [projectKey]: {
          events: [
            { kind: 'prompt', session: 'wire-1', source: 'Claude Code', ts: '2026-08-04T10:00:00.000Z', text: 'store the deploy key' },
            // The leak carrier: an ordinary captured edit whose path happens to
            // name a credential. buildEntries turns this into files[].
            { kind: 'edit', session: 'wire-1', source: 'Claude Code', ts: '2026-08-04T10:01:00.000Z', file: path.join(projectKey, TOKEN_FILE) },
            {
              kind: 'summary', session: 'wire-1', source: 'Distilled', ts: '2026-08-04T10:05:00.000Z',
              text: 'Stored the deploy key.', headline: 'deploy key stored',
              goal: '', decisions: '', gotchas: '', highlights: [],
            },
          ],
        },
      };
      util.saveState(st);
    }
    const link = await teamsync.linkProject(util.getConfig(), projectKey, team.team_id, 'WireCo');
    const res = await teamsync.syncTeams({});
    const pushed = mock.entries.filter(e => e.project_id === link.projectId);

    await check('end to end: a credential in a filename REACHES the backend table', () => {
      // PRECONDITION FIRST, and it is load-bearing in the inverted direction.
      // This check asserts the token is ABSENT from the pushed row. If nothing
      // were ever pushed, that assertion would be trivially satisfied and the
      // finding would silently turn green. So: prove a row arrived, and prove
      // it carries the files field, before saying anything about its content.
      assert.deepStrictEqual(res.errors, [], `the push failed: ${JSON.stringify(res.errors)}`);
      assert.strictEqual(pushed.length, 1,
        `fixture: expected exactly one pushed row, got ${pushed.length} — with ` +
        'no row on the wire the leak assertion below would pass vacuously');
      assert.ok(Array.isArray(pushed[0].files) && pushed[0].files.length,
        'fixture: the pushed row carries no files field, so there is nothing to leak');

      assert.ok(!collectStrings(pushed[0]).some(s => s.includes(TOKEN)),
        'a credential embedded in a filename travelled the REAL push path — ' +
        'buildEntries to entryToRow to wireKeyFor to the backend — and landed ' +
        'in another machine\'s reach with the token intact. This is not a ' +
        'hypothetical about an unwrapped field: it is the field shipping. ' +
        `Row files: ${JSON.stringify(pushed[0].files)}`);
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  // THE PROPERTY THAT WOULD BE CATASTROPHIC TO LOSE, pinned because nothing else
  // states it: encryptRow runs on entryToRow's OUTPUT, so the ciphertext carries
  // the redacted text. If the order were ever swapped — encrypt the local entry,
  // then scrub the plaintext columns — every field would be redacted in the
  // clear and intact inside the ciphertext, which every teammate decrypts. That
  // failure would be invisible in the database and total on the receiving end.
  //
  // DELIBERATELY UNCHANGED. This is already the right instrument: it drives
  // encryptRow with an injected teamcrypto and inspects the actual sealed
  // payload, so it tests the ordering as EXECUTED rather than as written. There
  // is nothing to convert, and it was not touched for symmetry with the
  // conversions elsewhere in this branch. It is also the one check here that
  // must keep PASSING — the two findings above are about a field that never
  // enters the net, while this is about the net being applied in the right
  // order to the fields that do. Do not fold them together: a future fix that
  // wrapped files[] would turn the findings green and leave this exactly as it
  // is, which is correct.
  await check('the ciphertext carries the REDACTED text, not the raw entry', () => {
    let sealed = null;
    const row = rowWith({ summary: `before ${SECRET} after` });
    teamsync.encryptRow(row, 'team-key', 1, {
      teamcrypto: {
        encrypt: payload => { sealed = payload; return { ciphertext: 'c', nonce: 'n' }; },
      },
      plaintextOff: false,
    });
    assert.ok(sealed, 'encryptRow must hand the payload to teamcrypto.encrypt');
    assert.ok(!JSON.stringify(sealed).includes(NEEDLE),
      'the sealed payload contains the unredacted secret — redaction is being ' +
      'bypassed for the encrypted copy');
  });

  // The harsher question: would these tests fail if redaction were broken? A
  // suite that only asserts "the secret is gone" also passes against a row
  // builder that drops every field on the floor. Assert the benign text SURVIVES
  // too, so emptying a field cannot masquerade as redacting it.
  await check('redaction removes the secret without discarding the surrounding text', () => {
    const row = rowWith({ summary: `keepthisprefix ${SECRET} keepthissuffix` });
    assert.ok(!leaks(row), 'the secret must be gone');
    assert.match(row.summary, /keepthisprefix/,
      'surrounding text must survive — a builder that returned null would pass ' +
      'the leak assertion while silently destroying the summary');
    assert.match(row.summary, /keepthissuffix/,
      'text AFTER the redacted span must survive too; losing it would mean the ' +
      'pattern is eating to end-of-string');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
