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
// HOW THE FIXTURE IS BUILT, AND HOW YOU CAN TELL IT IS SYNTHETIC. Every secret
// below is generated here, at test time, by the seeded PRNG in `gen()` — a
// plain LCG with a literal seed, visible in this file. No value was copied from
// a real credential, a real config, or a real transcript, and none has ever been
// valid anywhere. The PEM marker is a real *format* wrapped around generated
// bytes, chosen because the `private-key` default pattern matches it
// unambiguously: that isolates "did this field pass through redaction" from
// "does some pattern happen to match this shape", which is the whole point.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const digest = require('../../lib/digest');
const teamsync = require('../../lib/teamsync');

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

  // THE PROPERTY THAT WOULD BE CATASTROPHIC TO LOSE, pinned because nothing else
  // states it: encryptRow runs on entryToRow's OUTPUT, so the ciphertext carries
  // the redacted text. If the order were ever swapped — encrypt the local entry,
  // then scrub the plaintext columns — every field would be redacted in the
  // clear and intact inside the ciphertext, which every teammate decrypts. That
  // failure would be invisible in the database and total on the receiving end.
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
