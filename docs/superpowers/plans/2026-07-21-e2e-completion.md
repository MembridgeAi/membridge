# E2E Encryption Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish MemBridge E2E encryption: TOFU key pinning + fingerprints, epoch rotation, fail-closed sync, local feed decryption, cutover flag, hardening.

**Architecture:** New pure module `lib/teampins.js` (pin store); `lib/teamcrypto.js` grows `fingerprint()`; `lib/teamsync.js` gets `resolveCurrentTeamKey` (mint/rotate/join-seal, pull-side resolver becomes unseal-only), fail-closed push/pull, `plaintextOff`, and `decryptTeamRows` for the feed; `lib/server.js` decrypts team rows per request; migration 013 widens `team_keys` SELECT and adds ciphertext columns to `team_feed`; CLI adds `team fingerprint`/`team trust`; web feed gets an encrypted-placeholder.

**Tech Stack:** Node 18+, libsodium-wrappers, offline mock Supabase (test/mock-supabase.js), test/run-tests.js §8.

## Global Constraints

- Spec: docs/superpowers/specs/2026-07-21-e2e-completion-design.md — fail-closed; dual-write default; `team.plaintextOff` cutover flag; web metadata-only.
- `config.team.encrypt` defaults ON (`!== false`); explicit `false` is the escape hatch restoring legacy plaintext behavior end-to-end.
- Never stage other sessions' dirty files; commit narrowly with explicit paths.
- Match house style: CommonJS, 'use strict', explanatory header comments, immutable updates, no new deps.
- Run suite: `node test/run-tests.js` (expect the one pre-existing red noted in memory to stay unrelated — suite was 469/470 at some point; verify baseline before starting).

---

### Task 1: teamcrypto.fingerprint + lib/teampins.js

**Files:** Modify `lib/teamcrypto.js`; Create `lib/teampins.js`; Test `test/run-tests.js` (§8 area).

**Interfaces produced:**
- `teamcrypto.fingerprint(publicKeyB64) -> "ab12 cd34 …"` — crypto_generichash(32) of the raw key, first 16 bytes hex, 4-char space-separated groups. Requires `ready()` first (like other primitives).
- `teampins.load(dir) -> pins` (plain object `{ [userId]: { publicKey, name, firstSeen } }`, `{}` when file missing/corrupt); `teampins.save(dir, pins)`; `teampins.check(pins, fetched, nowIso) -> { pins, allowed, alerts }` where `fetched = [{ user_id, public_key, display_name? }]`, `allowed` = rows whose key matches pin or was newly pinned (TOFU), `alerts = [{ user_id, name, pinned, fetched }]` for mismatches (excluded from allowed). Pure; returns new objects. `dir` is the `.membridge` home dir (caller passes `path.join(util.homeDir(), '.membridge')` — verify actual home helper during implementation).

**Steps:**
- [ ] Failing tests: fingerprint is stable/formatted; TOFU pins unseen keys; mismatch produces alert + exclusion; matching keys pass; load/save round-trip; corrupt file → `{}`.
- [ ] Implement; suite green; commit `feat(crypto): key fingerprints + TOFU pin store`.

### Task 2: keychain stdin hardening

**Files:** Modify `lib/keychain.js`; Test `test/run-tests.js`.

**Interfaces:** `store(account, secret)` unchanged externally, but the secret travels via `security -i` stdin: `spawnSync('security', ['-i'], { input: 'add-generic-password -U -a "<acct>" -s "membridge" -w "<secret>"\n' })`. Add injectable runner seam `keychain._setRunner(fn)` (test-only, like other seams) so tests assert no secret in argv on any platform.

**Steps:**
- [ ] Failing test: with fake runner, `store()` argv contains no secret; stdin line does; quoting correct for base64 (`+ / =`).
- [ ] Implement; green; commit `fix(crypto): keychain secret via stdin, not argv`.

### Task 3: epoch resolution, rotation, join-seal, TOFU enforcement

**Files:** Modify `lib/teamsync.js`, `test/mock-supabase.js`; Test `test/run-tests.js`.

**Interfaces produced:**
- `resolveCurrentTeamKey(identity, deps) -> { teamKey, epoch } | null`. deps: `{ teamId, teamcrypto, pins: {load, save, check, dir}, fetchTeamKeyRows, fetchMembers, fetchMemberPubkeys, insertSealedRows, cache, onAlert }`.
  - `fetchTeamKeyRows()` → ALL visible rows `[{ epoch, member_user_id, sealed_team_key? }]` (013 policy; sealed blob present only guaranteed for own rows pre-013 — treat missing blob as row-exists).
  - currentEpoch = max(epoch) else mint at 1. My row at currentEpoch → unseal (null on fail → return null, fail-closed). No rows at all → mint 1. Rows but none mine → return null (waiting to be sealed-to).
  - Rotation: any member_user_id at currentEpoch not in `fetchMembers()` → mint currentEpoch+1 sealed to current members' TOFU-checked keys only.
  - Join-seal: current member with no row at currentEpoch while I hold the key → insert their sealed row.
  - All inserts: `on_conflict=team_id,epoch,member_user_id` + ignore-duplicates; after a conflict-y mint, re-fetch and unseal winner.
  - Every seal target passes through `teampins.check`; alerts go to `onAlert(alerts)` and those members are NOT sealed to.
- `resolveTeamKey` (pull-side, historical epochs) becomes unseal-only: never mints. Same signature.
- Mock: widen team_keys GET to member-visible rows (blob included — mirrors 013 single-policy note in migration comments); POST honors ignore-duplicates Prefer by skipping PK conflicts (else 409).

**Steps:**
- [ ] Failing tests: mint-at-1; second member unseals same key; removal → epoch 2 minted excluding removed member, old epoch rows intact; join → sealed row appears for joiner; changed pubkey → member excluded + alert surfaced; concurrent mint conflict → refetch path yields one shared key; pull of old-epoch row still decrypts; pull never mints.
- [ ] Implement + mock changes; green; commit `feat(crypto): epoch rotation, join-seal, TOFU enforcement`.

### Task 4: fail-closed push/pull + encrypt default-on

**Files:** Modify `lib/teamsync.js`; Test `test/run-tests.js`.

**Behavior:**
- `syncTeams`: `encryptOn = ((config.team||{}).encrypt !== false)`. When on and identity/key unavailable → do NOT call pushProject for that project; record `state.teamCryptoPaused = '<reason>'` (cleared on success) and an errors[] entry; pull still runs.
- `pushProject(…, crypto)`: crypto now `{ teamKey, epoch, teamcrypto, plaintextOff, required }`. When `required` and no teamKey → return 0, cursor untouched. Encrypt throw → stop before that batch; cursor advances only through pushed batches.
- `pullProject`: when encryptOn, a row with ciphertext either decrypts or lands in teamEntries with content fields null + `undecryptable: true`; never its plaintext columns. `encrypt === false` → legacy behavior exactly. Rows without ciphertext → plaintext (legacy data).
- `reshareSession`: same required-crypto rule (refuse with error instead of plaintext overwrite when key unavailable).
- Existing tests asserting plaintext fallback flip to assert fail-closed (fix tests to match new spec — the spec changed, not the tests' subject).

**Steps:**
- [ ] Failing tests: no-key push pushes nothing + sets paused flag + cursor unmoved + next-pass recovery; tampered ciphertext pull → undecryptable marker, plaintext columns ignored; encrypt=false escape hatch restores legacy; default-on without explicit flag.
- [ ] Implement; green; commit `feat(crypto): fail-closed sync, encryption on by default`.

### Task 5: plaintextOff cutover flag

**Files:** Modify `lib/teamsync.js`; Test `test/run-tests.js`.

**Behavior:** `config.team.plaintextOff === true` → `encryptRow` returns row with ask/goal/decisions/gotchas/summary/files/changes all null alongside ciphertext/nonce/key_epoch. Only meaningful with active crypto (push is already paused otherwise via Task 4).

**Steps:**
- [ ] Failing test: pushed row content columns all null, ciphertext round-trips to full payload on pull.
- [ ] Implement; green; commit `feat(crypto): plaintextOff cutover flag`.

### Task 6: migration 013 + feed decryption

**Files:** Create `supabase/migrations/013_e2e_feed.sql`; Modify `lib/teamsync.js` (decryptTeamRows + buildCryptoContext exports), `lib/server.js`, `lib/feed.js`; Test `test/run-tests.js`.

**Interfaces:**
- 013 (re-runnable, house style): drop+recreate `team_feed` adding ciphertext/nonce/key_epoch to RETURNS TABLE and select list (copy signature from 008's recreation); replace team_keys select policy with member-wide (`public.is_team_member(team_id)`), drop old policy by name first inside guarded DO block.
- `teamsync.buildCryptoContext(config, creds, deps?) -> ctx | null` (extracted from syncTeams so server.js reuses it).
- `teamsync.decryptTeamRows(config, creds, teamId, rows, ctx) -> rows'` — per-row: ciphertext? decrypt via unseal-only resolver (per-ctx cache) → overlay payload; failure → null content + `undecryptable: true`. No ctx (encrypt=false) → rows unchanged.
- `server.js feedPayload`: build ctx once, map fulfilled team results through decryptTeamRows before normalizeTeam. `feed.normalizeTeam` carries `undecryptable` through; renderers show "(encrypted — cannot decrypt)".

**Steps:**
- [ ] Failing tests: feedPayload returns decrypted content for ciphertext rows (mock team_feed already passes columns through); undecryptable row shows marker, not plaintext columns.
- [ ] Implement + SQL; green; commit `feat(crypto): feed decrypts locally; team_feed returns ciphertext (013)`.

### Task 7: CLI + status surface

**Files:** Modify `bin/membridge.js`; Test `test/run-tests.js`.

- `membridge team fingerprint` — own fingerprint (keychain pubkey) + each pinned teammate's, names from pins.
- `membridge team trust <user_id>` — refetch that member's pubkey, overwrite pin, print old/new fingerprints.
- Status line (wherever `membridge status`/dashboard health prints): encryption on/off, identity present, `teamCryptoPaused` reason, alert count.

**Steps:**
- [ ] Failing tests (invoke handlers or exported helpers offline): fingerprint output format; trust overwrites pin.
- [ ] Implement; green; commit `feat(cli): team fingerprint/trust + encryption status`.

### Task 8: web placeholder + runbook + changelog

**Files:** Modify `web/app/feed/page.js`; Create `docs/E2E-CUTOVER.md`; Modify `CHANGELOG.md`.

- Web feed: row with no ask/summary but ciphertext present → "Encrypted — view in the desktop app" placeholder (author/project/time still shown). No decryption in browser.
- Runbook: apply 009+013 SQL (Supabase SQL editor, one transaction each); both members update + verify `membridge team fingerprint` out-of-band; both set `team.plaintextOff`; optional plaintext-scrub SQL for historical rows (`update memory_entries set ask=null, goal=null, decisions=null, gotchas=null, summary=null, files=null, changes=null where ciphertext is not null;`).
- [ ] Implement; suite green; commit `feat(crypto): web encrypted placeholder + cutover runbook`.

## Self-review

Spec coverage: §1→T1/T7, §2→T3, §3→T4, §4→T5+runbook, §5→T6, §6→T2, §7→T8, §8→T7, testing list→each task. Types consistent: `{ teamKey, epoch }` from resolveCurrentTeamKey feeds pushProject's crypto arg; `undecryptable` flows teamsync→feed→renderers.
