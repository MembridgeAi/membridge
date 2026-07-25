# Solo onboarding: a guided first run, a first-class solo mode, and one path to a team

Date: 2026-07-25 · Scope: `lib/dashboard/` (app dashboard) + `scripts/install/install.sh.tmpl`

## The problem

MemBridge Beta installs and runs fine for one person, but nothing in the
product acknowledges that being one person is a normal, supported state. A
solo user is shown a Team tab, an `ENCRYPTED` badge and a `SYNCED` pill before
they have an account, a team, or anything being transmitted. "Synced" with no
team reads as "synced to a cloud", which contradicts the local-first promise
the same app makes on its sign-in screen.

Setup has the opposite problem: it is honest but thin. The first-run screen
([`client.js:1011`](../../../lib/dashboard/client.js), `renderProjectsEmpty`,
reached from `loadProjectsIndex` when no projects are watched) reports that
the daemon is running, lists detected tools, and offers to watch the projects
discovery found. That is a good skeleton. What it never does is say what a
solo user actually gets, or show the product working. The payoff — a memory
block written into `CLAUDE.md` that every tool reads at startup — is described
nowhere and demonstrated nowhere.

Both were confirmed by driving the running beta app, not by reading code
alone.

### Two defects found while auditing

- **Dead code with a hardcoded name.** `loadCatchup`, `renderWelcome` and
  `renderCatchup` ([`client.js:1219–1370`](../../../lib/dashboard/client.js))
  are unreachable: their only callers are click handlers that exist solely
  inside markup those functions render, so nothing can enter the loop. The v3
  Projects index replaced this surface and the old code was left behind. It
  hardcodes `Good morning, Marco` in two places, and it contains the old
  *"You're not on a team yet → Create an invite link"* home screen — exactly
  the framing this work replaces.
- **Badges that describe a relationship that does not exist.** The header
  ([`body.js:36–46`](../../../lib/dashboard/body.js)) renders `#e2eBadge` and
  `#pill` unconditionally. Encryption state and sync state are meaningless
  before a team exists.

## Goals

1. **A three-step first-run setup** that ends with the user having seen the
   product work, not having been told it will.
2. **A first-class solo mode** — the app states that you are solo, and every
   surface tells the truth about what is and is not leaving the machine.
3. **One guided team upgrade** with a prominent call to action, ending in a
   link the user can send someone.
4. **An installer that hands off** instead of stopping dead at "Done."

Explicitly *not* a goal: changing how the beta is distributed. The `gh`-gated
private release channel stays as it is.

## Design

### 1. First-run setup wizard

Shown when the dashboard opens with **no watched projects** and no recorded
completion. Completion is persisted as `setup.completedAt` in config via the
existing `POST /api/settings`, so the wizard never reappears once finished or
explicitly skipped.

It takes over the window rather than sitting in a modal — at this point there
is no dashboard content worth preserving behind it. **"Skip for now"** is
present on every step and leaves a persistent "Finish setup" link on the
Projects screen.

**Step 1 — What you get, on your own.** One line of value stated plainly:
your tools each keep their own history and forget each other; MemBridge gives
them one shared memory per project. Underneath, the live tool scan from
`GET /api/scan` as evidence the app already sees this machine
(`Claude Code ✓ · Codex ✓ · Cursor —`). One reassurance line: nothing leaves
this Mac, no account needed.

**Step 2 — Pick your projects.** The discovered list already returned by
`GET /api/scan` (`projects[]` with `tracked`, worktrees already folded into
their main repo), each row showing real weight — `AI — 336 sessions · Claude
Code`. The busiest few are pre-checked, the rest unchecked, with "Select all".
Manual path entry is demoted to a secondary link. Adoption uses the existing
`POST /api/projects/adopt`. **Finishing this step requires no typing.**

**Step 3 — Watch it work.** The step that does not exist today and carries the
most weight. It triggers `POST /api/sync` immediately — the history to distill
is already on disk, so there is nothing to wait for — then reads
`GET /api/project/memory` for the busiest adopted project and renders **the
actual block that was just written**, with its real path
(`~/Documents/AI/CLAUDE.md`). One line beneath it: every tool that reads this
file now starts with this. Hook installation and start-at-login are confirmed
here as quiet ticks, not as questions.

If the sync produces nothing (a project with no distillable history), the step
says so honestly and points at what will trigger the first block, rather than
rendering an empty card.

### 2. Solo mode

**Header.** `#e2eBadge` and `#pill` are suppressed while the user has no team,
replaced by a single chip reading **"Local only"**, whose tooltip states that
nothing leaves this Mac and no account exists. Both badges return, accurate,
once a team exists — encryption state is real information *then*.

**The upgrade call to action.** The `#openInvite` button slot becomes an
explicit **"Invite a teammate"** primary button, always visible to a solo
user. The **Team** tab stays in the nav as the permanent doorway. This is the
one place solo users are asked to consider a team; it is a standing
affordance, not a recurring nag, and no other screen interrupts to sell it.

**Smaller truths.** Activity hides its "Person" filter when the user is the
only person. Settings gains a solo section: where memory lives
(`~/.membridge-beta`), autostart state, hook state, and the same upgrade CTA
— so Settings stops being only a project list.

The existing honest solo touches stay: `2 projects, all local` on the Projects
index and its "Working with others? Create a team" footer line.

### 3. Team upgrade flow

Entered from the header CTA or the Team tab. Replaces today's behavior, where
a solo user reaches `teamScreenNone` ([`client.js:332`](../../../lib/dashboard/client.js))
and meets a sign-in wall whose only explanation is "A team is two or more
people whose session memories sync."

1. **What changes.** Teammates' distilled sessions land in your projects'
   context files and yours in theirs; content is redacted before it leaves,
   end-to-end encrypted, and projects share only when you say so.
2. **Account.** Sign up or sign in — GitHub or email, reusing
   `/api/team/signup`, `/api/team/login`, `/api/team/oauth-complete` — framed
   as *so teammates can find you*, not as a gate.
3. **Name the team and choose what to share.** `POST /api/team/create`, then
   per-project `POST /api/team/link`. Nothing is shared by default; each
   project is opted in explicitly.
4. **The link.** `POST /api/team/invite`, rendered as a large copyable invite
   link with "send this to your teammate". Done lands on the now-populated
   Team screen.

Every step can fail (offline, backend unreachable, auth rejected). Each
failure states what happened and leaves the user **cleanly solo** — never in a
half-upgraded state. A user who abandons the flow mid-way is solo, not broken.

### 4. Cleanup

Delete `loadCatchup`, `renderWelcome`, `renderCatchup` and their orphaned
handlers. This removes the hardcoded `Good morning, Marco`, removes the
superseded "not on a team yet" home screen, and makes `client.js` smaller on
net despite the feature growing.

### 5. Installer handoff

`scripts/install/install.sh.tmpl` keeps its preflight, pinning, checksum
verification and CLI wrapper untouched. Only the closing message changes: what
was installed, that it runs local-only with no account, and that the app is
now opening into setup. It ends by pointing at the next step instead of
stopping at "Done."

## File layout

`lib/dashboard/client.js` is already 4,086 lines. None of this goes into it.

| File | Contents |
| --- | --- |
| `lib/dashboard/setup.js` | first-run wizard: step state, the three screens, completion |
| `lib/dashboard/upgrade.js` | team upgrade flow: step machine, the four screens, failure paths |
| `lib/dashboard/solo.js` | solo/team state resolution; header chip and CTA rendering |

`client.js` keeps routing and hands off to these; `body.js` gains the mount
points. Each new file is one screen's worth of behavior, readable on its own.

## Testing

The decisions worth pinning are the pure ones, and they go in the existing
`test/run-tests.js`:

- **Setup gating** — wizard shows only with zero watched projects and no
  `setup.completedAt`; skip records completion state correctly.
- **Project preselection** — which discovered projects arrive pre-checked,
  given a scan payload; already-tracked projects never appear.
- **Header state** — solo vs signed-in-without-team vs on-a-team produces the
  right chip, and `ENCRYPTED`/`SYNCED` appear only in the last case.
- **Upgrade step machine** — forward transitions, and that each failure path
  lands in a clean solo state rather than a partial one.

Rendered screens are verified by driving the running app directly — that is
what surfaced the badge problem in the first place, and it catches what unit
tests on markup strings would not.

## Out of scope

- Distribution changes to the beta channel (`gh` requirement stays).
- Anything about the web workspace in `web/`.
- Team screen internals beyond the entry flow — members, roles, key
  management and invite revocation are unchanged.
