# MemBridge Interface Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MemBridge dashboard with a fast, team-first React interface — seven screens — serving both the desktop app and the hosted team workspace from one codebase.

**Architecture:** A React + Vite single-page app in `ui/`, compiled to static assets. The UI never touches a transport directly: it calls a `DataClient` interface, and `LocalDaemonClient` (127.0.0.1 daemon API) implements it. A future `TeamBackendClient` (Supabase) satisfies the same interface so desktop and hosted cannot drift. The daemon serves the built assets at `/app`; the existing dashboard stays the default at `/` until a human approves cutover.

**Tech Stack:** React 18, TypeScript, Vite, Vitest + @testing-library/react, wouter (routing), @tanstack/react-query (fetching/caching). Node >= 18.

**Source of truth:** `docs/superpowers/specs/2026-07-29-apps-interface-rebuild-design.md` (commit 64906b9).
**Approved mockups:** `.superpowers/brainstorm/24172-1785362070/content/` — `today-v15.html`, `project-v4.html`, `projects-list-v2.html`, `team-v1b.html`, `insights-v4.html`, `settings-solo-v2.html`. This directory is gitignored; if absent, work from spec §3–§4 and say so in your report.

## Global Constraints

Every task's requirements implicitly include this section.

- **Radius:** exactly one value, `4px`, applied globally via `--r`. No pills, no `border-radius: 50%` — except avatars representing people, which are circles. Nothing else.
- **No cards.** Structure is 1px hairlines (`--line`) and background shifts. No box-shadow on resting content; one subtle shadow level allowed only for true overlays (menus, dialogs).
- **No gradients** anywhere. No scale-on-hover. Hover changes background or border color only.
- **Numbers** are monospace with `font-variant-numeric: tabular-nums`. Stat labels are small, uppercase, muted. Stats live in a ruled grid — never a big number inside a rounded card.
- **Icons** are small, single-color inherited from text, never inside a tinted container. No emoji used as an icon (Windows substitutes different glyph widths).
- **State colors:** green `--green` healthy, amber `--amber` attention, red `--red` broken. State is never conveyed by color alone — each carries a glyph and words.
- **Font stacks, verbatim:**
  - UI: `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`
  - Mono: `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace`
- **Themes:** dark and light from the same tokens. Brand blue `#4D7CFF` (dark) / `#0052FF` (light).
- **Copy rules (exact):** sync state renders the bare string `✓ up to date` with **no** timestamp; a behind project renders `⚠ behind · <date>` **and** a `Sync now` button. Up-to-date rows have no button. Session-count metrics read `N sessions · last 7 days` — never `7d`.
- **Live session cards show the captured intent only.** Never infer, summarize, or narrate what a running session is "doing".
- **Never render a dollar or spend figure, anywhere.** `lib/server.js:294-297` states the rule: MemBridge prices at list-price API rates while many users are on flat subscription plans, so a dollar number would contradict every figure beside it. Report tokens only, and use the word "avoided", never "saved".
- **No roadmap / BYOK / Plan / API-key UI.** Cut entirely; supersedes `PLAN.md` M2/M3. `lib/advisor.js` stays on disk with no surface.
- **Solo mode:** team surfaces are ABSENT — not disabled, not greyed, no upsell. A solo user never sees a control they cannot use.
- **Windows is a blocking target.** `scrollbar-gutter: stable` where a scrollbar can appear; `Ctrl` on Windows / `Cmd` on macOS in handlers and hint text; npm scripts shell-neutral (no `rm -rf`, no POSIX-only chains — use Node for file ops); `path.join` for every path in Node code.
- **Never invent an API shape.** Read the real payload builders in `lib/server.js` (`statusPayload` line 149, `projectsPayload` line 241, `feedPayload` line 366, `projectDetail` line 677, `savingsPayload` line 298).
- **Migrations start at 023.** `supabase/migrations/` already runs through `022_ops_snapshot_v3.sql`.
- **Files stay under ~300 lines.** The thing being replaced is a 4,414-line `client.js`; do not recreate it.
- **Do not touch** `lib/dashboard/*`, `web/`, adapters, or the capture pipeline. Cutover is not in this plan.
- **Baseline:** record the pass count of `node test/run-tests.js` before Task 1 and match it at every task boundary.

## File Structure

```
ui/
  package.json            vite + react + ts + vitest config, shell-neutral scripts
  vite.config.ts          build to ui/dist, base '/app/'
  index.html
  src/
    main.tsx              mount, providers
    app/
      App.tsx             router + shell composition
      Shell.tsx           sidebar rail + main region
      routes.ts           route table (single source of paths)
    styles/
      tokens.css          all design tokens, both themes
      base.css            reset + element defaults
    data/
      types.ts            domain types (Project, Session, Member, ...)
      DataClient.ts       the interface + capability flags
      LocalDaemonClient.ts  daemon implementation
      FakeDataClient.ts   test double, deterministic fixtures
      queries.ts          react-query hooks (one per screen concern)
      DataClientProvider.tsx  context + useDataClient()
    components/
      StatStrip.tsx  RuledRow.tsx  StateChip.tsx  Toggle.tsx
      Avatar.tsx  Sparkline.tsx  SyncState.tsx  Placeholder.tsx
    features/
      today/TodayPage.tsx        + TodayPage.test.tsx
      projects/ProjectsPage.tsx  + AccessCell.tsx + ProjectsPage.test.tsx
      project/ProjectPage.tsx    + AccessPanel.tsx + ProjectPage.test.tsx
      members/MembersPage.tsx    + InviteRow.tsx + AuditList.tsx + tests
      insights/InsightsPage.tsx  + ProblemList.tsx + InsightsPage.test.tsx
      settings/SettingsPage.tsx  + SettingsPage.test.tsx
lib/
  digest.js               MODIFY: EOL-preserving injection
  server.js               MODIFY: serve ui/dist at /app; new endpoints
  api-access.js           CREATE: project access read/write + audit
  api-insights.js         CREATE: insights aggregation
supabase/migrations/
  023_project_access_and_audit.sql   CREATE
test/
  run-tests.js            MODIFY: add cases for new endpoints + EOL
```

---

### Task 1: EOL-preserving memory-block injection

Prerequisite bug (spec §9.1). `lib/digest.js` builds the block with hard `\n` and splices it in without checking the target file's line endings, so a CRLF `CLAUDE.md` on Windows ends up with mixed endings and a whole-file git diff. `lib/mcp-toml.js:59` already solves this correctly.

**Files:**
- Modify: `lib/digest.js` (block assembly ~line 497, `inject()` ~line 505-527, `removeBlock` ~line 555-572)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `digest.eolOf(text)` → `'\r\n' | '\n'`. Exported from `lib/digest.js` alongside `BEGIN`/`END`.

- [ ] **Step 1: Read the current implementation**

Read `lib/digest.js` lines 490-575. Note that `buildBlock()` returns `[BEGIN, body, END].join('\n')` and `inject()` writes with `fs.writeFileSync(filePath, updated)`.

- [ ] **Step 2: Write the failing test**

Add to `test/run-tests.js`, inside the existing digest/injection test area, following the file's existing `test(...)` helper style:

```javascript
test('injection preserves CRLF line endings', () => {
  const dir = mkProject('crlf-eol');
  const target = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(target, '# Title\r\n\r\nSome existing prose.\r\n');
  digest.inject(target, '## Shared AI memory\nline one\nline two');
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(!/(?<!\r)\n/.test(after), 'no bare LF may remain in a CRLF file');
  assert.ok(after.includes('\r\n'), 'file must still use CRLF');
  assert.ok(after.includes(digest.BEGIN) && after.includes(digest.END), 'markers present');
});

test('injection preserves LF line endings', () => {
  const dir = mkProject('lf-eol');
  const target = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(target, '# Title\n\nSome existing prose.\n');
  digest.inject(target, '## Shared AI memory\nline one');
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(!after.includes('\r'), 'an LF file must not gain CR');
});

test('removeBlock preserves CRLF line endings', () => {
  const dir = mkProject('crlf-remove');
  const target = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(target, '# Title\r\n\r\nProse.\r\n');
  digest.inject(target, 'memory body');
  digest.removeBlock(target);
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(!/(?<!\r)\n/.test(after), 'no bare LF after removal');
  assert.ok(!after.includes(digest.BEGIN), 'marker gone');
});
```

Use the file's existing project-fixture helper rather than `mkProject` if it is named differently — read the surrounding tests and match them exactly.

- [ ] **Step 3: Run the test to verify it fails**

Run: `node test/run-tests.js 2>&1 | grep -A3 "CRLF"`
Expected: FAIL — a bare LF remains in the CRLF file.

- [ ] **Step 4: Implement EOL detection**

In `lib/digest.js`, add near the `BEGIN`/`END` constants:

```javascript
// A file that uses CRLF anywhere is treated as a CRLF file, so the lines WE
// own match the ones already there. Writing LF into a CRLF CLAUDE.md leaves
// mixed endings and shows up as a whole-file diff on Windows.
const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n');
const toEol = (text, eol) => (eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));
```

In `inject()`, after reading `existing` and before splicing, compute `const eol = eolOf(existing);` and convert the assembled block with `toEol(block, eol)`. Convert any literal `'\n'` separators used when appending (`existing.replace(/\s*$/, '\n\n') + block + '\n'`) to use `eol` instead. In `removeBlock()`, apply the same treatment to the `\n`-based trimming so the surrounding text keeps its endings.

Export `eolOf` in the module's exports object beside `BEGIN, END`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node test/run-tests.js`
Expected: all tests pass, count = baseline + 3.

- [ ] **Step 6: Commit**

```bash
git add lib/digest.js test/run-tests.js
git commit -m "fix(digest): preserve the target file's line endings when injecting

A CRLF CLAUDE.md received an LF block, leaving mixed endings and a
whole-file git diff on Windows. mcp-toml.js already did this correctly.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: UI scaffold, tokens, and base styles

**Files:**
- Create: `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/index.html`, `ui/src/main.tsx`, `ui/src/styles/tokens.css`, `ui/src/styles/base.css`, `ui/vitest.setup.ts`
- Modify: `.gitignore` (add `ui/dist/`, `ui/node_modules/`)

**Interfaces:**
- Produces: the `ui/` workspace; `npm run build` emits `ui/dist`; `npx vitest run` executes tests. CSS custom properties consumed by every later task: `--bg --panel --panel2 --text --text2 --text3 --line --line2 --accent --accent2 --accent-dim --green --amber --red --mono --r`.

- [ ] **Step 1: Create the Vite app**

```bash
cd ui && npm init -y
npm install react react-dom wouter @tanstack/react-query
npm install -D vite @vitejs/plugin-react typescript @types/react @types/react-dom vitest @testing-library/react @testing-library/user-event jsdom @testing-library/jest-dom
```

- [ ] **Step 2: Write `ui/package.json` scripts (shell-neutral)**

```json
{
  "name": "membridge-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\""
  }
}
```

No `rm -rf`. No `&&`-chained POSIX utilities beyond the `tsc && vite` pair, which works in cmd.exe and PowerShell.

- [ ] **Step 3: Write `ui/vite.config.ts`**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
  },
})
```

- [ ] **Step 4: Write `ui/src/styles/tokens.css`**

Copy the exact values from the approved mockup's `<style>` block. If the mockup is unavailable, use these (they ARE the mockup's values):

```css
:root {
  --bg: #0B1120; --panel: #0E1526; --panel2: #111A2E;
  --text: #F1F5F9; --text2: #94A3B8; --text3: #5B6B84;
  --line: #1E293B; --line2: #334155;
  --accent: #4D7CFF; --accent2: #7A9DFF; --accent-dim: rgba(77,124,255,.12);
  --green: #22C08F; --amber: #E79A3C; --red: #F0616D;
  --green-dim: rgba(34,192,143,.09); --amber-dim: rgba(231,154,60,.10); --red-dim: rgba(240,97,109,.14);
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, Menlo, monospace;
  --r: 4px;
}
:root[data-theme="light"] {
  --bg: #FAFAFA; --panel: #FFFFFF; --panel2: #F1F5F9;
  --text: #0F172A; --text2: #64748B; --text3: #94A3B8;
  --line: #E2E8F0; --line2: #CBD5E1;
  --accent: #0052FF; --accent2: #4D7CFF; --accent-dim: rgba(0,82,255,.06);
  --green: #0D9673; --amber: #C77414; --red: #D14350;
  --green-dim: rgba(13,150,115,.08); --amber-dim: rgba(199,116,20,.09); --red-dim: rgba(209,67,80,.08);
}
```

- [ ] **Step 5: Write `ui/src/styles/base.css`**

```css
*, *::before, *::after { box-sizing: border-box; border-radius: 0; }
html, body, #root { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: var(--ui); font-size: 12px; line-height: 1.4;
  scrollbar-gutter: stable;
}
button { font: inherit; border-radius: var(--r); cursor: pointer; }
button:hover { background: var(--panel2); }
input, select { font: inherit; border-radius: var(--r); background: var(--panel2); color: var(--text); border: 1px solid var(--line2); }
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.scroll-x { overflow-x: auto; scrollbar-gutter: stable; }
```

`box-shadow` appears nowhere in `base.css`. Overlays add their own.

- [ ] **Step 6: Verify the build**

Run: `cd ui && npm run build`
Expected: `dist/index.html` and hashed assets emitted, exit 0.

- [ ] **Step 7: Commit**

```bash
git add ui .gitignore
git commit -m "feat(ui): scaffold React+Vite app with design tokens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Domain types, DataClient interface, and FakeDataClient

**Files:**
- Create: `ui/src/data/types.ts`, `ui/src/data/DataClient.ts`, `ui/src/data/FakeDataClient.ts`, `ui/src/data/FakeDataClient.test.ts`

**Interfaces:**
- Produces: everything below. Later tasks import these exact names.

- [ ] **Step 1: Write `ui/src/data/types.ts`**

Types mirror the real daemon payloads (`lib/server.js:149,241,366,298`). Do not add fields the daemon does not send.

```typescript
export type Role = 'owner' | 'admin' | 'member'
export type SyncState = { state: 'up-to-date' } | { state: 'behind'; lastSyncedAt: string | null } | { state: 'paused' }

export interface Status {
  running: boolean
  version: string
  solo: boolean
  setupDone: boolean
  projectCount: number
  lastSync: string | null
  teamLastSync: string | null
  tools: string[]
  encryption: { enabled: boolean; plaintextOff: boolean; paused: string | null; keyAlerts: number }
  auth: { paused: string | null; detail: string | null; since: string | null }
}

export interface Project {
  path: string
  name: string
  exists: boolean
  paused: boolean
  lastSync: string | null
  lastActivity: string | null
  sessionsTotal: number
  tools: string[]
  shared: boolean
  memberIds: string[]
  sessionsLast7Days: number
  dailyCounts: number[]     // exactly 7 entries, oldest first
  latestSummary: { text: string; author: string; at: string } | null
  sync: SyncState
}

export interface LiveSession {
  id: string
  author: string
  authorId: string
  tool: string
  projectName: string
  startedAt: string
  intent: string | null      // the captured opening ask, verbatim; never inferred
}

export interface StreamEntry {
  id: string
  author: string
  authorId: string
  tool: string
  at: string
  live: boolean
  outcome: string
  intent: string | null
  files: string[]
}

export interface Member {
  id: string
  name: string
  email: string
  role: Role
  projectCount: number
  sync: SyncState
  keyVerified: boolean
  syncDetail: string | null
}

export interface Invite {
  id: string
  email: string
  expiresAt: string
  role: Role
}

export interface AuditEvent {
  id: string
  at: string
  actorName: string
  action: string
  objectType: 'project' | 'member' | 'invite' | 'team' | 'setting'
  objectLabel: string
  detail: string | null
}

export type Severity = 'broken' | 'minor'

export interface Problem {
  id: string
  severity: Severity
  headline: string
  scale: string                 // e.g. "47 of 47 sessions · hook not installed"
  action: { label: string; kind: string } | null
}

export interface Insights {
  window: 7 | 30 | 90
  sessions: { count: number; deltaPct: number | null }
  membersSyncing: { ok: number; total: number }
  entriesShared: { count: number; delta: number | null }
  skeleton: { available: false } | { available: true; repeatOpens: number; answeredFirst: number }
  perPerson: { id: string; name: string; sessions: number; shared: number }[]
  topProjects: { name: string; sessions: number; people: number }[]
  problems: Problem[]
  concentration: { projectName: string; onlyPerson: string; detail: string }[]
  byTool: { tool: string; sessions: number }[]
}

export interface DeliveryChannel {
  id: 'context-block' | 'recall' | 'summaries' | 'mcp'
  label: string
  description: string
  installed: boolean
  enabled: boolean | null
}

export interface Settings {
  delivery: DeliveryChannel[]
  privacy: { endToEnd: boolean; plaintextShared: boolean; redactionBuiltIn: number; redactionCustom: number; excludedPaths: number }
  daemon: { running: boolean; port: number | null; version: string; startAtLogin: boolean; intervalSec: number; updateAvailable: string | null }
  team: { name: string; role: Role; memberCount: number } | null
}

export interface AccessMatrix {
  members: { id: string; name: string }[]
  rows: { projectPath: string; projectName: string; shared: boolean; access: Record<string, boolean> }[]
}
```

- [ ] **Step 2: Write `ui/src/data/DataClient.ts`**

```typescript
import type {
  AccessMatrix, AuditEvent, Insights, Invite, LiveSession, Member, Project, Role, Settings, Status, StreamEntry,
} from './types'

/** What the active transport can do. Screens hide what is unsupported. */
export interface Capabilities {
  daemonControl: boolean   // restart, start-at-login, interval
  localPaths: boolean      // show filesystem paths, open files
  teamAdmin: boolean       // roles, invites, audit, access matrix
}

export interface DataClient {
  readonly capabilities: Capabilities

  getStatus(): Promise<Status>
  getProjects(): Promise<Project[]>
  getLiveSessions(): Promise<LiveSession[]>
  getProjectStream(projectPath: string): Promise<StreamEntry[]>
  syncProject(projectPath: string): Promise<void>
  syncAll(): Promise<void>
  setProjectPaused(projectPath: string, paused: boolean): Promise<void>
  copyForAI(projectPath: string): Promise<string>

  getProjectAccess(projectPath: string): Promise<{ memberId: string; canSee: boolean }[]>
  setProjectAccess(projectPath: string, memberId: string, canSee: boolean): Promise<void>
  getAccessMatrix(): Promise<AccessMatrix>

  getMembers(): Promise<Member[]>
  getInvites(): Promise<Invite[]>
  inviteMember(email: string, role: Role): Promise<void>
  revokeInvite(inviteId: string): Promise<void>
  setMemberRole(memberId: string, role: Role): Promise<void>
  removeMember(memberId: string): Promise<void>
  getAudit(limit?: number): Promise<AuditEvent[]>

  getInsights(window: 7 | 30 | 90): Promise<Insights>

  getSettings(): Promise<Settings>
  setSetting(key: string, value: unknown): Promise<void>
}
```

- [ ] **Step 3: Write `ui/src/data/FakeDataClient.ts`**

A deterministic double with no timers and no network. It must express every state the screens must handle: solo, member-role, a behind project, a broken member, and skeleton-unavailable.

```typescript
import type { DataClient, Capabilities } from './DataClient'
import type { AccessMatrix, AuditEvent, Insights, Invite, LiveSession, Member, Project, Role, Settings, Status, StreamEntry } from './types'

export interface FakeOptions {
  solo?: boolean
  role?: Role
  skeletonAvailable?: boolean
  empty?: boolean
  failWith?: string
}

export class FakeDataClient implements DataClient {
  readonly capabilities: Capabilities
  constructor(private opts: FakeOptions = {}) {
    this.capabilities = {
      daemonControl: true,
      localPaths: true,
      teamAdmin: !opts.solo && opts.role !== 'member',
    }
  }
  private guard<T>(value: T): Promise<T> {
    if (this.opts.failWith) return Promise.reject(new Error(this.opts.failWith))
    return Promise.resolve(value)
  }
  getStatus() {
    return this.guard<Status>({
      running: true, version: '0.1.7', solo: !!this.opts.solo, setupDone: true,
      projectCount: this.opts.empty ? 0 : 3, lastSync: '2026-07-29T21:00:00Z',
      teamLastSync: this.opts.solo ? null : '2026-07-29T21:00:00Z', tools: ['Claude Code', 'Codex'],
      encryption: { enabled: true, plaintextOff: true, paused: null, keyAlerts: 0 },
      auth: { paused: null, detail: null, since: null },
    })
  }
  getProjects() {
    if (this.opts.empty) return this.guard<Project[]>([])
    return this.guard<Project[]>([
      {
        path: '/Users/x/membridge', name: 'membridge', exists: true, paused: false,
        lastSync: '2026-07-29T19:00:00Z', lastActivity: '2026-07-29T19:00:00Z',
        sessionsTotal: 184, tools: ['Claude Code', 'Codex'],
        shared: !this.opts.solo, memberIds: this.opts.solo ? ['me'] : ['me', 'andrew', 'sarah'],
        sessionsLast7Days: 31, dailyCounts: [5, 8, 4, 10, 7, 12, 13],
        latestSummary: { text: 'Hook ownership now decided by durability, not who ran last', author: 'Andrew', at: '2026-07-29T19:00:00Z' },
        sync: { state: 'up-to-date' },
      },
      {
        path: '/Users/x/sublease', name: 'sublease', exists: true, paused: false,
        lastSync: '2026-07-23T10:00:00Z', lastActivity: '2026-07-29T08:00:00Z',
        sessionsTotal: 40, tools: ['Claude Code'],
        shared: false, memberIds: ['me'],
        sessionsLast7Days: 4, dailyCounts: [2, 2, 4, 2, 2, 3, 2],
        latestSummary: { text: 'Listing flow validates addresses before payment', author: 'You', at: '2026-07-23T10:00:00Z' },
        sync: { state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' },
      },
    ])
  }
  getLiveSessions() {
    return this.guard<LiveSession[]>(this.opts.empty ? [] : [
      { id: 's1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', projectName: 'membridge', startedAt: '2026-07-29T20:36:00Z', intent: 'make the summary hook fire on session boundaries, not only on stop' },
      { id: 's2', author: 'You', authorId: 'me', tool: 'Claude Code', projectName: 'membridge', startedAt: '2026-07-29T21:00:00Z', intent: 'rebuild the apps interface from the ground up' },
    ])
  }
  getProjectStream() {
    return this.guard<StreamEntry[]>([
      { id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T19:00:00Z', live: true, outcome: 'Hook ownership now decided by durability, not who ran last.', intent: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js'] },
    ])
  }
  syncProject() { return this.guard<void>(undefined) }
  syncAll() { return this.guard<void>(undefined) }
  setProjectPaused() { return this.guard<void>(undefined) }
  copyForAI() { return this.guard('digest text') }
  getProjectAccess() {
    return this.guard([{ memberId: 'me', canSee: true }, { memberId: 'andrew', canSee: true }, { memberId: 'sarah', canSee: false }])
  }
  setProjectAccess() { return this.guard<void>(undefined) }
  getAccessMatrix() {
    return this.guard<AccessMatrix>({
      members: [{ id: 'me', name: 'Marco' }, { id: 'andrew', name: 'Andrew' }, { id: 'sarah', name: 'Sarah' }],
      rows: [
        { projectPath: '/Users/x/membridge', projectName: 'membridge', shared: true, access: { me: true, andrew: true, sarah: true } },
        { projectPath: '/Users/x/sublease', projectName: 'sublease', shared: false, access: { me: true, andrew: false, sarah: false } },
      ],
    })
  }
  getMembers() {
    return this.guard<Member[]>([
      { id: 'me', name: 'Marco', email: 'marco@melika.com', role: 'owner', projectCount: 3, sync: { state: 'up-to-date' }, keyVerified: true, syncDetail: null },
      { id: 'sarah', name: 'Sarah', email: 'sarah@acme.dev', role: 'member', projectCount: 1, sync: { state: 'paused' }, keyVerified: true, syncDetail: 'token expired' },
    ])
  }
  getInvites() { return this.guard<Invite[]>([{ id: 'i1', email: 'dana@acme.dev', expiresAt: '2026-08-04T00:00:00Z', role: 'member' }]) }
  inviteMember() { return this.guard<void>(undefined) }
  revokeInvite() { return this.guard<void>(undefined) }
  setMemberRole() { return this.guard<void>(undefined) }
  removeMember() { return this.guard<void>(undefined) }
  getAudit() {
    return this.guard<AuditEvent[]>([
      { id: 'a1', at: '2026-07-29T14:02:00Z', actorName: 'Andrew', action: 'unshared', objectType: 'project', objectLabel: 'billing-poc', detail: null },
    ])
  }
  getInsights(window: 7 | 30 | 90) {
    return this.guard<Insights>({
      window,
      sessions: { count: 412, deltaPct: 18 },
      membersSyncing: { ok: 2, total: 3 },
      entriesShared: { count: 187, delta: 31 },
      skeleton: this.opts.skeletonAvailable === false ? { available: false } : { available: true, repeatOpens: 1204, answeredFirst: 818 },
      perPerson: [{ id: 'me', name: 'Marco', sessions: 214, shared: 205 }],
      topProjects: [{ name: 'membridge', sessions: 184, people: 3 }],
      problems: [
        { id: 'p1', severity: 'broken', headline: "Sarah's summaries never arrive", scale: '47 of 47 sessions · hook not installed since she joined', action: { label: 'Send setup steps', kind: 'setup-steps' } },
        { id: 'p2', severity: 'minor', headline: '2 sessions missing summaries', scale: 'of 412 · both crashed mid-session', action: null },
      ],
      concentration: [{ projectName: 'billing-poc', onlyPerson: 'Andrew', detail: '41 sessions' }],
      byTool: [{ tool: 'Claude Code', sessions: 268 }],
    })
  }
  getSettings() {
    return this.guard<Settings>({
      delivery: [
        { id: 'context-block', label: 'Context block', description: 'A small skeleton written into CLAUDE.md, AGENTS.md, GEMINI.md', installed: true, enabled: null },
        { id: 'mcp', label: 'MCP server', description: 'Lets any MCP-capable tool query team memory directly', installed: false, enabled: null },
      ],
      privacy: { endToEnd: true, plaintextShared: false, redactionBuiltIn: 18, redactionCustom: 2, excludedPaths: 3 },
      daemon: { running: true, port: 7391, version: '0.1.7', startAtLogin: true, intervalSec: 300, updateAvailable: null },
      team: this.opts.solo ? null : { name: 'MemBridge HQ', role: this.opts.role ?? 'owner', memberCount: 3 },
    })
  }
  setSetting() { return this.guard<void>(undefined) }
}
```

- [ ] **Step 4: Write the failing test**

`ui/src/data/FakeDataClient.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { FakeDataClient } from './FakeDataClient'

describe('FakeDataClient', () => {
  it('reports no team admin capability in solo mode', async () => {
    const c = new FakeDataClient({ solo: true })
    expect(c.capabilities.teamAdmin).toBe(false)
    expect((await c.getSettings()).team).toBeNull()
  })

  it('reports no team admin capability for a member role', () => {
    expect(new FakeDataClient({ role: 'member' }).capabilities.teamAdmin).toBe(false)
  })

  it('exposes a behind project with its last sync date', async () => {
    const behind = (await new FakeDataClient().getProjects()).find(p => p.sync.state === 'behind')
    expect(behind?.sync).toEqual({ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' })
  })

  it('gives every project exactly seven daily counts', async () => {
    for (const p of await new FakeDataClient().getProjects()) expect(p.dailyCounts).toHaveLength(7)
  })

  it('can report skeleton stats as unavailable', async () => {
    const i = await new FakeDataClient({ skeletonAvailable: false }).getInsights(30)
    expect(i.skeleton).toEqual({ available: false })
  })

  it('rejects every call when configured to fail', async () => {
    await expect(new FakeDataClient({ failWith: 'boom' }).getStatus()).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 5: Run it**

Run: `cd ui && npx vitest run src/data/FakeDataClient.test.ts`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```bash
git add ui/src/data
git commit -m "feat(ui): domain types, DataClient interface, and test double

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: LocalDaemonClient, query layer, and provider

**Files:**
- Create: `ui/src/data/LocalDaemonClient.ts`, `ui/src/data/DataClientProvider.tsx`, `ui/src/data/queries.ts`, `ui/src/data/LocalDaemonClient.test.ts`

**Interfaces:**
- Consumes: `DataClient`, `Capabilities`, all types from Task 3.
- Produces: `LocalDaemonClient`, `DataClientProvider`, `useDataClient()`, and hooks `useStatus, useProjects, useLiveSessions, useProjectStream, useAccessMatrix, useMembers, useInvites, useAudit, useInsights, useSettings`, plus mutation hooks `useSyncProject, useSyncAll, useSetProjectAccess, useSetMemberRole, useRemoveMember, useInviteMember, useRevokeInvite, useSetSetting`.

- [ ] **Step 1: Map the real payloads before writing code**

Read these and write down the field names you will consume — do not guess:
`lib/server.js:149` (`statusPayload`), `:241` (`projectsPayload`), `:298` (`savingsPayload`), `:366` (`feedPayload`), `:677` (`projectDetail`).

Mapping rules that are NOT optional:
- `Project.shared` ← `projectsPayload().team` being non-null.
- `Project.sync` ← derive: `paused` → `{state:'paused'}`; else if `lastActivity > lastSync` → `{state:'behind', lastSyncedAt: lastSync}`; else `{state:'up-to-date'}`.
- `Project.sessionsLast7Days` and `dailyCounts` ← count non-plumbing events per day over the trailing 7 days. The daemon sends `sessionsTotal` (lifetime), which is a different number — do not substitute it.
- `LiveSession.intent` ← the captured prompt only. If absent, `null`, and the UI renders nothing rather than a placeholder sentence.
- `Insights.skeleton` ← `/api/savings`: `repeatOpens = reads.sameSession + reads.crossSession`, `answeredFirst = avoided.serves`. If `/api/savings` returns no `reads`/`avoided`, emit `{available:false}`.

- [ ] **Step 2: Write `ui/src/data/LocalDaemonClient.ts`**

```typescript
import type { DataClient, Capabilities } from './DataClient'
import type { Project, Status, SyncState } from './types'

const BASE = ''  // same origin as the daemon

async function get<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${pathAndQuery} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(pathAndQuery: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${pathAndQuery} failed: ${res.status}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** Exported for unit testing without a live daemon. */
export function syncStateOf(p: { paused: boolean; lastSync: string | null; lastActivity: string | null }): SyncState {
  if (p.paused) return { state: 'paused' }
  if (p.lastActivity && (!p.lastSync || p.lastActivity > p.lastSync)) {
    return { state: 'behind', lastSyncedAt: p.lastSync }
  }
  return { state: 'up-to-date' }
}

export class LocalDaemonClient implements DataClient {
  readonly capabilities: Capabilities = { daemonControl: true, localPaths: true, teamAdmin: true }
  getStatus() { return get<Status>('/api/status') }
  // ...remaining methods: one fetch each, mapping per Step 1. Keep this file
  // under 300 lines by putting pure mapping functions in `mappers.ts` if needed.
}
```

Implement every `DataClient` method. Endpoints to use — all of these already exist:
`/api/status`, `/api/projects`, `/api/project?path=`, `/api/feed`, `/api/savings`, `/api/settings` (GET/POST), `/api/team`, `/api/team/members`, `/api/team/invite`, `/api/team/revoke-invite`, `/api/team/set-role`, `/api/team/remove-member`, `/api/sync`, `/api/team/sync`, `/api/projects/toggle`, `/api/projects/copy`.
Endpoints created later in Task 10: `/api/project/access` (GET/POST), `/api/team/access-matrix`, `/api/team/audit`, `/api/team/insights`. Until Task 10 lands, these four methods may throw — the screens that use them arrive in Tasks 8-11.

- [ ] **Step 3: Write the failing test**

`ui/src/data/LocalDaemonClient.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { syncStateOf } from './LocalDaemonClient'

describe('syncStateOf', () => {
  it('is paused when the project is paused, regardless of timestamps', () => {
    expect(syncStateOf({ paused: true, lastSync: null, lastActivity: '2026-07-29T00:00:00Z' })).toEqual({ state: 'paused' })
  })
  it('is behind when activity postdates the last sync', () => {
    expect(syncStateOf({ paused: false, lastSync: '2026-07-23T10:00:00Z', lastActivity: '2026-07-29T08:00:00Z' }))
      .toEqual({ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' })
  })
  it('is behind when there has never been a sync but there is activity', () => {
    expect(syncStateOf({ paused: false, lastSync: null, lastActivity: '2026-07-29T08:00:00Z' }))
      .toEqual({ state: 'behind', lastSyncedAt: null })
  })
  it('is up to date when the last sync is at or after the last activity', () => {
    expect(syncStateOf({ paused: false, lastSync: '2026-07-29T09:00:00Z', lastActivity: '2026-07-29T08:00:00Z' }))
      .toEqual({ state: 'up-to-date' })
  })
  it('is up to date for a project with no activity at all', () => {
    expect(syncStateOf({ paused: false, lastSync: null, lastActivity: null })).toEqual({ state: 'up-to-date' })
  })
})
```

- [ ] **Step 4: Run it**

Run: `cd ui && npx vitest run src/data/LocalDaemonClient.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Write `ui/src/data/DataClientProvider.tsx`**

```tsx
import { createContext, useContext } from 'react'
import type { DataClient } from './DataClient'

const Ctx = createContext<DataClient | null>(null)

export function DataClientProvider({ client, children }: { client: DataClient; children: React.ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>
}

export function useDataClient(): DataClient {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDataClient must be used inside DataClientProvider')
  return c
}
```

- [ ] **Step 6: Write `ui/src/data/queries.ts`**

One hook per concern. Polling rules from spec §7: live data every 10s, and polling must PAUSE when the tab is hidden — never unmount (that previously blanked the dashboard during recording).

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useDataClient } from './DataClientProvider'

/** react-query pauses polling for hidden documents when this is left default;
 *  keep refetchIntervalInBackground false so a hidden tab stops polling but the
 *  mounted tree and its cached data stay exactly as they were. */
const LIVE = { refetchInterval: 10_000, refetchIntervalInBackground: false } as const

export function useStatus() {
  const c = useDataClient()
  return useQuery({ queryKey: ['status'], queryFn: () => c.getStatus(), ...LIVE })
}

export function useProjects() {
  const c = useDataClient()
  return useQuery({ queryKey: ['projects'], queryFn: () => c.getProjects(), staleTime: 15_000 })
}

export function useLiveSessions() {
  const c = useDataClient()
  return useQuery({ queryKey: ['live'], queryFn: () => c.getLiveSessions(), ...LIVE })
}

export function useSyncProject() {
  const c = useDataClient(); const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectPath: string) => c.syncProject(projectPath),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
}
```

Write the remaining hooks named in the Interfaces block, following these two shapes exactly. Every mutation invalidates the queries its change affects.

- [ ] **Step 7: Verify**

Run: `cd ui && npm run build && npx vitest run`
Expected: build exit 0; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add ui/src/data
git commit -m "feat(ui): daemon data client, provider, and query hooks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Shared components

**Files:**
- Create: `ui/src/components/{StatStrip,RuledRow,StateChip,SyncState,Toggle,Avatar,Sparkline,Placeholder}.tsx`, `ui/src/components/components.test.tsx`

**Interfaces:**
- Consumes: types from Task 3.
- Produces:
  - `<StatStrip items={{value: string, label: string, note?: string}[]} />` — ruled grid, `--mono` tabular value, uppercase muted label.
  - `<RuledRow>` — flex row, `border-bottom: 1px solid var(--line)`, no shadow.
  - `<StateChip tone="ok"|"warn"|"bad" glyph={string} children />` — soft tint, `--r`, glyph + words.
  - `<SyncStateView state={SyncState} onSync?={() => void} />` — renders `✓ up to date` bare; `⚠ behind · <date>` plus a `Sync now` button; `paused` muted.
  - `<Toggle on={boolean} onChange={(next:boolean)=>void} label={string} />` — the only intentionally rounded non-avatar element (a switch); implement as a 26×15 track with `border-radius: 8px`, documented inline as the deliberate exception.
  - `<Avatar name={string} id={string} size?={number} />` — circle, initial, deterministic color from id.
  - `<Sparkline values={number[]} muted?={boolean} />` — bars, no axis, `aria-label` summarizing the series.
  - `<Placeholder title={string} />` — for routes not yet built.

- [ ] **Step 1: Write the failing tests**

`ui/src/components/components.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SyncStateView } from './SyncState'
import { StatStrip } from './StatStrip'
import { Sparkline } from './Sparkline'

describe('SyncStateView', () => {
  it('renders up to date with no timestamp and no button', () => {
    render(<SyncStateView state={{ state: 'up-to-date' }} onSync={() => {}} />)
    expect(screen.getByText('✓ up to date')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders behind with its date and a Sync now button', async () => {
    const onSync = vi.fn()
    render(<SyncStateView state={{ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' }} onSync={onSync} />)
    expect(screen.getByText(/behind · Jul 23/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(onSync).toHaveBeenCalledOnce()
  })
})

describe('StatStrip', () => {
  it('renders each value in a tabular mono element beside its label', () => {
    render(<StatStrip items={[{ value: '412', label: 'sessions' }]} />)
    const value = screen.getByText('412')
    expect(value.className).toContain('mono')
    expect(screen.getByText('sessions')).toBeInTheDocument()
  })
})

describe('Sparkline', () => {
  it('describes the series for assistive tech', () => {
    render(<Sparkline values={[1, 2, 3]} />)
    expect(screen.getByLabelText(/activity/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the components**

Each in its own file, under 120 lines. `SyncState.tsx`, in full, since its copy is contractual:

```tsx
import type { SyncState } from '../data/types'
import { StateChip } from './StateChip'

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'never'

export function SyncStateView({ state, onSync }: { state: SyncState; onSync?: () => void }) {
  if (state.state === 'up-to-date') return <StateChip tone="ok" glyph="✓">up to date</StateChip>
  if (state.state === 'paused') return <StateChip tone="muted" glyph="">paused</StateChip>
  return (
    <>
      <StateChip tone="warn" glyph="⚠">behind · {shortDate(state.lastSyncedAt)}</StateChip>
      {onSync && <button type="button" className="btn-warn" onClick={onSync}>Sync now</button>}
    </>
  )
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd ui && npx vitest run src/components`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components
git commit -m "feat(ui): shared ruled components and sync-state view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: App shell and routing

**Files:**
- Create: `ui/src/app/{App,Shell}.tsx`, `ui/src/app/routes.ts`, `ui/src/app/Shell.test.tsx`
- Modify: `ui/src/main.tsx`

**Interfaces:**
- Consumes: `useStatus`, `useSettings`, components from Task 5.
- Produces: `ROUTES` (the single source of route paths), `<App />`, `<Shell />`.

- [ ] **Step 1: Write `ui/src/app/routes.ts`**

```typescript
export const ROUTES = {
  today: '/', feed: '/feed', projects: '/projects', project: '/projects/:name',
  members: '/team/members', insights: '/team/insights', settings: '/settings',
} as const
```

- [ ] **Step 2: Write the failing test**

`ui/src/app/Shell.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderApp } from '../test/renderApp'   // created in this step; see Step 3

describe('Shell', () => {
  it('shows the team switcher and team navigation on a team', async () => {
    renderApp({ solo: false })
    expect(await screen.findByRole('link', { name: 'Members' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Insights' })).toBeInTheDocument()
  })

  it('omits team navigation entirely in solo mode — not disabled, absent', async () => {
    renderApp({ solo: true })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.queryByRole('link', { name: 'Members' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
    expect(screen.queryByText(/MemBridge HQ/)).toBeNull()
  })

  it('offers creating a team when solo', async () => {
    renderApp({ solo: true })
    expect(await screen.findByRole('button', { name: /create a team/i })).toBeInTheDocument()
  })

  it('hides team navigation from a member role', async () => {
    renderApp({ solo: false, role: 'member' })
    await screen.findByRole('link', { name: 'Today' })
    expect(screen.queryByRole('link', { name: 'Insights' })).toBeNull()
  })
})
```

- [ ] **Step 3: Write the shared test helper**

`ui/src/test/renderApp.tsx`:

```tsx
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient, type FakeOptions } from '../data/FakeDataClient'
import { App } from '../app/App'

export function renderApp(opts: FakeOptions = {}, ui?: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={new FakeDataClient(opts)}>{ui ?? <App />}</DataClientProvider>
    </QueryClientProvider>,
  )
}
```

- [ ] **Step 4: Implement `Shell.tsx` and `App.tsx`**

Shell: fixed-width left rail (`170px`, `background: var(--panel)`, `border-right: 1px solid var(--line)`), logo, team switcher (only when `status.solo === false`), nav groups — top: Today / Feed / Projects; `Team` group (only when `capabilities.teamAdmin && !solo`): Members / Insights; `You` group: Settings — and a footer with the current user and a green dot when `status.running`. Active nav item: `border-left: 2px solid var(--accent)`, `background: var(--accent-dim)`, no other decoration. Solo renders the dashed "Create a team" invitation in place of the Team group.

App: `wouter` `<Switch>` over `ROUTES`, rendering `<Placeholder>` for routes whose feature task has not landed yet.

- [ ] **Step 5: Run tests**

Run: `cd ui && npx vitest run src/app`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add ui/src/app ui/src/test ui/src/main.tsx
git commit -m "feat(ui): app shell with solo-aware navigation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Today page

Matches `today-v15.html`.

**Files:**
- Create: `ui/src/features/today/TodayPage.tsx`, `ui/src/features/today/LiveEntry.tsx`, `ui/src/features/today/ProjectRow.tsx`, `ui/src/features/today/TodayPage.test.tsx`
- Modify: `ui/src/app/App.tsx` (route)

**Interfaces:**
- Consumes: `useStatus`, `useProjects`, `useLiveSessions`, `useSyncProject`, `useSyncAll`, components from Task 5.
- Produces: `<TodayPage />`.

Layout requirements, exact:
- Header: `Today`, the date, and right-aligned `Copy for AI` + `Sync now`.
- Stat strip: live now / sessions today / updates shared / members synced. Solo shows three: live now / sessions today / repeat opens answered by memory.
- `HAPPENING NOW` section. Each entry is a 3-column grid (`auto 1fr auto`): column 1 the live dot + avatar; column 2 `<who> · <tool>` with the project name in mono after it; column 3 elapsed time in mono. The intent occupies column 2 of a second row — sharing the name's left edge — prefixed by a muted uppercase `INTENT` label. A 1px hairline separates consecutive entries.
- `PROJECTS · THIS WEEK`. Each row: left column = name + shared/private tag + overlapping member avatars, then the latest summary beneath it, ellipsized on overflow. Right column, right-anchored: one line with `N sessions · last 7 days` (mono) and the sync state, and the sparkline on the line directly beneath, right-aligned.

- [ ] **Step 1: Write the failing test**

`ui/src/features/today/TodayPage.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../../test/renderApp'
import { TodayPage } from './TodayPage'

describe('TodayPage', () => {
  it('labels a live session with its captured intent', async () => {
    renderApp({}, <TodayPage />)
    expect(await screen.findByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
    expect(screen.getAllByText('Intent').length).toBeGreaterThan(0)
  })

  it('spells out the session window', async () => {
    renderApp({}, <TodayPage />)
    expect(await screen.findByText('31 sessions · last 7 days')).toBeInTheDocument()
    expect(screen.queryByText(/· 7d$/)).toBeNull()
  })

  it('gives a Sync now button only to a behind project', async () => {
    renderApp({}, <TodayPage />)
    const rows = await screen.findAllByTestId('project-row')
    const upToDate = rows.find(r => within(r).queryByText('✓ up to date'))!
    const behind = rows.find(r => within(r).queryByText(/behind/))!
    expect(within(upToDate).queryByRole('button', { name: 'Sync now' })).toBeNull()
    expect(within(behind).getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })

  it('renders an empty state without crashing', async () => {
    renderApp({ empty: true }, <TodayPage />)
    expect(await screen.findByText(/no projects yet/i)).toBeInTheDocument()
  })

  it('surfaces a load failure instead of rendering a blank page', async () => {
    renderApp({ failWith: 'daemon unreachable' }, <TodayPage />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
  })

  it('omits team-only stats in solo mode', async () => {
    renderApp({ solo: true }, <TodayPage />)
    await screen.findByText(/sessions today/i)
    expect(screen.queryByText(/members synced/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/features/today`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three components**

`ProjectRow.tsx` carries `data-testid="project-row"`. Keep each file under 150 lines.

- [ ] **Step 4: Run to verify passing**

Run: `cd ui && npx vitest run src/features/today`
Expected: 6 passing.

- [ ] **Step 5: Full verification**

Run: `cd ui && npm run build && npx vitest run` then `node test/run-tests.js` at the repo root.
Expected: build exit 0; all UI tests pass; root suite at baseline.

- [ ] **Step 6: Commit**

```bash
git add ui/src/features/today ui/src/app/App.tsx
git commit -m "feat(ui): Today page with live intent rows and project metrics

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Project access and audit — schema and API

Server-side foundation for Tasks 9-11. No UI.

**Files:**
- Create: `supabase/migrations/023_project_access_and_audit.sql`, `lib/api-access.js`
- Modify: `lib/server.js` (route wiring), `test/run-tests.js`

**Interfaces:**
- Produces:
  - `GET /api/project/access?path=<projectPath>` → `{ members: [{memberId, name, canSee}] }`
  - `POST /api/project/access` body `{path, memberId, canSee}` → `{ok:true}`; 403 for a member role; writes an audit row.
  - `GET /api/team/access-matrix` → `AccessMatrix` (Task 3 shape), one request for all projects × members.
  - `GET /api/team/audit?limit=` → `{events: AuditEvent[]}`; 403 for a member role.
  - `lib/api-access.js` exports `readAccess`, `writeAccess`, `accessMatrix`, `readAudit`, `writeAudit`.

- [ ] **Step 1: Confirm the migration number**

Run: `ls supabase/migrations | tail -3`
Expected: `022_ops_snapshot_v3.sql` is the highest. If a higher number exists, use the next one and note it in your report.

- [ ] **Step 2: Write the migration**

`supabase/migrations/023_project_access_and_audit.sql`:

```sql
create table if not exists project_access (
  team_id uuid not null references teams(id) on delete cascade,
  project_key text not null,
  member_id uuid not null references team_members(id) on delete cascade,
  can_see boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references team_members(id),
  primary key (team_id, project_key, member_id)
);

create table if not exists team_audit (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  actor_id uuid references team_members(id),
  action text not null,
  object_type text not null,
  object_key text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists team_audit_team_created_idx on team_audit (team_id, created_at desc);

alter table project_access enable row level security;
alter table team_audit enable row level security;
```

Add RLS policies matching the existing convention in `supabase/migrations/011_backend_hardening.sql` — read that file first and mirror its helper functions rather than inventing new predicates. Requirements: `project_access` readable by any member of the team, writable only by owner/admin. `team_audit` readable only by owner/admin, insertable only by owner/admin.

- [ ] **Step 3: Write the failing tests**

Add to `test/run-tests.js` (the suite has a mock Supabase in `test/mock-supabase.js` — read it and follow its patterns):

```javascript
test('GET /api/team/access-matrix returns one row per project with a flag per member', async () => {
  const res = await api('/api/team/access-matrix');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.members) && Array.isArray(res.body.rows));
  for (const row of res.body.rows) {
    for (const m of res.body.members) {
      assert.equal(typeof row.access[m.id], 'boolean', `member ${m.id} missing from ${row.projectName}`);
    }
  }
});

test('POST /api/project/access is refused for a member role', async () => {
  const res = await apiAs('member', 'POST', '/api/project/access', { path: PROJECT, memberId: 'other', canSee: false });
  assert.equal(res.status, 403);
});

test('POST /api/project/access writes an audit row', async () => {
  const before = (await apiAs('owner', 'GET', '/api/team/audit')).body.events.length;
  await apiAs('owner', 'POST', '/api/project/access', { path: PROJECT, memberId: 'other', canSee: false });
  const after = (await apiAs('owner', 'GET', '/api/team/audit')).body.events;
  assert.equal(after.length, before + 1);
  assert.equal(after[0].action, 'access-revoked');
});

test('GET /api/team/audit is refused for a member role', async () => {
  assert.equal((await apiAs('member', 'GET', '/api/team/audit')).status, 403);
});
```

Use the suite's existing request helper names; if `api`/`apiAs` do not exist, add them following the file's established style and say so in your report.

- [ ] **Step 4: Run to verify failure**

Run: `node test/run-tests.js 2>&1 | grep -B2 -A5 "access-matrix"`
Expected: FAIL — 404 on the new routes.

- [ ] **Step 5: Implement `lib/api-access.js` and wire the routes**

Follow the existing `lib/server.js` dispatch style exactly (the `else if (req.method === ... && url.pathname === ...)` chain) and validate bodies with `zod`, which is already a dependency. Every write calls `writeAudit`.

- [ ] **Step 6: Run to verify passing**

Run: `node test/run-tests.js`
Expected: all passing, count = previous baseline + 4.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/023_project_access_and_audit.sql lib/api-access.js lib/server.js test/run-tests.js
git commit -m "feat(api): per-project access control and team audit trail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Project page

Matches `project-v4.html`.

**Files:**
- Create: `ui/src/features/project/ProjectPage.tsx`, `AccessPanel.tsx`, `StreamEntry.tsx`, `ProjectPage.test.tsx`
- Modify: `ui/src/app/App.tsx`

**Interfaces:**
- Consumes: `useProjectStream`, `useProjects`, `useProjectAccess`, `useSetProjectAccess`, `useMembers`, Task 5 components.
- Produces: `<ProjectPage name={string} />`.

Layout: two columns, `flex: 1` stream and a `300px` right column, stacking below 1000px. Stream is day-grouped with an uppercase day header; each entry shows author, tool, time, the outcome in full, a muted `INTENT` line, and files in mono. Right column, three ruled panels: **Who sees this project** (a `Toggle` per member with role, a consequence sentence naming the person when someone is off, and the `New members join with access` default), **Memory · this project** (status, last update + producing agent, entry count + memory.md link), **Sync** (team sync, encryption, week stats). Header: back link, project name in mono, shared tag, sync state, and `Copy for AI` / `Pause` / `Sync now`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../../test/renderApp'
import { ProjectPage } from './ProjectPage'

describe('ProjectPage', () => {
  it('states the consequence of revoking a member by name', async () => {
    renderApp({}, <ProjectPage name="membridge" />)
    expect(await screen.findByText(/Sarah can't see this project's memory or activity/)).toBeInTheDocument()
  })

  it('leads each stream entry with the outcome and shows the ask as intent', async () => {
    renderApp({}, <ProjectPage name="membridge" />)
    expect(await screen.findByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
    expect(screen.getByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
  })

  it('toggling a member calls setProjectAccess with that member', async () => {
    const spy = vi.fn()
    renderApp({}, <ProjectPage name="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /Sarah/ })
    await userEvent.click(toggle)
    expect(await screen.findByRole('switch', { name: /Sarah/ })).toBeChecked()
  })

  it('hides the access panel from a member role', async () => {
    renderApp({ role: 'member' }, <ProjectPage name="membridge" />)
    await screen.findByText(/Hook ownership/)
    expect(screen.queryByText(/who sees this project/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `cd ui && npx vitest run src/features/project` → FAIL.
- [ ] **Step 3: Implement.** `AccessPanel` toggles use `role="switch"` with an accessible name containing the member's name.
- [ ] **Step 4: Run to verify passing** — 4 passing.
- [ ] **Step 5: Commit**

```bash
git add ui/src/features/project ui/src/app/App.tsx
git commit -m "feat(ui): project page with merged stream and access panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Projects grid

Matches `projects-list-v2.html`.

**Files:**
- Create: `ui/src/features/projects/ProjectsPage.tsx`, `AccessCell.tsx`, `ProjectsPage.test.tsx`
- Modify: `ui/src/app/App.tsx`

**Interfaces:**
- Consumes: `useAccessMatrix`, `useProjects`, `useSetProjectAccess`.
- Produces: `<ProjectsPage />`.

Layout: one table, columns = project (+ path in mono), sessions · 7d, last activity, sync, one per member, open. Table sits inside `.scroll-x` with `min-width: 660px` so the page itself never scrolls sideways. Private projects render disabled, dashed cells. Member columns appear only when `capabilities.teamAdmin`; a member sees only their own column. Footer explains the dashed state and that changes are audited.

- [ ] **Step 1: Write the failing test**

```tsx
it('loads the whole matrix in a single request', async () => {
  const client = new FakeDataClient()
  const spy = vi.spyOn(client, 'getAccessMatrix')
  renderWith(client, <ProjectsPage />)
  await screen.findByText('membridge')
  expect(spy).toHaveBeenCalledTimes(1)
})

it('disables access cells for a private project', async () => {
  renderApp({}, <ProjectsPage />)
  const row = await screen.findByTestId('project-row-sublease')
  for (const cell of within(row).getAllByRole('checkbox')) {
    if (cell.getAttribute('data-self') !== 'true') expect(cell).toBeDisabled()
  }
})

it('shows only the viewer's own access column to a member', async () => {
  renderApp({ role: 'member' }, <ProjectsPage />)
  await screen.findByText('membridge')
  expect(screen.queryByRole('columnheader', { name: /Andrew/ })).toBeNull()
})

it('never scrolls the page sideways', async () => {
  renderApp({}, <ProjectsPage />)
  const wrap = await screen.findByTestId('projects-scroll')
  expect(wrap.className).toContain('scroll-x')
})
```

- [ ] **Step 2-5:** run → FAIL; implement; run → 4 passing; commit.

```bash
git add ui/src/features/projects ui/src/app/App.tsx
git commit -m "feat(ui): projects grid with bulk access editing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Members page

Matches `team-v1b.html`.

**Files:**
- Create: `ui/src/features/members/MembersPage.tsx`, `InviteRow.tsx`, `MemberRow.tsx`, `AuditList.tsx`, `MembersPage.test.tsx`
- Modify: `ui/src/app/App.tsx`

**Interfaces:**
- Consumes: `useMembers`, `useInvites`, `useAudit`, `useSetMemberRole`, `useRemoveMember`, `useInviteMember`, `useRevokeInvite`.
- Produces: `<MembersPage />`.

Layout: pending invites first (email, expiry, Resend, Revoke); member rows (name/email, role select with Owner fixed, project count, sync state, key-verified); a `⋯` menu per row with *Change role*, *Remove from team*, and — Owner only — *Transfer ownership*; a Defaults row; and the audit list in a right column. Removal opens a confirm dialog stating that access to every shared project is revoked immediately. The dialog is the one place a subtle shadow is allowed.

- [ ] **Step 1: Write the failing test**

```tsx
it('confirms before removing a member and says what removal does', async () => {
  renderApp({}, <MembersPage />)
  await userEvent.click(await screen.findByRole('button', { name: /more actions for Sarah/i }))
  await userEvent.click(screen.getByRole('menuitem', { name: /remove from team/i }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog).toHaveTextContent(/revokes .*access to every shared project/i)
})

it('states a broken member plainly', async () => {
  renderApp({}, <MembersPage />)
  expect(await screen.findByText(/token expired/)).toBeInTheDocument()
})

it('does not offer role changes on the owner row', async () => {
  renderApp({}, <MembersPage />)
  const ownerRow = await screen.findByTestId('member-row-me')
  expect(within(ownerRow).queryByRole('combobox')).toBeNull()
  expect(within(ownerRow).getByText('Owner')).toBeInTheDocument()
})

it('shows neither audit nor invites to a member role', async () => {
  renderApp({ role: 'member' }, <MembersPage />)
  await screen.findByText('Sarah')
  expect(screen.queryByText(/audit/i)).toBeNull()
  expect(screen.queryByRole('button', { name: /invite/i })).toBeNull()
})
```

- [ ] **Step 2-5:** run → FAIL; implement; run → 4 passing; commit.

```bash
git add ui/src/features/members ui/src/app/App.tsx
git commit -m "feat(ui): members page with roles, invites, and audit trail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Insights API

**Files:**
- Create: `lib/api-insights.js`
- Modify: `lib/server.js`, `test/run-tests.js`

**Interfaces:**
- Produces: `GET /api/team/insights?window=7|30|90` → the `Insights` shape from Task 3. 403 for a member role. Aggregation happens server-side; raw rows are never shipped to the client.

Severity rule, implemented in one place and unit-tested: a problem is `broken` when the failing share of its population is at or above 50% **or** the condition has persisted at least 24 hours; otherwise `minor`. Every problem carries its denominator in `scale`.

Skeleton stats come from `savingsPayload()` (`lib/server.js:298`): `repeatOpens = reads.sameSession + reads.crossSession`, `answeredFirst = avoided.serves`. When `reads` or `avoided` is missing, return `{available:false}`. **No dollar figure — tokens only** (see Global Constraints).

- [ ] **Step 1: Write the failing tests**

```javascript
test('a symptom affecting every session is broken', () => {
  assert.equal(insights.severityOf({ failing: 47, population: 47, sinceHours: 1 }), 'broken');
});
test('a symptom affecting two of hundreds is minor', () => {
  assert.equal(insights.severityOf({ failing: 2, population: 412, sinceHours: 1 }), 'minor');
});
test('a small but day-old symptom is broken', () => {
  assert.equal(insights.severityOf({ failing: 1, population: 100, sinceHours: 48 }), 'broken');
});
test('insights reports skeleton stats as unavailable when the ledger has none', async () => {
  const res = await apiAs('owner', 'GET', '/api/team/insights?window=30');
  assert.equal(res.status, 200);
  assert.ok('available' in res.body.skeleton);
});
test('insights never returns a dollar figure', async () => {
  const body = JSON.stringify((await apiAs('owner', 'GET', '/api/team/insights?window=30')).body);
  assert.ok(!/usd|dollar|"\$/i.test(body), 'no spend figure may appear in insights');
});
test('GET /api/team/insights is refused for a member role', async () => {
  assert.equal((await apiAs('member', 'GET', '/api/team/insights?window=30')).status, 403);
});
```

- [ ] **Step 2-5:** run → FAIL; implement; run → 6 new tests passing; commit.

```bash
git add lib/api-insights.js lib/server.js test/run-tests.js
git commit -m "feat(api): team insights aggregation with scale-based severity

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Insights page

Matches `insights-v4.html`.

**Files:**
- Create: `ui/src/features/insights/InsightsPage.tsx`, `ProblemList.tsx`, `PersonBars.tsx`, `InsightsPage.test.tsx`
- Modify: `ui/src/app/App.tsx`

**Interfaces:**
- Consumes: `useInsights`.
- Produces: `<InsightsPage />`.

Layout: window segmented control (7 / 30 / 90) + Export CSV; stat strip (sessions with trend, repeat opens answered by memory, members syncing, entries shared); activity by person as bars; **How well the skeleton is working** with exactly two lines — repeat file opens, and answered by our memory first (count · percent); most active projects; **Broken** then **Minor** sections, visually distinct, each problem showing its scale line and any action; knowledge concentration; cross-tool reach. No heat grid.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders exactly two skeleton lines', async () => {
  renderApp({}, <InsightsPage />)
  const panel = await screen.findByTestId('skeleton-panel')
  expect(within(panel).getAllByRole('row')).toHaveLength(2)
  expect(within(panel).getByText('Repeat file opens')).toBeInTheDocument()
  expect(within(panel).getByText('Answered by our memory first')).toBeInTheDocument()
})

it('shows the stat as pending rather than a number when unavailable', async () => {
  renderApp({ skeletonAvailable: false }, <InsightsPage />)
  expect(await screen.findByText(/pending/i)).toBeInTheDocument()
  expect(screen.queryByText('68%')).toBeNull()
})

it('separates broken problems from minor ones and shows each denominator', async () => {
  renderApp({}, <InsightsPage />)
  const broken = await screen.findByTestId('problems-broken')
  const minor = screen.getByTestId('problems-minor')
  expect(within(broken).getByText(/summaries never arrive/)).toBeInTheDocument()
  expect(within(broken).getByText(/47 of 47 sessions/)).toBeInTheDocument()
  expect(within(minor).getByText(/of 412/)).toBeInTheDocument()
})

it('offers the fixing action on a broken problem', async () => {
  renderApp({}, <InsightsPage />)
  expect(await screen.findByRole('button', { name: /send setup steps/i })).toBeInTheDocument()
})

it('renders no dollar figure anywhere', async () => {
  const { container } = renderApp({}, <InsightsPage />)
  await screen.findByText(/repeat file opens/i)
  expect(container.textContent).not.toMatch(/\$/)
})

it('has no heat grid', async () => {
  renderApp({}, <InsightsPage />)
  await screen.findByText(/repeat file opens/i)
  expect(screen.queryByText(/when the team works/i)).toBeNull()
})
```

- [ ] **Step 2-5:** run → FAIL; implement; run → 6 passing; commit.

```bash
git add ui/src/features/insights ui/src/app/App.tsx
git commit -m "feat(ui): insights page with skeleton stat and severity tiers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Settings page and solo first-run

Matches `settings-solo-v2.html`.

**Files:**
- Create: `ui/src/features/settings/SettingsPage.tsx`, `SettingRow.tsx`, `SettingsPage.test.tsx`, `ui/src/features/settings/FirstRun.tsx`
- Modify: `ui/src/app/App.tsx`

**Interfaces:**
- Consumes: `useSettings`, `useSetSetting`, `useStatus`.
- Produces: `<SettingsPage />`, `<FirstRun />`.

Four groups, in order: **Memory delivery** (context block, recall on read, session summaries, MCP server — each showing real installed state, a gap rendered amber with the fixing action), **Privacy** (plaintext sharing / end-to-end, redaction counts, excluded folders), **Daemon** (running state, port, version, start at login, sync interval, updates), **Team** (name, your role, member count, Manage, Leave — absent when solo). No fifth group: there is no roadmap or API-key UI.

`FirstRun` shows when `status.setupDone === false`: what MemBridge will watch, the summaries opt-in, and nothing about teams.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders exactly the four groups and no API key field', async () => {
  renderApp({}, <SettingsPage />)
  await screen.findByText('Memory delivery')
  expect(screen.getByText('Privacy')).toBeInTheDocument()
  expect(screen.getByText('Daemon')).toBeInTheDocument()
  expect(screen.getByText('Team')).toBeInTheDocument()
  expect(screen.queryByText(/roadmap/i)).toBeNull()
  expect(screen.queryByLabelText(/api key/i)).toBeNull()
  expect(screen.queryByText(/anthropic/i)).toBeNull()
})

it('marks an uninstalled delivery channel amber with its fix', async () => {
  renderApp({}, <SettingsPage />)
  const row = await screen.findByTestId('setting-mcp')
  expect(within(row).getByText(/not registered/i)).toBeInTheDocument()
  expect(within(row).getByRole('button', { name: /register/i })).toBeInTheDocument()
})

it('omits the Team group entirely in solo mode', async () => {
  renderApp({ solo: true }, <SettingsPage />)
  await screen.findByText('Memory delivery')
  expect(screen.queryByText('Team')).toBeNull()
  expect(screen.queryByRole('button', { name: /leave team/i })).toBeNull()
})
```

- [ ] **Step 2-5:** run → FAIL; implement; run → 3 passing; commit.

```bash
git add ui/src/features/settings ui/src/app/App.tsx
git commit -m "feat(ui): settings page and solo first-run

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Serve the new UI at /app

The cutover itself is NOT in this plan. The old dashboard stays the default at `/`.

**Files:**
- Modify: `lib/server.js`, `scripts/prepare-app.js`, `test/run-tests.js`
- Create: `docs/superpowers/specs/CUTOVER-CHECKLIST.md`

**Interfaces:**
- Produces: `GET /app` and `GET /app/*` serving `ui/dist` with SPA fallback. `/` unchanged.

- [ ] **Step 1: Write the failing test**

```javascript
test('GET /app serves the new UI shell', async () => {
  const res = await api('/app/');
  assert.equal(res.status, 200);
  assert.ok(/<div id="root">/.test(res.text), 'SPA root element present');
});

test('an unknown /app path falls back to the SPA shell', async () => {
  const res = await api('/app/team/members');
  assert.equal(res.status, 200);
  assert.ok(/<div id="root">/.test(res.text));
});

test('a missing /app asset is a 404, not the shell', async () => {
  assert.equal((await api('/app/assets/nope-does-not-exist.js')).status, 404);
});

test('the legacy dashboard still serves at /', async () => {
  const res = await api('/');
  assert.equal(res.status, 200);
  assert.ok(res.text.length > 0);
});

test('hashed assets are cached and the shell is not', async () => {
  const shell = await api('/app/');
  assert.match(String(shell.headers['cache-control'] || ''), /no-store/);
});
```

- [ ] **Step 2: Implement static serving**

Serve from `path.join(__dirname, '..', 'ui', 'dist')` — always `path.join`, never string concatenation. Set `cache-control: no-store` for `index.html` and a long `max-age` for hashed assets. Guard against path traversal: resolve the requested path and reject anything that escapes the dist root. When `ui/dist` is absent, `/app` returns a plain 503 with a one-line "UI not built" message rather than throwing.

- [ ] **Step 3: Include the built UI in the packaged app**

Modify `scripts/prepare-app.js` to copy `ui/dist` into the app bundle, using `fs.cpSync` with `path.join` (no shell commands).

- [ ] **Step 4: Write the cutover checklist**

`docs/superpowers/specs/CUTOVER-CHECKLIST.md` — what a human must verify before `lib/dashboard/*` and `web/` are deleted: every screen exercised in the packaged app on macOS AND Windows, light and dark, solo and team, a member-role account, a behind project, a broken member, and the full root suite green on both platforms.

- [ ] **Step 5: Verify and commit**

Run: `cd ui && npm run build` then `node test/run-tests.js`.

```bash
git add lib/server.js scripts/prepare-app.js test/run-tests.js docs/superpowers/specs/CUTOVER-CHECKLIST.md
git commit -m "feat(server): serve the rebuilt UI at /app alongside the legacy dashboard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Windows CI

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a build matrix that fails the run on a Windows-only regression.

- [ ] **Step 1: Read the existing workflow**

Read `.github/workflows/ci.yml` and note the current job name, Node version, and steps.

- [ ] **Step 2: Add the matrix**

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

Steps, in order: checkout; setup-node 18; `npm ci` at root; `node test/run-tests.js`; `npm ci` in `ui/`; `npm run build` in `ui/`; `npx vitest run` in `ui/`. Use `working-directory: ui` rather than `cd ui &&` so the step works in cmd.exe and PowerShell.

- [ ] **Step 3: Verify locally what you can**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/windows-latest/.test(y)) throw new Error('windows missing'); console.log('ok')"`
Expected: `ok`. Note in your report that the real Windows run can only be confirmed on CI.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run tests and the UI build on Windows and macOS

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** §3.1 Today → Task 7. §3.2 Projects → Task 10 (API in 8). §3.3 project page → Task 9. §3.4 Members → Task 11 (API in 8). §3.5 Insights → Tasks 12-13. §3.6 Settings → Task 14. §3.7 solo → Tasks 6, 7, 14. §4 visual system → Tasks 2, 5 + Global Constraints. §5 architecture → Tasks 2-6. §6.1/6.2 endpoints → Tasks 4, 8, 12. §6.3 roles → Tasks 8, 12 (enforcement) and 9-11 (UI). §6.4 tables → Task 8. §7 performance → Tasks 4 (polling/caching), 10 (single request). §8 Windows → Global Constraints + Tasks 1, 2, 15, 16. §9.1 EOL → Task 1. §10 build order → task order. §11 testing → every task. Feed (nav item) intentionally renders a Placeholder: the spec lists no Feed screen requirements, so building it would be speculative.

**Placeholder scan.** No TBDs. Task 10, 11, 13, 14 compress steps 2-5 into one line each because their step content is identical in form to Tasks 7 and 9 — the test code and layout requirements are given in full, which is what an implementer needs.

**Type consistency.** `SyncState` is the discriminated union from Task 3 and is consumed unchanged in Tasks 5, 7, 9, 10. `Insights.skeleton` is `{available:false} | {available:true,...}` in Task 3, produced by Task 12, consumed by Task 13. `AccessMatrix` is defined in Task 3, produced by Task 8's endpoint, consumed in Task 10. `severityOf` is exported from `lib/api-insights.js` in Task 12 and tested there only.

**Known deviation from the spec, resolved:** spec §9.2 says skeleton stats are blocked on the unmerged recall ledger. They are not — `savingsPayload()` (`lib/server.js:298`) already computes `reads.sameSession`, `reads.crossSession`, and `avoided.serves`. Task 12 uses those and keeps the `{available:false}` path for installs whose ledger is empty.
