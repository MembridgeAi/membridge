import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen, cleanup, fireEvent } from '@testing-library/react'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { SessionPage } from './SessionPage'
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
    // Intent row, same labelled shape the feed rows use. Scoped to the row:
    // the same ask text legitimately appears again in the prompt chain.
    const intentRow = screen.getByText('Intent').closest('.session-intent')
    expect(intentRow).not.toBeNull()
    expect(intentRow!.textContent).toContain('make the summary hook fire on session boundaries')
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

  it('the NORMAL page has a back button, not only the not-found branch', async () => {
    visit('/sessions/s-f2')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const back = screen.getByRole('link', { name: 'Back to the Feed' })
    expect(back.getAttribute('href')).toBe(ROUTES.feed)
    expect(back.classList.contains('session-back')).toBe(true)
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

describe('session page redesign: order, analytics, bullets, intent', () => {
  it('reads back button, analytics, summary, bullets, prompts -- top to bottom', async () => {
    visit('/sessions/s-f2')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const page = document.querySelector('.session-page')!
    const order = ['.session-back', '.session-analytics', '.session-header', '.session-bullets', '.session-chain']
    const positions = order.map(sel => {
      const el = page.querySelector(sel)
      expect(el, `${sel} is missing from the page`).not.toBeNull()
      return [...page.querySelectorAll('*')].indexOf(el as Element)
    })
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('the distilled bullets render as a list of one-liners above the raw prompts', async () => {
    visit('/sessions/s-f2')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const bullets = [...document.querySelectorAll('.session-bullet')].map(el => el.textContent)
    // s-f2's second checkpoint repeats the header, so only the first survives.
    expect(bullets).toEqual(['Gate extracted; stop path green.'])
  })

  it('a session with nothing distilled renders no bullet list at all', async () => {
    visit('/sessions/s-f3')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    expect(document.querySelector('.session-bullets')).toBeNull()
  })

  it('the analytics header sits on the page with its four tiles', async () => {
    visit('/sessions/s-f2')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const labels = [...document.querySelectorAll('.session-tile-label')].map(el => el.textContent)
    expect(labels).toEqual(['Files touched', 'Lines', 'Commits', 'Duration'])
  })

  it('a long intent is clipped with a disclosure that reveals the whole prompt', async () => {
    visit('/sessions/s-f5')
    renderApp()
    const row = (await screen.findByText('Intent')).closest('.session-intent')!
    const long = 'please do the thing '.repeat(40)
    expect(row.textContent).not.toContain(long)
    expect(row.textContent).toContain('…')
    fireEvent.click(screen.getByRole('button', { name: 'Show full intent' }))
    const opened = screen.getByText('Intent').closest('.session-intent')!
    expect(opened.textContent).toContain(long.trim())
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('a short intent renders whole, with no disclosure control', async () => {
    visit('/sessions/s-f2')
    renderApp()
    const row = (await screen.findByText('Intent')).closest('.session-intent')!
    expect(row.textContent).toContain('make the summary hook fire on session boundaries')
    expect(row.querySelector('button')).toBeNull()
  })

  it('checkpoints are not duplicated as a widget now that they are the bullets', async () => {
    visit('/sessions/s-f2')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const titles = [...document.querySelectorAll('.session-widget-title')].map(el => el.textContent)
    expect(titles).not.toContain('Checkpoints')
  })
})

// Provenance, end to end: a wire payload through mapSession and onto the page.
// The unit tests in provenance.test.tsx own the copy and the branching; these
// own the WIRING -- that the fields survive the mapper, and that each note
// lands where the reader would otherwise draw the wrong conclusion.
describe('session page provenance (s-f6: a teammate session out of the archive)', () => {
  it('says the copy came from the team, and that the history may be partial', async () => {
    visit('/sessions/s-f6')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByTestId('session-origin')).toHaveTextContent(
      'Shared with you by your team — this is the copy that reached your machine.',
    )
    expect(screen.getByTestId('session-earlier-activity')).toHaveTextContent(
      /may not have reached your machine yet/,
    )
    // Never our storage words, and never an alarm.
    expect(document.querySelector('.session-provenance')!.textContent).not.toMatch(/archive|cache/i)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The whole point: this session's trail is empty because it never crossed to
  // this machine, and an empty trail is exactly what a session that recorded
  // nothing looks like.
  it('states the missing checkpoints in the bullets slot, above the folded prompt chain', async () => {
    visit('/sessions/s-f6')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const note = screen.getByTestId('session-missing-checkpoints')
    expect(note).toHaveTextContent(/This copy has no checkpoints/)
    const page = document.querySelector('.session-page')!
    const nodes = [...page.querySelectorAll('*')]
    expect(nodes.indexOf(note)).toBeLessThan(nodes.indexOf(page.querySelector('.session-chain')!))
  })

  it('says the commit count is not in this copy rather than showing nothing found', async () => {
    visit('/sessions/s-f6')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    const commits = screen.getByText('Commits').closest('.session-tile')!
    expect(commits.textContent).toContain('not in this copy')
  })

  // The absent case, on the fixtures that carry neither field: an older daemon
  // (or a response cached before these fields existed) must render exactly as
  // it did before any of this existed.
  it('adds nothing at all to a payload that carried neither field', async () => {
    visit('/sessions/s-f2')
    renderApp()
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByTestId('session-origin')).toBeNull()
    expect(screen.queryByTestId('session-earlier-activity')).toBeNull()
    expect(screen.queryByTestId('session-missing-checkpoints')).toBeNull()
    expect(document.querySelector('.session-provenance')).toBeNull()
    // And the Commits tile keeps the words it has always had.
    expect(screen.getByText('Commits').closest('.session-tile')!.textContent).toContain('not captured')
  })
})

// T-72. Was `<div className="session-page" />` — the shortest blank in the app
// (49ms to 175ms measured; GET /api/session is a 67ms local read), fixed anyway
// because the back link is the one control a reader may want DURING the wait and
// it is known from the URL without waiting for anything.
describe('SessionPage while the session is still loading', () => {
  it('keeps the back link and shows placeholder rows instead of an empty page', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getSession').mockReturnValue(new Promise<never>(() => {}))
    renderWith(client, <SessionPage sessionId="s1" />)

    expect(await screen.findByTestId('session-loading')).toBeInTheDocument()
    expect(screen.getByRole('link')).toBeInTheDocument()
    // Must not have concluded the session is gone — that is a different state
    // with a different remedy.
    expect(screen.queryByText("This session isn't in memory anymore.")).toBeNull()
  })
})
