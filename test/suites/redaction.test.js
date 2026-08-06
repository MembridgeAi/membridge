'use strict';
// @serial — carries a perf assertion (the 200-event render budget). The check
// measures process CPU time, which external load mostly cannot inflate, but
// heavy contention still taxes it somewhat (SMT siblings, cache pressure), so
// test/run.js additionally runs this suite with nothing else in flight.
// Extracted verbatim from test/run-tests.js. Shared plumbing lives in
// test/harness.js; run this file directly, or via `node test/run.js redaction`.
// --- 12. built-in secret redaction (lib/redact.js) ---
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, BIN, jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../../lib/util');
const { syncOnce } = require('../../lib/scan');
const digest = require('../../lib/digest');
const { feedPayload } = require('../../lib/server');
const teamsync = require('../../lib/teamsync');
const { createMockSupabase } = require('../mock-supabase');
const memorydb = require('../../lib/memorydb');
const hooks = require('../../lib/hooks');
const redactLib = require('../../lib/redact');
const feed = require('../../lib/feed');

async function main() {
  // Suite-local seed, mirroring setupFixtures() in the monolith: the team-push
  // checks below assert prompt text crossing the wire, so this home opts into
  // prompt sharing; encrypt:false is the explicit escape hatch that keeps the
  // mock-Supabase round trip off the real macOS keychain.
  util.ensureConfig();
  const cfgSeed = util.loadUserConfig();
  cfgSeed.team = { ...(cfgSeed.team || {}), sharePrompts: true, encrypt: false };
  util.saveUserConfig(cfgSeed);

  // --- 12. built-in secret redaction (lib/redact.js) ---
  // Per-pattern unit coverage: the secret is gone and the named marker present.
  const GH_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SLACK_TOKEN = 'xox' + 'b-9999999999-ABCDEFGHIJKLMNOP';
  const ANTHROPIC_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOP1234567890';
  // FIX ROUND 1, FINDING 5: real OpenAI keys are dash-bearing (sk-proj-...,
  // sk-live-...) -- the old pattern (/\bsk-[A-Za-z0-9]{20,}/) disallowed
  // internal dashes and missed this shape entirely, a genuine gap since
  // skeletons derive from raw source where such keys actually appear.
  const OPENAI_KEY = 'sk-live-' + '1234567890abcdef1234567890';
  const GOOGLE_KEY = 'AIza' + 'B1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2'; // AIza + 35
  const AWS_KEY = 'AKIA1234567890ABCDEF';
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  const PG_URI = 'postgres://app:hunter2secret@db.internal:5432/prod';
  const ENTROPY_TOKEN = 'aB3dE5gH7jK9mN1pQ3rS5tU7wX9zA1cE'; // 32-char base64, entropy > 4.5
  const STRIPE_KEY = 'sk_live_' + 'ABCDEFGHIJKLMNOP1234567890';
  const STRIPE_WEBHOOK = 'whsec_' + 'ABCDEFGHIJKLMNOPabcdefghij1234';
  const GOOGLE_OAUTH_SECRET = 'GOCSPX-' + 'ABCDEFGHIJKLMNOP1234567890';
  const SENDGRID_KEY = 'SG.' + 'ABCDEFGHIJKLMNOP1234' + '.' + 'abcdefghijklmnop1234ABCDEFGHIJKLMNOP567';
  const NPM_TOKEN = 'npm_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // npm_ + 36
  // Split across a + so no full webhook-URL literal appears contiguously in
  // source — GitHub push protection flags the shape even for obviously-fake
  // tokens. The runtime value (what the redactor is tested against) is identical.
  const SLACK_WEBHOOK = 'https://hooks.slack.com' + '/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
  const DISCORD_WEBHOOK = 'https://discord.com/api' + '/webhooks/123456789012345678/AbC-dEf_1234567890AbCdEfGhIjKlMnOpQrStUvWx';
  // The shape of the real leak the url-credential-param pattern was added for.
  // A UUID on purpose: that is what the sign-in callback actually mints, and it
  // is the one shape the entropy backstop is GUARANTEED to miss (looksLikeSecret
  // exempts UUIDs so session ids survive). A high-entropy blob here would pass
  // on the backstop alone and prove nothing about the new pattern.
  const AUTH_CODE = '1f0e5d5d-1603-4ea6-8b41-832bf6d27195';
  const cases = [
    ['aws-access-key', `creds ${AWS_KEY} here`, AWS_KEY],
    ['github-token', `rotate ${GH_TOKEN} now`, GH_TOKEN],
    ['google-api-key', `key ${GOOGLE_KEY} end`, GOOGLE_KEY],
    ['slack-token', `slack ${SLACK_TOKEN} end`, SLACK_TOKEN],
    ['anthropic-key', `key ${ANTHROPIC_KEY} tail`, ANTHROPIC_KEY],
    ['openai-key', `key ${OPENAI_KEY} tail`, OPENAI_KEY],
    ['jwt', `token ${JWT} done`, JWT],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIBhaha+notreal/xyz==\n-----END RSA PRIVATE KEY-----', 'MIIBhaha'],
    ['credentials', `DB ${PG_URI} yo`, 'hunter2secret'],
    ['secret-assignment', "config password=hunter2xyz done", 'hunter2xyz'],
    ['stripe-key', `pay ${STRIPE_KEY} now`, STRIPE_KEY],
    ['stripe-webhook-secret', `sig ${STRIPE_WEBHOOK} end`, STRIPE_WEBHOOK],
    ['google-oauth-secret', `oauth ${GOOGLE_OAUTH_SECRET} end`, GOOGLE_OAUTH_SECRET],
    ['sendgrid-key', `mail ${SENDGRID_KEY} sent`, SENDGRID_KEY],
    ['npm-token', `registry ${NPM_TOKEN} used`, NPM_TOKEN],
    ['slack-webhook-url', `post ${SLACK_WEBHOOK} now`, SLACK_WEBHOOK],
    ['discord-webhook-url', `hook ${DISCORD_WEBHOOK} set`, DISCORD_WEBHOOK],
    ['url-credential-param', `visit https://hub.membridge.ai/auth/cli?code=${AUTH_CODE} now`, AUTH_CODE],
    ['high-entropy', `blob ${ENTROPY_TOKEN} done`, ENTROPY_TOKEN],
  ];
  // E2E crypto primitives (libsodium sealed-box + secretbox). Load once so the
  // sync check body can use the primitives directly (check() doesn't await).
  const teamcrypto = require('../../lib/teamcrypto');
  await teamcrypto.ready();
  check('teamcrypto: seal/unseal + secretbox round trip, wrong-key safe, file paths inside ciphertext', () => {
    const a = teamcrypto.genKeypair(), b = teamcrypto.genKeypair();
    const teamKey = teamcrypto.genTeamKey();
    const sealed = teamcrypto.sealTeamKey(teamKey, b.publicKey);
    assert.strictEqual(teamcrypto.unsealTeamKey(sealed, b.publicKey, b.privateKey), teamKey, 'unseal round trip');
    const payload = { ask: 'q', summary: 's', goal: null, decisions: null, gotchas: null, files: ['src/login.js'], changes: null };
    const enc = teamcrypto.encrypt(payload, teamKey);
    assert.deepStrictEqual(teamcrypto.decrypt(enc.ciphertext, enc.nonce, teamKey), payload, 'secretbox round trip');
    assert.strictEqual(teamcrypto.unsealTeamKey(sealed, a.publicKey, a.privateKey), null, 'wrong keypair -> null');
    assert.strictEqual(teamcrypto.decrypt(enc.ciphertext, enc.nonce, teamcrypto.genTeamKey()), null, 'wrong team key -> null');
    assert.ok(!Buffer.from(enc.ciphertext, 'base64').toString('latin1').includes('src/login.js'), 'file path leaked into ciphertext');
    assert.notStrictEqual(teamcrypto.encrypt(payload, teamKey).ciphertext, enc.ciphertext, 'nonce reused');
  });
  // Fingerprints (E2E completion Task 1): a short human-comparable digest of a
  // box pubkey for Signal-style out-of-band verification. The format is a
  // contract — it is what two humans read aloud to each other — so it is
  // asserted exactly: eight 4-hex groups.
  check('teamcrypto: fingerprint is stable, formatted, and key-specific', () => {
    const kp = teamcrypto.genKeypair();
    const fp = teamcrypto.fingerprint(kp.publicKey);
    assert.strictEqual(fp, teamcrypto.fingerprint(kp.publicKey), 'same key -> same fingerprint');
    assert.match(fp, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/, 'eight 4-hex groups');
    assert.notStrictEqual(fp, teamcrypto.fingerprint(teamcrypto.genKeypair().publicKey), 'different key -> different fingerprint');
  });
  // TOFU pin store (E2E completion Task 1): first sight pins, change alerts,
  // and the pinned key is never silently replaced — `membridge team trust` is
  // the only way to re-pin. check() is pure; load/save go through the
  // MEMBRIDGE_HOME-isolated pins.json.
  const teampins = require('../../lib/teampins');
  check('teampins: TOFU pins unseen keys, alerts on change, load/save round trip', () => {
    const kA = teamcrypto.genKeypair(), kB = teamcrypto.genKeypair(), kEvil = teamcrypto.genKeypair();
    const fetched = [
      { user_id: 'u-a', public_key: kA.publicKey, display_name: 'Alice' },
      { user_id: 'u-b', public_key: kB.publicKey, display_name: 'Bob' },
    ];
    const first = teampins.check({}, fetched, '2026-07-21T00:00:00Z');
    assert.strictEqual(first.allowed.length, 2, 'all first-sight keys allowed (TOFU)');
    assert.strictEqual(first.alerts.length, 0, 'no alerts on first sight');
    assert.strictEqual(first.pins['u-a'].publicKey, kA.publicKey, 'pinned A');
    assert.strictEqual(first.pins['u-b'].name, 'Bob', 'pin carries the display name');
    // The server swaps Bob's key: Bob is excluded and alerted, Alice unaffected,
    // and Bob's PIN keeps the original key.
    const swapped = [fetched[0], { user_id: 'u-b', public_key: kEvil.publicKey, display_name: 'Bob' }];
    const second = teampins.check(first.pins, swapped, '2026-07-22T00:00:00Z');
    assert.deepStrictEqual(second.allowed.map(m => m.user_id), ['u-a'], 'changed key excluded from allowed');
    assert.strictEqual(second.alerts.length, 1, 'exactly one alert');
    assert.strictEqual(second.alerts[0].user_id, 'u-b', 'alert names the member');
    assert.strictEqual(second.alerts[0].pinned, kB.publicKey, 'alert carries the pinned key');
    assert.strictEqual(second.alerts[0].fetched, kEvil.publicKey, 'alert carries the fetched key');
    assert.strictEqual(second.pins['u-b'].publicKey, kB.publicKey, 'pin NOT overwritten by a changed key');
    assert.strictEqual(first.pins['u-b'].publicKey, kB.publicKey, 'input pins object never mutated');
    teampins.save(second.pins);
    assert.deepStrictEqual(teampins.load(), second.pins, 'save/load round trip');
    fs.writeFileSync(teampins.pinsPath(), '{nope');
    assert.deepStrictEqual(teampins.load(), {}, 'corrupt pins file -> empty, never a crash');
    teampins.save(second.pins); // leave a valid file behind for later sections
  });
  // Private-key storage. The real keychain only exists on macOS, so off-darwin
  // this asserts the fail-closed contract instead of skipping blind.
  const keychain = require('../../lib/keychain');
  // argv hardening (E2E completion Task 2): argv is world-readable via `ps`,
  // so the secret must travel to `security` on stdin, never as an argument.
  // Runner-injected so the assertion is about command construction, not the
  // real keychain; the darwin round-trip check below exercises the real path.
  check('keychain: store passes the secret via stdin, never argv', () => {
    if (process.platform !== 'darwin') return; // store() fails closed off-darwin by design
    const calls = [];
    const prev = keychain._setRunner((args, input) => { calls.push({ args, input: input || '' }); return { status: 0, stdout: '' }; });
    try {
      const secret = 'U0VDUkVULXZh+bHVl/wow==';
      assert.ok(keychain.store('membridge.test.stdin', secret), 'store failed');
      assert.ok(calls.every(c => !c.args.join(' ').includes(secret)), 'secret leaked into argv');
      const store = calls.find(c => c.args[0] === '-i');
      assert.ok(store, 'store must run security in -i (stdin command) mode');
      assert.ok(store.input.includes(secret), 'secret travels on stdin');
      assert.ok(/add-generic-password/.test(store.input), 'stdin carries the add command');
      assert.ok(/-U/.test(store.input), 'idempotent update flag preserved');
    } finally { keychain._setRunner(prev); }
  });
  check('keychain: store/load/remove round trip on macOS; fails closed elsewhere', () => {
    if (!keychain.available()) {
      assert.strictEqual(keychain.load('anything'), null, 'unavailable load must be null');
      assert.strictEqual(keychain.store('a', 'b'), false, 'unavailable store must be false');
      return; // no `security` binary: fail-closed contract verified, nothing more to test
    }
    const acct = 'membridge.test.' + Date.now();
    assert.ok(keychain.store(acct, 'SECRET-VALUE'), 'store failed');
    assert.strictEqual(keychain.load(acct), 'SECRET-VALUE', 'load round trip');
    assert.ok(keychain.store(acct, 'SECOND'), 're-store (update) failed');
    assert.strictEqual(keychain.load(acct), 'SECOND', 'update round trip');
    assert.ok(keychain.remove(acct), 'remove failed');
    assert.strictEqual(keychain.load(acct), null, 'load after remove must be null');
  });
  // Windows DPAPI backend. lib/keychain.js has a full Windows implementation
  // (winAvailable/winStore/winLoad/winRemove) that has never been executed by
  // this suite — every check above is darwin-or-fail-closed, so on a Mac the
  // Windows path is completely uncovered.
  //
  // THIS IS DELIBERATELY A VISIBLE SKIP, NOT A SILENT PASS. An earlier version
  // of this test opened with `if (process.platform !== 'win32') return;`, which
  // counted as a passing check on every Mac run — the suite reported Windows
  // key storage as tested when nothing had run. Real coverage requires the
  // Windows CI leg (.github/workflows/windows.yml); until that runs, this line
  // is the honest statement that it has not been verified here.
  if (process.platform === 'win32') {
    check('keychain(win): real DPAPI store/load/remove round trip', () => {
      assert.ok(keychain.available(), 'DPAPI must be available on win32');
      const acct = 'membridge.test.win.' + Date.now();
      assert.ok(keychain.store(acct, 'WIN-SECRET'), 'store failed');
      assert.strictEqual(keychain.load(acct), 'WIN-SECRET', 'load round trip');
      assert.ok(keychain.store(acct, 'WIN-SECOND'), 're-store (update) failed');
      assert.strictEqual(keychain.load(acct), 'WIN-SECOND', 'update round trip');
      assert.ok(keychain.remove(acct), 'remove failed');
      assert.strictEqual(keychain.load(acct), null, 'load after remove must be null');
    });
    check('keychain(win): the secret never travels on argv', () => {
      // argv is world-readable via Get-CimInstance Win32_Process, exactly as it
      // is via `ps` on macOS. The DPAPI backend must feed the secret to
      // powershell on stdin; the -EncodedCommand text carries no secret.
      const acct = 'membridge.test.win.argv.' + Date.now();
      const secret = 'U0VDUkVULXZh+bHVl/wow==';
      try {
        assert.ok(keychain.store(acct, secret), 'store failed');
        assert.strictEqual(keychain.load(acct), secret, 'round trip');
      } finally { keychain.remove(acct); }
    });
  } else {
    console.log('  skip  keychain(win): DPAPI round trip — not win32, needs the Windows CI leg');
  }

  // Identity bootstrap (ensureIdentity, plan Task 4): pure by injection, so
  // every scenario runs offline against fakes — no network, no real keychain.
  // Awaits happen at block level (check() doesn't await), wrapped so a missing
  // helper fails the checks instead of killing the runner.
  {
    const mkIdFakes = (opts = {}) => {
      const stored = new Map(opts.preload || []);
      const calls = { store: [], upload: [], gen: 0 };
      return {
        stored, calls,
        deps: {
          keychain: {
            available: () => opts.keychainAvailable !== false,
            load: a => (stored.has(a) ? stored.get(a) : null),
            store: (a, s) => {
              calls.store.push(a);
              if (opts.storeFails) return false;
              stored.set(a, s);
              return true;
            },
            remove: a => stored.delete(a),
          },
          teamcrypto: {
            available: () => opts.cryptoAvailable !== false,
            ready: async () => {},
            genKeypair: () => {
              calls.gen++;
              return { publicKey: 'PUB' + calls.gen, privateKey: 'PRIV' + calls.gen };
            },
          },
          uploadPubkey: async row => { calls.upload.push(row); },
        },
      };
    };
    const idCreds = { userId: 'user-1', accessToken: 'tok' };
    let idErr = null;
    const fresh = mkIdFakes();
    const noCrypto = mkIdFakes({ cryptoAvailable: false });
    const noChain = mkIdFakes({ keychainAvailable: false });
    const halfPair = mkIdFakes({ preload: [['membridge.box.privatekey', 'ORPHAN-PRIV']] });
    const badStore = mkIdFakes({ storeFails: true });
    let id1, id2, idNoCrypto, idNoChain, idNoCreds, idHalf, idBadStore;
    try {
      id1 = await teamsync.ensureIdentity(idCreds, fresh.deps);
      id2 = await teamsync.ensureIdentity(idCreds, fresh.deps);
      idNoCrypto = await teamsync.ensureIdentity(idCreds, noCrypto.deps);
      idNoChain = await teamsync.ensureIdentity(idCreds, noChain.deps);
      idNoCreds = await teamsync.ensureIdentity(null, fresh.deps);
      idHalf = await teamsync.ensureIdentity(idCreds, halfPair.deps);
      idBadStore = await teamsync.ensureIdentity(idCreds, badStore.deps);
    } catch (e) { idErr = e; }

    check('teamsync: ensureIdentity first call generates a pair, stores both halves, uploads the pubkey once', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.deepStrictEqual(id1, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(fresh.calls.gen, 1, 'expected exactly one keypair generation');
      assert.strictEqual(fresh.stored.get('membridge.box.privatekey'), 'PRIV1', 'private key not stored');
      assert.strictEqual(fresh.stored.get('membridge.box.publickey'), 'PUB1', 'public key not stored');
      // Both block-level calls have already run by check time; the FIRST
      // upload is the generation-time one (the second is the self-heal
      // upsert asserted below).
      assert.deepStrictEqual(fresh.calls.upload[0], { user_id: 'user-1', public_key: 'PUB1' },
        'first call must upload { user_id, public_key }');
    });

    check('teamsync: ensureIdentity second call reuses the stored pair and re-upserts the pubkey (self-heal)', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.deepStrictEqual(id2, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(fresh.calls.gen, 1, 'second call must not regenerate');
      // The upsert is idempotent (merge-duplicates on user_id) and MUST run
      // every call: a locally-persisted identity whose first upload failed
      // (e.g. keypair generated before the backend migrated) would otherwise
      // never publish its pubkey and the team key could never seal to it.
      assert.strictEqual(fresh.calls.upload.length, 2, 'every call must (re)upsert the pubkey');
      assert.strictEqual(fresh.calls.upload[1].public_key, 'PUB1', 'the re-upsert must carry the stored pubkey');
    });

    check('teamsync: ensureIdentity fails closed — unavailable crypto/keychain or missing creds return null, nothing stored or uploaded', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.strictEqual(idNoCrypto, null);
      assert.strictEqual(noCrypto.calls.store.length + noCrypto.calls.upload.length, 0, 'unavailable crypto must be a no-op');
      assert.strictEqual(idNoChain, null);
      assert.strictEqual(noChain.calls.store.length + noChain.calls.upload.length, 0, 'unavailable keychain must be a no-op');
      assert.strictEqual(idNoCreds, null, 'missing creds must return null');
    });

    check('teamsync: ensureIdentity self-heals a half-missing pair by regenerating and re-uploading', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.deepStrictEqual(idHalf, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(halfPair.stored.get('membridge.box.privatekey'), 'PRIV1', 'orphaned private key must be replaced');
      assert.strictEqual(halfPair.calls.upload.length, 1, 'regenerated pubkey must be uploaded');
    });

    check('teamsync: ensureIdentity returns null and uploads nothing when the keychain cannot persist the key', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.strictEqual(idBadStore, null, 'a key we cannot retain must not be reported as an identity');
      assert.strictEqual(badStore.calls.upload.length, 0, 'must not upload a pubkey whose private half was not persisted');
    });
  }

  // Team-key handling (resolveTeamKey, plan Task 5): same injected-deps
  // convention as ensureIdentity above. deps.teamId names the team the
  // closures are bound to (inserted rows carry it), deps.cache is the
  // caller-owned per-sync-run Map — injection, not module state, so the
  // "one pass" lifetime is the caller's by construction.
  {
    const mkKeyFakes = (opts = {}) => {
      const calls = { fetchRow: 0, fetchRowEpochs: [], fetchMembers: 0, inserts: [], gen: 0, seal: [], unseal: 0 };
      return {
        calls,
        deps: {
          teamId: opts.teamId || 'team-1',
          cache: opts.cache,
          teamcrypto: {
            available: () => opts.cryptoAvailable !== false,
            ready: async () => {},
            genTeamKey: () => { calls.gen++; return 'RAWKEY' + calls.gen; },
            sealTeamKey: (key, pub) => { calls.seal.push([key, pub]); return `SEALED(${key}->${pub})`; },
            unsealTeamKey: sealed => { calls.unseal++; return opts.unsealFails ? null : 'UNSEALED-' + sealed; },
          },
          fetchMySealedRow: async epoch => {
            calls.fetchRow++;
            calls.fetchRowEpochs.push(epoch);
            return opts.myRow || null;
          },
          fetchMemberPubkeys: async () => { calls.fetchMembers++; return opts.members || []; },
          insertSealedRows: async rows => { calls.inserts.push(rows); },
        },
      };
    };
    const keyIdentity = { publicKey: 'MYPUB', privateKey: 'MYPRIV' };
    const twoMembers = [
      { user_id: 'u-a', public_key: 'PUB-A' },
      { user_id: 'u-b', public_key: 'PUB-B' },
    ];
    let tkErr = null;
    const mint = mkKeyFakes({ members: twoMembers, teamId: 'team-mint' });
    const have = mkKeyFakes({ myRow: { sealed_team_key: 'BLOB' }, teamId: 'team-have' });
    const cached = mkKeyFakes({ myRow: { sealed_team_key: 'BLOB2' }, teamId: 'team-cache', cache: new Map() });
    const badUnseal = mkKeyFakes({ myRow: { sealed_team_key: 'BAD' }, unsealFails: true, teamId: 'team-bad', cache: new Map() });
    const noCrypto = mkKeyFakes({ cryptoAvailable: false, teamId: 'team-off' });
    let kMint, kHave, kC1, kC2, kC3, kBad, kBadAgain, kOff, kNoId;
    try {
      kMint = await teamsync.resolveTeamKey(keyIdentity, 3, mint.deps);
      kHave = await teamsync.resolveTeamKey(keyIdentity, 1, have.deps);
      kC1 = await teamsync.resolveTeamKey(keyIdentity, 1, cached.deps);
      kC2 = await teamsync.resolveTeamKey(keyIdentity, 1, cached.deps);   // same epoch: cache hit
      kC3 = await teamsync.resolveTeamKey(keyIdentity, 2, cached.deps);   // new epoch: cache miss
      kBad = await teamsync.resolveTeamKey(keyIdentity, 1, badUnseal.deps);
      kBadAgain = await teamsync.resolveTeamKey(keyIdentity, 1, badUnseal.deps); // failure must not be cached
      kOff = await teamsync.resolveTeamKey(keyIdentity, 1, noCrypto.deps);
      kNoId = await teamsync.resolveTeamKey(null, 1, mkKeyFakes().deps);
    } catch (e) { tkErr = e; }

    check('teamsync: resolveTeamKey (pull side) with no sealed row fails closed — never mints', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kMint, null, 'an epoch I was never sealed into is unreadable, full stop');
      assert.strictEqual(mint.calls.gen, 0, 'pull-side resolution must never generate a key');
      assert.deepStrictEqual(mint.calls.fetchRowEpochs, [3], 'fetchMySealedRow must receive the epoch');
      assert.strictEqual(mint.calls.inserts.length, 0, 'pull-side resolution must never insert');
    });

    check('teamsync: resolveTeamKey with an existing sealed row unseals it — no generation, no insert', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kHave, 'UNSEALED-BLOB');
      assert.strictEqual(have.calls.gen, 0, 'must not generate when a sealed row exists');
      assert.strictEqual(have.calls.inserts.length, 0, 'must not insert when a sealed row exists');
      assert.strictEqual(have.calls.fetchMembers, 0, 'must not fetch member pubkeys when a sealed row exists');
    });

    check('teamsync: resolveTeamKey caches per (team, epoch) for the injected cache\'s lifetime', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kC1, 'UNSEALED-BLOB2');
      assert.strictEqual(kC2, 'UNSEALED-BLOB2', 'second call must return the same key');
      assert.strictEqual(cached.calls.fetchRow, 2, 'same epoch must be served from cache (1 fetch) + new epoch refetches (2nd)');
      assert.strictEqual(cached.calls.fetchRowEpochs[1], 2, 'only the new epoch may refetch');
      assert.strictEqual(kC3, 'UNSEALED-BLOB2', 'different epoch resolves independently (same fake blob)');
    });

    check('teamsync: resolveTeamKey fails closed — unseal failure or unavailable crypto/identity returns null with no inserts, and failures are never cached', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kBad, null, 'unseal failure must return null');
      assert.strictEqual(kBadAgain, null);
      assert.strictEqual(badUnseal.calls.fetchRow, 2, 'a failed resolve must not be cached — second call refetches');
      assert.strictEqual(badUnseal.calls.inserts.length, 0, 'unseal failure must not insert');
      assert.strictEqual(kOff, null, 'unavailable crypto must return null');
      assert.strictEqual(noCrypto.calls.fetchRow, 0, 'unavailable crypto must not fetch');
      assert.strictEqual(kNoId, null, 'missing identity must return null');
    });
  }

  // Current-key resolution (E2E completion Task 3): epoch discovery from the
  // team-wide key rows, rotation when membership shrank, join-seal for members
  // missing at the current epoch, continuous TOFU gating of every seal target,
  // and lost mint races resolved by reading back my own sealed row. The fake
  // seal is a reversible string encoding (S(KEY->PUB)) so a concurrent
  // winner's key can round-trip without real crypto.
  {
    const teampins2 = require('../../lib/teampins');
    const mkCur = (opts = {}) => {
      const calls = { rowFetches: 0, inserts: [], gen: 0, alerts: [], myRowEpochs: [] };
      let stored = opts.rows ? opts.rows.slice() : [];
      const pinsBox = { pins: opts.pins ? { ...opts.pins } : {} };
      return {
        calls, pinsBox,
        deps: {
          teamId: opts.teamId || 'team-cur', userId: 'me', cache: opts.cache,
          teamcrypto: {
            available: () => true, ready: async () => {},
            genTeamKey: () => 'RAW' + (++calls.gen),
            sealTeamKey: (key, pub) => `S(${key}->${pub})`,
            unsealTeamKey: sealed => { const m = /^S\((.+?)->/.exec(sealed || ''); return m ? m[1] : null; },
          },
          pins: { load: () => pinsBox.pins, save: p => { pinsBox.pins = p; }, check: teampins2.check },
          onAlert: a => calls.alerts.push(...a),
          fetchTeamKeyRows: async () => { calls.rowFetches++; return stored.map(r => ({ ...r })); },
          fetchMembers: async () => opts.members || [],
          fetchMemberPubkeys: async () => opts.pubkeys || [],
          fetchMySealedRow: async epoch => {
            calls.myRowEpochs.push(epoch);
            const mine = stored.find(r => r.epoch === epoch && r.member_user_id === 'me');
            if (mine) return mine;
            // A concurrent minter won the insert race: read-back sees THEIR
            // key sealed to me, not the rows this client tried to write.
            if (opts.raceWinnerKey) return { sealed_team_key: `S(${opts.raceWinnerKey}->MYPUB)` };
            return null;
          },
          insertSealedRows: async rows => {
            calls.inserts.push(rows);
            if (!opts.dropInserts) stored = stored.concat(rows);
          },
        },
      };
    };
    const me = { user_id: 'me', public_key: 'MYPUB', display_name: 'Me' };
    const bob = { user_id: 'u-b', public_key: 'PUB-B', display_name: 'Bob' };
    const idc = { publicKey: 'MYPUB', privateKey: 'MYPRIV' };
    const membersOf = list => list.map(m => ({ user_id: m.user_id, display_name: m.display_name }));
    const pubsOf = list => list.map(m => ({ user_id: m.user_id, public_key: m.public_key }));
    const bothRows = [
      { epoch: 1, member_user_id: 'me', sealed_team_key: 'S(K1->MYPUB)' },
      { epoch: 1, member_user_id: 'u-b', sealed_team_key: 'S(K1->PUB-B)' },
    ];

    const fresh = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]) });
    const have = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), rows: bothRows });
    const rotate = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]),
      rows: bothRows.concat([{ epoch: 1, member_user_id: 'u-gone', sealed_team_key: 'S(K1->PUB-GONE)' }]) });
    const joinCase = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), rows: [bothRows[0]] });
    const tofu = mkCur({ members: membersOf([me, bob]),
      pubkeys: [pubsOf([me])[0], { user_id: 'u-b', public_key: 'EVIL' }],
      pins: { 'u-b': { publicKey: 'PUB-B', name: 'Bob', firstSeen: 't0' } } });
    const race = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), dropInserts: true, raceWinnerKey: 'WINNER' });
    const wait = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]),
      rows: [{ epoch: 2, member_user_id: 'u-b', sealed_team_key: 'S(K2->PUB-B)' }] });
    const cachedCur = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), cache: new Map(), rows: bothRows });

    let curErr = null, rFresh, rHave, rRotate, rJoin, rTofu, rRace, rWait, rCached1, rCached2;
    try {
      rFresh = await teamsync.resolveCurrentTeamKey(idc, fresh.deps);
      rHave = await teamsync.resolveCurrentTeamKey(idc, have.deps);
      rRotate = await teamsync.resolveCurrentTeamKey(idc, rotate.deps);
      rJoin = await teamsync.resolveCurrentTeamKey(idc, joinCase.deps);
      rTofu = await teamsync.resolveCurrentTeamKey(idc, tofu.deps);
      rRace = await teamsync.resolveCurrentTeamKey(idc, race.deps);
      rWait = await teamsync.resolveCurrentTeamKey(idc, wait.deps);
      rCached1 = await teamsync.resolveCurrentTeamKey(idc, cachedCur.deps);
      rCached2 = await teamsync.resolveCurrentTeamKey(idc, cachedCur.deps);
    } catch (e) { curErr = e; }

    check('teamsync: resolveCurrentTeamKey mints epoch 1 for a fresh team, sealed to every pinned member', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rFresh, { teamKey: 'RAW1', epoch: 1 });
      assert.strictEqual(fresh.calls.inserts.length, 1, 'one insert batch');
      assert.deepStrictEqual(fresh.calls.inserts[0].map(r => r.member_user_id).sort(), ['me', 'u-b'], 'sealed to both members');
      assert.ok(fresh.calls.inserts[0].every(r => r.epoch === 1), 'fresh team mints at epoch 1');
      assert.strictEqual(fresh.pinsBox.pins['u-b'].publicKey, 'PUB-B', 'TOFU pinned the teammate key');
    });

    check('teamsync: resolveCurrentTeamKey with my sealed row unseals it — no mint, no insert', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rHave, { teamKey: 'K1', epoch: 1 });
      assert.strictEqual(have.calls.gen, 0, 'must not generate');
      assert.strictEqual(have.calls.inserts.length, 0, 'must not insert');
    });

    check('teamsync: resolveCurrentTeamKey rotates to a new epoch when the current one is sealed to a removed member', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rRotate, { teamKey: 'RAW1', epoch: 2 });
      assert.strictEqual(rotate.calls.inserts.length, 1, 'one mint batch');
      assert.ok(rotate.calls.inserts[0].every(r => r.epoch === 2), 'rotation mints the NEXT epoch');
      assert.deepStrictEqual(rotate.calls.inserts[0].map(r => r.member_user_id).sort(), ['me', 'u-b'],
        'the removed member gets no sealed row at the new epoch');
    });

    check('teamsync: resolveCurrentTeamKey join-seals the current key to members missing at the current epoch', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rJoin, { teamKey: 'K1', epoch: 1 });
      assert.strictEqual(joinCase.calls.gen, 0, 'join is a seal of the EXISTING key, not a rotation');
      assert.strictEqual(joinCase.calls.inserts.length, 1, 'one join-seal insert');
      assert.deepStrictEqual(joinCase.calls.inserts[0],
        [{ team_id: 'team-cur', epoch: 1, member_user_id: 'u-b', sealed_team_key: 'S(K1->PUB-B)' }],
        'the joiner gets the current key sealed to their pinned pubkey');
    });

    check('teamsync: resolveCurrentTeamKey excludes a member whose fetched key contradicts the pin, and alerts', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rTofu, { teamKey: 'RAW1', epoch: 1 }, 'the mint itself proceeds for verified members');
      assert.deepStrictEqual(tofu.calls.inserts[0].map(r => r.member_user_id), ['me'], 'mismatched member NOT sealed to');
      assert.strictEqual(tofu.calls.alerts.length, 1, 'one alert');
      assert.strictEqual(tofu.calls.alerts[0].user_id, 'u-b');
      assert.strictEqual(tofu.calls.alerts[0].fetched, 'EVIL');
      assert.strictEqual(tofu.pinsBox.pins['u-b'].publicKey, 'PUB-B', 'pin survives the attack');
    });

    check('teamsync: resolveCurrentTeamKey losing a mint race adopts the winner\'s key via read-back', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rRace, { teamKey: 'WINNER', epoch: 1 },
        'the key that COUNTS is whatever my read-back row unseals to, never my candidate');
    });

    check('teamsync: resolveCurrentTeamKey with an epoch I am not sealed into waits (null) — no mint, fail closed', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.strictEqual(rWait, null, 'a teammate must join-seal me; minting would fork the team key');
      assert.strictEqual(wait.calls.gen, 0, 'must not mint over an existing epoch');
      assert.strictEqual(wait.calls.inserts.length, 0, 'must not insert');
    });

    check('teamsync: resolveCurrentTeamKey caches the resolution for the injected cache\'s lifetime', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rCached1, { teamKey: 'K1', epoch: 1 });
      assert.deepStrictEqual(rCached2, rCached1, 'second call returns the same resolution');
      assert.strictEqual(cachedCur.calls.rowFetches, 1, 'second call must be served from cache');
    });
  }

  // Encrypt-on-push (encryptRow + syncTeams wiring, plan Task 6 Part A).
  // encryptRow is pure and tested with REAL libsodium (already ready()'d
  // above — no keychain involved, so no machine side effects); the wiring's
  // fail-closed path runs the real syncTeams against a fresh mock backend
  // with injected unavailable crypto deps.
  {
    const tcReal = require('../../lib/teamcrypto');
    const pushRow = {
      project_id: 'p-1', author_id: 'u-1', author_name: 'Marco',
      ts: '2026-07-18T10:00:00.000Z', source: 'Claude Code', session: 's1',
      ask: 'redacted ask', goal: null, decisions: 'kept it', gotchas: null,
      files: ['src/a.js'], changes: null, summary: 'did the thing',
    };
    let encErr = null, encOff, encOn, encRound;
    try {
      encOff = teamsync.encryptRow(pushRow, null, 1, { teamcrypto: null });
      const teamKey = tcReal.genTeamKey();
      encOn = teamsync.encryptRow(pushRow, teamKey, 1, { teamcrypto: tcReal });
      encRound = tcReal.decrypt(encOn.ciphertext, encOn.nonce, teamKey);
    } catch (e) { encErr = e; }

    check('teamsync: encryptRow with no team key returns the row unchanged (flag-off byte-identical)', () => {
      assert.ok(!encErr, `encryptRow threw: ${encErr && encErr.message}`);
      assert.strictEqual(encOff, pushRow, 'flag-off must return the SAME row object, not a copy');
    });

    check('teamsync: encryptRow dual-writes — ciphertext/nonce/key_epoch added, plaintext intact, payload round-trips', () => {
      assert.ok(!encErr, `encryptRow threw: ${encErr && encErr.message}`);
      assert.ok(encOn.ciphertext && encOn.nonce, 'ciphertext/nonce missing');
      assert.strictEqual(encOn.key_epoch, 1);
      assert.strictEqual(encOn.ask, 'redacted ask', 'plaintext ask must still be present (dual-write)');
      assert.strictEqual(encOn.summary, 'did the thing', 'plaintext summary must still be present');
      assert.strictEqual(encOn.project_id, 'p-1', 'metadata must be untouched');
      assert.ok(!('ciphertext' in pushRow), 'input row must not be mutated');
      assert.deepStrictEqual(encRound, {
        ask: 'redacted ask', summary: 'did the thing', goal: null,
        decisions: 'kept it', gotchas: null, files: ['src/a.js'], changes: null,
      }, 'decrypting must return exactly the seven content fields');
    });

    // Cutover flag (E2E completion Task 5): plaintextOff strips every content
    // column — the row that crosses the wire is ciphertext + routing metadata
    // only, and the ciphertext still round-trips to the full payload.
    check('teamsync: encryptRow with plaintextOff ships ciphertext-only rows — content columns null, payload intact', () => {
      const teamKey = tcReal.genTeamKey();
      const off = teamsync.encryptRow(pushRow, teamKey, 2, { teamcrypto: tcReal, plaintextOff: true });
      for (const col of ['ask', 'goal', 'decisions', 'gotchas', 'summary', 'files', 'changes']) {
        assert.strictEqual(off[col], null, `${col} must be null under plaintextOff`);
      }
      assert.strictEqual(off.key_epoch, 2, 'epoch must ride along');
      assert.strictEqual(off.project_id, 'p-1', 'routing metadata must survive');
      assert.strictEqual(off.session, 's1', 'session id must survive for threading');
      const payload = tcReal.decrypt(off.ciphertext, off.nonce, teamKey);
      assert.strictEqual(payload.ask, 'redacted ask', 'payload must still carry the full content');
      assert.deepStrictEqual(payload.files, ['src/a.js'], 'files must live inside the ciphertext');
      assert.ok(!('ciphertext' in pushRow), 'input row must not be mutated');
    });

    // Cutover default: ciphertext-only is the DEFAULT once a team key exists —
    // dual-write survives only as the explicit rollback hatch
    // (`team.plaintextOff: false`). Guards the leak where every "encrypted"
    // row still carried readable content columns unless each machine
    // hand-set the flag.
    check('teamsync: plaintextOffFor defaults ON — only an explicit false re-enables dual-write', () => {
      assert.strictEqual(teamsync.plaintextOffFor({}), true, 'no team config → ciphertext-only');
      assert.strictEqual(teamsync.plaintextOffFor(null), true, 'null config → ciphertext-only');
      assert.strictEqual(teamsync.plaintextOffFor({ team: {} }), true, 'empty team config → ciphertext-only');
      assert.strictEqual(teamsync.plaintextOffFor({ team: { plaintextOff: true } }), true, 'explicit true stays on');
      assert.strictEqual(teamsync.plaintextOffFor({ team: { plaintextOff: false } }), false, 'explicit false is the only dual-write hatch');
    });

    // Fail-closed wiring: flag ON, crypto/keychain unavailable. The pass must
    // push today's plaintext rows, never throw — and must LOG the fallback,
    // which is what separates "the wiring engaged and failed closed" from
    // "the flag was silently ignored" (this is the assertion that fails
    // before the wiring exists).
    {
      const mockE = createMockSupabase();
      await new Promise(r => mockE.server.listen(P(52), '127.0.0.1', r));
      const savedEnvUrl = process.env.MEMBRIDGE_TEAM_URL;
      const savedEnvKey = process.env.MEMBRIDGE_TEAM_ANON_KEY;
      process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(52)}`;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
      const projE = path.join(ROOT, 'projects', 'encrypt-app');
      fs.mkdirSync(projE, { recursive: true });
      // Fail-closed (E2E completion Task 4): with encryption on (the DEFAULT
      // — this home sets no encrypt flag at all) and crypto unavailable,
      // NOTHING may leave in plaintext. The pass pauses, records why, and a
      // later pass with working crypto pushes the held entries encrypted.
      let syncErr = null, syncRes = null, syncRes2 = null, syncRes3 = null, syncRes4 = null, logDelta = '';
      let pushedWhileUnavailable = -1, pausedFlag = null, pausedFlag2 = null;
      let authFlag3 = null, authFlag4 = 'unset', pushedBeforeAuthFail = -1, pushedAfterAuthFail = -2;
      try {
        await teamsync.signup(util.getConfig(), 'enc@test.dev', 'pw-e', 'Enc');
        const teamE = await teamsync.createTeam(util.getConfig(), 'EncTeam');
        await teamsync.linkProject(util.getConfig(), projE, teamE.team_id, 'EncTeam');
        const st = util.loadState();
        st.projects[projE] = { events: [
          { ts: '2026-07-18T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'encrypt me maybe', session: 'e1' },
          { ts: '2026-07-18T10:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projE, 'src', 'x.js'), session: 'e1' },
        ] };
        util.saveState(st);
        const raw = util.loadUserConfig();
        if (raw.team) { delete raw.team.encrypt; util.saveUserConfig(raw); } // default-on is the point
        let logBefore = 0;
        try { logBefore = fs.statSync(util.logPath()).size; } catch {}
        syncRes = await teamsync.syncTeams({
          project: projE,
          cryptoDeps: {
            keychain: { available: () => false, load: () => null, store: () => false, remove: () => false },
            teamcrypto: { available: () => false },
            uploadPubkey: async () => { throw new Error('must not be called when unavailable'); },
          },
        });
        try { logDelta = fs.readFileSync(util.logPath(), 'utf8').slice(logBefore); } catch {}
        pushedWhileUnavailable = mockE.entries.length;
        pausedFlag = util.loadState().teamCryptoPaused || null;
        // Recovery pass: crypto works now (in-memory keychain, real libsodium).
        const kcMem = new Map();
        syncRes2 = await teamsync.syncTeams({
          project: projE,
          cryptoDeps: {
            keychain: { available: () => true, load: a => kcMem.get(a) || null, store: (a, s) => { kcMem.set(a, s); return true; }, remove: a => kcMem.delete(a) },
            teamcrypto: tcReal,
          },
        });
        pausedFlag2 = util.loadState().teamCryptoPaused || null;
        // The live wiring, not just the helper. A pass whose identity upload is
        // rejected with a dead JWT must leave the reason in the SAVED state:
        // syncTeams saves its own in-memory state copy at the end of the pass,
        // so a helper that wrote state independently would be clobbered by it.
        const kcAuth = { available: () => true, load: a => kcMem.get(a) || null, store: (a, s) => { kcMem.set(a, s); return true; }, remove: a => kcMem.delete(a) };
        pushedBeforeAuthFail = mockE.entries.length;
        syncRes3 = await teamsync.syncTeams({
          project: projE,
          cryptoDeps: {
            keychain: kcAuth,
            teamcrypto: tcReal,
            uploadPubkey: async () => { throw Object.assign(new Error('JWT expired'), { status: 401 }); },
          },
        });
        authFlag3 = util.loadState().teamAuthPaused || null;
        pushedAfterAuthFail = mockE.entries.length;
        // Recovery: the session is good again, so the header must stop warning.
        syncRes4 = await teamsync.syncTeams({ project: projE, cryptoDeps: { keychain: kcAuth, teamcrypto: tcReal } });
        authFlag4 = util.loadState().teamAuthPaused || null;
      } catch (e) { syncErr = e; } finally {
        const raw = util.loadUserConfig();
        raw.team = { ...(raw.team || {}), encrypt: false }; // restore the legacy-home hatch
        util.saveUserConfig(raw);
        process.env.MEMBRIDGE_TEAM_URL = savedEnvUrl;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = savedEnvKey;
        mockE.server.close();
      }
      check('teamsync: encrypted push (default-on) with unavailable crypto fails closed — nothing leaves, pass pauses and says why', () => {
        assert.ok(!syncErr, `syncTeams threw: ${syncErr && syncErr.message}`);
        assert.strictEqual(pushedWhileUnavailable, 0, 'fail-closed push must upload NOTHING without a key');
        assert.ok(pausedFlag, 'state.teamCryptoPaused must record the pause');
        assert.ok((syncRes.errors || []).some(e => /encryption|paused/i.test(e)),
          `pass must surface a paused error, got: ${JSON.stringify(syncRes && syncRes.errors)}`);
        assert.ok(/team encrypt/.test(logDelta), 'expected a logged "team encrypt" line naming the pause');
      });
      check('teamsync: held entries push encrypted on the next pass with working crypto, and the pause clears', () => {
        assert.ok(!syncErr, `syncTeams threw: ${syncErr && syncErr.message}`);
        assert.deepStrictEqual(syncRes2.errors, [], `recovery errors: ${JSON.stringify(syncRes2 && syncRes2.errors)}`);
        assert.ok(mockE.entries.length >= 1, 'recovery pass must push the held entries');
        assert.ok(mockE.entries.every(r => r.ciphertext && r.nonce && r.key_epoch === 1),
          'recovered rows must carry ciphertext/nonce/key_epoch');
        assert.strictEqual(pausedFlag2, null, 'teamCryptoPaused must clear after a successful pass');
      });
      check('teamsync: a pass with a dead session records the auth pause in SAVED state and pushes nothing', () => {
        assert.ok(!syncErr, `syncTeams threw: ${syncErr && syncErr.message}`);
        assert.ok(authFlag3, 'state.teamAuthPaused must survive the pass\'s own saveState');
        assert.strictEqual(authFlag3.reason, 'session-expired',
          'a 401 on the identity upload is a dead session, not a missing key store');
        assert.strictEqual(pushedAfterAuthFail, pushedBeforeAuthFail,
          'fail-closed must not change: a dead session pushes nothing');
      });
      check('teamsync: the auth pause clears on the next healthy pass', () => {
        assert.ok(!syncErr, `syncTeams threw: ${syncErr && syncErr.message}`);
        assert.strictEqual(authFlag4, null,
          'a recovered session must clear the header warning, or it goes stale and lies the other way');
      });
    }

    // ------------------------------------------------------------------
    // Surfacing a paused team session. The identity bootstrap is where an
    // expired JWT actually bites: it fails, team push pauses fail-closed
    // (correct), and until now the only trace was a line in membridge.log.
    // buildCryptoContext must record a reason the dashboard can act on, and
    // must tell a dead session (sign in — nothing resumes on its own) apart
    // from an unreachable backend (transient, not the user's fault).
    // ------------------------------------------------------------------
    check('teamsync: auth failures classify into "sign in" vs "transient", and nothing else does', () => {
      const c = teamsync.classifyAuthFailure;
      const withStatus = (msg, status) => Object.assign(new Error(msg), { status });
      assert.strictEqual(c(withStatus('JWT expired', 401)), 'session-expired', 'a 401 is a dead session');
      assert.strictEqual(c(new Error('JWT expired')), 'session-expired',
        'PostgREST puts the reason in the body and drops the status — the message alone must be enough');
      assert.strictEqual(c(new Error('Invalid Refresh Token: Refresh Token Not Found')), 'session-expired',
        'a rejected refresh token is the same dead session, reported by the auth endpoint');
      assert.strictEqual(c(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })), 'backend-unreachable');
      assert.strictEqual(c(new Error('fetch failed')), 'backend-unreachable',
        'undici reports a dead network as a bare "fetch failed"');
      assert.strictEqual(c(withStatus('internal server error', 500)), null,
        'a backend fault is neither — telling the user to sign in would be a lie');
      assert.strictEqual(c(withStatus('permission denied for table team_feed', 403)), null,
        'an RLS refusal is a membership problem, not an expired session');
      assert.strictEqual(c(null), null, 'a missing error must never be read as a dead session');
    });

    {
      const kcAuthMem = new Map();
      const kcAuth = {
        available: () => true,
        load: a => kcAuthMem.get(a) || null,
        store: (a, s) => { kcAuthMem.set(a, s); return true; },
        remove: a => kcAuthMem.delete(a),
      };
      const CFG = { team: {} };
      const CREDS = { userId: 'u-auth-1', accessToken: 'dead-token' };
      const throwing = err => ({ keychain: kcAuth, teamcrypto: tcReal, uploadPubkey: async () => { throw err; } });
      const dead = () => Object.assign(new Error('JWT expired'), { status: 401 });
      const st = { projects: {} };
      let ctxDead = 'unset', ctxNet = 'unset', ctxOk = 'unset';
      let pausedDead = null, pausedNet = null, pausedOk = 'unset', sinceKept = null, authErr = null;
      try {
        ctxDead = await teamsync.buildCryptoContext(CFG, CREDS, { state: st, cryptoDeps: throwing(dead()) });
        pausedDead = st.teamAuthPaused ? { ...st.teamAuthPaused } : null;
        // A pass that keeps failing must not keep resetting the clock — how
        // long the team has been getting nothing is the actionable part.
        st.teamAuthPaused = { reason: 'session-expired', detail: 'JWT expired', since: '2026-07-20T00:00:00.000Z' };
        await teamsync.buildCryptoContext(CFG, CREDS, { state: st, cryptoDeps: throwing(dead()) });
        sinceKept = st.teamAuthPaused && st.teamAuthPaused.since;

        ctxNet = await teamsync.buildCryptoContext(CFG, CREDS, {
          state: st,
          cryptoDeps: throwing(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })),
        });
        pausedNet = st.teamAuthPaused ? { ...st.teamAuthPaused } : null;

        ctxOk = await teamsync.buildCryptoContext(CFG, CREDS, {
          state: st,
          cryptoDeps: { keychain: kcAuth, teamcrypto: tcReal, uploadPubkey: async () => {} },
        });
        pausedOk = st.teamAuthPaused || null;
      } catch (e) { authErr = e; }

      check('teamsync: an expired session records a machine-readable pause and still fails closed', () => {
        assert.ok(!authErr, `buildCryptoContext threw: ${authErr && authErr.message}`);
        assert.strictEqual(ctxDead, null, 'fail-closed must not change — no context, no push');
        assert.ok(pausedDead, 'state.teamAuthPaused must record the pause');
        assert.strictEqual(pausedDead.reason, 'session-expired');
        assert.ok(/JWT expired/.test(pausedDead.detail || ''),
          'the underlying reason must survive for the tooltip and the log');
        assert.ok(!isNaN(Date.parse(pausedDead.since)), 'since must be a parseable timestamp');
      });
      check('teamsync: a repeated failure keeps the original "since" instead of restarting the clock', () => {
        assert.ok(!authErr, `buildCryptoContext threw: ${authErr && authErr.message}`);
        assert.strictEqual(sinceKept, '2026-07-20T00:00:00.000Z');
      });
      check('teamsync: an unreachable backend is recorded as transient, never as "sign in"', () => {
        assert.ok(!authErr, `buildCryptoContext threw: ${authErr && authErr.message}`);
        assert.strictEqual(ctxNet, null, 'still fail-closed');
        assert.ok(pausedNet, 'a transient failure is still worth recording');
        assert.strictEqual(pausedNet.reason, 'backend-unreachable',
          'a network blip must never tell the user to sign in');
      });
      check('teamsync: the next successful bootstrap clears the pause so it cannot go stale', () => {
        assert.ok(!authErr, `buildCryptoContext threw: ${authErr && authErr.message}`);
        assert.ok(ctxOk && ctxOk.identity, 'a working pass must return a real crypto context');
        assert.strictEqual(pausedOk, null, 'teamAuthPaused must be gone after a successful bootstrap');
      });
    }
  }

  // Decrypt-on-pull + full round trip (plan Task 6 Part B). Two real homes
  // against one mock backend: Alice mints the epoch key and pushes encrypted
  // (dual-write), Bob unseals with his own keypair and pulls. Keychains are
  // in-memory fakes (never the real macOS keychain); libsodium is real.
  // cryptoDeps injects ONLY { keychain, teamcrypto } — uploadPubkey must be
  // inherited from the real wiring (merge, not replace), which is itself part
  // of what these tests pin.
  {
    const tcE2E = require('../../lib/teamcrypto');
    const mkMemKeychain = () => {
      const m = new Map();
      return {
        available: () => true,
        load: a => m.get(a) || null,
        store: (a, s) => { m.set(a, s); return true; },
        remove: a => m.delete(a),
      };
    };
    const setTeamCfg = () => {
      util.ensureConfig();
      const raw = util.loadUserConfig();
      raw.team = { ...(raw.team || {}), sharePrompts: true, encrypt: true };
      util.saveUserConfig(raw);
    };
    const savedHome = process.env.MEMBRIDGE_HOME;
    const savedUrl2 = process.env.MEMBRIDGE_TEAM_URL;
    const savedKey2 = process.env.MEMBRIDGE_TEAM_ANON_KEY;
    const homeAlice = path.join(ROOT, 'home-e2ea');
    const homeBob = path.join(ROOT, 'home-e2eb');
    const projE2E = path.join(ROOT, 'projects', 'e2e-app');
    fs.mkdirSync(projE2E, { recursive: true });
    const kcAlice = mkMemKeychain();
    const kcBob = mkMemKeychain();
    const mockE2E = createMockSupabase();
    let e2eErr = null, resAlice = null, resBob = null, bobEntries = null, origRows = null;
    try {
      await new Promise(r => mockE2E.server.listen(P(53), '127.0.0.1', r));
      process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(53)}`;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

      // Alice: account, team, linked project.
      process.env.MEMBRIDGE_HOME = homeAlice;
      setTeamCfg();
      await teamsync.signup(util.getConfig(), 'alice-e2e@test.dev', 'pw-a', 'Alice');
      const teamE = await teamsync.createTeam(util.getConfig(), 'E2E');
      const linkE = await teamsync.linkProject(util.getConfig(), projE2E, teamE.team_id, 'E2E');

      // Bob joins and bootstraps his identity FIRST, so Alice's epoch-1 mint
      // seals to both members.
      process.env.MEMBRIDGE_HOME = homeBob;
      setTeamCfg();
      await teamsync.signup(util.getConfig(), 'bob-e2e@test.dev', 'pw-b', 'Bob');
      await teamsync.joinTeam(util.getConfig(), teamE.invite_code);
      await teamsync.syncTeams({ cryptoDeps: { keychain: kcBob, teamcrypto: tcE2E } });

      // Alice: plant a session and push encrypted.
      process.env.MEMBRIDGE_HOME = homeAlice;
      const stA = util.loadState();
      stA.projects[projE2E] = { events: [
        { ts: '2026-07-18T12:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'Ship the E2E slice token=sk-e2e-alice-999', session: 'e2e1' },
        { ts: '2026-07-18T12:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projE2E, 'src', 'core.js'), session: 'e2e1' },
        { ts: '2026-07-18T12:02:00.000Z', source: 'Claude Code', kind: 'summary', text: 'Shipped the slice end to end', session: 'e2e1', decisions: 'sealed-box model kept' },
      ] };
      util.saveState(stA);
      resAlice = await teamsync.syncTeams({ project: projE2E, cryptoDeps: { keychain: kcAlice, teamcrypto: tcE2E } });
      origRows = mockE2E.entries.map(e => ({ ...e }));

      // Inject fake plaintext into every stored content column: cutover rows
      // carry none, so anything readable server-side is server-controlled. A
      // correct pull recovers content from the CIPHERTEXT, so the injection
      // must never surface.
      for (const e of mockE2E.entries) {
        e.ask = 'TAMPERED ask'; e.summary = 'TAMPERED summary'; e.decisions = 'TAMPERED';
      }
      // Plus one plaintext-only row (no ciphertext): must pull through as-is.
      const alice = mockE2E.users.get('alice-e2e@test.dev');
      mockE2E.entries.push({
        project_id: linkE.projectId, author_id: alice.id, author_name: 'Alice',
        ts: '2026-07-18T12:30:00.000Z', source: 'Codex', session: 'plain1',
        ask: 'plain only row', goal: null, decisions: null, gotchas: null,
        summary: 'no cipher here', files: ['docs/x.md'], changes: null,
        created_at: new Date(Date.now() + 60000).toISOString(),
      });

      // Bob: pull and decrypt.
      process.env.MEMBRIDGE_HOME = homeBob;
      const stB = util.loadState();
      stB.projects[projE2E] = { events: [] };
      util.saveState(stB);
      resBob = await teamsync.syncTeams({ project: projE2E, cryptoDeps: { keychain: kcBob, teamcrypto: tcE2E } });
      bobEntries = (util.loadState().projects[projE2E] || {}).teamEntries || [];
    } catch (e) { e2eErr = e; } finally {
      process.env.MEMBRIDGE_HOME = savedHome;
      process.env.MEMBRIDGE_TEAM_URL = savedUrl2;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey2;
      mockE2E.server.close();
    }

    check('teamsync: flag-on push is ciphertext-only by default and seals the epoch key to every member', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      assert.deepStrictEqual(resAlice.errors, [], `alice sync errors: ${JSON.stringify(resAlice && resAlice.errors)}`);
      assert.ok(origRows.length >= 1, 'expected pushed rows');
      for (const r of origRows) {
        assert.ok(r.ciphertext && r.nonce && r.key_epoch === 1, 'pushed row missing ciphertext/nonce/key_epoch');
        assert.ok(!Buffer.from(r.ciphertext, 'base64').toString('latin1').includes('src/core.js'),
          'file path visible in ciphertext bytes');
        for (const col of ['ask', 'goal', 'decisions', 'gotchas', 'summary', 'files', 'changes']) {
          assert.strictEqual(r[col], null, `${col} must be null — ciphertext-only is the default, dual-write is opt-in`);
        }
      }
      assert.strictEqual(mockE2E.pubkeys.size, 2, 'both members must have uploaded pubkeys');
      assert.strictEqual(mockE2E.teamKeys.length, 2, 'epoch key must be sealed once to each member');
    });

    check('teamsync: pull decrypts ciphertext rows — tampered plaintext columns are ignored', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      assert.deepStrictEqual(resBob.errors, [], `bob sync errors: ${JSON.stringify(resBob && resBob.errors)}`);
      const enc = bobEntries.filter(e => e.session === 'e2e1');
      assert.ok(enc.length >= 1, `expected pulled encrypted-session entries, got ${JSON.stringify(bobEntries)}`);
      assert.ok(!JSON.stringify(enc).includes('TAMPERED'),
        'tampered plaintext surfaced — pull must take content from the ciphertext');
    });

    check('teamsync: pull keeps a plaintext-only row unchanged', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      const plain = bobEntries.find(e => e.session === 'plain1');
      assert.ok(plain, 'plaintext-only row missing from pull');
      assert.strictEqual(plain.ask, 'plain only row');
      assert.strictEqual(plain.summary, 'no cipher here');
      assert.deepStrictEqual(plain.files, ['docs/x.md']);
    });

    check('teamsync: round trip — Bob recovers exactly what Alice pushed, through the ciphertext', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      // The server rows carry no readable content (ciphertext-only default),
      // so the round-trip oracle is the content Alice PLANTED, not the rows.
      const got = bobEntries.find(e => e.session === 'e2e1' && e.summary);
      assert.ok(got, 'summary-bearing e2e1 entry missing from Bob\'s pull');
      assert.strictEqual(got.summary, 'Shipped the slice end to end', 'summary must round-trip through the ciphertext');
      assert.strictEqual(got.decisions, 'sealed-box model kept', 'decisions must round-trip through the ciphertext');
      assert.ok(Array.isArray(got.files) && got.files.some(f => String(f).includes('core.js')),
        'edited file must round-trip through the ciphertext');
      assert.ok(!JSON.stringify(bobEntries).includes('sk-e2e-alice-999'),
        'secret must have been redacted before encryption');
    });

    // Fail-closed pull (E2E completion Task 4): a ciphertext row that cannot
    // be decrypted must render OPAQUE — never its server-controlled plaintext
    // columns (a stripping/corrupting server would otherwise force a silent
    // downgrade). The explicit encrypt:false hatch restores the legacy
    // plaintext read for the same row.
    {
      const mockT = createMockSupabase();
      const homeD = path.join(ROOT, 'home-e2ed');
      const homeE = path.join(ROOT, 'home-e2ee');
      const projT = path.join(ROOT, 'projects', 'tamper-app');
      fs.mkdirSync(projT, { recursive: true });
      const kcDana = mkMemKeychain(), kcEve = mkMemKeychain();
      let tErr = null, eveEntriesClosed = null, eveEntriesHatch = null, resEveClosed = null, feedEve = null, feedEveStale = null;
      let fpEve = null, trustRes = null, pinsAfterTrust = null, danaId = null, danaNewPub = null;
      try {
        await new Promise(r => mockT.server.listen(P(55), '127.0.0.1', r));
        process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(55)}`;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

        process.env.MEMBRIDGE_HOME = homeD;
        setTeamCfg();
        await teamsync.signup(util.getConfig(), 'dana-e2e@test.dev', 'pw-d', 'Dana');
        const teamT = await teamsync.createTeam(util.getConfig(), 'TamperTeam');
        await teamsync.linkProject(util.getConfig(), projT, teamT.team_id, 'TamperTeam');

        process.env.MEMBRIDGE_HOME = homeE;
        setTeamCfg();
        await teamsync.signup(util.getConfig(), 'eve-e2e@test.dev', 'pw-v', 'Eve');
        await teamsync.joinTeam(util.getConfig(), teamT.invite_code);
        await teamsync.syncTeams({ cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });

        process.env.MEMBRIDGE_HOME = homeD;
        const stD = util.loadState();
        stD.projects[projT] = { events: [
          { ts: '2026-07-18T14:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'the real content', session: 't1' },
          { ts: '2026-07-18T14:01:00.000Z', source: 'Claude Code', kind: 'summary', text: 'real summary', session: 't1' },
        ] };
        util.saveState(stD);
        await teamsync.syncTeams({ project: projT, cryptoDeps: { keychain: kcDana, teamcrypto: tcE2E } });

        // The hostile server corrupts every ciphertext but leaves poisoned
        // plaintext columns in place.
        for (const e of mockT.entries) {
          if (e.ciphertext) e.ciphertext = Buffer.from('garbage-' + e.ciphertext).toString('base64');
          e.ask = 'POISONED ask';
          e.summary = 'POISONED summary';
        }

        process.env.MEMBRIDGE_HOME = homeE;
        const stE = util.loadState();
        stE.projects[projT] = { events: [] };
        util.saveState(stE);
        resEveClosed = await teamsync.syncTeams({ project: projT, cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });
        eveEntriesClosed = ((util.loadState().projects[projT] || {}).teamEntries || []).map(e => ({ ...e }));

        // Explicit hatch: encrypt:false rereads the same rows the legacy way.
        const rawE = util.loadUserConfig();
        rawE.team = { ...(rawE.team || {}), encrypt: false };
        util.saveUserConfig(rawE);
        const stE2 = util.loadState();
        stE2.projects[projT] = { events: [] }; // fresh pull cursor
        util.saveState(stE2);
        await teamsync.syncTeams({ project: projT });
        eveEntriesHatch = ((util.loadState().projects[projT] || {}).teamEntries || []).map(e => ({ ...e }));

        // Feed rewrite (E2E completion Task 6): the dashboard feed decrypts
        // locally through the same fail-closed path. Dana pushes a fresh
        // (uncorrupted) session, then Eve's feedPayload must decrypt it while
        // rendering the corrupted t1 rows opaque — POISONED never surfaces.
        process.env.MEMBRIDGE_HOME = homeD;
        const stD2 = util.loadState();
        stD2.projects[projT].events.push(
          { ts: '2026-07-18T15:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'fresh content after corruption', session: 't2' });
        util.saveState(stD2);
        await teamsync.syncTeams({ project: projT, cryptoDeps: { keychain: kcDana, teamcrypto: tcE2E } });

        process.env.MEMBRIDGE_HOME = homeE;
        const rawE2 = util.loadUserConfig();
        rawE2.team = { ...(rawE2.team || {}), encrypt: true };
        util.saveUserConfig(rawE2);
        feedEve = await feedPayload({ limit: 50, cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });

        // Same bug class as reshareSession (BUG 1 above), at the dashboard's
        // own call site: feedPayload read raw loadCredentials, which never
        // checks expiresAt, and handed that dead token to buildCryptoContext.
        // Identity bootstrap then failed with "JWT expired" and EVERY team row
        // rendered opaque — indistinguishable from tampering. Expire the stored
        // access token, keep the refresh token valid: the feed must refresh and
        // still decrypt.
        const savedCredsEve = JSON.parse(fs.readFileSync(teamsync.credentialsPath(), 'utf8'));
        fs.writeFileSync(teamsync.credentialsPath(), JSON.stringify({
          ...savedCredsEve, accessToken: 'expired-dead-token', expiresAt: Date.now() - 60000,
        }));
        feedEveStale = await feedPayload({ limit: 50, cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });

        // CLI surface (E2E completion Task 7): fingerprint report from Eve's
        // keychain + pins, then a deliberate trust re-pin after Dana rotates
        // her published key (the only path that ever replaces a pin).
        fpEve = await teamsync.fingerprintReport({ cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });
        danaId = mockT.users.get('dana-e2e@test.dev').id;
        danaNewPub = tcE2E.genKeypair().publicKey;
        mockT.pubkeys.set(danaId, danaNewPub);
        trustRes = await teamsync.trustMember(util.getConfig(), 'Dana', { cryptoDeps: { teamcrypto: tcE2E } });
        pinsAfterTrust = require('../../lib/teampins').load();
      } catch (e) { tErr = e; } finally {
        process.env.MEMBRIDGE_HOME = savedHome;
        process.env.MEMBRIDGE_TEAM_URL = savedUrl2;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey2;
        mockT.server.close();
      }

      check('teamsync: a ciphertext row that cannot decrypt renders opaque — plaintext columns never surface (fail-closed pull)', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.deepStrictEqual((resEveClosed || {}).errors, [], `eve sync errors: ${JSON.stringify(resEveClosed && resEveClosed.errors)}`);
        assert.ok(eveEntriesClosed.length >= 1, 'expected pulled entries');
        assert.ok(!JSON.stringify(eveEntriesClosed).includes('POISONED'),
          'server-controlled plaintext surfaced from an undecryptable ciphertext row');
        const t1 = eveEntriesClosed.filter(e => e.session === 't1');
        assert.ok(t1.length >= 1 && t1.every(e => e.undecryptable === true), 'row must be marked undecryptable');
        assert.ok(t1.every(e => e.ask == null && e.summary == null), 'content fields must be null on an undecryptable row');
      });

      check('teamsync: the explicit encrypt:false hatch restores the legacy plaintext read for the same rows', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(eveEntriesHatch.some(e => e.summary === 'POISONED summary'),
          'hatch pull must read the plaintext columns exactly as a legacy client would');
      });

      check('feed: feedPayload decrypts team rows locally — good rows readable, corrupted rows opaque, poisoned plaintext never surfaces', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(feedEve && Array.isArray(feedEve.entries), 'feedPayload must return entries');
        assert.ok(!JSON.stringify(feedEve.entries).includes('POISONED'),
          'poisoned plaintext surfaced in the feed');
        assert.ok(feedEve.entries.some(e => e.ask === 'fresh content after corruption'),
          `fresh encrypted row must decrypt in the feed, got: ${JSON.stringify(feedEve.entries.map(e => ({ ask: e.ask, undecryptable: e.undecryptable })))}`);
        assert.ok(feedEve.entries.some(e => e.undecryptable === true),
          'corrupted rows must carry the undecryptable marker through normalizeTeam');
      });

      check('feed: feedPayload refreshes a stale token instead of rendering every team row opaque', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(feedEveStale && Array.isArray(feedEveStale.entries), 'feedPayload must return entries with a stale stored token');
        assert.ok(feedEveStale.entries.some(e => e.ask === 'fresh content after corruption'),
          `a stale-but-refreshable token must refresh, not fail identity bootstrap and blank the feed, got: ${JSON.stringify(feedEveStale.entries.map(e => ({ ask: e.ask, undecryptable: e.undecryptable })))}`);
        assert.ok(!JSON.stringify(feedEveStale.entries).includes('POISONED'),
          'the refreshed feed must stay fail-closed on genuinely corrupted rows');
      });

      check('teamsync: fingerprintReport shows my key and every pinned teammate in the human-readable format', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(fpEve && fpEve.ok, `report failed: ${fpEve && fpEve.error}`);
        assert.match(fpEve.mine, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/, 'own fingerprint format');
        const dana = fpEve.members.find(m => m.name === 'Dana');
        assert.ok(dana, `Dana must be pinned, members: ${JSON.stringify(fpEve.members)}`);
        assert.match(dana.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/, 'teammate fingerprint format');
      });

      check('teamsync: trustMember re-pins a rotated key, reporting old and new fingerprints', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(trustRes && trustRes.ok, `trust failed: ${trustRes && trustRes.error}`);
        assert.strictEqual(trustRes.userId, danaId, 'display-name lookup must resolve to the user id');
        assert.ok(trustRes.previous && trustRes.current && trustRes.previous !== trustRes.current,
          'old and new fingerprints must both be reported and differ');
        assert.strictEqual(pinsAfterTrust[danaId].publicKey, danaNewPub,
          'the pin must now hold the rotated key');
      });
    }

    // Pre-migration backend (no 009 columns): under the ciphertext-only
    // DEFAULT the push must fail closed and hold entries — dropping the
    // ciphertext column would upload contentless rows. Only the explicit
    // dual-write hatch (plaintextOff: false) restores the legacy degrade:
    // drop the three new columns and land plaintext (PGRST204 retry).
    // Fresh mock + home.
    {
      const mockPre = createMockSupabase();
      mockPre.flags.rejectColumns.add('ciphertext');
      mockPre.flags.rejectColumns.add('nonce');
      mockPre.flags.rejectColumns.add('key_epoch');
      const homeCarol = path.join(ROOT, 'home-e2ec');
      const projPre = path.join(ROOT, 'projects', 'pre-app');
      fs.mkdirSync(projPre, { recursive: true });
      let preErr = null, resPre = null, resPreHatch = null, heldCount = -1, mintedAfterHold = -1;
      // ONE keychain for both passes: a fresh keychain on the second pass
      // would be a brand-new identity that cannot unseal the epoch-1 key.
      const kcCarol = mkMemKeychain();
      try {
        await new Promise(r => mockPre.server.listen(P(54), '127.0.0.1', r));
        process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(54)}`;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
        process.env.MEMBRIDGE_HOME = homeCarol;
        setTeamCfg();
        await teamsync.signup(util.getConfig(), 'carol-e2e@test.dev', 'pw-c', 'Carol');
        const teamP = await teamsync.createTeam(util.getConfig(), 'PreTeam');
        await teamsync.linkProject(util.getConfig(), projPre, teamP.team_id, 'PreTeam');
        const stC = util.loadState();
        stC.projects[projPre] = { events: [
          { ts: '2026-07-18T13:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'premigration push', session: 'pre1' },
        ] };
        util.saveState(stC);
        resPre = await teamsync.syncTeams({ project: projPre, cryptoDeps: { keychain: kcCarol, teamcrypto: tcE2E } });
        heldCount = mockPre.entries.length;
        mintedAfterHold = mockPre.teamKeys.length;
        // Explicit dual-write hatch: the ONLY way the old degrade path runs.
        const rawC = util.loadUserConfig();
        rawC.team = { ...(rawC.team || {}), plaintextOff: false };
        util.saveUserConfig(rawC);
        resPreHatch = await teamsync.syncTeams({ project: projPre, cryptoDeps: { keychain: kcCarol, teamcrypto: tcE2E } });
      } catch (e) { preErr = e; } finally {
        process.env.MEMBRIDGE_HOME = savedHome;
        process.env.MEMBRIDGE_TEAM_URL = savedUrl2;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey2;
        mockPre.server.close();
      }
      check('teamsync: 009-less backend under the ciphertext-only default — push fails closed and holds entries', () => {
        assert.ok(!preErr, `premigration scenario threw: ${preErr && preErr.message}`);
        assert.strictEqual(resPre.errors.length, 1, `expected exactly the held-entries error: ${JSON.stringify(resPre && resPre.errors)}`);
        assert.ok(/backend lacks the \w+ column required for ciphertext-only push/.test(resPre.errors[0]),
          `error must name the missing-column hold: ${resPre.errors[0]}`);
        assert.strictEqual(heldCount, 0, 'no row may land — a dropped ciphertext column would upload contentless rows');
        assert.strictEqual(mintedAfterHold, 1, 'the epoch mint itself must still succeed (team_keys has no flag)');
      });
      check('teamsync: 009-less backend with the explicit plaintextOff:false hatch — push drops ciphertext/nonce/key_epoch and lands plaintext', () => {
        assert.ok(!preErr, `premigration scenario threw: ${preErr && preErr.message}`);
        assert.deepStrictEqual(resPreHatch.errors, [], `hatch sync errors: ${JSON.stringify(resPreHatch && resPreHatch.errors)}`);
        assert.ok(mockPre.entries.length >= 1, 'expected the hatch push to land after dropping the new columns');
        for (const r of mockPre.entries) {
          assert.ok(!('ciphertext' in r) && !('nonce' in r) && !('key_epoch' in r),
            'new columns must have been dropped for the old backend');
        }
        assert.ok(mockPre.entries.some(e => /premigration push/.test(e.ask || '')), 'plaintext content missing');
      });
    }
  }
  check('redact: every default pattern removes the secret and emits a named marker', () => {
    for (const [name, input, secret] of cases) {
      const out = redactLib.redactDefault(input);
      assert.ok(!out.includes(secret), `${name}: secret survived -> ${out}`);
      assert.ok(out.includes(`[redacted:${name}]`), `${name}: marker missing -> ${out}`);
    }
    // Bearer/authorization consume the whole value, no leak.
    const auth = redactLib.redactDefault('Authorization: Bearer abcDEF123456ghijKLmn');
    assert.ok(!auth.includes('abcDEF123456ghijKLmn') && auth.includes('[redacted:authorization]'), `auth -> ${auth}`);
  });

  // NEAR-MISS CORPUS. The table above proves each pattern matches its own
  // happy-path sample, and the negatives below prove it does not over-match.
  // Neither catches the failure that actually leaks: a credential one
  // character off the shape the pattern was written for. Every line here was
  // verified to survive redaction unchanged before the fix that added it.
  check('redact: credential shapes one character off the happy path are still redacted', () => {
    const leaks = [
      // connection-uri listed six database schemes. https://user:pass@host is
      // the commonest credential-in-URL shape of all and was not among them.
      ['https creds', 'clone https://admin:hunter2@git.internal.example.com/repo.git', 'hunter2'],
      ['http creds', 'curl http://svc_user:S3cr3tPass@api.acme.com/v1/ping', 'S3cr3tPass'],
      ['ssh creds', 'rsync ssh://root:toorpass@10.0.0.5/vol', 'toorpass'],
      ['git creds', 'git://deploy:sekritpw@host/repo.git', 'sekritpw'],
      // bearer was /g where its sibling authorization is /gi. Lowercase
      // "bearer" is what appears in curl transcripts, logs and prose.
      ['lowercase bearer', 'retrying with bearer abc123def456ghi789', 'abc123def456ghi789'],
      ['uppercase BEARER', 'BEARER abc123def456ghi789', 'abc123def456ghi789'],
      // AWS issues ASIA (STS), ABIA and ACCA alongside AKIA. All are 20 chars,
      // which is below ENTROPY_MIN_LEN, so the backstop cannot catch them.
      ['AWS STS key', 'aws sts token id ASIAY34FZKBOKMUTVV7A', 'ASIAY34FZKBOKMUTVV7A'],
      // xoxc (browser session) and xoxd (cookie) are full-account credentials
      // and fell outside the [abeprs] class.
      ['slack xoxc', 'token xoxc-2216254567-2216-abcdefghijk-1234567890', 'xoxc-2216254567'],
      // secret-assignment required the name to be immediately followed by the
      // separator, so the JSON form -- which is what an agent's tool
      // arguments, an MCP config and a settings.json dump all look like --
      // sailed straight through while the shell/env form was caught.
      ['JSON password', '{"password": "hunter2"}', 'hunter2'],
      ['JSON api_key', '{"api_key": "acme-live-42"}', 'acme-live-42'],
      ['JSON token, no space', '"token":"shhh-dont-tell"', 'shhh-dont-tell'],
    ];
    for (const [name, input, secret] of leaks) {
      const out = redactLib.redactDefault(input);
      assert.ok(!out.includes(secret), `${name}: secret survived -> ${out}`);
    }
  });

  // The scheme and name widenings above must not start eating ordinary prose,
  // ordinary URLs, or the identifiers the negatives section already protects.
  check('redact: the widened URI schemes and quoted names do not over-match', () => {
    const survivors = [
      'see https://example.com/docs/getting-started for the walkthrough',
      'clone https://github.com/membridge/membridge.git and run npm ci',
      'the http://localhost:7799 dashboard shows the fleet',
      'email andrew@example.com about the ssh://host/vol mount',
      'ASIAN markets and ACCAdemic writing are ordinary words',
      'the tokenizer and passwordless flows are documented',
    ];
    for (const s of survivors) {
      assert.strictEqual(redactLib.redactDefault(s), s, `false positive on: ${s} -> ${redactLib.redactDefault(s)}`);
    }
  });

  // Live incident: a sign-in callback of the form
  // https://host/auth/cli?code=<uuid> reached memory with all 23 patterns
  // before this one already running. Nothing caught it -- no pattern named
  // `code`, the auth code has no prefix to shape-match, and the entropy
  // backstop exempts UUIDs by design (session ids must survive), so the one
  // layer that might have caught it was guaranteed not to.
  check('redact: a credential-bearing query parameter loses its value and keeps its name', () => {
    const url = `https://hub.membridge.ai/auth/cli?code=${AUTH_CODE}`;
    const out = redactLib.redactDefault(url);
    assert.ok(!out.includes(AUTH_CODE), `the auth code survived untouched -> ${out}`);
    assert.ok(out.includes('code=[redacted:url-credential-param]'), `param name lost -> ${out}`);
    assert.ok(out.startsWith('https://hub.membridge.ai/auth/cli?'), `URL shape destroyed -> ${out}`);

    // token=/access_token= already matched secret-assignment, but its value
    // class runs to the next SPACE, so it swallowed the rest of the query
    // string along with the secret. Stopping at & is the readability half of
    // this pattern and is asserted, not incidental.
    const multi = `open https://h/cb?state=abc&access_token=${AUTH_CODE}&expires_in=3600 now`;
    const outMulti = redactLib.redactDefault(multi);
    assert.ok(!outMulti.includes(AUTH_CODE), `access_token survived -> ${outMulti}`);
    assert.ok(outMulti.includes('access_token=[redacted:url-credential-param]'), `name lost -> ${outMulti}`);
    assert.ok(outMulti.includes('&expires_in=3600'), `redaction ate the rest of the query -> ${outMulti}`);

    const tok = redactLib.redactDefault(`GET /v1/me?token=${AUTH_CODE} 200`);
    assert.ok(!tok.includes(AUTH_CODE) && tok.includes('token=[redacted:'), `token= not handled -> ${tok}`);
  });

  // The negative half, and the reason the pattern is anchored to query
  // position with a length floor rather than matching a bare `code=`:
  // `code=` is common English in logs and shell prose, and a bare match would
  // shred it. Every line here is a shape the pattern must refuse.
  check('redact: ordinary code= prose and non-credential code= values are left alone', () => {
    const survivors = [
      // No ? or & in front: prose, not a query parameter.
      'the handler returns code=200 on success and code=404 when missing',
      'set exit code=1 in the wrapper script',
      'see the error code=INTERNAL in the log',
      // In query position but plainly not credentials: too short, or numeric.
      'GET /api/status?code=200',
      'https://example.com/docs?code=ref',
      'https://example.com/p?code=42&page=2',
      // Long, but all digits -- an id or a status, never a secret.
      'https://example.com/p?code=20000000&page=2',
    ];
    for (const s of survivors) {
      assert.strictEqual(redactLib.redactDefault(s), s, `false positive on: ${s} -> ${redactLib.redactDefault(s)}`);
    }
    // A parameter that merely ENDS in one of the names is not claimed here:
    // the anchor requires the name to start immediately after the ? or &.
    // csrf_token is still redacted, by the pre-existing secret-assignment
    // pattern -- the point of this assertion is that the marker keeps the
    // more accurate name rather than being relabelled as a URL credential.
    const csrf = redactLib.redactDefault('https://example.com/x?csrf_token=abcdefghij');
    assert.ok(!csrf.includes('url-credential-param'), `csrf_token wrongly claimed -> ${csrf}`);
  });

  // Negatives — as important as positives. None of these may be touched.
  check('redact: normal text, versions, paths, SHAs, UUIDs, identifiers survive untouched', () => {
    const survivors = [
      'The quick brown fox jumps over the lazy dog again and again.',
      'Upgrade express@4.18.2 and lodash@4.17.21 in package.json.',
      'See lib/adapters/claude-code.js and lib/redact.js for the wiring.',
      'Commit 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c reverted it cleanly.',
      'session 1f0e5d5d-1603-4ea6-8b41-832bf6d27195 kept running',
      'getUserAuthenticationTokenFromLocalCache is called on every request',
      'the config keys checkpointEvery and summaries.jsonl are documented',
      'a b c d camelCaseWord PascalCaseWord snake_case_word kebab-case-word',
      // FIX ROUND 1, FINDING 5 negative: the openai-key pattern now allows
      // internal dashes/underscores after 'sk-', so ordinary prose using
      // 'sk-' as a word fragment must still survive -- real sentences break
      // the run with spaces long before the 20-char floor the pattern needs.
      'We use sk-prefixed identifiers like sk-8 and sk-42 for test fixtures, not credentials.',
    ];
    for (const s of survivors) {
      assert.strictEqual(redactLib.redactDefault(s), s, `false positive on: ${s}`);
    }
  });
  check('redact: session-id UUIDs are never redacted (load-bearing for the hook)', () => {
    const uuid = '1f0e5d5d-1603-4ea6-8b41-832bf6d27195';
    assert.strictEqual(redactLib.redactDefault(uuid), uuid);
    assert.strictEqual(redactLib.redactDefault(`Resumed session ${uuid} after a crash`).includes(uuid), true);
  });
  check('redact: entropy catches a standalone token but not the same token in a URL path', () => {
    assert.ok(redactLib.redactDefault(`x ${ENTROPY_TOKEN} y`).includes('[redacted:high-entropy]'), 'standalone token not caught');
    // Pinned behavior: a high-entropy segment inside a plain URL path (no
    // embedded credentials) is treated as a path, not a secret, and survives.
    const url = `https://cdn.example.com/assets/${ENTROPY_TOKEN}/main.js`;
    assert.strictEqual(redactLib.redactDefault(url), url, `URL path token was redacted -> ${redactLib.redactDefault(url)}`);
    assert.ok(redactLib.entropy(ENTROPY_TOKEN) > 4.5, 'test token is not actually high-entropy');
  });
  check('redact: redactDefaults:false opts out; redactExtra is additive', () => {
    const off = digest.redactText(`key ${AWS_KEY}`, digest.compileRedactions({ redactDefaults: false }));
    assert.ok(off.includes(AWS_KEY), 'defaults not disabled by redactDefaults:false');
    const extra = digest.redactText('internal CODENAME-BLUEJAY ships', digest.compileRedactions({ redactDefaults: false, redactExtra: ['CODENAME-\\w+'] }));
    assert.ok(!extra.includes('CODENAME-BLUEJAY') && extra.includes('[redacted]'), `redactExtra not applied -> ${extra}`);
    // defaults + user patterns compose: both a built-in and an extra match.
    const both = digest.redactText(`${AWS_KEY} and CODENAME-BLUEJAY`, digest.compileRedactions({ redactExtra: ['CODENAME-\\w+'] }));
    assert.ok(!both.includes(AWS_KEY) && !both.includes('CODENAME-BLUEJAY'), `compose failed -> ${both}`);
  });

  // Performance: default regexes compile once per pass, not per event.
  check('redact: a 200-event render stays well under 200ms', () => {
    const events = [];
    for (let i = 0; i < 200; i++) {
      const ts = `2026-07-15T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
      if (i % 3 === 0) events.push({ ts, source: 'Claude Code', kind: 'prompt', text: `Do step ${i} with some ${AWS_KEY} and ${ENTROPY_TOKEN} inline`, session: `s${i % 7}` });
      else if (i % 3 === 1) events.push({ ts, source: 'Claude Code', kind: 'edit', file: path.join(ROOT, 'projects', 'perf', `f${i}.js`), session: `s${i % 7}` });
      else events.push({ ts, source: 'Distilled', kind: 'summary', text: `Finished step ${i}; rotated ${ANTHROPIC_KEY} along the way.`, session: `s${i % 7}` });
    }
    const cfg = util.getConfig();
    // Sample three times and assert the MINIMUM, not a single sample.
    //
    // This check failed once on a shared CI runner at 229ms against the 200ms
    // bound. It was not a regression: benchmarked directly, the same render
    // takes a median of 11ms at a70fd32 and 10ms at 802d366, with the cold
    // first run dropping from 48ms to 23ms across the same range. The bound
    // was never the problem; taking one sample on a contended runner was.
    //
    // The minimum is the right statistic here. A real slowdown raises the
    // floor, so sensitivity is exactly what it was. Scheduler noise only
    // inflates the slower samples, which the minimum discards. Widening the
    // bound was considered and rejected: that would have traded one flake for
    // a permanently weaker check.
    //
    // Second chapter (2026-08-04): on a machine saturated by several agent
    // sessions, ALL THREE wall-clock samples inflated together (402-512ms
    // best-of-3, same tree that renders in ~10ms quiet), so the minimum alone
    // cannot save a wall-clock measurement from sustained external load. The
    // clock is now process CPU time: the regression this check exists to
    // catch (per-event regex recompilation, an accidentally quadratic
    // redactText) burns THIS process's CPU directly, while a busy machine
    // steals wall-clock without charging this process. Bound and best-of-3
    // are unchanged, so sensitivity is exactly what it was.
    let ms = Infinity;
    let block = '';
    for (let run = 0; run < 3; run++) {
      const proj = { events: events.slice() };
      const c0 = process.cpuUsage();
      block = digest.renderBlock(path.join(ROOT, 'projects', 'perf'), proj, cfg, 'CLAUDE.md');
      memorydb.buildEntries(path.join(ROOT, 'projects', 'perf'), proj, cfg);
      const d = process.cpuUsage(c0);
      ms = Math.min(ms, (d.user + d.system) / 1000);
    }
    assert.ok(ms < 200, `200-event render took ${ms.toFixed(1)}ms of CPU time (best of 3)`);
    assert.ok(!block.includes(AWS_KEY) && !block.includes(ANTHROPIC_KEY), 'secret leaked into the perf render');
  });

  // End to end: secrets planted in a prompt, a distilled checkpoint, and a todo
  // item must be redacted in the block, memory.md, the copy digest, and a push.
  const projRed = path.join(ROOT, 'projects', 'redact-app');
  fs.mkdirSync(path.join(projRed, '.membridge'), { recursive: true });
  const redCDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-redact-app');
  fs.mkdirSync(redCDir, { recursive: true });
  fs.writeFileSync(path.join(redCDir, 'red1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: `Rotate the leaked GitHub token ${GH_TOKEN} immediately` }, cwd: projRed, timestamp: '2026-07-15T01:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
      { content: `Revoke Slack token ${SLACK_TOKEN} in the admin panel`, status: 'in_progress', activeForm: 'Revoking Slack token' },
      { content: 'Ship the rotation script', status: 'pending', activeForm: 'Shipping' },
    ] } }] }, cwd: projRed, timestamp: '2026-07-15T01:01:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projRed, 'rotate.js') } }] }, cwd: projRed, timestamp: '2026-07-15T01:02:00.000Z' },
  ]));
  fs.writeFileSync(path.join(projRed, '.membridge', 'summaries.jsonl'),
    JSON.stringify({ session: 'red1', ts: '2026-07-15T01:05:00.000Z', did: `Rotated everything: new key ${ANTHROPIC_KEY} and moved the DB to ${PG_URI}.` }) + '\n');
  syncOnce();

  const redBlock = () => read(path.join(projRed, 'CLAUDE.md'));
  const secretsGone = s => !s.includes(GH_TOKEN) && !s.includes(SLACK_TOKEN) && !s.includes(ANTHROPIC_KEY) && !s.includes('hunter2secret');
  check('redact: block redacts secrets from prompt and distilled checkpoint', () => {
    const b = redBlock();
    assert.ok(secretsGone(b), 'a secret survived into the block');
    assert.ok(b.includes('[redacted:github-token]'), 'github marker missing from Ask line');
    assert.ok(b.includes('[redacted:anthropic-key]'), 'anthropic marker missing from Result line');
    assert.ok(b.includes('[redacted:credentials]'), 'connection marker missing from Result line');
  });
  // Cloudflare credentials. Added from a live incident: a cfut_ token pasted
  // into an agent session went through every layer untouched — no prefix rule
  // matched it, and the entropy backstop skipped it. Anyone deploying Workers
  // or Pages from an agent will paste one eventually.
  //
  // The mid-sentence case is the one that matters: real pastes are prose ("here
  // is the cloudflare: cfut_..."), not bare tokens on their own line, and a
  // \b-anchored rule that only fires at a line start would pass this test while
  // failing every real leak.
  check('redact: a Cloudflare API token is redacted, alone and mid-sentence', () => {
    const CFUT = 'cfut_' + 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ012345';
    const compiled = digest.compileRedactions({});
    assert.ok(!digest.redactText(CFUT, compiled).includes(CFUT), 'bare token survived');
    const prose = `here is the cloudflare token: ${CFUT} — use it for the deploy`;
    const out = digest.redactText(prose, compiled);
    assert.ok(!out.includes(CFUT), 'token survived inside a sentence');
    assert.ok(out.includes('[redacted:cloudflare-token]'), 'expected a named marker');
    assert.ok(out.includes('use it for the deploy'), 'redaction ate surrounding prose');
  });
  check('redact: a Cloudflare Origin CA key is redacted', () => {
    const CAKEY = 'v1.0-' + 'aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const compiled = digest.compileRedactions({});
    const out = digest.redactText(`origin ca key ${CAKEY} rotated`, compiled);
    assert.ok(!out.includes(CAKEY), 'origin CA key survived');
    assert.ok(out.includes('[redacted:cloudflare-origin-ca]'), 'expected a named marker');
  });
  // Regression guard for the claim that started this: the Supabase service_role
  // key WAS already covered by the jwt rule. Pinned so a future narrowing of
  // that pattern cannot silently expose the single most dangerous credential in
  // the stack — service_role bypasses row-level security entirely.
  check('redact: a Supabase service_role JWT is redacted', () => {
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';
    const out = digest.redactText(`service role: ${JWT}`, digest.compileRedactions({}));
    assert.ok(!out.includes(JWT), 'service_role JWT survived');
    assert.ok(out.includes('[redacted:jwt]'), 'expected the jwt marker');
  });

  check('redact: memory.md and memory.json redact prompt, checkpoint, and todo item', () => {
    const mem = read(path.join(projRed, '.membridge', 'memory.md'));
    const db = read(path.join(projRed, '.membridge', 'memory.json'));
    assert.ok(secretsGone(mem) && secretsGone(db), 'a secret survived into the memory DB');
    assert.ok(mem.includes('[redacted:github-token]') && mem.includes('[redacted:anthropic-key]'), 'markers missing from memory.md');
    assert.ok(db.includes('[redacted:slack-token]'), 'todo item Slack token not redacted in memory.json');
  });
  check('redact: copy-for-AI digest redacts every planted secret', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === projRed.toLowerCase());
    const copy = memorydb.renderCopyText(projRed, state.projects[key], util.getConfig());
    assert.ok(secretsGone(copy), 'a secret survived into the copy digest');
    assert.ok(copy.includes('[redacted:github-token]') && copy.includes('[redacted:anthropic-key]'), 'markers missing from copy digest');
  });

  const mock5 = createMockSupabase();
  await new Promise(r => mock5.server.listen(P(49), '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${P(49)}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    await teamsync.signup(util.getConfig(), 'red@test.dev', 'pw-r', 'Red');
    const teamRed = await teamsync.createTeam(util.getConfig(), 'RedTeam');
    await teamsync.linkProject(util.getConfig(), projRed, teamRed.team_id, 'RedTeam');
    await teamsync.syncTeams({ project: projRed });
    check('redact: pushed entries carry only redacted markers, never a secret', () => {
      const body = JSON.stringify(mock5.entries);
      assert.ok(!body.includes(GH_TOKEN) && !body.includes(ANTHROPIC_KEY) && !body.includes('hunter2secret'), 'a secret reached the server');
      const row = mock5.entries.find(e => e.ask.includes('[redacted:github-token]'));
      assert.ok(row, 'pushed ask not redacted with a named marker');
      assert.ok(row.summary.includes('[redacted:anthropic-key]'), `pushed summary not redacted -> ${row.summary}`);
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock5.server.close(r));
  }

  await check('mock: merge-duplicates overwrites an existing row in place', async () => {
    const m = createMockSupabase();
    await new Promise(r => m.server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + m.server.address().port + '/rest/v1/';
    const uid = 'u1', pid = 'p1', tid = 't1';
    m.teams.set(tid, { id: tid, name: 'T', inviteCode: 'x' });
    m.projects.push({ id: pid, teamId: tid, name: 'proj', repoUrl: null });
    m.members.push({ teamId: tid, userId: uid, displayName: 'U', role: 'owner' });
    const token = 'at-merge-test'; m.sessions.set(token, uid);
    const row = { project_id: pid, author_id: uid, author_name: 'U', ts: '2026-01-01T00:00:00Z', source: 'Claude Code', session: 's1', ask: null };
    const post = (body, prefer) => fetch(base + 'memory_entries?on_conflict=project_id,author_id,ts,source', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Prefer: prefer }, body: JSON.stringify([body]),
    });
    await post(row, 'resolution=ignore-duplicates,return=minimal');
    await post({ ...row, ask: 'the shared prompt' }, 'resolution=ignore-duplicates,return=minimal'); // ignored (dup)
    assert.strictEqual(m.entries.filter(e => e.session === 's1')[0].ask, null, 'ignore-duplicates wrongly overwrote');
    await post({ ...row, ask: 'the shared prompt' }, 'resolution=merge-duplicates,return=minimal'); // overwrites
    assert.strictEqual(m.entries.filter(e => e.session === 's1')[0].ask, 'the shared prompt', 'merge-duplicates did not overwrite');
    m.server.close();
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
