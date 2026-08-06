# MemBridge — End-to-End Encryption Spec

_For Marco (and his Claude). Written after a working crypto spike proved the round
trip. Goal: agree on the model before either of us touches real code, because this
breaks the server-rendered feed and can't be shipped one-sided._

_Status: **this document is the original design proposal, written 2026-07-16, before any
of it was built.** Encryption shipped in 0.1.0. Sections 1–10 are preserved as written —
they record what was agreed, not what exists — so several of their "open questions" have
since been settled and a few of their statements are now out of date. **§0 below is the
correction layer: it states what actually shipped and, more importantly, what it does not
protect.** Read §0 before quoting anything from §1–10._

---

## 0. What shipped, and what it does not protect

Encryption is on by default and fail-closed. Content is `secretbox`-encrypted with a
per-team key sealed to each member's public key; private keys stay in the OS keychain and
are never uploaded. The eight content fields sealed into the ciphertext are exactly
`ask`, `summary`, `goal`, `decisions`, `gotchas`, `files`, `changes`, `headline`
(`encryptRow`, `lib/teamsync.js`). File paths ARE encrypted — §3's open question was
settled in favour of encrypting them.

The three limitations below are not hypothetical and not scheduled fixes. They are the
current, shipped behaviour, and any public security claim has to be written around them.

### 0.1 A routing envelope travels OUTSIDE the ciphertext, in clear

Every synced row carries, in plaintext, at rest and on the wire:

`project_id`, `author_id`, **`author_name`**, `ts`, `source` (which AI tool), `session`,
plus the `nonce` and `key_epoch`.

These are the fields upserts and threading need, so they cannot be sealed without a
different schema. `author_name` is a **human display name**, and it is the one that
matters: the server holds a real person's name against every session timestamp, every tool
they used, and every project they touched. That is a social graph of who worked on what,
when, and with which tool — readable by anyone with database access, including us as the
operators.

So the accurate claim is **"the server cannot read your content"**, not "the server stores
ciphertext only" and not "nothing readable is stored on the server". The content is sealed.
The envelope is not.

### 0.2 Project-level revocation is enforced by the server, not by cryptography

**One team key spans every project in the team.** A member removed from a single project
while remaining on the team still legitimately needs that key for the projects they kept,
so there is no rotation that expresses "you may read Q but no longer P".

What stops them reading the revoked project is **Postgres row-level security alone**:
`team_keys` SELECT is gated on `is_team_member` and never on `can_see_project`, and
`reconcileTeamKeys` takes its seal targets from team membership with no project filter — so
a member revoked from one project is still sealed into every future key epoch. Project
access is a server-side check inside a product that otherwise sells end-to-end encryption,
and it is the weaker of the two guarantees by a wide margin. A revoked member who kept a
copy of the team key and could bypass RLS — an operator, a leaked service-role key, a
future policy bug — could decrypt that project's rows.

Fixing this properly needs project-scoped keys and a schema change. It is flagged, not
built. Do not describe project revocation as cryptographic, key-based, or end-to-end.

### 0.3 Team-level REMOVAL is cryptographic — do not confuse it with 0.2

Removing someone from the **team** is a genuinely different and genuinely stronger
operation. `removeMember` calls `rekeyTeam`, which mints a new team-key epoch sealed only
to the remaining members, so the removed device cannot read anything written afterwards.
When rotation cannot run (the `team.encrypt=false` hatch, or a failure) it reports that
plainly rather than claiming a success it did not achieve.

Two honest bounds on it, both by design:

- **Forward-only.** Old epochs are not re-encrypted, so history the removed member already
  pulled stays readable to them. No rotation can undo a copy someone already holds.
- **TOFU applies.** A member whose public key changed is withheld from the new epoch until
  verified, which is surfaced rather than silently applied.

---

## 1. Why

Everything we sync to Supabase today — summaries and opted-in prompts — is **plaintext**.
So "end-to-end encrypted, we never receive it readable, we retain nothing" — the privacy
line that's supposed to be our entire wedge — is currently false at the data layer.
Anyone with DB/API access (us as operators, Supabase, a leaked key) can read every
teammate's summaries. This spec closes that.

**The hard rule:** Supabase, and us as the operators, must never be able to read summary
or prompt content, and must never hold any key that could. If the server can ever get a
key, the promise is a lie.

---

## 2. The crypto model (already proven by a spike)

Library: **libsodium** (via `libsodium-wrappers` on the client). Not the Noise framework —
Noise is for live encrypted tunnels (WireGuard-style); ours is store-and-forward (write
ciphertext to Supabase, teammate pulls later), which is a mailbox and maps cleanly to
libsodium's sealed boxes.

**Shared-team-key model** (what the spike demonstrated end to end):

1. Each summary is encrypted **once** with a random symmetric **team key**
   (`crypto_secretbox` + a nonce) → one ciphertext blob.
2. The team key is distributed by **sealing** it to each member's public key
   (`crypto_box_seal`) → one small blob per member.
3. A member unseals the team key with their private key, then decrypts the summary.

Why this over "encrypt each summary to every member": one encrypted summary + N tiny
sealed-key blobs scales far better than N full re-encryptions per summary. Spike results:
round trip verified both directions, ~48-byte fixed overhead per blob (negligible).

---

## 3. Storage schema (Supabase)

`memory_entries` — stop storing readable `ask`/`summary`; store instead:

- `ciphertext` (the `secretbox`-encrypted payload of ask+summary), base64/bytea
- `nonce` (per-row random nonce)
- `key_epoch` (int) — which team-key version encrypted this row
- `files` — **open question:** encrypt these too, or keep as metadata? File paths can leak
  intent/structure. Recommend encrypting them into the same payload for v1.
  _(Settled: they ARE encrypted, inside the same payload. See §0.)_

New tables:

- `member_pubkeys` — `(user_id, public_key, created_at)`. Each member's published public
  key. **This is the trust-sensitive table** — see §5.
- `team_keys` — `(team_id, epoch, member_user_id, sealed_team_key)`. The team key for a
  given epoch, sealed to each member. New epoch on membership change.

**What the server can see:** ciphertext blobs, nonces, which member a sealed key is for,
timestamps, epochs, and (unless we encrypt them) file paths. **What it cannot see:** any
summary/prompt text, any private key, or the raw team key.

> **Correction (this list is incomplete as written — see §0.1).** File paths ended up
> encrypted, but the shipped rows also carry `project_id`, `author_id`, **`author_name`**,
> `ts`, `source` and `session` in clear. The display name in particular is readable server
> side against every timestamp, tool and project. §0.1 has the full envelope.

---

## 4. Client changes — mostly Andrew's side (`lib/teamsync.js`)

- **Keypair:** on first login, generate a libsodium box keypair. Private key stored in the
  **macOS keychain**, never uploaded. Public key uploaded to `member_pubkeys`.
- **`pushProject`:** before upload, unseal the current team key (from `team_keys`, with your
  private key), `secretbox`-encrypt ask+summary, and upload `ciphertext` + `nonce` +
  `key_epoch` instead of plaintext.
- **`pullProject`:** fetch ciphertext + the team key for that epoch, decrypt locally, then
  proceed as today.
- Existing **redaction stays** as defense-in-depth, but encryption is the real guarantee.

This half is self-contained and Andrew can prototype it solo behind a flag.

---

## 5. Feed rewrite — Marco's side, and the biggest work item

**The problem:** the v3 dashboard and the web app render summaries **server-side**
(`team_feed` RPC → `/api/feed`). Once summaries are ciphertext, the server can no longer
read them. **Decryption has to move to the client.** This is why encryption can't ship
one-sided — the day storage flips to ciphertext, any server-side summary rendering goes
blank.

- **`team_feed` RPC:** change to return `ciphertext` + `nonce` + `key_epoch`, not readable
  text.
- **Desktop dashboard:** the local server has keychain access, so it can decrypt locally
  before rendering — the desktop feed keeps working, it just decrypts client-side instead
  of trusting server-side text.
- **Web app (Next.js, browser):** browsers are a bad place to hold private keys. Options:
  (a) web feed shows **metadata only** — who / when / which project, no readable content;
  (b) require the desktop app for content; (c) a heavier browser-key scheme (out of scope
  for v1). **Recommend (a) for v1:** web = metadata-only, content lives in the desktop app.

---

## 6. Key management — the genuinely hard part (needs a cryptographer)

The spike faked this: both keypairs were generated in one script, so each side already had
the other's *real* public key. In reality, when Andrew fetches "Marco's public key" from
`member_pubkeys`, **a malicious server could substitute a fake key and silently
man-in-the-middle the whole thing.** Authenticity, not scrambling, is the real risk.

- **Trust-on-first-use (TOFU):** pin a teammate's public key on first sight; alert loudly
  if it ever changes.
- **Out-of-band verification:** Signal-style "safety numbers" — a short fingerprint the two
  humans compare over a trusted channel (in person / text) to confirm keys match.
- **Private-key protection:** OS keychain; consider deriving/wrapping it with a user
  passphrase so a stolen laptop file alone isn't enough.
- **Rotation:** on member removal, mint a new team-key epoch sealed only to remaining
  members; new data uses the new epoch (decide: re-encrypt old data, or leave old epochs
  readable to those who had them).
  _(Settled and shipped: `removeMember` calls `rekeyTeam`, and old epochs are NOT
  re-encrypted — rotation is forward-only. This covers removal from the TEAM only;
  per-project revocation has no cryptographic equivalent. See §0.2 and §0.3.)_
- **Do not roll your own crypto.** Use libsodium primitives as-is, and get **one
  cryptographer to review the key-management + rotation design before any security claim is
  written publicly.**

---

## 7. Decided vs open

**Decided (Andrew's recommendation):** libsodium; shared-team-key model; private key in the
OS keychain; web feed metadata-only for v1.

**Open — settle together:** exact schema column types; encrypt file paths or leave as
metadata; TOFU vs a team-secret-derived key scheme; rotation policy (re-encrypt vs leave
epochs); the desktop-decrypt architecture; whether the web app can ever show content.

---

## 8. Build sequence

1. **(Andrew, prototype)** keypair gen + keychain storage + `member_pubkeys` upload.
2. **(Andrew)** encrypt-before-push / decrypt-on-pull with the team-key model, behind a
   flag, laptop-to-laptop.
3. **(Marco)** feed rewrite: `team_feed` returns ciphertext; desktop decrypts client-side;
   web = metadata-only.
4. **(Both)** key management: TOFU + safety numbers + rotation on removal.
5. **Cryptographer review.**
6. **Coordinated cutover:** flip storage to ciphertext only once the feed rewrite ships in
   lockstep.

---

## 9. Division of labor

- **Andrew:** client crypto (keypair, push/pull encrypt/decrypt), schema.
- **Marco:** the feed rewrite (desktop + web), the `team_feed` RPC change.
- **Both:** key-management design, the coordinated cutover, the cryptographer review.

## 10. The one coordination rule

**Do not flip storage to ciphertext until the feed rewrite ships in lockstep.** The moment
summaries become ciphertext, anything rendering them server-side goes blank. Everything
above exists so we agree before that happens.
