# Changelog

## Unreleased

## 0.3.0 — 2026-08-04

- **Insights opens for whoever owns the team, full stop.** 0.2.9 restored the
  file whose absence locked the owner out; this removes the reason that
  absence could lock anyone out in the first place. The page was asking
  `solo` — a flag that answers "is anyone else actually here", which the
  daemon works out from whether a *linked project* belongs to a multi-member
  team. That is a different question from "do you have a team", and the gap
  between them is where an owner fell through: own a real team, have no repo
  linked yet, and the page told you Insights was for owners and admins.
  Authorization now turns on membership and role, which is what it always
  meant. The navigation rail had already been corrected this way, so the link
  and the page behind it finally agree — an owner of a one-person team can see
  their own numbers too.

## 0.2.9 — 2026-08-04

- **Fixed: a team owner could be locked out of their own Insights page.** The
  page read "Insights is available to team owners and admins" to someone who
  was, in fact, the owner. The cause was not in the page: `.membridge/team.json`
  had been deleted from the repository. Everything else under `.membridge/` is
  per-machine derived data, but that one file is source — it pins the shared
  backend project so every clone and fork resolves to the same team instead of
  minting its own. With it gone no project belonged to a multi-member team, the
  daemon reported the machine as solo, and Insights gates on that. The file is
  restored and `.gitignore` still carries the exception that keeps it tracked.
  If you cloned in the last day, pull before wondering where your team went.
- **Plainer language when something is wrong.** Full-page errors say
  "MemBridge" rather than "daemon", the Team page states what each state
  actually means instead of naming the mechanism behind it, and the Insights
  copy no longer promises more than it measures.
- **The installer no longer advertises working around Gatekeeper.** The mac
  build is signed and notarized, so the quarantine flag is left exactly where
  macOS puts it, and the install test now asserts that it is *not* stripped.

- **You can ask what a teammate is working on.** Recent activity now takes a
  person (and a project), so "what is Andrew on?" is a question with an answer
  instead of a page of everyone's work you have to read through. The filter is
  applied before the page is cut, which is the part that actually broke it
  before: narrowing a page of fifty to one person routinely left nothing, and
  nothing reads as "they are idle" rather than "ask for more rows".
- **"Working now" is a thing MemBridge can actually say.** Liveness used to be
  one flat fifteen-minute flag, so a teammate whose work landed twenty seconds
  ago and one who stopped fourteen minutes ago looked identical — which meant
  the only safe thing to report about either was a hedge. Activity is now
  graded **active / recent / idle**, and `active` is a claim worth making: a
  teammate's work reaches the backend within one sync cycle, so a row that new
  cannot exist unless their tooling was running. The threshold follows your
  configured sync interval instead of being a fixed number, because a team
  syncing every ten seconds and one syncing every five minutes cannot both be
  described by the same window.
  Grading is on **newest activity, not the last prompt**. Someone asks a
  question and their agent then works for twenty minutes: judged on the ask
  they look gone, judged on what they are actually doing they are plainly
  still going. So "asked about the invite flow 13 minutes ago and still
  working on it" is now expressible, and it is the honest answer.
  Anything older still gets its real age rather than a present-tense claim,
  and that whole distinction only became trustworthy now that timestamps come
  from a real clock (below).

- **Search runs on a real search engine now.** Memory is indexed into SQLite
  FTS5 and ranked by BM25 instead of being scored by a hand-rolled scan over
  every entry in memory. The reason to care is not mainly speed: BM25 weights
  a word by how *rare* it is, and the old scorer had no notion of that at all —
  a match on a word appearing in every entry counted exactly as much as a match
  on a word appearing in one. Rare, specific terms now win, which is what you
  wanted every time a search buried the good answer under noise.
  End to end a search is roughly twice as fast on a hit and four times on a
  miss against a 50,000-row archive; the query itself drops from ~450ms to
  ~1ms, and what remains is other work around it. The first search after an
  upgrade is slower, once, while the index builds. Deleting the index
  (`~/.membridge/search.db`) is always safe — it rebuilds itself.
- **Memory the team leans on now ranks higher.** Retrieval counts stopped
  being a number you could only look at: search results are reordered by them.
  Two entries that say much the same thing used to be separated by nothing but
  their timestamps, which is a coin toss — now the one people keep coming back
  to leads. This is reinforcement, not recency, and the distinction is
  load-bearing: MemBridge still refuses to favour recent work, because
  cross-teammate overlap runs about fifty days and a recency boost would
  rebuild the exact blind spot team search exists to fix. A six-month-old
  gotcha that keeps getting recalled is evidence, not staleness. The boost is
  bounded — it can settle a near-tie, never bury a better answer under a
  popular one — and it applies only to entries that already matched, so what
  "no results" means is unchanged on every surface.
- **Requires Node 22 or newer.** The index uses the SQLite support built into
  modern Node, so there is no new dependency to install. Node 18 and 20 both
  reached end of life earlier this year. The desktop app is unaffected — it
  ships its own runtime.

## 0.2.8 — 2026-08-04

- **Distilled notes are actually bullets now.** The Stop hook has been asking
  for one short bullet per line, and every reader still saw a single
  paragraph: two separate steps on the way out of storage collapsed all
  whitespace, and a newline is whitespace. Sessions distilled from here on
  keep their line structure on the feed, the session page, the team wire and
  the injected block. Entries written before this stay as they are, since
  their line breaks were never stored.
- **A session roll-up asks a better question.** The final summary of a long
  session now asks for the few things a teammate will still need next week,
  rather than everything that happened in the order it happened.

## 0.2.7 — 2026-08-04

A pass over the surfaces you actually read: the feed, a session, and the
controls that were quietly doing nothing.

- **The feed is day cards now, not a wall of sessions.** One card per person
  per project per local day, newest activity first, collapsed by default and
  expanding into the same session rows as before. The card's line is a pick of
  that day's best existing headline, never a new summary invented for it.
- **A row that could not be decrypted says so.** It used to render the exact
  words a genuinely un-summarized row renders, so a feed full of unreadable
  teammate entries looked healthy and empty rather than locked. The daemon had
  always sent the marker; the UI was dropping it.
- **A session reads top to bottom.** Files first, then what happened as a
  bulleted list, then the prompt chain folded away. "Why" and "Watch out" were
  merged into one "What", because they were always read together and two open
  paragraphs above the file list was the wall this page exists to avoid.
- **Sign in is reachable.** The left rail showed a status dot and the word
  "You" whether or not anyone was signed in, and offered "Create a team" to
  people who could not yet sign in. It now offers sign-in when signed out and
  names you when signed in.
- **Pending invites are visible and revocable.** The list and its Revoke button
  already existed and could never render, because the client returned an empty
  array instead of asking the daemon.
- **Credentials in URLs are redacted.** A sign-in URL carrying `?code=` reached
  memory intact: the entropy backstop deliberately exempts UUIDs so session ids
  stay readable, and the sign-in flow mints UUIDs, so the one layer that might
  have caught it was guaranteed not to. `code`, `token` and `access_token`
  values are now redacted in query position, while `code=200` in ordinary prose
  is left alone.
- **Settings changes take effect immediately.** Five mutations refreshed only
  half the state they changed, which is why "Get started" appeared to do
  nothing, and why leaving a team left the team navigation on screen until the
  next poll, or indefinitely with the window unfocused.
- **Searches are shareable and Back works.** The query and its filters live in
  the URL. A session opened from Search or a project now offers a way back to
  where you actually came from, instead of always claiming the feed.
- **Project names are links** on Today, Projects, and the Insights rows whose
  own copy tells you to go to the project page.
- **Insights fits the window again.** A long concentration reason forced the
  page 300px wider than a default window, in a range too wide to stack and too
  narrow to fit. The reason now wraps beneath the project name.
- **The MCP panel says why a tool was skipped.** The daemon had always computed
  the cause and the exact config key to set; the dashboard was collapsing all
  of it into one vague sentence.
- **You cannot demote yourself out of your own admin rights,** in the UI or
  through the API, and "Transfer ownership" is gone: no RPC to perform it has
  ever existed, so the control could only ever fail.
- **First-run navigation stops lying.** Clicking a nav item during setup moved
  the highlight and changed the URL while the welcome screen stayed put.

## 0.2.6 — 2026-08-04

An invite you send now works. Every step of accepting one was broken in a
different way, and each was hiding the next.

- **Invite links can be accepted.** Three separate faults, end to end. Signing
  in through an invite bounced to a nonsense address and dropped the invite,
  because Supabase's Site URL had no scheme and the join page's own return
  address was not on the redirect allowlist. The page then redeemed against
  the wrong table: it called the ops onboarding RPC, which **creates a new
  team** and never sees the invites the app actually mints, so a real invite
  answered "not recognised". And its closing instructions told people to run a
  CLI login that takes a password they do not have, having just signed up
  through GitHub. Accepting an invite now signs you in, joins you to the team
  that invited you, and points you at the app.
- **Joining a team, and switching between teams, from the app.** There was no
  join UI at all — an invited user could redeem a link and still have no way to
  connect a machine. The Team page now takes a pasted link or code, GitHub
  sign-in is reachable from the sign-in card (the only method the invite page
  offers, so an invited user had no password to type), and teams switch from
  the left rail.
- **Adding a project no longer means typing a path.** The dialog lists every
  folder on the machine that has AI sessions, with a native picker beside it.
- **Search filters filter.** All three did nothing: the person and project
  dropdowns send identifiers, the tool dropdown sends a display name, and the
  matcher compared them against names and raw stored values respectively — so
  every filter returned an empty list for every query. There is also a **Hide
  mine** control, applied before ranking rather than trimming the page, and
  results now lead with the outcome instead of the attribution.
- **Memory now knows when it gets used.** Every `search_memory` result and
  every `why` row carries `retrievals`: how many times that entry had been
  served before this call, counted identically across the MCP tools and the
  dashboard search and keyed on the event itself, so one memory accrues one
  count no matter which surface or author spelling served it. Serves append
  to a log under ~/.membridge — never state.json — and a tracking failure can
  never break a search. This is the first read on what stored memory is
  actually worth: proof of use now, the input for decay and usage-aware
  ranking later. Opt out with `trackRetrievals: false` or
  MEMBRIDGE_NO_RETRIEVALS=1.
- **Search quality is now a gated promise, not a hope.** A recall-quality
  harness (test/suites/recall-quality.test.js) seeds realistic corpora and
  asserts perfect recall AND precision for the questions people actually
  re-ask: a decision arc across sessions, a row that shared nothing but a
  file list, project/author/date filters, one event pushed under two display
  names, and an old exact answer outranking a recent partial one. A ranking
  change that silently breaks resurfacing now fails in seconds instead of in
  a teammate's session.
- **The installer stops overwriting a linked checkout.** Running it on a
  machine with `npm link` clobbered the developer's own `bin/membridge.js`.
- **Insights cannot publish a change it never measured.** A feed fetch that
  stopped at its page cap still produced a delta, so a truncated 30-day window
  reported growth that had not happened. Capped figures now say so.
- **Anonymous `mcp_tool_used` counter.** Reports which MCP tools see use —
  presence only, never call counts or arguments — gated by the same
  diagnostics kill switch as every other counter (`MEMBRIDGE_NO_DIAGNOSTICS=1`
  / `diagnostics.enabled: false`).
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
Two entries below sat under "Unreleased" through the 0.2.5 release but had
already shipped in it. They are recorded here as **0.2.5** features so nobody
upgrading from it expects them to be new:

- **`search_memory` is now relevance-ranked, not substring match.** _(0.2.5)_
  The MCP
  tool scores headlines, decisions, gotchas, goals, files touched, per-file
  change notes, prompts, and summaries, and returns each result's relevance
  `score` and which fields `matched`, plus a `total`. Deliberately not
  recency-weighted — cross-teammate overlap has no recency correlation, so
  old work still surfaces when it's the best match. New optional filters:
  `author`, `project`, `file`, `tool`, `since`/`until` (a bare date like
  `2026-06-01` is inclusive of that whole day), and `limit`.
- **Team activity gets a durable local archive.** _(0.2.5)_ The teammate-activity
  cache only ever kept the newest 100 entries per project — under a week
  for a busy five-person team — and discarded the rest permanently. Every
  pulled entry is now also written to a per-project archive under
  `~/.membridge/team-archive/`, and the daemon backfills it backward until
  the team's earliest entry is archived. `search_memory` reads the archive
  so it can answer questions about work far outside the cache window;
  `get_recent_activity` intentionally does not, to keep its payload small.

## 0.2.5 — 2026-08-03

Most of this shipped to `master` the evening 0.2.4 was tagged and missed that
release by hours, so 0.2.4 users have been running without it.

- **Distillation stopped writing summaries, and now does not.** The checkpoint
  gate compared edits against `minEdits + n * checkpointEvery`, where `n` counts
  the lines already in `summaries.jsonl`. That counter only grows and nothing
  prunes it, so the bar climbed out of reach and the Stop hook went silent by
  construction: failing the gate was a plain `return`. One live session reached
  a required 97 edits and had been dead for 26 hours. Replaced by a pure
  `isCheckpointDue` that measures edits SINCE the last checkpoint.
- **The desktop app reported "hook not installed" on every Electron install.**
  Liveness was judged with plain `fs.existsSync`, which cannot stat a path
  inside `app.asar`, so a correct registration read as dead and `membridge
  status` told users to re-run `setup-hooks` over a registration that was
  already right.
- **A session detail page, and a Team page.** The session page carries an
  analytics header (files touched, lines, commits, duration), the distilled
  one-liners, and the prompt chain, with a way back to the feed. The Team page
  is the surface that says whether this machine is signed in at all; gating it
  on already being on a team is what previously left signed-out users with
  nowhere to go.
- **Sign in is reachable from the left rail.** The rail footer showed a status
  dot and the literal word "You" whether or not anyone was signed in. It now
  offers a sign-in control when signed out and names the signed-in user
  otherwise, and it withholds "Create a team" until sign-in, which used to walk
  straight into a sign-in wall. Signed-in state is read from real account
  status, never from `solo`, which cannot tell "signed out" from "signed in
  with no team".
- **The session brief leads with files, and reads as a list.** Order is now Key
  files, Changes, What. "Why" and "Watch out" were merged into one bulleted
  "What": they were always read together, and two open paragraphs above the
  file list was the wall the page existed to avoid.
- **Distilled summaries are budgeted.** `decisions` and `gotchas` were the only
  distilled fields with no length limit, which is why they arrived as
  800-character paragraphs while headlines stayed short. They are now asked for
  as short bullets, one per line, and enforced. The session intent gets a wider
  budget so it can carry real detail, and the headline is now asked for as the
  general shape of the session rather than one specific outcome. Sessions
  distilled before this change still render, split on sentence boundaries, with
  nothing truncated.
- **The macOS download carries its notarization ticket.** 0.2.4 was signed and
  notarized but never stapled, so Gatekeeper had to reach Apple on first launch
  and an offline machine saw a "cannot be opened" panel for a perfectly valid
  build. The dmg is now stapled and the staple is validated in CI, which is the
  part that was missing: nothing in the pipeline had ever checked.
- **A recall answer no longer claims to have served lines it never served.**
  The hook answered a ranged `Read` with "this session already read it", but
  the ledger records only that a session read a PATH, never which lines came
  back. Ranged reads are now refused rather than answered on unsupportable
  evidence.
- **Invite links, and what the app tells you to do with them.** GitHub-invited
  users were told to run a CLI command they had no way to run, and the printed
  invite URL used a form the hosted join page ignores.
- **A teammate's "live" flag says what it was judged on.** A synced row means
  recent synced activity, never proof that someone is at their machine right
  now, and the MCP had already been read as the latter.
- **Context injection reaches git worktrees, and fails closed.**

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
