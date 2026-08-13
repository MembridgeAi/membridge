// The scorer is a table, so it is tested as one. Length is the dominant term
// on purpose: length is what actually resists offline guessing, and a scorer
// that rewards `P@ssw0rd` over `correct horse battery` teaches the wrong move.
import { describe, it, expect } from 'vitest'
import { MIN_PASSWORD_LENGTH, scorePassword, strengthWord } from './passwordStrength'

describe('scorePassword', () => {
  it('says nothing at all about an empty field', () => {
    // No score, no hint: a meter that scolds before a single keystroke is noise.
    expect(scorePassword('')).toEqual({ score: 0, hint: '' })
  })

  it.each([
    ['abc'],
    ['abcdefg'],
  ])('names the minimum for %s, which is too short to score', pw => {
    expect(scorePassword(pw)).toEqual({ score: 0, hint: 'Use at least 8 characters.' })
  })

  it.each([
    // password,             score, hint
    ['abcdefgh',                 0, 'Add another word — length matters most.'],
    ['Abcdef1!',                 1, 'Add another word — length matters most.'],
    ['abcdefghijkl',             1, 'Mix in a number or symbol.'],
    ['Abcdefghijk1',             2, 'Add another word — length matters most.'],
    ['abcdefghijklmnop',         2, 'Mix in a number or symbol.'],
    ['Abcdefghijklmno1',         3, ''],
  ])('scores %s as %i', (pw, score, hint) => {
    expect(scorePassword(pw as string)).toEqual({ score, hint })
  })

  it('never exceeds the top of the scale, however long the input', () => {
    expect(scorePassword(`Aa1!${'x'.repeat(500)}`).score).toBe(3)
  })

  it('exports the minimum as a number other modules can import', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8)
  })
})

describe('strengthWord', () => {
  it('maps every score to its word', () => {
    expect([0, 1, 2, 3].map(s => strengthWord(s as 0 | 1 | 2 | 3)))
      .toEqual(['Weak', 'Fair', 'Good', 'Strong'])
  })
})
