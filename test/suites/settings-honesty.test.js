'use strict';
// The Settings status surface must not report success it never observed.
//
// Two findings from the Settings audit, both daemon-side:
//
// 1. /api/status reported `running: true` as a LITERAL. Only a live process
//    answers that request at all, so the field asserted "the HTTP server
//    responded" while the page rendered it as "MemBridge is working" — and a
//    daemon whose sync loop is wedged answers instantly and looked healthy
//    forever. `running` is now derived from the loop's actual last pass, and a
//    degraded state has to be REACHABLE or the same problem has been rebuilt.
//
// 2. POST /api/daemon/restart wrote {ok:true} BEFORE attempting the restart, and
//    a failure was only log()ged. A process genuinely cannot report that it
//    restarted (it would be gone), which is why it pre-confirmed — but it can
//    stop claiming the ATTEMPT succeeded when the spawn failed outright.
//
// Run directly, or via `node test/run.js settings-honesty`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, P, post } = h;
const assert = require('assert');
const { EventEmitter } = require('events');
const server = require('../../lib/server');
const apiMachine = require('../../lib/api-machine');

const util = require('../../lib/util');

// The freshness window is derived from the REAL configured interval (the
// harness pins MEMBRIDGE_INTERVAL), so ages are expressed in multiples of it
// rather than hardcoded seconds — a suite that assumed 300s silently stopped
// testing staleness at all under a 3600s harness.
const intervalSec = () => util.getConfig().intervalSec;
const agedTick = intervals => ({ at: Date.now() - intervals * intervalSec() * 1000, ok: true, error: null });

async function main() {
  // --- Finding 1: the sync loop's state, not the socket's ---
  {
    check('status: an unobserved loop reads unknown and NOT running', () => {
      server._resetTickForTests(null);
      const s = server.statusPayload();
      assert.strictEqual(s.health.state, 'unknown');
      assert.strictEqual(s.running, false,
        'running was true with no tick ever observed — the literal is back');
      assert.strictEqual(s.health.lastTickAt, null);
    });

    check('status: a completed pass reads ok and running, with a real timestamp', () => {
      server._resetTickForTests(null);
      server.noteTick({ ok: true });
      const s = server.statusPayload();
      assert.strictEqual(s.health.state, 'ok');
      assert.strictEqual(s.running, true);
      assert.ok(!Number.isNaN(Date.parse(s.health.lastTickAt)),
        `lastTickAt is not an ISO timestamp: ${s.health.lastTickAt}`);
      assert.strictEqual(s.health.lastTickError, null);
    });

    // A throwing pass is a different problem from a dead loop and must not
    // collapse into it: the catch that reports the error is also what keeps the
    // loop scheduled, so the daemon IS running and its work is failing.
    check('status: a throwing pass reads erroring — still running, error surfaced', () => {
      server._resetTickForTests(null);
      server.noteTick({ ok: false, error: 'ENOSPC writing state' });
      const s = server.statusPayload();
      assert.strictEqual(s.health.state, 'erroring');
      assert.strictEqual(s.running, true, 'an erroring loop is alive; reporting it dead names the wrong problem');
      assert.strictEqual(s.health.lastTickError, 'ENOSPC writing state');
    });

    check('status: a loop that stopped passing reads stalled and NOT running', () => {
      // Planted well past three intervals, which is the freshness window.
      server._resetTickForTests(agedTick(4));
      const s = server.statusPayload();
      assert.strictEqual(s.health.state, 'stalled');
      assert.strictEqual(s.running, false,
        'a wedged sync loop still reported running — this is the original bug');
      assert.ok(s.health.staleForSec >= intervalSec() * 3,
        `staleForSec looks wrong: ${s.health.staleForSec}`);
    });

    // The window has to tolerate a slow pass. The tick is a CHAINED setTimeout,
    // so the next pass starts intervalSec after the previous one FINISHED — a
    // long team sync legitimately widens the gap and must not read as wedged.
    check('status: a pass one interval old is still ok, not stalled', () => {
      server._resetTickForTests(agedTick(1));
      assert.strictEqual(server.statusPayload().health.state, 'ok');
    });

    check('status: a short interval still gets a floor before being called stalled', () => {
      // 1s interval: 3x would be 3s, which any real pass could exceed.
      const planted = { at: Date.now() - 30 * 1000, ok: true, error: null };
      server._resetTickForTests(planted);
      assert.strictEqual(server.tickHealth({ intervalSec: 1 }).state, 'ok',
        'a 30s-old pass on a 1s interval was called stalled — the floor is gone');
    });

    server._resetTickForTests(null);
  }

  // --- Finding 2: the restart reports the attempt, honestly ---
  {
    // The failure that matters. A missing or non-executable node binary is an
    // ASYNC 'error' event, not a synchronous throw, so a try/catch around
    // spawn() reports success for the most likely real-world failure.
    await (async () => {
      const child = new EventEmitter();
      const p = apiMachine.spawnReplacement({ spawnImpl: () => child, timeoutMs: 1000 });
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      let err = null;
      try { await p; } catch (e) { err = e; }
      check('restart: a child that fails to launch rejects, it does not resolve', () => {
        assert.ok(err, 'a failed spawn resolved as success — this is the pre-confirm bug');
        assert.match(err.message, /could not start a replacement MemBridge/);
        assert.strictEqual(err.status, 500);
      });
    })();

    await (async () => {
      const child = new EventEmitter();
      child.unref = () => {};
      const p = apiMachine.spawnReplacement({ spawnImpl: () => child, timeoutMs: 1000 });
      setImmediate(() => child.emit('spawn'));
      let err = null;
      try { await p; } catch (e) { err = e; }
      check('restart: a child the OS confirms started resolves', () => {
        assert.strictEqual(err, null, `a confirmed spawn was reported as failure: ${err && err.message}`);
      });
    })();

    await (async () => {
      let err = null;
      try {
        await apiMachine.spawnReplacement({
          spawnImpl: () => { throw new Error('bad options'); }, timeoutMs: 1000,
        });
      } catch (e) { err = e; }
      check('restart: a synchronous spawn throw rejects too', () => {
        assert.ok(err, 'a throwing spawn resolved as success');
        assert.strictEqual(err.status, 500);
      });
    })();

    await (async () => {
      const child = new EventEmitter(); // emits neither 'spawn' nor 'error'
      let err = null;
      try {
        await apiMachine.spawnReplacement({ spawnImpl: () => child, timeoutMs: 50 });
      } catch (e) { err = e; }
      check('restart: an unconfirmed spawn is a failure, never an optimistic success', () => {
        assert.ok(err, 'an unconfirmed spawn resolved — the request would claim a restart it never saw');
        assert.strictEqual(err.status, 504);
      });
    })();

    check('restart: a post-confirmation child error cannot crash this process', () => {
      // 'error' stays attached with on(), not once(): an error event with no
      // listener is an uncaught exception, in the one process whose job is not
      // to crash while replacing itself.
      const child = new EventEmitter();
      child.unref = () => {};
      apiMachine.spawnReplacement({ spawnImpl: () => child, timeoutMs: 1000 });
      child.emit('spawn');
      assert.doesNotThrow(() => child.emit('error', new Error('died later')),
        'a later child error had no listener and would take the daemon down');
    });

    await check('restart: scheduleExit is what ends this process, and it is separable', () => {
      let code = null;
      apiMachine.scheduleExit({ exit: c => { code = c; }, delayMs: 0 });
      return new Promise(r => setTimeout(() => {
        assert.strictEqual(code, 0, 'scheduleExit never exited');
        r();
      }, 20));
    });
  }

  // --- Finding 2, over HTTP: the endpoint's actual contract ---
  {
    const realSpawn = apiMachine.spawnReplacement;
    const realExit = apiMachine.scheduleExit;
    const PORT = P(7);
    const srv = server.startServer(PORT, { retries: 0 });
    await h.waitForHttp(`http://127.0.0.1:${PORT}/api/status`);
    try {
      // Failing spawn: the response must be an error, and — the part that
      // matters most — this daemon must NOT exit, or a failed restart leaves
      // the user with no daemon at all.
      let exited = false;
      apiMachine.scheduleExit = () => { exited = true; };
      apiMachine.spawnReplacement = () => Promise.reject(
        Object.assign(new Error('could not start a replacement MemBridge: spawn ENOENT'), { status: 500 }));
      const bad = await post(`http://127.0.0.1:${PORT}/api/daemon/restart`, {});
      const badBody = await bad.json();
      await new Promise(r => setTimeout(r, 30));
      check('restart endpoint: a failed spawn returns an error, not ok:true', () => {
        assert.strictEqual(bad.status, 500, `expected a 500, got ${bad.status}`);
        assert.ok(!badBody.ok, `endpoint still claimed success: ${JSON.stringify(badBody)}`);
        assert.match(String(badBody.error), /could not start a replacement MemBridge/);
      });
      check('restart endpoint: a failed spawn does not kill the daemon we still have', () => {
        assert.strictEqual(exited, false, 'the daemon scheduled its own exit after a failed restart');
      });

      // Succeeding spawn: ok:true, and only then is the exit scheduled — after
      // the response has been flushed, or the client sees a dropped socket.
      exited = false;
      apiMachine.spawnReplacement = () => Promise.resolve({});
      const good = await post(`http://127.0.0.1:${PORT}/api/daemon/restart`, {});
      const goodBody = await good.json();
      await new Promise(r => setTimeout(r, 30));
      check('restart endpoint: a confirmed spawn reports ok and then schedules the exit', () => {
        assert.strictEqual(good.status, 200);
        assert.strictEqual(goodBody.ok, true);
        assert.strictEqual(goodBody.restarting, true);
        assert.strictEqual(exited, true, 'the replacement started but this process was never scheduled to exit');
      });
    } finally {
      apiMachine.spawnReplacement = realSpawn;
      apiMachine.scheduleExit = realExit;
      await new Promise(r => srv.close(r));
    }
  }

  h.finish();
}

main();
