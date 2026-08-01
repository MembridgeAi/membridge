// Appearance (light/dark/system). Persisted to localStorage, deliberately
// NOT through DataClient.setSetting/config.json: this is a per-machine
// DISPLAY preference -- which physical screen renders which palette -- not
// team- or project-scoped state. config.json is read by the daemon, a
// headless Node process with no rendering concerns of its own, and every
// other value that lives there is either synced or shared infrastructure
// config; "how do MY eyes want this screen" has no business riding along.
// localStorage keeps the choice local to the browser profile/Electron
// window actually doing the rendering, applies with zero request round
// trip, and matches how virtually every desktop/web app scopes a theme
// toggle.
export type ThemeMode = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

// Kept in lockstep, BY HAND, with the inline no-flash script in index.html.
// That script cannot import this module (it must run synchronously before
// any JS bundle loads, or the point of preventing a flash is lost) -- if
// this key or the mode values below ever change, index.html's copy has to
// change with it.
export const THEME_STORAGE_KEY = 'membridge:theme'

const VALID_MODES: readonly ThemeMode[] = ['system', 'light', 'dark']

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && (VALID_MODES as readonly string[]).includes(value)
}

export function readStoredMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeMode(raw) ? raw : 'system'
  } catch {
    // Storage denied (private browsing, locked-down WebView) -- fall back
    // to system rather than throwing and blanking the settings screen over
    // a theme preference.
    return 'system'
  }
}

export function storeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    // Same reasoning as readStoredMode -- a theme pref that fails to
    // persist must not surface as a page error.
  }
}

export function systemPrefersLight(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

export function effectiveTheme(mode: ThemeMode): EffectiveTheme {
  return mode === 'system' ? (systemPrefersLight() ? 'light' : 'dark') : mode
}

// Sets the attribute tokens.css keys its palette off (:root[data-theme]).
// Always writes an explicit value -- 'dark' included, even though dark has
// no override rule today (it's the bare :root default) -- so the DOM state
// is never ambiguous between "explicitly dark" and "the attribute was never
// set at all".
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', effectiveTheme(mode))
}

// Registered ONCE at app startup (main.tsx) -- not tied to whichever screen
// happens to have the Appearance control mounted, so System mode keeps
// following the OS live no matter which route the user is looking at right
// now. Re-reads the stored mode on every OS change rather than closing over
// a stale value, so it stays correct even if the mode was switched away
// from 'system' after this listener was registered. Returns an unsubscribe
// function -- unused by main.tsx today (the listener lives for the whole
// session), but tests (and any future hot-reload path) can call it to avoid
// leaking a listener per mount.
export function watchSystemTheme(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mql = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = () => {
    if (readStoredMode() === 'system') applyTheme('system')
  }
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}
