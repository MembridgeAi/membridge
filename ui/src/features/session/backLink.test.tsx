// Task 2: the session page's back link must be honest. It rendered "Back to
// the Feed" unconditionally, which is a lie the moment the reader arrived
// from Search or from a project page -- the link took them somewhere they had
// never been and told them they were going back.
import { describe, expect, it, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../../test/renderApp'
import { ROUTES, backLink, projectHref, searchHref, sessionHref } from '../../app/routes'

const SETTLED = { timeout: 8000 }

function visit(path: string) {
  window.history.pushState({}, '', path)
}

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('SessionPage back link follows ?from=', () => {
  it('with no origin still goes to the Feed', async () => {
    visit(sessionHref('s-f2'))
    renderApp()
    const link = await screen.findByRole('link', { name: /Back to/ }, SETTLED)
    expect(link).toHaveTextContent('Back to the Feed')
    expect(link.getAttribute('href')).toBe(ROUTES.feed)
  })

  it('from Search goes back to Search, with the query intact', async () => {
    const from = searchHref({ q: 'ports' })
    visit(sessionHref('s-f2', from))
    renderApp()
    const link = await screen.findByRole('link', { name: /Back to/ }, SETTLED)
    expect(link).toHaveTextContent('Back to Search')
    expect(link.getAttribute('href')).toBe(from)
  })

  it('from a project page goes back to that project', async () => {
    const from = projectHref('/Users/x/membridge')
    visit(sessionHref('s-f2', from))
    renderApp()
    const link = await screen.findByRole('link', { name: /Back to/ }, SETTLED)
    expect(link).toHaveTextContent('Back to the project')
    expect(link.getAttribute('href')).toBe(from)
  })

  it('an off-site ?from= is refused and falls back to the Feed', async () => {
    // The param arrives from the address bar, so it is attacker-controlled on
    // any pasted link. A back link that leaves the app while labelled "Back
    // to the Feed" is the failure this prevents.
    visit(`${sessionHref('s-f2')}?from=${encodeURIComponent('https://evil.example')}`)
    renderApp()
    const link = await screen.findByRole('link', { name: /Back to/ }, SETTLED)
    expect(link).toHaveTextContent('Back to the Feed')
    expect(link.getAttribute('href')).toBe(ROUTES.feed)
  })

  it('the not-in-memory state uses the same honest link', async () => {
    const from = searchHref({ q: 'ports' })
    visit(sessionHref('no-such-session', from))
    renderApp()
    expect(await screen.findByText(/This session isn't in memory anymore/, {}, SETTLED)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Back to/ })
    expect(link).toHaveTextContent('Back to Search')
    expect(link.getAttribute('href')).toBe(from)
  })
})

describe('call sites say where they are sending the reader from', () => {
  it('a search result links to the session carrying the search URL', async () => {
    visit(searchHref({ q: 'ports' }))
    renderApp()
    const row = await screen.findByText(/Ports fixed and pushed/, {}, SETTLED)
    const link = row.closest('a')
    expect(link).not.toBeNull()
    const href = link!.getAttribute('href')!
    expect(href.startsWith(ROUTES.session.replace(':sessionId', ''))).toBe(true)
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('from')).toBe(searchHref({ q: 'ports' }))
  })

  // The Feed is day cards now and expands nothing: a session is reached from
  // the DAY view a card opens, so that is the origin a session must carry.
  // Walked as a reader walks it, click by click, because the two halves of
  // this (the card's href and the day view's lookup of it) are exactly what a
  // hand-written URL in a test would stop checking.
  it('a day view links to the session carrying that day as its origin', async () => {
    const user = userEvent.setup()
    visit(ROUTES.feed)
    renderApp()
    const card = (await screen.findByText(/Hook ownership now decided by durability/, {}, SETTLED)).closest('a')
    expect(card!.getAttribute('href')!.startsWith(`${ROUTES.days}/`)).toBe(true)
    await user.click(card!)

    // Wait for the day view's own content, not for "any link": the shell's
    // nav links are in the document from the first paint, so a bare
    // findAllByRole resolves long before this lazy route has rendered. Same
    // trap, same fix, as the project-stream case below.
    await screen.findByText('Prompts', {}, SETTLED)
    const link = screen.getAllByRole('link').find(a =>
      (a.getAttribute('href') ?? '').startsWith('/sessions/'))
    expect(link).toBeDefined()
    const href = link!.getAttribute('href')!
    const from = new URLSearchParams(href.slice(href.indexOf('?'))).get('from')!
    expect(from.startsWith(`${ROUTES.days}/`)).toBe(true)
    expect(backLink(from).label).toBe('Back to the day')
  })

  it('a project stream row links to the session carrying that project as its origin', async () => {
    const from = projectHref('/Users/x/membridge')
    visit(from)
    renderApp()
    // Wait for a STREAM row, not for "any link": the shell's own nav links
    // are in the document from the first paint, so a bare findAllByRole
    // resolves long before the project's entries have arrived.
    const outcome = await screen.findByText(/Hook ownership now decided by durability/, {}, SETTLED)
    const href = outcome.closest('a')!.getAttribute('href')!
    expect(href.startsWith('/sessions/')).toBe(true)
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('from')).toBe(from)
  })
})
