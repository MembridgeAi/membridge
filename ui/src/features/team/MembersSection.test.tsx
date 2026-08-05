import { describe, it, expect, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import type { AccessMatrix } from '../../data/types'
import { MembersSection } from './MembersSection'

/** An access matrix in which Sarah is blocked from exactly `blocked`, told as
 *  shared rows, plus one shared row she can see (so a test cannot pass just by
 *  counting rows) and one PRIVATE row where her flag is false. The daemon never
 *  sends false on an unshared row -- it fills `true` for everyone -- but the
 *  private row is here to prove the reader gates on `shared` rather than
 *  reading the flag off any row it is handed. */
function matrixBlockingSarahFrom(blocked: string[]): AccessMatrix {
  const seen = (name: string, sarah: boolean, shared: boolean) => ({
    projectPath: `/Users/x/${name}`, projectName: name, shared,
    access: { me: true, andrew: true, sarah },
  })
  return {
    members: [{ id: 'me', name: 'Marco' }, { id: 'andrew', name: 'Andrew' }, { id: 'sarah', name: 'Sarah' }],
    rows: [
      ...blocked.map(name => seen(name, false, true)),
      seen('visible-to-all', true, true),
      seen('my-private-thing', false, false),
    ],
  }
}

async function openRemoveDialogForSarah() {
  await userEvent.click(await screen.findByRole('button', { name: /more actions for Sarah/i }))
  await userEvent.click(screen.getByRole('menuitem', { name: /remove from team/i }))
  return screen.findByRole('dialog')
}

describe('MembersSection (the People section of the Team page)', () => {
  it('confirms before removing a member and says what removal does, honestly', async () => {
    renderApp({}, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Sarah/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /remove from team/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Sarah')
    expect(dialog).toHaveTextContent(/cuts off access to every shared project/i)
    // This is the moment the admin forms their expectation, so it must
    // carry the same honesty as the project access panel's toggle-off note:
    // access is revoked immediately, anything already synced is cleaned up
    // the next time that machine checks in (prune-on-revocation), and a
    // device that never syncs again keeps its copy -- stated as fact, not
    // hedged, and never implying removal is guaranteed or complete.
    expect(dialog).toHaveTextContent(/right away/i)
    expect(dialog).toHaveTextContent(/removed the next time it checks in/i)
    expect(dialog).toHaveTextContent(/never syncs again/i)
    expect(dialog).toHaveTextContent(/keeps its copy/i)
    expect(dialog.textContent).not.toMatch(/retroactive/i)
  })

  // U-2: public.project_access cascades on the team_members foreign key, so
  // removing a member deletes their per-project revokes with their membership.
  // The half everyone reasons about is the good one -- no stale GRANT survives a
  // rejoin. The mirror half is invisible: no stale REVOKE survives either, so
  // revoke, remove, re-invite, and the project they were blocked from is
  // visible to them again with nothing anywhere having said so. The removal
  // dialog is the last moment that information both exists and is about to be
  // destroyed, which is why it is said there. (Not at invite time: an invite is
  // a bearer token with no addressee, so at mint time there is nobody to warn
  // about, by construction.)
  describe('removal warns that the member\'s per-project blocks will be lost', () => {
    it('names the projects and what happens if they rejoin', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'getAccessMatrix').mockResolvedValue(matrixBlockingSarahFrom(['membridge', 'billing']))
      renderWith(client, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      // Count and names, so the admin can decide whether the rejoin is a
      // problem without leaving this dialog to go read the Projects grid.
      await within(dialog).findByText(/blocked from 2 shared projects/i)
      expect(dialog).toHaveTextContent(/billing/)
      expect(dialog).toHaveTextContent(/membridge/)
      expect(dialog).toHaveTextContent(/if Sarah rejoins later/i)
      expect(dialog).toHaveTextContent(/re-apply the blocks by hand/i)
      // The private row's false flag must not be counted: the daemon fills
      // `true` for every member of an unshared project, so a false there is
      // not a revoke and naming it would invent a block that does not exist.
      expect(dialog.textContent).not.toMatch(/my-private-thing/)
      expect(dialog.textContent).not.toMatch(/visible-to-all/)
      // The original consequence is still the lead -- this is appended, not
      // substituted.
      expect(dialog).toHaveTextContent(/cuts off access to every shared project/i)
    })

    it('reads as one block, not "1 projects", for a single revoke', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'getAccessMatrix').mockResolvedValue(matrixBlockingSarahFrom(['membridge']))
      renderWith(client, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      await within(dialog).findByText(/blocked from 1 shared project \(membridge\)/i)
      expect(dialog).toHaveTextContent(/deletes that block/i)
      expect(dialog).toHaveTextContent(/that project becomes visible again/i)
      expect(dialog.textContent).not.toMatch(/1 shared projects/i)
    })

    it('counts the overflow rather than listing a dozen project names', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'getAccessMatrix')
        .mockResolvedValue(matrixBlockingSarahFrom(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']))
      renderWith(client, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      await within(dialog).findByText(/blocked from 6 shared projects \(a1, a2, a3, a4, and 2 more\)/i)
    })

    // U-4: with the warning appended, the message had grown to five sentences in
    // a single <p> -- on a destructive action, which is the worst place for a
    // wall of text. The question and its immediate answer are the first
    // paragraph; everything that follows from it, including the block warning,
    // is the second.
    it('reads as a question plus its consequences, not one block of text', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'getAccessMatrix').mockResolvedValue(matrixBlockingSarahFrom(['membridge']))
      renderWith(client, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      await within(dialog).findByText(/blocked from 1 shared project/i)

      const paragraphs = [...dialog.querySelectorAll('.dialog-message')]
      expect(paragraphs).toHaveLength(2)
      // First paragraph answers the title's question and stops there.
      expect(paragraphs[0].textContent).toMatch(/cuts off access to every shared project right away\.$/i)
      expect(paragraphs[0].textContent).not.toMatch(/blocked from|already synced/i)
      // Second carries the consequences, block warning included -- the part
      // most likely to go unread as the tail of a long paragraph.
      expect(paragraphs[1].textContent).toMatch(/nothing new reaches their machine/i)
      expect(paragraphs[1].textContent).toMatch(/blocked from 1 shared project/i)
    })

    it('leaves the dialog untouched for a member who has no blocks', async () => {
      // The default fixture's matrix grants every member every shared project.
      renderApp({}, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      expect(dialog).toHaveTextContent(/cuts off access to every shared project/i)
      // Deliberately NOT a reassuring "no blocks to lose" line: that is a claim
      // the matrix cannot make when it failed to load, and the two cases must
      // not be worded so as to be confusable.
      expect(dialog.textContent).not.toMatch(/blocked from|re-apply/i)
    })

    it('still removes the member while the matrix is in flight', async () => {
      const client = new FakeDataClient()
      // Never resolves: the matrix read is permanently pending.
      vi.spyOn(client, 'getAccessMatrix').mockImplementation(() => new Promise<AccessMatrix>(() => {}))
      const removeSpy = vi.spyOn(client, 'removeMember')
      renderWith(client, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      expect(dialog.textContent).not.toMatch(/blocked from/i)
      const confirm = within(dialog).getByRole('button', { name: /remove from team/i })
      expect(confirm).toBeEnabled()
      await userEvent.click(confirm)
      expect(removeSpy).toHaveBeenCalledWith('sarah')
    })

    it('still removes the member when the matrix read failed', async () => {
      const client = new FakeDataClient()
      vi.spyOn(client, 'getAccessMatrix').mockRejectedValue(new Error('access matrix unreachable'))
      const removeSpy = vi.spyOn(client, 'removeMember')
      renderWith(client, <MembersSection />)
      const dialog = await openRemoveDialogForSarah()
      expect(dialog.textContent).not.toMatch(/blocked from/i)
      // A failed access read must not become a second permission system: the
      // manager keeps the ability to remove someone, and the dialog degrades
      // to the text it had before this warning existed rather than guessing.
      expect(dialog.textContent).not.toMatch(/access matrix unreachable/i)
      await userEvent.click(within(dialog).getByRole('button', { name: /remove from team/i }))
      expect(removeSpy).toHaveBeenCalledWith('sarah')
    })
  })

  it('says plainly when a member has shared nothing, without guessing why', async () => {
    renderApp({}, <MembersSection />)
    expect(await screen.findByText(/nothing shared yet/i)).toBeInTheDocument()
    // We cannot see a teammate's machine, so no cause may be asserted.
    expect(screen.queryByText(/token expired|hook not installed/i)).toBeNull()
  })

  // Found by routing FakeDataClient through the real mapMember. The fixture
  // used to author Member literals with plausible addresses
  // ('andrew@acme.dev'), so every screenshot and every test saw a populated
  // email -- while mapMember hardcodes `email: ''`, because the members RPC
  // has never returned one. Production rendered a permanently blank 10.5px
  // line under every name and nothing could catch it, because the only data
  // the tests ever saw came from the fixture rather than the mapper.
  //
  // Exactly the defect InviteRow already documents and fixed for
  // `invite.email`. Same remedy: the field is gone from the type, so no
  // future row can render it either.
  it('shows no address line under a name, because no endpoint supplies one', async () => {
    renderApp({}, <MembersSection />)
    const andrewRow = await screen.findByTestId('member-row-andrew')
    expect(within(andrewRow).getByText('Andrew')).toBeInTheDocument()
    // The blank line itself is the bug: an empty element still occupies its
    // row and reads as a field that failed to load.
    expect(andrewRow.querySelector('.member-email')).toBeNull()
    // Nothing in the row is an empty text slot waiting for data that will
    // never arrive.
    const blanks = [...andrewRow.querySelectorAll('div, span')]
      .filter(el => el.children.length === 0 && el.textContent === '')
    expect(blanks).toHaveLength(0)
  })

  // Second instance of the mapMember(email) shape, found by sweeping the
  // mappers for fields assigned a literal rather than read from the raw row.
  //
  // mapMember set `keyAlert: false` on every member -- RawMemberRow has no such
  // field, and /api/team/members is a bare RPC passthrough returning four
  // columns -- while MemberRow rendered a "key changed" warning chip gated on
  // it. So the chip could not fire for any member, ever.
  //
  // Worse than the blank email line: this is a SECURITY warning, and its
  // silence read as "these keys are fine". The daemon does track it per member
  // (state.keyAlerts is a list of { user_id }), it just never exposes the list
  // -- statusPayload sends only a COUNT. The count is what the app can honestly
  // show today, and it was reaching the UI's Status type and being rendered
  // nowhere at all.
  describe('key-substitution alerts', () => {
    const withAlerts = async (keyAlerts: number) => {
      const client = new FakeDataClient()
      const status = await client.getStatus()
      vi.spyOn(client, 'getStatus').mockResolvedValue({
        ...status,
        encryption: { ...status.encryption, keyAlerts },
      })
      return client
    }

    it('warns when the daemon is holding key alerts, naming how many', async () => {
      renderWith(await withAlerts(2), <MembersSection />)
      const warning = await screen.findByTestId('member-key-alerts')
      expect(warning).toHaveTextContent(/2/)
      // Says what to DO about it -- a warning nobody can act on is the same
      // dead end as one that never fires.
      expect(warning).toHaveTextContent(/verif/i)
    })

    it('says nothing when there are no alerts', async () => {
      renderApp({}, <MembersSection />)
      await screen.findByText('Sarah')
      expect(screen.queryByTestId('member-key-alerts')).toBeNull()
    })

    // The counterpart: no per-member chip, because nothing can populate one.
    // An always-absent chip is what made the whole feature invisible.
    it('shows no per-member key chip, which could never fire', async () => {
      renderWith(await withAlerts(2), <MembersSection />)
      await screen.findByTestId('member-key-alerts')
      expect(screen.queryByText(/key changed/i)).toBeNull()
    })
  })

  it('does not offer role changes on the owner row', async () => {
    renderApp({}, <MembersSection />)
    const ownerRow = await screen.findByTestId('member-row-me')
    expect(within(ownerRow).queryByRole('combobox')).toBeNull()
    expect(within(ownerRow).getByText('Owner')).toBeInTheDocument()
  })

  it('shows neither audit nor invites to a member role', async () => {
    renderApp({ role: 'member' }, <MembersSection />)
    await screen.findByText('Sarah')
    expect(screen.queryByText(/audit/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull()
  })

  // All three endpoints are owner/admin-only on the daemon (lib/api-access.js
  // 403s a member for the audit and the access matrix), so a member-role viewer
  // must not fire a single one of them -- including the access matrix the
  // removal warning reads, which is gated on the same canManage check that
  // decides whether a removal control is offered at all.
  it('never calls getAudit, getInvites or getAccessMatrix for a member role', async () => {
    const client = new FakeDataClient({ role: 'member' })
    const auditSpy = vi.spyOn(client, 'getAudit')
    const invitesSpy = vi.spyOn(client, 'getInvites')
    const matrixSpy = vi.spyOn(client, 'getAccessMatrix')
    renderWith(client, <MembersSection />)
    await screen.findByText('Sarah')
    expect(auditSpy).not.toHaveBeenCalled()
    expect(invitesSpy).not.toHaveBeenCalled()
    expect(matrixSpy).not.toHaveBeenCalled()
  })

  // "Transfer ownership" was a control that could not work. It called
  // setRole(memberId, 'owner'), and set_role (002_team_v2.sql) raises
  // `role must be admin or member` for any p_role outside that pair; no
  // transfer_ownership RPC exists anywhere in supabase/migrations/. So the
  // menu item opened a confirmation dialog whose only possible outcome was an
  // error message. The menu keeps Remove, which is real.
  //
  // The component moved from MembersPage to MembersSection while this was in
  // flight; the assertion is unchanged, only where it renders from.
  it('offers no "Transfer ownership" -- no RPC can perform it', async () => {
    renderApp({}, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Andrew/i }))
    expect(screen.queryByRole('menuitem', { name: /transfer ownership/i })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /remove from team/i })).toBeInTheDocument()
  })

  it('offers no control anywhere that would set a role of "owner"', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setMemberRole')
    renderWith(client, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /more actions for Andrew/i }))
    const roleSelect = screen.getByRole('combobox', { name: /role for andrew/i }) as HTMLSelectElement
    expect([...roleSelect.options].map(o => o.value)).not.toContain('owner')
    expect(spy.mock.calls.flat()).not.toContain('owner')
  })

  it('never shows a menu on the viewer\'s own row', async () => {
    renderApp({}, <MembersSection />)
    const ownerRow = await screen.findByTestId('member-row-me')
    expect(within(ownerRow).queryByRole('button', { name: /more actions/i })).toBeNull()
  })

  // The own-row guard used to compare a member's id against a hardcoded
  // two-letter placeholder -- a value the real daemon never sends (a real
  // user id looks like 'usr_9f2a'), so the guard silently never activated in
  // production and every member, including the viewer, got a "more
  // actions" menu on their own row. This drives the fixture with a
  // REALISTIC id AND role: 'admin' (so the viewer's own row isn't also
  // hidden by the separate "no menu on the owner row" rule, which would
  // mask the isSelf bug) to prove the guard now reads settings.viewerId
  // instead of that sentinel, for both the viewer's own row and a
  // teammate's row.
  it('suppresses the own-row menu using the real viewerId, not a hardcoded placeholder', async () => {
    const client = new FakeDataClient({ viewerId: 'usr_9f2a', role: 'admin' })
    renderWith(client, <MembersSection />)
    const ownRow = await screen.findByTestId('member-row-usr_9f2a')
    expect(within(ownRow).queryByRole('button', { name: /more actions/i })).toBeNull()

    const andrewRow = await screen.findByTestId('member-row-andrew')
    expect(within(andrewRow).getByRole('button', { name: /more actions for andrew/i })).toBeInTheDocument()
  })

  // The own-row guard was applied to the overflow menu and NOT to the role
  // select sitting one line above it, so an admin was still handed a select
  // on their own row -- the one control that can demote the viewer out of
  // the ability to use every other control on this page. The backend refuses
  // the write anyway (set_role is owner-only), which makes the offer worse,
  // not better: the admin picks "Member", nothing happens, and the only
  // feedback is an error banner explaining a rule the UI should not have
  // invited them to break. Same fixture as the menu test above -- a
  // REALISTIC viewerId plus role 'admin', so the viewer's own row is not
  // also hidden by the separate owner-row rule, which would mask the bug.
  it('never offers a role select on the viewer\'s own row', async () => {
    const client = new FakeDataClient({ viewerId: 'usr_9f2a', role: 'admin' })
    renderWith(client, <MembersSection />)
    const ownRow = await screen.findByTestId('member-row-usr_9f2a')
    expect(within(ownRow).queryByRole('combobox')).toBeNull()

    // A teammate's row must keep its select: the fix is "not on yourself",
    // not "admins can no longer change anyone's role".
    const andrewRow = await screen.findByTestId('member-row-andrew')
    expect(within(andrewRow).getByRole('combobox', { name: /role for andrew/i })).toBeInTheDocument()
  })


  // Fix 6: the audit query is ?limit=30 EVENTS -- "last 30 days" claimed a
  // time window nothing actually queries. The count now reflects the rows
  // actually on screen, which is the only number that stays true once "Show
  // more" exists.
  it('labels the audit list by event count, not a time window it never queries', async () => {
    renderApp({}, <MembersSection />)
    // Heading reads "Team activity", not the jargon "Audit"; still counts the
    // rows actually on screen (the only number that stays true once "Show
    // more" exists), never a time window nothing queries.
    expect(await screen.findByText('Team activity · last 4 events')).toBeInTheDocument()
    expect(screen.queryByText(/last 30 days/i)).toBeNull()
  })

  it('labels and legends the invite list so a bare token is not the first thing read', async () => {
    renderApp({}, <MembersSection />)
    expect(await screen.findByText(/outstanding invite links · token · uses · expiry/i)).toBeInTheDocument()
  })

  it('counts the People by membership, not with the misleading word "active"', async () => {
    renderApp({}, <MembersSection />)
    await screen.findByText('Sarah')
    const membersHeading = screen.getByRole('heading', { name: 'People' })
    const head = membersHeading.parentElement as HTMLElement
    // The count beside "People" is a plain member count; "active" implied an
    // inactive set the roster never shows.
    expect(within(head).getByText(/^\d+ members?$/)).toBeInTheDocument()
    expect(within(head).queryByText(/active/i)).toBeNull()
  })

  it('revokes a pending invite via a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'revokeInvite')
    renderWith(client, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke invite i1/i }))
    expect(spy).toHaveBeenCalledWith('i1')
  })

  it('changes a non-owner member\'s role through a real DataClient call', async () => {
    const client = new FakeDataClient()
    const spy = vi.spyOn(client, 'setMemberRole')
    renderWith(client, <MembersSection />)
    const sarahRow = await screen.findByTestId('member-row-sarah')
    await userEvent.selectOptions(within(sarahRow).getByRole('combobox', { name: /role for sarah/i }), 'admin')
    expect(spy).toHaveBeenCalledWith('sarah', 'admin')
  })

  // "Resend" is permanently omitted -- Task 17 confirmed no mail-delivery
  // path exists anywhere in this codebase or backend for team invites.
  it('never renders "Resend" -- no mail-delivery path exists to back it', async () => {
    renderApp({}, <MembersSection />)
    await screen.findByText('Sarah')
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })









  it('surfaces a failed role change instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setMemberRole').mockRejectedValue(new Error('role change rejected'))
    renderWith(client, <MembersSection />)
    const sarahRow = await screen.findByTestId('member-row-sarah')
    await userEvent.selectOptions(within(sarahRow).getByRole('combobox', { name: /role for sarah/i }), 'admin')
    expect(await screen.findByText(/role change rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed invite revoke instead of looking like nothing happened', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'revokeInvite').mockRejectedValue(new Error('revoke rejected'))
    renderWith(client, <MembersSection />)
    await userEvent.click(await screen.findByRole('button', { name: /revoke invite i1/i }))
    expect(await screen.findByText(/revoke rejected/i)).toBeInTheDocument()
  })
})

// T-72. Measured on a two-member team: the People heading read "0 members" from
// 750ms to 1974ms, and the audit heading "Team activity · last 0 events" from
// 750ms to 1708ms on a trail holding six. Both are counts derived from a
// `?? []` fallback and presented as measurements.
describe('Team counts while their data is still in flight', () => {
  const forever = () => new Promise<never>(() => {})

  it('does not report zero members before the roster arrives', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getMembers').mockReturnValue(forever())
    const { container } = renderWith(client, <MembersSection />)

    const count = container.querySelector('.team-members-count')
    expect(count).not.toBeNull()
    expect(count?.querySelector('.loading-block')).not.toBeNull()
    expect(count?.textContent).not.toMatch(/\d/)
    expect(screen.queryByText('0 members')).toBeNull()
  })

  it('holds the roster open with placeholder rows, not a bare Loading line', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getMembers').mockReturnValue(forever())
    renderWith(client, <MembersSection />)

    expect(await screen.findByTestId('members-loading')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('does not report an event count before the audit trail arrives', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'getAudit').mockReturnValue(forever())
    renderWith(client, <MembersSection />)

    // The clause is dropped, not zeroed: the shorter sentence is still true.
    expect(await screen.findByText('Team activity')).toBeInTheDocument()
    expect(screen.queryByText(/last 0 events/)).toBeNull()
  })

  it('reports the real member count once the roster arrives', async () => {
    renderWith(new FakeDataClient(), <MembersSection />)
    expect(await screen.findByText(/\d+ members?$/)).toBeInTheDocument()
  })
})
