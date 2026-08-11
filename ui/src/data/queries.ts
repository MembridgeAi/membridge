// react-query hooks, one per screen concern (spec §7). Live surfaces poll
// every 10s and pause while the tab is hidden -- refetchIntervalInBackground
// stays false so a hidden tab stops polling WITHOUT unmounting the tree or
// clearing its cached data (a previous implementation unmounted on
// document.hidden and blanked the dashboard mid screen-recording).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDataClient } from './DataClientProvider'
import type { AccessMatrix, DeleteProjectResult, FeedFilters, InviteOptions, Role, Settings } from './types'

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
    // No focus refetch (Fix 16), same reasoning as the deliberate no-poll
    // above: an infinite query refetches EVERY loaded page on window
    // refocus, so a reader three "Show more" clicks deep had all their
    // pages refired at once on alt-tab -- fighting their scroll position
    // exactly the way the 10s poll would have. staleTime alone can't stop
    // this (it only masks the first 15s); the feed refreshes via explicit
    // filter changes and the sync mutations' cache invalidation instead.
    refetchOnWindowFocus: false,
  })
}

// Search (GET /api/search). One page, no infinite scroll: a ranked list is
// answered by its top results or not at all, and paging a relevance ordering
// invites reading it as a feed.
//
// `enabled` on a non-empty query keeps the resting state honest -- an empty
// box must not fire a request, and must not render "no results" for a search
// nobody ran. Not live-polled, for the same reason the feed is not: results
// reshuffling under a reader mid-scan is worse than being seconds stale.
export const SEARCH_PAGE_SIZE = 25

export function useSearch(query: string, filters: FeedFilters) {
  const c = useDataClient()
  const trimmed = query.trim()
  return useQuery({
    queryKey: ['search', trimmed, filters],
    queryFn: () => c.search(trimmed, filters, SEARCH_PAGE_SIZE),
    enabled: trimmed.length > 0,
    staleTime: STANDARD_STALE_MS,
    refetchOnWindowFocus: false,
  })
}

// The session detail page (GET /api/session?id=). Not live-polled: the page
// is a read of one finished-or-running session's brief; a reader deep in the
// prompt chain must not have the list reshuffled under them every 10s.
// `data === null` is the real "not in memory anymore" state (the client
// resolves null on 404); a rejected fetch is the retryable error state.
export function useSession(sessionId: string | null) {
  const c = useDataClient()
  return useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => c.getSession(sessionId as string),
    enabled: !!sessionId,
    staleTime: STANDARD_STALE_MS,
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

// Deliberately NOT live-polled. getSettings() fans out to /api/settings,
// /api/status and /api/team, so a refetchInterval here would triple this
// page's request volume forever to solve a problem a button solves: the
// Settings page owns an explicit Recheck control plus a "checked <when>"
// stamp, so a stale reading is visible and fixable rather than silently
// believed. Anything on the page that genuinely changes on its own -- the
// daemon being up -- is read from the polled ['status'] query instead.
export function useSettings() {
  const c = useDataClient()
  return useQuery({ queryKey: ['settings'], queryFn: () => c.getSettings(), staleTime: STANDARD_STALE_MS })
}

// The Team page's state source (GET /api/team). Separate from useSettings()
// because `authenticated` is the fact Settings cannot carry: Settings.team is
// null both when signed out and when signed in with no team, and the app used
// to render those two identically.
export function useTeamAccount() {
  const c = useDataClient()
  return useQuery({ queryKey: ['teamAccount'], queryFn: () => c.getTeamAccount(), staleTime: STANDARD_STALE_MS })
}

/**
 * "Should this surface speak team-language at all?" Every affirmative team
 * surface -- SHARED/PRIVATE tags, "N shared" counts, team-sync chips, team
 * encryption -- is HIDDEN when this returns true, because on a solo install
 * those assertions are drawn from noise: a stray `.membridge/team.json` in the
 * working directory (someone else's clone, an old worktree, a repo cloned from
 * a team member's fork) marks the project as team-linked on the daemon side,
 * and every downstream screen then renders team language a user with no team
 * has no context for. The one commit's-worth-of-gating half of T-78 is this
 * hook plus its call sites.
 *
 * The rule is exactly what T-78 named: `status.solo === true` OR the account
 * is not authenticated. Deliberately NOT distinguishing "genuinely solo" from
 * "team member with no rows yet" -- both should see solo language for a stray
 * team-labelled project. This is DIFFERENT from Shell.tsx's `onTeam`
 * (settings.team !== null): that answers "does this identity own a team",
 * which is the right gate for showing team NAV but the wrong one for
 * suppressing team CLAIMS about a stray-linked project, since a real owner
 * whose linked projects all happen to sit outside a multi-member team still
 * reports `solo: true` and should still not see "1 shared" quoted about a
 * project that just happens to carry a foreign team.json.
 *
 * Loading defaults to `true` (solo view). The failure mode this ticket exists
 * to fix is TEAM language rendered without evidence; defaulting to solo means
 * a flash-of-noise is empty rather than accusatory. Every consumer's real
 * team data still lands on its own; this only decides whether the frame
 * around it commits to team-ness before that data arrives.
 */
export function useSoloView(): boolean {
  const status = useStatus()
  const account = useTeamAccount()
  const solo = status.data?.solo ?? true
  const authenticated = account.data?.authenticated === true
  return solo || !authenticated
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

// Archive/unarchive change what the projects list shows (the row moves into
// or out of the Archived section), so both refresh ['projects']. Not
// optimistic: the daemon can refuse (404 untracked, 500 failed strip), and
// the row must fall back to its server state with the inline error rather
// than pretend the archive landed.
export function useArchiveProject() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectPath: string) => c.archiveProject(projectPath),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
}

export function useUnarchiveProject() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectPath: string) => c.unarchiveProject(projectPath),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['projects'] }) },
  })
}

// Did the daemon actually delete anything? POST /api/team/archive-project
// answers 200 on a REFUSAL as well as on a success (lib/server.js
// archiveSharedProject: a plain member deleting a shared project gets
// { archived: false, unlinked, message } after their local team link and
// durable teammate archive have already been pruned, with the project itself
// left intact). Returns the refusal reason, or null when the delete really
// happened. Success is asserted positively -- an unrecognized body is treated
// as "not confirmed" rather than assumed to have worked.
export interface DeleteRefusal {
  /** What to show the user. The daemon's own sentence when it sent one -- it
   *  knows which of the three causes applied and already words each of them
   *  actionably; only the fallbacks below are ours. */
  message: string
  /** Whether trying the identical delete again could succeed. Read straight off
   *  the daemon's `retryable`, never re-derived from `refusal` here: the daemon
   *  owns the indeterminate set, so a determinate refusal it adds later is
   *  correctly non-retryable for this client without this client being changed.
   *  An older daemon sends neither field, which lands on false -- the behaviour
   *  this code had before the discriminator existed. */
  retryable: boolean
}

export function deleteRefusalOf(result: DeleteProjectResult): DeleteRefusal | null {
  if (result.deleted === true || result.archived === true) return null
  const retryable = result.retryable === true
  if (result.message) return { message: result.message, retryable }
  if (result.archived === false) return { message: 'The daemon did not delete this project.', retryable }
  // Fail closed. Every branch the daemon ships today sets one of the fields
  // above, so this is unreachable now, but a body we do not recognize must
  // never be read as a completed destruction: a future fourth branch would
  // otherwise close the dialog and report success for work that never ran.
  return { message: 'The daemon did not confirm this delete.', retryable }
}

/**
 * A refusal, carried through react-query's error channel.
 *
 * A refusal has to REJECT (see useDeleteProject below) so that no success path
 * can run for a destruction that never happened -- but a plain `new
 * Error(message)` threw away the one bit the screen needs, so the dialog drew
 * an outage and a genuine "you are not a manager" identically: same weight,
 * same finality, no retry affordance for the case that is entirely retryable.
 * The distinction is NOT recoverable by matching on the sentence, and a copy
 * edit that tried would change behaviour silently.
 */
export class DeleteRefusedError extends Error {
  readonly retryable: boolean
  constructor(refusal: DeleteRefusal) {
    super(refusal.message)
    this.name = 'DeleteRefusedError'
    this.retryable = refusal.retryable
  }
}

/** True only for a refusal the DAEMON marked retryable. A transport failure
 *  (the request itself threw) is deliberately excluded: it is a different
 *  error type, nothing is known about what the daemon did or did not do, and
 *  inviting a retry on an unknown local outcome is not the same promise as
 *  "nothing on this machine was changed". */
export function isRetryableDeleteRefusal(error: unknown): boolean {
  return error instanceof DeleteRefusedError && error.retryable
}

// Destructive single-project delete (Task 6). Refreshes the projects list
// and the feed: the daemon drops the project's state, so both surfaces
// change. Never optimistic -- a shared project's delete can legitimately be
// refused by the role gate, and the row must stay until the daemon confirms.
//
// A refusal is turned into a REJECTION here, so every consumer's success path
// (the cache invalidations below, and the caller's own onSuccess that closes
// the confirmation dialog) is structurally unreachable unless the destruction
// actually happened. This is the fix for a refusal being reported to the user
// as a completed delete.
export function useDeleteProject() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (projectPath: string) => {
      const result = await c.deleteProject(projectPath)
      const refusal = deleteRefusalOf(result)
      if (refusal) throw new DeleteRefusedError(refusal)
      return result
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['feed'] })
    },
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
    // Settled, not success: an access change writes access-granted /
    // access-revoked server-side, and on the error path the optimistic
    // rollback above can still be racing a row that DID get written.
    onSettled: () => { qc.invalidateQueries({ queryKey: ['audit'] }) },
  })
}

// Both member mutations also invalidate ['accessMatrix'] and
// ['projectAccess'] (prefix-matched, so every per-project key refreshes):
// those caches list members too, and invalidating only ['members'] left a
// removed member ghosting in the projects grid's access columns and the
// project page's access panel until an unrelated refetch cleared them.
export function useSetMemberRole() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { memberId: string; role: Role }) => c.setMemberRole(vars.memberId, vars.role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members'] })
      qc.invalidateQueries({ queryKey: ['accessMatrix'] })
      qc.invalidateQueries({ queryKey: ['projectAccess'] })
      qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

export function useRemoveMember() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (memberId: string) => c.removeMember(memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members'] })
      qc.invalidateQueries({ queryKey: ['accessMatrix'] })
      qc.invalidateQueries({ queryKey: ['projectAccess'] })
      qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

// Mints a fresh onboarding-invite token for a team (DataClient.createInviteLink,
// POST /api/team/invite). The minted link itself is used-and-copied on the
// spot and appears in no list this UI reads back -- but the mint DOES write
// an `invite-created` row (lib/server.js:2455), and the audit trail is a list
// this UI reads back. It went stale on every mint until this landed.
export function useCreateInviteLink() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { teamId: string } & InviteOptions) =>
      c.createInviteLink(v.teamId, { expiresDays: v.expiresDays, maxUses: v.maxUses }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['audit'] }) },
  })
}

// ---------------------------------------------------------------------------
// Account mutations (Team page). All four change what /api/team, /api/status
// and /api/settings answer, so each refreshes the same three caches -- the
// rail's team switcher, the solo CTA and every role gate read from them, and
// a stale read there is exactly what makes a sign-out invisible.
//
// CREDENTIALS: `password` travels from the submit handler through
// mutationFn into DataClient and no further. It is never placed in a query
// key (which react-query keeps in its cache), never retried, and never part
// of any resolved value.
// ---------------------------------------------------------------------------
function accountRefresh(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['teamAccount'] })
  qc.invalidateQueries({ queryKey: ['settings'] })
  qc.invalidateQueries({ queryKey: ['status'] })
}

export function useSignIn() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) => c.signIn(credentials),
    onSuccess: () => accountRefresh(qc),
  })
}

export function useSignUp() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (credentials: { displayName: string; email: string; password: string }) => c.signUp(credentials),
    // Refreshed on success even for needsConfirmation, where nothing changed
    // server-side: a sign-up that DID issue a session (confirmation off) must
    // not leave the rail still reading signed-out.
    onSuccess: () => accountRefresh(qc),
  })
}

export function useSignOut() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.signOut(),
    onSuccess: () => accountRefresh(qc),
  })
}

// Joining changes the same things creating does -- membership, the rail's
// team nav, the solo flag -- so it refreshes the same set.
export function useJoinTeam() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (codeOrLink: string) => c.joinTeam(codeOrLink),
    onSuccess: () => {
      accountRefresh(qc)
      qc.invalidateQueries({ queryKey: ['members'] })
    },
  })
}

export function useRenameTeam() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ teamId, name }: { teamId: string; name: string }) => c.renameTeam(teamId, name),
    onSuccess: () => accountRefresh(qc),
  })
}

// Rotating also revokes every outstanding invite LINK (the rotate_invite RPC
// does both in one statement), so the invite list is stale the moment this
// resolves -- not just the code on the settings/team reads.
export function useRotateInviteCode() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (teamId: string) => c.rotateInviteCode(teamId),
    onSuccess: () => {
      accountRefresh(qc)
      qc.invalidateQueries({ queryKey: ['invites'] })
    },
  })
}

export function useCreateTeam() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => c.createTeam(name),
    onSuccess: () => {
      accountRefresh(qc)
      qc.invalidateQueries({ queryKey: ['members'] })
    },
  })
}

export function useRevokeInvite() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (inviteId: string) => c.revokeInvite(inviteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invites'] })
      qc.invalidateQueries({ queryKey: ['audit'] })
    },
  })
}

// A write from the Settings page moves DAEMON state, and daemon state is
// reported by GET /api/status as well as GET /api/settings. Every one of
// these mutations invalidated ['settings'] alone, which left ['status']
// serving a value the daemon had already changed.
//
// The failure that surfaced it: "Get started" writes setupCompletedAt, the
// daemon stores it at config.setup.completedAt, and lib/server.js derives
// status.setupDone from it -- but App.tsx gates the entire first-run
// takeover on status.setupDone. The write landed, ['status'] was never
// refetched, the screen did not move, and the button read as broken.
//
// This is the settings-page analogue of accountRefresh above, and it is
// applied to EVERY write on the page rather than to the one key known to be
// broken. Any setting that moves daemon state has exactly this shape, so
// keying the refresh off a list of known-bad keys would only leave the next
// one to be found the same way. ['status'] is a small payload the app
// already polls on an interval, so the unconditional invalidation costs one
// request the app was about to make on its own moments later.
function settingsRefresh(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: ['settings'] })
  qc.invalidateQueries({ queryKey: ['status'] })
}

// The optimistic half of useSetSetting, for the keys whose control on the
// Settings page is a LIVE switch or select rather than a dialog. Returns null
// for anything else, which means "no cache patch" -- every other setting on
// that page is edited in a dialog that stays open with its own pending state
// until the write resolves, so it already shows in-flight honestly and a
// speculative patch would only add a way to be wrong.
//
// Why this exists: a switch that does not move until the write returns and the
// query refetches reads as "it didn't take", so users flip it again, which
// queues a second write and lands them on the opposite value from the one they
// wanted. Same shape of fix as useSetProjectAccess above, and the same
// obligation: rollback on failure, and the rollback has to be VISIBLE (the
// Settings rows name the failed action inline) -- a switch that silently snaps
// back is worse than one that lags.
function isEnabledFlag(value: unknown): value is { enabled: boolean } {
  return typeof value === 'object' && value !== null && typeof (value as { enabled?: unknown }).enabled === 'boolean'
}

function isSharePromptsPatch(value: unknown): value is { sharePrompts: 'off' | 'distilled' | 'verbatim' } {
  if (typeof value !== 'object' || value === null) return false
  const v = (value as { sharePrompts?: unknown }).sharePrompts
  return v === 'off' || v === 'distilled' || v === 'verbatim'
}

function optimisticSettings(prev: Settings, key: string, value: unknown): Settings | null {
  if (key === 'startAtLogin' && typeof value === 'boolean') {
    return { ...prev, daemon: { ...prev.daemon, startAtLogin: value } }
  }
  if (key === 'intervalSec' && typeof value === 'number') {
    return { ...prev, daemon: { ...prev.daemon, intervalSec: value } }
  }
  if (key === 'distill' && isEnabledFlag(value)) {
    const enabled = value.enabled
    return { ...prev, delivery: prev.delivery.map(c => c.id === 'summaries' ? { ...c, enabled } : c) }
  }
  // Share-prompts write: setSetting('team', { sharePrompts: '...' }). Only
  // patches when a real team is present (SharePromptsControl is not rendered
  // on solo -- if a payload without team.sharePrompts ever slipped through
  // we would rather do no patch than fabricate one).
  if (key === 'team' && isSharePromptsPatch(value) && prev.team) {
    return { ...prev, team: { ...prev.team, sharePrompts: value.sharePrompts } }
  }
  return null
}

export function useSetSetting() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { key: string; value: unknown }) => c.setSetting(vars.key, vars.value),
    onMutate: async (vars): Promise<{ previous?: Settings }> => {
      const previous = qc.getQueryData<Settings>(['settings'])
      if (!previous) return {}
      const next = optimisticSettings(previous, vars.key, vars.value)
      if (!next) return {}
      // Only cancelled once there is really a patch to apply -- cancelling an
      // in-flight settings refetch for a key we are not going to touch would
      // discard a good answer for nothing.
      await qc.cancelQueries({ queryKey: ['settings'] })
      qc.setQueryData<Settings>(['settings'], next)
      return { previous }
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(['settings'], context.previous)
    },
    onSuccess: () => settingsRefresh(qc),
  })
}

// Re-register (Task: always-available MCP re-registration, not gated on
// the channel's current reported install state). settingsRefresh so the
// "installed"/"not registered" chip reflects whatever registerNow() just
// found, same as every other write on this page.
export function useRegisterMcp() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.registerMcp(),
    onSuccess: () => settingsRefresh(qc),
  })
}

// Force-update the Stop and recall hooks to the current build (POST
// /api/hooks/update), always available regardless of the reported
// hooksVersion state -- same "not gated" shape as useRegisterMcp above.
// settingsRefresh so the vintage chips reflect what forceUpdateHooks() just
// found, on success or on a per-hook failure alike.
export function useUpdateHooks() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.updateHooks(),
    onSuccess: () => settingsRefresh(qc),
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
// A restart moves every value on the Settings page (port, version, uptime,
// hook vintages) AND status.running, and this mutation used to invalidate
// nothing at all -- so pressing Restart left the whole page, Status chip
// included, serving the pre-restart snapshot indefinitely.
//
// The invalidation is NOT the confirmation, and callers must not treat it as
// one. lib/server.js's /api/daemon/restart writes { ok: true, restarting: true }
// to the socket BEFORE the replacement process is spawned, and only logs a
// throw from the spawn -- so this mutation resolving proves the request was
// accepted, never that a restart happened. The only observable proof is the
// daemon answering a later request; DaemonGroup therefore holds "restarting…"
// until a fresh ['status'] answer lands (that query polls, so the confirmation
// arrives even if the invalidated refetch below lands inside the down window
// and fails).
export function useRestartDaemon() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.restartDaemon(),
    onSuccess: () => settingsRefresh(qc),
  })
}

export function useCheckForUpdates() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => c.checkForUpdates(),
    onSuccess: () => settingsRefresh(qc),
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

// Leaving a team changes ALL THREE account caches, so it takes accountRefresh
// rather than the settings-page pair: it is a membership change, exactly like
// the sign-in/sign-out mutations that helper was written for.
//
// This was the worst of the settings-only invalidations. Leaving flips
// status.solo, and Shell.tsx gates the entire Team nav group on !solo
// (showTeamNav) and the "Create a team" CTA on solo && signedIn. With
// ['status'] left stale the rail went on offering Members and Insights for a
// team this machine had just left, and went on withholding the create-team
// CTA, until the next status poll -- and since the live queries do not
// refetch in the background, "the next poll" is not guaranteed to arrive at
// all while the window is unfocused. That is the state immediately after a
// destructive action, which is the worst possible moment for the rail to
// describe a team the user no longer belongs to.
export function useLeaveTeam() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (teamId: string) => c.leaveTeam(teamId),
    onSuccess: () => accountRefresh(qc),
  })
}

// The deletion preview. `enabled` is load-bearing: this is a backend RPC round
// trip, and it should fire when the confirmation dialog opens rather than
// sitting in the background of a Settings page nobody is deleting from.
//
// staleTime/gcTime 0 so every open re-reads. A stale count is tolerable almost
// everywhere else in this product and intolerable here: it is the number a
// person reads before agreeing to destroy something, and other machines push
// to the same account between opens.
export function useMyData(enabled: boolean) {
  const c = useDataClient()
  return useQuery({
    queryKey: ['myData'],
    queryFn: () => c.getMyData(),
    enabled,
    staleTime: 0,
    gcTime: 0,
  })
}

// Irreversible. Invalidates everything on success rather than patching
// individual caches: entries this user wrote surface in the feed, in search,
// in project counts and in insights, and any one of those still rendering
// removed rows would read as "it didn't work" -- the single impression this
// action must never give.
export function useDeleteMyData() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (projectId?: string | null) => c.deleteMyData(projectId ?? null),
    onSuccess: () => { void qc.invalidateQueries() },
  })
}

// Discovery for the add-project dialog (GET /api/scan). `enabled` is the
// whole point: scanPayload re-reads every session file on this machine from
// byte 0, so this must fire when the dialog opens and never on its own.
// staleTime 0 + gcTime 0 means each open re-scans rather than showing what
// the machine looked like the last time the dialog was opened, which for a
// list of "folders you have worked in lately" is the difference between a
// live answer and a stale one.
export function useDiscoveredProjects(enabled: boolean) {
  const c = useDataClient()
  return useQuery({
    queryKey: ['discover'],
    queryFn: () => c.discoverProjects(),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}

export function useAdoptProjects() {
  const c = useDataClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (paths: string[]) => c.adoptProjects(paths),
    // Both lists move: the grid gains rows, and the discovery list must drop
    // what is now tracked if the dialog stays open (Browse adds without
    // closing it).
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['discover'] })
    },
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
