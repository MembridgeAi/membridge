// Task 1: the search query and its filters live in the URL, not in component
// state. State-only, a search was unshareable, survived neither a reload nor
// the browser's Back button, and left the address bar describing a page that
// was no longer on screen.
import { describe, expect, it, afterEach } from 'vitest'
import { screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp } from '../../test/renderApp'
import { ROUTES, searchHref } from '../../app/routes'
import { SearchPage } from './SearchPage'

// Same reasoning as SearchPage.test.tsx's own SETTLED: every assertion here
// waits out the input debounce plus a query round trip, and must sit ABOVE
// the suite-wide asyncUtilTimeout rather than below it.
const SETTLED = { timeout: 8000 }

function visit(path: string) {
  window.history.pushState({}, '', path)
}

afterEach(() => {
  cleanup()
  window.history.pushState({}, '', '/')
})

describe('SearchPage reads its query from the URL', () => {
  it('runs the query in ?q= on first render, with nothing typed', async () => {
    visit(searchHref({ q: 'ports' }))
    renderApp({}, <SearchPage />)
    // The box is seeded from the URL, and the search has already run: this is
    // what makes a pasted search link reproduce the sender's screen.
    expect((await screen.findByLabelText('Search team memory') as HTMLInputElement).value).toBe('ports')
    expect(await screen.findByText(/Ports fixed and pushed/, {}, SETTLED)).toBeInTheDocument()
  })

  it('applies a filter carried in the URL', async () => {
    visit(searchHref({ q: 'ports', source: 'Codex' }))
    renderApp({}, <SearchPage />)
    // The tool list arrives with /api/status, so the option has to exist
    // before the select can report the URL's value as its own.
    await screen.findByRole('option', { name: 'Codex' }, SETTLED)
    expect((screen.getByLabelText('Filter by tool') as HTMLSelectElement).value).toBe('Codex')
  })

  it('degrades a malformed query string to no filters instead of throwing', async () => {
    // A hand-edited or truncated URL must still render a page. FeedPage's
    // ?session= read already has exactly this contract.
    visit(`${ROUTES.search}?%&q=%E0%A4%A&project=%zz`)
    renderApp({}, <SearchPage />)
    expect(await screen.findByRole('heading', { name: 'Search' })).toBeInTheDocument()
    const project = screen.getByLabelText('Filter by project') as HTMLSelectElement
    expect(project.value).toBe('')
  })
})

describe('SearchPage writes its query to the URL', () => {
  it('puts what was typed into ?q=, so the address bar is shareable', async () => {
    const user = userEvent.setup()
    visit(ROUTES.search)
    renderApp({}, <SearchPage />)
    const box = await screen.findByLabelText('Search team memory')
    await user.click(box)
    await user.paste('ports')
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('q')).toBe('ports')
    }, SETTLED)
  })

  it('puts a chosen filter into the URL', async () => {
    const user = userEvent.setup()
    visit(searchHref({ q: 'ports' }))
    renderApp({}, <SearchPage />)
    await screen.findByRole('option', { name: 'Codex' }, SETTLED)
    await user.selectOptions(screen.getByLabelText('Filter by tool'), 'Codex')
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search)
      expect(params.get('tool')).toBe('Codex')
      // The query survives a filter change: they are one URL, not two.
      expect(params.get('q')).toBe('ports')
    }, SETTLED)
  })

  it('Clear drops the filters from the URL and keeps the query', async () => {
    const user = userEvent.setup()
    visit(searchHref({ q: 'ports', source: 'Codex' }))
    renderApp({}, <SearchPage />)
    await user.click(await screen.findByRole('button', { name: 'Clear' }))
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search)
      expect(params.get('tool')).toBeNull()
      expect(params.get('q')).toBe('ports')
    }, SETTLED)
  })

  it('a filter change is a history entry, so Back undoes it', async () => {
    const user = userEvent.setup()
    visit(searchHref({ q: 'ports' }))
    renderApp({}, <SearchPage />)
    await screen.findByRole('option', { name: 'Codex' }, SETTLED)
    await user.selectOptions(screen.getByLabelText('Filter by tool'), 'Codex')
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('tool')).toBe('Codex')
    }, SETTLED)

    window.history.back()
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('tool')).toBeNull()
    }, SETTLED)
    // The control follows the URL back, rather than describing a filter the
    // page is no longer applying.
    await waitFor(() => {
      expect((screen.getByLabelText('Filter by tool') as HTMLSelectElement).value).toBe('')
    }, SETTLED)
  })
})
