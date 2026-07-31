import { describe, it, expect, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { ROUTES } from '../../app/routes'

function visit(path: string) {
  window.history.pushState({}, '', path)
}

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('session route + page shell (Task 3)', () => {
  it('ROUTES.session is /sessions/:sessionId', () => {
    expect(ROUTES.session).toBe('/sessions/:sessionId')
  })

  it('renders the session page at the route: 2-sentence header, Intent, meta row', async () => {
    visit('/sessions/s-f2')
    renderApp()
    // Header is summaryFull clipped to 2 sentences -- never the headline,
    // never the third sentence.
    expect(await screen.findByRole('heading', {
      name: 'Hook ownership now decided by durability, not who ran last. The stop path and the recall path share one gate.',
    })).toBeInTheDocument()
    expect(screen.queryByText(/This third sentence must never render in the header/)).toBeNull()
    // Intent row, same labelled shape the feed rows use.
    expect(screen.getByText('Intent')).toBeInTheDocument()
    expect(screen.getByText('make the summary hook fire on session boundaries')).toBeInTheDocument()
    // Meta row: author, tool, project, prompt count.
    expect(screen.getByText('Andrew')).toBeInTheDocument()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('membridge')).toBeInTheDocument()
    expect(screen.getByText(/2 prompts/)).toBeInTheDocument()
  })

  it('a live session says so in the eyebrow instead of a finished time', async () => {
    visit('/sessions/s-f1')
    renderApp()
    expect(await screen.findByText(/Session · live/)).toBeInTheDocument()
  })

  it('a finished session eyebrow carries finished + duration', async () => {
    visit('/sessions/s-f2')
    renderApp()
    expect(await screen.findByText(/Session · finished .* · 1h 30m/)).toBeInTheDocument()
  })

  it('an unknown id renders the not-in-memory state with a Feed link, never a blank screen', async () => {
    visit('/sessions/no-such-session')
    renderApp()
    expect(await screen.findByText(/This session isn't in memory anymore/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Back to the Feed' })
    expect(link.getAttribute('href')).toBe(ROUTES.feed)
  })

  it('a fetch failure renders a role="alert" error, not a redirect', async () => {
    visit('/sessions/s-f2')
    renderApp({ failWith: 'daemon unreachable' })
    const alerts = await screen.findAllByRole('alert')
    expect(alerts.some(a => /Couldn't load this session/.test(a.textContent || ''))).toBe(true)
    // Still on the session route -- an error must never redirect.
    expect(window.location.pathname).toBe('/sessions/s-f2')
  })
})
