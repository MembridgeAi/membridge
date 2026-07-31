// react-query hooks, one per screen concern (spec §7). Live surfaces poll
// every 10s and pause while the tab is hidden -- refetchIntervalInBackground
// stays false so a hidden tab stops polling WITHOUT unmounting the tree or
// clearing its cached data (a previous implementation unmounted on
// document.hidden and blanked the dashboard mid screen-recording).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDataClient } from './DataClientProvider'
import type { AccessMatrix, FeedFilters, Role } from './types'

const LIVE = { refetchInterval: 10_000, refetchIntervalInBackground: false } as const

// The Feed screen's page size. Not "live" (no poll) -- an infinite list
// re-fetching its first page every 10s would fight the reader's scroll
// position and reshuffle "Show more" state underneath them.
export const FEED_PAGE_SIZE = 30

// Cache tuning (spec §7: tab switch < 100ms, no spinner for cached data).
// Everything below is data that does not change on its own between explicit
// user actions -- members, settings, audit rows, access grants. Without a
// staleTime these default to 0, so simply switching tabs away and back
// (unmount + remount, since each screen only renders while its route is
// active) re-fetched every one of them on every single visit, even a second
// after the first fetch. STANDARD_STALE_MS matches the value useProjects()
// already used before this pass -- reused here rather than inventing a
// second number, so "how fresh is fresh enough" has one answer across the
// non-live queries. Cached data still renders INSTANTLY on remount either
// way; this only decides whether react-query also fires a silent background
// refetch behind it.
const STANDARD_STALE_MS = 15_000

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export function useStatus() {
  const c = useDataClient()
  return useQuery({ queryKey: ['status'], queryFn: () => c.getStatus(), ...LIVE })
}

export function useProjects() {
  const c = useDataClient()
  return useQuery({ queryKey: ['projects'], queryFn: () => c.getProjects(), staleTime: STANDARD_STALE_MS })
}

export function useLiveSessions() {
  const c = useDataClient()
  return useQuery({ queryKey: ['live'], queryFn: () => c.getLiveSessions(), ...LIVE })
}

export function useProjectStream(projectPath: string | null) {
  const c = useDataClient()
  return useQuery({
    queryKey: ['stream', projectPath],
    queryFn: () => c.getProjectStream(projectPath as string),
    enabled: !!projectPath,
    ...LIVE,
  })
}

// The Feed screen: cross-project, filtered, paged backwards by `before`.
// `filters` is part of the queryKey, so changing a filter starts a FRESH
// infinite query (page one, server-filtered) rather than re-slicing
// whatever pages happened to already be cached under the old filter --
// paging stays correct because there's never a mix of pages fetched under
// two different filters in the same list.
export function useFeed(filters: FeedFilters) {
  const c = useDataClient()
  return useInfiniteQuery({
    queryKey: ['feed', filters],
    queryFn: ({ pageParam }) => c.getFeed(filters, { limit: FEED_PAGE_SIZE, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.nextBefore,
  })
}

// GET /api/team/access-matrix is owner/admin-only -- 403 for a member (Task
// 8). `enabled` defaults true for existing/simple callers, but the projects
// grid (Task 10) must pass false for a member role so this never fires a
// request the daemon is going to refuse.
export function useAccessMatrix(enabled: boolean = true) {
  const c = useDataClient()
  return useQuery({ queryKey: ['accessMatrix'], queryFn: () => c.getAccessMatrix(), enabled, staleTime: STANDARD_STALE_MS })
}

// Per-project visibility flags (who on the team can see THIS project), for
// the project page's access panel. Not live -- access changes are rare and
// this screen's own mutation (below) keeps the cache in sync optimistically,
// so a poll would only add noise. `enabled: false` for a null path covers
// both "project not loaded yet" and "project is private" (Task 9: reading
// this for an unshared project 404s on the real daemon -- see api-access.js
// readAccess's requireLink -- so callers pass null until project.shared).
export function useProjectAccess(projectPath: string | null) {
  const c = useDataClient()
  return useQuery({
    queryKey: ['projectAccess', projectPath],
    queryFn: () => c.getProjectAccess(projectPath as string),
    enabled: !!projectPath,
    staleTime: STANDARD_STALE_MS,
  })
}

// `enabled` defaults true for existing/simple callers (same convention as
// useAccessMatrix above). Feed passes `!solo`: getMembers() already returns
// [] on a solo machine (no team to list), but there is no reason to fire the
// /api/team + /api/team/members round trip at all when the Feed screen's
// person filter is going to be absent regardless.
export function useMembers(enabled: boolean = true) {
  const c = useDataClient()
  return useQuery({ queryKey: ['members'], queryFn: () => c.getMembers(), enabled, staleTime: STANDARD_STALE_MS })
}

export function useInvites() {
  const c = useDataClient()
  return useQuery({ queryKey: ['invites'], queryFn: () => c.getInvites(), staleTime: STANDARD_STALE_MS })
}

export function useAudit(limit?: number) {
  const c = useDataClient()
  return useQuery({ queryKey: ['audit', limit], queryFn: () => c.getAudit(limit), staleTime: STANDARD_STALE_MS })
}

export function useInsights(window: 7 | 30 | 90) {
  const c = useDataClient()
  return useQuery({ queryKey: ['insights', window], queryFn: () => c.getInsights(window), staleTime: STANDARD_STALE_MS })
}

export function useSkeletonStats() {
  const c = useDataClient()
  return useQuery({ queryKey: ['skeletonStats'], queryFn: () => c.getSkeletonStats(), staleTime: STANDARD_STALE_MS })
}

export function useSettings() {
  const c = useDataClient()
  return useQuery({ queryKey: ['settings'], queryFn: () => c.getSettings(), staleTime: STANDARD_STALE_MS })
}

// ---------------------------------------------------------------------------
// Mutations. Every mutation invalidates the queries its change affects.
// ---------------------------------------------------------------------------
export function useSyncProject() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectPath: string) => c.syncProject(projectPath),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
}

export function useSyncAll() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.syncAll(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['status'] })
    },
  })
}

type ProjectAccessRow = { memberId: string; canSee: boolean }
type ProjectAccessData = { members: ProjectAccessRow[]; defaultAccess: boolean }
type SetAccessVars = { projectPath: string; memberId: string; canSee: boolean }
type SetAccessContext = { previousAccess?: ProjectAccessData; previousMatrix?: AccessMatrix }

// Optimistic: a toggle click must read back as flipped immediately (Task 9's
// "toggling a member calls setProjectAccess" test), and the daemon has no
// push channel to tell us the write landed. Updates both caches this screen
// and the projects grid (Task 10) read, matching the values we just sent --
// not re-fetched, since we already know the exact shape a successful write
// produces. Rolls back on failure; does not invalidate/refetch on success,
// so a concurrent teammate change is picked up on the next natural refetch
// rather than clobbering this optimistic write with a stale response.
export function useSetProjectPaused() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { projectPath: string; paused: boolean }) => c.setProjectPaused(vars.projectPath, vars.paused),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
}

// No cache to invalidate -- copying a digest to the clipboard changes
// nothing server-side. Callers read `.data` for the copied text (e.g. to
// confirm what landed on the clipboard) and `.isPending` for button state.
export function useCopyForAI() {
  const c = useDataClient()
  return useMutation({ mutationFn: (projectPath: string) => c.copyForAI(projectPath) })
}

export function useSetProjectAccess() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: SetAccessVars) => c.setProjectAccess(vars.projectPath, vars.memberId, vars.canSee),
    onMutate: async (vars: SetAccessVars): Promise<SetAccessContext> => {
      const accessKey = ['projectAccess', vars.projectPath]
      await qc.cancelQueries({ queryKey: accessKey })
      await qc.cancelQueries({ queryKey: ['accessMatrix'] })

      const previousAccess = qc.getQueryData<ProjectAccessData>(accessKey)
      if (previousAccess) {
        qc.setQueryData<ProjectAccessData>(accessKey, {
          ...previousAccess,
          members: previousAccess.members.map(row => row.memberId === vars.memberId ? { ...row, canSee: vars.canSee } : row),
        })
      }

      const previousMatrix = qc.getQueryData<AccessMatrix>(['accessMatrix'])
      if (previousMatrix) {
        qc.setQueryData<AccessMatrix>(['accessMatrix'], {
          ...previousMatrix,
          rows: previousMatrix.rows.map(row =>
            row.projectPath === vars.projectPath
              ? { ...row, access: { ...row.access, [vars.memberId]: vars.canSee } }
              : row),
        })
      }

      return { previousAccess, previousMatrix }
    },
    onError: (_err, vars, context) => {
      if (context?.previousAccess) qc.setQueryData(['projectAccess', vars.projectPath], context.previousAccess)
      if (context?.previousMatrix) qc.setQueryData(['accessMatrix'], context.previousMatrix)
    },
  })
}

export function useSetMemberRole() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { memberId: string; role: Role }) => c.setMemberRole(vars.memberId, vars.role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members'] }) },
  })
}

export function useRemoveMember() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (memberId: string) => c.removeMember(memberId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members'] }) },
  })
}

export function useInviteMember() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { email: string; role: Role }) => c.inviteMember(vars.email, vars.role),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invites'] }) },
  })
}

// Mints a fresh onboarding-invite token for a team (DataClient.createInviteLink,
// POST /api/team/invite). No cache to invalidate: unlike useInviteMember (which
// feeds the pending-invites list), a minted link is used-and-copied on the
// spot, not tracked in any list this UI reads back.
export function useCreateInviteLink() {
  const c = useDataClient()
  return useMutation({
    mutationFn: (teamId: string) => c.createInviteLink(teamId),
  })
}

export function useRevokeInvite() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (inviteId: string) => c.revokeInvite(inviteId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invites'] }) },
  })
}

export function useSetSetting() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { key: string; value: unknown }) => c.setSetting(vars.key, vars.value),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
}

// Re-register (Task: always-available MCP re-registration, not gated on
// the channel's current reported install state). Invalidates settings so
// the "installed"/"not registered" chip reflects whatever registerNow()
// just found, same as every other write on this page.
export function useRegisterMcp() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.registerMcp(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
}

// Force-update the Stop and recall hooks to the current build (POST
// /api/hooks/update), always available regardless of the reported
// hooksVersion state -- same "not gated" shape as useRegisterMcp above.
// Invalidates settings so the vintage chips reflect what forceUpdateHooks()
// just found, on success or on a per-hook failure alike.
export function useUpdateHooks() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.updateHooks(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
}

export function useSetProjectAccessDefault() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { projectPath: string; defaultAccess: boolean }) => c.setProjectAccessDefault(vars.projectPath, vars.defaultAccess),
    onSuccess: (_data, vars) => { qc.invalidateQueries({ queryKey: ['projectAccess', vars.projectPath] }) },
  })
}

// ---------------------------------------------------------------------------
// Task 17/18: daemon- and machine-level controls with no query cache of
// their own to keep in sync (restart/open/leave), or that only need to
// refresh `settings` once the write lands (checkForUpdates writes the
// on-disk cache GET /api/settings reads).
// ---------------------------------------------------------------------------
export function useRestartDaemon() {
  const c = useDataClient()
  return useMutation({ mutationFn: () => c.restartDaemon() })
}

export function useCheckForUpdates() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.checkForUpdates(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
}

export function useOpenConfigFile() {
  const c = useDataClient()
  return useMutation({ mutationFn: () => c.openConfigFile() })
}

export function useOpenMemoryFile() {
  const c = useDataClient()
  return useMutation({ mutationFn: (projectPath: string) => c.openMemoryFile(projectPath) })
}

export function useLeaveTeam() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (teamId: string) => c.leaveTeam(teamId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }) },
  })
}

export function useAddProject() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => c.addProject(path),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
}

// Native Finder/Explorer picker (the Electron bridge). No query cache to
// invalidate here -- callers merge the returned paths into whatever local
// form state they're editing themselves, same as typing them by hand would.
// Callers must check capabilities.filePicker before invoking this; there is
// no fallback path inside the client.
export function usePickPaths() {
  const c = useDataClient()
  return useMutation({
    mutationFn: (options: { kind: 'file' | 'folder'; multiple?: boolean }) => c.pickPaths(options),
  })
}
