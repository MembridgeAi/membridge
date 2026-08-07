'use strict';
// Task 32: `POST /api/daemon/restart` must hand off to a NEW daemon.
//
// The restart endpoint (lib/server.js) spawns a replacement via
// apiMachine.spawnReplacement() (lib/api-machine.js), keeps the OLD daemon alive
// long enough to flush the HTTP response, then schedules the old one to exit
// ~200ms later. The replacement is `node bin/membridge.js daemon`, i.e. it runs
// cmdDaemon just like any other start.
//
// Alpha Task 4 added a duplicate-daemon guard to cmdDaemon: if the pid file
// names a LIVE, real-MemBridge process, the new start refuses and exits 1
// (see the daemon-pid-race suite). During a restart the replacement reaches
// that guard within milliseconds of spawn, while the old daemon is still alive
// for the ~200ms exit delay -- so the replacement mistakes the daemon it is
// meant to REPLACE for a duplicate it must refuse, and dies. The old daemon
// then exits on schedule and the user is left with NO daemon at all. The pid
// never changes because no new daemon ever takes over.
//
// This suite drives the real endpoint end to end: start a real daemon, read its
// pid off /api/status, POST the restart, and assert a DIFFERENT, live daemon is
// answering afterward. It also asserts the reverse invariant -- a genuine second
// `membridge daemon` (no restart handoff) is still refused -- so the fix cannot
// be a fail-open weakening of the guard. (The full genuine-duplicate proof lives
// in daemon-pid-race; this is a lightweight companion check.)
//
// PORT USAGE: the daemon subprocess binds its dashboard on a fresh ephemeral
// port (noEgress.freePort()) per run, exactly like daemon-pid-race -- no other
// test binds an ephemeral, so there is no cross-suite collision, and this file
// itself opens NO listening socket, so it needs no P(N) offset.

const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, BIN, noEgress } = h;
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const util = require('../../lib/util');

const DAEMON_ENV = {
  MEMBRIDGE_INTERVAL: '3600',
  MEMBRIDGE_NO_DIAGNOSTICS: '1',
  MEMBRIDGE_NO_RETRIEVALS: '1',
  MEMBRIDGE_NO_RECALL: '1',
};

function req(method, port, pathname) {
  return new Promise(resolve => {
    // POST endpoints require Content-Type: application/json (server.js's
    // state-changing-method gate); no Origin header is sent, which the
    // sameOrigin() check treats as a non-browser local client.
    const headers = method === 'POST' ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, timeout: 2000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end(method === 'POST' ? '{}' : undefined);
  });
}

// Poll /api/status until it answers and satisfies `accept(pid)`, or time out.
// Returns the accepted pid, or null on timeout.
async function waitForDaemon(port, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await req('GET', port, '/api/status');
    if (res && res.status === 200) {
      let pid = null;
      try { pid = JSON.parse(res.body).pid; } catch {}
      if (pid && accept(pid)) return pid;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLog() {
  try { return fs.readFileSync(util.logPath(), 'utf8'); } catch { return '(no log)'; }
}

async function main() {
  fs.mkdirSync(util.homeDir(), { recursive: true });
  const port = await noEgress.freePort();

  // 1. Start a real daemon and wait for its dashboard to answer.
  const first = spawn(process.execPath, [BIN, 'daemon'], {
    env: { ...process.env, MEMBRIDGE_PORT: String(port), ...DAEMON_ENV },
    stdio: 'ignore',
  });
  const started = new Set([first.pid]);

  try {
    const pid1 = await waitForDaemon(port, () => true, 10000);
    assert.ok(pid1, `daemon never came up on port ${port}\nlog:\n${readLog()}`);

    // 2. Restart. The endpoint returns ok:true once the replacement is spawned;
    //    the old daemon then exits ~200ms later.
    const restart = await req('POST', port, '/api/daemon/restart');
    assert.ok(restart && restart.status === 200,
      `restart endpoint did not accept the request: ${restart ? restart.status + ' ' + restart.body : 'no response'}`);

    // 3. A DIFFERENT daemon must now take over. Accept only a pid that is not
    //    the original AND is alive. In the broken state the replacement refuses
    //    (guard) and the old daemon exits, so nothing new ever answers -> null.
    const pid2 = await waitForDaemon(port, p => p !== pid1 && isAlive(p), 12000);
    if (pid2) started.add(pid2);

    await check('POST /api/daemon/restart hands off to a new, live daemon (pid changes)', () => {
      assert.ok(pid2 && pid2 !== pid1,
        `no new daemon took over after restart: original pid=${pid1}, ` +
        `answering pid=${pid2 || 'none'} (original alive=${isAlive(pid1)}).\n` +
        `daemon log:\n${readLog()}`);
    });

    // 4. The genuine-duplicate guard must still refuse. Point the pid file at the
    //    live daemon and start a plain `membridge daemon` (NO restart handoff):
    //    it must exit non-zero without taking the pid.
    const livePid = pid2 || pid1;
    if (isAlive(livePid)) {
      fs.writeFileSync(util.pidPath(), String(livePid));
      const dupPort = await noEgress.freePort();
      const dup = spawnSync(process.execPath, [BIN, 'daemon'], {
        env: { ...process.env, MEMBRIDGE_PORT: String(dupPort), ...DAEMON_ENV },
        timeout: 5000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      });
      check('a genuine second `membridge daemon` is still refused (guard not fail-open)', () => {
        assert.ok(dup.status !== null && dup.status !== 0,
          `duplicate daemon did not exit cleanly non-zero (status=${dup.status}, signal=${dup.signal})\n` +
          `stdout: ${dup.stdout || '(empty)'}\nstderr: ${dup.stderr || '(empty)'}`);
        assert.ok(`${dup.stdout || ''}${dup.stderr || ''}`.includes(String(livePid)),
          `duplicate daemon did not name the running pid ${livePid} in its refusal`);
      });
    } else {
      check('a genuine second `membridge daemon` is still refused (guard not fail-open)', () => {
        assert.fail('no live daemon to test the duplicate guard against (restart handoff failed)');
      });
    }
  } finally {
    // Kill every daemon we started or that took over. Read the pid file too, in
    // case a handoff produced a daemon we never captured.
    const filePid = (() => { try { return parseInt(fs.readFileSync(util.pidPath(), 'utf8'), 10) || null; } catch { return null; } })();
    if (filePid) started.add(filePid);
    for (const pid of started) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}

main().then(() => h.finish()).catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
