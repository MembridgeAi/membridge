# Day-card area tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put up to three area tags (`UI/UX`, `Backend`, `Data/Schema`, …) on every day card, derived from the files that day touched, so the Feed can be scanned for who worked on what.

**Architecture:** One new pure module, `ui/src/features/feed/areaTags.ts`, maps a file path to one of eight areas and selects which areas earn a tag. `buildDayCards` calls it once per card and stores the result on the card model; `DayCard.tsx` renders the tags as inert spans. No daemon change, no schema change, no new API field — the tags are computed client-side from the `files` array `/api/feed` already ships.

**Tech Stack:** TypeScript, React, vitest, Testing Library.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-session-headers-and-day-tags-design.md`. Piece B only. Session-page headers (piece A) are NOT in this plan.
- **Vocabulary is exactly eight areas in this precedence order**, first match wins: `Data/Schema`, `Build/CI`, `Tests`, `Docs`, `UI/UX`, `Integrations`, `Config`, `Backend`.
- **Punctual areas** (tag on presence): `Data/Schema`, `Build/CI`, `Integrations`. **Ambient areas** (tag at ≥25% share): all others.
- **Maximum 3 tags per card**, ordered by files touched, descending.
- **Nothing inside a day card may be a link, button, or focusable element.** The card is itself an `<a>` (`DayCard.tsx:88`); a nested anchor is unnested by the parser and the live DOM stops matching the JSX. Tags are `<span>`s. This is why tag filtering is out of scope.
- **Style:** no semicolons, single quotes, 2-space indent — match `dayCards.ts`.
- **Verification per `.claude/rules/testing.md`:** `cd ui && npx tsc --noEmit` then `npx vitest run <file>`. Never the full vitest suite, never `node test/run.js` bare.
- **Never commit to master. Never push.** Work stays on this branch.

---

## Deviation from the spec — resolve before Task 1

The spec's guard says path keys "must resolve through `repoRoot.ledgerKeyFor` / `wireKeyFor`, never a raw relative path."

**That is not reachable from this code.** `lib/repo-root.js` is a Node module that shells out to git; this work runs in the browser bundle. `/api/feed` ships paths in whatever form the daemon stored them, and a live sample confirms the client really does receive worktree-prefixed paths (`.claude/worktrees/<name>/lib/scan.js`, 35 occurrences in one page) and absolute paths.

Two ways to honour the guard:

- **(A) Client-side `repoRelative()`** — a tested pure function stripping the two worktree conventions this repo uses plus absolute prefixes. Ships in this plan, no daemon change. A path shape it does not know produces a *wrong tag*, which is cheap and visible.
- **(B) Normalise daemon-side in `lib/feed.js`** — correct per the spec, but it changes the `files` array the day view *displays*, which is a visible change to an unrelated surface, and it needs node-suite coverage.

**This plan implements (A)** and files (B) as a follow-up, because a wrong tag is low-cost and reversible where changing displayed paths is not. Task 1's tests pin the exact shapes handled. If you prefer (B), stop and re-plan Task 1 — nothing downstream changes.

---

## File Structure

| File | Responsibility |
|---|---|
| `ui/src/features/feed/areaTags.ts` (create) | Path → area mapping, exclusions, selection rule. Pure, no React, no I/O. |
| `ui/src/features/feed/areaTags.test.ts` (create) | Unit tests for the above. |
| `ui/src/features/feed/dayCards.ts` (modify) | Add `tags` to `DayCard`; populate in `buildDayCards`. |
| `ui/src/features/feed/dayCards.test.ts` (modify) | Card-level wiring test. |
| `ui/src/features/feed/DayCard.tsx` (modify) | Render tags as inert spans. |
| `ui/src/features/feed/feed.css` (modify) | Grid row 5 for the tag strip. |

`areaTags.ts` is deliberately separate from `dayCards.ts`, which is already 1,101 lines.

---

### Task 1: Path → area mapping

**Files:**
- Create: `ui/src/features/feed/areaTags.ts`
- Test: `ui/src/features/feed/areaTags.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Area`, `repoRelative(file: string): string`, `isProjectFile(file: string): boolean`, `areaOf(file: string): Area | null`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/features/feed/areaTags.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { areaOf, isProjectFile, repoRelative } from './areaTags'

describe('repoRelative', () => {
  it('strips this repo\'s two worktree conventions', () => {
    expect(repoRelative('.claude/worktrees/agent-x/lib/scan.js')).toBe('lib/scan.js')
    expect(repoRelative('.worktrees/run-abc/ui/src/App.tsx')).toBe('ui/src/App.tsx')
  })

  it('strips an absolute checkout prefix, keeping the repo-relative tail', () => {
    expect(repoRelative('/Users/andrew/membridge/membridge/lib/feed.js')).toBe('lib/feed.js')
  })

  it('leaves an already-relative path alone', () => {
    expect(repoRelative('lib/feed.js')).toBe('lib/feed.js')
  })
})

describe('isProjectFile', () => {
  it('rejects agent scratch, build output and binaries', () => {
    expect(isProjectFile('scratchpad/shot.png')).toBe(false)
    expect(isProjectFile('tasks/bm8wp0s8h.output')).toBe(false)
    expect(isProjectFile('node_modules/react/index.js')).toBe(false)
    expect(isProjectFile('package-lock.json')).toBe(false)
  })

  it('accepts ordinary source', () => {
    expect(isProjectFile('lib/feed.js')).toBe(true)
  })
})

describe('areaOf', () => {
  it('maps each area', () => {
    expect(areaOf('supabase/migrations/057_x.sql')).toBe('Data/Schema')
    expect(areaOf('.github/workflows/ci.yml')).toBe('Build/CI')
    expect(areaOf('test/suites/redaction.test.js')).toBe('Tests')
    expect(areaOf('docs/guide.md')).toBe('Docs')
    expect(areaOf('ui/src/features/feed/FeedPage.tsx')).toBe('UI/UX')
    expect(areaOf('lib/mcp.js')).toBe('Integrations')
    expect(areaOf('.claude/rules/testing.md')).toBe('Config')
    expect(areaOf('lib/feed.js')).toBe('Backend')
  })

  // Precedence is the design. Both of these match two rules; the ORDER decides.
  it('gives a UI test file to Tests, not UI/UX', () => {
    expect(areaOf('ui/src/features/feed/FeedPage.test.tsx')).toBe('Tests')
  })

  it('gives an MCP test file to Tests, not Integrations', () => {
    expect(areaOf('test/suites/mcp-config.test.js')).toBe('Tests')
  })

  it('gives scripts/ to Backend', () => {
    expect(areaOf('scripts/install/gen-install.js')).toBe('Backend')
  })

  it('normalises before matching, so a worktree path is not Config', () => {
    expect(areaOf('.claude/worktrees/agent-x/lib/scan.js')).toBe('Backend')
  })

  it('returns null for an excluded or unrecognised file', () => {
    expect(areaOf('scratchpad/shot.png')).toBe(null)
    expect(areaOf('runs/run-x/mission.json')).toBe(null)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ui && npx vitest run src/features/feed/areaTags.test.ts
```

Expected: FAIL — `Failed to resolve import "./areaTags"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/features/feed/areaTags.ts`:

```ts
// Area tags for a day card: which parts of the codebase a day's work touched.
//
// Derived from FILE PATHS, not from anything an agent wrote, so it works on
// every session already captured rather than only on new ones. See
// docs/superpowers/specs/2026-08-12-session-headers-and-day-tags-design.md.

/** The fixed vocabulary. Fixed rather than freeform because these are SCANNED:
 *  "UI/UX" and "UI" and "Frontend" as three separate tags would defeat the
 *  entire purpose. */
export type Area =
  | 'Data/Schema' | 'Build/CI' | 'Tests' | 'Docs'
  | 'UI/UX' | 'Integrations' | 'Config' | 'Backend'

/** Ordered. FIRST MATCH WINS, and the order carries two decisions:
 *
 *    * Tests precedes UI/UX, so ui/**\/*.test.tsx is Tests. A test is a test
 *      wherever it lives.
 *    * Tests precedes Integrations, so test/suites/mcp-config.test.js is Tests
 *      rather than Integrations; Integrations is for integration CODE.
 *
 *  Changing this order changes what every historical card says, so it is not a
 *  detail to tidy. */
const AREA_RULES: Array<{ area: Area; patterns: RegExp[] }> = [
  { area: 'Data/Schema', patterns: [/(^|\/)(migrations?|supabase|prisma|db)\//i, /\.sql$/i] },
  { area: 'Build/CI', patterns: [/(^|\/)\.github\//i, /(^|\/)(Dockerfile|Makefile)$/i, /(^|\/)(webpack|vite|rollup|esbuild)\.config\./i] },
  { area: 'Tests', patterns: [/(^|\/)(tests?|spec|__tests__|e2e)\//i, /\.(test|spec)\.[jt]sx?$/i] },
  { area: 'Docs', patterns: [/(^|\/)docs?\//i, /\.mdx?$/i] },
  { area: 'UI/UX', patterns: [/(^|\/)(ui|frontend|client|components?|views?|templates?|styles?|public)\//i, /\.(tsx|jsx|vue|svelte|css|scss|less|html)$/i] },
  { area: 'Integrations', patterns: [/(^|\/)(adapters?|connectors?|integrations?|hooks?)\//i, /(^|\/)(mcp|webhook|oauth)[-.]?[a-z]*\.[jt]s$/i] },
  { area: 'Config', patterns: [/(^|\/)\.claude\//i, /(^|\/)(config|settings)\.[a-z]+$/i, /(^|\/)\.[a-z]+rc/i, /(^|\/)\.env/i] },
  { area: 'Backend', patterns: [/(^|\/)(lib|src|server|api|services?|bin|scripts|app)\//i, /\.(js|ts|py|rb|go|rs|java|php)$/i] },
]

/** Agent working files are not project work. Measured: before this filter, 33
 *  distinct unmatched paths across the whole local corpus were scratchpad
 *  screenshots and task output; after it, 6. Left in, they inflate a day's file
 *  count and can hand a tag to a session that edited nothing but its own
 *  scratch. */
const NOT_PROJECT: RegExp[] = [
  /(^|\/)(private\/)?tmp\//i,
  /(^|\/)scratchpad\//i,
  /(^|\/)tasks\/[a-z0-9]+\.output$/i,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)(dist|build|coverage)\//,
  /\.(png|jpe?g|gif|webp|svg|ico|lock)$/i,
  /(^|\/)package-lock\.json$/,
]

/** Almost all work in this repo happens inside a worktree, so a raw path
 *  beginning `.claude/worktrees/` is the COMMON case, not an edge one -- and
 *  left raw it matches the Config rule, tagging every worktree session
 *  `Config`.
 *
 *  This is a string-level approximation of lib/repo-root.js ledgerKeyFor,
 *  which is a Node module and unreachable from the browser bundle. A path shape
 *  not handled here yields a wrong tag, which is cheap and visible; see the
 *  "Deviation" section of the plan for why that trade was taken over
 *  normalising daemon-side. */
export function repoRelative(file: string): string {
  return String(file || '')
    .replace(/^.*?\.claude\/worktrees\/[^/]+\//, '')
    .replace(/^.*?\.worktrees\/[^/]+\//, '')
    .replace(/^\/(?:Users|home)\/[^/]+\/[^/]+\/[^/]+\//, '')
    .replace(/^\.\//, '')
}

export function isProjectFile(file: string): boolean {
  const f = repoRelative(file)
  return !!f && !NOT_PROJECT.some(p => p.test(f))
}

/** The area a file belongs to, or null when it is excluded or unrecognised.
 *  Null is a real answer, not a failure: `runs/x/mission.json` genuinely is not
 *  one of the eight. */
export function areaOf(file: string): Area | null {
  const f = repoRelative(file)
  if (!f || !isProjectFile(f)) return null
  for (const { area, patterns } of AREA_RULES) {
    for (const p of patterns) if (p.test(f)) return area
  }
  return null
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd ui && npx vitest run src/features/feed/areaTags.test.ts
```

Expected: PASS, 12 tests.

```bash
cd ui && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/feed/areaTags.ts ui/src/features/feed/areaTags.test.ts
git commit -m "feat(feed): map a file path to one of eight areas"
```

---

### Task 2: The selection rule

**Files:**
- Modify: `ui/src/features/feed/areaTags.ts`
- Test: `ui/src/features/feed/areaTags.test.ts`

**Interfaces:**
- Consumes: `areaOf` from Task 1.
- Produces: `interface AreaTag { area: Area; files: number }`, `areaTagsFor(files: Array<{ file: string }>): AreaTag[]`.

The input is `Array<{ file: string }>` rather than `string[]` so a `DayFile[]` can be passed straight in without mapping.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/feed/areaTags.test.ts`:

```ts
import { areaTagsFor } from './areaTags'

const f = (...paths: string[]) => paths.map(file => ({ file }))

describe('areaTagsFor', () => {
  it('drops an ambient area below a 25% share', () => {
    // 1 doc among 8 files = 12.5%. Docs is touched by nearly every session, so
    // below a material share it says nothing.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'ui/b.tsx', 'ui/c.tsx', 'ui/d.tsx',
      'ui/e.tsx', 'ui/f.tsx', 'ui/g.tsx', 'docs/x.md',
    ))
    expect(tags.map(t => t.area)).toEqual(['UI/UX'])
  })

  it('keeps a punctual area on presence, however small its share', () => {
    // The reason this rule exists: MCP work is 1 file among 8, and "they went
    // into the MCP server" is exactly what a reader wants to know.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'ui/b.tsx', 'ui/c.tsx', 'ui/d.tsx',
      'ui/e.tsx', 'ui/f.tsx', 'ui/g.tsx', 'lib/mcp.js',
    ))
    expect(tags.map(t => t.area)).toEqual(['UI/UX', 'Integrations'])
  })

  it('orders by files touched, so one CI file cannot headline a UI day', () => {
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'ui/b.tsx', 'ui/c.tsx', '.github/workflows/ci.yml',
    ))
    expect(tags.map(t => t.area)).toEqual(['UI/UX', 'Build/CI'])
  })

  it('caps at three', () => {
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'lib/a.js', 'docs/a.md', 'test/a.test.js',
      'supabase/migrations/1.sql', '.github/workflows/ci.yml',
    ))
    expect(tags).toHaveLength(3)
  })

  it('falls back to the heaviest area when nothing clears the bar', () => {
    // Four areas at 25% each would all qualify; make each 20% so none does.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'ui/b.tsx', 'lib/a.js', 'lib/b.js', 'docs/a.md',
    ))
    expect(tags).toHaveLength(1)
    expect(['UI/UX', 'Backend']).toContain(tags[0].area)
  })

  it('returns nothing when no file is recognised', () => {
    expect(areaTagsFor(f('scratchpad/a.png', 'runs/x/mission.json'))).toEqual([])
  })

  it('counts a file once however many times it appears', () => {
    const tags = areaTagsFor(f('lib/a.js', 'lib/a.js', 'lib/a.js', 'ui/a.tsx'))
    expect(tags.find(t => t.area === 'Backend')?.files).toBe(1)
  })

  it('is stable when two areas tie', () => {
    const once = areaTagsFor(f('ui/a.tsx', 'lib/a.js'))
    const twice = areaTagsFor(f('lib/a.js', 'ui/a.tsx'))
    expect(once.map(t => t.area)).toEqual(twice.map(t => t.area))
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ui && npx vitest run src/features/feed/areaTags.test.ts
```

Expected: FAIL — `areaTagsFor is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `ui/src/features/feed/areaTags.ts`:

```ts
/** Areas that earn a tag on PRESENCE rather than on share.
 *
 *  The split is the whole design. Measured over the local corpus, tagging every
 *  area a day touched put Docs on 73% of cards and UI/UX on 68% -- a tag that
 *  fires on most cards cannot answer "who worked on X". But a flat share
 *  threshold has the opposite failure: it silenced Integrations completely,
 *  because MCP work is two files inside a twenty-file day.
 *
 *  So: areas touched by almost everything must earn their tag, and areas
 *  touched by almost nothing are worth saying whenever they appear. */
const PUNCTUAL: ReadonlySet<Area> = new Set<Area>(['Data/Schema', 'Build/CI', 'Integrations'])

/** Share of a card's recognised files an AMBIENT area must reach. */
const AMBIENT_SHARE = 0.25

/** Most tags a card carries. Past three the strip stops being scannable, which
 *  is the only thing it is for. */
const TAG_LIMIT = 3

export interface AreaTag {
  area: Area
  /** Distinct files this card touched in this area. Drives the ordering, and
   *  is exposed so the renderer can title the tag. */
  files: number
}

/** The areas a day's files earn, most-touched first, at most three.
 *
 *  Counts DISTINCT files, not touches: a day that edited one file thirty times
 *  worked in one area, and weighting by touch count would let a single
 *  hot file outrank a whole subsystem. */
export function areaTagsFor(files: Array<{ file: string }>): AreaTag[] {
  const seen = new Set<string>()
  const counts = new Map<Area, number>()
  let total = 0
  for (const { file } of files) {
    const key = repoRelative(file)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const area = areaOf(key)
    if (!area) continue
    counts.set(area, (counts.get(area) ?? 0) + 1)
    total++
  }
  if (total === 0) return []

  // Sorted by weight, ties broken on name so the same day always renders the
  // same strip -- an unstable order would make a card flicker between renders.
  const ranked = [...counts.entries()]
    .map(([area, n]): AreaTag => ({ area, files: n }))
    .sort((a, b) => b.files - a.files || a.area.localeCompare(b.area))

  const kept = ranked.filter(t => PUNCTUAL.has(t.area) || t.files / total >= AMBIENT_SHARE)
  // A card with recognised files always says something: if every area fell
  // below the bar, the heaviest one is still the truest thing available.
  return (kept.length > 0 ? kept : ranked.slice(0, 1)).slice(0, TAG_LIMIT)
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd ui && npx vitest run src/features/feed/areaTags.test.ts
```

Expected: PASS, 20 tests.

```bash
cd ui && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/feed/areaTags.ts ui/src/features/feed/areaTags.test.ts
git commit -m "feat(feed): ambient areas earn a tag by share, punctual ones on presence"
```

---

### Task 3: Put tags on the card model

**Files:**
- Modify: `ui/src/features/feed/dayCards.ts` (`DayCard` interface ~line 951; `buildDayCards` ~line 1042)
- Test: `ui/src/features/feed/dayCards.test.ts`

**Interfaces:**
- Consumes: `areaTagsFor`, `AreaTag` from Task 2.
- Produces: `DayCard.tags: AreaTag[]`.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/feed/dayCards.test.ts`:

```ts
describe('buildDayCards tags', () => {
  it('tags a card from the files its day touched', () => {
    const cards = buildDayCards([
      entry({ id: 'a', files: ['ui/src/App.tsx', 'ui/src/Shell.tsx', 'ui/src/x.css'] }),
      entry({ id: 'b', files: ['supabase/migrations/057_x.sql'] }),
    ])
    expect(cards[0].tags.map(t => t.area)).toEqual(['UI/UX', 'Data/Schema'])
  })

  it('gives a card with no recognised files an empty list, never undefined', () => {
    const cards = buildDayCards([entry({ id: 'a', files: [] })])
    expect(cards[0].tags).toEqual([])
  })

  it('counts a file named by changes as well as by files', () => {
    const cards = buildDayCards([
      entry({ id: 'a', files: [], changes: [{ file: 'lib/feed.js', note: 'x' }] }),
    ])
    expect(cards[0].tags.map(t => t.area)).toEqual(['Backend'])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ui && npx vitest run src/features/feed/dayCards.test.ts -t 'buildDayCards tags'
```

Expected: FAIL — `Property 'tags' does not exist on type 'DayCard'`.

- [ ] **Step 3: Write the implementation**

In `ui/src/features/feed/dayCards.ts`, add to the imports at the top of the file:

```ts
import { areaTagsFor, type AreaTag } from './areaTags'
```

Add this field to the `DayCard` interface, immediately after `files: DayFile[]`:

```ts
  /** Which parts of the codebase this day touched, most-touched first, at most
   *  three. Derived from `files`, so it is available on every day already
   *  captured rather than only on days recorded after this shipped. Empty when
   *  nothing recognisable was touched -- an empty strip, never a fake tag. */
  tags: AreaTag[]
```

In `buildDayCards`, the card literal already computes `files: dayFiles(sorted)`. Replace that single line with a hoisted binding and reuse it, so the file list is built once:

```ts
    const files = dayFiles(sorted)
```

placed immediately after the existing `const bullets = dayBullets(sessions, overview)` line, and then inside the `cards.push({ ... })` literal replace `files: dayFiles(sorted),` with:

```ts
      files,
      // dayFiles already folds `changes[].file` in alongside `files`, so a file
      // that only ever appeared as a change note still counts toward its area.
      tags: areaTagsFor(files),
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd ui && npx vitest run src/features/feed/dayCards.test.ts
```

Expected: PASS, whole file green.

```bash
cd ui && npx tsc --noEmit
```

Expected: no output. If it reports a missing `tags` on a `DayCard` literal elsewhere, add `tags: []` there — a fixture, not a code path.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/feed/dayCards.ts ui/src/features/feed/dayCards.test.ts
git commit -m "feat(feed): carry area tags on the day card model"
```

---

### Task 4: Render the tags

**Files:**
- Modify: `ui/src/features/feed/DayCard.tsx`
- Modify: `ui/src/features/feed/feed.css`
- Test: `ui/src/features/feed/FeedPage.test.tsx`

**Interfaces:**
- Consumes: `DayCard.tags` from Task 3.
- Produces: markup with `data-testid="day-card-tags"`; each tag a `<span className="day-card-tag">`.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/feed/FeedPage.test.tsx`, inside the existing `describe('FeedPage', ...)`. This mirrors the render pattern the file already uses — `new FakeDataClient()`, `vi.spyOn(c, 'getFeed').mockResolvedValue(...)`, `renderWith(c, <FeedPage />)` — and the local `entry()` fixture helper defined at the top of that file:

```tsx
  it('shows the areas a day touched, as inert tags', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({
        id: 'a', session: 's-1', outcome: 'Reworked the feed cards',
        files: ['ui/src/features/feed/DayCard.tsx', 'ui/src/features/feed/feed.css'],
      })],
      nextBefore: null, dayDigests: [],
    })
    renderWith(c, <FeedPage />)

    const card = (await screen.findByText('Reworked the feed cards')).closest('.day-card') as HTMLElement
    const tags = within(card).getByTestId('day-card-tags')
    expect(tags).toHaveTextContent('UI/UX')
    // The card is itself an <a>; a nested interactive element would be unnested
    // by the parser and the DOM would stop matching the JSX.
    expect(tags.querySelector('a, button')).toBeNull()
  })

  it('renders no tag strip at all for a day with no recognisable files', async () => {
    const c = new FakeDataClient()
    vi.spyOn(c, 'getFeed').mockResolvedValue({
      entries: [entry({ id: 'a', session: 's-1', outcome: 'Thinking, mostly', files: [] })],
      nextBefore: null, dayDigests: [],
    })
    renderWith(c, <FeedPage />)

    const card = (await screen.findByText('Thinking, mostly')).closest('.day-card') as HTMLElement
    expect(within(card).queryByTestId('day-card-tags')).toBeNull()
  })
```

Check the local `entry()` helper at the top of `FeedPage.test.tsx` accepts a `files` override; every `FeedEntry` fixture in this repo carries `files: []` by default, so it should. If it does not, add `files` to its `Partial<FeedEntry>` spread rather than building a second helper.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ui && npx vitest run src/features/feed/FeedPage.test.tsx -t 'area tags'
```

Expected: FAIL — `Unable to find an element by: [data-testid="day-card-tags"]`.

**If it fails with a timeout or an unrelated missing element, STOP.** Per `.claude/rules/agent-team.md` that is the documented phantom-failure signature. Re-run through the gate before believing it:

```bash
node scripts/verify-finding.js --ui src/features/feed/FeedPage.test.tsx --runs 3
```

- [ ] **Step 3: Write the implementation**

In `ui/src/features/feed/DayCard.tsx`, insert immediately before the `<span className="mono day-card-stats">` line:

```tsx
      {/* Which parts of the codebase this day touched. Spans, never links:
          this card is itself an <a> (see the note above), so a nested anchor
          would be unnested by the parser and the DOM would stop matching this
          JSX. Filtering by tag therefore lives on the Feed's own filter bar if
          it is ever built, never here. */}
      {card.tags.length > 0 && (
        <span className="day-card-tags" data-testid="day-card-tags">
          {card.tags.map(t => (
            <span
              key={t.area}
              className="mono day-card-tag"
              title={`${t.files} ${t.files === 1 ? 'file' : 'files'} in ${t.area}`}
            >
              {t.area}
            </span>
          ))}
        </span>
      )}
```

In `ui/src/features/feed/feed.css`, add after the `.day-card-coverage` block:

```css
/* The area strip: what this day touched, at most three. Row 5, under the
 * coverage note, spanning the same content columns as the two text lines above
 * it so the card keeps one left edge. Inert by construction -- see DayCard.tsx
 * for why nothing in here may be interactive. */
.day-card-tags {
  grid-column: 2 / 4;
  grid-row: 5;
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.day-card-tag {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--text3);
  font-size: 10px;
  line-height: 1.6;
  white-space: nowrap;
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd ui && npx vitest run src/features/feed/FeedPage.test.tsx
```

Expected: PASS.

```bash
cd ui && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/feed/DayCard.tsx ui/src/features/feed/feed.css ui/src/features/feed/FeedPage.test.tsx
git commit -m "feat(feed): show area tags on the day card"
```

---

### Task 5: Lock the distribution invariant

**Files:**
- Modify: `ui/src/features/feed/areaTags.test.ts`

**Interfaces:**
- Consumes: `areaTagsFor` from Task 2.
- Produces: nothing. This is a guard, not an API.

This is the test the spec asks for by name. Without it, a future change to the vocabulary or the threshold can quietly return the feature to "every card says Docs", which is indistinguishable from working unless someone measures.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/feed/areaTags.test.ts`:

```ts
// A tag that fires on most cards cannot answer "who worked on X". This is the
// property the feature exists for, so it is asserted directly rather than left
// to a reviewer to notice.
//
// The corpus is a hand-built stand-in for the shape of real days, taken from
// the backtest in docs/superpowers/specs/. Shipping the real corpus is not an
// option -- it is one person's private history -- so this asserts the RULE on
// representative days rather than re-deriving the measured numbers.
describe('distribution invariant', () => {
  const DAYS: string[][] = [
    ['ui/a.tsx', 'ui/b.tsx', 'ui/c.css', 'docs/x.md'],
    ['lib/a.js', 'lib/b.js', 'test/a.test.js', 'docs/y.md'],
    ['docs/a.md', 'docs/b.md', 'README.md'],
    ['ui/d.tsx', 'ui/e.tsx', 'lib/c.js', 'supabase/migrations/1.sql'],
    ['test/b.test.js', 'test/c.test.js', 'lib/d.js'],
    ['lib/e.js', 'lib/f.js', 'lib/mcp.js'],
    ['ui/f.tsx', 'ui/g.tsx', 'ui/h.tsx', 'ui/i.css'],
    ['.github/workflows/ci.yml', 'lib/g.js', 'docs/z.md'],
  ]

  it('lets no area tag more than half the days', () => {
    const fired = new Map<string, number>()
    for (const day of DAYS) {
      for (const tag of areaTagsFor(day.map(file => ({ file })))) {
        fired.set(tag.area, (fired.get(tag.area) ?? 0) + 1)
      }
    }
    const over = [...fired.entries()].filter(([, n]) => n / DAYS.length > 0.5)
    expect(over).toEqual([])
  })

  it('keeps the strip short enough to scan', () => {
    const sizes = DAYS.map(d => areaTagsFor(d.map(file => ({ file }))).length)
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length
    expect(mean).toBeLessThanOrEqual(2.5)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **Step 2: Run it**

```bash
cd ui && npx vitest run src/features/feed/areaTags.test.ts
```

Expected: PASS. **If either assertion fails, do not adjust the assertion** — it is the specification. Fix the rule, or stop and escalate.

- [ ] **Step 3: Verify against the real corpus**

The unit corpus above is representative, not real. Confirm the rule still holds on actual history:

```bash
node docs/superpowers/specs/2026-08-12-session-headers-and-day-tags-backtest.js
```

Expected: the `salience` block reports `0 tag(s) fire on >50%`. Note that the backtest measures per SESSION while the card is per PERSON-DAY, so the percentages will not match the spec's table exactly; the invariant is what must hold, not the numbers.

- [ ] **Step 4: Commit**

```bash
git add ui/src/features/feed/areaTags.test.ts
git commit -m "test(feed): no area may tag more than half of days"
```

---

## Follow-ups (do NOT do these in this plan)

- Normalise paths daemon-side via `repoRoot.ledgerKeyFor` in `lib/feed.js`, replacing `repoRelative` — option (B) above.
- Filtering the Feed by tag. Needs the filter bar, not the card.
- Tags on the day view (`DayPage.tsx`) and the project page.
- Session-page area headers — piece A of the spec, its own plan.
- Per-repo vocabulary overrides for installs whose layout the eight areas fit badly.

## Self-Review

**Spec coverage.** Vocabulary and precedence → Task 1. Ambient/punctual selection, weight ordering, 3-cap, single-area fallback → Task 2. Both required guards (path normalisation, scratch exclusion) → Task 1. Retroactive-by-construction → Task 3 (derived from `files`, no new capture). Distribution invariant → Task 5. Display-only/no-links → Task 4. "No migration" holds: nothing here touches the daemon, the wire, or the schema.

**Known gap, stated rather than hidden:** the spec mandates `repoRoot.ledgerKeyFor`; this plan ships a client-side approximation because the browser bundle cannot reach a Node module. See the Deviation section. This is the one place the plan knowingly departs from the spec.

**Type consistency.** `Area`, `AreaTag`, `areaOf`, `areaTagsFor`, `repoRelative`, `isProjectFile` are used with the same names and signatures in every task that references them. `areaTagsFor` takes `Array<{ file: string }>` throughout, which is what `DayFile[]` satisfies.
