import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { SearchPage } from './SearchPage'

// Every result assertion waits out the input debounce (SEARCH_DEBOUNCE_MS)
// plus a query round trip -- close enough to the default findBy budget to
// fail under load, which is a flaky test, not a real signal, so the waits
// here are given explicit room.
//
// Must stay ABOVE the suite-wide asyncUtilTimeout (vitest.setup.ts, 5s), not
// the 1s Testing Library default it was originally written against: an
// explicit timeout BELOW the global one silently makes these waits shorter
// than every other wait in the suite, which is the opposite of the intent.
const SETTLED = { timeout: 8000 }

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

// The query and filters live in the URL now, so a test that leaves one behind
// SEEDS the next one: the box would open pre-filled with the previous test's
// query and paste() would append to it, producing a search neither test asked
// for. jsdom's location is shared for the whole file.
afterEach(() => {
  window.history.pushState({}, '', '/')
})

describe('SearchPage', () => {
  it('says what it searches before anything is typed -- never "no results"', async () => {
    // Awaited: the resting line now varies with useSoloView, which reads
    // status + team-account. Sync getByText landed on the FIRST render, before
    // either resolved, so it matched whichever variant the loading defaults
    // produced rather than the one this fixture describes.
    renderApp({}, <SearchPage />)
    expect(await screen.findByText(/archive going back further than the feed/i)).toBeInTheDocument()
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

  // Was `findByText('No matches.')` -- a bare dim line above an empty pane,
  // which is what users reported as the screen "going black". The empty state
  // now has to name what was searched and say what to do next, so the
  // assertions moved onto those two facts.
  it('reports an empty result set honestly once a search HAS run', async () => {
    const user = userEvent.setup()
    renderApp({}, <SearchPage />)
    await search(user, 'zzzz-nothing-matches')
    expect(await screen.findByText(/No matches for "zzzz-nothing-matches"/, {}, SETTLED)).toBeInTheDocument()
    expect(screen.getByText(/Try fewer words/i)).toBeInTheDocument()
  })

  // The recoverable half of empty: a filter, not the query, is why nothing came
  // back -- so the state has to say so and offer the way out in place. Without
  // this the person filter (which returns nothing for every person on real
  // data) looks exactly like a corpus that holds nothing.
  it('blames the filters, and offers a way out, when a filtered search finds nothing', async () => {
    const user = userEvent.setup()
    renderApp({}, <SearchPage />)
    await search(user, 'zzzz-nothing-matches')
    await user.selectOptions(await screen.findByLabelText('Filter by project', {}, SETTLED), '/Users/x/membridge')

    expect(await screen.findByText(/Filters are narrowing this search/i, {}, SETTLED)).toBeInTheDocument()
    const clear = screen.getByRole('button', { name: 'Clear filters' })
    await user.click(clear)
    await waitFor(() => expect(screen.getByLabelText('Filter by project')).toHaveValue(''), SETTLED)
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

  it('offers Hide mine only where there are teammates to hide yours from', () => {
    renderApp({ solo: true }, <SearchPage />)
    expect(screen.queryByRole('button', { name: 'Hide mine' })).toBeNull()
  })

  // T-78 item 5: the resting line promised "your teammates', and the archive
  // going back further than the feed does" on every install -- but a solo
  // user has neither teammates nor a team archive, and reading that line as
  // a promise about what search sees would send them looking for rows that
  // structurally cannot exist.
  it('describes the solo scope honestly on a solo, signed-out install', async () => {
    renderApp({ solo: true, authenticated: false }, <SearchPage />)
    expect(await screen.findByText(/your own sessions/i)).toBeInTheDocument()
    expect(screen.queryByText(/teammates/i)).toBeNull()
    expect(screen.queryByText(/team archive/i)).toBeNull()
    expect(screen.queryByText(/archive going back further/i)).toBeNull()
  })

  // The negation is the point of the assertion, not an implementation detail:
  // it is what makes the daemon drop self rows BEFORE ranking and before the
  // page limit. Filtering the returned page in the browser instead would leave
  // the reported match count describing rows the reader cannot see.
  //
  // KNOWN COVERAGE GAP -- read this before trusting this test.
  // It asserts ONLY that `author: '!<viewerId>'` was handed to the client. It
  // does NOT assert that a single row was hidden, and it cannot: measured
  // against a live daemon, `authorId` is null on every row it serves, so
  // '!<viewerId>' matches nothing, the negation keeps everything, and "Hide
  // mine" hides nothing at all. This test passes over that. An
  // outcome-asserting version (rows actually absent) is red until the daemon
  // exposes a usable person identity -- that is the daemon ticket, and these
  // assertions stay exactly as they are until it lands. Do not read green here
  // as "Hide mine works".
  it('hides your own rows by negating the person filter, not by trimming the page', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient({ viewerId: 'usr_9f2a' })
    const spy = vi.spyOn(client, 'search')
    renderWith(client, <SearchPage />)
    await search(user, 'ports')
    await waitFor(() => expect(spy).toHaveBeenCalled(), SETTLED)
    await user.click(screen.getByRole('button', { name: 'Hide mine' }))
    await waitFor(
      () => expect(spy).toHaveBeenCalledWith('ports', expect.objectContaining({ author: '!usr_9f2a' }), expect.any(Number)),
      SETTLED,
    )
  })

  // KNOWN COVERAGE GAP, same shape as the test above: this asserts the
  // outgoing filter is the chosen person's id and that Hide mine goes disabled.
  // It does NOT assert that the results are that person's work -- on real data
  // an id filter returns ZERO rows for every person, because no row carries an
  // author id. The fixtures do carry ids, which is the only reason this is
  // green. Blocked on the same daemon ticket.
  it('lets a chosen person supersede Hide mine instead of combining the two', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient({ viewerId: 'usr_9f2a' })
    const spy = vi.spyOn(client, 'search')
    renderWith(client, <SearchPage />)
    await search(user, 'ports')
    await user.click(await screen.findByRole('button', { name: 'Hide mine' }, SETTLED))
    await user.selectOptions(screen.getByLabelText('Filter by person'), 'andrew')
    await waitFor(
      () => expect(spy).toHaveBeenLastCalledWith('ports', expect.objectContaining({ author: 'andrew' }), expect.any(Number)),
      SETTLED,
    )
    expect(screen.getByRole('button', { name: 'Hide mine' })).toBeDisabled()
  })

  it('clears every filter at once, including the one that is a button', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'search')
    renderWith(client, <SearchPage />)
    await search(user, 'ports')
    await user.selectOptions(await screen.findByLabelText('Filter by project', {}, SETTLED), '/Users/x/membridge')
    await user.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(
      () => expect(spy).toHaveBeenLastCalledWith('ports', { author: null, project: null, source: null }, expect.any(Number)),
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

// #59. Filtering by a person returns zero for TWO different reasons, and until
// the daemon started reporting `preFixLocal` they were byte-identical:
//
//   1. that person genuinely has no matching history, and
//   2. their rows exist on this machine but carry no author_id, so a uuid
//      person filter cannot reach them. (Live, not theoretical: 100 of the 200
//      team rows on the author's own machine have authorId === null.)
//
// Case 2 shown as case 1 is a confident zero over history that exists. The
// daemon now says which one it is; these tests pin that the page says so too
// -- and, just as importantly, that it does NOT say so in case 1, where a
// repull hint would be a false alarm trading a silent zero for a noisy one.
describe('SearchPage when a person filter returns nothing', () => {
  // Zero results for whoever is picked, so the only variable across these
  // tests is which member was chosen -- i.e. their preFixLocal.
  const noMatches = () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'search').mockResolvedValue({ query: 'ports', total: 0, results: [] })
    return client
  }

  // Andrew is the fixture's member WITH unattributable local history.
  it('says the zero may be unattributed history, and names the repull command', async () => {
    const user = userEvent.setup()
    renderWith(noMatches(), <SearchPage />)
    await search(user, 'ports')
    await user.selectOptions(await screen.findByLabelText('Filter by person', {}, SETTLED), 'andrew')

    const gap = await screen.findByTestId('search-prefix-gap', {}, SETTLED)
    // The command is the whole point: a notice that says "some history is
    // unreachable" without saying how to fix it leaves the reader worse off
    // than the silent zero did.
    expect(gap).toHaveTextContent('membridge team repull')
    // The scale, so the reader can judge whether it is worth doing. Both
    // numbers come off the wire; neither is inferred here.
    expect(gap).toHaveTextContent(/7 .*(entries|rows)/)
    expect(gap).toHaveTextContent(/2 projects/)
    // Must not be phrased as a fact about Andrew.
    expect(gap.textContent).not.toMatch(/has (done )?nothing/i)
  })

  // THE COUNTER-CHECK. Sarah has preFixLocal.entries === 0, so her zero is a
  // real zero and must read as one. This is the assertion that stops the fix
  // from trading a silent wrong answer for a loud one on every empty search.
  it('leaves a genuine zero reading as a plain "nothing found"', async () => {
    const user = userEvent.setup()
    renderWith(noMatches(), <SearchPage />)
    await search(user, 'ports')
    await user.selectOptions(await screen.findByLabelText('Filter by person', {}, SETTLED), 'sarah')

    expect(await screen.findByText(/No matches for "ports"/, {}, SETTLED)).toBeInTheDocument()
    expect(screen.queryByTestId('search-prefix-gap')).toBeNull()
    expect(screen.queryByText(/repull/i)).toBeNull()
    // The ordinary filter advice is what a real zero gets, and it survives.
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument()
  })

  // No person picked at all: `preFixLocal` describes ONE member, so there is
  // nobody for it to be about. An "Everyone" search that happens to return
  // zero must not inherit Andrew's gap.
  it('says nothing about repull when no person is picked', async () => {
    const user = userEvent.setup()
    renderWith(noMatches(), <SearchPage />)
    await search(user, 'ports')
    expect(await screen.findByText(/No matches for "ports"/, {}, SETTLED)).toBeInTheDocument()
    expect(screen.queryByTestId('search-prefix-gap')).toBeNull()
  })

  // The notice belongs to the ZERO state only. Results on screen mean the
  // filter reached rows, and a gap warning above them would undercut an
  // answer the page did in fact produce.
  it('stays silent when the same person filter does return results', async () => {
    const user = userEvent.setup()
    renderWith(new FakeDataClient(), <SearchPage />)
    await search(user, 'ports')
    await user.selectOptions(await screen.findByLabelText('Filter by person', {}, SETTLED), 'andrew')
    await screen.findByText(/Ports fixed and pushed/, {}, SETTLED)
    expect(screen.queryByTestId('search-prefix-gap')).toBeNull()
  })
})
