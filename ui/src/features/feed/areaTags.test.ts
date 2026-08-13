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
