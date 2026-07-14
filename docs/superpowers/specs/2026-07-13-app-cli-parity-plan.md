# App/CLI Parity Plan

_Date: 2026-07-13 · Branch: brown_

## Principle

App-first, CLI-second. Every CLI feature must have an app equivalent. The
dashboard UI must be extremely clean — no feature dumping. Group controls
logically, use the existing design system (dark theme, cards, `--accent`/
`--accent2` gradient highlights, `.btn`, `.card`, `.st-row` patterns).

## Gap audit

| CLI command | App equivalent today | Gap |
|---|---|---|
| `start / stop / status` | Tray menu (running/paused, sync now) | None |
| `dashboard` | App opens it natively | None |
| `sync --dry-run --project` | "Sync now" button (no dry-run, no per-project) | Minor |
| `scan` | — | **Full gap** |
| `remove --project` | — | **Full gap** |
| `setup-hooks / remove-hooks` | — | **Full gap** (consent popup addresses first-run; ongoing toggle missing) |
| `enable-autostart / disable-autostart` | Tray menu "Start at login" checkbox | None |
| `signup / login / logout` | Dashboard auth view | None |
| `join` | Dashboard team join | None |
| `team create` | Dashboard team create | None |
| `team invite` | Dashboard "Copy invite link" | Partial (no `--expires-days`, `--max-uses`) |
| `team revoke-invite` | — | **Full gap** |
| `team join` | Dashboard team join | None |
| `team link / unlink` | Dashboard project team link/unlink | None |
| `team list` | Dashboard team view | None |
| `team setup` (self-host) | — | **Full gap** (advanced, low priority) |
| `hook stop` | N/A (hook runtime, not user-facing) | N/A |
| distill config (`minEdits`, `checkpointEvery`, `enabled`) | — | **Full gap** |

---

## Implementation: 6 features, grouped into Settings sections

All new controls go into the existing **Settings** view (`#settings`), except
`scan` which becomes a new section on the **Overview** view and `remove` which
goes into the project detail Memory tab.

### Feature 1: Distillation controls (Settings → new "Session summaries" card)

**What it does:** Replaces the need for `setup-hooks`, `remove-hooks`, and
raw config editing of `distill.*`.

**UI — new card in `#view-settings`:**

```
┌─────────────────────────────────────────────────────┐
│  Session summaries                                  │
│                                                     │
│  When an AI tool finishes work, MemBridge can ask   │
│  it to leave a short note for your other tools.     │
│                                                     │
│  ┌─ Toggle ──────────────────────────────────────┐  │
│  │  Summaries               [ON]                 │  │
│  │  Claude Code hook        Installed ✓          │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌─ Advanced ────────────────────────────────────┐  │
│  │  Ask after          [ 1 ] edits               │  │
│  │  Re-ask every       [ 4 ] edits               │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  [Save]                                             │
└─────────────────────────────────────────────────────┘
```

**Backend:**

- `GET /api/settings` — already returns full config; add `hookInstalled` field
  (call `hooks.isHookInstalled()`).
- `POST /api/settings` — accept `distill: { enabled, consent, minEdits,
  checkpointEvery }`. When toggling summaries on, call `hooks.setupHooks()`;
  when off, call `hooks.removeHooks()`.

**Files:** `lib/server.js` (settings endpoint), `lib/dashboard.js` (new card HTML + JS).

### Feature 2: Remove memory block (Project detail → Memory tab)

**What it does:** Replaces `membridge remove --project <path>`.

**UI — add button to the project Memory tab, below the Pause/Delete row:**

```
┌─────────────────────────────────────────────────────┐
│  Injected memory block                              │
│                                                     │
│  Strip the MemBridge block from this project's      │
│  context files. History is kept — syncing will       │
│  re-add it unless you pause first.                  │
│                                                     │
│  [Remove block]                                     │
└─────────────────────────────────────────────────────┘
```

Clicking shows a confirmation ("Remove block from CLAUDE.md and AGENTS.md?")
then calls `POST /api/projects/remove`.

**Backend:**

- New route `POST /api/projects/remove` — accepts `{ path }`, calls the same
  removal logic as `cmdRemove` in the CLI (the `digest.removeBlock` or
  equivalent).

**Files:** `lib/server.js` (new route), `lib/dashboard.js` (button + handler),
`lib/digest.js` (extract removal logic into a reusable function if not already).

### Feature 3: Scan / discovery view (Overview → new section or modal)

**What it does:** Replaces `membridge scan` — shows which adapters are found,
which session directories exist, which projects have activity.

**UI — link in the Overview header area, opens an inline section or modal:**

```
┌─────────────────────────────────────────────────────┐
│  Detected tools                                     │
│                                                     │
│  Claude Code    ~/.claude/projects     ✓            │
│  Codex          ~/.codex/sessions      ✓            │
│  Custom         (not configured)                    │
│                                                     │
│  Projects with AI activity: 4                       │
│  shop-app          Claude Code: 12, Codex: 3        │
│  api-server        Claude Code: 8                   │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

Read-only, informational. Uses the same `getAdapters` + fresh-scan logic as
`cmdScan`.

**Backend:**

- New route `GET /api/scan` — runs a read-only scan pass and returns adapters +
  project-event counts.

**Files:** `lib/server.js` (new route), `lib/dashboard.js` (new UI section).

### Feature 4: Revoke invite (Team view)

**What it does:** Replaces `membridge team revoke-invite <token>`.

**UI — in the team card, next to "Copy invite link":**

Each active invite shows a small "Revoke" button or link. Clicking confirms
("Revoke this invite link? Anyone who hasn't used it yet won't be able to join.")
then calls the API.

```
┌─────────────────────────────────────────────────────┐
│  Your team: Acme                                    │
│                                                     │
│  Invite link  [Copy link]  [Revoke]                 │
│                                                     │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

**Backend:**

- New route `POST /api/team/revoke-invite` — accepts `{ token }`, calls
  `teamsync.revokeInvite()`.

**Files:** `lib/server.js` (new route), `lib/dashboard.js` (button + handler).

### Feature 5: Invite options (Team view — expires, max-uses)

**What it does:** Replaces the `--expires-days` and `--max-uses` flags on
`membridge team invite`.

**UI — expand the existing invite flow with optional fields:**

When clicking "Copy invite link" or a new "Create invite" button, show a small
inline form:

```
  Expires in   [ 7 ] days     (leave blank for no expiry)
  Max uses     [ ∞ ]          (leave blank for unlimited)
  [Create & copy link]
```

**Backend:** The `POST /api/team/invite` endpoint already exists — add support
for `expiresDays` and `maxUses` params (pass through to `teamsync.createInvite`).

**Files:** `lib/server.js` (update invite route), `lib/dashboard.js` (form UI).

### Feature 6: Self-host backend (Settings → new card, low priority)

**What it does:** Replaces `membridge team setup --url ... --anon-key ...`.

**UI — new card at the bottom of Settings, collapsed by default:**

```
┌─────────────────────────────────────────────────────┐
│  ▸ Advanced: self-hosted backend                    │
│                                                     │
│  (expanded)                                         │
│  Point MemBridge at your own Supabase backend       │
│  instead of the hosted one.                         │
│                                                     │
│  URL        [ https://....supabase.co   ]           │
│  Anon key   [ eyJ...                    ]           │
│                                                     │
│  [Save]  [Reset to default]                         │
└─────────────────────────────────────────────────────┘
```

**Backend:** `POST /api/settings` already handles config writes — just add
`team: { url, anonKey }` to accepted fields.

**Files:** `lib/server.js` (settings route update), `lib/dashboard.js` (card).

---

## Execution order

Priority by user impact, with dependencies noted:

| Order | Feature | Depends on | Effort |
|-------|---------|------------|--------|
| 1 | Distillation controls | Consent popup (separate plan) | Medium |
| 2 | Remove memory block | — | Small |
| 3 | Scan / discovery view | — | Small |
| 4 | Revoke invite | — | Small |
| 5 | Invite options (expires, max-uses) | — | Small |
| 6 | Self-host backend | — | Small |

Features 2–6 are independent of each other and can be parallelized across
agents. Feature 1 should come after the consent popup lands because the
distillation card's "Summaries" toggle reads and writes the same `consent` field.

## Design constraints

- **No new views/tabs.** Everything fits into existing Settings, Overview, and
  project detail views. The dashboard already has 5 tabs — adding more dilutes
  the navigation.
- **Same design system.** Dark theme, `.card` containers, `.btn` / `.btn.primary`
  / `.btn.del` buttons, `.st-row` label+input layout, `.m-help` descriptions,
  `--accent` green and `--accent2` blue for highlights.
- **Progressive disclosure.** Advanced controls (minEdits, checkpointEvery,
  self-host) are collapsed or separated from the main toggle. Clean defaults,
  power when you dig.
- **No external deps.** The dashboard is self-contained vanilla JS/HTML — no
  framework, no build step, no CDN.

## File summary

| File | Changes |
|------|---------|
| `lib/server.js` | New routes: `/api/scan`, `/api/projects/remove`, `/api/team/revoke-invite`. Update: `/api/settings` (distill fields, team self-host), `/api/team/invite` (expires, max-uses). |
| `lib/dashboard.js` | New cards: distillation controls, remove block button, scan section, revoke invite button, invite options form, self-host card. |
| `lib/digest.js` | Extract block-removal into a reusable export (if not already). |
| `lib/hooks.js` | No changes (already exports `setupHooks`, `removeHooks`, `isHookInstalled`). |
| `test/run-tests.js` | Tests for each new API route and the removal logic. |
