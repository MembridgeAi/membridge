'use strict';
// Nothing in the test suite talks to a real host unless it says so out loud.
//
// REQUIRE THIS FIRST, before any ../lib module, from every suite prelude.
//
// WHY. Four outbound lanes ship with a BAKED production default, and a test
// process inherits all four unless something takes them away:
//
//   1. team sync      lib/teamsync.js backend()  -> lib/backend.json url/anonKey
//                     (the live Supabase project holding customer data)
//   2. counters       lib/counters.js            -> lib/counters-backend.json
//   3. diagnostics    lib/diagnostics.js         -> backend.json url +
//                     /functions/v1/diagnostics  (the RICH payload, not four
//                     anonymous counters -- its own comment says so)
//   4. update check   lib/update-check.js        -> api.github.com (no env
//                     override exists at all)
//
// `isConfigured()` is therefore TRUE by default in tests: `backend()` reads
// `process.env.MEMBRIDGE_TEAM_URL || team.url || BAKED.url`, and the preludes
// never set the env var. Every daemon the suite booted was pointed at the
// production backend, saved from writing to it only by getAccessToken() bailing
// on absent credentials -- one credential fixture away from a test suite
// writing to the live database. 39 `finally` blocks in this suite `delete
// process.env.MEMBRIDGE_TEAM_URL`, and every one of them restored that
// production default rather than clearing it, because an EMPTY env var falls
// through the `||` chain to BAKED just like an absent one does.
//
// Lane 2 was patched once by convention (`cfg.countersUrl = ''` in
// run-tests.js's setupFixtures) and test/harness.js never got the same line, so
// all 26 split suites kept it. Convention does not survive a second suite.
//
// HOW. Two layers, because the two halves have different reach:
//
//   ENV, for CHILD processes (daemons, CLI verbs) -- they inherit it, and it is
//   the only lever that crosses a process boundary. Points every lane with an
//   env override at loopback, and sets the documented diagnostics kill switch.
//
//   A FETCH GUARD, for THIS process -- covers the lanes with NO env override
//   (counters, update check, diagnostics-if-re-enabled) and, more importantly,
//   any baked default added in the future, which is the whole reason it is a
//   guard and not four more assignments. Non-loopback egress THROWS and names
//   the opt-in. To reach a real host a suite must call allowEgress() -- opting
//   IN, rather than remembering to opt out.
const net = require('net');

// Port 1 is privileged and never listening, so a child that ignores the guard
// gets an instant ECONNREFUSED instead of a real request. Same stand-in
// run-tests.js already uses for the counters endpoint.
const DEAD_SINK = 'http://127.0.0.1:1';
let sink = DEAD_SINK;

const LOOPBACK = /^(127(\.\d+){3}|localhost|\[?::1\]?|0\.0\.0\.0)$/i;
const allowed = [];
const attempts = [];

function isLoopback(hostname) {
  return LOOPBACK.test(hostname || '');
}

function hostOf(input) {
  const raw = typeof input === 'string' ? input
    : (input && typeof input.url === 'string') ? input.url
      : String(input && input.href ? input.href : input);
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

// Point the inherited default at a real recorder. Used by
// test/suites/backend-egress.test.js to prove a CHILD picks the default up;
// everything else leaves it at the dead sink.
function setSink(origin) {
  sink = origin;
  applyEnv();
  return sink;
}

function applyEnv() {
  // Non-empty on purpose: `env || team.url || BAKED.url` falls through on an
  // empty string, so "" would silently mean production. This is the exact trap
  // the 39 delete-in-finally sites fell into.
  process.env.MEMBRIDGE_TEAM_URL = sink;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'test-anon-key-not-a-real-backend';
  // lib/diagnostics.js has no URL env override; this is its documented switch.
  process.env.MEMBRIDGE_NO_DIAGNOSTICS = '1';
  // lib/update-check.js gained MEMBRIDGE_UPDATE_LATEST_URL as part of #74. Its
  // semantics are DELIBERATELY unlike the team lane's: an empty string here
  // means "disabled", not "fall through to the baked default". That is what
  // makes this line safe to leave assigned in every child a suite spawns —
  // whereas MEMBRIDGE_TEAM_URL='' would restore production. Empty by default;
  // a check that must actually hit an endpoint sets it (loopback only).
  process.env.MEMBRIDGE_UPDATE_LATEST_URL = '';
  // MEMBRIDGE_TEAM_WEB_URL is deliberately NOT pinned: webUrl() only builds
  // invite links shown to a human, nothing ever fetches it, and two checks
  // legitimately assert the baked join.membridge.me default resolves. Pinning
  // it would buy no safety and break them.
}

// Restore the inherited default. Call this instead of
// `delete process.env.MEMBRIDGE_TEAM_URL` -- deleting it means production.
function resetTeamEnv() {
  applyEnv();
}

// Explicit, per-host opt-in. Nothing in the suite needs this today; it exists
// so a future test that genuinely must reach a host has a way to say so that
// is visible in its own source.
function allowEgress(hostname) {
  allowed.push(hostname);
}

// Every non-loopback attempt, whether it was allowed or blocked. A check can
// assert this is empty, which is the only way to prove a negative here.
function egressAttempts() {
  return attempts.slice();
}

function install() {
  applyEnv();
  const realFetch = globalThis.fetch;
  if (typeof realFetch !== 'function' || realFetch.__noEgress) return;
  const guarded = function fetch(input, init) {
    const host = hostOf(input);
    if (host && !isLoopback(host)) {
      const ok = allowed.includes(host);
      attempts.push({ host, allowed: ok, at: new Date().toISOString() });
      if (!ok) {
        return Promise.reject(new Error(
          `blocked outbound request to ${host}: the test suite does not talk to real hosts. `
          + 'If this is deliberate, call require("../no-egress").allowEgress("' + host + '") '
          + 'in the suite that needs it. (test/no-egress.js explains the four baked defaults.)'
        ));
      }
    }
    return realFetch(input, init);
  };
  guarded.__noEgress = true;
  globalThis.fetch = guarded;
}

module.exports = {
  DEAD_SINK,
  sinkOrigin: () => sink,
  setSink,
  resetTeamEnv,
  allowEgress,
  egressAttempts,
  isLoopback,
  install,
  // Exposed so a check can prove the baked defaults it is protecting against
  // are real and non-empty -- a guard tested against an empty baked value
  // would be the same vacuous check this repo just spent a night removing.
  bakedTeamUrl: () => {
    try { return require('../lib/backend.json').url || ''; } catch { return ''; }
  },
  freePort: () => new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  }),
};
