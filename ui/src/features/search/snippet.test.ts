import { describe, expect, it } from 'vitest'
import { matchLabels, queryTerms, snippetAround } from './snippet'

// A real teammate summary: the match sits 400+ characters in, exactly where a
// head-of-text preview would never reach it.
const LONG =
  'The gh CLI v2.97.0 is installed at ~/.local/bin/gh from the official release zip, with no Homebrew, ' +
  'no sudo and nothing written outside the home directory, but GitHub login is still not done: the device ' +
  'code expired before the browser flow was completed, so the failing CI job has not been read yet and no ' +
  'diagnosis exists. Earlier in the session two things shipped: the marketing site had its dead Windows ' +
  'download button removed, and the live indicator that never cleared was fixed and pushed to master.'

describe('snippetAround', () => {
  it('centres the window on the match, not the head of the text', () => {
    const text = snippetAround(LONG, 'live indicator').map(p => p.text).join('')
    expect(text).toContain('live indicator')
    expect(text.startsWith('…')).toBe(true)
  })

  it('marks the matched run so the eye lands on it', () => {
    const parts = snippetAround(LONG, 'Homebrew')
    expect(parts.some(p => p.hit && p.text.toLowerCase() === 'homebrew')).toBe(true)
  })

  it('preserves the original casing of the source', () => {
    const parts = snippetAround('Master repaired and GREEN again', 'green')
    expect(parts.find(p => p.hit)?.text).toBe('GREEN')
  })

  it('falls back to the head when the query is not in this field', () => {
    const parts = snippetAround('Something else entirely', 'vault')
    expect(parts.map(p => p.text).join('')).toContain('Something else entirely')
    expect(parts.some(p => p.hit)).toBe(false)
  })

  it('is empty for empty text, so the row renders nothing rather than a blank line', () => {
    expect(snippetAround(null, 'anything')).toEqual([])
    expect(snippetAround('   ', 'anything')).toEqual([])
  })

  it('collapses whitespace so a multi-line summary stays one snippet', () => {
    const parts = snippetAround('first line\n\n   second line', 'second')
    expect(parts.map(p => p.text).join('')).toBe('first line second line')
  })

  it('keeps identifiers and paths whole when tokenizing', () => {
    expect(queryTerms('who touched lib/feed.js')).toContain('feed.js')
  })
})

describe('matchLabels', () => {
  it('says the field names the way a person would', () => {
    expect(matchLabels(['decisions', 'files'])).toEqual(['decisions', 'files'])
    expect(matchLabels(['goal'])).toEqual(['intent'])
    expect(matchLabels(['ask'])).toEqual(['prompt'])
  })

  it('collapses headline and summary into one label', () => {
    expect(matchLabels(['headline', 'summary'])).toEqual(['summary'])
  })

  it('passes an unknown field through rather than dropping it', () => {
    expect(matchLabels(['somethingNew'])).toEqual(['somethingNew'])
  })
})
