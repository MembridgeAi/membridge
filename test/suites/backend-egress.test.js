'use strict';
// The suite must not be able to talk to the PRODUCTION backend. Run via
// `node test/run.js backend-egress`, or directly.
//
// WHY THIS EXISTS. `lib/teamsync.js backend()` resolves
// `process.env.MEMBRIDGE_TEAM_URL || config.team.url || BAKED.url`, and BAKED
// comes from lib/backend.json — the live Supabase project holding customer
// data. No prelude set that env var, so `isConfigured()` was TRUE by default and
// every daemon the suite booted pointed at production. The only thing that kept
// it from writing there was getAccessToken() returning null on absent
// credentials: one credential fixture away from a test suite writing to the live
// database. Three more lanes ship the same way (counters, diagnostics, the
// update check), and 39 `finally` blocks used to `delete` the team env var,
// restoring the production default rather than clearing it — an empty env var
// falls through the `||` chain exactly like an absent one.
//
// WHAT IS PINNED HERE. Not "the fix is installed" — the fix DOING something:
// the guard is proven to have teeth before it is trusted, the credential case
// that was one fixture away is actually created, and a real daemon boots with
// those credentials and is shown to reach a loopback recorder. A guard asserted
// only against an already-safe world is the vacuous check this repo spent a
// night removing.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env + installs the egress guard
const { check, ROOT } = h;
const noEgress = h.noEgress;
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');

// Resolve the backend in a CHILD process, from the env it inherits and nothing
// else. This is the question that matters for daemons and CLI verbs, and it
// cannot be answered from inside this process.
function resolveInChild(extraEnv = {}) {
  const script = 'const t=require("' + path.join(__dirname, '..', '..', 'lib', 'teamsync.js').replace(/\\/g, '\\\\') + '");'
    + 'const u=require("' + path.join(__dirname, '..', '..', 'lib', 'util.js').replace(/\\/g, '\\\\') + '");'
    + 'const b=t.backend(u.getConfig());'
    + 'process.stdout.write(JSON.stringify({ url: b && b.url, configured: t.isConfigured(u.getConfig()) }));';
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', env: { ...process.env, ...extraEnv },
  });
  assert.strictEqual(r.status, 0, `child failed to resolve the backend: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

async function main() {
  const baked = noEgress.bakedTeamUrl();

  // ---- the thing being protected against is real ----

  check('egress: lib/backend.json really does bake a live production URL', () => {
    // If this were empty the rest of this suite would be theatre.
    assert.ok(/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(baked),
      `backend.json must bake a real production Supabase URL for this suite to mean anything, got ${JSON.stringify(baked)}`);
  });

  // ---- the guard has teeth ----

  await check('egress: a non-loopback request from the suite is BLOCKED, not merely discouraged', async () => {
    // The probe host is .invalid (RFC 2606: guaranteed never resolvable) rather
    // than the production backend ON PURPOSE. A check that proves the guard by
    // firing a request at the live backend is only safe while the guard works,
    // which is the thing in question — and RED-proving it would then have to
    // send that request for real. This way the failure mode of a broken guard
    // is a DNS error, not a production request, and the distinction between
    // "blocked" and "merely failed" is still visible in the message.
    let err = null;
    await fetch('https://blocked-by-membridge-tests.invalid/rest/v1/memory_entries').catch(e => { err = e; });
    assert.ok(err, 'a non-loopback request was NOT blocked');
    assert.match(err.message, /blocked outbound request/,
      `the request failed, but not because the guard stopped it — a broken guard looks exactly like this: ${err.message}`);
    assert.ok(noEgress.egressAttempts().some(a => a.host.endsWith('.invalid') && !a.allowed),
      'the blocked attempt was not recorded, so a check could never prove a negative');
    // And the production host falls in the same blocked class — asserted on the
    // classifier, never by sending anything there.
    assert.strictEqual(noEgress.isLoopback(new URL(baked).hostname), false,
      'the baked production host must classify as non-loopback, i.e. blocked');
  });

  await check('egress: loopback still works, so the guard is not just breaking everything', async () => {
    const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
    const port = await noEgress.freePort();
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(res.status, 200);
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  // ---- the default a child inherits is loopback, never production ----

  check('egress: a child process resolves the backend to loopback, not the baked production host', () => {
    const r = resolveInChild();
    assert.ok(noEgress.isLoopback(new URL(r.url).hostname),
      `a child inherited a non-loopback backend: ${r.url}`);
    assert.notStrictEqual(r.url, baked, 'a child resolved the production backend');
  });

  check('egress: `delete process.env.MEMBRIDGE_TEAM_URL` is what restored production, and resetTeamEnv undoes it', () => {
    // Pins the trap itself, so the reason those 39 finally blocks were changed
    // cannot be lost. The delete happens in a CHILD, so this process stays safe.
    const deleted = resolveInChild({ MEMBRIDGE_TEAM_URL: '' }); // '' falls through the || chain
    assert.strictEqual(deleted.url, baked,
      'an empty MEMBRIDGE_TEAM_URL no longer falls through to the baked default — if this changed in lib/, simplify test/no-egress.js');
    assert.strictEqual(deleted.configured, true,
      'isConfigured() is true with no credentials, which is why absent credentials were the only thing protecting production');

    const before = process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_URL;
    noEgress.resetTeamEnv();
    assert.strictEqual(process.env.MEMBRIDGE_TEAM_URL, before, 'resetTeamEnv must restore the loopback default');
    assert.ok(noEgress.isLoopback(new URL(teamsync.backend(util.getConfig()).url).hostname));
  });

  // ---- the credential case: one fixture away, now actually created ----

  await check('egress: a REAL daemon, with credentials present, reaches the loopback recorder and never production', async () => {
    // A recorder standing in for the backend. Nothing here is a mock of
    // teamsync's protocol -- it only needs to observe that a request arrived.
    const seen = [];
    const recorder = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"message":"recorder"}');
    });
    const port = await noEgress.freePort();
    await new Promise(r => recorder.listen(port, '127.0.0.1', r));
    // Repoint the INHERITED default at the recorder: the daemon below is given
    // no team URL of its own, so whatever it talks to, it got from the prelude.
    const savedSink = noEgress.sinkOrigin();
    noEgress.setSink(`http://127.0.0.1:${port}`);

    const home = path.join(ROOT, 'egress-daemon-home');
    fs.mkdirSync(home, { recursive: true });
    // encrypt:false is the documented hatch, used here for the same reason the
    // other team suites use it: it keeps this daemon off the REAL macOS
    // keychain. Without it the pass fail-closes on "no identity" before it ever
    // reaches the backend, which would make this check silent for the wrong
    // reason (observed exactly that on the first run).
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      intervalSec: 3600, team: { encrypt: false }, countersUrl: '',
    }, null, 2));
    // A LINKED project, because syncTeams' per-project pass skips anything
    // without a team link — with none, the daemon reaches no backend at all and
    // the recorder stays silent whether the redirect works or not.
    const linked = path.join(home, 'linked-project');
    fs.mkdirSync(path.join(linked, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(linked, '.membridge', 'team.json'),
      JSON.stringify({ teamId: 'egress-team', projectId: 'egress-project', teamName: 'EgressCo' }));
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
      version: util.STATE_VERSION, files: {}, projects: { [linked]: { events: [] } },
      catchup: { ...util.DEFAULT_CATCHUP }, feedback: { ...util.DEFAULT_FEEDBACK },
    }, null, 2));
    // THE FIXTURE THAT WAS MISSING. getAccessToken() returns creds without any
    // network call when expiresAt is comfortably in the future, so syncTeams
    // runs its real REST pass. This is the exact state that turns "pointed at
    // production" into "writing to production".
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({
      accessToken: 'test-access-token', refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3600_000, displayName: 'Egress Test',
    }, null, 2), { mode: 0o600 });

    const daemonPort = await noEgress.freePort();
    const child = spawn(process.execPath, [h.BIN, 'daemon'], {
      env: {
        ...process.env,
        MEMBRIDGE_HOME: home,
        MEMBRIDGE_PORT: String(daemonPort),
        MEMBRIDGE_INTERVAL: '3600',
      },
      stdio: 'ignore',
    });
    try {
      // Wait on the daemon's own behaviour, not a wall clock: the arrival of a
      // request IS the thing being asserted, and if the process dies there is
      // nothing left to wait for.
      const deadline = Date.now() + 30000;
      let alive = true;
      child.on('exit', () => { alive = false; });
      while (!seen.length && alive && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      assert.ok(seen.length,
        `the daemon made no backend request at all in ${Math.round((Date.now() - deadline + 30000) / 1000)}s, `
        + 'so this check cannot tell a redirected daemon from a silent one '
        + `(alive: ${alive}, log: ${(() => { try { return fs.readFileSync(path.join(home, 'membridge.log'), 'utf8').split('\n').slice(-6).join(' | '); } catch { return '(none)'; } })()})`);
      // The positive half: it talked to the recorder, which it could only have
      // learned from the inherited default. Had that default been absent it
      // would have resolved BAKED and this recorder would be silent.
      assert.ok(seen.some(s => /^(GET|POST|PATCH)\s/.test(s)), `unexpected recorder traffic: ${JSON.stringify(seen)}`);
      // The negative half, for this process: nothing left for a real host.
      assert.deepStrictEqual(
        noEgress.egressAttempts().filter(a => a.allowed).map(a => a.host), [],
        'something in this suite reached a real host');
    } finally {
      child.kill();
      noEgress.setSink(savedSink);
      await new Promise(r => recorder.close(r));
    }
  });

  // ---- the other three lanes ----

  check('egress: the diagnostics lane is off by default, and it is off by its own documented switch', () => {
    const diagnostics = require('../../lib/diagnostics');
    // The endpoint is DERIVED from backend.json and has no env override at all,
    // which is why the kill switch is the lever the prelude has to use.
    assert.ok(diagnostics.diagnosticsUrl({}).startsWith(baked),
      `diagnosticsUrl must still derive from the baked backend, got ${diagnostics.diagnosticsUrl({})}`);
    assert.strictEqual(process.env.MEMBRIDGE_NO_DIAGNOSTICS, '1',
      'the prelude must set the diagnostics kill switch: every child running syncOnce would otherwise POST the rich payload at production');
    assert.strictEqual(diagnostics.diagnosticsEnabled(util.getConfig()), false);
  });

  check('egress: counters still has no env lever, so the guard is the only thing covering it', () => {
    const counters = require('../../lib/counters');
    // Recorded as a finding, not fixed here: countersUrl resolves a real host
    // with no MEMBRIDGE_* env override to redirect a child at (only config
    // countersUrl:''). In-process it is covered by the fetch guard; in a
    // CHILD, only test setupFixtures' countersUrl:'' covers it.
    assert.ok(/^https:\/\//.test(counters.countersUrl({})),
      'counters still resolves a real host from its baked default');
  });

  // The update-check lane, #74. It shipped for a while with no env lever at
  // all, so a child process could not be pointed away from api.github.com and
  // there was no way to prove one had been. This is the whole opt-out surface,
  // asserted end to end.
  const updateCheck = require('../../lib/update-check');

  check('update-check: the baked default is still api.github.com, so the switch below is protecting something real', () => {
    assert.strictEqual(updateCheck.DEFAULT_LATEST_URL,
      `https://api.github.com/repos/${updateCheck.REPO}/releases/latest`,
      'if this changed, the semantics below are protecting the wrong URL');
  });

  check('update-check: an EMPTY env var means DISABLED, not "fall through to the baked default"', () => {
    // The trap that made MEMBRIDGE_TEAM_URL='' silently mean production. This
    // lane must NOT reproduce it.
    const saved = process.env.MEMBRIDGE_UPDATE_LATEST_URL;
    try {
      process.env.MEMBRIDGE_UPDATE_LATEST_URL = '';
      assert.strictEqual(updateCheck.latestUrl(), null, 'empty must resolve to null (disabled), not the baked default');
      process.env.MEMBRIDGE_UPDATE_LATEST_URL = '   ';
      assert.strictEqual(updateCheck.latestUrl(), null, 'whitespace-only is the same explicit opt-out (matches counters/diagnostics)');
      delete process.env.MEMBRIDGE_UPDATE_LATEST_URL;
      assert.strictEqual(updateCheck.latestUrl(), updateCheck.DEFAULT_LATEST_URL,
        'unset must fall back to the baked default -- shipped behaviour must not change');
    } finally {
      if (saved === undefined) delete process.env.MEMBRIDGE_UPDATE_LATEST_URL;
      else process.env.MEMBRIDGE_UPDATE_LATEST_URL = saved;
    }
  });

  await check('update-check: disabled at the leaf — fetchLatest returns null without touching fetchImpl', async () => {
    const saved = process.env.MEMBRIDGE_UPDATE_LATEST_URL;
    process.env.MEMBRIDGE_UPDATE_LATEST_URL = '';
    let called = false;
    try {
      const latest = await updateCheck.fetchLatest({ fetchImpl: () => { called = true; throw new Error('should not fetch'); } });
      assert.strictEqual(latest, null, 'a disabled check must resolve to null, not the caller\'s idea of the latest');
      assert.strictEqual(called, false, 'a disabled check must not invoke the fetch at all');
    } finally {
      if (saved === undefined) delete process.env.MEMBRIDGE_UPDATE_LATEST_URL;
      else process.env.MEMBRIDGE_UPDATE_LATEST_URL = saved;
    }
  });

  await check('update-check: with an override, a child\'s update-check request lands on the loopback recorder — never GitHub', async () => {
    // The child has to actually perform an update check, not merely resolve a
    // URL — the coordinator asked for the same shape #67 established for the
    // team lane. A recorder stands in for GitHub, and the child is spawned
    // from a fresh MEMBRIDGE_HOME so its update-check.json cache is empty and
    // check() genuinely goes to the network.
    const seen = [];
    const recorder = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ua=${req.headers['user-agent'] || ''}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tag_name: 'v9.9.9' }));
    });
    const port = await noEgress.freePort();
    await new Promise(r => recorder.listen(port, '127.0.0.1', r));

    const home = fs.mkdtempSync(path.join(ROOT, 'update-check-home-'));
    const script = 'const u = require("' + path.join(__dirname, '..', '..', 'lib', 'update-check.js').replace(/\\/g, '\\\\') + '");'
      + 'u.check({ force: true }).then(r => process.stdout.write(JSON.stringify(r)));';
    // spawn (async), NOT spawnSync: the recorder is served on THIS event loop,
    // and spawnSync would block it — the child would then fetch, wait for
    // AbortSignal(4s) to fire because no one is answering, and fetchLatest
    // would catch the abort and return null. Recorder stays silent, this
    // check fails. Cost 20 minutes to learn the first time; leaving the note.
    const r = await new Promise(resolve => {
      const c = spawn(process.execPath, ['-e', script], {
        env: {
          ...process.env,
          MEMBRIDGE_HOME: home,
          MEMBRIDGE_UPDATE_LATEST_URL: `http://127.0.0.1:${port}/whatever`,
        },
      });
      let stdout = ''; let stderr = '';
      c.stdout.on('data', d => { stdout += d; });
      c.stderr.on('data', d => { stderr += d; });
      c.on('close', status => resolve({ status, stdout, stderr }));
    });
    try {
      assert.strictEqual(r.status, 0, `child failed: ${r.stderr}`);
      // Positive half: it reached the recorder. The child could only have
      // learned that URL from the env — a broken resolver would either 404 at
      // the real GitHub or explode. This proves the redirect works at the leaf.
      assert.strictEqual(seen.length, 1, `expected exactly one request to the recorder, got ${JSON.stringify(seen)}`);
      assert.match(seen[0], /^GET \/whatever/, `unexpected path or method: ${seen[0]}`);
      // What check() returns must reflect the recorder's answer end-to-end.
      const parsed = JSON.parse(r.stdout);
      assert.strictEqual(parsed.latest, '9.9.9', `check() did not carry the recorder's tag through: ${r.stdout}`);
      // Negative half: no attempt to any real host, not from this process
      // either. This process never fetches — but a mistaken require of the
      // module could — so it is still worth asserting.
      assert.deepStrictEqual(
        noEgress.egressAttempts().filter(a => a.allowed).map(a => a.host), [],
        'something in this suite reached a real host');
    } finally {
      await new Promise(r => recorder.close(r));
    }
  });

  h.finish();
}

main();
