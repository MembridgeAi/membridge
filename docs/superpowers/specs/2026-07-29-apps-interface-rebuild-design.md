# MemBridge interface rebuild — design

Date: 2026-07-29
Status: approved mockups, pending implementation
Branch: `claude/apps-interface-rebuild-476701`

## 1. Goal

Replace the MemBridge interface with a ground-up rebuild that is fast,
team-first, and platform-neutral. Team pages are the default experience; solo is
the same app with team parts absent. Managing a team — roles, invites, and who
sees which project — happens in the interface, not in config files.

This is a replacement, not a refactor. The current UI (`lib/dashboard/*`, a
4,414-line `client.js` served as template literals, plus the separate half-built
`web/` Next.js app) is retired once the rebuild reaches parity on the screens
below.

### Why the current UI is being replaced

- `lib/dashboard/client.js` is one 4,414-line template literal. A stray
  backtick in any added line breaks `require` (has happened twice).
- Two divergent surfaces: the desktop dashboard and `web/`. Team pages must be
  built twice and drift.
- No component boundaries, so every change risks unrelated views.

## 2. Scope

**In:** Today, Projects, project page, Members, Insights, Settings, and the solo
variants of each. Roles and invites. Per-project access control. Admin
oversight (audit trail, per-member sync/encryption health).

**Out:**

- **Roadmaps / BYOK planner — build nothing.** No Plan tab, no goal box, no API
  key field, no planner-model picker. `PLAN.md` M2/M3 describes this as the
  headline feature; that is superseded. `lib/advisor.js` and `lib/advisors/`
  stay on disk with no UI surface.
- Billing and seat management (no pricing exists yet).
- The neural map / 3D graph.
- Changes to adapters, the daemon's capture pipeline, or the sync protocol,
  except the two prerequisites in §9.

## 3. Approved screens

Mockups live in `.superpowers/brainstorm/24172-1785362070/content/`. The
approved version of each is named below.

### 3.1 Today — `today-v15.html`

The team-first home. Answers "what happened, and is anything broken."

| Region | Content | Source |
| --- | --- | --- |
| Stat strip | live now · sessions today · updates shared · members synced | `/api/status`, `/api/feed` |
| Happening now | one row per running session: person, tool, project, elapsed, and the session's **intent** (its opening ask, verbatim and redacted) | live sessions from `/api/feed` |
| Projects · this week | per project: name, shared/private, member avatars, latest summary; right-anchored metrics block with `N sessions · last 7 days` and sync state, activity sparkline directly beneath | `/api/projects` |

Rules settled during review:

- Live rows show **intent only**. Never infer or narrate what a running session
  is "doing" — intent is the one thing actually captured.
- Sync state reads **`✓ up to date`** with no timestamp. Only a project that is
  behind shows a date (`⚠ behind · Jul 23`) and gets a **Sync now** button.
  Up-to-date rows have no button.
- `last 7 days` means the trailing 7 days through now. Spelled out, never `7d`.

### 3.2 Projects — `projects-list-v2.html`

Every project in one grid with **a column per teammate**. Ticking a cell grants
or revokes that person's access without opening the project. This is the bulk
half of the who-sees-what requirement.

- Columns: project (+ path), sessions · 7d, last activity, sync, one per
  member, open.
- Private projects show dashed, disabled cells — nobody can be granted access
  until the project is shared.
- Member columns are visible to admins and owners only. A member sees a single
  column: their own access.
- Wide table scrolls inside its own container; the page never scrolls sideways.
- Every change is written to the audit trail (§3.4) and applies immediately.

### 3.3 Project page — `project-v4.html`

Two columns.

**Left — the merged stream.** Day-grouped, your sessions and teammates'
interleaved. Each entry: person, tool, time, the outcome in full, the original
ask beneath as a muted `INTENT` line, and touched files in mono. Live sessions
marked.

**Right — three panels:**

1. **Who sees this project** — one toggle per member with role shown. Turning
   someone off states the consequence in plain words ("Sarah can't see this
   project's memory or activity"). Plus the per-project default, "New members
   join with access."
2. **Memory · this project** — status, last update and which agent produced it,
   entry count, link to `memory.md`. Project-specific only; the machine-level
   delivery plumbing is explained once in Settings, not repeated per project.
3. **Sync** — team sync state, encryption state, sessions/people this week.

Header actions: Copy for AI, Pause, Sync now.

### 3.4 Members — `team-v1b.html`

- **Pending invites** at the top: email, time remaining, Resend, Revoke.
- **Member rows**: name, email, role (dropdown; Owner fixed), project count,
  sync state, key-verified state. A broken member is stated plainly in amber
  ("paused 2 days — token expired").
- **⋯ menu** per row: Change role, **Remove from team**, and for Owner only,
  Transfer ownership. Removal revokes access to every shared project
  immediately and is confirmed in a dialog.
- **Defaults**: whether new projects auto-share, stay private, or ask.
- **Audit · last 30 days** in the right column: joins, role changes, sharing
  changes, invites, team creation — actor, object, timestamp.

### 3.5 Insights — `insights-v4.html` (team only)

Built only from data the daemon already has. No new tracking.

- Stat strip: sessions (with trend), **repeat opens answered by memory** (the
  headline effectiveness number), members syncing, entries shared.
- Activity by person: sessions and how many produced a shared summary.
- **How well the skeleton is working** — exactly two lines: repeat file opens,
  and answered by our memory first (count + percent).
- Most active projects.
- **Broken** vs **Minor**, visually distinct:
  - *Broken* (red): nothing is reaching the team — e.g. "Sarah's summaries never
    arrive · 47 of 47 sessions · hook not installed since she joined." Carries
    the fixing action.
  - *Minor* (grey): isolated, quoted with its denominator — "2 sessions missing
    summaries · of 412."
  - **Severity is decided by scale and persistence, not kind.** The same symptom
    is Minor at 2-of-412 and Broken at 47-of-47.
- Knowledge concentration: projects only one person has ever touched.
- Cross-tool reach: sessions per tool.
- No "when the team works" heat grid (cut in review).

### 3.6 Settings — `settings-solo-v2.html`

One page, four groups. Machine-level, explained once.

1. **Memory delivery** — context block (and which files), recall on read,
   session summaries, MCP server. Each shows real installed state; a gap is
   amber with the action that fixes it.
2. **Privacy** — plaintext sharing (off = end-to-end), redaction pattern counts,
   excluded folders.
3. **Daemon** — running state, port, version, start at login, sync interval,
   updates.
4. **Team** — your role, member count, Manage, Leave.

### 3.7 Solo — second frame of `settings-solo-v2.html`

The same pages with team parts **absent, not disabled**: no team switcher, no
Members or Insights, no avatars, no "who sees this" panel. Projects read
**Local only**. One dashed sidebar invitation to create a team. The skeleton
effectiveness stat still appears — it is just as useful alone.

A solo user must never see a control they cannot use. No greyed-out team
features, no upsell modals.

## 4. Visual system

Locked during review (`today-v10` → `v11` established it). Extracted to
`ui/src/styles/tokens.css`; every screen uses it.

- **Radius:** one value, 4px, everywhere. No pills, no `rounded-full`. Sole
  exception: avatars are circles — people are round, chrome is square.
- **No cards.** Structure comes from 1px hairlines and background shifts.
  Sections are flat and ruled, not floating boxes.
- **Shadows:** none on resting content. One subtle level, reserved for true
  overlays (menus, dialogs).
- **Density:** instrument panel, not marketing page. ~35% tighter than the
  previous dashboard. Data rows are compact ruled rows.
- **Buttons/inputs:** rectangles defined by border or solid fill. No gradients,
  no drop shadows, no scale-on-hover. Hover changes background or border only.
- **Numbers:** monospace with tabular figures. Stat labels small, uppercase,
  muted. Stats in a ruled grid, never big-number-in-a-card.
- **Icons:** small, one set, single color inherited from text. Never in tinted
  containers.
- **State colors:** green = healthy, amber = attention, red = broken. Soft tints
  behind state text; state is never conveyed by color alone (each carries a
  glyph and words).
- **Themes:** dark and light from the same tokens, brand blue `#4D7CFF` /
  `#0052FF` retained.

## 5. Architecture

### 5.1 Stack

React + Vite, compiled to static assets. TypeScript. A small router
(`wouter` or `react-router`) and TanStack Query for fetching, caching, and
background refresh. Vitest + Testing Library for unit/component tests.

Runtime dependencies are not a constraint — the package already ships
`@modelcontextprotocol/sdk`, `libsodium-wrappers`, `web-tree-sitter`, `zod`.

### 5.2 One UI, two hosts

```
        ui/  (React + Vite → static assets)
              │
      ┌───────┴────────┐
   desktop           hosted
 daemon serves     Cloudflare/static
 built assets      serves built assets
      │                 │
 LocalDaemonClient   TeamBackendClient
 (127.0.0.1 API)     (Supabase + RLS)
              │
        DataClient interface
```

The UI never talks to a transport directly. It calls a `DataClient` interface;
two implementations satisfy it. Screens are identical, so team pages cannot
drift between the app and the browser. Solo-only capabilities (paths, daemon
control, hooks) are declared as optional capabilities on the client, and
components hide what the active client does not support.

### 5.3 Layout

```
ui/
  src/
    app/          router, shell, providers
    data/         DataClient interface, local + team implementations, types
    features/
      today/  projects/  project/  members/  insights/  settings/
    components/   ruled table, stat strip, state chip, toggle, avatar, sparkline…
    styles/       tokens.css
```

Files stay under ~300 lines; a feature folder owns its screen and its queries.
No file is allowed to become the new `client.js`.

### 5.4 Serving

- **Desktop:** `lib/server.js` serves `ui/dist` as static files with a SPA
  fallback, replacing the template-literal renderers. `lib/dashboard/*` is
  deleted once parity lands. Assets are content-hashed; the daemon sets
  long-cache headers for hashed files and no-store for `index.html`.
- **Hosted:** the same `ui/dist` deployed for browser-only teammates, with
  `TeamBackendClient` talking to Supabase. `web/` (Next.js) is removed.
- The daemon keeps binding `127.0.0.1` only.

## 6. Data

### 6.1 Reused endpoints

`/api/status`, `/api/projects`, `/api/project`, `/api/project/memory`,
`/api/feed`, `/api/settings`, `/api/sync`, `/api/team`, `/api/team/members`,
`/api/team/feed`, `/api/team/projects`, `/api/team/invite`,
`/api/team/rotate-invite`, `/api/team/revoke-invite`, `/api/team/set-role`,
`/api/team/remove-member`, `/api/team/leave`, `/api/team/link`,
`/api/team/unlink`, `/api/projects/toggle`, `/api/projects/add`,
`/api/projects/remove`, `/api/projects/copy`.

Advisor/plan endpoints (`/api/advisor*`, `/api/plan/generate`) are not called by
the new UI.

### 6.2 New endpoints

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `GET /api/project/access` | per-member access for one project | derived from existing share state |
| `POST /api/project/access` | grant/revoke one member | `{projectKey, memberId, canSee}`; admin/owner only; writes audit |
| `GET /api/team/access-matrix` | all projects × all members for the Projects grid | one request, not N |
| `GET /api/team/audit` | audit rows, paginated | new table, §6.4 |
| `GET /api/team/insights?window=7\|30\|90` | Insights aggregates | server-side aggregation, not raw rows |
| `GET /api/skeleton-stats?window=` | repeat file opens + answered-by-memory | from the recall ledger, §9 |

All new endpoints return the existing envelope shape and validate input with
`zod` at the boundary.

### 6.3 Roles

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| See shared projects they have access to | ✓ | ✓ | ✓ |
| Invite / revoke invites | ✓ | ✓ | — |
| Change roles | ✓ | ✓ (not Owner) | — |
| Remove members | ✓ | ✓ (not Owner) | — |
| Grant/revoke project access for others | ✓ | ✓ | — |
| Change team defaults | ✓ | ✓ | — |
| See audit trail and Insights | ✓ | ✓ | — |
| Transfer ownership / delete team | ✓ | — | — |

Enforced server-side and in Supabase RLS. The UI hides what a role cannot do
rather than disabling it. Exactly one Owner; transfer is explicit.

### 6.4 New tables

- `team_audit` — `id, team_id, actor_id, action, object_type, object_key,
  detail jsonb, created_at`. RLS: readable by owner/admin of that team,
  insert-only via server.
- `project_access` — `team_id, project_key, member_id, can_see, updated_at,
  updated_by`. Absence of a row means "team default applies."

Migrations are numbered from **018** onward. Prior numbers are contested:
015 is squatted (`015_feedback` on master vs. the manually applied join-seal
SQL) and two competing 016s exist. Verify the live schema before numbering, and
never reuse a number.

## 7. Performance

Concrete targets, measured on the desktop app with a 3-project / 400-session
local dataset:

- Cold window open to first meaningful paint: **< 700 ms**.
- Tab switch: **< 100 ms**, no spinner for cached data (stale-while-revalidate).
- No full-page re-render on refresh; only changed rows repaint.
- Feed and stream lists virtualize past 100 rows.
- Poll only what is visible: Today polls live sessions every 10 s; background
  tabs stop polling entirely (`document.hidden` — note this previously blanked
  the dashboard during recording; the fix is to pause polling, not unmount).
- One request per screen. The Projects grid loads the whole access matrix in a
  single call — never one request per project or per member.
- Aggregation for Insights happens server-side.

## 8. Windows compatibility (first-class)

Windows is a supported target for this UI, not an afterthought. `dist:win`
already exists and the codebase handles Windows in places (`autostart.js`,
`keychain.js`, `normPath` case-folding in `util.js`, CRLF-aware
`mcp-toml.js`) — the rebuild must not regress that, and closes the gaps below.

**UI requirements**

- Font stacks name Windows faces explicitly: UI text
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`; mono
  `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace`.
  Never assume SF Mono resolves.
- Modifier keys resolve per platform: `Ctrl` on Windows, `Cmd` on macOS, in both
  shortcut handlers and any hint text.
- Scrollbars: Windows renders visible scrollbars that consume layout width.
  Wide containers must not shift; use `scrollbar-gutter: stable` where a
  scrollbar can appear.
- Window chrome differs (no traffic lights). The shell must not hardcode macOS
  inset padding; header padding comes from a platform-aware token.
- No emoji-as-icon anywhere text metrics matter — Windows substitutes different
  glyph widths.

**Paths and data**

- All paths shown in the UI render POSIX-style for readability but are treated
  as opaque strings; the UI never parses, splits, or joins them. Path handling
  stays server-side (`repoRoot.ledgerKeyFor` / `wireKeyFor`).
- Project identity keys must never be derived from a UI-supplied path. Marco
  works almost entirely in `.claude/worktrees/<name>`, and project-relative
  keys fragment per worktree — the existing rule stands.
- Case-insensitive filesystem: comparisons of project keys in the UI use the
  server-normalized key, never a raw string compare.

**Prerequisite bug (found while writing this spec)**

`lib/digest.js:497` builds the memory block with hard `\n` joins and
`inject()` splices it in without detecting the file's existing line endings.
`lib/mcp-toml.js:59` already does this correctly (`eolOf`). On Windows a CRLF
`CLAUDE.md` receives an LF block: mixed endings and a whole-file git diff.
Fix `digest.js` to detect and preserve the target file's EOL before the UI
claims "context block ✓ installed."

**Build and packaging**

- npm scripts must be shell-neutral: no `rm -rf`, no `&&`-chained POSIX
  utilities, no shell globs. Use Node for file operations
  (`node -e`, `rimraf`-style helper, or `fs.rm`).
- `ui/dist` paths are joined with `path.join`, never string concatenation with
  `/`.
- CI runs the test suite and the UI build on **both** `macos-latest` and
  `windows-latest`. A Windows failure blocks merge.

**Verification**

Windows checks are part of done, not follow-up: the UI build, the test suite,
static serving from the daemon, and a manual pass of all seven screens in the
packaged `dist:win` app.

## 9. Prerequisites

1. **`digest.js` EOL preservation** (§8). Small, and the UI reports on it.
2. **Recall ledger merge.** The skeleton-effectiveness numbers (§3.5) come from
   the recall layer, which is built but unmerged, and whose savings are
   unmeasured. Until it lands, `/api/skeleton-stats` returns
   `{available: false}` and the UI shows the stat as *pending*, never a
   fabricated number.
3. **Live sessions in flight.** Implementation starts only after the running
   hook-firing session lands, so the rebuild does not race changes to
   `lib/hooks.js` / `lib/membridge-hook.js`.

## 10. Build order

| Phase | Deliverable | Done when |
| --- | --- | --- |
| P0 | `ui/` scaffold, tokens, `DataClient` interface + local implementation, shell with routing | shell renders in the daemon, dark + light, macOS + Windows |
| P1 | Today | matches `today-v15`, live via real `/api/feed` |
| P2 | Project page + project access panel | toggling access changes real share state |
| P3 | Projects grid + `access-matrix` endpoint | bulk access edits work, single request |
| P4 | Members + invites + roles + audit trail | remove/role-change enforced server-side and in RLS |
| P5 | Insights | Broken/Minor tiers driven by real health data |
| P6 | Settings | every row reflects and controls real state |
| P7 | Solo variants + first-run | no team → no team surface anywhere |
| P8 | Cutover | `lib/dashboard/*` and `web/` deleted; hosted build deployed |

Phases P1–P7 each ship behind the same route table, so the app is usable
throughout; the old dashboard stays reachable at `/legacy` until P8.

## 11. Testing

- **Component tests** per screen against a fake `DataClient`: empty, loading,
  error, solo, member-role, and broken-health states.
- **Contract tests** on both `DataClient` implementations against the same
  suite, so desktop and hosted cannot diverge silently.
- **Permission tests**: a Member must not be able to read the audit trail,
  change roles, or grant access — asserted at the API and RLS layers, not just
  hidden in the UI.
- **Path/identity tests**: worktree-prefixed project keys resolve to the same
  project (regression on the fragmenting-keys bug).
- **EOL test**: injecting into a CRLF file leaves the file CRLF throughout.
- **Ports**: the suite must keep using probed port blocks; never hardcode
  17941/17961, which the live daemon can squat.
- The existing suite (`node test/run-tests.js`) stays fully green, offline, with
  no network access. Record the pass count before starting and match or exceed
  it at every phase boundary.

## 12. Risks

| Risk | Handling |
| --- | --- |
| Migration numbering collision (015/016 contested) | verify live schema, number from 018, never reuse |
| Skeleton stats unavailable at ship | explicit `available: false` + pending state; never fabricate |
| Cutover breaks the installed app | `/legacy` route until P8; packaged-app verification on both platforms before delete |
| Hosted and desktop drift | one `DataClient` contract suite run against both |
| Windows regressions | CI on `windows-latest` blocking, plus packaged-app pass |
| Access-control mistakes leak a private project | server-side + RLS enforcement, permission tests, every change audited |

## 13. Decisions on record

1. One unified UI for desktop and hosted — not desktop-only.
2. New layout, existing brand kept.
3. React + Vite SPA with a swappable data layer — not Next.js, not the
   template-literal approach.
4. Team management scope: roles + invites, project access control, admin
   oversight. Billing excluded.
5. Live session cards show captured intent only.
6. Sync state: `up to date` bare; date and a Sync button only when behind.
7. Insights headline = repeat opens answered by memory; two supporting lines
   only; no heat grid; no summary-rate stat.
8. Problem severity by scale, not kind — Broken vs Minor.
9. **Roadmaps/BYOK: build nothing.** `PLAN.md` M2/M3 superseded.
10. Windows is a first-class target with blocking CI.
