// Fix 10: removing a member or changing their role alters what the access
// surfaces show -- ['accessMatrix'] (the projects grid's member columns) and
// ['projectAccess', *] (the project page's access panel) both list members.
// Invalidating only ['members'] left a removed member ghosting in those
// grids until an unrelated refetch happened to clear them.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from './DataClientProvider'
import { FakeDataClient } from './FakeDataClient'
import {
  useArchiveProject, useCheckForUpdates, useCreateInviteLink, useLeaveTeam, useRegisterMcp,
  useRemoveMember, useRevokeInvite, useSetMemberRole, useSetProjectAccess, useSetSetting,
  useUnarchiveProject, useUpdateHooks,
} from './queries'

function mountHook<T>(useHook: () => T, client: FakeDataClient = new FakeDataClient()): { qc: QueryClient; hook: () => T } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let current: T | undefined
  function Probe() {
    current = useHook()
    return null
  }
  render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>
        <Probe />
      </DataClientProvider>
    </QueryClientProvider>,
  )
  return { qc, hook: () => current as T }
}

afterEach(cleanup)

describe('member mutations invalidate every member-listing surface (Fix 10)', () => {
  it('useRemoveMember invalidates members, accessMatrix, and projectAccess', async () => {
    const { qc, hook } = mountHook(() => useRemoveMember())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('andrew')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['members'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['accessMatrix'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projectAccess'] })
  })

  it('useSetMemberRole invalidates members, accessMatrix, and projectAccess', async () => {
    const { qc, hook } = mountHook(() => useSetMemberRole())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync({ memberId: 'andrew', role: 'member' })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['members'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['accessMatrix'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projectAccess'] })
  })
})

// The audit trail is a list this UI reads back and caches, so every action
// that writes a team_audit row has to refresh it. Six actions do
// (access-granted, access-revoked, invite-created, invite-revoked,
// member-removed, role-changed) and NONE of them invalidated ['audit'] --
// so the trail sat stale until its staleTime lapsed or the page remounted,
// which reads as "the audit isn't updating". Each case below pins one writer.
describe('every audit-writing mutation refreshes the audit trail', () => {
  it('useRemoveMember invalidates audit (member-removed)', async () => {
    const { qc, hook } = mountHook(() => useRemoveMember())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('andrew')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['audit'] })
  })

  it('useSetMemberRole invalidates audit (role-changed)', async () => {
    const { qc, hook } = mountHook(() => useSetMemberRole())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync({ memberId: 'andrew', role: 'member' })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['audit'] })
  })

  it('useRevokeInvite invalidates audit (invite-revoked) as well as invites', async () => {
    const { qc, hook } = mountHook(() => useRevokeInvite())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('inv-1')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['invites'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['audit'] })
  })

  // This one carried a comment saying it had no cache to invalidate. True of
  // the link itself; false of the audit row the mint writes.
  it('useCreateInviteLink invalidates audit (invite-created)', async () => {
    const { qc, hook } = mountHook(() => useCreateInviteLink())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('team-1')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['audit'] })
  })

  it('useSetProjectAccess invalidates audit (access-granted / access-revoked)', async () => {
    const { qc, hook } = mountHook(() => useSetProjectAccess())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync({ projectPath: '/Users/x/membridge', memberId: 'andrew', canSee: false })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['audit'] })
  })
})

// Task 3 (projects tab scale and archive): archiving changes what the
// projects list shows, so both mutations must reach the client method and
// refresh the ['projects'] query.
describe('archive mutations', () => {
  it('useArchiveProject calls the client with the path and invalidates projects', async () => {
    const client = new FakeDataClient()
    const clientSpy = vi.spyOn(client, 'archiveProject')
    const { qc, hook } = mountHook(() => useArchiveProject(), client)
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('/Users/x/sublease')
    expect(clientSpy).toHaveBeenCalledWith('/Users/x/sublease')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('useUnarchiveProject calls the client with the path and invalidates projects', async () => {
    const client = new FakeDataClient()
    const clientSpy = vi.spyOn(client, 'unarchiveProject')
    const { qc, hook } = mountHook(() => useUnarchiveProject(), client)
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('/Users/x/sublease')
    expect(clientSpy).toHaveBeenCalledWith('/Users/x/sublease')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })
})

// A setting write moves daemon state, and daemon state is what GET /api/status
// reports -- not just GET /api/settings. The concrete failure: FirstRun's "Get
// started" writes setupCompletedAt, App.tsx gates the whole first-run takeover
// on status.setupDone (lib/server.js derives it from config.setup.completedAt),
// and invalidating only ['settings'] left ['status'] holding setupDone:false.
// The write succeeded, the screen did not move, and the button read as broken.
// Invalidating ['status'] on EVERY setting write rather than special-casing
// this one key is deliberate: any setting that moves daemon state has exactly
// this shape, and ['status'] is a small payload the app already polls, so the
// unconditional refetch costs one request the app was about to make anyway.
describe('useSetSetting refreshes daemon state, not only the settings payload', () => {
  it('invalidates both settings and status on every setting write', async () => {
    const client = new FakeDataClient()
    const clientSpy = vi.spyOn(client, 'setSetting')
    const { qc, hook } = mountHook(() => useSetSetting(), client)
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync({ key: 'setupCompletedAt', value: '2026-08-03T00:00:00.000Z' })
    expect(clientSpy).toHaveBeenCalledWith('setupCompletedAt', '2026-08-03T00:00:00.000Z')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['settings'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['status'] })
  })

  it('invalidates status for an ordinary setting key too, not just the setup key', async () => {
    const { qc, hook } = mountHook(() => useSetSetting())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync({ key: 'distill', value: { enabled: false } })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['status'] })
  })

  // useSetSetting was not the only site with this shape -- the same
  // settings-only invalidation was copied to every write on the Settings
  // page. Each of these writes moves daemon state that /api/status reports,
  // so each one could leave the rail or a gate reading a value the daemon has
  // already changed.
  it('every daemon-state write on the settings page refreshes status too', async () => {
    for (const [name, mount, run] of [
      ['useRegisterMcp', () => useRegisterMcp(), (h: { mutateAsync: (v?: unknown) => Promise<unknown> }) => h.mutateAsync()],
      ['useUpdateHooks', () => useUpdateHooks(), (h: { mutateAsync: (v?: unknown) => Promise<unknown> }) => h.mutateAsync()],
      ['useCheckForUpdates', () => useCheckForUpdates(), (h: { mutateAsync: (v?: unknown) => Promise<unknown> }) => h.mutateAsync()],
    ] as const) {
      const { qc, hook } = mountHook(mount as () => { mutateAsync: (v?: unknown) => Promise<unknown> })
      const spy = vi.spyOn(qc, 'invalidateQueries')
      await run(hook())
      expect(spy, `${name} did not invalidate settings`).toHaveBeenCalledWith({ queryKey: ['settings'] })
      expect(spy, `${name} did not invalidate status`).toHaveBeenCalledWith({ queryKey: ['status'] })
      cleanup()
    }
  })

  // The worst of the family, and the one nobody caught by reading. Leaving a
  // team flips status.solo, and Shell.tsx gates the entire Team nav group on
  // !solo (showTeamNav) and the "Create a team" CTA on solo && signedIn. With
  // only ['settings'] invalidated the rail kept offering Members and Insights
  // for a team the machine had just left, and withheld the create-team CTA,
  // until the next ['status'] poll -- which, with refetchIntervalInBackground
  // false, does not arrive at all while the window is unfocused. Team
  // membership moves all three caches, so this goes through accountRefresh
  // rather than a settings-and-status pair.
  it('useLeaveTeam refreshes teamAccount, settings and status, not settings alone', async () => {
    const { qc, hook } = mountHook(() => useLeaveTeam())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('team-1')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['settings'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['status'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['teamAccount'] })
  })
})
