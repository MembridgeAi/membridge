# Changelog

## Unreleased

- **The context block arrives fresh at session start.** The daemon writes
  the "Shared AI memory" block into CLAUDE.md on its own ticks, so a session
  starting in a just-created worktree read whatever stale block an ancestor
  file happened to carry — sometimes another project's. A SessionStart hook
  (riding the already-registered entry, no settings change) now renders the
  block live from state and injects it, deduped against every CLAUDE.md the
  session can see: a healthy root session pays nothing extra, and the hook
  only speaks when the on-disk block is missing, stale, or foreign.
- **Capped context now says it's capped.** The block's session and teammate
  sections showed the newest few entries with no hint that more existed.
  When entries are elided, the headers now carry explicit counts ("showing
  the last 5 of 37 sessions", "the freshest 8 of 412 shared entries") and
  name where the rest lives (`search_memory`, or `.membridge/memory.md`) —
  so an agent never mistakes the window for the whole history.
- **`search_memory` is now relevance-ranked, not substring match.** The MCP
  tool scores headlines, decisions, gotchas, goals, files touched, per-file
  change notes, prompts, and summaries, and returns each result's relevance
  `score` and which fields `matched`, plus a `total`. Deliberately not
  recency-weighted — cross-teammate overlap has no recency correlation, so
  old work still surfaces when it's the best match. New optional filters:
  `author`, `project`, `file`, `tool`, `since`/`until` (a bare date like
  `2026-06-01` is inclusive of that whole day), and `limit`.
- **Team activity gets a durable local archive.** The teammate-activity
  cache only ever kept the newest 100 entries per project — under a week
  for a busy five-person team — and discarded the rest permanently. Every
  pulled entry is now also written to a per-project archive under
  `~/.membridge/team-archive/`, and the daemon backfills it backward until
  the team's earliest entry is archived. `search_memory` reads the archive
  so it can answer questions about work far outside the cache window;
  `get_recent_activity` intentionally does not, to keep its payload small.
- **Anonymous `mcp_tool_used` counter.** Reports which MCP tools see use —
  presence only, never call counts or arguments — gated by the same
  diagnostics kill switch as every other counter (`MEMBRIDGE_NO_DIAGNOSTICS=1`
  / `diagnostics.enabled: false`).

## 0.1.0 — 2026-07-22

Public launch. Version numbers reset to 0.1.0; the sections below this release
are pre-launch internal history and their version numbers no longer correspond
to published releases.

- **End-to-end encryption is on by default, fail-closed.** Team sync content
  (asks, summaries, decisions, gotchas, file paths, change notes) is
  secretbox-encrypted with a per-team key sealed to each member's public key
  (libsodium; private keys never leave the macOS Keychain, now fed to
  `security` via stdin so secrets never touch argv). When encryption cannot
  run — no key, tampered row, unmigrated backend — sync **holds entries and
  pauses** instead of degrading to plaintext, and undecryptable rows render
  opaque rather than trusting server-side text. The explicit
  `team.encrypt: false` hatch restores legacy plaintext sync.
- **Key authenticity + rotation.** Teammate public keys are pinned on first
  use (TOFU); a changed key raises a loud alert, is excluded from key
  sealing, and is only accepted via `membridge team trust` after comparing
  `membridge team fingerprint` safety numbers out-of-band. Removing a member
  rotates the team key to a new epoch sealed only to remaining members;
  joiners are sealed into the current epoch automatically.
- **The feed decrypts locally.** `team_feed` now returns ciphertext
  (migration 013) and the desktop dashboard decrypts with the local
  identity; the web feed shows an "Encrypted — view in the desktop app"
  placeholder instead of ever holding keys in a browser. The
  `team.plaintextOff` flag stops dual-writing plaintext entirely — see
  `docs/E2E-CUTOVER.md` for the coordinated flip (migrations 009 + 013
  must be applied to the live backend first).

- **Session summaries are now cumulative and outcome-phrased.** Every
  checkpoint rewrites the whole-session summary (newest line wins on every
  surface) as *what changed in the project*, not AI activity — so a long
  session's card no longer shows only its last increment. The summary turn
  is discreet: one pre-approved `membridge-hook.js append` command (narrow
  `permissions.allow` rule installed/removed by `setup-hooks`/`remove-hooks`),
  no narration, no permission prompt.
- **Activity cards lead with a one-glance outcome.** Distilled summaries carry an
  optional short `headline`; cards never headline with harvested AI monologue, guard
  noisy live prompts to "Working…", clamp to two lines, and move the full summary
  into the expander.
- **Card headlines never get cut off.** The hook asks for the headline within a
  hard 80-character budget and the append command enforces it (an over-budget
  headline fails loudly so the agent shortens and retries) — the card shows it
  verbatim, and the longer `did` story stays one click away in the expander.
  Legacy over-long headlines degrade at a word boundary with an ellipsis. Also
  fixes a pipeline gap where the distilled `headline` was captured but dropped
  by `mergeEvents` and `buildEntries`, so local cards had been falling back to a
  truncated first sentence of `did` and never actually showed the short line.

## 0.7.0 — 2026-07-14

- **Simplified dashboard — three surfaces, one feed.** The desktop dashboard
  drops from five surfaces to three: **Home**, a single unified,
  summary-first activity feed (you and your teammates, across all projects,
  newest first) where each entry leads with *what got done* and keeps the raw
  prompt as a muted `Asked:` line, with a running session shown as
  `Working on:` instead; quiet person/project/tool filter chips replace the
  select-box filter bar. **Project pages** become one merged local + team
  stream in the same summary-first format, day-grouped, with Copy-for-AI and a
  `⋯` menu (memory log, context targets, pause/resume, share/unlink, remove
  block, delete) and the roadmap generator collapsed at the bottom.
  **Settings** now also holds all team management (switch/rename team, members
  and roles, invite links, create/join/leave, account + log out) and project
  management (add a project, detected-tools scan, watched-projects list).
- **Removed**: the Neural map (force-directed graph view, its canvas
  simulation, `/api/graph`, and `lib/graph.js`), the Overview marketing hero
  and project-card grid, the separate Team hub tab, member drill-down pages
  (`#team-member=`), and the team-project sub-route (`#team-project=`, folded
  into `#project=`). The header is now just logo · running/sync pill · Invite
  · settings gear.
- **New `GET /api/feed`** in the local daemon merges local `.membridge` memory
  with each team's `team_feed` into one sorted, deduped list, degrading to
  local-only (with a notice) when the team backend is unreachable. Merge logic
  lives in a new, unit-tested `lib/feed.js`.
- **Migration `004_feed_summary.sql`**: `team_feed` now returns each entry's
  `summary`, so teammates' distilled summaries reach the feed. Function-only —
  old clients ignore the added column. **Apply it to the live Supabase
  backend.** (`supabase/schema.sql` updated to match.)

## 0.6.0 — 2026-07-13

- **Invite links (team schema v2)**: `membridge team invite` mints a short
  URL-safe token — shareable as `https://<web app>/join/<token>` or
  `membridge join <token>` — with optional expiry (`--expires-days`) and use
  cap (`--max-uses`), revocable with `team revoke-invite`. A redeem can never
  grant more than the member role; rotating the legacy code also revokes all
  outstanding links. The legacy UUID invite code keeps working — `join`
  routes on the input's shape. (`supabase/migrations/002_team_v2.sql` — a
  migration, so the live backend upgrades without recreating anything.)
- **`membridge join <link-or-code>`**: one command from invite to member —
  logs in, or creates the account if it's new (`--email` / `--password`),
  then joins. The dashboard's team page gains a "Copy invite link" button.
- **Auto-link, prompt-first**: when a local project's normalized git remote
  matches a project a teammate already shares, MemBridge *suggests* the link
  (dashboard card + log line) and shares nothing until you confirm. Opt into
  fully automatic linking with `"team": { "autoLink": true }` in config.
- **Roles & management**: `admin` role between owner and member; RPCs for
  remove_member, set_role, rename_team, rotate_invite, leave_team with
  owner/admin checks; `team_feed` (keyset pagination + person/project/tool
  filters) and a `project_stats` view power the web app in one query.
- **Hosted web workspace (`web/`)**: Next.js + supabase-js + Tailwind, no
  custom API server — RLS is the authorization layer. Screens: `/join/<token>`
  invite landing (team name via `peek_invite`, inline signup, auto-join,
  CLI install nudge), day-grouped team feed with filters, project cards,
  team settings (members, roles, invite links, rename, leave). Deploys to
  Vercel from the `web/` folder; the npm package still ships without it.
- **Privacy hardening**: memory entries now fall back to the *basename* for
  files outside the project (an absolute path would leak usernames and
  machine layout to teammates), and a regression test pins that git remote
  credentials (`https://user:token@…`) are stripped before any URL is
  uploaded. The suite grows to 82 offline checks.

## 0.4.1 — 2026-07-12

- **Team sync is now zero-config for users.** The Supabase backend is baked
  into the build (`lib/backend.json`, filled once by whoever operates the
  MemBridge backend), so end users no longer run `team setup` — they just
  `membridge signup` and go. `team setup` remains as an advanced override for
  self-hosting your own backend. (Backend resolution order: env → config →
  baked default.)

## 0.4.0 — 2026-07-12

- **Team sync (beta)**: link a project to a team and every member's MemBridge
  pushes its redacted per-project memory entries to a shared Supabase backend
  (yours — run `supabase/schema.sql` in a free project) and pulls teammates'
  entries down. The injected context block gains a "Teammates' AI activity"
  section with author attribution, so your Claude Code knows what a
  teammate's Codex did. New commands: `team setup/create/join/link/unlink/
  list`, `signup`, `login`, `logout`. Invite-code joins; clones map to one
  project row via the normalized git remote (name fallback). Row-level
  security restricts every row to team members; only already-redacted digest
  entries ever leave the machine, and only for explicitly linked projects.
  Auth tokens live in `~/.membridge/credentials.json` (chmod 600). Team sync
  is best-effort on top of local sync: an unreachable backend never blocks
  local syncing. (New: `lib/teamsync.js`, `supabase/schema.sql`; the suite
  gains an offline mock Supabase and now has 60 checks.)

## 0.3.0 — 2026-07-12

- **Roadmaps (the BYOK upgrade)**: with a key saved, every project's Plan tab
  becomes a generator — describe what you want to build, see the estimated
  cost before you click, and get back a phased roadmap where every task
  carries the AI model that should do it (Everyday — Haiku up to Frontier —
  Fable, plus a cross-check by Codex), a reason, and a size. The tab lists
  exactly what leaves the machine (project name, goal, redacted recent asks,
  file paths, top-level names — never file contents), shows the actual cost
  from usage afterwards, warns when new AI activity postdates the plan, and
  saves to `.membridge/plan.json`. One line — "Current roadmap: …" — is
  written into the shared memory block, so Claude Code and Codex see the
  plan too. (New: `POST /api/plan/generate`; structured-outputs request in
  `lib/advisor.js` with one retry and a 60s timeout.)
- **Settings + bring-your-own-key**: a gear in the header opens Settings —
  paste an Anthropic API key (stored only in `~/.membridge/config.json`,
  chmod 600, `ANTHROPIC_API_KEY` env honored as fallback) with a Test button
  that makes a single count_tokens request; pick the planner model in plain
  English (Fast & cheap ~1¢ / Smarter ~4¢ / Deepest ~6¢ per roadmap); and
  set the sync interval and context files, which used to require editing
  config by hand. Interval changes now apply without restarting the daemon.
  (New: `lib/advisor.js`, `GET/POST /api/settings`, `POST /api/settings/test`;
  the key is never sent to the dashboard page.)
- **Project pages**: the Overview is now a clean projects grid (name, tool
  badges, last activity, paused state) and clicking a card opens a full
  project page — Activity (the complete ask-by-ask history with the files
  each ask touched) and Memory (what gets injected where, a read-only view
  of the full memory log, pause/resume/delete). ✕, Esc and browser-back all
  exit. (New endpoints: `GET /api/project`, `GET /api/project/memory`.)
- **Neural map**: a second dashboard tab with a force-directed 3D map of
  every chat across every project, linked by shared files and TF-IDF idea
  similarity. Events now carry per-chat session ids (state v2 triggers a
  one-time full rescan from the transcripts). (New: `lib/graph.js`,
  `GET /api/graph`.)
- **Copy for AI**: every project page has a Copy for AI button that puts a
  trimmed, redacted digest of recent AI activity on the clipboard, ready to
  paste into ChatGPT / claude.ai / any web AI that can't see your disk. The
  manual bridge until importers/MCP land. (New endpoint:
  `POST /api/projects/copy`.)
- Fix: a fast `stop` → `start` could leave the new daemon running with a dead
  dashboard when the port was still held by the dying process. The dashboard
  now retries the bind (EADDRINUSE) for up to ~10s before giving up, and says
  so in the log if it does.

## 0.2.1 — 2026-07-10

- Fix: macOS build was reported as "damaged" and refused to launch on
  Apple Silicon. Root cause: the app had zero code signature, and arm64
  Gatekeeper reports fully unsigned apps as damaged instead of the usual
  unidentified-developer warning. The build now ad-hoc signs the app
  bundle after packaging (`scripts/afterPack.js`). Still unsigned by a
  real Apple Developer certificate, so first launch needs right-click > Open.

## 0.2.0 — 2026-07-10

- **Tray app**: MemBridge now runs as a macOS menu-bar app (dock-hidden) and
  Windows/Linux system-tray app. Status at a glance, open dashboard, sync now,
  pause, start at login, quit. Built with Electron; the CLI daemon is unchanged
  and the app takes over cleanly if the CLI daemon is already running.
- **Per-project memory database**: every AI update is recorded as a structured
  entry in `<project>/.membridge/memory.json` — what was asked, by which tool,
  and exactly which files it touched — rendered for humans and agents as
  `.membridge/memory.md`. The DB also maintains an index of the project's
  local files (path, size, mtime; ignore-aware, capped) so memory entries can
  point any other LLM at the right files.
- The injected context block now links to `.membridge/memory.md` for the full
  log; `membridge remove` also deletes the `.membridge` folder.
- macOS app builds (unsigned `.dmg` / `.zip`) are produced by CI on every
  release via the "Build app" workflow.

## 0.1.0 — 2026-07-09

Initial release.

- Background daemon syncing a brief per-project "shared AI memory" into
  `CLAUDE.md` / `AGENTS.md` (configurable targets)
- Adapters: Claude Code, Codex, plus a config-driven custom adapter for any
  JSONL-logging tool
- Incremental transcript reading (byte offsets, partial-write safe)
- Local web dashboard on `127.0.0.1:7437` (status, per-project memory,
  pause/resume, sync now)
- Secret redaction before injection; per-project exclude / `.membridge-off`
- `remove` command strips injected blocks cleanly
- Autostart at login on Windows, macOS, Linux (no admin required)
- Zero runtime dependencies; Node 18+; 20-check end-to-end test suite
