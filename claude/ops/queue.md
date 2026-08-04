# Queue

What is being worked and in what order. `canonical-sources.md` lists this file
in the fresh-session read order; it did not exist until 2026-08-02, so anything
before that date was tracked in `state.md`'s "Not done" section instead.

`decisions.md` holds settled reasoning. `state.md` holds verified current
state. This file holds only what is next.

---

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

## Logged, not scheduled

These are real gaps found while doing other work. Neither is a defect in
something that was asked for, and neither is being fixed yet.

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

## Found 2026-08-03, not yet fixed

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

## Found 2026-08-02 while dogfooding, not yet fixed

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
