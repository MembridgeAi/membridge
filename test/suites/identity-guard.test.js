'use strict';
// A machine that temporarily cannot reach its keychain must not destroy its
// own encryption identity.
//
// THE INCIDENT THIS PINS. `security find-generic-password` (macOS) and the
// DPAPI unprotect step (Windows) both exit non-zero for "no such item" AND
// for "the read itself failed" (locked keychain, no default keychain, no
// keychain session, a corrupt/undecryptable DPAPI file). Before this fix,
// lib/keychain.js's `load` collapsed both to `null`, and lib/teamsync.js's
// `ensureIdentity` read a null private key as "nothing here yet" and
// regenerated + overwrote it. On the day this was found, a process with no
// usable keychain session called ensureIdentity; the human's real keypair
// (created 2026-07-22) survived only because the SECOND step (`store`) also
// happened to fail. Had it succeeded, every team key sealed to the old
// identity would have become permanently unreadable, silently, on a daemon
// poll.
//
// THE FIX. `keychain.loadChecked` is tri-state: `{ value, indeterminate }`.
// `indeterminate: true` means "the read failed for a reason other than the
// item being absent" — never inferred from a null value alone. ensureIdentity
// now regenerates ONLY when both halves are read and come back determinately
// absent; an indeterminate read on either half returns null and touches
// nothing (no genKeypair, no store), and logs why so a machine that never
// establishes an identity is diagnosable from its own log.
//
// WHAT THESE CHECKS PIN, and why in this shape:
//
//   1. FIRST RUN MUST NOT REGRESS — a genuinely-absent pair still generates,
//      stores both halves, and uploads. This is the case the whole feature
//      exists to keep working; if this check goes red the fix is wrong.
//   2. THE DESTRUCTIVE CASE ITSELF — an existing pair, one half's read made
//      indeterminate: genKeypair and store must NEVER be called (asserted on
//      call counts, not the return value — the return value is null in both
//      the fixed and the broken code, so a return-only assertion would pass
//      against the bug). A log line records why.
//   3. THE HALF-MISSING SELF-HEAL SURVIVES — an interrupted first run (one
//      half present, the OTHER half genuinely, determinately absent) must
//      still regenerate. Without this case, "never regenerate on any
//      ambiguity" would have quietly become "never regenerate", a different
//      bug.
//   4. BACK-COMPAT WITH TWO-STATE FAKES — a `deps.keychain` that implements
//      only the old `load(account) -> string|null` (no `loadChecked`, the
//      shape every existing fake across redaction.test.js/run-tests.js uses)
//      must behave exactly as before: it structurally cannot express
//      "unreadable", so it is read as never indeterminate. redaction.test.js
//      itself, run unmodified alongside this suite, is the broader regression
//      check that this fallback did not disturb its ~15 keychain fakes.
//   5. THE REAL macOS CLASSIFIER — `security`'s exit status 44 is
//      errSecItemNotFound; anything else is indeterminate. Exercised via
//      `_setRunner` against a fake subprocess, never a real keychain.
//
// WHAT THIS CANNOT PROVE: the exact `security` exit code on every macOS
// version for every failure mode (locked keychain, no default keychain, a
// keychain daemon that is simply gone) — only that this machine's `security`
// reports 44 for absence (checked once, live, by a human before approving
// this ticket) and that the code treats "not 0 and not 44" as indeterminate,
// which covers all of those by construction rather than by enumeration. The
// Windows DPAPI classifier (winLoadChecked) has no darwin-runnable check here
// — see the platform branch below for what it needs and why it is not faked.
//
// Run directly, or via `node test/run.js identity-guard`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, skip } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');
const keychain = require('../../lib/keychain');

const PRIVKEY_ACCOUNT = 'membridge.box.privatekey';
const PUBKEY_ACCOUNT = 'membridge.box.publickey';

// Same injection convention as feed-pubkey-write.test.js and redaction.test.js's
// mkIdFakes: `deps.keychain` merges over the real deps at the call site, and
// tests exercise ensureIdentity entirely offline. `loadChecked` is the tri-state
// read; `indeterminateAccounts` lets a check say "this ONE slot is unreadable"
// without touching the other.
function mkFakes(opts = {}) {
  const stored = new Map(opts.preload || []);
  const indeterminate = new Set(opts.indeterminate || []);
  const calls = { store: [], upload: [], gen: 0, loadChecked: [] };
  return {
    stored, calls,
    deps: {
      keychain: {
        available: () => opts.keychainAvailable !== false,
        load: a => (stored.has(a) ? stored.get(a) : null),
        loadChecked: a => {
          calls.loadChecked.push(a);
          if (indeterminate.has(a)) return { value: null, indeterminate: true };
          return { value: stored.has(a) ? stored.get(a) : null, indeterminate: false };
        },
        store: (a, s) => { calls.store.push(a); stored.set(a, s); return true; },
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
}

// A two-state fake with NO loadChecked at all — the shape every existing
// fake across the rest of the suite uses. readKeySlot must fall back to
// treating its `load` as never indeterminate.
function mkTwoStateFakes(opts = {}) {
  const stored = new Map(opts.preload || []);
  const calls = { store: [], upload: [], gen: 0 };
  return {
    stored, calls,
    deps: {
      keychain: {
        available: () => true,
        load: a => (stored.has(a) ? stored.get(a) : null),
        store: (a, s) => { calls.store.push(a); stored.set(a, s); return true; },
        remove: a => stored.delete(a),
      },
      teamcrypto: {
        available: () => true,
        ready: async () => {},
        genKeypair: () => { calls.gen++; return { publicKey: 'PUB' + calls.gen, privateKey: 'PRIV' + calls.gen }; },
      },
      uploadPubkey: async row => { calls.upload.push(row); },
    },
  };
}

const readLog = () => { try { return fs.readFileSync(util.logPath(), 'utf8'); } catch { return ''; } };

async function main() {
  const creds = { userId: 'user-guard-1', accessToken: 'tok' };

  // --- 1. first run must not regress: a genuinely absent pair still generates ---
  {
    const f = mkFakes();
    const id = await teamsync.ensureIdentity(creds, f.deps);
    check('first run: a genuinely absent pair still generates, stores both halves, and uploads', () => {
      assert.deepStrictEqual(id, { publicKey: 'PUB1', privateKey: 'PRIV1' }, 'identity not returned');
      assert.strictEqual(f.calls.gen, 1, 'expected exactly one keypair generation');
      assert.deepStrictEqual(f.calls.store.sort(), [PRIVKEY_ACCOUNT, PUBKEY_ACCOUNT].sort(), 'both halves must be stored');
      assert.strictEqual(f.calls.upload.length, 1, 'the new pubkey must be uploaded');
      assert.strictEqual(f.calls.upload[0].public_key, 'PUB1');
    });
  }

  // --- 2. the destructive case itself: existing key, one read made indeterminate ---
  {
    const f = mkFakes({
      preload: [[PRIVKEY_ACCOUNT, 'REAL-PRIV'], [PUBKEY_ACCOUNT, 'REAL-PUB']],
      indeterminate: [PRIVKEY_ACCOUNT],
    });
    const logBefore = readLog().length;
    const id = await teamsync.ensureIdentity(creds, f.deps);
    const logDelta = readLog().slice(logBefore);
    check('destructive case: an indeterminate private-key read generates NOTHING and stores NOTHING', () => {
      // Asserted on call counts, not the return value: the return value is
      // null in both the fixed and the broken code, so a return-only
      // assertion would pass against the bug this exists to catch.
      assert.strictEqual(f.calls.gen, 0, 'genKeypair must never be called on an indeterminate read');
      assert.strictEqual(f.calls.store.length, 0, 'store must never be called on an indeterminate read');
      assert.strictEqual(f.calls.upload.length, 0, 'nothing should be uploaded either');
      assert.strictEqual(id, null, 'ensureIdentity must report null when it cannot establish identity');
      // The existing key must survive untouched in the fake store, exactly as
      // the human's real key survived the live incident (there, only because
      // `store` also happened to fail — here, because it is never called).
      assert.strictEqual(f.stored.get(PRIVKEY_ACCOUNT), 'REAL-PRIV', 'the existing private key must be untouched');
      assert.strictEqual(f.stored.get(PUBKEY_ACCOUNT), 'REAL-PUB', 'the existing public key must be untouched');
    });
    check('destructive case: the indeterminate read is logged, so a stuck machine is diagnosable', () => {
      assert.ok(logDelta.includes(PRIVKEY_ACCOUNT), `expected the account name in the log, got: ${JSON.stringify(logDelta)}`);
      assert.ok(/indeterminate/i.test(logDelta), 'the log line must say the read was indeterminate, not just fail silently');
    });
  }

  // --- 3. pub-side indeterminate: covers the second read site independently ---
  {
    const f = mkFakes({
      preload: [[PRIVKEY_ACCOUNT, 'REAL-PRIV'], [PUBKEY_ACCOUNT, 'REAL-PUB']],
      indeterminate: [PUBKEY_ACCOUNT],
    });
    const id = await teamsync.ensureIdentity(creds, f.deps);
    check('destructive case (pub half): an indeterminate public-key read also generates and stores nothing', () => {
      assert.strictEqual(f.calls.gen, 0, 'genKeypair must never be called');
      assert.strictEqual(f.calls.store.length, 0, 'store must never be called');
      assert.strictEqual(id, null);
      // The private-key read itself must still have happened (found, not
      // indeterminate) — this proves the null came from the pub-side check,
      // not from some unrelated early return.
      assert.ok(f.calls.loadChecked.includes(PRIVKEY_ACCOUNT), 'private key must have been read first');
      assert.ok(f.calls.loadChecked.includes(PUBKEY_ACCOUNT), 'public key read must have been attempted');
    });
  }

  // --- 4. half-missing self-heal survives: interrupted first run, both reads determinate ---
  {
    const f = mkFakes({ preload: [[PRIVKEY_ACCOUNT, 'ORPHAN-PRIV']] });
    const id = await teamsync.ensureIdentity(creds, f.deps);
    check('half-missing pair (both reads determinate) still self-heals by regenerating', () => {
      assert.deepStrictEqual(id, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(f.calls.gen, 1, 'an orphaned half must still trigger regeneration when nothing was indeterminate');
      assert.strictEqual(f.stored.get(PRIVKEY_ACCOUNT), 'PRIV1', 'the orphaned private key must be replaced');
      assert.strictEqual(f.calls.upload.length, 1);
    });
  }

  // --- 5. back-compat: a two-state fake (no loadChecked) behaves exactly as before ---
  {
    const first = mkTwoStateFakes();
    const id1 = await teamsync.ensureIdentity(creds, first.deps);
    const id2 = await teamsync.ensureIdentity(creds, first.deps);
    check('a keychain dep with only `load` (no loadChecked) reads as never indeterminate — unchanged behaviour', () => {
      assert.deepStrictEqual(id1, { publicKey: 'PUB1', privateKey: 'PRIV1' }, 'first call must still generate');
      assert.strictEqual(first.calls.gen, 1);
      assert.deepStrictEqual(id2, { publicKey: 'PUB1', privateKey: 'PRIV1' }, 'second call must reuse, not regenerate');
      assert.strictEqual(first.calls.gen, 1, 'second call must not regenerate');
    });
  }

  // --- 6. the real macOS classifier: security's exit code, via _setRunner, never a real keychain ---
  if (process.platform === 'darwin') {
    const fakeRunner = findStatus => (args) => {
      if (args[0] === 'help') return { status: 0, error: null };
      if (args[0] === 'find-generic-password') {
        if (findStatus === 0) return { status: 0, stdout: 'FAKE-SECRET-VALUE\n' };
        return { status: findStatus, stdout: '' };
      }
      return { status: 1, stdout: '' };
    };

    check('keychain: loadChecked on a found item reports the value, indeterminate:false', () => {
      const prev = keychain._setRunner(fakeRunner(0));
      try {
        assert.deepStrictEqual(keychain.loadChecked('membridge.guard.found'),
          { value: 'FAKE-SECRET-VALUE', indeterminate: false });
      } finally { keychain._setRunner(prev); }
    });

    check('keychain: loadChecked on exit status 44 (errSecItemNotFound) reports genuinely absent', () => {
      const prev = keychain._setRunner(fakeRunner(44));
      try {
        assert.deepStrictEqual(keychain.loadChecked('membridge.guard.absent'),
          { value: null, indeterminate: false });
      } finally { keychain._setRunner(prev); }
    });

    check('keychain: loadChecked on any OTHER non-zero status reports indeterminate, not absent', () => {
      // 1 stands in for "some failure that is not itemNotFound" — a locked
      // keychain, no default keychain, or any status this code has not
      // specifically been taught means absence. The fix's whole point is
      // that an unenumerated status must default to indeterminate.
      for (const status of [1, 25, 36]) {
        const prev = keychain._setRunner(fakeRunner(status));
        try {
          assert.deepStrictEqual(keychain.loadChecked(`membridge.guard.err.${status}`),
            { value: null, indeterminate: true }, `status ${status} must be indeterminate, not absent`);
        } finally { keychain._setRunner(prev); }
      }
    });

    check('keychain: loadChecked on a spawn error (no exit status at all) reports indeterminate', () => {
      const prev = keychain._setRunner(() => ({ status: null, error: new Error('ENOENT'), stdout: '' }));
      try {
        assert.deepStrictEqual(keychain.loadChecked('membridge.guard.spawnerr'),
          { value: null, indeterminate: true });
      } finally { keychain._setRunner(prev); }
    });
  } else {
    skip('keychain: real macOS exit-code classification (44 vs other)',
      'needs the darwin CI leg; _setRunner only exists on the `security`-backed mac path');
  }

  // --- 7. the real Windows classifier: file-exists is real, DPAPI unprotect is not ---
  //
  // Unlike macOS there is no `_setRunner` seam for the Windows backend (the
  // ticket names only the mac runner and the ensureIdentity deps injection as
  // existing seams), so this exercises winLoadChecked against the REAL DPAPI
  // stack rather than a fake subprocess — exactly like redaction.test.js's
  // existing win32 DPAPI round-trip check. This is still never the macOS
  // keychain and never anything outside this test's own isolated
  // MEMBRIDGE_HOME/keys directory: DPAPI's ciphertext file lives entirely
  // under the throwaway temp home the harness set up above.
  if (process.platform === 'win32') {
    check('keychain(win): loadChecked reports genuinely absent when no keyfile exists', () => {
      assert.ok(keychain.available(), 'DPAPI must be available on win32 CI');
      const res = keychain.loadChecked('membridge.guard.win.absent.' + Date.now());
      assert.deepStrictEqual(res, { value: null, indeterminate: false });
    });
    check('keychain(win): loadChecked reports indeterminate when the keyfile exists but cannot be unprotected', () => {
      const acct = 'membridge.guard.win.corrupt.' + Date.now();
      assert.ok(keychain.store(acct, 'REAL-VALUE'), 'seed store failed');
      // keyFile() is not exported; account names used in this suite contain
      // only [A-Za-z0-9._-], which lib/keychain.js's sanitizer passes through
      // unchanged, so this reproduces the same path winLoadChecked reads.
      const keyPath = path.join(process.env.MEMBRIDGE_HOME, 'keys', acct + '.dpapi');
      fs.writeFileSync(keyPath, 'not-valid-base64-dpapi-ciphertext');
      const res = keychain.loadChecked(acct);
      assert.strictEqual(res.value, null);
      assert.strictEqual(res.indeterminate, true, 'a keyfile DPAPI cannot unprotect must be indeterminate, not absent');
    });
  } else {
    skip('keychain(win): real DPAPI file-exists-but-unreadable classification',
      'not win32; needs the Windows CI leg (.github/workflows/windows.yml)');
  }

  // --- 8. the unavailable-platform backend cannot reach the destructive path ---
  //
  // No fake needed: ensureIdentity's own first line is
  // `if (!teamcrypto.available() || !keychain.available()) return null`,
  // which already exits before any read. This check pins that guard rather
  // than exercising a fourth backend.
  {
    const f = mkFakes({ keychainAvailable: false, preload: [[PRIVKEY_ACCOUNT, 'REAL-PRIV'], [PUBKEY_ACCOUNT, 'REAL-PUB']] });
    const id = await teamsync.ensureIdentity(creds, f.deps);
    check('an unavailable keychain (CI/Linux fallback, or any platform mid-outage) never reaches loadChecked at all', () => {
      assert.strictEqual(id, null);
      assert.strictEqual(f.calls.loadChecked.length, 0, 'the availability gate must short-circuit before any read');
      assert.strictEqual(f.calls.gen, 0);
      assert.strictEqual(f.calls.store.length, 0);
    });
  }

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
