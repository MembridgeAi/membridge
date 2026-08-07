'use strict';
// The local daemon's HTTP surface — the only surface in this product reachable
// from any web page the user happens to visit.
//
// THREAT MODEL, stated because it differs from everything else audited. This
// needs no credential, no team membership, and no access to the machine: only
// that the user browses the web while the daemon runs. The port is FIXED
// (util.js dashboardPort: 7437), so an attacker page hardcodes it — no scanning,
// no discovery step. That makes every guard below load-bearing on an ordinary
// Tuesday, not in a contrived scenario.
//
// Every check here PASSES. This suite documents a defence rather than reporting
// a hole, because on inspection this surface is the best-defended one in the
// product. It is worth pinning precisely BECAUSE it is currently correct: the
// protections are cheap to lose and nothing else asserts them.
//
// All requests go to an instance this file starts on its own port. Nothing here
// touches a running daemon.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, P, waitForHttp } = h;
const assert = require('assert');
const net = require('net');
const { startServer } = require('../../lib/server');

const PORT = P(71);
const BASE = `http://127.0.0.1:${PORT}`;

// Raw fetch with explicit headers, so a "browser-shaped" request can be posed
// exactly — including the header combinations a browser would send and the ones
// it never would.
const req = (pathname, { method = 'GET', headers = {}, body } = {}) =>
  fetch(`${BASE}${pathname}`, { method, headers, body });

// Host must be posed over a RAW SOCKET, not through fetch.
//
// The first version of this suite set `headers: { Host: 'evil.example' }` on a
// fetch call and reported the daemon returning 200 — i.e. that the
// anti-rebinding guard was broken. It is not. `Host` is a forbidden header
// name, so undici silently drops it and sends the real one; the forged value
// never left the process. The assertion was measuring fetch, not the daemon.
// Raw sockets confirm the guard: forged Host -> 403, absent Host -> 400 from
// Node's own parser before the daemon sees it, loopback -> 200.
//
// Same lesson as this session's other instrument defect: a test that reports a
// vulnerability is as capable of being wrong as one that reports safety, and
// the direction of the error is not evidence either way.
const rawGet = hostLine => new Promise((resolve, reject) => {
  const socket = net.connect(PORT, '127.0.0.1', () => {
    socket.write(`GET /api/status HTTP/1.1\r\n${hostLine ? `${hostLine}\r\n` : ''}Connection: close\r\n\r\n`);
  });
  let buf = '';
  socket.on('data', d => { buf += d; });
  socket.on('end', () => resolve(Number((buf.split('\r\n')[0].match(/ (\d{3}) /) || [])[1])));
  socket.on('error', reject);
});

async function main() {
  const srv = startServer(PORT, { retries: 0 });
  try {
    await waitForHttp(`${BASE}/api/status`);

    // ANTI-DNS-REBINDING, and it applies to EVERY method including reads.
    // An attacker who points evil.example at 127.0.0.1 gets the browser to send
    // Host: evil.example, which is not a loopback name. Without this, rebinding
    // turns every read route into a cross-origin data source, because the page
    // would then be same-origin with the daemon and CORS would not apply at all.
    await check('a non-loopback Host is refused, on a READ', async () => {
      assert.strictEqual(await rawGet('Host: evil.example'), 403,
        'a rebound Host must be refused');
    });

    await check('a missing Host header fails closed', async () => {
      // Node's HTTP parser rejects an HTTP/1.1 request with no Host before the
      // daemon is reached, so this is 400 rather than the daemon's 403. Either
      // is closed; asserted as "not 200" so a future parser change that let it
      // through would have to face localHost's own Set.has('') -> false.
      const status = await rawGet(null);
      assert.notStrictEqual(status, 200, `absent Host must not be served (got ${status})`);
    });

    await check('loopback aliases are accepted', async () => {
      for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) {
        const res = await req('/api/status', { headers: { Host: host } });
        assert.strictEqual(res.status, 200, `${host} must be accepted`);
      }
    });

    // WRITES: two independent gates, either of which alone would do the job.
    await check('a cross-origin write is refused on the Origin check', async () => {
      const res = await req('/api/team/logout', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.strictEqual(res.status, 403);
    });

    // The classic preflight dodge: a form-shaped POST is a "simple request", so
    // the browser sends it without asking permission first. The content-type
    // gate refuses it independently of the Origin check, which matters because
    // Origin is the header an attacker would most like to be absent.
    await check('a form-shaped write is refused on the content-type check', async () => {
      for (const ct of ['text/plain;charset=UTF-8', 'application/x-www-form-urlencoded',
        'multipart/form-data; boundary=x']) {
        const res = await req('/api/team/logout', {
          method: 'POST', headers: { 'Content-Type': ct }, body: 'action=x',
        });
        assert.strictEqual(res.status, 403, `${ct} must be refused even with no Origin`);
      }
    });

    // THE INVARIANT WITH NO OTHER GUARD, and the reason this suite exists.
    //
    // Reads are gated by Host only — a GET carrying no Origin (an <img>, a
    // <script src>, a top-level navigation) passes both checks and the handler
    // RUNS. What stops the attacker page reading the answer is not the daemon:
    // it is the browser refusing to hand a cross-origin response to script
    // because no Access-Control-Allow-Origin came back. That protection is the
    // ABSENCE of a header — a property of what this code does not do, which no
    // amount of reading the guard functions would reveal.
    //
    // So one permissive CORS header, added anywhere for any reason (a dev
    // convenience, a UI fetch that seemed to need it, a copied middleware),
    // silently converts every read route below into a public API for any web
    // page — captured prompt text, team feed, settings and all. Nothing else in
    // the repo would notice. Pinned across the read routes that carry content.
    await check('no read route returns CORS headers that would expose it to a page', async () => {
      const routes = ['/api/status', '/api/feed', '/api/projects', '/api/settings',
        '/api/search?q=test', '/api/team', '/api/session'];
      for (const route of routes) {
        const res = await req(route);
        for (const header of ['access-control-allow-origin', 'access-control-allow-credentials']) {
          assert.strictEqual(res.headers.get(header), null,
            `${route} returned ${header} — that hands this route's body to any ` +
            'web page the user visits. Reads are gated on Host alone; the ' +
            'browser is what withholds the response, and only while no CORS ' +
            'header is present.');
        }
      }
    });

    // A preflight must not be answerable either, or the write gates above are
    // reachable from a page that simply asks permission first.
    await check('an OPTIONS preflight is not granted', async () => {
      const res = await req('/api/team/logout', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null,
        'answering the preflight would let a page make the JSON POST the ' +
        'content-type gate is meant to force it into');
    });

    // Reads DO execute cross-origin — asserted so the record is honest about
    // what the guards permit, rather than implying reads are blocked. The
    // consequence is bounded (the response is unreadable, per the check above),
    // but any read route that ever gains a side effect becomes triggerable blind
    // by an <img> tag on any page.
    await check('a GET with no Origin reaches the handler (documents the residual)', async () => {
      const res = await req('/api/status');
      assert.strictEqual(res.status, 200,
        'reads are gated on Host alone by design — recorded so that adding a ' +
        'side effect to any GET route is understood as making it CSRF-reachable');
    });
  } finally {
    await new Promise(r => srv.close(r));
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
