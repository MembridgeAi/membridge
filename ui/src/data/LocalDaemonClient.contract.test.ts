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
  // POST /api/team/invite only mints a generic, role-less link and cannot
  // list issued invites -- no endpoint accepts email/role, and none lists
  // pending invites. Structurally blocked, not merely unwired.
  'getInvites',
  'inviteMember',
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
  syncProject: c => c.syncProject('/x'),
  syncAll: c => c.syncAll(),
  setProjectPaused: c => c.setProjectPaused('/x', true),
  copyForAI: c => c.copyForAI('/x'),
  getProjectAccess: c => c.getProjectAccess('/x'),
  setProjectAccess: c => c.setProjectAccess('/x', 'm1', true),
  getAccessMatrix: c => c.getAccessMatrix(),
  getMembers: c => c.getMembers(),
  getInvites: c => c.getInvites(),
  inviteMember: c => c.inviteMember('a@b.com', 'member'),
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
  addProject: c => c.addProject('/x'),
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
