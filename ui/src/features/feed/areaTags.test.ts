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
