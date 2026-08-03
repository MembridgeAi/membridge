import { describe, it, expect } from 'vitest'
import { INTENT_MAX, distilledBullets, shortIntent } from './distill'
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
