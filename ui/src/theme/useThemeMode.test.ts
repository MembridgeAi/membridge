import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { THEME_STORAGE_KEY } from './theme'
import { useThemeMode } from './useThemeMode'

describe('useThemeMode', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })
  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('defaults to system on first mount and applies it to the DOM', () => {
    const { result } = renderHook(() => useThemeMode())
    const [mode] = result.current
    expect(mode).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark') // stubbed matchMedia: matches:false
  })

  it('reads a previously persisted mode instead of defaulting', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const { result } = renderHook(() => useThemeMode())
    expect(result.current[0]).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('switching to light updates the DOM attribute and persists the choice', () => {
    const { result } = renderHook(() => useThemeMode())
    act(() => result.current[1]('light'))
    expect(result.current[0]).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('switching to dark updates the DOM attribute and persists the choice', () => {
    const { result } = renderHook(() => useThemeMode())
    act(() => result.current[1]('dark'))
    expect(result.current[0]).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('switching back to system re-resolves against the current OS preference', () => {
    const { result } = renderHook(() => useThemeMode())
    act(() => result.current[1]('light'))
    act(() => result.current[1]('system'))
    expect(result.current[0]).toBe('system')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })
})
