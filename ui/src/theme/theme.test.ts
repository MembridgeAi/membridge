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

// ---------------------------------------------------------------------------
// The text ramp is a CONTRAST CONTRACT (T-49/T-69/T-75), and this is what
// enforces it. Ratios are computed from styles/tokens.css itself rather than
// from values duplicated here -- a test that restated the hexes would pass
// forever while the real file drifted, which is the failure mode this whole
// area already had once.
//
// Why a test and not a comment: the shipped values failed WCAG for months
// behind a well-commented token file. A rule someone has to remember is not a
// rule. Same instinct as making SidePanels' `streamPending` a required prop.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKENS = readFileSync(join(__dirname, '..', 'styles', 'tokens.css'), 'utf8')

/** Reads one custom property out of a `:root...{ }` block in tokens.css. */
function token(block: 'dark' | 'light', name: string): string {
  // The bare `:root {` block is dark; light lives under [data-theme="light"].
  const re = block === 'dark'
    ? /:root\s*\{([\s\S]*?)\}/
    : /:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/
  const body = TOKENS.match(re)?.[1]
  if (!body) throw new Error(`tokens.css: no ${block} :root block found`)
  const value = body.match(new RegExp(`--${name}\\s*:\\s*(#[0-9A-Fa-f]{6})`))?.[1]
  if (!value) throw new Error(`tokens.css: --${name} not found in the ${block} block`)
  return value
}

const channels = (hex: string): number[] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('text ramp contrast (WCAG 1.4.3)', () => {
  // 4.5:1, not 3:1, and deliberately applied to all three tiers: the
  // large-text exemption needs 18.66px bold / 24px regular, and every --text3
  // declaration in this app is 9-12px.
  const MIN = 4.5
  const SURFACES = ['bg', 'panel', 'panel2'] as const
  const TIERS = ['text', 'text2', 'text3'] as const

  for (const theme of ['dark', 'light'] as const) {
    for (const tier of TIERS) {
      for (const surface of SURFACES) {
        it(`${theme}: --${tier} on --${surface} clears ${MIN}:1`, () => {
          const fg = token(theme, tier)
          const bg = token(theme, surface)
          const ratio = contrastRatio(fg, bg)
          // The message carries the numbers, so a failure says what to change
          // rather than just that something is wrong.
          expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
        })
      }
    }
  }

  // --panel2 is the binding surface in both themes, and on tier 2 it is
  // reachable ONLY through base.css's global `button:hover { background:
  // var(--panel2) }`. That is how light --text2 shipped at 4.34:1 on twelve
  // 10.5px .settings-btn labels while passing on every resting surface, so the
  // hover path gets its own named assertion rather than being left implicit in
  // the loop above.
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: --text2 clears ${MIN}:1 on the button:hover surface`, () => {
      const ratio = contrastRatio(token(theme, 'text2'), token(theme, 'panel2'))
      expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    })
  }

  // The ramp must stay a ramp. Without this, the cheapest way to pass every
  // assertion above is to set all three tiers to the same near-black value,
  // which would silently delete the hierarchy the tiers exist to express.
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: the three tiers stay ordered and distinct`, () => {
      const [l1, l2, l3] = TIERS.map(t => luminance(token(theme, t)))
      if (theme === 'dark') {
        expect(l1).toBeGreaterThan(l2)
        expect(l2).toBeGreaterThan(l3)
      } else {
        expect(l1).toBeLessThan(l2)
        expect(l2).toBeLessThan(l3)
      }
      // Distinct enough to be seen as different tiers at all. 1.15x is a floor
      // against collapse, NOT the separation the design aims for -- see the
      // dL* note in tokens.css for what the real separation is and why it
      // narrowed.
      const step = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      expect(step(l1, l2)).toBeGreaterThan(1.15)
      expect(step(l2, l3)).toBeGreaterThan(1.15)
    })
  }
})
