import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { InsightsPage, buildCsv } from './InsightsPage'
import type { Insights } from '../../data/types'

// Fix 14b: a CSV cell starting with =, +, - or @ executes as a formula when
// the export is opened in Excel/Sheets -- and person names, project names
// and problem headlines are all attacker-influenceable text. Those cells get
// a leading apostrophe (the standard spreadsheet neutralizer); purely
// numeric cells stay untouched.
describe('buildCsv formula-injection escaping', () => {
  it('prefix-escapes text cells starting with =, +, - or @, leaving numbers alone', async () => {
    const base = await new FakeDataClient().getInsights(30)
    const csv = buildCsv({
      ...base,
      perPerson: [{ id: 'u1', name: '+Marco', sessions: 214, shared: 205 }],
      topProjects: [{ name: '-proj', sessions: 184, people: 3 }],
      problems: [{ id: 'p1', severity: 'broken', headline: '=HYPERLINK("http://evil")', scale: '@import', action: null }],
    })
    expect(csv).toContain(`'+Marco`)
    expect(csv).toContain(`'-proj`)
    expect(csv).toContain(`"'=HYPERLINK("`)
    expect(csv).toContain(`'@import`)
    // Numbers are not text and must not grow an apostrophe.
    expect(csv).toContain('window_days,30')
    expect(csv).toContain(`'+Marco,214,205`)
  })
})

// The fake has no truncation or exactness mode of its own -- these are
// backend states, not fixture variants -- so the payload is overridden on the
// client.
const clientServing = async (insights: Insights) => {
  const client = new FakeDataClient()
  vi.spyOn(client, 'getInsights').mockResolvedValue(insights)
  return client
}

// Counts are exact against a current backend (027_team_feed_counts.sql counts
// in the database), so a big number renders as the number. The old behaviour
// -- paging team_feed and publishing the 2000-row cap as if it were a total,
// with a "+2000" delta that was really the prior window running out of pages
// -- survives only as the pre-migration fallback below.
describe('InsightsPage with exact counts', () => {
  const exact = async () => ({
    ...(await new FakeDataClient().getInsights(30)),
    exact: true,
    truncated: false,
    sessions: { count: 4871, deltaPct: 12.5 },
    entriesShared: { count: 28143, delta: 3120 },
  })

  it('prints the real total, with no floor marker and a real trend', async () => {
    renderWith(await clientServing(await exact()), <InsightsPage />)
    expect(await screen.findByText('28,143')).toBeInTheDocument()
    expect(screen.getByText('4,871')).toBeInTheDocument()
    // The number is the number -- no "≥", no cap note, whatever its size.
    expect(screen.queryByText(/≥/)).toBeNull()
    expect(screen.queryByText(/approximate/)).toBeNull()
    expect(screen.getByText('+3120')).toBeInTheDocument()
    expect(screen.getByText(/\+12\.5% vs prev 30d/)).toBeInTheDocument()
  })

  it('exports the exact totals, unmarked, to CSV', async () => {
    const csv = buildCsv(await exact())
    expect(csv).toContain('entries_shared,28143')
    expect(csv).toContain('sessions,4871')
    expect(csv).toContain('feed_truncated,false')
  })
})

// Pre-migration fallback ONLY: a backend without team_feed_counts still pages
// team_feed, so it can still run out of pages. This is the one path where a
// count is a floor, and it names the missing migration rather than implying
// the team's numbers are inherently unknowable.
describe('InsightsPage against a backend predating migration 027', () => {
  const truncated = async () => ({
    ...(await new FakeDataClient().getInsights(30)),
    exact: false,
    truncated: true,
    // Same coveredDays shape backend #79 ships even on an ancient wire; the
    // TWO fields describe DIFFERENT facts (`exact` covers the headline counts,
    // `truncated` covers the paged breakdowns), so the counts-are-floors path
    // still needs the reached span to phrase the notice.
    lookbackDays: 12,
    coveredDays: 12,
    sessions: { count: 267, deltaPct: null },
    entriesShared: { count: 2000, delta: null },
  })

  it('renders counts as floors and replaces the trend with the cap note', async () => {
    renderWith(await clientServing(await truncated()), <InsightsPage />)
    // "≥" is the whole point: a bare 2,000 reads as a measurement.
    expect(await screen.findByText('≥2,000')).toBeInTheDocument()
    expect(screen.getByText('≥267')).toBeInTheDocument()
    expect(screen.getAllByText(/approximate/).length).toBeGreaterThan(0)
    // The fabricated delta must not come back in any form.
    expect(screen.queryByText('+2000')).toBeNull()
    expect(screen.queryByText(/vs prev 30d/)).toBeNull()
  })

  it('carries the caveat into the CSV without turning numeric cells into strings', async () => {
    const csv = buildCsv(await truncated())
    expect(csv).toContain('feed_truncated,true')
    // Counts stay numeric so a spreadsheet can still sum them.
    expect(csv).toContain('entries_shared,2000')
    expect(csv).not.toContain('≥')
  })

  it('says nothing about a cap when the fetch completed', async () => {
    const csv = buildCsv(await new FakeDataClient().getInsights(30))
    expect(csv).toContain('feed_truncated,false')
    renderApp({}, <InsightsPage />)
    expect(await screen.findByText('187')).toBeInTheDocument()
    expect(screen.queryByText(/approximate/)).toBeNull()
  })
})

// T-76 + T-71. A 30-day and a 90-day window are indistinguishable on a team
// with real history -- both saturate the same MAX_PAGES x TEAM_FEED_PAGE cap.
// Under T-76 (before backend #79) the truncation was invisible to the client
// because the wire masked it through `exact`; the fix landed as absence copy
// ("the reached depth is not reported") because that was the strongest
// sentence the payload permitted.
//
// With #79 the wire now carries `coveredDays` (== lookbackDays), the actual
// reach of the fetch, so the notice moves from "something was cut" to
// "Showing N of the 30 days you asked for." The two truncation shapes have to
// be told apart:
//   - `coveredDays < windowDays` -- the current window itself is short. The
//     ticket's headline case.
//   - `coveredDays >= windowDays` (but still truncated) -- the current window
//     is whole, the PRIOR one is short, the delta is what got capped.
describe('Insights when the current window itself was cut short', () => {
  const cut = async (over: Partial<Insights> = {}) => ({
    ...(await new FakeDataClient().getInsights(30)),
    // Post-#79: exact stays true on a current backend even when truncated,
    // because the two headline counts come from the database and only the
    // paged breakdowns are floors. The old masked flag would have hidden this
    // whole path -- see the type doc for `truncated`.
    exact: true,
    truncated: true,
    lookbackDays: 12,
    coveredDays: 12,
    sessions: { count: 267, deltaPct: null },
    entriesShared: { count: 2000, delta: null },
    ...over,
  })

  it('names both the requested and the covered range, in days', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)

    const notice = await screen.findByTestId('insights-truncated')
    // The actionable sentence: what you asked for, and what you got. Both
    // numbers, both units, no "some part of it was cut" hedge.
    expect(notice).toHaveTextContent(/Showing 12 of the 30 days you asked for/)
    // The absent span is stated as the arithmetic difference so a scanner
    // can see how big the gap is without doing the subtraction themselves.
    expect(notice).toHaveTextContent(/oldest 18 days are not included/)
    // The load-bearing half, and the reason this banner exists: the figures
    // are minimums, and a quiet-looking teammate may be an artefact of the
    // part that is absent rather than a person who has gone quiet.
    expect(notice).toHaveTextContent(/Every number below is a minimum/)
    expect(notice).toHaveTextContent(/a teammate can look quiet here/)
  })

  // The banner is the one surface on this page whose whole job is to be
  // trusted about precision, so it does not get to print "1 days". Both counts
  // it renders can be 1; this is the one the current-window branch can reach.
  it('renders a single absent day as "1 day"', async () => {
    renderWith(await clientServing(await cut({ lookbackDays: 29, coveredDays: 29 })), <InsightsPage />)

    const notice = await screen.findByTestId('insights-truncated')
    expect(notice).toHaveTextContent(/Showing 29 of the 30 days you asked for/)
    expect(notice).toHaveTextContent(/the oldest 1 day is not included/)
    expect(notice.textContent).not.toMatch(/1 days/)
  })

  // Every other ⚠ in this app marks something broken that wants the reader's
  // hands (hook not installed, last sync failed, keys stale). A window that
  // reports its own size is neither, and leading with the alarm glyph made the
  // first reading of this banner "Insights is broken".
  it('does not dress a reported limit as an alarm', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)

    const notice = await screen.findByTestId('insights-truncated')
    expect(notice.textContent).not.toMatch(/⚠/)
    // ...and it stays an advisory, not an alert, for a screen reader too.
    expect(notice).toHaveAttribute('role', 'status')
  })

  // THE SCREEN, not one element. Every one of these words got here the same
  // way: someone described the daemon to a reader who has no model of it. They
  // arrived in three different components (the truncation banner, a stat note,
  // a section hint), which is why this asserts over the whole rendered page
  // rather than the banner it started in -- the next one will land somewhere
  // none of us is looking.
  //
  // Bare "read" is deliberately NOT banned: "a file a past session already
  // read" is the user's own domain and the right word for it. What is banned
  // is our vocabulary for our own plumbing.
  const DAEMON_WORDS = /page limit|newest first|team feed|floor|unread|never read/i

  it('explains the reader\'s situation rather than the daemon\'s, everywhere on the page', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)
    await screen.findByTestId('insights-truncated')

    // Covers the banner, the members-syncing note ("a minimum — some days are
    // not included") and the Can't-tell hint in one pass.
    expect(document.body.textContent).not.toMatch(DAEMON_WORDS)
  })

  // The empty variant renders copy the assertion above never reaches, and it
  // is the sentence a reader sees when the page has nothing to accuse anyone
  // of -- the one place it would be easiest to overclaim.
  it('keeps the empty Can\'t-tell note honest and jargon-free', async () => {
    renderWith(await clientServing(await cut({ problems: [] })), <InsightsPage />)

    const unconfirmed = await screen.findByTestId('problems-unconfirmed')
    // Says what it can see, and does not promote that into "nothing is wrong".
    expect(unconfirmed).toHaveTextContent('Nobody looked quiet in the days this view includes.')
    expect(document.body.textContent).not.toMatch(DAEMON_WORDS)
    expect(document.body.textContent).not.toMatch(/Nothing is broken right now/i)
  })

  it('names the window the reader actually chose', async () => {
    renderWith(await clientServing(await cut({ window: 90, lookbackDays: 12, coveredDays: 12 })), <InsightsPage />)
    await screen.findByTestId('insights-truncated')
    await userEvent.click(screen.getByRole('button', { name: '90 days' }))
    expect(await screen.findByTestId('insights-truncated'))
      .toHaveTextContent(/Showing 12 of the 90 days you asked for/)
  })

  // The part that matters. "Nothing has arrived from Sarah" is drawn from the
  // truncated rows, so under a cut window it may be an artefact of the cap
  // rather than a fact about Sarah.
  it('never files a silent teammate under Broken when the data was cut', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)

    const unconfirmed = await screen.findByTestId('problems-unconfirmed')
    expect(within(unconfirmed).getByText(/Nothing has arrived from Sarah/)).toBeInTheDocument()
    expect(unconfirmed).toHaveTextContent(/Unconfirmed/)
    // The hint next to Sarah's name has to offer the innocent reading, in
    // words that survive being read by someone who has never met this app.
    // Naming only the doubt ("silence here may be unread data") left "Sarah
    // stopped working" as the only conclusion a reader could actually draw.
    expect(unconfirmed).toHaveTextContent('silence here may be days that are not included, not a teammate who has gone quiet')

    // The accusing frame is gone entirely -- both the "nothing is reaching the
    // team" heading and its inverse claim that nothing is wrong.
    expect(screen.queryByTestId('problems-broken')).toBeNull()
    expect(screen.queryByText(/nothing is reaching the team/i)).toBeNull()
    expect(screen.queryByText(/Nothing is broken right now/i)).toBeNull()
  })

  // Every action on this page asks the reader to go and chase a named
  // teammate. You may not send someone after a problem the page cannot
  // establish. (The real daemon sets action: null for absence problems; the
  // fixture supplies one, which is exactly the case worth pinning.)
  it('offers no chase-this-person action on an unconfirmed problem', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)
    await screen.findByTestId('problems-unconfirmed')
    expect(screen.queryByRole('button', { name: /send setup steps/i })).toBeNull()
  })

  // T-84. `exact` and `truncated` are two independent bits describing two
  // different things: `exact` says the two headline COUNTS were counted in the
  // database (027_team_feed_counts.sql), `truncated` says the paged FEED FETCH
  // stopped at its cap. AND-ing them wrongly is what masked feedTruncated on
  // the wire for four releases (3b0a97f); the mirror-image mistake is here --
  // marking a database-exact count as a floor just because the feed was cut.
  //
  // A "≥" on a number that is in fact the real total is not a safe hedge. It
  // tells the reader their figure is a lower bound and invites them to assume
  // the truth is higher, which is a different wrong answer, not a softer one.
  it('does not mark the database-exact counts as floors just because the feed was cut', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)
    await screen.findByTestId('insights-truncated')

    // Counted in the database, so these are the real totals however short the
    // feed fetch was.
    expect(screen.getByText('267')).toBeInTheDocument()
    expect(screen.getByText('2,000')).toBeInTheDocument()
    expect(screen.queryByText('≥267')).toBeNull()
    expect(screen.queryByText('≥2,000')).toBeNull()

    // CAP_NOTE blames an out-of-date server, and the server is not out of
    // date -- `exact` is true. Its own doc says it is for `exact:false +
    // truncated:true` and nothing else.
    expect(screen.queryByText(/approximate/)).toBeNull()
    expect(screen.queryByText(/out of date/)).toBeNull()
  })

  // The counterpart, and the reason this is not simply "drop the ≥ marks":
  // members-syncing is NOT one of the database-counted figures. `ok` is
  // derived from the fetched pages, so a short fetch really can undercount it
  // and `exact` says nothing about it either way. It keeps its ≥ on exactly
  // the same payload the assertion above requires to be unmarked.
  // BOUNDARY, found by mutation. `coveredDays < windowDays` survived being
  // changed to `<=`, which means nothing pinned the case where the fetch
  // reached EXACTLY the window asked for. Under `<=` that reads as a cut
  // window and announces "the oldest 0 days are not included" -- the page
  // claiming it is less certain than it is, which is the same defect as
  // claiming more certainty, just in the flattering direction.
  it('does not call the window cut when the fetch reached exactly the window asked for', async () => {
    renderWith(await clientServing(await cut({ lookbackDays: 30, coveredDays: 30 })), <InsightsPage />)

    const notice = await screen.findByTestId('insights-truncated')
    // Not the "showing N of the 30" phrasing: nothing of the current window was missed.
    expect(notice.textContent).not.toMatch(/of the 30 days you asked for/)
    expect(notice.textContent).not.toMatch(/oldest 0 days/)
    // The honest reading at this boundary: the window is whole, the PRIOR one
    // is what got capped.
    expect(notice).toHaveTextContent(/comparison with the previous 30 days is unavailable/)
  })

  it('marks members-syncing as a minimum instead of counting people out', async () => {
    renderWith(await clientServing(await cut()), <InsightsPage />)

    // Anchored on loaded content: the loading frame renders the same four stat
    // LABELS with bars in place of figures, so a findByText on the label alone
    // resolves one state too early.
    await screen.findByTestId('insights-truncated')
    const cell = screen.getByText('members syncing').closest('.stat-cell')
    expect(cell).toHaveTextContent('≥2/3')
    // The whole note, not a fragment: it has to say BOTH that the figure is a
    // lower bound and why, in the same words the banner above it uses. An
    // assertion on "a minimum" alone would survive the note losing its reason.
    expect(cell).toHaveTextContent('a minimum — some days are not included')
    // `ok` can only be undercounted by a short fetch, so the missing member
    // must not be reported as a person who has gone quiet.
    expect(cell).not.toHaveTextContent(/haven't shared recently/)
  })

  // The CSV is the copy that gets forwarded to the person it names, so it must
  // not out-claim the screen it came from.
  it('exports the problem as unconfirmed rather than broken, and carries the reached span', async () => {
    const csv = buildCsv(await cut())
    expect(csv).toContain('feed_truncated,true')
    expect(csv).toContain('feed_covered_days,12')
    expect(csv).toContain('unconfirmed,Nothing has arrived from Sarah')
    expect(csv).not.toContain('broken,Nothing has arrived from Sarah')
  })

  it('keeps Broken, Minor and the plain fraction when the fetch completed', async () => {
    renderApp({}, <InsightsPage />)

    const broken = await screen.findByTestId('problems-broken')
    expect(within(broken).getByText(/Nothing has arrived from Sarah/)).toBeInTheDocument()
    expect(screen.getByTestId('problems-minor')).toBeInTheDocument()
    expect(screen.queryByTestId('problems-unconfirmed')).toBeNull()
    expect(screen.queryByTestId('insights-truncated')).toBeNull()
    expect(screen.getByRole('button', { name: /send setup steps/i })).toBeInTheDocument()
    expect((screen.getByText('members syncing').closest('.stat-cell'))).toHaveTextContent('2/3')
  })
})

// T-71 second shape: the CURRENT window is whole but the PRIOR one is not, so
// the trend against the previous window is what got capped. Different sentence
// entirely -- "30 days requested, 42 days reached" would read as growth, when
// the point is that the reader can trust everything in the current window and
// only the year-over-year comparison is unavailable.
describe('Insights when only the prior window was cut short', () => {
  const capped = async () => ({
    ...(await new FakeDataClient().getInsights(30)),
    exact: true,
    truncated: true,
    // The daemon requests window * 2 = 60 days; reaching 42 means the LAST
    // 30 days are complete and the previous 30 days are short.
    lookbackDays: 42,
    coveredDays: 42,
    sessions: { count: 812, deltaPct: null },
    entriesShared: { count: 3400, delta: null },
  })

  it('names the trend as capped, not the window as truncated', async () => {
    renderWith(await clientServing(await capped()), <InsightsPage />)

    const notice = await screen.findByTestId('insights-truncated')
    // Not the "showing N of the 30" phrasing -- that would read as growth
    // ("showing 42 of the 30 days") when the actual fact is a capped delta.
    expect(notice.textContent).not.toMatch(/of the 30 days you asked for/)
    expect(notice).toHaveTextContent(/comparison with the previous 30 days is unavailable/)
    // Reassures on the current window itself, which is the fact the reader
    // most needs to know before deciding whether to trust the figures below.
    expect(notice).toHaveTextContent(/last 30 days are complete/)
    expect(notice).toHaveTextContent(/only go back 42 days/)
  })

  it('still demotes the silent-teammate sentence, because the sentence reads over the same rows', async () => {
    // Coordinator's rule: silent-teammate demotion fires whenever truncated
    // is true, not only when the current window is short. The delta-only
    // case still means the problems list was built from a capped view --
    // any teammate whose last row is older than 42 days is invisible.
    renderWith(await clientServing(await capped()), <InsightsPage />)
    await screen.findByTestId('problems-unconfirmed')
    expect(screen.queryByTestId('problems-broken')).toBeNull()
  })
})

// `ok === total ? 'all healthy' : "N haven't shared recently"` survived being
// inverted, so nothing distinguished a fully-synced team from a partly-synced
// one. Inverted, a team where everyone is syncing reads "0 haven't shared
// recently" and a team with someone missing reads "all healthy" -- a false
// assurance about whether teammates' work is reaching you, which is the whole
// question this stat exists to answer.
describe('the members-syncing note distinguishes a whole team from a partial one', () => {
  const serving = async (ok: number, total: number) => {
    const base = await new FakeDataClient().getInsights(30)
    return clientServing({ ...base, membersSyncing: { ok, total } })
  }

  it('says all healthy only when everyone has shared into the window', async () => {
    renderWith(await serving(3, 3), <InsightsPage />)
    // Anchored on a LOADED figure first: the loading frame renders the same
    // four stat labels with bars in place of numbers, so finding the label
    // alone resolves one state too early.
    await screen.findByText('412')
    const cell = screen.getByText('members syncing').closest('.stat-cell')
    expect(cell).toHaveTextContent('3/3')
    expect(cell).toHaveTextContent(/all healthy/)
    expect(cell?.textContent).not.toMatch(/shared recently/)
  })

  it('counts the quiet ones when somebody has not', async () => {
    renderWith(await serving(2, 3), <InsightsPage />)
    await screen.findByText('412')
    const cell = screen.getByText('members syncing').closest('.stat-cell')
    expect(cell).toHaveTextContent('2/3')
    expect(cell).toHaveTextContent(/1 haven't shared recently/)
    expect(cell?.textContent).not.toMatch(/all healthy/)
  })
})

describe('InsightsPage', () => {
  it('renders exactly two skeleton lines', async () => {
    renderApp({}, <InsightsPage />)
    const panel = await screen.findByTestId('skeleton-panel')
    expect(within(panel).getAllByRole('row')).toHaveLength(2)
    expect(within(panel).getByText('Repeat file opens')).toBeInTheDocument()
    expect(within(panel).getByText('Answered by our memory first')).toBeInTheDocument()
  })

  it('shows the stat as pending rather than a number when unavailable', async () => {
    renderApp({ skeletonAvailable: false }, <InsightsPage />)
    expect(await screen.findAllByText(/pending/i)).not.toHaveLength(0)
    expect(screen.queryByText('68%')).toBeNull()
  })

  it('separates broken problems from minor ones and shows each denominator', async () => {
    renderApp({}, <InsightsPage />)
    const broken = await screen.findByTestId('problems-broken')
    const minor = screen.getByTestId('problems-minor')
    // Denominators come straight from the API's `scale` line for either
    // severity -- "joined 3 days ago" for the broken (absence-phrased)
    // problem, "of 412" for the minor one.
    expect(within(broken).getByText(/joined 3 days ago/)).toBeInTheDocument()
    expect(within(minor).getByText(/of 412/)).toBeInTheDocument()
  })

  it('offers the fixing action on a broken problem', async () => {
    renderApp({}, <InsightsPage />)
    expect(await screen.findByRole('button', { name: /send setup steps/i })).toBeInTheDocument()
  })

  // Task 18 Part C: the default fixture used to phrase this as a machine
  // diagnosis ("...hook not installed since she joined"), which this
  // machine has no way to actually know -- it can only see that nothing has
  // arrived. Fixed to match lib/api-insights.js's real silentTeammateProblems
  // wording exactly ("Nothing has arrived from X").
  it('phrases a teammate problem as absence, never as a machine diagnosis', async () => {
    renderApp({}, <InsightsPage />)
    const broken = await screen.findByTestId('problems-broken')
    expect(within(broken).getByText(/Nothing has arrived from Sarah/)).toBeInTheDocument()
    expect(within(broken).getByText(/0 entries shared/)).toBeInTheDocument()
    // The action asks them to check; it must not diagnose their machine.
    expect(screen.queryByText(/hook not installed|token expired/i)).toBeNull()
  })

  it('renders no dollar figure anywhere', async () => {
    const { container } = renderApp({}, <InsightsPage />)
    await screen.findByText('Repeat file opens')
    expect(container.textContent).not.toMatch(/\$/)
  })

  it('has no heat grid', async () => {
    renderApp({}, <InsightsPage />)
    await screen.findByText('Repeat file opens')
    expect(screen.queryByText(/when the team works/i)).toBeNull()
  })

  it('never calls getInsights for a member role', async () => {
    const client = new FakeDataClient({ role: 'member' })
    const insightsSpy = vi.spyOn(client, 'getInsights')
    renderWith(client, <InsightsPage />)
    expect(await screen.findByText(/owners and admins/i)).toBeInTheDocument()
    expect(insightsSpy).not.toHaveBeenCalled()
  })

  it('never calls getInsights in solo mode', async () => {
    // T-78 item 14: on a fresh solo install (no team of any kind) the copy
    // says WHAT this screen is, not what permission it needs -- a signed-out
    // user has no team, so "available to team owners and admins" was true
    // but useless. The role-restricted case (a signed-in member, tested just
    // above) keeps its original wording, since for that reader the tier is
    // the answer.
    const client = new FakeDataClient({ solo: true })
    const insightsSpy = vi.spyOn(client, 'getInsights')
    renderWith(client, <InsightsPage />)
    expect(await screen.findByText(/team surface/i)).toBeInTheDocument()
    expect(screen.getByText(/join or create a team/i)).toBeInTheDocument()
    expect(insightsSpy).not.toHaveBeenCalled()
  })

  // The owner-locked-out bug. `status.solo` does not mean "has no team": the
  // daemon derives it from whether a LINKED PROJECT belongs to a multi-member
  // team, so an owner whose repo link is missing -- or whose team is still
  // just them -- reports solo while genuinely owning a team. Gating the page
  // on !solo showed that owner "Insights is available to team owners and
  // admins", which is exactly what happened in 0.2.8 when .membridge/team.json
  // was deleted from the repo. The fake ties its own `solo` option to "no
  // team", so the two have to be pulled apart by hand here.
  it('renders for an owner whose machine reports solo but who is on a team', async () => {
    const client = new FakeDataClient()
    const status = await client.getStatus()
    vi.spyOn(client, 'getStatus').mockResolvedValue({ ...status, solo: true })
    const settings = await client.getSettings()
    expect(settings.team?.role).toBe('owner')

    renderWith(client, <InsightsPage />)
    expect(await screen.findByText('Repeat file opens')).toBeInTheDocument()
    expect(screen.queryByText(/owners and admins/i)).toBeNull()
  })

  // Assists breakdown (owner's ask: "answered by our memory first should be
  // a better stat -- it should be any instance where the memory helped").
  // The default FakeDataClient fixture is total: 864, byKind: { recallServed:
  // 818, teammateNotes: 46 } -- 818 + 46 = 864, so the headline is provably
  // the sum of the auditable rows underneath it, not a magic number.
  it('renders the assists breakdown and its rows sum to the headline', async () => {
    renderApp({}, <InsightsPage />)
    const strip = await screen.findByText('864')
    expect(strip.closest('.stat-cell')).toHaveTextContent('times memory helped')

    const breakdown = await screen.findByTestId('assists-breakdown')
    const rows = within(breakdown).getAllByRole('row')
    expect(rows).toHaveLength(2)
    expect(within(breakdown).getByText('Recall served a file instead of a read')).toBeInTheDocument()
    expect(within(breakdown).getByText('818')).toBeInTheDocument()
    expect(within(breakdown).getByText('Teammate notes delivered into a session')).toBeInTheDocument()
    expect(within(breakdown).getByText('46')).toBeInTheDocument()

    const sum = 818 + 46
    expect(sum).toBe(864)
  })

  // The MCP tally counts DISTINCT tools that have seen use, never calls, so
  // it saturates at the size of the tool allowlist and can never be an
  // instance count. It used to be summed into the headline anyway, which
  // made that headline untraceable and understated real MCP use. It now
  // renders as its own fraction, outside the rows that sum to the headline.
  it('shows the MCP tool coverage as a fraction, outside the assist total', async () => {
    renderApp({}, <InsightsPage />)
    const gauge = await screen.findByTestId('assists-mcp-tools')
    expect(gauge).toHaveTextContent('Distinct memory tools in use')
    expect(gauge).toHaveTextContent('4 of 6')
    // Not a row: the rows are exactly what the headline sums.
    expect(within(gauge).queryAllByRole('row')).toHaveLength(0)
    expect(screen.queryByText(/MCP memory tools queried/i)).toBeNull()
  })

  it('shows no breakdown, only pending, when assists are unavailable', async () => {
    renderApp({ skeletonAvailable: false }, <InsightsPage />)
    await screen.findAllByText(/pending/i)
    expect(screen.queryByTestId('assists-breakdown')).toBeNull()
  })

  // The knowledge-concentration reason used to render in the same `.lrow`
  // flex line as the project name, inside `.lrow-value` -- which is
  // `white-space: nowrap` and has no `min-width: 0`. A nowrap flex item's
  // intrinsic minimum is its FULL text width, so one long reason set the
  // minimum width of the whole 340px right column and pushed the page past
  // the 1280px default window. The reason IS the content, so it cannot be
  // ellipsised away: it has to become its own wrapping line beneath the
  // name, the same label+description shape SettingRow.tsx already uses.
  it('renders the concentration reason as its own line beneath the project name', async () => {
    const client = new FakeDataClient()
    const base = await client.getInsights(30)
    const detail = '41 sessions and nobody else on the team has opened this project in the last 30 days'
    vi.spyOn(client, 'getInsights').mockResolvedValue({
      ...base,
      concentration: [{ projectName: 'billing-poc', onlyPerson: 'Andrew', detail }],
    })
    renderWith(client, <InsightsPage />)

    // The whole reason survives -- no truncation, no ellipsis substitute.
    const reason = await screen.findByText(`Andrew only · ${detail}`)
    // The name is a LINK now (Task 3), so getByText lands on the <a>; the
    // structural claim below is about the .lrow-name line that holds it.
    const name = screen.getByText(/billing-poc/).closest('.lrow-name')!

    // It is a separate element from the name, not the nowrap metric sibling.
    expect(reason).not.toBe(name)
    expect(reason).not.toHaveClass('lrow-value')

    // ...and it sits BENEATH the name inside a shared label block, so it has
    // a block of its own to wrap inside of.
    const label = name.parentElement
    expect(label).not.toBeNull()
    expect(reason.parentElement).toBe(label)
    expect(name.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('switches the time window and refetches for the new window', async () => {
    const client = new FakeDataClient()
    const insightsSpy = vi.spyOn(client, 'getInsights')
    renderWith(client, <InsightsPage />)
    await screen.findByText('Repeat file opens')
    expect(insightsSpy).toHaveBeenCalledWith(30)

    await userEvent.click(screen.getByRole('button', { name: '7 days' }))
    expect(await screen.findByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true')
    expect(insightsSpy).toHaveBeenCalledWith(7)
  })
})

// T-61, and the screen Marco actually named. GET /api/team/insights?window=30
// takes 3.6-4.0s on his install (three consecutive curl runs: 3.98s, 3.93s,
// 3.63s), and for all of it this page rendered:
//
//   t=65ms    an empty <div className="insights-page" /> -- a blank window
//   t=253ms   a bare "Loading…" paragraph, no header, no strip, no columns
//   t=4371ms  the entire page, all at once
//
// Two undesigned states and a four-second layout jump. Note this is a
// DIFFERENT endpoint from /api/insights (0.6ms), which this screen never calls
// -- the fast one is not the one behind the wait.
describe('Insights while its payload is still in flight', () => {
  const pendingInsights = () => {
    const client = new FakeDataClient()
    // Never resolves: pending is the state under test.
    vi.spyOn(client, 'getInsights').mockReturnValue(new Promise(() => {}))
    return client
  }

  it('renders the page frame immediately instead of a bare Loading line', async () => {
    renderWith(pendingInsights(), <InsightsPage />)

    // The frame: title, window selector, and the four stat cells the loaded
    // page renders -- so nothing is renamed or re-counted when data lands.
    //
    // Awaited on the window selector, not on the heading: the OUTER gate
    // (status/settings, tested in its own describe below) renders a heading
    // too, so a findBy on that would resolve one state too early and assert
    // against the wrong frame.
    expect(await screen.findByRole('group', { name: 'Time window' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Insights' })).toBeInTheDocument()
    for (const label of ['sessions', 'times memory helped', 'members syncing', 'memory entries shared']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('shows bars, not zeros, in every stat cell', async () => {
    renderWith(pendingInsights(), <InsightsPage />)

    const cell = (await screen.findByText('sessions')).closest('.stat-cell')
    expect(cell?.querySelector('.loading-block')).not.toBeNull()
    expect(cell?.querySelector('.stat-value')?.textContent).not.toMatch(/\d/)
  })

  it('holds both columns open with placeholder rows', async () => {
    renderWith(pendingInsights(), <InsightsPage />)

    expect(await screen.findByTestId('insights-people-loading')).toBeInTheDocument()
    expect(screen.getByTestId('insights-problems-loading')).toBeInTheDocument()
  })

  // A 30-day window that takes four seconds is exactly when a reader wants to
  // ask for 7 instead. Disabling the control would make them wait out an
  // answer they have already decided against.
  it('keeps the window selector usable during the wait', async () => {
    renderWith(pendingInsights(), <InsightsPage />)

    const sevenDays = await screen.findByRole('button', { name: '7 days' })
    expect(sevenDays).toBeEnabled()
    await userEvent.click(sevenDays)
    expect(sevenDays).toHaveAttribute('aria-pressed', 'true')
  })

  // Nothing to export yet. An absent control is honest where a disabled one is
  // a dead button, and a live one would hand back an empty CSV.
  it('offers no Export CSV until there is something to export', async () => {
    renderWith(pendingInsights(), <InsightsPage />)

    await screen.findByRole('heading', { name: 'Insights' })
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })
})

// The outer gate, before the role check: this returned a literally empty
// element while getSettings() fanned out to /api/settings + /api/status +
// /api/team (~250ms, dominated by /api/team).
describe('Insights before status and settings have resolved', () => {
  it('names the screen instead of painting a blank window', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getSettings').mockReturnValue(new Promise(() => {}))
    renderWith(client, <InsightsPage />)

    expect(await screen.findByRole('heading', { name: 'Insights' })).toBeInTheDocument()
    expect(screen.getByTestId('insights-outer-loading')).toBeInTheDocument()
    // NOT the admin page's furniture: this runs before the role check, and a
    // member who typed the URL must not watch it assemble and then be refused.
    expect(screen.queryByRole('group', { name: 'Time window' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
  })
})
