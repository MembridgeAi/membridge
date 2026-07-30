import type { DataClient, Capabilities } from './DataClient'
import type { AccessMatrix, AuditEvent, Insights, Invite, LiveSession, Member, Project, Role, Settings, Status, StreamEntry } from './types'

export interface FakeOptions {
  solo?: boolean
  role?: Role
  skeletonAvailable?: boolean
  empty?: boolean
  failWith?: string
}

export class FakeDataClient implements DataClient {
  readonly capabilities: Capabilities
  constructor(private opts: FakeOptions = {}) {
    this.capabilities = {
      daemonControl: true,
      localPaths: true,
      teamAdmin: !opts.solo && opts.role !== 'member',
    }
  }
  private guard<T>(value: T): Promise<T> {
    if (this.opts.failWith) return Promise.reject(new Error(this.opts.failWith))
    return Promise.resolve(value)
  }
  getStatus() {
    return this.guard<Status>({
      running: true, version: '0.1.7', solo: !!this.opts.solo, setupDone: true,
      projectCount: this.opts.empty ? 0 : 3, lastSync: '2026-07-29T21:00:00Z',
      teamLastSync: this.opts.solo ? null : '2026-07-29T21:00:00Z', tools: ['Claude Code', 'Codex'],
      encryption: { enabled: true, plaintextOff: true, paused: null, keyAlerts: 0 },
      auth: { paused: null, detail: null, since: null },
    })
  }
  getProjects() {
    if (this.opts.empty) return this.guard<Project[]>([])
    return this.guard<Project[]>([
      {
        path: '/Users/x/membridge', name: 'membridge', exists: true, paused: false,
        lastSync: '2026-07-29T19:00:00Z', lastActivity: '2026-07-29T19:00:00Z',
        sessionsTotal: 184, tools: ['Claude Code', 'Codex'],
        shared: !this.opts.solo, memberIds: this.opts.solo ? ['me'] : ['me', 'andrew', 'sarah'],
        sessionsThisWeek: 31, dailyCounts: [5, 8, 4, 10, 7, 12, 13],
        latestSummary: { text: 'Hook ownership now decided by durability, not who ran last', author: 'Andrew', at: '2026-07-29T19:00:00Z' },
        sync: { state: 'up-to-date' },
      },
      {
        path: '/Users/x/sublease', name: 'sublease', exists: true, paused: false,
        lastSync: '2026-07-23T10:00:00Z', lastActivity: '2026-07-29T08:00:00Z',
        sessionsTotal: 40, tools: ['Claude Code'],
        shared: false, memberIds: ['me'],
        sessionsThisWeek: 4, dailyCounts: [2, 2, 4, 2, 2, 3, 2],
        latestSummary: { text: 'Listing flow validates addresses before payment', author: 'You', at: '2026-07-23T10:00:00Z' },
        sync: { state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' },
      },
    ])
  }
  getLiveSessions() {
    return this.guard<LiveSession[]>(this.opts.empty ? [] : [
      { id: 's1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', projectName: 'membridge', startedAt: '2026-07-29T20:36:00Z', intent: 'make the summary hook fire on session boundaries, not only on stop' },
      { id: 's2', author: 'You', authorId: 'me', tool: 'Claude Code', projectName: 'membridge', startedAt: '2026-07-29T21:00:00Z', intent: 'rebuild the apps interface from the ground up' },
    ])
  }
  getProjectStream() {
    return this.guard<StreamEntry[]>([
      { id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T19:00:00Z', live: true, outcome: 'Hook ownership now decided by durability, not who ran last.', intent: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js'] },
    ])
  }
  syncProject() { return this.guard<void>(undefined) }
  syncAll() { return this.guard<void>(undefined) }
  setProjectPaused() { return this.guard<void>(undefined) }
  copyForAI() { return this.guard('digest text') }
  getProjectAccess() {
    return this.guard([{ memberId: 'me', canSee: true }, { memberId: 'andrew', canSee: true }, { memberId: 'sarah', canSee: false }])
  }
  setProjectAccess() { return this.guard<void>(undefined) }
  getAccessMatrix() {
    return this.guard<AccessMatrix>({
      members: [{ id: 'me', name: 'Marco' }, { id: 'andrew', name: 'Andrew' }, { id: 'sarah', name: 'Sarah' }],
      rows: [
        { projectPath: '/Users/x/membridge', projectName: 'membridge', shared: true, access: { me: true, andrew: true, sarah: true } },
        { projectPath: '/Users/x/sublease', projectName: 'sublease', shared: false, access: { me: true, andrew: false, sarah: false } },
      ],
    })
  }
  getMembers() {
    return this.guard<Member[]>([
      { id: 'me', name: 'Marco', email: 'marco@melika.com', role: 'owner', projectCount: 3, sync: { state: 'up-to-date' }, keyVerified: true, syncDetail: null },
      { id: 'sarah', name: 'Sarah', email: 'sarah@acme.dev', role: 'member', projectCount: 1, sync: { state: 'paused' }, keyVerified: true, syncDetail: 'token expired' },
    ])
  }
  getInvites() { return this.guard<Invite[]>([{ id: 'i1', email: 'dana@acme.dev', expiresAt: '2026-08-04T00:00:00Z', role: 'member' }]) }
  inviteMember() { return this.guard<void>(undefined) }
  revokeInvite() { return this.guard<void>(undefined) }
  setMemberRole() { return this.guard<void>(undefined) }
  removeMember() { return this.guard<void>(undefined) }
  getAudit() {
    return this.guard<AuditEvent[]>([
      { id: 'a1', at: '2026-07-29T14:02:00Z', actorName: 'Andrew', action: 'unshared', objectType: 'project', objectLabel: 'billing-poc', detail: null },
    ])
  }
  getInsights(window: 7 | 30 | 90) {
    return this.guard<Insights>({
      window,
      sessions: { count: 412, deltaPct: 18 },
      membersSyncing: { ok: 2, total: 3 },
      entriesShared: { count: 187, delta: 31 },
      skeleton: this.opts.skeletonAvailable === false ? { available: false } : { available: true, repeatOpens: 1204, answeredFirst: 818 },
      perPerson: [{ id: 'me', name: 'Marco', sessions: 214, shared: 205 }],
      topProjects: [{ name: 'membridge', sessions: 184, people: 3 }],
      problems: [
        { id: 'p1', severity: 'broken', headline: "Sarah's summaries never arrive", scale: '47 of 47 sessions · hook not installed since she joined', action: { label: 'Send setup steps', kind: 'setup-steps' } },
        { id: 'p2', severity: 'minor', headline: '2 sessions missing summaries', scale: 'of 412 · both crashed mid-session', action: null },
      ],
      concentration: [{ projectName: 'billing-poc', onlyPerson: 'Andrew', detail: '41 sessions' }],
      byTool: [{ tool: 'Claude Code', sessions: 268 }],
    })
  }
  getSettings() {
    return this.guard<Settings>({
      delivery: [
        { id: 'context-block', label: 'Context block', description: 'A small skeleton written into CLAUDE.md, AGENTS.md, GEMINI.md', installed: true, enabled: null },
        { id: 'mcp', label: 'MCP server', description: 'Lets any MCP-capable tool query team memory directly', installed: false, enabled: null },
      ],
      privacy: { endToEnd: true, plaintextShared: false, redactionBuiltIn: 18, redactionCustom: 2, excludedPaths: 3 },
      daemon: { running: true, port: 7391, version: '0.1.7', startAtLogin: true, intervalSec: 300, updateAvailable: null },
      team: this.opts.solo ? null : { name: 'MemBridge HQ', role: this.opts.role ?? 'owner', memberCount: 3 },
    })
  }
  setSetting() { return this.guard<void>(undefined) }
}
