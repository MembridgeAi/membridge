# Cutover checklist: deleting `lib/dashboard/*` and `web/`

The new React UI (`ui/`) is mounted at `/app`, alongside the legacy
dashboard, which stays the default at `/`. This is deliberate: Task 15 wires
up serving, nothing more. `lib/dashboard/*` and `web/` stay on disk, fully
working, until a human runs through this checklist on a **packaged app** —
not `npm run dev`, not a bare `node bin/membridge.js start` — and signs off.

Do not delete `lib/dashboard/*` or `web/` until every box below is checked.

## Why the packaged app, specifically

`scripts/prepare-app.js` copies `lib/`, `bin/`, `node_modules`, and (as of
Task 15) `ui/dist` into `app/`, and the packaged build is what
electron-builder actually ships. A dev-server smoke test does not exercise
that copy step, does not exercise the built (minified, hashed) UI assets,
and does not exercise the platform-specific packaging quirks (code signing,
asar path resolution) that only show up once the app is built for real. Any
of those can silently pass in dev and fail in the packaged binary.

## How to build the packaged app for this checklist

1. `cd ui && npm run build` — regenerate `ui/dist` from current source.
2. `node scripts/prepare-app.js` — refresh `app/lib`, `app/bin`,
   `app/node_modules`, `app/vendor`, and `app/ui/dist`.
3. Build and install the platform package (electron-builder) and run the
   installed app — not the source tree directly.

Repeat this on **both** macOS and Windows; a checklist run on only one
platform does not clear this list.

## Screens to exercise (every one, in the packaged app)

For each screen below, confirm it renders with real (or realistic seeded)
data, matches the approved mockup's layout and copy, and has no console
errors:

- [ ] Today (`/app`) — live session intent rows, project metrics
- [ ] Projects (`/app/projects`) — grid, bulk access editing
- [ ] Project detail (`/app/projects/:name`) — merged stream, access panel
- [ ] Members (`/app/team/members`) — roles, invites, audit trail
- [ ] Insights (`/app/team/insights`) — skeleton stat, severity tiers
- [ ] Settings (`/app/settings`) — delivery channels, privacy, daemon control

## States to exercise

Each screen above must be checked under every state that changes what it
renders, not just its default state:

- [ ] **Light theme** and **dark theme** — both, for every screen above
- [ ] **Solo mode** — team surfaces (Members, Insights, team switcher) are
      absent, not disabled or greyed out; no upsell anywhere
- [ ] **Team mode** — team switcher and nav present, at least one other
      member visible
- [ ] **A member-role account** — signed in as `member`, not `owner`/`admin`;
      confirm Members/Insights nav is hidden per the role gate in
      `ui/src/app/Shell.tsx`, and that `/api/team/access-matrix` and
      `/api/team/audit` return 403 for this account (the UI must never be the
      only thing enforcing this)
- [ ] **A behind project** — a project whose `sync` state is `behind` renders
      `⚠ behind · <date>` and a working `Sync now` button (never a bare
      timestamp, per the copy rule in the plan's Global Constraints)
- [ ] **A broken member** — a teammate whose sync/key state is broken (e.g. a
      `keyAlert`, or a project with zero shared entries from them) renders
      with a glyph and words, never color alone

## Platform parity

- [ ] Every screen and state above, exercised on **macOS**
- [ ] Every screen and state above, exercised on **Windows** — this is the
      one most likely to be skipped; do not skip it. Check in particular:
      window chrome/scrollbars (`scrollbar-gutter: stable` holding), `Ctrl`
      appearing instead of `Cmd` in any shortcut hints, and that no path
      constructed by `lib/server.js`'s `/app` static serving 404s or 500s on
      Windows path separators

## Automated suite

- [ ] `node test/run-tests.js` — full root suite green, run on **macOS**
- [ ] `node test/run-tests.js` — full root suite green, run on **Windows**
      (via the CI matrix added in Task 16, or a local Windows machine/VM)
- [ ] `cd ui && npx vitest run` — full UI suite green

## Sign-off

Record here once every box above is checked, by whom, and on what commit:

- [ ] Verified by: ______________  Commit: ______________  Date: ______________

Only after this line is filled in should a follow-up change delete
`lib/dashboard/*` and `web/`, and switch `/` to serve `ui/dist` directly.
