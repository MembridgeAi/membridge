import { describe, it, expect } from 'vitest'
import { areaOf, isProjectFile, repoRelative, areaTagsFor } from './areaTags'

describe('repoRelative', () => {
  it('strips this repo\'s two worktree conventions', () => {
    expect(repoRelative('.claude/worktrees/agent-x/lib/scan.js')).toBe('lib/scan.js')
    expect(repoRelative('.worktrees/run-abc/ui/src/App.tsx')).toBe('ui/src/App.tsx')
  })

  // Idempotence, and it is not academic: areaTagsFor dedupes on repoRelative's
  // output and areaOf then applies it AGAIN. A prefix that only collapsed on
  // the second pass counted one file as two.
  it('strips a nested worktree prefix in one call', () => {
    expect(repoRelative('.claude/worktrees/a/.claude/worktrees/b/lib/x.js')).toBe('lib/x.js')
    expect(repoRelative(repoRelative('.claude/worktrees/a/lib/x.js'))).toBe('lib/x.js')
  })

  // No absolute-prefix rule, by decision: the daemon relativises on the way in
  // (lib/memorydb.js, lib/provenance.js), so an absolute path is not a shape
  // that reaches here -- and one that did is classified correctly by its own
  // segments, where the old strip turned this into `src/data/DataClient.ts`
  // and tagged a UI file `Backend`.
  it('classifies an absolute path by its segments rather than stripping a guessed root', () => {
    expect(areaOf('/Users/marco/membridge/ui/src/data/DataClient.ts')).toBe('UI/UX')
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
    expect(areaOf('.claude/settings.json')).toBe('Config')
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

const f = (...paths: string[]) => paths.map(file => ({ file }))

/** n distinct paths of one shape. Distinct because areaTagsFor counts DISTINCT
 *  files, so `many` repeating one name would silently size a fixture wrong. */
const many = (n: number, path: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => path(i))

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

  // The bar, pinned from BOTH sides. Every other assertion here is one-sided,
  // so without this pair AMBIENT_SHARE could be retuned from 0.25 to 0.40 with
  // the suite still green -- changing what every historical card says with
  // nothing going red. The arithmetic is exact and stated: 5 of 20 is 0.25,
  // 6 of 25 is 0.24, and both are exactly representable, so neither assertion
  // rests on floating-point luck.
  it('keeps an ambient area at exactly the 25% bar', () => {
    // 15 UI + 5 docs = 20 recognised files; 5/20 = 0.25, which the >= keeps.
    const tags = areaTagsFor(f(...many(15, i => `ui/Comp${i}.tsx`), ...many(5, i => `docs/note${i}.md`)))
    expect(tags.map(t => t.area)).toEqual(['UI/UX', 'Docs'])
  })

  it('drops an ambient area one file below the bar', () => {
    // 19 UI + 6 docs = 25 recognised files; 6/25 = 0.24, just under.
    const tags = areaTagsFor(f(...many(19, i => `ui/Comp${i}.tsx`), ...many(6, i => `docs/note${i}.md`)))
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
    // Three punctual areas plus an ambient one clearing 25% share: four areas
    // qualify, so the cap -- not the bar -- is what has to cut this down.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'ui/b.tsx', 'lib/mcp.js',
      '.github/workflows/ci.yml', 'supabase/migrations/1.sql',
    ))
    expect(tags).toHaveLength(3)
  })

  it('falls back to every tied leader when nothing clears the bar', () => {
    // Five ambient areas (no punctual ones) at one file each of five total =
    // 20% share apiece, all below the 25% bar, so none qualifies outright.
    //
    // ALL FIVE tie, so there is no heaviest area to name. Naming one anyway --
    // ranked[0], which is alphabetical among equals -- rendered exactly
    // `Backend` and read as a finding about the day. The exact set is asserted
    // rather than "one of these": the cap keeps three, and which three is the
    // alphabetical order the tie-break already promises, so pinning it is what
    // makes a future change to either rule visible.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'lib/a.js', 'docs/a.md', 'test/a.test.js', 'config.json',
    ))
    expect(tags.map(t => t.area)).toEqual(['Backend', 'Config', 'Docs'])
  })

  it('falls back to the leaders only, not to every area touched', () => {
    // 2 each of UI/UX, Backend, Docs and Tests plus 1 Config = 9 files, so the
    // best any area manages is 2/9 = 22.2% and nothing clears the bar. The
    // four at 2 files are the leaders; Config at 1 is not, and must not ride
    // along. Alphabetical among the four tied leaders, capped at three.
    const tags = areaTagsFor(f(
      ...many(2, i => `ui/Comp${i}.tsx`), ...many(2, i => `lib/mod${i}.js`),
      ...many(2, i => `docs/note${i}.md`), ...many(2, i => `test/case${i}.test.js`),
      '.claude/settings.json',
    ))
    expect(tags.map(t => t.area)).toEqual(['Backend', 'Docs', 'Tests'])
  })

  it('returns nothing when no file is recognised', () => {
    expect(areaTagsFor(f('scratchpad/a.png', 'runs/x/mission.json'))).toEqual([])
  })

  it('counts a file once however many times it appears', () => {
    const tags = areaTagsFor(f('lib/a.js', 'lib/a.js', 'lib/a.js', 'ui/a.tsx'))
    expect(tags.find(t => t.area === 'Backend')?.files).toBe(1)
  })

  it('counts a nested worktree path once, not twice', () => {
    // Same file, two spellings. The dedupe runs on repoRelative's output and
    // areaOf applies it again, so a prefix that needed two passes to collapse
    // used to make one file count as two -- inflating both the area and the
    // day's total, which is the denominator of every share above.
    const tags = areaTagsFor(f('.claude/worktrees/a/.claude/worktrees/b/lib/x.js', 'lib/x.js'))
    expect(tags).toEqual([{ area: 'Backend', files: 1 }])
  })

  it('is stable when two areas tie', () => {
    const once = areaTagsFor(f('ui/a.tsx', 'lib/a.js'))
    const twice = areaTagsFor(f('lib/a.js', 'ui/a.tsx'))
    expect(once.map(t => t.area)).toEqual(twice.map(t => t.area))
  })
})

// A tag that fires on most cards cannot answer "who worked on X". This is the
// property the feature exists for, so it is asserted directly rather than left
// to a reviewer to notice.
//
// The corpus below models the per-session area distribution measured by the
// backtest (docs/superpowers/specs/2026-08-12-session-headers-and-day-tags-backtest.js,
// salience mode, 27 sessions): UI/UX ~48%, Docs ~48%, Tests ~39%, Backend
// ~30%, Data/Schema ~26%, Build/CI ~9%, Integrations ~9%. Shipping the real
// corpus is not an option -- it is one person's private history -- so this
// re-derives days of that shape rather than the real files.
//
// What these 18 days actually produce under the shipped rule, measured rather
// than intended: UI/UX 44%, Docs 44%, Tests 39%, Backend 33%, Data/Schema 28%,
// Build/CI 11%, Integrations 11%, Config 0% -- every area within 4 points of
// the backtest, and Config deliberately touched on two days without ever
// clearing the bar, which is what it does in the real data.
//
// Days are sized 8-20 recognised files, not 3-4: a day that small makes any
// single file 25%+ of the total, so the 25% ambient bar can never exclude
// anything and every area effectively tags on presence. A corpus like that
// cannot tell the shipped rule apart from a naive "tag everything touched"
// rule -- see the canary tests below, which prove this corpus can.
//
// Both of the shipped rule's cuts have to BITE somewhere in here, or the
// corpus is not exercising the rule it pins. Three days present four
// qualifying areas so the 3-tag cap does the cutting, and seven days carry an
// ambient area the 25% bar excludes. An earlier version of this corpus had
// neither: the naive selector matched the shipped one on 10 of 11 days, the
// cap never bound at all, and the whole guard hung on one day's Docs tag.
describe('distribution invariant', () => {
  const DAYS: string[][] = [
    // Big UI day with a stray doc: 2 of 20 files (10%) is well under the 25%
    // ambient bar, so the doc should not earn a tag.
    [...many(18, i => `ui/Comp${i}.tsx`), ...many(2, i => `docs/note${i}.md`)],
    // UI day that also carries real doc work (6 of 16 = 37.5%, clears the bar).
    [...many(10, i => `ui/Comp${i}.tsx`), ...many(6, i => `docs/note${i}.md`)],
    // Backend day with a couple of tests (3 of 11 = 27.3%, just clears 25%).
    [...many(8, i => `lib/mod${i}.js`), ...many(3, i => `test/case${i}.test.js`)],
    // Migration day: Data/Schema is punctual (fires on presence) inside an
    // otherwise Backend-majority day.
    [...many(6, i => `lib/mod${i}.js`), ...many(2, i => `supabase/migrations/${i}.sql`)],
    // CI-touch day: Build/CI is punctual, one workflow file among Backend work.
    [...many(7, i => `lib/mod${i}.js`), '.github/workflows/ci.yml'],
    // Migration day landing inside UI-heavy work.
    [...many(10, i => `ui/Comp${i}.tsx`), ...many(2, i => `supabase/migrations/${i}.sql`)],
    // Migration day landing inside Tests-heavy work.
    [...many(8, i => `test/case${i}.test.js`), ...many(2, i => `supabase/migrations/${i}.sql`)],
    // Mixed day: UI/UX, Docs and Tests each land at an even third.
    [...many(4, i => `ui/Comp${i}.tsx`), ...many(4, i => `docs/note${i}.md`), ...many(4, i => `test/case${i}.test.js`)],
    // Integrations day: one adapter file (punctual) inside Docs-majority work.
    [...many(3, i => `ui/Comp${i}.tsx`), ...many(6, i => `docs/note${i}.md`), 'adapters/sync-adapter.js'],
    // Docs day with a few tests alongside.
    [...many(6, i => `docs/note${i}.md`), ...many(4, i => `test/case${i}.test.js`)],
    // Pure docs day: writing a spec, no code touched.
    many(5, i => `docs/note${i}.md`),
    // --- Days where the CAP is what cuts, not the bar -------------------
    // Four areas qualify (UI/UX 4/12, Backend 4/12, plus two punctual), and
    // the 2 docs at 16.7% do not. Shipped keeps 3 of the 5 areas touched.
    [
      ...many(4, i => `ui/Comp${i}.tsx`), ...many(4, i => `lib/mod${i}.js`),
      ...many(2, i => `docs/note${i}.md`),
      'supabase/migrations/12.sql', '.github/workflows/release.yml',
    ],
    // Same shape one area over: Tests 5/14 and Backend 5/14 qualify, two
    // punctual areas ride along, the 2 docs at 14.3% do not.
    [
      ...many(5, i => `test/case${i}.test.js`), ...many(5, i => `lib/mod${i}.js`),
      ...many(2, i => `docs/note${i}.md`),
      'adapters/team-sync.js', 'supabase/migrations/13.sql',
    ],
    // Three ambient areas at an even 5/16 = 31.25% each plus one migration:
    // four qualify, the cap keeps three.
    [
      ...many(5, i => `ui/Comp${i}.tsx`), ...many(5, i => `test/case${i}.test.js`),
      ...many(5, i => `docs/note${i}.md`), 'supabase/migrations/17.sql',
    ],
    // --- Days where the BAR is what cuts -------------------------------
    // UI day with real doc work at exactly the bar (3/12 = 25%, kept) over a
    // tail of tests and one backend file that are not (16.7% and 8.3%).
    [
      ...many(6, i => `ui/Comp${i}.tsx`), ...many(3, i => `docs/note${i}.md`),
      ...many(2, i => `test/case${i}.test.js`), 'lib/mod9.js',
    ],
    // Backend day with a wide, thin tail: UI 3/15, docs 2/15 and config 2/15
    // are all supporting churn, and the day was about lib/.
    [
      ...many(8, i => `lib/mod${i}.js`), ...many(3, i => `ui/Comp${i}.tsx`),
      ...many(2, i => `docs/note${i}.md`),
      '.claude/settings.json', '.claude/agents/ui-engineer.json',
    ],
    // Writing day: 9 of 16 docs, with UI and tests at 18.75% apiece and one
    // config file. One tag is the honest answer.
    [
      ...many(9, i => `docs/note${i}.md`), ...many(3, i => `ui/Comp${i}.tsx`),
      ...many(3, i => `test/case${i}.test.js`), '.claude/settings.json',
    ],
    // Test day carrying both punctual areas, with 2/10 backend below the bar.
    [
      ...many(6, i => `test/case${i}.test.js`), ...many(2, i => `lib/mod${i}.js`),
      'supabase/migrations/18.sql', 'adapters/notifier.js',
    ],
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

  // Bounded from BOTH sides. The ceiling is what the strip can carry; the
  // floor is the other way this feature dies -- a rule tightened until most
  // cards say nothing is as useless as one that tags everything, and an
  // upper bound alone would pass happily on a corpus of empty strips.
  it('keeps the strip short enough to scan, and long enough to say something', () => {
    const sizes = DAYS.map(d => areaTagsFor(d.map(file => ({ file }))).length)
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length
    expect(mean).toBeLessThanOrEqual(2.5)
    expect(mean).toBeGreaterThanOrEqual(1.8)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(3)
  })

  // Teeth: prove this corpus can actually detect the degradation it exists to
  // guard against. A "tag everything touched" selector -- no ambient
  // threshold, no cap -- run over this SAME corpus must violate the invariant
  // above. If it doesn't, the corpus is too weak to distinguish the shipped
  // rule from the naive one, and the two tests above would be passing for the
  // wrong reason.
  //
  // Measured on this corpus: the naive selector emits 53 tags to the shipped
  // rule's 38, and puts two areas over the half-the-days line (Docs 12/18 =
  // 67%, UI/UX 10/18 = 56%) where the shipped rule puts none. Both halves are
  // asserted, because "some area went over" alone survived on a corpus where
  // the two selectors agreed on 10 days of 11 and the whole guard rested on a
  // single day's Docs tag: delete that day and it silently stopped guarding.
  const naiveAreaTagsFor = (files: Array<{ file: string }>): string[] => {
    const areas = new Set<string>()
    for (const { file } of files) {
      const area = areaOf(file)
      if (area) areas.add(area)
    }
    return [...areas]
  }

  it('the corpus can actually detect the degradation it guards against', () => {
    const fired = new Map<string, number>()
    for (const day of DAYS) {
      for (const area of naiveAreaTagsFor(day.map(file => ({ file })))) {
        fired.set(area, (fired.get(area) ?? 0) + 1)
      }
    }
    const over = [...fired.entries()].filter(([, n]) => n / DAYS.length > 0.5)
    expect(over.length).toBeGreaterThanOrEqual(2)
  })

  it('separates the shipped rule from the naive one by a wide margin', () => {
    const total = (pick: (day: string[]) => unknown[]) =>
      DAYS.reduce((n, day) => n + pick(day).length, 0)
    const shipped = total(day => areaTagsFor(day.map(file => ({ file }))))
    const naive = total(day => naiveAreaTagsFor(day.map(file => ({ file }))))
    expect(naive - shipped).toBeGreaterThanOrEqual(10)
  })
})
