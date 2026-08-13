import { describe, it, expect } from 'vitest'
import { areaOf, isProjectFile, repoRelative, areaTagsFor } from './areaTags'

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
    // Three punctual areas plus an ambient one clearing 25% share: four areas
    // qualify, so the cap -- not the bar -- is what has to cut this down.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'ui/b.tsx', 'lib/mcp.js',
      '.github/workflows/ci.yml', 'supabase/migrations/1.sql',
    ))
    expect(tags).toHaveLength(3)
  })

  it('falls back to the heaviest area when nothing clears the bar', () => {
    // Five ambient areas (no punctual ones) at one file each of five total =
    // 20% share apiece, all below the 25% bar, so none qualifies outright.
    const tags = areaTagsFor(f(
      'ui/a.tsx', 'lib/a.js', 'docs/a.md', 'test/a.test.js', 'config.json',
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
// Days are sized 8-20 recognised files, not 3-4: a day that small makes any
// single file 25%+ of the total, so the 25% ambient bar can never exclude
// anything and every area effectively tags on presence. A corpus like that
// cannot tell the shipped rule apart from a naive "tag everything touched"
// rule -- see the canary test below, which proves this corpus can.
describe('distribution invariant', () => {
  const many = (n: number, path: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => path(i))

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

  // Teeth: prove this corpus can actually detect the degradation it exists to
  // guard against. A "tag everything touched" selector -- no ambient
  // threshold, no cap -- run over this SAME corpus must violate the invariant
  // above. If it doesn't, the corpus is too weak to distinguish the shipped
  // rule from the naive one, and the two tests above would be passing for the
  // wrong reason.
  it('the corpus can actually detect the degradation it guards against', () => {
    const naiveAreaTagsFor = (files: Array<{ file: string }>): string[] => {
      const areas = new Set<string>()
      for (const { file } of files) {
        const area = areaOf(file)
        if (area) areas.add(area)
      }
      return [...areas]
    }
    const fired = new Map<string, number>()
    for (const day of DAYS) {
      for (const area of naiveAreaTagsFor(day.map(file => ({ file })))) {
        fired.set(area, (fired.get(area) ?? 0) + 1)
      }
    }
    const over = [...fired.entries()].filter(([, n]) => n / DAYS.length > 0.5)
    expect(over.length).toBeGreaterThan(0)
  })
})
