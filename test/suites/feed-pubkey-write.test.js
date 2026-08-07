'use strict';
// #63 — /api/feed is a READ, and a read must not write.
//
// WHY THIS EXISTS. server.feedPayload built the E2E crypto context on every
// call a signed-in install made, gated only on `feedEncryptOn && creds`. The
// first thing buildCryptoContext does is bootstrap the identity, and
// ensureIdentity re-upserts the pubkey on EVERY call (lib/teamsync.js:435 —
// deliberately, as a self-heal). So an install with no teams at all, whose feed
// read has literally nothing to decrypt, still fired an authenticated
// POST /rest/v1/member_pubkeys — and the Activity view polls this endpoint every
// 10 seconds, forever. It also sat on first paint next to /api/projects, where
// it was one of the two round trips that made the pair 40x slower than the
// projects read alone (see the numbers in projects-payload.test.js).
//
// WHY THE WRITE COULD MOVE RATHER THAN BE DELETED. The upsert is not a
// keepalive against any backend TTL — it is an idempotent merge on user_id that
// exists so a locally-persisted keypair whose first upload failed eventually
// publishes. Nothing on the READ path consumes it either: decryptTeamRows
// resolves a team key out of team_keys sealed to our own pubkey, and
// member_pubkeys is fetched only by reconcileTeamKeys/rekeyTeam on the sync
// side. syncTeams builds its own context on the 60s tick, so the self-heal
// survives at the place that actually needs a fresh published key.
//
// WHAT THESE CHECKS PIN, and why in this shape:
//
//   1. NO PUBKEY WRITE when there is nothing to decrypt — solo, and a team
//      whose page comes back empty. Asserted by counting requests against a
//      stub backend that would happily accept the write, because a latency
//      number today does not stop someone widening the gate tomorrow.
//   2. THE WRITE STILL HAPPENS when a ciphertext row is present. This is the
//      check that keeps check 1 honest: without it, a fixture that had
//      accidentally disabled encryption (or a keychain fake that never reported
//      available) would pass check 1 while proving nothing at all.
//   3. FAIL-CLOSED IS UNCHANGED. A ciphertext row we hold no key for still
//      renders opaque rather than leaking the server's plaintext columns — the
//      gate must not have bought its saving by skipping decryption.
//   4. A PLAINTEXT-ONLY team writes nothing and still reads through. Rows
//      without ciphertext pass through decryptTeamRows untouched whether the
//      context exists or not, so they must not drag the write back in.
//
// WHAT THESE CANNOT PROVE: real latency against a real Supabase. The stub
// answers instantly, which is exactly why "which requests were made" is the
// load-bearing assertion here rather than a duration.
//
// Run directly, or via `node test/run.js feed-pubkey-write`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P } = h;
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const util = require('../../lib/util');
const server = require('../../lib/server');

const STUB_PORT = P(74);
const SELF_ID = '11111111-1111-1111-1111-111111111111';
const MATE_ID = '22222222-2222-2222-2222-222222222222';
const TEAM_ID = '33333333-3333-3333-3333-333333333333';
const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const iso = minsAgo => new Date(NOW - minsAgo * 60000).toISOString();

// What the stub will answer for this call. Reassigned per check.
let teams = [];
let feedRows = [];
let requests = [];

// A backend that ACCEPTS the pubkey write. If the read path still makes it,
// it lands in `requests` and the checks below fail — the stub must never be
// the thing that stops it.
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/auth/v1/token')) {
      return res.end(JSON.stringify({
        access_token: 'stub-access', refresh_token: 'stub-refresh', expires_in: 3600,
        user: { id: SELF_ID, email: 'self@test.dev', user_metadata: {} },
      }));
    }
    if (req.url === '/rest/v1/rpc/my_teams') return res.end(JSON.stringify(teams));
    if (req.url === '/rest/v1/rpc/team_feed') return res.end(JSON.stringify(feedRows));
    res.end('[]');
  });
});

// A team_feed row in wire shape. `ciphertext`/`nonce` are what decryptTeamRows
// keys on, and therefore what the gate keys on.
function wireRow(over = {}) {
  return {
    id: 'row-1',
    ts: iso(5),
    created_at: iso(5),
    author_id: MATE_ID,
    author_name: 'Mate',
    source: 'Claude Code',
    session: 'mate-session',
    project_id: '44444444-4444-4444-4444-444444444444',
    project_name: 'shared-app',
    ask: null,
    summary: null,
    files: [],
    changes: null,
    goal: null,
    decisions: null,
    gotchas: null,
    headline: null,
    ...over,
  };
}

// Identity fakes, same injection convention redaction.test.js uses: cryptoDeps
// MERGES over the real deps, so the REAL rest-backed uploadPubkey stays wired
// and any write it makes reaches the stub above. The keychain is preloaded with
// a complete pair so ensureIdentity takes its self-heal branch — the exact path
// that re-upserts on every call, i.e. the one this ticket is about.
const kcMem = new Map([
  ['membridge.box.privatekey', 'PRIV-FIXTURE'],
  ['membridge.box.publickey', 'PUB-FIXTURE'],
]);
const cryptoDeps = {
  keychain: {
    available: () => true,
    load: a => (kcMem.has(a) ? kcMem.get(a) : null),
    store: (a, s) => { kcMem.set(a, s); return true; },
    remove: a => kcMem.delete(a),
  },
  teamcrypto: {
    available: () => true,
    ready: async () => {},
    genKeypair: () => ({ publicKey: 'PUB-FIXTURE', privateKey: 'PRIV-FIXTURE' }),
    // No key is ever resolvable here, so every ciphertext row must go opaque.
    decrypt: () => null,
    fingerprint: k => `fp:${k}`,
  },
};

const pubkeyWrites = () => requests.filter(r => r.startsWith('POST /rest/v1/member_pubkeys'));

async function main() {
  await new Promise(r => stub.listen(STUB_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${STUB_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'stub-anon';

  // Encryption ON — the default, and the only configuration in which this
  // ticket exists. Asserted rather than assumed: the encrypt:false hatch would
  // make every check below vacuous.
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.team = { ...(cfg.team || {}), encrypt: true };
  util.saveUserConfig(cfg);
  assert.notStrictEqual(((util.getConfig().team || {}).encrypt), false,
    'fixture guard: these checks are meaningless with the encrypt:false hatch on');

  // Signed in, with a token that does NOT need refreshing (expiresAt is compared
  // as epoch ms), so the request list stays about the feed rather than auth.
  fs.mkdirSync(util.homeDir(), { recursive: true });
  fs.writeFileSync(path.join(util.homeDir(), 'credentials.json'), JSON.stringify({
    userId: SELF_ID, accessToken: 'stored-access', refreshToken: 'stored-refresh',
    expiresAt: Date.now() + 3600000,
  }));

  // One watched project with local activity: the feed has real work to do, so a
  // "no writes" result can never be explained by an empty payload.
  const proj = path.join(ROOT, 'feed-projects', 'alpha');
  fs.mkdirSync(proj, { recursive: true });
  const st = util.loadState();
  st.projects[proj] = {
    events: [
      { ts: iso(30), source: 'Claude Code', kind: 'prompt', session: 'sess-1', text: 'do the thing' },
      { ts: iso(2), source: 'Claude Code', kind: 'edit', session: 'sess-1', file: 'lib/thing.js' },
    ],
  };
  util.saveState(st);

  const call = async () => {
    requests = [];
    return server.feedPayload({ limit: 50, now: new Date(NOW).toISOString(), cryptoDeps });
  };

  await check('solo — a feed read with no teams performs NO member_pubkeys write', async () => {
    teams = [];
    feedRows = [];
    const out = await call();
    assert.ok(out && Array.isArray(out.entries), 'must still return a feed payload');
    assert.ok(out.entries.length > 0, 'and the local half must actually be there');
    assert.deepStrictEqual(pubkeyWrites(), [],
      `a read must not write, got: ${requests.join(' | ')}`);
  });

  await check('a team whose page comes back EMPTY performs no member_pubkeys write either', async () => {
    // The gate cannot be "do I belong to a team" — membership alone gives the
    // read nothing to decrypt, and this is the steady state of a quiet project.
    teams = [{ team_id: TEAM_ID, name: 'Team', member_count: 2 }];
    feedRows = [];
    const out = await call();
    assert.strictEqual(out.teamUnavailable, false, 'the team half must have succeeded');
    assert.ok(requests.includes('POST /rest/v1/rpc/team_feed'), 'and must actually have been queried');
    assert.deepStrictEqual(pubkeyWrites(), [],
      `an empty team page is nothing to decrypt, got: ${requests.join(' | ')}`);
  });

  await check('a PLAINTEXT team row reads through without dragging the write back in', async () => {
    // Rows with no ciphertext pass through decryptTeamRows untouched whether the
    // context exists or not, so they must not cost a write.
    teams = [{ team_id: TEAM_ID, name: 'Team', member_count: 2 }];
    feedRows = [wireRow({ summary: 'Plain legacy row.' })];
    const out = await call();
    const mate = out.entries.find(e => e.authorId === MATE_ID);
    assert.ok(mate, 'the teammate row must surface');
    assert.strictEqual(mate.summary, 'Plain legacy row.', 'and read through unchanged');
    assert.deepStrictEqual(pubkeyWrites(), [],
      `a plaintext row needs no crypto context, got: ${requests.join(' | ')}`);
  });

  await check('a CIPHERTEXT row DOES build the context — the write is gated, not deleted', async () => {
    // The check that keeps the three above honest. If the fixture had quietly
    // disabled encryption, or the keychain fake reported unavailable, the "no
    // write" results would be true for the wrong reason and this fails.
    teams = [{ team_id: TEAM_ID, name: 'Team', member_count: 2 }];
    feedRows = [wireRow({ ciphertext: 'YmxvYg==', nonce: 'bm9uY2U=', key_epoch: 1 })];
    await call();
    assert.strictEqual(pubkeyWrites().length, 1,
      `a row worth decrypting must still bootstrap the identity, got: ${requests.join(' | ')}`);
  });

  await check('fail-closed survives the gate — an undecryptable row is still opaque', async () => {
    // The gate must not have bought its saving by skipping decryption: this row
    // has ciphertext we hold no key for, and its server-controlled plaintext
    // columns must not speak for it.
    teams = [{ team_id: TEAM_ID, name: 'Team', member_count: 2 }];
    feedRows = [wireRow({
      ciphertext: 'YmxvYg==', nonce: 'bm9uY2U=', key_epoch: 1,
      summary: 'POISONED server plaintext', headline: 'POISONED headline',
    })];
    const out = await call();
    const mate = out.entries.find(e => e.authorId === MATE_ID);
    assert.ok(mate, 'the row must still be served, opaquely');
    assert.strictEqual(mate.undecryptable, true, 'and marked undecryptable');
    assert.notStrictEqual(mate.summary, 'POISONED server plaintext',
      'the server plaintext must never speak for a ciphertext row');
    assert.notStrictEqual(mate.headline, 'POISONED headline');
  });

  await check('a mixed page builds the context ONCE for the whole read', async () => {
    // Two teams, only one of them carrying ciphertext. The context is per-read,
    // not per-team, so the plaintext team must not add a second bootstrap.
    teams = [
      { team_id: TEAM_ID, name: 'Team A', member_count: 2 },
      { team_id: '55555555-5555-5555-5555-555555555555', name: 'Team B', member_count: 2 },
    ];
    feedRows = [
      wireRow({ id: 'row-plain', session: 'plain', summary: 'Plain.' }),
      wireRow({ id: 'row-cipher', session: 'cipher', ciphertext: 'YmxvYg==', nonce: 'bm9uY2U=', key_epoch: 1 }),
    ];
    await call();
    assert.strictEqual(pubkeyWrites().length, 1,
      `one context per read, not one per team, got: ${requests.join(' | ')}`);
  });

  await new Promise(r => stub.close(r));
  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
