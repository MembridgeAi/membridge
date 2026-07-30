import { describe, expect, it } from 'vitest'
import { linesToList, listToLines, mergeLines } from './textList'

describe('textList', () => {
  describe('linesToList / listToLines', () => {
    it('trims and drops blank lines', () => {
      expect(linesToList(' a \n\nb\n ')).toEqual(['a', 'b'])
    })

    it('round-trips a list through lines', () => {
      expect(listToLines(['a', 'b'])).toBe('a\nb')
    })
  })

  describe('mergeLines', () => {
    it('appends new paths onto the existing text', () => {
      expect(mergeLines('a\nb', ['c'])).toBe('a\nb\nc')
    })

    it('skips a path already present as a line', () => {
      expect(mergeLines('a\nb', ['b', 'c'])).toBe('a\nb\nc')
    })

    it('returns the existing text unchanged when given no additions (the cancelled-picker case)', () => {
      expect(mergeLines('a\nb', [])).toBe('a\nb')
    })

    it('starts from an empty list', () => {
      expect(mergeLines('', ['a', 'a', 'b'])).toBe('a\nb')
    })
  })
})
