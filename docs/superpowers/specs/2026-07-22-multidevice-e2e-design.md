# MemBridge — Multi-device E2E encryption fix

Status: in progress · Branch: `feat/multidevice-e2e` · Migration: `016_multidevice_keys.sql`

## Why this exists (the bug, proven)

Marco runs MemBridge under one account on a MacBook and a Windows machine. On the
second device MemBridge shows `Encrypt: PAUSED` and his own summaries from the
first device render blank. On 2026-07-22 we root-caused the live account and
proved the mechanism against the production Supabase:

- `team_keys` had a key sealed to Marco at the current epoch, but the keypair in
  this Mac's Keychain could **not** unseal it (verified by fetching the row and
  failing `unsealTeamKey` locally). Epoch 1 opened; epoch 2 did not.
- `member_pubkeys` held one row for Marco that **flip-flopped** — it did not match
  the Keychain at 23:55, did match later — because two devices under one
  `user_id` were overwriting the single pubkey slot.

The immediate pause was cleared by hand (delete Marco's stale epoch-2 `team_keys`
row; Andrew's next sync re-sealed the current key to Marco). **That was a manual
repair — no code changed.** This spec is the durable fix so it never recurs.

### Root cause

The key model is **one keypair per user**:

- `member_pubkeys` PK is `user_id` (one published pubkey per user).
- `team_keys` PK is `(team_id, epoch, member_user_id)` (one sealed copy per user
  per epoch).

Private keys live per device (macOS Keychain / Windows DPAPI) and never leave the
device. So a second device cannot reuse the first device's key — it mints its own,
overwrites the single `member_pubkeys` slot, and the team key stays sealed to the
first device's key. The second device holds a row it cannot open, is therefore
"not missing" at the epoch, so the join-seal skips it forever → paused. On every
sync the two devices fight over the one slot, and the next rotation seals to
whichever pubkey won the race, breaking the other device.

Two contributing gaps this also fixes:

1. `keychain.available()` is false on non-Darwin, so Windows has no key storage at
   all → no identity → paused regardless of the schema.
2. Nothing distinguishes devices; the schema has no notion of a device.

## Design

Each device gets its own libsodium keypair. The team key is sealed **once per
device**, not per user. A user with N devices publishes N pubkeys and receives N
sealed rows. This generalizes the existing "new member" join-seal to "new device":
any member's sync pass that already holds the team key seals it to every
not-yet-sealed **device** pubkey of every pinned member — including the user's own
other devices.

Legacy (pre-migration) `team_keys` rows carry no `device_id`; they stay readable by
whichever device holds the original key, and the join-seal at the existing epoch
hands that same team key to the new device — so old entries become readable on the
new device **without a key rotation**.

## Changes by area (implementation order)

### 1. `lib/device.js` (new) — stable per-device id ✅ done
`deviceId()` lazily creates `device.json` in `util.homeDir()`:
`{ deviceId: crypto.randomUUID(), label: os.hostname() }`, returns the id. Honors
`MEMBRIDGE_DEVICE_ID` env override (mirrors the `MEMBRIDGE_HOME` test-isolation
pattern in `util.js`). Atomic write (tmp + rename) like `teampins.save`. Corrupt/
missing file → regenerate.

### 2. `lib/keychain.js` — cross-platform key storage ✅ done
- Keep the macOS `security` backend and its `_setRunner` seam unchanged.
- Add a **Windows DPAPI** backend (no native deps): `available()` true on `win32`;
  `store/load/remove` shell out to `powershell` using
  `System.Security.Cryptography.ProtectedData.Protect/Unprotect` with `CurrentUser`
  scope, persisting the protected blob as base64 at
  `util.homeDir()/secrets/<account>.dpapi`. Gives the Keychain's "a copied file
  alone can't decrypt" property (bound to the Windows user account). Secret is fed
  on **stdin**, never argv (same discipline as macOS).
- Dispatch by `process.platform`; Linux stays a no-op (fail-closed). Add a Windows
  runner seam analogous to `_setRunner`.

### 3. `lib/teamsync.js` — device-aware identity, sealing, resolution
Thread `deviceId` (from `lib/device.js`) through the crypto path:
- `ensureIdentity`: upload `{ user_id, device_id, public_key }`, upsert on
  `(user_id, device_id)`; return `{ publicKey, privateKey, deviceId }`.
- `fetchMemberPubkeys`: select `user_id, device_id, public_key` — multiple rows per
  user; every device pubkey is a seal target.
- `resolveCurrentTeamKey` / `sealRows`: seal per `(user_id, device_id)`; each
  `team_keys` row carries `device_id`. "Missing at this epoch" (join-seal) matches
  on both `member_user_id` and `device_id`, so a new device is join-sealed exactly
  like a new member.
- `fetchMySealedRow`: fetch all my rows for the epoch and unseal whichever candidate
  opens — matches both my real `device_id` row and a legacy `device_id IS NULL`
  row, preserving backward decryptability. Same in `resolveTeamKey` and the
  pull/feed decrypt paths.
- `buildCryptoContext` / `mkTeamKeyDeps`: carry `deviceId` and the `device_id`
  upsert conflict target. Paused-reason log/state unchanged.

### 4. `lib/teampins.js` — TOFU pins keyed by device
Pin map becomes nested `{ [user_id]: { [device_id]: { publicKey, name, firstSeen } } }`
(or a flat `${user_id}|${device_id}` key). `check()` reads `device_id` from fetched
rows. A **new device** for a known user is a first-sight pin (allowed), **not** an
alert; a **changed key for an existing device** is an alert. Preserves the
anti-MITM guarantee per device. Migrate legacy flat pins on load.

### 5. `supabase/migrations/016_multidevice_keys.sql` (new, re-runnable, guarded) ✅ written
- `member_pubkeys`: add `device_id`, clear existing rows (safe — `ensureIdentity`
  re-uploads every sync), drop the old `user_id` PK, add composite PK
  `(user_id, device_id)`. RLS unchanged (own-or-shared-team select, own-row
  insert/update — device_id doesn't affect those predicates).
- `team_keys`: add `device_id` and **make it part of the PK**:
  `(team_id, epoch, member_user_id, device_id)`. **Do not clear** — clearing
  destroys decryptability of existing entries; legacy rows backfill to `''` and
  stay readable. Index on `(member_user_id, device_id)`.
  - **Correction to the original note:** it proposed leaving `device_id` NULLABLE
    with the PK unchanged. That fails — a second device's row for the same
    `(team, epoch, member)` collides with the existing PK regardless of
    `device_id`, so the new device never gets its own row (the exact bug). So
    `device_id` must be `NOT NULL` and join the PK; legacy rows use a `''`
    sentinel (a PK column cannot be NULL). **Consequence for section 3:** the
    client's `insertSealedRows` on-conflict target becomes
    `(team_id, epoch, member_user_id, device_id)`.
- `memory_entries`: unchanged (ciphertext is per-row, team-key-scoped).
- Same deploy-gate discipline as 009/013: **apply to live Supabase before shipping
  the client.**

### 6. `test/mock-supabase.js` — model devices
- pubkeys: key by `${userId}|${deviceId}`, upsert on the pair, GET returns all
  devices for the requested users with `device_id`.
- teamKeys: rows carry `device_id`; dup check on
  `(team_id, epoch, member_user_id, device_id)`; GET returns `device_id` and honors
  the `member_user_id` filter.

### 7. `bin/membridge.js` — CLI surface
- `team fingerprint`: list a fingerprint per device (label from `device.json`); own
  device highlighted.
- `team trust`: re-pin all published device keys for the matched user (or a specific
  device when disambiguated).
- `status`: unchanged logic; optionally show this device's label.

### 8. `test/run-tests.js`
- Update existing E2E tests to inject a fake device id alongside the fake
  keychain/teamcrypto `cryptoDeps` (one device each — existing Marco/Andrew tests
  stay green).
- New regression test (the bug): user A on device D1 pushes an encrypted entry; user
  A on device D2 (distinct keypair) resolves the team key (join-sealed to D2) and
  decrypts D1's entry.
- New: Windows DPAPI round-trip, guarded `process.platform === 'win32'` (mirrors the
  macOS-only keychain test) — exercised only on the Windows box.
- New: TOFU — a second device for a known user is allowed (new pin), a changed key
  for an existing device alerts.

## Rollout
- Apply `016` to live Supabase **before** shipping the client.
- After upgrade, run a Mac sync once so the device holding the team key join-seals
  the newly-published second device at the current epoch; the next sync on the new
  device then decrypts, including older entries under that epoch. No rotation.
- Legacy `member_pubkeys` rows are cleared and self-heal on re-upload; legacy
  `team_keys` rows (`device_id NULL`) remain readable by the original device.

## Non-goals (not fixing here)
- `pullProject` filters `author_id=neq.me`, so a user's own other-device summaries
  flow into the dashboard feed (fixed) but not into locally injected
  CLAUDE.md/AGENTS.md context. Separate product decision.
- Linux key storage stays a no-op (fail-closed).
- The stopgap `team.encrypt=false` is not used.

## Verification
- `node test/run-tests.js` — full suite green, including the three new tests
  (cross-device decrypt, DPAPI round-trip on win32, TOFU per-device).
- Manual on Windows: `membridge status` shows `Encrypt: on` (no PAUSED);
  `membridge team fingerprint` lists this device's key; after a Mac sync + a Windows
  sync, the dashboard team feed renders the Mac's summaries (no opaque rows).
- `membridge team fingerprint` on both machines shows matching per-device
  fingerprints for out-of-band cross-checking.
