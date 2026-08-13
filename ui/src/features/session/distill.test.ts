import { describe, it, expect } from 'vitest'
import { INTENT_MAX, distilledBullets, parseAreaPoint, shortIntent, whatGroups } from './distill'
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

  it('drops a gotcha that merely restates a decision in the same area', () => {
    const groups = whatGroups(s('[UI/UX] Same line', '[UI/UX] Same line.'))
    expect(groups[0].points).toEqual(['Same line'])
  })

  // The same sentence under two areas is two facts, not a duplicate. Keying
  // dedupe on the text alone kept the first and deleted the second area's copy,
  // which is a teammate's line disappearing with nothing to show it happened.
  it('keeps the same sentence under each area that recorded it', () => {
    const groups = whatGroups(s(
      '[UI/UX] Ports collide\n[UI/UX] One\n[Tests] Ports collide\n[Tests] Two',
    ))
    expect(groups.find(g => g.area === 'UI/UX')?.points).toEqual(['Ports collide', 'One'])
    expect(groups.find(g => g.area === 'Tests')?.points).toEqual(['Ports collide', 'Two'])
  })

  // A one-point field has no newline, so it is cut at sentence boundaries and
  // only the FIRST fragment can carry the prefix. Without inheritance the tail
  // clause fell into the trailing unlabelled group, putting every other area's
  // heading between a sentence and the clause that finishes it.
  it('keeps a sentence-split point under the area its first fragment named', () => {
    const groups = whatGroups(s(
      '[UI/UX] One\n[UI/UX] Two\n[UI/UX] Three',
      '[Tests] The harness reuses ports. Run the gate first.',
    ))
    expect(groups.map(g => g.area)).toEqual(['UI/UX', 'Tests'])
    expect(groups[1].points).toEqual(['The harness reuses ports.', 'Run the gate first.'])
  })

  // A row the hook never validated -- an older install, the Codex adapter,
  // anything synced before areas existed -- can open with a bracket that is not
  // a label at all. Eating it leaves the reader a line starting "(src/...)".
  it('renders a point that merely opens with a bracket whole', () => {
    const groups = whatGroups(s('[clipWords](src/mappers.ts) now trims'))
    expect(groups[0].points).toEqual(['[clipWords](src/mappers.ts) now trims'])
  })

  // An empty-string area renders no heading but still counts toward
  // GROUP_MIN_AREAS, so it could flip a list into grouped mode and then put an
  // invisible boundary in the middle of it.
  it('does not let a blank label make an invisible group', () => {
    const groups = whatGroups(s('[ ] x\n[UI/UX] One\n[Backend] Two\n[Backend] Three'))
    expect(groups.map(g => g.area)).toEqual(['UI/UX', 'Backend', null])
    expect(groups[2].points).toEqual(['[ ] x'])
  })

  // Inherited from the old whatBullets tests, which task 2 deleted: these three
  // guarantees survived the rewrite and are the ones a reader would notice
  // breaking.
  it('never truncates a long point, however long the writer made it', () => {
    const long = `${'word '.repeat(60)}end`
    const groups = whatGroups(s(long))
    expect(groups[0].points[0]).toBe(long.trim())
    expect(groups[0].points[0].length).toBeGreaterThan(INTENT_MAX)
  })

  it('strips leading bullet markers so the list renders as one shape', () => {
    const groups = whatGroups(s('- One\n* Two\n• Three'))
    expect(groups[0].points).toEqual(['One', 'Two', 'Three'])
  })

  it('is an empty list, never a placeholder, when both fields are empty', () => {
    expect(whatGroups(session())).toEqual([])
    expect(whatGroups(s('', '   '))).toEqual([])
  })
})

// The area parser exists twice on purpose: lib/hooks.js splitAreaPrefix
// validates what an agent writes, parseAreaPoint renders what any tool ever
// wrote, and no module can be shared across the CommonJS/TypeScript boundary
// between them. A rule that changes on one side only is a point accepted one
// way and displayed another, so this table is MIRRORED VERBATIM in
// test/suites/hooks.test.js -- change one, change both, or one side fails.
const PARSER_TABLE: Array<{ input: string; area: string | null; text: string }> = [
  { input: '[UI/UX] Removed the menu item', area: 'UI/UX', text: 'Removed the menu item' },
  { input: 'Removed the menu item', area: null, text: 'Removed the menu item' },
  { input: 'Fixed the [object Object] label', area: null, text: 'Fixed the [object Object] label' },
  // "]" not followed by whitespace: a sentence, not a label.
  { input: '[clipWords](src/mappers.ts) now trims', area: null, text: '[clipWords](src/mappers.ts) now trims' },
  { input: '[Tests]no space', area: null, text: '[Tests]no space' },
  // Blank and empty labels name no area, and keep their text whole.
  { input: '[ ] x', area: null, text: '[ ] x' },
  { input: '[] x', area: null, text: '[] x' },
  // The length bound is measured on the COLLAPSED label, which is the rule that
  // used to differ: the UI flattens first, the hook did not.
  { input: `[a${' '.repeat(30)}b] note`, area: 'a b', text: 'note' },
  { input: `[${'x'.repeat(20)}] note`, area: 'x'.repeat(20), text: 'note' },
  { input: `[${'x'.repeat(21)}] note`, area: null, text: `[${'x'.repeat(21)}] note` },
  // "]" at end of string is still a prefix.
  { input: '[Tests]', area: 'Tests', text: '' },
]

describe('parseAreaPoint agrees with lib/hooks.js splitAreaPrefix', () => {
  for (const row of PARSER_TABLE) {
    it(`classifies ${JSON.stringify(row.input)}`, () => {
      const out = parseAreaPoint(row.input)
      expect(out.area).toBe(row.area)
      expect(out.point).toBe(row.text)
    })
  }
})
