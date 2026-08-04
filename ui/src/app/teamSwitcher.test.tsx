// The rail's team switcher. Before it, every team-scoped read in the app AND
// in the daemon took teams[0] unconditionally: someone on two teams saw one of
// them, with no hint the other existed, and every control on screen quietly
// acted on it.
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../test/renderApp'
import { FakeDataClient } from '../data/FakeDataClient'
import { Shell } from './Shell'
import { TeamPage } from '../features/team/TeamPage'

function onTeams(secondTeam: boolean) {
  return new FakeDataClient({ solo: false, authenticated: true, secondTeam })
}

describe('switching teams from the rail', () => {
  it('stays a plain label when there is only one team', async () => {
    renderWith(onTeams(false), <Shell><div /></Shell>)
    expect(await screen.findByText('MemBridge HQ')).toBeInTheDocument()
    // No control, because there is nothing to switch between -- a one-team
    // install must look exactly as it did.
    expect(screen.queryByRole('combobox', { name: /team/i })).toBeNull()
  })

  it('offers every team the viewer is on', async () => {
    renderWith(onTeams(true), <Shell><div /></Shell>)
    const picker = await screen.findByRole('combobox', { name: /team/i })
    expect(picker).toHaveValue('team-1')
    const names = Array.from(picker.querySelectorAll('option')).map(o => o.textContent)
    expect(names).toEqual(['MemBridge HQ', 'Weekend Side Project'])
  })

  it('tells the transport, so team-scoped reads follow the choice', async () => {
    const client = onTeams(true)
    const spy = vi.spyOn(client, 'selectTeam')
    renderWith(client, <Shell><div /></Shell>)
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: /team/i }), 'team-2')
    // The selection lives on the client because it has to ride on requests
    // the component tree never sees (the audit, invite and matrix GETs).
    expect(spy).toHaveBeenCalledWith('team-2')
    expect(client.selectedTeamId()).toBe('team-2')
  })

  it('actually re-renders the app against the new team', async () => {
    const client = onTeams(true)
    renderWith(client, <Shell><div /></Shell>)
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: /team/i }), 'team-2')
    // Not just "the control changed": the rail now reads the other team,
    // which only happens if the cached queries were invalidated and refetched.
    await waitFor(() => expect(screen.getByRole('combobox', { name: /team/i })).toHaveValue('team-2'))
    expect(await screen.findByText('Weekend Side Project')).toBeInTheDocument()
  })
})

describe('the Team page follows the same selection', () => {
  it('describes the selected team, not always the first', async () => {
    const client = onTeams(true)
    client.selectTeam('team-2')
    renderWith(client, <TeamPage />)
    expect(await screen.findByRole('heading', { name: /weekend side project/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /membridge hq/i })).toBeNull()
  })

  it('falls back to the first team when the stored selection is stale', async () => {
    const client = onTeams(true)
    // A team the viewer has since left, or one belonging to another account
    // signed in on this machine: it must not pin the app to nothing.
    client.selectTeam('team-that-no-longer-exists')
    renderWith(client, <TeamPage />)
    expect(await screen.findByRole('heading', { name: /membridge hq/i })).toBeInTheDocument()
  })
})
