# E2E Encryption Completion — Design

_Date: 2026-07-21. Builds on docs/ENCRYPTION-SPEC.md (the agreed model) and the
shipped client slice (teamcrypto/keychain/teamsync behind `config.team.encrypt`).
This spec covers everything remaining to make E2E actually work: key
authenticity, rotation, the feed rewrite, fail-closed hardening, and the
cutover switch. User decisions (2026-07-21): fail-closed on crypto failure;
cutover via flag + runbook; web feed metadata-only._

## Goals

1. Encryption on by default, with plaintext dual-write until a deliberate,
   documented cutover flip.
2. No silent downgrade: when encryption is on, content never leaves the
   machine in plaintext because of a crypto failure, and a ciphertext row is
   never rendered from server-controlled plaintext columns.
3. Key authenticity via TOFU pinning + human-comparable fingerprints.
4. Key rotation on member removal; sealed-key delivery on member join.
5. Desktop feed decrypts locally; web feed degrades to metadata.

Non-goals (documented limitations): multi-device per user (last-writer-wins
pubkey, warn on mismatch), re-encrypting historical epochs, browser-held keys,
passphrase-wrapping the private key (keychain-only), non-macOS key storage.

## Components

### 1. Pin store + fingerprints (new `lib/teampins.js`)

- Pins live in `~/.membridge/pins.json`: `{ [user_id]: { publicKey, name,
  firstSeen } }`. Identity-level, separate from churny state.json. Immutable
  update pattern; written atomically.
- TOFU: first time a teammate's pubkey is fetched, pin it. Afterwards a
  fetched key that differs from the pin is a **key alert**: that member is
  excluded from any sealing, the alert is recorded in state
  (`state.keyAlerts`) for the dashboard/status to surface, and a warnOnce log
  fires. Clearing an alert = explicit re-pin via CLI (`membridge team trust
  <member>` after out-of-band verification).
- Own-key check: if the server's pubkey for me differs from my keychain pair,
  warn loudly (second machine or server tampering) and do not overwrite the
  keychain; push continues with the local pair.
- Fingerprints: `crypto_generichash(32, publicKey)` → first 16 bytes → hex in
  4-char groups. `membridge team fingerprint` prints mine + each pinned
  teammate's, for Signal-style out-of-band comparison.

### 2. Rotation + epochs (`lib/teamsync.js`)

- Widen `team_keys` SELECT policy to all team members (migration 013). Sealed
  blobs are only openable by their target's private key, so visibility of
  rows is not a confidentiality leak; it lets any member compute membership
  of an epoch.
- Current epoch = `max(epoch)` among visible team_keys rows (1 when none).
  `KEY_EPOCH` constant goes away.
- On each sync pass, per team: fetch current members + all team_keys rows.
  - **Removal detected** (epoch E has a sealed row for a non-member): mint a
    fresh key at E+1, sealed only to current members' **pinned** keys.
  - **Join detected** (current member lacks a row at E and I can unseal E):
    seal the current key to their pinned/TOFU key.
  - Races: insert with `on_conflict` ignore-duplicates on the PK
    (team_id, epoch, member_user_id); on conflict re-fetch and unseal the
    winner's key.
- Old epochs stay readable (pull already resolves per-row `key_epoch`).
  Removed members keep keys they already held — new content only is
  protected, per the agreed model.

### 3. Fail-closed sync (`lib/teamsync.js`)

- `config.team.encrypt` defaults **on** (`!== false`); explicit `false` is the
  escape hatch and the only way to get plaintext behavior.
- Push: no identity or no team key → **skip the push** (cursor does not
  advance, entries retry next pass) and surface "team sync paused —
  encryption unavailable" via log + state flag shown in dashboard/status.
  Encrypt error mid-batch → skip that batch, do not advance cursor past it.
- Pull: a row carrying ciphertext never falls back to its plaintext columns.
  Decrypt failure → content fields become null + `undecryptable: true`; the
  feed and context blocks render "(encrypted — cannot decrypt)". Rows with no
  ciphertext (legacy, pre-encryption) render plaintext as today.
- `reshareSession` follows the same rules.

### 4. Cutover switch

- `config.team.plaintextOff === true` → pushed rows carry only routing
  metadata (project_id, author, ts, source, session) + ciphertext/nonce/
  key_epoch; all plaintext content columns are null. Requires encrypt to be
  active; if encryption is unavailable, push pauses (rule 3).
- Default remains dual-write until the runbook is executed.
- Runbook (docs/E2E-CUTOVER.md): (1) apply migrations 009 + 013 to live
  Supabase; (2) both members update to this release; (3) verify fingerprints
  out-of-band; (4) both set `team.plaintextOff`; (5) optional: scrub
  historical plaintext columns server-side (SQL provided).

### 5. Feed rewrite (migration 013 + `lib/server.js`)

- Migration 013 (`013_e2e_feed.sql`, re-runnable, drop+recreate per house
  pattern): `team_feed` additionally returns ciphertext, nonce, key_epoch;
  team_keys member-wide SELECT policy (see §2).
- New `teamsync.decryptFeedRows(config, creds, rows, cryptoCtx)` helper:
  groups rows by team, resolves epoch keys through the same resolveTeamKey +
  per-pass cache, overlays decrypted payloads. Fail-closed per §3.
- `server.js feedPayload` builds one crypto context per request and passes
  team rows through the helper before `normalizeTeam`. Existing re-redaction
  stays (defense in depth).
- Context-block injection (pull path) already decrypts; it inherits the
  fail-closed change.

### 6. Keychain hardening (`lib/keychain.js`)

- Store via `security -i` with the command fed on stdin, so the secret never
  appears in argv (`ps` leak closed). Reads unchanged. Values are base64;
  quote them in the stdin command line.

### 7. Web app (`web/`)

- Feed rendering: when a row has no readable content (post-cutover or
  undecryptable), show author/project/time/source and an "Encrypted — view in
  the desktop app" placeholder. No keys in the browser, ever. Plaintext still
  present (dual-write era) renders as today.

### 8. CLI/status surface (`bin/membridge.js`)

- `membridge team fingerprint` — own + pinned teammate fingerprints.
- `membridge team trust <email|user_id>` — re-pin after a key alert.
- `membridge status` — shows encryption state: on/off, identity present,
  paused-for-crypto flag, outstanding key alerts.

## Error handling summary

Every crypto failure is loud (log + state flag + dashboard/status) and safe
(no plaintext leaves, no server plaintext trusted). Sync stalls only when
encryption is on and genuinely unavailable — by explicit user decision.

## Testing

All offline against the mock Supabase (test/run-tests.js §8 + mock-supabase):
- TOFU: first-sight pin; changed key → member excluded from sealing + alert.
- Rotation: removal → epoch bump sealed to remaining members only; join →
  sealed row appears; race → ignore-duplicates + refetch path.
- Fail-closed push: no key → nothing plaintext pushed, cursor unmoved, flag
  set; recovery next pass advances.
- Fail-closed pull/feed: ciphertext row with wrong key renders undecryptable,
  never plaintext columns; legacy plaintext row unaffected.
- plaintextOff: pushed rows have null content columns + valid ciphertext that
  round-trips.
- Keychain: store path passes secret via stdin (assert argv clean) — behind
  a darwin guard with an injected fake for CI.
- Fingerprint: stable, matches across two identities' views.
- Feed: server feedPayload decrypts team rows end-to-end via mock.

## Sequencing

1. teampins.js + fingerprints + keychain stdin (self-contained).
2. Epoch/rotation + fail-closed push/pull in teamsync.
3. Migration 013 + decryptFeedRows + server feed wiring.
4. plaintextOff + CLI/status + web placeholder.
5. Runbook + CHANGELOG; full suite green.
