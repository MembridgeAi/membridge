import { useCallback, useEffect, useState } from 'react'
import { applyTheme, readStoredMode, storeMode, type ThemeMode } from './theme'

/**
 * Owns the Appearance control's selected mode: reads the persisted value
 * once, then keeps <html data-theme> and localStorage in sync with every
 * change. Live "System follows the OS" reaction is NOT this hook's job --
 * that is a single, app-lifetime listener registered once in main.tsx
 * (theme.ts's watchSystemTheme), so it keeps working no matter which route
 * is mounted, not only while this control happens to be on screen.
 */
export function useThemeMode(): [ThemeMode, (next: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => readStoredMode())

  useEffect(() => {
    applyTheme(mode)
    storeMode(mode)
  }, [mode])

  const change = useCallback((next: ThemeMode) => setMode(next), [])
  return [mode, change]
}
