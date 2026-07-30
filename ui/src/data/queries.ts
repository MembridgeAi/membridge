// react-query hooks, one per screen concern (spec §7). Live surfaces poll
// every 10s and pause while the tab is hidden -- refetchIntervalInBackground
// stays false so a hidden tab stops polling WITHOUT unmounting the tree or
// clearing its cached data (a previous implementation unmounted on
// document.hidden and blanked the dashboard mid screen-recording).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDataClient } from './DataClientProvider'
import type { Role } from './types'

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

export function useSetProjectAccess() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { projectPath: string; memberId: string; canSee: boolean }) =>
      c.setProjectAccess(vars.projectPath, vars.memberId, vars.canSee),
    onSuccess: (_result, vars) => {
      qc.invalidateQueries({ queryKey: ['accessMatrix'] })
      qc.invalidateQueries({ queryKey: ['projectAccess', vars.projectPath] })
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
