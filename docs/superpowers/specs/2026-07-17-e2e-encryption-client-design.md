# E2E Encryption — Client Slice: keypair, team key, encrypted push/pull

**Date:** 2026-07-17
**Status:** Approved design (Andrew) — implements build-sequence steps 1–2 of the E2E spec
**Builds on:** [../../ENCRYPTION-SPEC.md](../../ENCRYPTION-SPEC.md) (full E2E model, agreed with Marco)

## Problem

Everything MemBridge syncs to Supabase today is **plaintext**. `pushProject`
(`lib/teamsync.js`) uploads seven content-bearing fields per entry — `ask`,
`summary`, `goal`, `decisions`, `gotchas`, `files`, `changes` — redacted and
clipped, but readable. So the product's entire wedge ("end-to-end encrypted, we
never receive it readable, we retain nothing") is **false at the data layer**:
anyone with DB/API access (us as operators, Supabase, a leaked service key) can
read every teammate's summaries and file paths.

This spec is the **client half** that closes it, scoped to what Andrew can build
and validate solo without breaking anything: generate a keypair, distribute a
shared team key sealed to each member, and encrypt the content fields before
push / decrypt them after pull — all **behind a flag, dual-writing plaintext**
so the server-rendered feed keeps working until the coordinated cutover.

The full guarantee is not delivered by this slice alone. It holds only after
the cutover (stop writing plaintext) which is gated on Marco's feed rewrite
(the E2E spec's step 3, out of scope here). This slice makes that cutover
*possible* and proves the round trip on real data.

## The model

Three new nouns, all from the agreed E2E spec — defined here so the plan can't
drift.

- **Member keypair** — a libsodium `crypto_box` keypair per user. The **private
  key lives in the macOS keychain** (via the `security` CLI) and is never
  uploaded. The **public key** is uploaded to `member_pubkeys`.
- **Team key** — a random symmetric key (`crypto_secretbox`) shared by a team.
  Content is encrypted once with it. The team key itself is distributed by
  **sealing** it to each member's public key (`crypto_box_seal`) → one small
  blob per member in `team_keys`, tagged with an **epoch** (int). A member
  unseals it with their private key.
- **Encrypted payload** — the seven content fields packed into one JSON object,
  `secretbox`-encrypted with the team key + a per-row random **nonce**, stored
  as `ciphertext` + `nonce` + `key_epoch`. File paths are **inside** the
  payload (decided: encrypt them — paths leak intent/structure).

What the server can still see (metadata, intentionally plaintext):
`project_id`, `author_id`, `author_name`, `ts`, `source`, `session`,
`created_at`, `key_epoch`, `nonce`. What it can never see: any content field,
any private key, or the raw team key.

## Scope of this slice (and what's deferred)

In scope (Andrew, solo, behind a flag):
- `lib/teamcrypto.js` — pure crypto primitives over `libsodium-wrappers`.
- `lib/keychain.js` — private-key storage via the macOS `security` CLI.
- Additive Supabase migration: `member_pubkeys`, `team_keys`, and
  `ciphertext`/`nonce`/`key_epoch` columns on `memory_entries`. Nothing dropped.
- Identity bootstrap: ensure a keypair on sync; upload the public key.
- Minimal team-key handling: create the epoch-1 team key sealed to all current
  member pubkeys if none exists; unseal it locally.
- `pushProject` / `pullProject` gated on `config.team.encrypt`: when on, write
  `ciphertext`+`nonce`+`key_epoch` **in addition to** the plaintext fields
  (dual-write), and on pull prefer decrypting the ciphertext when present.

Explicitly deferred (not this slice):
- Marco's feed rewrite (`team_feed` RPC → ciphertext; desktop decrypts
  client-side; web = metadata-only). E2E spec step 3.
- Real **key management**: TOFU pinning, Signal-style safety-number
  verification, passphrase-wrapping the private key, rotation on member
  removal. E2E spec step 4 + §6. This slice fetches pubkeys **trusting the
  server**, which is a known MITM hole — acceptable ONLY behind the flag, for
  laptop-to-laptop validation, and called out loudly. No security claim ships
  until step 4 + a cryptographer review (E2E spec steps 4–5).
- The coordinated cutover to ciphertext-only. E2E spec step 6 / §10.

## Behavior

**Flag.** `config.team.encrypt` (default **false**), same convention as
`sharePrompts`/`autoLink`. Off ⇒ today's exact behavior, byte for byte.

**Push (flag on).** For each entry, build the payload object from the seven
content fields (already redacted by the existing pipeline), `secretbox`-encrypt
with the current team key + fresh nonce, and add `ciphertext`, `nonce`,
`key_epoch` to the row. Keep writing the plaintext columns too (dual-write) so
nothing server-side goes blank pre-cutover. The existing PGRST204
drop-missing-column retry already tolerates a backend without the new columns.

**Pull (flag on).** Select the new columns too. If a row has `ciphertext`,
unseal the team key for its `key_epoch`, decrypt, and use the decrypted content
fields (ignoring the plaintext ones). If a row has no ciphertext (legacy /
pre-flag), fall back to the plaintext fields exactly as today.

**Private key never leaves.** `teamcrypto` never returns the private key to a
caller that uploads; `keychain` is the only holder. A failure to read the
keychain fails the *encryption path* closed (skip encrypting, keep working
plaintext) rather than crashing sync.

## Overlap with the E2E spec / Marco

This is the E2E spec's steps 1–2 and Andrew's column of §9, verbatim — no
deviation from the agreed model (libsodium, shared-team-key, keychain, encrypt
file paths, web-metadata-only later). The one coordination rule from §10 is
respected structurally: **dual-write only; storage never flips to
ciphertext-only in this slice.** Marco's step 3 and the joint step-4 key
management are unchanged and still required before any guarantee.

## Error handling

- **libsodium unavailable** (dep missing): the crypto path is a no-op — sync
  runs plaintext exactly as today, with a one-line stderr note. Never crash.
- **Keychain read/write fails**: encryption path fails closed (plaintext-only
  push, no ciphertext); a teammate simply can't decrypt what was never
  encrypted. Sync itself never fails on a keychain error.
- **Missing team key / can't unseal on pull**: fall back to the row's plaintext
  fields; log once. A wrong/rotated key must never throw the pull loop.
- **Backend without the new columns**: the existing drop-and-retry (push) and
  optional-select-column (pull) machinery already degrades gracefully; the new
  columns join those lists.
- **Non-macOS** (CI/Linux): `keychain` has no `security` binary — it reports
  unavailable and the crypto path no-ops, so the suite still runs green.

## Testing

Pure functions and offline round trips (no live Supabase), matching the repo's
`test/run-tests.js` harness; crypto validated against real `libsodium-wrappers`:

- **teamcrypto round trip:** genKeypair → seal team key to a pubkey → unseal
  with the matching private key → `secretbox` a payload → decrypt → deep-equal
  the original seven fields.
- **Wrong key fails safely:** unsealing with the wrong private key, or
  decrypting with the wrong team key, returns null/throws a caught error — never
  garbage that looks valid.
- **Nonce uniqueness:** two encryptions of the same payload yield different
  ciphertext (fresh nonce each time).
- **File paths are inside the ciphertext:** the plaintext `files` never appears
  in the encrypted blob's bytes.
- **keychain (darwin-only, else skipped):** store → load → delete round trips a
  private key; load-after-delete returns null; on non-darwin the module reports
  unavailable and tests skip rather than fail.
- **push dual-writes (offline):** with the flag on, a built row carries
  `ciphertext`+`nonce`+`key_epoch` AND the plaintext fields; with the flag off,
  the row is byte-identical to today (no new keys).
- **pull prefers ciphertext (offline):** a row with ciphertext decrypts to the
  original content; a row without ciphertext uses plaintext unchanged.
- **fail-closed:** simulated keychain/libsodium unavailability leaves push
  emitting today's plaintext row and never throws.
