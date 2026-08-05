import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { projectHref, sessionHref } from '../../app/routes'
import { ProjectPage } from './ProjectPage'

describe('ProjectPage', () => {
  it('states the consequence of revoking a member by name, honestly', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    const note = await screen.findByText(/loses access to this project/)
    expect(note).toHaveTextContent('Sarah')
    // Three things must all survive here: (1) the backend revokes access
    // immediately, (2) anything already synced to their machine is cleaned
    // up the next time it checks in (prune-on-revocation), and (3) a
    // device that never syncs again keeps its copy -- that case must read
    // as a fact, not a hedge, and must never be dropped in favor of (1)+(2)
    // alone (which would imply removal is guaranteed).
    expect(note).toHaveTextContent(/right away/i)
    expect(note).toHaveTextContent(/removed the next time it checks in/i)
    expect(note).toHaveTextContent(/never syncs again/i)
    expect(note).toHaveTextContent(/keeps its copy/i)
    expect(note.textContent).not.toMatch(/retroactive/i)
  })

  it('leads each stream entry with the outcome and shows the ask as intent', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    expect(await screen.findByText(/Hook ownership now decided by durability/)).toBeInTheDocument()
    expect(screen.getByText(/make the summary hook fire on session boundaries/)).toBeInTheDocument()
  })

  it('toggling a member calls setProjectAccess with that member', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /Sarah/ })
    await userEvent.click(toggle)
    expect(await screen.findByRole('switch', { name: /Sarah/ })).toBeChecked()
  })

  // Fix 8: useSetProjectAccess rolls an optimistic toggle back on failure,
  // but no consumer said WHY the toggle snapped back -- the failure needs a
  // role="alert" line, same as setAccessDefault's below.
  it('surfaces a failed access toggle instead of silently snapping back', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setProjectAccess').mockRejectedValue(new Error('access write rejected'))
    renderWith(client, <ProjectPage slug="membridge" />)
    await userEvent.click(await screen.findByRole('switch', { name: /Sarah/ }))
    const alert = await screen.findByText(/couldn't change access/i)
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert.textContent).toContain('access write rejected')
  })

  it('hides the access panel from a member role', async () => {
    renderApp({ role: 'member' }, <ProjectPage slug="membridge" />)
    await screen.findByText(/Hook ownership/)
    expect(screen.queryByText(/who sees this project/i)).toBeNull()
  })

  it('opens memory.md through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'openMemoryFile')
    renderWith(client, <ProjectPage slug="membridge" />)
    await userEvent.click(await screen.findByRole('button', { name: 'memory.md' }))
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge')
  })

  it('toggles "new members join with access" through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setProjectAccessDefault')
    renderWith(client, <ProjectPage slug="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /new members join with access/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith('/Users/x/membridge', false)
  })

  it('surfaces a failed access-default write instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setProjectAccessDefault').mockRejectedValue(new Error('default write rejected'))
    renderWith(client, <ProjectPage slug="membridge" />)
    const toggle = await screen.findByRole('switch', { name: /new members join with access/i })
    await userEvent.click(toggle)
    expect(await screen.findByText(/default write rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed memory.md open instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'openMemoryFile').mockRejectedValue(new Error('open rejected'))
    renderWith(client, <ProjectPage slug="membridge" />)
    await userEvent.click(await screen.findByRole('button', { name: 'memory.md' }))
    expect(await screen.findByText(/open rejected/i)).toBeInTheDocument()
  })

  // BUG 2, project-page half: the stream shares EntryRow with the Feed, and
  // shares the same checkpoint-collapsing gap -- a session's several Stop
  // hook checkpoints must collapse to its newest, same as the Feed.
  it('collapses several checkpoint entries of the same session into one row showing the newest text', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjectStream').mockResolvedValue([
      { id: 'c2', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:05:00Z', live: false, outcome: 'second checkpoint', intent: null, files: [], session: 's1', summaryFull: null, decisions: null, gotchas: null, changes: [] },
      { id: 'c1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:00:00Z', live: false, outcome: 'first checkpoint', intent: null, files: [], session: 's1', summaryFull: null, decisions: null, gotchas: null, changes: [] },
    ])
    renderWith(client, <ProjectPage slug="membridge" />)

    expect(await screen.findByText('second checkpoint')).toBeInTheDocument()
    expect(screen.queryByText('first checkpoint')).toBeNull()
  })

  // Task 6: ProjectPage renders the SAME EntryRow the Feed does, so its rows
  // inherit the session link with no ProjectPage.tsx change at all.
  it('stream rows inherit the session link from EntryRow', async () => {
    renderWith(new FakeDataClient(), <ProjectPage slug="membridge" />)
    const outcome = await screen.findByText(/Hook ownership now decided by durability/)
    const row = outcome.closest('.entry-row')
    expect(row).not.toBeNull()
    expect(row!.tagName).toBe('A')
    // Carries ?from= pointing at this project, so the session page's back
    // link returns here instead of dumping the reader in the Feed (Task 2).
    expect(row!.getAttribute('href')).toBe(sessionHref('s-e1', projectHref('/Users/x/membridge')))
  })
})

// Task 7 (projects tab scale and archive, spec section 4): a shared project
// must OPEN shared -- the Shared badge from the team link, a stream carrying
// every author's sessions, and the member avatar stack.
describe('a shared project opens shared', () => {
  it('renders the Shared badge, never Private, for a project with a team link', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    await screen.findByText(/Hook ownership/)
    expect(screen.getByText('Shared')).toBeInTheDocument()
    expect(screen.queryByText('Private')).toBeNull()
  })

  it('streams every author: a teammate-authored row is present (the actual defect)', async () => {
    renderApp({}, <ProjectPage slug="membridge" />)
    await screen.findByText(/Hook ownership/)
    // The fixture stream entry is authored by Andrew, not the viewer -- it
    // must render as a stream row, not be self-filtered away.
    const authors = screen.getAllByText('Andrew')
    expect(authors.some(el => el.className.includes('entry-row-who'))).toBe(true)
  })

  it('renders the member avatar stack for a shared project, at every role', async () => {
    const member = renderApp({ role: 'member' }, <ProjectPage slug="membridge" />)
    await screen.findByText(/Hook ownership/)
    const stack = screen.getByTestId('project-member-stack')
    expect(stack.querySelectorAll('.avatar').length).toBeGreaterThanOrEqual(3)
    member.unmount()
  })

  it('renders no member stack for a private project', async () => {
    renderApp({}, <ProjectPage slug="sublease" />)
    await screen.findByText(/sublease/)
    expect(screen.queryByTestId('project-member-stack')).toBeNull()
  })

  // T15: Project.recentAuthorIds is who has shown up here lately, off one
  // capped cross-project feed page. Rendered as an unlabelled stack of faces
  // immediately right of the "Shared" tag it read as the share roster, and
  // rendered as a figure in the Sync panel it read as a headcount. It is
  // neither. The faces stay (approximate is honest for "who's been active");
  // the label is what stops them answering the wrong question, and the figure
  // is gone.
  describe('recent-author faces are not a roster or a headcount', () => {
    /** A shared project with a real week of sessions but NO entries on the
     *  shared feed page -- the case that produced "31 sessions · 0 people". */
    function quietSharedClient(role: 'owner' | 'member' = 'member') {
      const client = new FakeDataClient({ role })
      const real = client.getProjects.bind(client)
      vi.spyOn(client, 'getProjects').mockImplementation(async () =>
        (await real()).map(p => (p.shared ? { ...p, recentAuthorIds: [] } : p)))
      return client
    }

    it('names the avatar group as recent activity, never as who it is shared with', async () => {
      renderApp({ role: 'member' }, <ProjectPage slug="membridge" />)
      await screen.findByText(/Hook ownership/)
      const group = screen.getByRole('img', { name: /recently active here/i })
      expect(group).toBe(screen.getByTestId('project-member-stack'))
      // Every face shown is accounted for in the one announced label.
      expect(group.getAttribute('aria-label')).toContain('Marco')
      expect(group.getAttribute('aria-label')).toContain('Andrew')
      expect(group.getAttribute('aria-label')).not.toMatch(/shared with|can see|access/i)
    })

    it('never pairs the week\'s session count with a people figure', async () => {
      renderWith(quietSharedClient(), <ProjectPage slug="membridge" />)
      await screen.findByText(/Hook ownership/)
      // The row that used to contradict itself: 31 real sessions beside 0 people.
      const row = screen.getByText('This week').parentElement!
      expect(row.textContent).toContain('31 sessions')
      expect(row.textContent).not.toMatch(/people/i)
      expect(row.textContent).not.toMatch(/\b0\b/)
    })

    it('hides the faces entirely rather than showing an empty group', async () => {
      renderWith(quietSharedClient(), <ProjectPage slug="membridge" />)
      await screen.findByText(/Hook ownership/)
      expect(screen.queryByTestId('project-member-stack')).toBeNull()
      expect(screen.queryByRole('img', { name: /recently active here/i })).toBeNull()
    })
  })

  // The Sync panel's encryption chip. It already branched on plaintextOff, so
  // the encrypted-but-dual-write case was not hidden -- but it labelled that
  // case "plaintext shared", the words for the encryption-OFF case, and toned
  // encryption-off itself `muted` under the label "off". Muted is this system's
  // neutral/absence tone, so the one state where the server can read everything
  // was the only one rendered as unremarkable, described as a switch position
  // rather than as a consequence.
  describe('encryption state in the Sync panel', () => {
    async function withEncryption(encryption: { enabled: boolean; plaintextOff: boolean }) {
      const client = new FakeDataClient()
      const status = await client.getStatus()
      vi.spyOn(client, 'getStatus').mockResolvedValue({
        ...status,
        encryption: { ...status.encryption, ...encryption },
      })
      renderWith(client, <ProjectPage slug="membridge" />)
      await screen.findByText('Encryption')
      return screen.getByText('Encryption').closest('.kv') as HTMLElement
    }

    // Substring regexes, not exact strings: StateChip renders the glyph and the
    // label as two text nodes in one span, so the element's text is "✓ end-to-
    // end" and an exact-string matcher never sees the label on its own.
    it('reassures only when nothing readable is retained', async () => {
      const row = await withEncryption({ enabled: true, plaintextOff: true })
      const chip = within(row).getByText(/end-to-end/)
      expect(chip.className).toMatch(/chip-ok/)
    })

    it('warns, in its own words, when a readable copy is stored beside the ciphertext', async () => {
      const row = await withEncryption({ enabled: true, plaintextOff: false })
      const chip = within(row).getByText(/readable copy stored/)
      expect(chip.className).toMatch(/chip-warn/)
      // Must not borrow the encryption-OFF wording for this state -- that is
      // what left the two unsafe states labelled as each other.
      expect(within(row).queryByText(/plaintext shared/)).toBeNull()
    })

    // The state of a real incident: a config with team.encrypt false shipped a
    // full plaintext history while this chip read a neutral, unalarming "off".
    it('warns rather than muting when encryption is off entirely', async () => {
      const row = await withEncryption({ enabled: false, plaintextOff: true })
      const chip = within(row).getByText(/plaintext shared/)
      expect(chip.className).toMatch(/chip-warn/)
      expect(row.querySelector('.chip-muted')).toBeNull()
      expect(within(row).queryByText(/\boff\b/)).toBeNull()
    })

    // plaintextOff is INERT with no key: the daemon's nulling lives inside
    // encryptRow, which never runs. A ciphertext-only reading must not soften
    // the encryption-off state into anything reassuring.
    it('gives ciphertext-only no credit while encryption is off', async () => {
      const row = await withEncryption({ enabled: false, plaintextOff: true })
      expect(row.querySelector('.chip-ok')).toBeNull()
      expect(within(row).queryByText(/end-to-end/)).toBeNull()
    })
  })
})

// T-72. The project page's two worst not-yet-known-as-empty states, both fed by
// GET /api/feed?project=… (850ms-1.1s measured). Sampled per animation frame in
// a visible Chrome on a real 28-session project:
//
//   0    -> 1640ms   main region entirely blank (useProjects awaits /api/feed)
//   1640 -> 2486ms   "No activity captured yet."  + Status "waiting for the
//                    first session"  — on a project with 28 captured sessions
//
// The status chip is the worse of the two: an empty note is a claim about a
// list, but a muted health chip is a claim about whether the product is working
// at all, and it was asserting a state the code had not observed.
describe('ProjectPage while its data is still in flight', () => {
  const forever = () => new Promise<never>(() => {})

  it('does not claim the project has no activity while the stream is loading', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjectStream').mockReturnValue(forever())
    renderWith(client, <ProjectPage slug="membridge" />)

    expect(await screen.findByTestId('project-stream-loading')).toBeInTheDocument()
    expect(screen.queryByText('No activity captured yet.')).toBeNull()
  })

  it('does not report "waiting for the first session" before the stream answers', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjectStream').mockReturnValue(forever())
    renderWith(client, <ProjectPage slug="membridge" />)

    await screen.findByTestId('project-stream-loading')
    expect(screen.queryByText('waiting for the first session')).toBeNull()
    // And not the opposite lie either — "delivering" is equally unearned here.
    expect(screen.queryByText('delivering')).toBeNull()
  })

  it('names the page instead of rendering nothing while the project list loads', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjects').mockReturnValue(forever())
    renderWith(client, <ProjectPage slug="membridge" />)

    expect(await screen.findByTestId('project-loading')).toBeInTheDocument()
    // Must NOT have decided the project is missing — that is the other branch
    // of this same `if (!project)`.
    expect(screen.queryByText(/not found/)).toBeNull()
  })

  // The screen still has to be able to say "nothing" once it really knows.
  it('still reports no activity once the stream comes back empty', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getProjectStream').mockResolvedValue([])
    renderWith(client, <ProjectPage slug="membridge" />)

    expect(await screen.findByText('No activity captured yet.')).toBeInTheDocument()
    expect(screen.queryByTestId('project-stream-loading')).toBeNull()
  })
})
