// Finding 1 (getAccessMatrix) shipped because FakeDataClient always answers
// every DataClient method, so no test ever drove a REAL LocalDaemonClient
// method call end to end -- a client method that still rejects with the
// "missing endpoint" stub message, for an endpoint that has actually shipped
// server-side, is invisible to every test that only exercises the fake.
//
// This file is that missing check. It calls every DataClient method against
// a real LocalDaemonClient (with fetch stubbed to a generic response) and
// fails if the call rejects with the stub sentinel -- the one signal that a
// method was simply never wired to its daemon endpoint, as opposed to
// failing for some other, fixture-shape-related reason (which is expected
// and fine: this test never asserts success, only that the method actually
// attempted a request instead of short-circuiting).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataClient } from './DataClient'
import { LocalDaemonClient } from './LocalDaemonClient'

type DataClientMethod = Exclude<keyof DataClient, 'capabilities'>
type Invoker = (client: DataClient) => Promise<unknown>

// Every DataClient method with no live daemon endpoint today, and why.
// Keeping this list explicit (rather than deriving it) means adding a new
// DataClient method forces a conscious choice here, via the Record below
// failing to type-check until it's accounted for.
const LEGITIMATELY_UNBACKED = new Set<DataClientMethod>([
  // The team selection is local state on the transport, read back into the
  // query string of the team-scoped GETs. There is no endpoint to attempt and
  // nothing for this test's "did it try a real request" check to observe.
  'selectTeam',
  'selectedTeamId',
  // pickPaths never has a daemon endpoint to attempt -- it is routed through
  // the Electron IPC bridge (window.membridge, set by app/preload.js), not
  // fetch, because the daemon is a separate process with no GUI to show a
  // dialog from. There is nothing here for this test's "did it try a real
  // request" check to observe.
  'pickPaths',
])

// One call per DataClient method, argument values chosen only to satisfy the
// signature -- this test never asserts on a successful result, so their
// content doesn't matter.
const CALLS: Record<DataClientMethod, Invoker> = {
  getStatus: c => c.getStatus(),
  getProjects: c => c.getProjects(),
  getLiveSessions: c => c.getLiveSessions(),
  getProjectStream: c => c.getProjectStream('/x'),
  getFeed: c => c.getFeed({ author: null, project: null, source: null }, { limit: 10, before: null }),
  getSession: c => c.getSession('s1'),
  search: c => c.search('vault rotation', { author: null, project: null, source: null }, 25),
  syncProject: c => c.syncProject('/x'),
  syncAll: c => c.syncAll(),
  setProjectPaused: c => c.setProjectPaused('/x', true),
  archiveProject: c => c.archiveProject('/x'),
  unarchiveProject: c => c.unarchiveProject('/x'),
  deleteProject: c => c.deleteProject('/x'),
  copyForAI: c => c.copyForAI('/x'),
  getProjectAccess: c => c.getProjectAccess('/x'),
  setProjectAccess: c => c.setProjectAccess('/x', 'm1', true),
  getAccessMatrix: c => c.getAccessMatrix(),
  getMembers: c => c.getMembers(),
  // Account state and the four account writes (Team page). The password here
  // is a fixture literal for a stubbed fetch -- it reaches no network.
  getTeamAccount: c => c.getTeamAccount(),
  signIn: c => c.signIn({ email: 'a@b.dev', password: 'fixture-only' }),
  signUp: c => c.signUp({ displayName: 'A', email: 'a@b.dev', password: 'fixture-only' }),
  signOut: c => c.signOut(),
  createTeam: c => c.createTeam('Acme AI'),
  joinTeam: c => c.joinTeam('tok_fixture'),
  // Synchronous, local, and deliberately request-free -- exempted below.
  selectTeam: async c => { c.selectTeam(null) },
  selectedTeamId: async c => { c.selectedTeamId() },
  renameTeam: c => c.renameTeam('team-1', 'Acme AI'),
  rotateInviteCode: c => c.rotateInviteCode('team-1'),
  getInvites: c => c.getInvites(),
  createInviteLink: c => c.createInviteLink('team-1'),
  revokeInvite: c => c.revokeInvite('i1'),
  setMemberRole: c => c.setMemberRole('m1', 'member'),
  removeMember: c => c.removeMember('m1'),
  getAudit: c => c.getAudit(),
  getInsights: c => c.getInsights(30),
  getSkeletonStats: c => c.getSkeletonStats(),
  getSettings: c => c.getSettings(),
  setSetting: c => c.setSetting('k', 'v'),
  registerMcp: c => c.registerMcp(),
  updateHooks: c => c.updateHooks(),
  setProjectAccessDefault: c => c.setProjectAccessDefault('/x', true),
  restartDaemon: c => c.restartDaemon(),
  checkForUpdates: c => c.checkForUpdates(),
  openConfigFile: c => c.openConfigFile(),
  openMemoryFile: c => c.openMemoryFile('/x'),
  leaveTeam: c => c.leaveTeam('team-1'),
  discoverProjects: c => c.discoverProjects(),
  adoptProjects: c => c.adoptProjects(['/x']),
  pickPaths: c => c.pickPaths({ kind: 'file' }),
}

const MISSING_ENDPOINT_SENTINEL = /has no daemon endpoint yet/

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
}

describe('LocalDaemonClient contract: methods not explicitly exempted must attempt a real request', () => {
  beforeEach(stubFetch)
  afterEach(() => vi.unstubAllGlobals())

  const wired = (Object.keys(CALLS) as DataClientMethod[]).filter(name => !LEGITIMATELY_UNBACKED.has(name))

  it.each(wired)('%s does not reject with the "missing endpoint" sentinel', async (name) => {
    const client = new LocalDaemonClient()
    try {
      await CALLS[name](client)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toMatch(MISSING_ENDPOINT_SENTINEL)
    }
  })

  // /api/session's payload contract (session detail page, Task 1/3): the
  // client must hit the endpoint with the id in the query string, keep an
  // unshared team prompt's ask as null (never a fabricated placeholder
  // string), and resolve null -- not throw -- for an unknown/evicted id.
  it('getSession maps the /api/session shape, keeping prompts: null for an unshared ask', async () => {
    const payload = {
      session: 'team-sess-9', project: 'shop-app', projectPath: '/x/shop-app',
      author: 'Marco', authorId: null, source: 'Claude Code',
      startedAt: '2026-07-21T09:00:00.000Z', endedAt: '2026-07-21T09:10:00.000Z', live: false,
      summary: 'Fixed the login flow.', summaryFull: 'Fixed the login flow.',
      goal: 'fix login', headline: 'Login fixed', decisions: 'went with cookie sessions', gotchas: null,
      files: ['src/login.js'], changes: [{ file: 'src/login.js', status: 'edited', add: 4, del: 1, note: null, dep: false }],
      checkpoints: [{ ts: '2026-07-21T09:05:00.000Z', text: 'halfway there' }],
      prompts: [
        { ts: '2026-07-21T09:10:00.000Z', ask: 'polish the error copy', files: [] },
        { ts: '2026-07-21T09:00:00.000Z', ask: null, files: ['src/login.js'] },
        { ts: '2026-07-21T08:50:00.000Z', ask: null, files: [], undecryptable: true },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => payload })
    vi.stubGlobal('fetch', fetchMock)
    const s = await new LocalDaemonClient().getSession('team-sess-9')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/session?id=team-sess-9')
    expect(s).not.toBeNull()
    expect(s!.session).toBe('team-sess-9')
    expect(s!.summaryFull).toBe('Fixed the login flow.')
    expect(s!.prompts).toHaveLength(3)
    expect(s!.prompts[0].ask).toBe('polish the error copy')
    expect(s!.prompts[1].ask).toBeNull()
    // The fail-closed E2E marker must survive the mapping -- the page renders
    // an encrypted state for it, never "(prompt not shared)".
    expect(s!.prompts[1].undecryptable).toBeUndefined()
    expect(s!.prompts[2].ask).toBeNull()
    expect(s!.prompts[2].undecryptable).toBe(true)
    expect(s!.checkpoints).toEqual([{ ts: '2026-07-21T09:05:00.000Z', text: 'halfway there' }])
    expect(s!.changes[0]).toEqual({ file: 'src/login.js', status: 'edited', add: 4, del: 1, note: null, dep: false })
  })

  it('getSession resolves null on 404 (unknown or evicted id), never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'unknown session' }) }))
    await expect(new LocalDaemonClient().getSession('no-such-session')).resolves.toBeNull()
  })

  // The exemption list itself is the thing that let Finding 1 hide -- pin it
  // down so a future "oh, just add it to the exemption list" edit has to
  // touch a line that says, in as many words, that this is not one of them.
  // getInsights joined this pin after the same shape of bug: it kept its
  // "Task 12" stub message after GET /api/team/insights actually shipped
  // (98546a1), and no test caught it because FakeDataClient always answers.
  it('does not exempt getAccessMatrix, getAudit, or getInsights -- all three endpoints already exist', () => {
    expect(LEGITIMATELY_UNBACKED.has('getAccessMatrix')).toBe(false)
    expect(LEGITIMATELY_UNBACKED.has('getAudit')).toBe(false)
    expect(LEGITIMATELY_UNBACKED.has('getInsights')).toBe(false)
  })
})
