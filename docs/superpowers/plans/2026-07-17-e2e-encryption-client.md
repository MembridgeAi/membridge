# E2E Encryption — Client Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt the seven content fields client-side with a libsodium shared-team-key before they reach Supabase, and decrypt on pull — behind `config.team.encrypt` (default off), dual-writing plaintext so nothing breaks until the coordinated cutover.

**Architecture:** Two new pure-ish modules — `lib/teamcrypto.js` (libsodium primitives) and `lib/keychain.js` (macOS `security` CLI for the private key) — plus additive changes to `lib/teamsync.js` `pushProject`/`pullProject` gated on the flag, and an additive Supabase migration. Storage stays dual (plaintext + ciphertext); the guarantee only lands at the later cutover (out of scope). The flag OFF path is byte-identical to today.

**Tech Stack:** Node.js (CommonJS). New dependency: `libsodium-wrappers` (crypto is core, not optional — unlike the lazy MCP deps, but still guarded so a missing dep no-ops rather than crashes). macOS `security` CLI for the keychain (zero extra deps). Test harness: `test/run-tests.js` (`check(name, fn)`, `npm test`), offline only — no live Supabase.

**Locked decisions (from the approved spec, do not relitigate):**
- libsodium sealed-box + shared-team-key model; private key in the macOS keychain, never uploaded.
- Encrypt **file paths** into the payload (all seven content fields go inside the ciphertext).
- `config.team.encrypt` default **false**; dual-write plaintext + ciphertext; no cutover in this slice.
- Server-trusting pubkey fetch is a **known, flagged MITM hole** — real key management (TOFU/safety numbers/rotation) and a cryptographer review are separate, required, and gate any public security claim.

---

## Data contracts

**Content payload** (the encrypted object): `{ ask, summary, goal, decisions, gotchas, files, changes }` — the exact seven fields `pushProject` sends today, already redacted/clipped by the existing pipeline. Serialized to JSON, then `secretbox`-encrypted.

**Row additions** (all nullable, additive): `ciphertext` (bytea/base64), `nonce` (bytea/base64), `key_epoch` (int). Existing plaintext columns unchanged and still written while the flag is on.

**`member_pubkeys`**: `(user_id uuid, public_key text, created_at timestamptz)`, one row per member.

**`team_keys`**: `(team_id uuid, epoch int, member_user_id uuid, sealed_team_key text, created_at timestamptz)` — the epoch's team key sealed to each member.

**`lib/teamcrypto.js` API** (all base64 strings across the boundary):
- `ready()` → resolves when libsodium is loaded; `available()` → bool.
- `genKeypair()` → `{ publicKey, privateKey }`.
- `genTeamKey()` → `teamKey` (secretbox key).
- `sealTeamKey(teamKey, recipientPublicKey)` → `sealed`.
- `unsealTeamKey(sealed, myPublicKey, myPrivateKey)` → `teamKey | null`.
- `encrypt(payloadObj, teamKey)` → `{ ciphertext, nonce }`.
- `decrypt(ciphertext, nonce, teamKey)` → `payloadObj | null`.

**`lib/keychain.js` API:** `available()` → bool (darwin + `security` present); `store(account, secret)`, `load(account)` → `string | null`, `remove(account)`. Account key e.g. `membridge.box.privatekey`.

---

## File structure

- **Create** `lib/teamcrypto.js` — libsodium primitives (~90 lines).
- **Create** `lib/keychain.js` — macOS `security` wrapper (~50 lines).
- **Create** `supabase/migrations/009_e2e_encryption.sql` — additive tables + columns.
- **Modify** `lib/teamsync.js` — identity bootstrap, team-key fetch/seal/unseal, encrypt-on-push / decrypt-on-pull behind the flag.
- **Modify** `package.json` — add `libsodium-wrappers`.
- **Modify** `test/run-tests.js` — new `check(...)` blocks per task.

---

## Task 1: `lib/teamcrypto.js` — crypto primitives

**Files:** Create `lib/teamcrypto.js`; add dep to `package.json`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** — round trip, wrong-key, nonce-uniqueness, files-inside-ciphertext:
```js
const tc = require('../lib/teamcrypto');
check('teamcrypto: seal/unseal + secretbox round trip', async () => {
  await tc.ready();
  const a = tc.genKeypair(), b = tc.genKeypair();
  const teamKey = tc.genTeamKey();
  const sealed = tc.sealTeamKey(teamKey, b.publicKey);
  assert.strictEqual(tc.unsealTeamKey(sealed, b.publicKey, b.privateKey), teamKey);
  const payload = { ask: 'q', summary: 's', goal: null, decisions: null, gotchas: null, files: ['src/a.js'], changes: null };
  const { ciphertext, nonce } = tc.encrypt(payload, teamKey);
  assert.deepStrictEqual(tc.decrypt(ciphertext, nonce, teamKey), payload);
  // wrong recipient key can't unseal
  assert.strictEqual(tc.unsealTeamKey(sealed, a.publicKey, a.privateKey), null);
  // file path is not present in the ciphertext bytes
  assert.ok(!Buffer.from(ciphertext, 'base64').toString('latin1').includes('src/a.js'));
  // fresh nonce each call
  assert.notStrictEqual(tc.encrypt(payload, teamKey).ciphertext, ciphertext);
});
```
(If the harness's `check` is sync-only, wrap the async body per the existing async-test convention — search `await` in `test/run-tests.js` and match it.)

- [ ] **Step 2: Run to verify it fails** — `npm test 2>&1 | grep teamcrypto` → FAIL (module missing).
- [ ] **Step 3: Implement** `lib/teamcrypto.js` over `libsodium-wrappers`: lazy `require` guarded so a missing dep sets `available()=false` and every op throws a clear "encryption unavailable" that callers catch. Use `crypto_box_keypair`, `crypto_box_seal`/`_seal_open`, `crypto_secretbox_easy`/`_open_easy` with `randombytes_buf` nonces; base64 at the boundary. Add `"libsodium-wrappers": "^0.7"` to `package.json` dependencies.
- [ ] **Step 4: Run to verify it passes** — `npm test 2>&1 | grep teamcrypto` → ok; then full `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(crypto): teamcrypto — libsodium sealed-box + secretbox primitives"`

---

## Task 2: `lib/keychain.js` — private key in the macOS keychain

**Files:** Create `lib/keychain.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing test** (darwin-only; skip elsewhere so CI stays green):
```js
const keychain = require('../lib/keychain');
check('keychain: store/load/remove round trip (darwin only)', () => {
  if (!keychain.available()) return; // non-macOS or no `security`: skip, not fail
  const acct = 'membridge.test.' + Date.now();
  keychain.store(acct, 'SECRET');
  assert.strictEqual(keychain.load(acct), 'SECRET');
  keychain.remove(acct);
  assert.strictEqual(keychain.load(acct), null);
});
```
- [ ] **Step 2: Run to verify it fails** — module missing.
- [ ] **Step 3: Implement** with `spawnSync('security', …)`: `available()` = `process.platform === 'darwin'` && a `security` probe succeeds; `store` = `add-generic-password -U -a <acct> -s membridge -w <secret>`; `load` = `find-generic-password -a <acct> -s membridge -w` (null on non-zero exit); `remove` = `delete-generic-password`. Never echo the secret to logs.
- [ ] **Step 4: Run to verify it passes** — on macOS it round-trips; on CI it skips. Full `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(crypto): keychain — macOS security-CLI private key storage"`

---

## Task 3: additive Supabase migration

**Files:** Create `supabase/migrations/009_e2e_encryption.sql`.

- [ ] **Step 1** Write the migration: `create table if not exists member_pubkeys (...)` and `team_keys (...)` per the data contracts, plus `alter table memory_entries add column if not exists ciphertext text, add column if not exists nonce text, add column if not exists key_epoch int;`. Add RLS policies mirroring `memory_entries`/team membership (read your team's pubkeys and your own sealed keys). Additive only — drop nothing.
- [ ] **Step 2** Note in the migration header: **apply to the live Supabase before shipping any client with the flag on** (same deploy-gate discipline as `007_memory_ask_nullable.sql`); tests use the mock and won't catch a missing live migration.
- [ ] **Step 3: Commit** — `git commit -m "feat(db): additive E2E columns + member_pubkeys/team_keys (009)"`

(No unit test — schema. Verified by the push/pull offline tests using a mock that accepts the columns, and by a manual live-apply on staging.)

---

## Task 4: identity bootstrap — ensure keypair, upload public key

**Files:** Modify `lib/teamsync.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing test** — a pure `ensureIdentity(creds, deps)` helper (inject keychain + teamcrypto + an uploader so it's offline-testable): first call generates a keypair, stores the private key via the injected keychain, and calls the uploader once with `{ user_id, public_key }`; second call reuses the stored key and does not re-upload.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `ensureIdentity` in `teamsync.js`: if `keychain.load('membridge.box.privatekey')` is null, `genKeypair`, store the private key, upload the public key to `member_pubkeys` (upsert on `user_id`). Return `{ publicKey, privateKey }`. Guard on `teamcrypto.available() && keychain.available()` — otherwise return null and callers skip encryption (fail-closed).
- [ ] **Step 4: Run to verify it passes; full `npm test`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(crypto): ensureIdentity — keypair bootstrap + pubkey upload"`

---

## Task 5: team-key handling — create/seal epoch-1, unseal

**Files:** Modify `lib/teamsync.js`; Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing test** — a pure `resolveTeamKey(identity, epoch, deps)` (inject a fake `team_keys` store + member pubkey list): when no sealed key exists for me, it generates a team key, seals it to every member pubkey, writes one `team_keys` row per member, and returns the raw key; when my sealed row exists, it unseals and returns the same key. Two members ⇒ two sealed rows.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `resolveTeamKey`: fetch my sealed row for the epoch; if present, `unsealTeamKey`; else `genTeamKey`, fetch member pubkeys, `sealTeamKey` to each, insert rows, return the key. Cache per epoch in memory for the sync run. (Rotation on membership change is deferred — new-epoch minting is step 4 of the E2E spec.)
- [ ] **Step 4: Run to verify it passes; full `npm test`.**
- [ ] **Step 5: Commit** — `git commit -m "feat(crypto): resolveTeamKey — epoch team key seal/unseal"`

---

## Task 6: wire push/pull behind `config.team.encrypt`

**Files:** Modify `lib/teamsync.js` (`pushProject`, `pullProject`); Test `test/run-tests.js`.

- [ ] **Step 1: Write the failing tests** (offline, build the row objects without a network POST — refactor the row-building into a pure `encryptRow(row, teamKey, deps)` the test can call directly):
  - flag off ⇒ row is byte-identical to today (no `ciphertext`/`nonce`/`key_epoch` keys).
  - flag on ⇒ row has `ciphertext`+`nonce`+`key_epoch` AND still the plaintext fields (dual-write); decrypting the ciphertext with the team key yields the seven original fields.
  - pull: a row WITH ciphertext decrypts to the original content (plaintext fields on that row ignored); a row WITHOUT ciphertext uses plaintext unchanged.
  - fail-closed: `teamcrypto.available()===false` (or keychain unavailable) ⇒ flag-on push still emits today's plaintext row and never throws.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** — read `config.team.encrypt === true`. On push, when on and identity+team key resolve, compute `{ciphertext,nonce}` from the seven fields and add them plus `key_epoch` to each row (keep plaintext). On pull, add the three columns to the select (join them to `OPTIONAL_PULL_COLUMNS` so a pre-migration backend still degrades); for each row, if `ciphertext` present, `resolveTeamKey`+`decrypt` and overwrite the content fields from the payload, else keep plaintext. Every crypto call in a try/catch that falls back to plaintext and logs once — sync must never fail on a crypto error.
- [ ] **Step 4: Run to verify they pass; full `npm test` (275+ green).**
- [ ] **Step 5: Commit** — `git commit -m "feat(crypto): encrypt push / decrypt pull behind team.encrypt flag (dual-write)"`

---

## Self-review

- **Spec coverage:** keypair+keychain → Tasks 1,2,4; team key seal/unseal → Tasks 1,5; encrypted push/pull dual-write behind flag → Task 6; additive schema → Task 3; encrypt file paths → payload includes `files` (Task 1 test asserts it's inside the ciphertext); fail-closed + non-macOS + missing-dep degrades → Tasks 1,2,6 error paths.
- **Contract stability:** flag-off path unchanged (Task 6 first test pins byte-identity); new columns join the existing drop-missing-column machinery so a pre-migration backend never breaks.
- **Delegated:** the async-`check` wrapping and the exact keychain/`security` invocation are aligned to existing harness/OS conventions (flagged in Tasks 1,2); all crypto logic and assertions are concrete here.
- **Explicitly NOT done (must precede any security claim):** Marco's feed rewrite, TOFU/safety-number key verification, private-key passphrase wrap, key rotation, and the cryptographer review. The server-trusting pubkey fetch is a known MITM hole, safe only behind the flag for laptop-to-laptop validation.

## Verification (whole slice)

- `npm test` green (existing + new); `teamcrypto` round trips against real libsodium; keychain round trips on macOS, skips on CI.
- With `team.encrypt` on, two laptops (or two keypairs in one test) push→pull and recover identical content through ciphertext; the plaintext columns still populate (dual-write) so the current server-rendered feed is unaffected.
- With the flag off, uploaded rows are unchanged from today.
- Migration `009` applied to staging Supabase; a manual row shows `ciphertext` populated and no content readable via the raw table.
