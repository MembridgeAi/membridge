'use strict';
// The wire builder protects by DEFAULT. A field is safe because it exists,
// not because someone remembered it.
//
// WHAT THIS IS ABOUT. entryToRow used to protect each field by wrapping it in
// scrub(), one at a time, and two content-bearing fields never got wrapped:
// `files`, where the `wire` translation is path rewriting for cross-machine
// identity and not redaction at all, and `changes[].file`, sitting directly
// beside a `changes[].note` that IS scrubbed. That is a habit, and a habit
// gets forgotten. The two fields are the evidence; the builder is the defect.
//
// A separate lane owns the executed proof that those two fields shipped a
// secret (test/suites/wire-redaction.test.js on agent-hunt, pinned failing on
// purpose). This suite is the other half: not "are these two fields fixed" but
// "is a field nobody enumerated protected anyway, and does opting out cost
// something".
//
// THE CARRIER IS THE ORDINARY CASE, deliberately: a filename that contains a
// token — `secrets/<token>.pem`. Not a PEM body pasted into a path, which
// invites "nobody does that". Anyone who has had a credential land in a
// filename has shipped it through this path.
//
// AND THE ASSERTIONS GO THROUGH THE CIPHERTEXT, because that is where the leak
// actually lands. plaintextOff is the shipped default and it NULLS the
// plaintext `files` column, so the database reads clean — which is exactly
// what makes this look contained when you go looking there. encryptRow seals
// the raw value into the ciphertext every teammate decrypts. Hidden from the
// operator, delivered intact to the people redaction exists to protect
// against. Checking the plaintext row alone would measure the half that was
// never the problem.
//
// EVERY ABSENCE CHECK FIRST PROVES PRESENCE. An assertion that a secret is
// gone is satisfied just as well by a payload that never carried the field, by
// a row that failed to build, by a decrypt that returned nothing. Each check
// below therefore asserts the field ARRIVED before asserting the secret did
// not — inverted vacuity is the specific way a security test goes green while
// proving nothing.
//
// Run directly, or via `node test/run.js wire-protection-default`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const teamsync = require('../../lib/teamsync');
const teamcrypto = require('../../lib/teamcrypto');
const digest = require('../../lib/digest');

// A real GitHub token shape, in a filename. Redactable by the DEFAULT patterns
// (no user config needed), which the first check proves before anything else
// leans on it.
const TOKEN = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
const SECRET_PATH = `secrets/${TOKEN}.pem`;
const CLEAN_PATH = 'src/lib/server.js';

const CREDS = { userId: '550e8400-e29b-41d4-a716-446655440000', displayName: 'Marco' };
// A NANOID-SHAPED session id, chosen because the entropy backstop redacts it
// (measured, not assumed — see the check that proves it below). A uuid would
// have made the exemption counter-check vacuous: uuids happen to survive
// redaction today, so exempting them or not would look identical, and the
// check would pass for a build with no exemption mechanism at all. "It happens
// to survive" is not the property being pinned; "it is exempt on purpose" is.
const SESSION_ID = 'V1StGXR8_Z5jdHi6B-myT_ab12cd34ef';
const BASE = {
  ts: '2026-08-05T10:00:00.000Z',
  source: 'Claude Code',
  session: SESSION_ID,
  summary: 'ordinary work',
};
const rowWith = over => teamsync.entryToRow(
  { ...BASE, ...over }, 'project-uuid-0001', CREDS, true, []);

// Everything a teammate can actually read: the plaintext row AND the decrypted
// payload. `plaintextOff` nulls the plaintext content columns, so the sealed
// copy is the one that reaches a person.
function asTeammateSees(row) {
  const teamKey = teamcrypto.genTeamKey();
  const sealed = teamsync.encryptRow(row, teamKey, 1, { teamcrypto, plaintextOff: true });
  const opened = teamcrypto.decrypt(sealed.ciphertext, sealed.nonce, teamKey);
  return { sealed, opened, wire: JSON.stringify(sealed), decrypted: JSON.stringify(opened) };
}

async function main() {
  // Real libsodium, not a stub: the point of this suite is what a teammate can
  // actually decrypt, and a fake cipher would let a "sealed" payload be
  // inspectable in a way the real one is not.
  await teamcrypto.ready();

  // --- 0. the probe is redactable at all (guards every check below) ---
  // If the marker were not caught by the default patterns, every "the secret
  // is absent" assertion under it would pass for the wrong reason.
  check('the probe token is redactable by the default patterns', () => {
    const probe = teamsync.entryToRow({ ...BASE, summary: `key ${TOKEN} end` },
      'p', CREDS, true, []);
    assert.ok(!probe.summary.includes(TOKEN),
      'the fixture token is not caught by redaction at all — every check below would be vacuous');
    assert.match(probe.summary, /^key .* end$/,
      'redaction ate the surrounding text, so absence would prove nothing about the token');
  });

  // --- 1. files[]: the field the `wire` translation stood in front of ---
  {
    const row = rowWith({ files: [SECRET_PATH, CLEAN_PATH] });
    const seen = asTeammateSees(row);
    check('files[] carries no secret into the ciphertext a teammate decrypts', () => {
      // PRESENCE FIRST: the sealed payload must actually contain the field,
      // or "no secret" is the answer to a question nobody asked.
      assert.ok(Array.isArray(seen.opened.files) && seen.opened.files.length === 2,
        'the decrypted payload carried no files at all — the absence below would be vacuous');
      assert.strictEqual(seen.sealed.files, null,
        'precondition: plaintextOff nulls the plaintext column, which is what hides this');
      assert.ok(!seen.decrypted.includes(TOKEN),
        'the token reached the ciphertext every teammate decrypts — nulling the plaintext ' +
        'column hides it from the operator and delivers it intact to the team');
      assert.ok(!seen.wire.includes(TOKEN), 'the token also reached the plaintext row');
    });
  }

  // --- 2. changes[].file, beside a note that was always scrubbed ---
  {
    const row = rowWith({ changes: [{ file: SECRET_PATH, status: 'edited', note: 'tidied up' }] });
    const seen = asTeammateSees(row);
    check('changes[].file carries no secret, like the note beside it always did', () => {
      assert.ok(Array.isArray(seen.opened.changes) && seen.opened.changes.length === 1,
        'the decrypted payload carried no changes — the absence below would be vacuous');
      assert.ok(seen.opened.changes[0].file, 'the change arrived with no file at all');
      assert.ok(!seen.decrypted.includes(TOKEN), 'changes[].file reached the ciphertext with the token');
    });
  }

  // --- 3. a non-array files value, which skipped even the translation ---
  {
    const row = rowWith({ files: `notes ${TOKEN} more` });
    const seen = asTeammateSees(row);
    check('a non-array files value is protected rather than passed through', () => {
      assert.ok(seen.opened.files, 'the decrypted payload dropped the field — absence would be vacuous');
      assert.ok(!seen.decrypted.includes(TOKEN),
        'a non-array files value passed through the ternary untouched');
    });
  }

  // --- 4. THE ARCHITECTURAL CLAIM: a field nobody enumerated is protected ---
  // This is the check the ticket is actually about. `{ ...c }` spreads every
  // other key a change object carries; nothing in the builder names them. A
  // field added there tomorrow must be safe without anyone editing the
  // builder, or the habit has just moved rather than gone.
  {
    const row = rowWith({
      changes: [{ file: CLEAN_PATH, status: 'edited', note: 'ok', reviewerNote: `see ${TOKEN}` }],
    });
    const seen = asTeammateSees(row);
    check('a field the builder never enumerates is protected because it exists', () => {
      const change = seen.opened.changes && seen.opened.changes[0];
      assert.ok(change && 'reviewerNote' in change,
        'the un-enumerated field did not survive to the wire at all — this check needs it to');
      assert.ok(!seen.decrypted.includes(TOKEN),
        'a field nobody wrapped shipped its contents raw — protection is still a habit, ' +
        'and the next field added will inherit the same silence');
    });
  }

  // --- 5. COUNTER-CHECK: this cannot be "fixed" by scrubbing everything ---
  // The failure mode of an over-eager fix is a wire that no longer carries
  // what it is for. Ordinary paths must arrive byte-exact (they are how a
  // teammate matches a file), and the five exempt identity fields must arrive
  // byte-exact (they are the backend's on_conflict key and the session
  // thread — altering one byte splits a session or duplicates a row).
  {
    const row = rowWith({
      files: [CLEAN_PATH, 'packages/app/src/components/VeryLongComponentName.tsx'],
      changes: [{ file: CLEAN_PATH, status: 'edited', note: 'ordinary note' }],
    });
    const seen = asTeammateSees(row);
    check('ordinary paths arrive byte-exact — redaction did not eat the payload', () => {
      assert.deepStrictEqual(seen.opened.files,
        [CLEAN_PATH, 'packages/app/src/components/VeryLongComponentName.tsx'],
        'ordinary file paths were mangled, so file identity is broken for every teammate');
      assert.strictEqual(seen.opened.changes[0].file, CLEAN_PATH);
      assert.strictEqual(seen.opened.changes[0].note, 'ordinary note');
    });
    check('the exempt identity fields arrive byte-exact', () => {
      // The session id is the one that makes this bite: redaction really does
      // eat this shape, so without the exemption the field below would arrive
      // as a redaction marker and every entry in the session would thread
      // under a different key. Asserted here so the day someone deletes the
      // exemption, this fails rather than shrugging.
      assert.strictEqual(digest.redactText(SESSION_ID, []), '[redacted:high-entropy]',
        'the fixture session id is no longer redactable, so this check no longer proves ' +
        'the exemption does anything — pick an id shape the backstop still eats');
      assert.strictEqual(row.session, SESSION_ID, 'a mangled session splits one thread in two');
      assert.strictEqual(row.project_id, 'project-uuid-0001');
      assert.strictEqual(row.author_id, CREDS.userId);
      assert.strictEqual(row.ts, BASE.ts, 'a mangled ts breaks the on_conflict key');
      assert.strictEqual(row.source, BASE.source);
    });
    check('the row keeps its exact key set — PostgREST rejects a batch that disagrees', () => {
      assert.deepStrictEqual(Object.keys(row), [
        'project_id', 'author_id', 'author_name', 'ts', 'source', 'session',
        'ask', 'goal', 'decisions', 'gotchas', 'files', 'changes',
        'summary', 'headline', 'distilled',
      ], 'the walker changed the column set or its order');
    });
  }

  // --- 6. the exemption costs something to write ---
  // If opting out is as easy as forgetting, nothing has changed.
  check('an exemption without a written reason is refused', () => {
    assert.throws(() => teamsync.unredacted('value'), /written reason/,
      'a field could be exempted with no reason at all');
    assert.throws(() => teamsync.unredacted('value', 'because'), /written reason/,
      'a one-word reason satisfied the exemption');
    const ok = teamsync.protectWireRow(
      { k: teamsync.unredacted(TOKEN, 'a reason long enough to be a real sentence about why') }, []);
    assert.strictEqual(ok.k, TOKEN, 'a properly reasoned exemption did not actually exempt');
  });

  // --- 7. redact BEFORE encrypt, which is the ordering the seal depends on ---
  // Reversed, redaction scrubs ciphertext (finding nothing) and the secret
  // stays intact inside what every teammate decrypts. The check is that the
  // sealed payload — the thing built FROM the row — is already clean.
  {
    const row = rowWith({ summary: `token ${TOKEN} here`, files: [SECRET_PATH] });
    const seen = asTeammateSees(row);
    check('the row is redacted before it is sealed, never after', () => {
      assert.ok(seen.opened.summary && seen.opened.summary.length > 0,
        'the sealed payload has no summary — absence would be vacuous');
      assert.ok(!seen.decrypted.includes(TOKEN),
        'the ciphertext holds the raw secret: redaction ran after encryption, or not at all');
      assert.ok(seen.sealed.ciphertext && seen.sealed.nonce, 'nothing was actually encrypted');
    });
  }

  h.finish();
}

main();
