import '@testing-library/jest-dom/vitest'

// jsdom does not implement matchMedia. Polyfill a minimal, always-resolves
// stub so any code that reads prefers-color-scheme (ui/src/theme/theme.ts)
// doesn't throw in tests that never explicitly care about it. Tests that DO
// care (theme.test.ts, useThemeMode.test.ts) replace this per-test with
// vi.stubGlobal for real control over `matches`.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
}

// On this Node version, a native (empty, non-functional) `localStorage`
// global shadows jsdom's own Storage implementation on `window` -- every
// method (getItem/setItem/removeItem/clear) is `undefined` unless Node is
// started with --localstorage-file, which this project's test scripts don't
// set. Verified directly: `typeof window.localStorage.setItem` is
// 'undefined' before this file runs. Replace it with a small in-memory
// Storage-compatible polyfill so any code reading/writing localStorage
// (ui/src/theme/theme.ts) behaves like a real browser in tests instead of
// throwing on the first call.
if (typeof window !== 'undefined' && typeof window.localStorage?.setItem !== 'function') {
  const store = new Map<string, string>()
  const memoryStorage: Storage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  }
  Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true, writable: true })
}
