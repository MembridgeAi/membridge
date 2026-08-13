'use strict';
// A sign-up against an address that already has an account used to report
// SUCCESS. teamsync.signup read the response like this:
//
//     const data = await authRequest(be, 'signup', { email, password });
//     if (!data.access_token) return { needsConfirmation: true, email };
//
// With email confirmation enabled, GoTrue answers a sign-up for a registered
// address with 200, a user object, and NO session -- its deliberate
// anti-enumeration behaviour. The absent access_token was read as "account
// created, one step left", and the UI told the user to go and confirm an email
// that was never sent. This is the repo's characteristic bug: a flag recording
// a success the code never achieved.
//
// Two different signals mean the same thing, and WHICH one arrives depends on
// a Supabase project setting this repo does not control:
//   confirmation ON  -> 200, no session, user.identities === []
//   confirmation OFF -> 400/422, msg 'User already registered'
// Handling one and not the other leaves the bug live under the other setting,
// so both are pinned here.
//
// The fourth case is the regression guard: a response with NO identities field
// at all is not evidence of anything and must still mean needs-confirmation,
// which is the behaviour that shipped.
//
// Run directly, or via `node test/run.js signup-email-exists`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, P, startJsonMock } = h;
const assert = require('assert');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');

const MOCK_PORT = P(71);

// One stub auth endpoint whose /auth/v1/signup answer is swapped per case.
// A hand-rolled mock rather than test/mock-supabase.js on purpose: that mock
// models only the confirmation-OFF rejection, and teaching it a second mode
// would change behaviour under every suite that shares it.
let respond = () => [200, {}];

async function main() {
  const srv = await startJsonMock(MOCK_PORT, (req, body, send) => {
    const [code, payload] = respond(body);
    send(code, payload);
  });
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  util.ensureConfig();

  // --- confirmation ON, address already registered -------------------------
  respond = body => [200, {
    id: '00000000-0000-0000-0000-000000000001',
    email: body.email,
    // The whole signal: a real new user carries at least one identity.
    identities: [],
  }];
  let r = await teamsync.signup(util.getConfig(), 'taken@test.dev', 'pw-taken', 'Taken');
  check('obfuscated 200 with empty identities reports the address is taken', () => {
    assert.ok(r.emailExists === true && r.email === 'taken@test.dev' && !r.needsConfirmation);
  });

  // --- confirmation OFF, address already registered ------------------------
  respond = () => [400, { msg: 'User already registered' }];
  r = await teamsync.signup(util.getConfig(), 'taken2@test.dev', 'pw-taken2', 'Taken2');
  check('a 400 "User already registered" reports the address is taken', () => {
    assert.ok(r.emailExists === true && r.email === 'taken2@test.dev');
  });

  // --- genuinely awaiting confirmation -------------------------------------
  respond = body => [200, {
    id: '00000000-0000-0000-0000-000000000002',
    email: body.email,
    identities: [{ id: 'ident-1', provider: 'email' }],
  }];
  r = await teamsync.signup(util.getConfig(), 'fresh@test.dev', 'pw-fresh', 'Fresh');
  check('a new account with one identity and no session still needs confirmation', () => {
    assert.ok(r.needsConfirmation === true && !r.emailExists);
  });

  // --- REGRESSION GUARD: no identities field at all ------------------------
  // Absent is not empty. A backend that simply does not send the field must
  // not be read as "this address is taken" -- that would turn every
  // confirmation-pending sign-up into a dead end.
  respond = body => [200, { id: '00000000-0000-0000-0000-000000000003', email: body.email }];
  r = await teamsync.signup(util.getConfig(), 'nofield@test.dev', 'pw-nf', 'NoField');
  check('a response with no identities field still means needs-confirmation', () => {
    assert.ok(r.needsConfirmation === true && !r.emailExists);
  });

  // --- an unrelated failure is still an error ------------------------------
  respond = () => [500, { msg: 'upstream exploded' }];
  let threw = null;
  try {
    await teamsync.signup(util.getConfig(), 'boom@test.dev', 'pw-b', 'Boom');
  } catch (err) {
    threw = err;
  }
  check('a backend fault is not quietly reported as a taken address', () => {
    assert.ok(threw !== null && /upstream exploded/.test(threw.message));
  });

  srv.close();
  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
