# Queue

What is being worked and in what order. `canonical-sources.md` lists this file
in the fresh-session read order; it did not exist until 2026-08-02, so anything
before that date was tracked in `state.md`'s "Not done" section instead.

`decisions.md` holds settled reasoning. `state.md` holds verified current
state. This file holds only what is next.

---

## Heads-up for in-flight branches

**The test suite is split (2026-08-04).** Six self-contained sections moved
verbatim out of `test/run-tests.js` into `test/suites/*.test.js` (redaction,
search, save-state, ops-noise, mcp-config, mcp-agent-discovery), each leaving a
one-line breadcrumb at its old location. `node test/run.js` runs everything in
parallel and is what `npm test` and all three workflows now call;
`node test/run.js <name>` runs one suite in seconds. If a branch of yours edits
one of the moved sections, the edit belongs in the suite file now — the
breadcrumb comment says which. New tests go in `test/suites/` (require
`../harness` first, end with `h.finish()`), not in run-tests.js.

**The feed screen is rewritten (2026-08-05).** `dayCardKey` is day+author
only, the card is a link into a new `/days/:daySlug` route, and
`collapseSessionCheckpoints` is gone from the feed path (ProjectPage keeps
it). Any branch touching `ui/src/features/feed/` rebases before further work.
Two hard-won rules from the same night: never set `pool: 'threads'` in
`ui/vite.config.ts` (it silently disables the TZ pin, red CI on UTC, green
everywhere else; the comment in that file has the mechanism), and a new test
suite must use port offsets no other suite file uses (`delete-my-data` copied
`shared-delete-outage`'s and Windows CI hit EADDRINUSE).

## In flight

**`feat/alpha-readiness-backfill`**, three commits, not merged and not pushed.
Alpha readiness Task 3 (adoption backfills prior history) plus the tombstone
that keeps a deliberately deleted project deleted. Task 3b passes at 17.3
seconds from install to visible memory. Merges cleanly into `master`.

## Next, in order

1. **Alpha readiness Task 5**, rewritten in full as 5A through 5E in
   `docs/superpowers/plans/2026-08-01-alpha-readiness.md`. Locked decision 5 in
   that plan is marked SUPERSEDED because of it; read both. 5A has a
   verification gate before any code: establish the provenance of `ask` versus
   `goal` and report before proceeding.
2. **Task 4**, the duplicate-daemon pid race.
3. **Task 6**, the duplicated `adoptProjects` at `lib/server.js:1347`. Both
   bodies were measured byte-identical (md5 `08e38450a77247e4f01b784f41751609`),
   so this one is mechanical.
4. **Task 7**, the installer SHA reconciliation. The repo copy and the deployed
   copy have drifted; fetch the live script before touching either.
5. **Task 8**, the Windows asset.

## Waiting on a human (2026-08-05)

- **The PITR/backup retention window, read off the Supabase dashboard.**
  Migration 035 (self-serve deletion) is applied live and verified, but
  `/security` on the site cannot state how long deleted data persists in
  backups until someone reads the retention number from Settings, Database,
  Backups. Asked of Marco in the 08-05 handoff. One number unblocks the copy.
- **Prompt-sharing default sign-off**, from Andrew's Aug 2 brief. Still open.

## Logged, not scheduled

These are real gaps found while doing other work. Neither is a defect in
something that was asked for, and neither is being fixed yet.

- **Digest lead-ins that announce instead of report (found 2026-08-05).**
  The filler fix stops short conversational clauses becoming day headlines,
  but a second class survives because it is long: "Now let me look at the
  digest/memorydb pipeline..." renders as a day-card clause today. Same rule
  the digest already enforces on `goal` (an intent is never promoted into an
  outcome), one field over, and it needs a different signal than a length
  floor. Lives in `pickSessionStatement`, `lib/digest.js`.
- **Pre-existing Supabase advisor warnings (surveyed 2026-08-05).** Nothing
  new from 035, but the standing list is worth a pass: `team_feed`,
  `team_feed_counts`, `peek_invite`, `can_see_project`, `is_team_member`,
  `is_team_member_uid`, `projects_materialize_access` and
  `set_project_access_default` are anon-callable SECURITY DEFINER functions;
  four ops tables have RLS enabled with no policy; leaked-password
  protection is off in Auth.

- **`membridge remove` purges memory but does not untrack, and there is no CLI
  untrack command at all.** `remove` strips the injected blocks and deletes
  `.membridge`, then leaves the project in `state.projects`. Untracking is only
  reachable through the dashboard's delete. One consequence is that the
  tombstone's re-add message cannot be reached from the CLI alone: a re-add of a
  still-tracked project reports "already tracked" and stops there.

- **There is no adopt surface in the React app, so `historyWithheld` has no
  consumer.** `ui/src` contains zero references to adopt or
  `/api/projects/add`. `adoptProjects` now reports `historyWithheld` so a
  re-add that withholds history can say why, and the CLI prints it, but nothing
  in the dashboard reads it. Whatever calls that route is not the React app.
  Worth resolving before anyone is told the dashboard surfaces this.

## Fixed 2026-08-03, in the working tree, not yet committed

The three items below this section were worked in one session. All four fixes
are uncommitted on `fix/pin-npm-and-harden-pack-check`; Andrew reviews and
commits. Suite is 1398/1399, the one failure being the known worktree check.

- **Distillation.** Root cause was the checkpoint gate, not the hook. It read
  `edits >= minEdits + n * checkpointEvery`, where `n` is the count of lines
  already in `summaries.jsonl`. That counter only grows, nothing prunes it, and
  the edit count it was compared against does not grow in step, so the two
  diverge and the bar becomes unreachable. Session `b6202e6a` reached n=8 with
  29 edits attributed to it, so it was being asked for 97 and had been dead for
  26 hours. Silent by construction: failing the gate is a plain `return`.
  Replaced by `hooks.isCheckpointDue`, a pure function measuring edits SINCE the
  last checkpoint, with `hooks.lastSummaryTs` reading the cursor off the file.
- **`isHookInstalled()`.** Root cause was `installKind`, which judged liveness
  with plain `fs.existsSync`. A path inside `app.asar` cannot be stat'd by plain
  node, only by Electron's patched fs, so every Electron install's correct
  registration read as dead. `installKind` now resolves the archive FILE when a
  path component ends in `.asar`. Verified against the real install: both
  `isHookInstalled()` and `isRecallHookInstalled()` flipped false to true, and
  `membridge status` now prints "Claude Code hook installed".
- **Recall hook answered a ranged read it had never served.** A `Read` of lines
  23510-23551 of `test/run-tests.js`, by a session that had earlier read lines
  9200-9319 of the same file, was answered with the tier A pointer, "this
  session already read it". The caller had to shell out to `sed`. Cause:
  `decide()` accepted `offset` in its input contract (the hook passes it, see
  `lib/hooks-recall.js:363`) and never read it, and the ledger's `fileReaders`
  records that a session read a PATH, never which lines came back, so tier A's
  claim is unsupportable for a ranged call. `decide()` now refuses any call with
  a positive offset, reason `ranged-read`. Tier B is refused too: a skeleton is
  not the lines that were asked for. offset 0 and a bare `limit` are unaffected.
  Recording served ranges properly would mean changing the ledger and the fold,
  which is not worth this narrow hole; refusing is the honest floor.
- **`commits` on `GET /api/session`**, so the session detail page's analytics
  header can show commits produced. Counts only commits attributed to that
  session, and is ABSENT rather than 0 when the map cannot be read, because a
  session that genuinely produced no commits is a real 0.

## Found 2026-08-04 evening by the agent team — ALL MERGED AND RELEASED 2026-08-05

**Status correction (2026-08-05, ~00:40).** The paragraph below described this
work as uncommitted in three worktrees. It is all on `master` and released; do
not go looking in the worktrees for it. Landed as PRs #19 (ui, 16 tickets), #21
(search/daemon, 9), #20 + #22 (team kit), #23 (schema/attribution, incl.
migrations 028-034), #24 (release 0.3.1), #26 (release 0.3.2), #25/#27 (installer
pins). `master` head after the batch: the 0.3.2 release commit.

Two things went out that need stating plainly:

- **0.3.1 shipped a regression and 0.3.2 fixes it.** Deriving `/api/status`'s
  `running` from the sync loop's real last pass was wired into
  `bin/membridge.js` only, and `app/main.js` — the tray app, the normal install —
  never recorded a pass. Every desktop user read `running: false` / health
  `unknown` while syncing fine. Caught by running the shipped build, not by the
  suite. Anyone on 0.3.1 should take 0.3.2. Rule: see the standing note that
  BOTH sync loops must be wired for any change to what a pass does or reports.
- **The site was four releases stale.** `membridge.app/install.sh` was pinned to
  0.2.8 and the JSON-LD said 0.2.7, so 0.2.9/0.3.0/0.3.1 never reached anyone
  using the documented install command. Now published at 0.3.2 with a SHA
  matching the CI asset. Nothing verifies these agree — publishing to the site
  repo is a required release step, not an optional one.

**Still open from this batch:** migrations 028-034 are committed and UNAPPLIED
(028 then 029 in order, in the SQL editor, never `db push`; diff 031 against live
first, it is a reconstruction). Until 033 is applied, revoking a member's access
still does not cover what they can write. Also open: duplicate `membridge` /
`Membridge` projects (needs a data write), `--text3` WCAG contrast, the Windows
daemon-restart flake plus `run.js` folding a crashed suite's partial count into a
green-looking total, `readAccess` defaulting a missing project row to open, and
rows left behind by a pre-fix unlink never being pruned.

Original entry, kept for the detail:

50 tickets. Work sat in `.claude/worktrees/{ui,hunt,search-identity}` on
`fix/insights-solo-gate`, `agent-hunt` and `agent-search-identity`.
Slack: #handoffs 2026-08-04 evening (main message plus four thread replies).

**Corrections to earlier reports, highest value first.**

- **`scripts/verify-finding.js` is not on `master`.** It exists only on
  `agent-hunt` and is not in the distributed kit zip. The Aug 4 setup handoff
  told Andrew to confirm it exists as precondition 4, and the Aug 4 brief said
  deciding whether a red test is real "is now a command instead of a judgment
  call". Both are true on one unmerged branch only. Land it before anyone else
  runs the team.

- **The version-lockstep guard could not fail where it mattered, and CI proved
  nothing.** `test/run-tests.js:661` spawns `scripts/prepare-app.js`, which
  rewrites the tracked `app/package.json` from the root manifest
  (`prepare-app.js:198-211`), so the assertion below compared the root version
  against a copy of itself. `master` with real drift (root 0.3.0, app 0.2.8)
  passed 1288/1288 unpatched, through CI on every push and through `npm
  publish`'s `prepublishOnly`, across 0.2.9 and 0.3.0. `docs/releasing-macos.md`
  step 1 told people to rely on the build to sync it, which is what produced the
  drift. Now three independent checks plus `scripts/stamp-version.js` and an
  `npm version` hook. **Landing consequence: the new check goes red until
  someone runs `node scripts/stamp-version.js` and commits `app/package.json`
  at 0.3.0 in the same commit.**

- **The 2026-08-02 cwd-attribution entry below is FIXED**, and deliberately not
  by re-homing. `rehomeEvents` now clears `ev.project` when an edit resolves to
  no tracked root; a file genuinely inside the project keeps it. 235 of 5,188
  edits were misattributions; zero were genuinely in-project-but-unresolvable,
  so there was no re-attribution target. **16 sessions stop appearing** (13
  Membridge, 2 AI, 1 Websites). The ask survives in the local memory DB with an
  empty file list; the block, feed and team push drop it. Marco signed off.

**Needs a human to apply, nothing is applied.**

- Migrations `028`/`029` (enforce the project access default, then materialize
  grants so the flag only governs new members), `030` (commit the live-only
  `is_team_member_uid` behind `team_keys_insert`), `031` (commit the live-only
  `ensure_rls` trigger, now fatal on failure per Marco). SQL editor only, `028`
  then `029` together, **never `supabase db push`** — only 2 of 30+ migrations
  are tracked as applied. Rollback read from live at
  `hunt/supabase/rollback/pre-028-029-snapshot.sql`. `031` §1 is a
  reconstruction, so diff it against live first.
- Normalise Andrew's 100 `Andrew Brown` rows to `andrewludwigbrown` (approved).
- The duplicate `membridge` / `Membridge` projects: 21 rows stranded in the
  lowercase one, excluded from every search. Code half (case-insensitive
  matching in `link_project`) not started; deliberately held so schema and data
  land together.

**Open, in flight at time of writing.**

- `readAccess` reports the whole team as able to see a restricted project, for
  any non-manager. `project_access`'s select policy is `is_team_manager` and RLS
  *filters rather than errors*, so a member's read returns zero rows and the "no
  row means visible" default fires. `028` does NOT close it: the fallback
  becomes `defaultAccess`, still `true`.
- ~~`projects_insert` lets a member POST straight to `/rest/v1/projects`,
  bypassing `link_project` and 029's materialization.~~ **CLOSED live
  2026-08-05**: the policy was dropped by hand, and `public.projects` now carries
  `projects_select` only (RLS still on, the `032` trigger intact, 7 projects and
  13 `project_access` rows unchanged). Written down as `036`, which is the one
  file in `supabase/migrations/` that is already applied — it exists so the repo
  stops disagreeing with production, not to introduce a change. Safe because
  `link_project` is owned by `postgres` (`rolbypassrls = true`) and
  `public.projects` is not FORCE-RLS, so the RPC's insert never evaluated the
  policy; either fact alone is sufficient. Rollback at
  `supabase/rollback/pre-036-projects-insert.sql`. **Does not fix the duplicate
  `membridge` / `Membridge` pair above** — that came from `link_project` matching
  on exact name, not from the POST path.
- `memory_entries_insert`/`_update` gate on membership and `author_id` only, so
  a revoked member can still write to a project they cannot read. Pre-existing.
- `project_access` needs an index on `(project_key, member_id)` — not a PK
  prefix, so `can_see_project` sequentially scans per row inside `team_feed` and
  the `memory_entries` policy.
- Archive compaction, then the opt-in re-pull that makes the identity fixes
  retroactive. Blocked on compaction because `appendRows` writes every line
  unconditionally, so the `.ndjson` would double permanently.
- **`lib/team-archive.js` `rewriteRows` runs outside `withAppendLock`** — a live
  data-loss bug, pre-existing: the eviction rewrite can discard another
  process's `appendFileSync` landing between read and rename. `writeAtomic` also
  has no fsync. Being fixed in the compaction commit.
- `classify` infers "is this source edit-capturing" from observed edits, so a
  project whose only captured edits were foreign ones now has every zero-edit
  session *spared* rather than suppressed. 0 instances here; mechanism is real.
- `test/run-tests.js:23258-23272` pins a link-agnostic backfill contract, so the
  teammate-notes reconciler cannot self-heal an install unlinked before that fix.

**Logged, not scheduled.**

- `--text3` is `#94A3B8`, roughly 2.8:1 on a light-theme panel. Fails WCAG
  wherever it lands on a light surface, not just the one dialog it was found in.
- Audit whether anything else in the monolith asserts on state a fixture step
  just wrote. The version guard was one instance of that shape, not the class.
- `ConfirmDialog` hierarchy, and an 8px dead gap from an empty faces span (both
  small, both in the `ui` worktree already).

**Method note worth keeping.** Requiring a RED proof on every ticket (revert
only the behavioural change, paste the failures) caught tests that were green
over live bugs four separate times in one session, including the version guard
above, a delete-outage test, and one case where a measurement helper was
silently changing the thing it measured. It is in
`.claude/skills/team/SKILL.md`.

## Found 2026-08-03, not yet fixed

- **A distilled summary's `ts` is written by the MODEL and trusted verbatim, so
  every teammate reads as hours dead while actively working.** The Stop hook
  asks the agent for `"ts":"<current UTC time, ISO-8601>"`; `lib/scan.js:517`
  takes that field as-is and only falls back to `new Date()` when it is
  absent. Models have no clock, so they estimate: the last six `ts` values in
  this machine's own `.membridge/summaries.jsonl` were `03:05:00`, `03:05:00`,
  `03:30:00`, `03:40:00`, `03:52:30`, `04:05:00` — all round numbers, newest 65
  minutes behind real time.

  Measured on the live backend (team `6ba3c572`): Andrew's rows were being
  written continuously while stamped hours earlier — `created_at 05:03:59Z` /
  `ts 00:04:48Z` (299m), `04:15:34Z` / `01:53:20Z` (142m), `04:07:34Z` /
  `00:40:51Z` (207m) — across five distinct recent sessions, so not backfill.

  Invisible to whoever has it: local sessions judge liveness from real
  transcript events (`session-events`), only teammates are judged on the
  written `ts` (`lib/feed.js:99` → `util.isLive`, 15-minute window). Everyone
  sees their own work as live and each other's as dead.

  Downstream, everything keys on it: the feed sorts on `ts`, and
  `lib/api-insights.js` splits current/prior windows on `Date.parse(r.ts)`, so
  activity is counted into the wrong window or dropped from both — which also
  means the new exact counts (027) count into the wrong buckets.

  Andrew called this on 2026-07-31 ("one bug, probably in the team pull") and
  had the location wrong; the pull is fine. `liveBasis` (PR #13) names what the
  flag rests on and is worth keeping, but it treats a symptom of this.

  **Decision needed (Andrew owns the distiller contract):** stamp `ts` at
  ingest from the daemon, which knows the real time when it reads the line, or
  keep the model's value in a separate field and stop letting it drive ordering
  and liveness. Cheap interim: clamp — reject future-dated, or anything older
  than the file's own mtime.

  **Blocks presence.** A heartbeat would show a teammate green while their
  entries kept arriving misdated, leaving every historical figure wrong with a
  live dot vouching for it.

- **The MemBridge MCP cannot currently answer "what is Andrew doing live right
  now" from the data it exposes.** `get_recent_activity` is registered as
  "newest-first AI activity" and combines local sessions with cached teammate
  activity, but its implementation reads only local state and cached pulled
  team rows (`lib/mcp.js:340`, `lib/activity.js:295`). In this Codex session it
  returned Marco's live local sessions but no live Andrew row; the newest Andrew
  row visible through project memory was a synced teammate summary from
  2026-08-01 19:00 UTC. Decide whether "live teammate presence" should mean
  cached team rows only, a backend poll for active remote sessions, or a separate
  clearly-labelled surface.

- **Answering the item above: live teammate presence is unbuilt, and the
  dashboard's "Happening now" is the surface that still implies otherwise.**
  The decision was option 1, qualify the claim rather than build presence or add
  a third surface; presence stays on the roadmap. Marco asked through the MCP
  whether he could see what Andrew was doing as we speak. He could not:
  `get_recent_activity` is a local read over `proj.teamEntries`
  (`lib/activity.js:222`), and the `live` flag on a team row is judged only on
  that row's ts (`lib/feed.js` `normalizeTeam`), so it is evidence of recent
  synced activity, never proof of a current remote session. The payload and the
  `get_recent_activity`/`why` tool descriptions now say so via `liveBasis`
  ('session-events' vs 'synced-row'), which is that fix. NOT fixed:
  `dedupeLiveSessions` in `ui/src/data/mappers.ts:397` filters Today's
  "Happening now" list and its "live now" count on that same `live` flag
  without reading `liveBasis`, so a teammate whose row synced inside the
  15-minute window still renders as working right now, with a live dot. Options
  are to filter Today on `liveBasis === 'session-events'` (honest, but removes
  teammates from the dashboard's presence surface entirely), or to render team
  rows there under separate wording such as "last synced". That is a product
  call, not a bug fix, and it overlaps the real presence feature already on the
  roadmap at `docs/guide.md:507`.

- **The invite URL the CLI prints cannot be redeemed.** `teamsync.inviteUrl`
  builds `<webUrl>/join/<token>`, but the hosted join page reads its token from
  the fragment only (`location.hash.slice(1)`,
  `cloudflare/join/public/index.html:107`). There is no worker and no
  `_redirects` under `cloudflare/join`, so `/join/<token>` is served by the SPA
  fallback (probed live: 200 text/html) and the token is simply ignored. The
  `membridge join <token>` line printed beneath it works, and the dashboard's
  MembersPage mints the hash form itself, so invites are not dead, but the
  clickable link a user would paste to a colleague is. Fix is `inviteUrl`
  returning the `#<token>` form. Deferred only because `lib/teamsync.js` was
  being edited by a parallel session.

## Found 2026-08-02 while dogfooding (cwd attribution now FIXED, see 08-04)

These came out of using the app rather than reading the code. Ordered by how
much they distort what a user sees. The first two are FIXED, see the section
above; they are left here for the reasoning that led to them.

- **Distillation stopped mid-session and nothing noticed.** Last summary written
  to `membridge/.membridge/summaries.jsonl` is `2026-08-02T00:35:00Z`. The
  session continued for hours past that and the Stop hook never prompted again.
  The hook IS registered in `~/.claude/settings.json` and its script IS readable
  (verified through Electron's fs), so the registration is not the problem. The
  hook appears to run and emit nothing. This is the highest-value open bug: the
  product's core loop silently stopped and the only symptom was a stale feed.

- **`isHookInstalled()` reports a false negative for every Electron install.**
  `lib/hooks.js` `commandIsLive` resolves the hook's script path with plain
  node's `fs`. The Electron registration points inside `app.asar`, which only
  resolves through Electron's patched `fs`, so a correct registration is judged
  dead. `membridge status` then says "Claude Code hook not installed" and tells
  the user to run `setup-hooks`, which would rewrite a registration that was
  already right. The irony is that `commandIsLive`'s own comment says it exists
  to close a hole; it opened the mirror-image one.

- **A session is attributed to its cwd, even when none of its edits are there.**
  Two days of membridge work landed under `mathetes` (270 events since Aug 2 vs
  6 for membridge) because the Claude Code session was started from
  `~/Desktop/mathetes`. MemBridge is doing what it was told: `cwd` is the signal
  it has. But `lib/project-resolve.js` already has `rehomeEvents`, and every
  edit event carries an absolute `ev.file`, so "most of this session's edits are
  under project X while it is filed under Y" is answerable with data already on
  hand. Do NOT auto-rehome silently. Surfacing it would have caught this on day
  one, and it belongs in the session analytics header.

## Known failing check, not a regression

`worktrees: a non-repo directory returns [] rather than throwing` fails on any
machine with a live git worktree, because it reads the real repository's
worktree registry rather than its own fixture. See `state.md`. Treat one
failure as green on such a machine; a second failure is real.
