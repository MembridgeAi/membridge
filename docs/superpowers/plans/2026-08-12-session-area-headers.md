# Session-page area headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the session page's "What" list under area headers, so a session that touched the React app and the MCP server reads as two labelled groups instead of one flat list.

**Architecture:** The Stop hook asks each `decisions`/`gotchas` point to begin with an area in square brackets — `[UI/UX] Removed the transfer-ownership menu item`. That prefix rides the existing TEXT columns to teammates with no schema change. The session page parses the prefix and groups by it. The vocabulary is canonical in `lib/hooks.js` only; the UI groups by whatever label it finds and keeps no list of its own, so the two cannot drift in code. A node test pins them to the tags vocabulary.

**Tech Stack:** Node (CommonJS) for the hook, TypeScript/React/vitest for the UI.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-12-session-headers-and-day-tags-design.md`, piece A. Piece B (day-card tags) already shipped on the branch beneath this one — do not modify `ui/src/features/feed/areaTags.ts` or anything else under `ui/src/features/feed/`.
- **The vocabulary is exactly these eight, spelled exactly this way:** `Data/Schema`, `Build/CI`, `Tests`, `Docs`, `UI/UX`, `Integrations`, `Config`, `Backend`.
- **A missing prefix is legal and must stay legal.** Every summary already captured has no prefix, and other writers (the Codex adapter, older installs) go through the same `runAppend`. Rejecting unprefixed points would break them. Only an *unrecognised* label is rejected.
- **`POINT_MAX` (120) is measured on the text AFTER the prefix is stripped.** Measured against the raw line, `[Integrations] ` silently eats 15 characters of every point's budget.
- **Style:** `lib/` is CommonJS with semicolons. `ui/` has NO semicolons, single quotes, 2-space indent. Match the file you are in.
- **Verification per `.claude/rules/testing.md`:** `node test/run.js hooks` for the hook, `cd ui && npx tsc --noEmit` plus targeted `npx vitest run <file>` for the UI. Never `node test/run.js` bare, never the full vitest suite — both are hook-blocked.
- **Never commit to master. Never push.** Branch is `feat/session-area-headers`.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/hooks.js` (modify) | Owns `AREAS`. Asks for the prefix in the Stop-hook prompt; parses and validates it in `runAppend`. |
| `test/suites/hooks.test.js` (modify) | Validation coverage, and the parity guard pinning `AREAS` to the tags vocabulary. |
| `ui/src/features/session/distill.ts` (modify) | `whatGroups` replaces `whatBullets`: parses the prefix and decides whether to group. |
| `ui/src/features/session/distill.test.ts` (modify) | Unit coverage for parsing and the grouping threshold. |
| `ui/src/features/session/BriefWidgets.tsx` (modify) | Renders the groups with headers. |
| `ui/src/features/session/session.css` (modify) | The header's style. |
| `ui/src/features/session/BriefWidgets.test.tsx` (modify) | Render coverage. |

---

### Task 1: The hook owns the vocabulary

**Files:**
- Modify: `lib/hooks.js` (`POINT_MAX`/`POINTS_MAX` near line 88; `blockReason`'s field asks near lines 229-230; `runAppend`'s per-field loop near lines 278-289; the `module.exports` list near line 2258)
- Test: `test/suites/hooks.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `AREAS` (array of the eight strings) and `splitAreaPrefix(line) -> { area, text }`, both exported from `lib/hooks.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/suites/hooks.test.js`, following that file's existing `check(...)` style:

```js
// --- area prefixes on distilled points ---
// The session page groups these points under area headings. The prefix rides
// the existing decisions/gotchas TEXT columns, so this is the only place the
// vocabulary is enforced.
{
  const { splitAreaPrefix, AREAS, POINT_MAX } = require('../../lib/hooks.js');

  check('splitAreaPrefix reads a known area off the front',
    () => splitAreaPrefix('[UI/UX] Removed the menu item').area === 'UI/UX');
  check('splitAreaPrefix returns the text without the prefix',
    () => splitAreaPrefix('[UI/UX] Removed the menu item').text === 'Removed the menu item');
  check('splitAreaPrefix reports no area for an unprefixed line',
    () => splitAreaPrefix('Removed the menu item').area === null);
  check('splitAreaPrefix leaves an unprefixed line whole',
    () => splitAreaPrefix('Removed the menu item').text === 'Removed the menu item');
  // A bracket that is not a prefix must not be eaten -- points legitimately
  // contain brackets mid-sentence.
  check('splitAreaPrefix ignores a bracket that is not leading',
    () => splitAreaPrefix('Fixed the [object Object] label').area === null);
  check('AREAS holds exactly eight areas', () => AREAS.length === 8);

  // POINT_MAX applies to the POINT, not to the prefix. A 120-char point with a
  // 15-char prefix is still a legal 120-char point.
  const longPoint = 'x'.repeat(POINT_MAX);
  const okLine = JSON.stringify({
    session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
    decisions: `[Integrations] ${longPoint}`,
  });
  check('a full-length point is not rejected for carrying a prefix',
    () => !/invalid line/.test(String(runAppendResult(okLine))));

  const badArea = JSON.stringify({
    session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
    decisions: '[Frontend] Renamed the thing',
  });
  check('an unknown area label is rejected loudly',
    () => /not one of the areas/.test(String(runAppendResult(badArea))));

  const noPrefix = JSON.stringify({
    session: 's1', ts: new Date().toISOString(), headline: 'h', did: 'd',
    decisions: 'Renamed the thing',
  });
  check('an unprefixed point is still accepted',
    () => !/invalid line/.test(String(runAppendResult(noPrefix))));
}
```

`runAppendResult(line)` is a helper you must write at the top of that block, matching however the surrounding tests already invoke `runAppend` in this file — **read the existing `runAppend` assertions in `test/suites/hooks.test.js` first and reuse their exact calling convention** (they already construct a summaries path and capture the failure string). Do not invent a new harness.

- [ ] **Step 2: Run it and confirm it fails**

```bash
node test/run.js hooks
```

Expected: FAIL — `splitAreaPrefix is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/hooks.js`, immediately after the `POINT_MAX`/`POINTS_MAX` declarations, add:

```js
// The eight areas a distilled point may be tagged with. CANONICAL HERE: the
// session page groups by whatever label it finds and keeps no list of its own,
// so this is the only place the vocabulary is enforced. It is pinned to the
// day-card tag vocabulary (ui/src/features/feed/areaTags.ts) by a test in
// test/suites/hooks.test.js -- a header and a tag reading differently for the
// same work is exactly the kind of quiet inconsistency this product exists to
// prevent.
const AREAS = ['Data/Schema', 'Build/CI', 'Tests', 'Docs', 'UI/UX', 'Integrations', 'Config', 'Backend'];

// Read a leading "[Area] " off a point. Returns the area (null when absent)
// and the point without it.
//
// ANCHORED AT THE START and bounded in length on purpose: a point may
// legitimately contain brackets mid-sentence ("Fixed the [object Object]
// label"), and eating those would silently truncate a teammate's note.
function splitAreaPrefix(line) {
  const raw = String(line == null ? '' : line).trim();
  const m = /^\[([^\][\n]{1,20})\]\s*(.*)$/.exec(raw);
  if (!m) return { area: null, text: raw };
  return { area: m[1].trim(), text: m[2].trim() };
}
```

In `blockReason`, extend the `decisions` ask. Append this sentence to the end of the existing `decisions:` string, immediately before the closing `or ""; `:

```js
`Start each line with the part of the codebase it belongs to, in square brackets — one of: ${AREAS.join(', ')} — like "[UI/UX] Removed the transfer-ownership menu item, no RPC can perform it". The bracket does not count against the character budget. Omit it only if no area fits, `
```

Append the same sentence to the `gotchas:` string in the same position.

In `runAppend`'s per-field loop, replace the `const over = points.find(...)` block with a loop that strips the prefix first:

```js
    for (const point of points) {
      const { area, text } = splitAreaPrefix(point);
      if (area !== null && !AREAS.includes(area)) {
        return fail(`invalid line: a "${field}" point is tagged [${area}], which is not one of the areas: ${AREAS.join(', ')}. Use one of those, or write the point with no bracket at all.`);
      }
      // The budget is on the POINT. Measured against the raw line, a 15-char
      // prefix would silently shrink every point by 15 characters.
      if (text.length > POINT_MAX) {
        return fail(`invalid line: a "${field}" point is ${text.length} characters, max ${POINT_MAX} — write it as a short bullet a teammate can skim, one completed piece of work or one choice per line, never a paragraph.`);
      }
    }
```

Add `AREAS` and `splitAreaPrefix` to the `module.exports` object near the end of the file, alongside the existing `POINT_MAX, POINTS_MAX`.

- [ ] **Step 4: Run the tests**

```bash
node test/run.js hooks
```

Expected: PASS, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add lib/hooks.js test/suites/hooks.test.js
git commit -m "feat(hooks): distilled points carry the area they belong to"
```

---

### Task 2: Parse and group in the UI

**Files:**
- Modify: `ui/src/features/session/distill.ts` (`whatBullets`, near line 113)
- Test: `ui/src/features/session/distill.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — the UI deliberately holds no vocabulary.
- Produces: `interface WhatGroup { area: string | null; points: string[] }`, `whatGroups(session: Session): WhatGroup[]`, and the exported constants `GROUP_MIN_POINTS = 4`, `GROUP_MIN_AREAS = 2`. `whatBullets` is REPLACED — remove it and update its only caller in Task 3.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/session/distill.test.ts`. That file already defines a full `session(overrides)` fixture helper at the top — use it rather than casting a partial object, and change the file's import line from `whatBullets` to `whatGroups`:

```ts
describe('whatGroups', () => {
  const s = (decisions: string | null, gotchas: string | null = null) =>
    session({ decisions, gotchas })

  it('groups by area once there are enough points across enough areas', () => {
    const groups = whatGroups(s(
      '[UI/UX] Removed the menu item\n[UI/UX] Renamed the tab\n[Backend] Raised the rate limit\n[Backend] Cached the lookup',
    ))
    expect(groups.map(g => g.area)).toEqual(['UI/UX', 'Backend'])
    expect(groups[0].points).toEqual(['Removed the menu item', 'Renamed the tab'])
  })

  it('renders flat below the point threshold, stripping prefixes anyway', () => {
    // 3 points is under GROUP_MIN_POINTS -- three headings over one line each
    // reads worse than the flat list this replaces.
    const groups = whatGroups(s('[UI/UX] One\n[Backend] Two\n[Tests] Three'))
    expect(groups).toHaveLength(1)
    expect(groups[0].area).toBe(null)
    expect(groups[0].points).toEqual(['One', 'Two', 'Three'])
  })

  it('renders flat when every point shares one area', () => {
    const groups = whatGroups(s('[UI/UX] One\n[UI/UX] Two\n[UI/UX] Three\n[UI/UX] Four'))
    expect(groups).toHaveLength(1)
    expect(groups[0].area).toBe(null)
  })

  it('keeps first-seen area order, not alphabetical', () => {
    const groups = whatGroups(s(
      '[Tests] One\n[Tests] Two\n[Backend] Three\n[Backend] Four',
    ))
    expect(groups.map(g => g.area)).toEqual(['Tests', 'Backend'])
  })

  it('puts unprefixed points in a trailing unlabelled group', () => {
    const groups = whatGroups(s(
      '[UI/UX] One\n[UI/UX] Two\n[Backend] Three\nFour with no area',
    ))
    expect(groups[groups.length - 1].area).toBe(null)
    expect(groups[groups.length - 1].points).toEqual(['Four with no area'])
  })

  it('reads legacy prose with no prefixes as one flat group', () => {
    const groups = whatGroups(s('We did a thing. Then another thing.'))
    expect(groups).toHaveLength(1)
    expect(groups[0].area).toBe(null)
  })

  it('merges decisions and gotchas into the same areas', () => {
    const groups = whatGroups(
      s('[UI/UX] One\n[UI/UX] Two', '[UI/UX] Three\n[Backend] Four'),
    )
    expect(groups.find(g => g.area === 'UI/UX')?.points).toEqual(['One', 'Two', 'Three'])
  })

  it('drops a gotcha that merely restates a decision', () => {
    const groups = whatGroups(s('[UI/UX] Same line', '[UI/UX] Same line.'))
    expect(groups[0].points).toEqual(['Same line'])
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ui && npx vitest run src/features/session/distill.test.ts
```

Expected: FAIL — `whatGroups is not a function`.

- [ ] **Step 3: Write the implementation**

In `ui/src/features/session/distill.ts`, replace `whatBullets` with:

```ts
/** Fewest points worth splitting under headings. Below this, headings cost
 *  more than they buy: with a hard ceiling of 4 points per field, three
 *  headings over one line each is a common shape, not a hypothetical one. */
export const GROUP_MIN_POINTS = 4

/** Fewest distinct areas worth splitting. One heading over the whole list says
 *  nothing the list did not already say. */
export const GROUP_MIN_AREAS = 2

export interface WhatGroup {
  /** The area these points share, or null for the unlabelled group -- either
   *  the whole list when it is not worth grouping, or the trailing points that
   *  carried no area of their own. */
  area: string | null
  points: string[]
}

/** Read a leading "[Area] " off a point. Mirrors lib/hooks.js splitAreaPrefix,
 *  deliberately WITHOUT a copy of the vocabulary: the hook is the only place
 *  the valid set is enforced, so this renders whatever label was written and a
 *  future ninth area needs no change here.
 *
 *  Anchored and length-bounded, so a bracket mid-sentence ("Fixed the [object
 *  Object] label") is not mistaken for a prefix and silently eaten. */
function parseAreaPoint(text: string): { area: string | null; point: string } {
  const flat = oneLine(text)
  const m = /^\[([^\][]{1,20})\]\s*(.*)$/.exec(flat)
  if (!m) return { area: null, point: flat }
  return { area: m[1].trim(), point: m[2].trim() }
}

/** The merged "What" widget: the session's decisions followed by its gotchas,
 *  grouped under the area each point named.
 *
 *  Grouping engages only at GROUP_MIN_POINTS across GROUP_MIN_AREAS; otherwise
 *  the whole list comes back as one unlabelled group and renders exactly as it
 *  did before areas existed. Every session captured before this shipped has no
 *  prefixes at all and lands in that case by construction, which is the
 *  intended degradation, not a gap.
 *
 *  Areas keep FIRST-SEEN order rather than being sorted: decisions come before
 *  gotchas and the hook asks for the most important first, so first-seen is
 *  the writer's own ordering. Sorting would overwrite it with the alphabet.
 *
 *  A gotcha that merely restates a decision is dropped, as before: the two
 *  fields are one list here, and the same sentence twice reads as a bug. */
export function whatGroups(session: Session): WhatGroup[] {
  const seen = new Set<string>()
  const order: string[] = []
  const byArea = new Map<string, string[]>()
  const loose: string[] = []

  for (const field of [session.decisions, session.gotchas]) {
    for (const piece of splitPoints(field)) {
      const { area, point } = parseAreaPoint(piece)
      const key = sameLineKey(point)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (area === null) { loose.push(point); continue }
      if (!byArea.has(area)) { byArea.set(area, []); order.push(area) }
      byArea.get(area)!.push(point)
    }
  }

  const total = loose.length + [...byArea.values()].reduce((n, ps) => n + ps.length, 0)
  if (total === 0) return []

  // Not worth grouping: hand back one flat list, in the order the points were
  // written, with prefixes stripped -- a reader should never see the raw
  // "[UI/UX] " markup whichever branch runs.
  if (total < GROUP_MIN_POINTS || order.length < GROUP_MIN_AREAS) {
    const flat: string[] = []
    for (const area of order) flat.push(...byArea.get(area)!)
    flat.push(...loose)
    return [{ area: null, points: flat }]
  }

  const groups: WhatGroup[] = order.map(area => ({ area, points: byArea.get(area)! }))
  if (loose.length > 0) groups.push({ area: null, points: loose })
  return groups
}
```

Leave `splitPoints`, `oneLine`, `sameLineKey`, `shortIntent` and `distilledBullets` exactly as they are.

**Note on the flat branch's ordering:** it emits grouped points before loose ones, so a list mixing prefixed and unprefixed points is not returned in strict write order. That is deliberate and is what the test above pins; strict interleaving would need a third structure for no reader benefit.

- [ ] **Step 4: Run the tests and the type check**

```bash
cd ui && npx vitest run src/features/session/distill.test.ts
```

Expected: PASS. Existing `whatBullets` tests in this file will fail to compile — delete them; they are replaced by the block above.

```bash
cd ui && npx tsc --noEmit
```

Expected: one error in `BriefWidgets.tsx` (it still imports `whatBullets`). That is Task 3's job — do not fix it here beyond confirming it is the only one.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/session/distill.ts ui/src/features/session/distill.test.ts
git commit -m "feat(session): parse the area off a point and group by it"
```

---

### Task 3: Render the headers

**Files:**
- Modify: `ui/src/features/session/BriefWidgets.tsx` (the `What` widget, near line 92)
- Modify: `ui/src/features/session/session.css`
- Test: `ui/src/features/session/BriefWidgets.test.tsx`

**Interfaces:**
- Consumes: `whatGroups`, `WhatGroup` from Task 2.
- Produces: markup with `data-testid="what-area"` on each heading.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/session/BriefWidgets.test.tsx`, matching the render helper that file already uses:

```tsx
  it('heads each area group, and heads nothing when the list is flat', async () => {
    const grouped = renderBrief({
      decisions: '[UI/UX] Removed the menu item\n[UI/UX] Renamed the tab',
      gotchas: '[Backend] Raised the rate limit\n[Backend] Cached the lookup',
    })
    expect(grouped.getAllByTestId('what-area').map(n => n.textContent)).toEqual(['UI/UX', 'Backend'])
    // The raw prefix must never reach the reader.
    expect(grouped.queryByText(/\[UI\/UX\]/)).toBeNull()
    grouped.unmount()

    const flat = renderBrief({ decisions: '[UI/UX] One\n[Backend] Two', gotchas: null })
    expect(flat.queryAllByTestId('what-area')).toHaveLength(0)
    expect(flat.getByText('One')).toBeTruthy()
  })
```

Read the existing tests in this file first and use their exact render helper and session fixture; `renderBrief` above is a stand-in name for whatever they call. If the file has no such helper, build the session object the same way its existing tests do.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ui && npx vitest run src/features/session/BriefWidgets.test.tsx
```

Expected: FAIL — no `what-area` testid.

**If it fails with a timeout or a missing unrelated element, STOP** — that is this repo's documented phantom-failure signature. Run the gate before believing it:

```bash
node scripts/verify-finding.js --ui src/features/session/BriefWidgets.test.tsx --runs 3
```

Exit 0 = real. Exit 3 = phantom, the code is fine. Exit 4 = flaky, stop and report.

- [ ] **Step 3: Write the implementation**

In `BriefWidgets.tsx`, change the import from `whatBullets` to `whatGroups`, change `const what = whatBullets(session)` to `const what = whatGroups(session)`, and replace the `What` widget's body:

```tsx
      {what.length > 0 && (
        <Widget title="What" open>
          {what.map(group => (
            <div key={group.area ?? '_unlabelled'} className="session-what-group">
              {/* No heading for the unlabelled group: it is either the whole
                  list (not worth grouping) or the leftovers, and "Other" would
                  be inventing a category the writer did not choose. */}
              {group.area && (
                <h4 className="session-what-area" data-testid="what-area">{group.area}</h4>
              )}
              <ul className="session-list">
                {group.points.map(text => <li key={text} className="session-what">{text}</li>)}
              </ul>
            </div>
          ))}
        </Widget>
      )}
```

In `session.css`, add after the `.session-bullet::before` block:

```css
/* Area headings inside the What widget. Small, quiet and uppercase: these are
 * signposts through a list, not headings competing with the widget's own
 * title. A group with no area renders no heading at all. */
.session-what-group + .session-what-group {
  margin-top: var(--sp-3);
}
.session-what-area {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-xs);
  font-weight: var(--fw-medium);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text3);
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
cd ui && npx vitest run src/features/session/BriefWidgets.test.tsx
```

Expected: PASS.

```bash
cd ui && npx tsc --noEmit
```

Expected: no output — the `whatBullets` error from Task 2 is now resolved.

- [ ] **Step 5: Commit**

```bash
git add ui/src/features/session/BriefWidgets.tsx ui/src/features/session/session.css ui/src/features/session/BriefWidgets.test.tsx
git commit -m "feat(session): head each area group in the What widget"
```

---

### Task 4: Pin the two vocabularies together

**Files:**
- Modify: `test/suites/hooks.test.js`

**Interfaces:**
- Consumes: `AREAS` from Task 1, and the `Area` union type in `ui/src/features/feed/areaTags.ts` (already on this branch, from the day-card tags work).
- Produces: nothing.

The spec promises that a header on a session page and a tag on a day card mean the same thing. Nothing enforces that today: the hook's list and the tags' union type are separate literals in different languages. Renaming `UI/UX` to `Frontend` in one would leave the other silently disagreeing.

- [ ] **Step 1: Write the failing test**

Append to `test/suites/hooks.test.js`:

```js
// --- the two vocabularies are one vocabulary ---
// The hook writes "[UI/UX] ..." onto a point; the day card derives "UI/UX"
// from file paths. They are separate literals in two languages, so nothing but
// this test stops them drifting into a header and a tag that name the same
// work differently.
{
  const { AREAS } = require('../../lib/hooks.js');
  // hooks.test.js already has ROOT (from the harness) and `path` at the top,
  // and `h` is in scope, so this needs no new destructuring.
  const src = h.readSource(path.join(ROOT, 'ui/src/features/feed/areaTags.ts'));
  // The union type is the tags' declaration of the vocabulary.
  const union = /export type Area =([\s\S]*?)\n\n/.exec(src);
  check('areaTags.ts still declares an Area union', () => !!union);
  const declared = union ? (union[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)) : [];
  check('every hook area exists in the tag vocabulary',
    () => AREAS.every(a => declared.includes(a)));
  check('every tag area exists in the hook vocabulary',
    () => declared.every(a => AREAS.includes(a)));
}
```

Note `h.readSource` rather than a destructured `readSource`: the top of `hooks.test.js` destructures only `{ check, ROOT }` from the harness, and `h` is already in scope, so nothing new needs importing. The union in `areaTags.ts` is currently written across two lines and terminated by a blank line:

```ts
export type Area =
  | 'Data/Schema' | 'Build/CI' | 'Tests' | 'Docs'
  | 'UI/UX' | 'Integrations' | 'Config' | 'Backend'
```

so `/export type Area =([\s\S]*?)\n\s*\n/` matches it. Confirm the regex actually matches before relying on it; if the file has been reformatted, adapt the regex, never the source.

- [ ] **Step 2: Run it**

```bash
node test/run.js hooks
```

Expected: PASS immediately — both lists already hold the same eight names. This test is a guard against future drift, so it going green on the first run is correct, not a sign it is testing nothing. Prove it has teeth: temporarily change one entry in `lib/hooks.js`'s `AREAS` to `'Frontend'`, re-run, confirm the suite FAILS, then revert. **Report that you did this and what the failure said.**

- [ ] **Step 3: Commit**

```bash
git add test/suites/hooks.test.js
git commit -m "test(hooks): a header and a tag must name the same work the same way"
```

---

## Out of scope

- Backfilling areas onto history. Impossible — the daemon has no model, and BYOK was cut.
- Any change under `ui/src/features/feed/`. The tags shipped on the branch beneath this one.
- Changing `POINT_MAX`, `POINTS_MAX`, `HEADLINE_MAX` or `GOAL_MAX`.
- A ninth area, or per-repo vocabulary overrides.
- The CLAUDE.md injected block, which flattens bullets to one line per field on purpose and is unaffected.

## Self-Review

**Spec coverage.** Prefix format and the ask → Task 1. Unknown-label rejection → Task 1. `POINT_MAX` measured post-prefix → Task 1. `whatBullets` returns groups, ≥4 points across ≥2 areas → Task 2. Unprefixed degradation → Task 2 (legacy-prose and flat-branch tests). Rendering → Task 3. The spec's "one vocabulary, both surfaces" promise → Task 4, which the spec asserts but nothing previously enforced.

**Deliberate departure from the spec's wording:** the spec's Validation paragraph could be read as requiring the prefix. This plan makes it optional, because `runAppend` is shared by the Codex adapter and by older installs, and rejecting unprefixed points would break every one of those writers. Only an unrecognised label is rejected. This is recorded here rather than silently taken.

**Type consistency.** `WhatGroup`, `whatGroups`, `GROUP_MIN_POINTS`, `GROUP_MIN_AREAS`, `AREAS`, `splitAreaPrefix` are used with the same names and shapes in every task that references them. `whatBullets` is removed in Task 2 and its only caller updated in Task 3; no task references it afterwards.
