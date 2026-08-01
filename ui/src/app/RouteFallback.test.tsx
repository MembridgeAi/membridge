import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { RouteFallback } from './RouteFallback'

describe('RouteFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing before the flash guard elapses', () => {
    const { container } = render(<RouteFallback />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders a loading status once the flash guard elapses', () => {
    render(<RouteFallback />)
    act(() => {
      vi.advanceTimersByTime(151)
    })
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
  })
})
