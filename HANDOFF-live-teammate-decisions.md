# Handoff: spec for live teammate-decision updates

**For:** a fresh Claude session, working with Marco.
**Your job:** run `superpowers:brainstorming` with Marco, then write the spec to `docs/superpowers/specs/` — same process that produced `2026-07-28-membridge-token-reduction-design.md`. Do not write code. Read this file, verify its claims against the code (line numbers drift), then start the brainstorm.

## The product question

When Andrew's session decides something — "we renamed the retry cap to `maxAttempts`, don't touch `validate.ts` until migration 018 lands" — Marco's agent should know it **during Marco's current session**, ideally at the moment it matters (when his agent touches the affected file), not tomorrow when a digest block regenerates.

Marco also asked: *do we need to redo project linking to be git-based?* Short answer discovered while writing this: **mostly no — the team wire is already git-keyed.** Details below; the spec should confirm and close the remaining gaps rather than redesign.

## Where the codebase is (2026-07-29)

Branch `claude/scale-agent-waste-corpus-53abef` (worktree of `/Users/marco/Documents/Membridge`), ~45 commits ahead of master, unpushed, final review verdict READY TO MERGE. Two layers shipped on top of the existing product:

1. **Measurement** — adapters emit per-request `usage` and `read` events; `lib/ledger.js` + `lib/ledger-fold*.js` maintain a durable per-project ledger (`.membridge/ledger.json`, version 4) with cumulative volume, read tiers (first / same-session / cross-session) and a `fileReaders` map (path → sessions that read it). Verified 0.000% drift against a reference implementation.
2. **Recall** — a PreToolUse hook (`lib/hooks-recall.js`) answers a repeat `Read` with a pointer (tier A) or a cached skeleton (tier B) built by the daemon's warmer (`lib/recall-store.js` + `lib/skeleton.js`, tree-sitter with fallback). Savings settle via `net = callTokens − (skeletonTokens + followTokens)` with revisable settlement (late reads correct the total). Everything fails open; 832/832 tests.

The build is installed and live on Marco's machine. Full history: `.superpowers/sdd/progress.md`. Specs/plans: `docs/superpowers/specs/2026-07-28-membridge-token-reduction-design.md`, `docs/superpowers/plans/` (two plans).

## What already exists that this feature stands on (verified)

- **Git-based project identity on the wire.** `lib/teamsync.js:918-954`: the shared project row is keyed on the *normalized git remote*, with logic making fork remotes converge to one project. Marco's and Andrew's different local paths already map to the same team project.
- **Decisions are already captured and synced.** The Stop-hook distillation (`lib/hooks.js` runStop) writes `decisions`/`gotchas` per session to `summaries.jsonl`; team sync pushes them E2E-encrypted (summary parity landed in b297527); teammate summaries flow back and render in the feed and the injected CLAUDE.md block.
- **A per-read delivery channel exists now.** The recall hook fires on every `Read` in a tracked project. The original design spec (§3.3) planned `decisions: [from summaries]` in the recall store; **it was never implemented — the store is skeleton-only today** (verified: no `decisions` field in `lib/recall-store.js`). This is the natural slot for "live": attach the relevant teammate decision to the skeleton/pointer served at the moment the agent touches the file.
- **Local project state is path-keyed** (`state.projects` by absolute path, worktree folding via `foldWorktreeProjects`), and the recall store + ledger use repo-relative paths internally (`readKeyFor`). Cross-machine file identity therefore works IF paths are repo-relative and the repo identity is the git remote — both halves already exist, they just haven't been joined for this purpose.

## So what does "live" actually take? (the spec's core questions)

1. **Freshness of arrival.** Sync today is a pull cadence in the daemon loop. How fast can a teammate decision arrive — is the existing cadence (~minutes) "live enough" when delivery is per-read, or does this need push (Supabase realtime subscription)? Note the E2E constraint: the server can only push ciphertext; decryption and routing stay client-side. Fail-closed pauses on expired JWTs have bitten before (see memory: encrypt:false hatch / token refresh) — a realtime channel adds another auth surface.
2. **Routing a decision to a file.** Decisions today are prose per session, not keyed to files. Options to explore: extract file paths from the session's edit/read events and attach decisions to those paths (the data is already in the wire rows); ask the distillation to name affected files explicitly (schema change to summaries + wire); or serve project-level decisions un-routed (weakest but zero schema change). This is the biggest design choice.
3. **Injection surface.** Three candidates, not exclusive: (a) recall serve payloads carry a "teammate notes" section — in-session, at the moment of relevance, but only fires on hot files; (b) a lightweight PreToolUse/UserPromptSubmit injection when fresh teammate decisions exist for the project — session-wide but costs tokens on every session (the CLAUDE.md block tax argument, spec §5.5, applies — Marco explicitly rejected shrinking the block once; don't propose a second standing tax lightly); (c) CLAUDE.md block updates mid-session — cheap but agents read it only at session start, so not live.
4. **Token honesty.** Whatever gets injected is new input cost. The ledger must count it (it can — injected content arrives as context growth), and the avoided/injected balance for this feature should be visible in the same Savings surface. The "tokens, never dollars; avoided, never saved" wording constraints are binding (spec §8.1/§8.2).
5. **Project linking gaps** (the actual residue of Marco's question): local `state.projects` stays path-keyed — fine, it's per-machine. What the spec must nail down: worktrees of the same repo folding to one identity (exists locally, verify it holds for recall store paths), repos with NO remote (currently can't join a team project — acceptable?), and monorepo subpaths (two teammates tracking different subdirectories of one remote). No wholesale redo; targeted rules.
6. **Privacy.** Decisions cross the wire already (encrypted, redacted). New surface: serving Andrew's decision text into Marco's agent context is fine inside a team, but tier-C-style serving to someone whose session never had access to that file is worth a explicit statement. Redaction (`lib/redact.js`) must run on anything newly injected — same rule as skeletons.

## Constraints that bind the spec (from the existing design, don't relitigate)

- Fail-open everywhere; nothing in the agent's critical path may block or slow reads beyond the 150 ms budget.
- E2E encryption stays; the server never sees plaintext. Local-first; solo users lose nothing.
- The CLAUDE.md narrative block stays as-is (decided 2026-07-28, §5.5) — this feature must not become a backdoor shrink or bloat of it.
- Tokens-not-dollars, avoided-not-saved wording in all user surfaces.
- Skeleton/recall store never syncs to the wire today; if the spec proposes syncing skeletons or file-keyed decisions, redaction + the existing `filterShareableEntries` path are the gate.

## Suggested first probes (before brainstorming with Marco)

- Read `lib/teamsync.js` remote-normalization + pull/push cadence; confirm what a "decision" row looks like on the wire and whether file paths already ride along via edit events.
- Read `lib/hooks-recall.js` serve-body construction — where a teammate-notes section would attach.
- Check Supabase realtime availability in the existing schema/config (does the client lib already depend on anything push-capable, or is it plain REST?).
- Skim memory notes: `team-wire-summary-parity`, `encrypt-false-hatch-and-token-refresh`, `ciphertext-only-default-landed`, `join-seal-rls-blocked` — the team-sync sharp edges live there.

## Open follow-ups from the recall work (unrelated, don't absorb them into this spec)

Mixed-settings-entry matcher repair; unpause UI for net-negative auto-paused projects; "Answer reads from memory" settings toggle surface; README "local-first" wording vs default-on diagnostics; stale "Read/Grep/Glob" console copy (chip filed). Listed in `.superpowers/sdd/progress.md`.
