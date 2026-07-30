import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTheme, effectiveTheme, readStoredMode, storeMode, systemPrefersLight, THEME_STORAGE_KEY, watchSystemTheme,
} from './theme'

// Swaps window.matchMedia for a controllable stub whose `matches` reflects
// `prefersLight`, and returns the registered 'change' handler(s) so a test
// can simulate the OS flipping mid-session without a real media query.
function stubMatchMedia(prefersLight: boolean): { listeners: (() => void)[] } {
  const state = { listeners: [] as (() => void)[] }
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersLight,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, cb: () => void) => { state.listeners.push(cb) },
    removeEventListener: (_type: string, cb: () => void) => {
      const i = state.listeners.indexOf(cb)
      if (i !== -1) state.listeners.splice(i, 1)
    },
    dispatchEvent: () => false,
  }))
  return state
}

describe('theme', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('readStoredMode', () => {
    it('defaults to system when nothing is stored', () => {
      expect(readStoredMode()).toBe('system')
    })
    it('returns a stored valid mode', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
      expect(readStoredMode()).toBe('light')
    })
    it('falls back to system for a garbage/legacy stored value', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'solarized')
      expect(readStoredMode()).toBe('system')
    })
    it('falls back to system when localStorage throws (private browsing)', () => {
      const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
      expect(readStoredMode()).toBe('system')
      spy.mockRestore()
    })
  })

  describe('storeMode', () => {
    it('persists the mode under the shared storage key', () => {
      storeMode('dark')
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    })
    it('never throws when localStorage write fails', () => {
      const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('denied') })
      expect(() => storeMode('dark')).not.toThrow()
      spy.mockRestore()
    })
  })

  describe('systemPrefersLight / effectiveTheme', () => {
    it('resolves system mode to light when the OS prefers light', () => {
      stubMatchMedia(true)
      expect(systemPrefersLight()).toBe(true)
      expect(effectiveTheme('system')).toBe('light')
    })
    it('resolves system mode to dark when the OS prefers dark', () => {
      stubMatchMedia(false)
      expect(systemPrefersLight()).toBe(false)
      expect(effectiveTheme('system')).toBe('dark')
    })
    it('an explicit mode always wins over the OS setting', () => {
      stubMatchMedia(true)
      expect(effectiveTheme('dark')).toBe('dark')
      stubMatchMedia(false)
      expect(effectiveTheme('light')).toBe('light')
    })
  })

  describe('applyTheme', () => {
    it('sets data-theme="light" for light mode', () => {
      applyTheme('light')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })
    it('sets an explicit data-theme="dark" for dark mode, not merely absent', () => {
      applyTheme('dark')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })
    it('resolves system mode against the current OS preference', () => {
      stubMatchMedia(true)
      applyTheme('system')
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })
  })

  describe('watchSystemTheme', () => {
    it('re-applies the theme live when the OS changes while mode is system', () => {
      // Captures the 'change' listener(s) registered against THIS matchMedia
      // instance -- watchSystemTheme queries window.matchMedia once, at
      // registration time, and attaches its handler there; a real browser
      // fires 'change' on that same query object when the OS setting flips.
      const { listeners } = stubMatchMedia(false) // OS starts dark
      storeMode('system')
      applyTheme('system')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

      watchSystemTheme()

      // Flip the (stubbed) OS preference for any FRESH matchMedia() call --
      // exactly what a real change means -- then fire the change event on
      // the original query object, precisely how the browser would.
      stubMatchMedia(true)
      for (const cb of listeners) cb()
      expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    })

    it('never fires the OS change into the DOM when the user has picked an explicit mode', () => {
      storeMode('dark')
      applyTheme('dark')
      const { listeners } = stubMatchMedia(false)
      watchSystemTheme()
      // Simulate the OS flipping to light while the user is pinned to dark.
      for (const cb of listeners) cb()
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })

    it('returns a no-op unsubscribe when matchMedia is unavailable', () => {
      vi.stubGlobal('matchMedia', undefined)
      expect(() => watchSystemTheme()()).not.toThrow()
    })
  })
})
