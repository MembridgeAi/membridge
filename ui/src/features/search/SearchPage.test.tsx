import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { SearchPage } from './SearchPage'

// Every result assertion waits out the input debounce (SEARCH_DEBOUNCE_MS)
// plus a query round trip. The default 1s findBy budget is close enough to
// that sum to fail under load, which is a flaky test, not a real signal --
// so the waits here are given explicit room.
const SETTLED = { timeout: 4000 }

// Enter the query as ONE input event (paste), never keystroke by keystroke.
// Typing restarts the debounce per character, so under load the run becomes a
// race between how fast the characters land and how long the debounce is --
// which made this file fail roughly one run in three while testing exactly
// nothing about typing speed.
async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByLabelText('Search team memory')
  await user.click(box)
  await user.paste(text)
}

describe('SearchPage', () => {
  it('says what it searches before anything is typed -- never "no results"', () => {
    renderApp({}, <SearchPage />)
    expect(screen.getByText(/archive going back further than the feed/i)).toBeInTheDocument()
    expect(screen.queryByText(/No matches/i)).toBeNull()
  })

  it('does not ask the daemon until something is typed', () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'search')
    renderWith(client, <SearchPage />)
    expect(spy).not.toHaveBeenCalled()
  })

  it('runs the search and reports how many matched', async () => {
    const user = userEvent.setup()
    renderApp({}, <SearchPage />)
    await search(user, 'ports')
    expect(await screen.findByText(/Ports fixed and pushed/, {}, SETTLED)).toBeInTheDocument()
    expect(await screen.findByText(/1 match/, {}, SETTLED)).toBeInTheDocument()
  })

  it('says why a row is here, in words rather than field names', async () => {
    const user = userEvent.setup()
    renderApp({}, <SearchPage />)
    await search(user, 'run-tests')
    // The fixture row matches on its file list, not on its outcome text.
    expect(await screen.findByText('files', {}, SETTLED)).toBeInTheDocument()
  })

  it('reports an empty result set honestly once a search HAS run', async () => {
    const user = userEvent.setup()
    renderApp({}, <SearchPage />)
    await search(user, 'zzzz-nothing-matches')
    expect(await screen.findByText('No matches.', {}, SETTLED)).toBeInTheDocument()
  })

  it('surfaces a failure as a retryable error, not as an empty list', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    vi.spyOn(client, 'search').mockRejectedValue(new Error('daemon unreachable'))
    renderWith(client, <SearchPage />)
    await search(user, 'anything')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/daemon unreachable/), SETTLED)
  })

  it('passes the person/project/tool filters through to the query', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'search')
    renderWith(client, <SearchPage />)
    await search(user, 'ports')
    await waitFor(() => expect(spy).toHaveBeenCalled(), SETTLED)
    await user.selectOptions(screen.getByLabelText('Filter by project'), '/Users/x/membridge')
    await waitFor(
      () => expect(spy).toHaveBeenCalledWith('ports', expect.objectContaining({ project: '/Users/x/membridge' }), expect.any(Number)),
      SETTLED,
    )
  })

  it('does not repeat the outcome line as its own snippet', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    vi.spyOn(client, 'search').mockResolvedValue({
      query: 'ports', total: 1,
      results: [{
        id: 'r1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z',
        live: false, outcome: 'Ports fixed and pushed.', intent: null, files: [], session: null,
        project: 'membridge', projectPath: null, summaryFull: 'Ports fixed and pushed.',
        decisions: null, gotchas: null, changes: [], score: 4, matched: ['summary'],
      }],
    })
    renderWith(client, <SearchPage />)
    await search(user, 'ports')
    expect(await screen.findByText('Ports fixed and pushed.', {}, SETTLED)).toBeInTheDocument()
    // Present once (as the outcome), never twice.
    expect(screen.getAllByText('Ports fixed and pushed.')).toHaveLength(1)
  })
})
