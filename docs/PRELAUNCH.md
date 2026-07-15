# MemBridge — Pre-Launch Checklist

_Single source of truth for what we're building toward. Supersedes the dated
`HANDOFF-*.md` notes and `servers.md`. Committed to the repo so both humans and
both AI sessions read the same thing. **This is human-owned — do not confuse it
with the auto-generated `CLAUDE.md` block, which MemBridge rewrites.**_

_Last updated: 2026-07-14 · Owners: Andrew, Marco_

## How to use this doc

1. At the **start** of a work session, read this file (and pull latest).
2. When you finish a chunk, update the item's **Status / Branch** and commit
   this file with your change.
3. The other person pulls before starting. Git is the sync layer — the two
   Claude sessions do not talk to each other; they coordinate only through
   this committed doc.
4. Settle architectural calls in the **Decisions log** so we stop
   relitigating them.

Status legend: `todo` · `in progress` · `blocked` · `done`

---

## Where we are today (verified 2026-07-14)

- The **team-collaboration MVP exists** on branch `marco-ui`: Supabase backend
  (migrations, invite links, roles), RLS as the authz layer, a Next.js web app
  under `web/`, team sync push/pull, and the team-hub dashboard.
- **Canonical source is top-level `lib/`.** `app/lib/` is a gitignored mirror
  refreshed by `scripts/prepare-app.js` (build scripts run it automatically).
  Review and edit `lib/`, not the mirror.
- Redaction (`lib/redact.js`) works and strips known secret patterns from
  asks/summaries before upload. **Redaction is not encryption.**

---

## P0 — Launch-blocking (cannot sell the Team tier without these)

### 1. End-to-end encryption of the sync payload
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Why:** `lib/teamsync.js` `pushProject` currently uploads `ask`, `summary`,
  and `files` to Supabase as **plaintext** (redacted + clipped only). The whole
  privacy wedge — "E2E encrypted, we never receive it readable, we retain
  nothing" — is false until this lands. A B2B security reviewer will find this
  immediately.
- **Definition of done:** summaries (and any opted-in prompts) are encrypted on
  the user's machine before upload; Supabase holds ciphertext only; the key is
  never uploaded. Web feed can no longer render summaries server-side — that
  change is expected and tracked under P1.

### 2. Prompt-privacy upload-gate (data layer)
- **Status:** code done (180/180, uncommitted) · **Owner:** Andrew · **Branch:**
  local, off `fix/checkpoint-sequence` — needs commit
- **Why:** teammates' verbatim prompts must not leave the machine unless the
  user opts in. Enforced at the **upload boundary**, not the UI.
- **Definition of done:** `config.team.sharePrompts` defaults false; when off,
  `pushProject` uploads `ask: null` (summary + files still go); offline tests
  prove non-shared prompts never reach Supabase and fail on reverted code. Also
  fixed: null-ask rendering in the injected block + both dashboards, and a
  settings/CLI bug that discarded the opt-in. CLI: `membridge team share-prompts
  <on|off>`.
- **⚠ Deploy gate — DO THIS BEFORE SHIPPING THE CLIENT:** the default upload
  sends `ask: null` into a `not null` column. Apply
  `supabase/migrations/005_ask_nullable.sql` to the **live** Supabase first
  (Fable had put the change only in `schema.sql`, which does not touch a live
  DB). Migration → then client. Tests pass regardless because the mock accepts
  nulls, so this won't be caught by CI.

### 3. Cryptographer review
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Definition of done:** one external cryptographer signs off on the crypto +
  key-management design **before** any security guarantee is written down
  publicly or in sales material. Don't roll our own crypto.

### 4. Key-management design
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Definition of done:** documented scheme — trust-on-first-use + out-of-band
  verification (Signal-style safety numbers) or keys derived from a
  team-controlled secret. Keys never uploaded to us. Study Syncthing's model.

---

## P1 — Should-have (needed for a credible launch, not strictly blocking)

### 5. Summary-first teammate UI
- **Status:** todo · **Owner:** Marco (web) · **Branch:** —
- **Definition of done:** `web/feed` and `dashboard-team.js` default to the
  session **summary** ("what was done"), collapse per-prompt asks, and expand to
  show a teammate's prompts only when that teammate opted in (else "not
  shared"). Depends on #2. Interacts with #1 (encryption changes how the feed
  reads summaries).

### 6. Retroactivity decision
- **Status:** todo · **Owner:** Andrew + Marco · **Branch:** —
- **Definition of done:** decide whether to scrub/backfill `ask` rows already
  uploaded before the gate (#2) existed. Record the decision here; ship a
  migration if we scrub.

### 7. Resolve `lib/` vs `app/lib` drift
- **Status:** todo · **Owner:** TBD · **Branch:** —
- **Why:** the mirror has drifted (`teamsync.js`, `digest.js`, `util.js` were
  stale). Risk: shipping an Electron build with old behavior.
- **Definition of done:** decide whether the mirror should exist at all or be a
  build-time-only artifact; ensure no stale drift can ship.

### 8. Merge the checkpoint-sequence fix
- **Status:** done (pushed `fix/checkpoint-sequence`, 176/176) · **Owner:**
  Andrew · **Branch:** `fix/checkpoint-sequence`
- **Definition of done:** PR reviewed and merged into `marco-ui`.

---

## P2 — Post-launch / nice-to-have

- Gemini CLI adapter.
- Local MCP server (expose MemBridge memory to MCP clients).
- Git-remote auto-linking polish.
- Cosmetic: in `memory.md`, the checkpoint block attaches to the session's
  latest summary-bearing entry, so its `Checkpoints:` list can sit under a
  trivial ask. Consider attaching to the session's first substantive entry.

---

## Decisions log

- **Prompt sharing: upload-gate, not display-gate.** Privacy is enforced by not
  uploading non-shared prompts, so they can't be read by the backend, Supabase,
  or a teammate hitting the API directly. Default off. (2026-07-14)
- **The shared unit is the summary; full chats stay local.** Summaries can
  contain sensitive IP, so they still require E2E encryption. (from `servers.md`)
- **Supabase is transport, not trust.** Use it as a dumb encrypted mailbox —
  encrypt client-side before upload. Resolved in principle, **not yet
  implemented** (that's P0 #1). (from `servers.md`)
- **Privacy is the differentiator; E2E is non-negotiable.** Shipping plaintext
  collapses the story to "as private as a private GitHub repo." (from
  `servers.md`)
- **Tiered model:** Free = LAN P2P (co-located, demo tier) · Team = hosted
  matchmaker, E2E, ~$10/seat/mo (guess) · Enterprise = customer self-hosts the
  matchmaker/relay. Keep BYOK; never resell AI tokens. (from `servers.md`)
- **Crypto:** don't roll our own — libsodium/NaCl or the Noise framework
  (WireGuard/Syncthing model). (from `servers.md`)

---

## Open questions to resolve together

- Encryption primitive: libsodium/NaCl vs Noise? (blocks P0 #1 scoping)
- Does E2E break enough of Marco's server-rendered web feed that the feed needs
  a client-side-decrypt rewrite, or a thin server-side "titles only" view?
- Pricing/seat model — is $10/seat/mo the real number?
