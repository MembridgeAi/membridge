'use strict';
// --- carrier-phrase detection ---
//
// Alpha readiness Task 5C. Match the sentence that INTRODUCES a secret
// rather than the secret itself, and redact only the captured value so the
// surrounding text stays readable. The typical pattern in captured prompts:
//
//   "the staging password is hunter2corgi"
//    -> "the staging password is [redacted:phrase]"
//
// Emits [redacted:phrase]. Lands in DEFAULT_PATTERNS so config.redactDefaults:
// false turns it off along with everything else — no separate flag.
//
// The false-positive discipline is enforced by the negative checks below:
// "the password field is empty", "auth: true", "password is required"
// must survive intact, or ordinary prose gets destroyed.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env
const { check } = h;
const assert = require('assert');
const digest = require('../../lib/digest');

const compile = () => digest.compileRedactions({});
const scrub = (text) => digest.redactText(text, compile());

// -----------------------------------------------------------------------
// Positive: value captured, sentence preserved, marker emitted
// -----------------------------------------------------------------------
check('"the staging password is <secret>" redacts the value, keeps the sentence', () => {
  const out = scrub('the staging password is hunter2corgi');
  assert.ok(!/hunter2corgi/.test(out), `secret survived: ${out}`);
  assert.ok(/\[redacted:phrase\]/.test(out), `no marker: ${out}`);
  assert.ok(/the staging password is/.test(out), `sentence destroyed: ${out}`);
});

check('"password:" with quoted value keeps the quotes (routed to secret-assignment)', () => {
  // NOTE: `password: "value"` matches secret-assignment first (tight
  // key/separator/quoted-value shape) rather than carrier-phrase. Task 5C
  // pinned the "keep the quotes" convention, so secret-assignment now
  // preserves the wrapping quotes too. Either marker inside preserved
  // quotes is acceptable — what matters is the value is gone AND the
  // quotes remain.
  const out = scrub('password: "hunter2corgi"');
  assert.ok(!/hunter2corgi/.test(out), `secret survived: ${out}`);
  assert.ok(/\[redacted:(?:phrase|secret-assignment)\]/.test(out), `no marker: ${out}`);
  assert.ok(/"\[redacted:[^\]]+\]"/.test(out), `quotes not preserved: ${out}`);
});

check('quoted carrier form via a prose separator uses [redacted:phrase]', () => {
  // The prose separator "is" is out of secret-assignment's [=:] scope, so
  // carrier-phrase gets the quoted-value case for `is`, `are`, `was`, `->`.
  const out = scrub('the password is "hunter2corgi"');
  assert.ok(!/hunter2corgi/.test(out), `secret survived: ${out}`);
  assert.ok(/\[redacted:phrase\]/.test(out), `wrong marker: ${out}`);
  assert.ok(/"\[redacted:phrase\]"/.test(out), `quotes not preserved: ${out}`);
});

check('carrier "secret =" catches spaced assignment on a bare carrier word', () => {
  // Note: `SECRET_KEY = value` is NOT covered here — the spec's carrier
  // list is bare words (secret, token, api key, ...), and prefixed compounds
  // (SECRET_KEY, STRIPE_KEY, DB_PASSWORD) are the secret-assignment
  // pattern's job. That pattern has a known gap on `<PREFIX>_KEY` shapes
  // (its inner alternation covers api_key / access_key / client_secret
  // but not bare _key); filing that as a follow-up rather than widening
  // this ticket's diff into another pattern.
  const out = scrub('secret = abcd1234efghijkl');
  assert.ok(!/abcd1234efghijkl/.test(out), `secret survived: ${out}`);
});

check('carrier "api key ->" catches arrow form', () => {
  const out = scrub('api key -> zzz9999zzzabc');
  assert.ok(!/zzz9999zzzabc/.test(out), `secret survived: ${out}`);
});

check('carrier "credential is" recognized', () => {
  const out = scrub('the credential is myuser-mypass-1234');
  assert.ok(!/myuser-mypass-1234/.test(out), `secret survived: ${out}`);
});

check('carrier "passphrase =" recognized', () => {
  const out = scrub('passphrase = correcthorse');
  assert.ok(!/correcthorse/.test(out), `secret survived: ${out}`);
});

check('carrier "creds are" recognized', () => {
  const out = scrub('the creds are ac-9999-bb-88');
  assert.ok(!/ac-9999-bb-88/.test(out), `secret survived: ${out}`);
});

// -----------------------------------------------------------------------
// Negative: prose about secrets that says nothing sensitive
// -----------------------------------------------------------------------
check('"the password field is empty" survives intact', () => {
  const out = scrub('the password field is empty');
  assert.strictEqual(out, 'the password field is empty',
    'ordinary prose about an EMPTY password was redacted');
});

check('"the token is set" survives intact', () => {
  const out = scrub('the token is set');
  assert.strictEqual(out, 'the token is set');
});

check('"the secret is required" survives intact', () => {
  const out = scrub('the secret is required');
  assert.strictEqual(out, 'the secret is required');
});

check('"password is missing" survives intact', () => {
  const out = scrub('the password is missing');
  assert.strictEqual(out, 'the password is missing');
});

check('"the auth is null" survives intact', () => {
  const out = scrub('the auth is null');
  assert.strictEqual(out, 'the auth is null');
});

check('captures under the length floor are skipped (too short for a real secret)', () => {
  // The floor is 6 (tightened after the corpus audit — kills 4-char English
  // verbs like "kept" that turned into false positives). Anything shorter
  // is either a placeholder, a stub, or a UI status word.
  assert.strictEqual(scrub('the password is x'), 'the password is x',
    'a single-character "value" was treated as a secret');
  assert.strictEqual(scrub('the token is abcd'), 'the token is abcd',
    'a 4-character value was treated as a secret');
  assert.strictEqual(scrub('the secret is abcde'), 'the secret is abcde',
    'a 5-character value was treated as a secret');
});

check('carrier does not fire on ordinary prose adverbs/verbs after "is"', () => {
  // The FP audit found three real hits on Marco's corpus, all of this
  // shape: "the token is obviously fake", "auth is kept separate". The
  // skip-list plus length floor kills every one.
  assert.strictEqual(scrub('the token is obviously fake'),
    'the token is obviously fake', '"obviously" was redacted (FP)');
  assert.strictEqual(scrub('the auth is kept separate'),
    'the auth is kept separate', '"kept" was redacted (FP)');
  assert.strictEqual(scrub('the auth is kept entirely separate'),
    'the auth is kept entirely separate', '"kept" was redacted (FP)');
  assert.strictEqual(scrub('the password is stored elsewhere'),
    'the password is stored elsewhere', '"stored" was redacted (FP)');
});

// -----------------------------------------------------------------------
// Interaction with existing patterns
// -----------------------------------------------------------------------
check('the existing secret-assignment marker is NOT re-wrapped', () => {
  // The generic key=value pattern already fires; the carrier pattern must
  // not re-redact "[redacted:secret-assignment]" into "[redacted:phrase]".
  const out = scrub('PASSWORD=hunter2corgi more prose');
  // Either marker is fine, but nested [redacted:phrase[redacted:...]] is not.
  assert.ok(!/\[redacted:[^\]]*\[redacted:/.test(out),
    `nested redaction marker (double-wrapped): ${out}`);
});

check('carrier does not fire when the pattern is a HEADER (no capture)', () => {
  // Prose that mentions "password" as a topic, not an assignment.
  const out = scrub('The Password Section covers rotation and expiry');
  assert.ok(!/\[redacted:phrase\]/.test(out),
    `carrier fired on a heading with no value: ${out}`);
});

check('config.redactDefaults=false turns the carrier off along with everything else', () => {
  const compiled = digest.compileRedactions({ redactDefaults: false });
  const out = digest.redactText('the staging password is hunter2corgi', compiled);
  assert.ok(/hunter2corgi/.test(out),
    'defaults-off must include this pattern — the spec pinned it as the escape hatch');
});

h.finish();
