// react-query hooks, one per screen concern (spec §7). Live surfaces poll
// every 10s and pause while the tab is hidden -- refetchIntervalInBackground
// stays false so a hidden tab stops polling WITHOUT unmounting the tree or
// clearing its cached data (a previous implementation unmounted on
// document.hidden and blanked the dashboard mid screen-recording).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDataClient } from './DataClientProvider'
import type { AccessMatrix, Role } from './types'

const LIVE = { refetchInterval: 10_000, refetchIntervalInBackground: false } as const

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export function useStatus() {
  const c = useDataClient()
  return useQuery({ queryKey: ['status'], queryFn: () => c.getStatus(), ...LIVE })
}

export function useProjects() {
  const c = useDataClient()
  return useQuery({ queryKey: ['projects'], queryFn: () => c.getProjects(), staleTime: 15_000 })
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

export function useAccessMatrix() {
  const c = useDataClient()
  return useQuery({ queryKey: ['accessMatrix'], queryFn: () => c.getAccessMatrix() })
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
  })
}

export function useMembers() {
  const c = useDataClient()
  return useQuery({ queryKey: ['members'], queryFn: () => c.getMembers() })
}

export function useInvites() {
  const c = useDataClient()
  return useQuery({ queryKey: ['invites'], queryFn: () => c.getInvites() })
}

export function useAudit(limit?: number) {
  const c = useDataClient()
  return useQuery({ queryKey: ['audit', limit], queryFn: () => c.getAudit(limit) })
}

export function useInsights(window: 7 | 30 | 90) {
  const c = useDataClient()
  return useQuery({ queryKey: ['insights', window], queryFn: () => c.getInsights(window) })
}

export function useSkeletonStats() {
  const c = useDataClient()
  return useQuery({ queryKey: ['skeletonStats'], queryFn: () => c.getSkeletonStats() })
}

export function useSettings() {
  const c = useDataClient()
  return useQuery({ queryKey: ['settings'], queryFn: () => c.getSettings() })
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
type SetAccessVars = { projectPath: string; memberId: string; canSee: boolean }
type SetAccessContext = { previousAccess?: ProjectAccessRow[]; previousMatrix?: AccessMatrix }

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

      const previousAccess = qc.getQueryData<ProjectAccessRow[]>(accessKey)
      if (previousAccess) {
        qc.setQueryData<ProjectAccessRow[]>(accessKey, previousAccess.map(row =>
          row.memberId === vars.memberId ? { ...row, canSee: vars.canSee } : row))
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
