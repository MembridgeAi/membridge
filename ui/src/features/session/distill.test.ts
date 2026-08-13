import { describe, it, expect } from 'vitest'
import { INTENT_MAX, distilledBullets, shortIntent, whatGroups } from './distill'
import type { Session } from '../../data/types'

const session = (overrides: Partial<Session> = {}): Session => ({
  session: 's1', project: 'membridge', projectPath: '/x/membridge',
  author: 'Andrew', authorId: 'andrew', source: 'Claude Code',
  startedAt: '2026-07-29T19:00:00Z', endedAt: '2026-07-29T20:30:00Z', live: false,
  summary: 'Hook ownership now decided by durability.',
  summaryFull: 'Hook ownership now decided by durability.',
  goal: null, headline: 'Hook ownership now decided by durability.',
  decisions: null, gotchas: null,
  files: [], changes: [], checkpoints: [], prompts: [],
  ...overrides,
})

describe('distilledBullets', () => {
  it('comes from the checkpoint trail, oldest-first', () => {
    const bullets = distilledBullets(session({
      checkpoints: [
        { ts: '2026-07-29T19:40:00Z', text: 'Fixed the date in the UI.' },
        { ts: '2026-07-29T20:10:00Z', text: 'Raised the rate limit from 3 to 10 seconds.' },
      ],
    }))
    expect(bullets).toEqual(['Fixed the date in the UI.', 'Raised the rate limit from 3 to 10 seconds.'])
  })

  it('drops the checkpoint that merely repeats the page header', () => {
    const bullets = distilledBullets(session({
      checkpoints: [
        { ts: '2026-07-29T19:40:00Z', text: 'Gate extracted; stop path green.' },
        { ts: '2026-07-29T20:30:00Z', text: 'Hook ownership now decided by durability.' },
      ],
    }))
    expect(bullets).toEqual(['Gate extracted; stop path green.'])
  })

  it('dedupes repeated checkpoint text and ignores blank entries', () => {
    const bullets = distilledBullets(session({
      checkpoints: [
        { ts: '1', text: 'Same line.' },
        { ts: '2', text: '  Same line.  ' },
        { ts: '3', text: '   ' },
      ],
    }))
    expect(bullets).toEqual(['Same line.'])
  })

  it('clips a paragraph-length checkpoint to one line rather than dumping it', () => {
    const long = `${'word '.repeat(80)}end.`
    const [bullet] = distilledBullets(session({ checkpoints: [{ ts: '1', text: long }] }))
    expect(bullet.length).toBeLessThanOrEqual(INTENT_MAX + 1)
    expect(bullet.endsWith('…')).toBe(true)
  })

  it('falls back to the key-file notes when the session has no checkpoints', () => {
    const bullets = distilledBullets(session({
      changes: [
        { file: 'lib/hooks.js', status: 'edited', add: 1, del: 1, note: 'ownership gate', dep: false },
        { file: 'test/run-tests.js', status: 'edited', add: 1, del: 1, note: null, dep: false },
      ],
    }))
    expect(bullets).toEqual(['lib/hooks.js: ownership gate'])
  })

  it('is an empty list, never a placeholder, when nothing was distilled', () => {
    expect(distilledBullets(session())).toEqual([])
  })
})

describe('shortIntent', () => {
  it('passes a short intent through whole and reports nothing was cut', () => {
    expect(shortIntent('fix the port collision')).toEqual({ text: 'fix the port collision', clipped: false })
  })

  it('clips a whole-prompt intent on a word boundary and says so', () => {
    const prompt = `${'please do the thing '.repeat(40)}now`
    const out = shortIntent(prompt)
    expect(out.clipped).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(INTENT_MAX + 1)
    expect(out.text.endsWith('…')).toBe(true)
    // Never mid-word: what survives is a whole-word prefix of the original.
    const kept = out.text.slice(0, -1)
    expect(prompt.startsWith(kept)).toBe(true)
    expect(prompt.charAt(kept.length)).toBe(' ')
  })

  it('collapses the newlines of a multi-line prompt so the line cannot grow vertically', () => {
    expect(shortIntent('first line\n\nsecond line').text).toBe('first line second line')
  })
})

// whatGroups: the merged "What" widget's content, grouped by the area each
// point named. Two shapes reach it, and both have to read as a scannable
// list. New sessions arrive already bulleted and area-prefixed (lib/hooks.js
// asks for one short "[Area] " line per bullet); every session distilled
// before that change arrives as one prose paragraph with no prefixes, and
// there are hundreds of those already synced, so prose is split on sentence
// boundaries and lands in a single unlabelled group, rendering exactly as it
// did before areas existed.
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
