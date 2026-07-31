import type { DataClient, Capabilities } from './DataClient'
import type {
  AccessMatrix, AssistsStats, AuditEvent, FeedEntry, FeedFilters, FeedPage, HooksVersionStatus, HookUpdateResult, Insights, Invite, LiveSession,
  McpRegisterResult, Member, Project, Role, Settings, SkeletonStats, Status, StreamEntry,
} from './types'

export interface FakeOptions {
  solo?: boolean
  role?: Role
  skeletonAvailable?: boolean
  empty?: boolean
  failWith?: string
  // Overrides the default team-mode fixture value. Lets a test exercise the
  // "never synced yet" case (Task 7 Finding 2) without also going solo,
  // which would hide the "last team sync" stat entirely.
  teamLastSync?: string | null
  // Overrides the id every fixture method uses for "the viewer" (default
  // 'me'). Task 18: a real daemon never hands back the literal string 'me'
  // -- tests that need to prove a guard reads the REAL viewerId, not a
  // hardcoded sentinel, pass a realistic id here (e.g. 'usr_9f2a').
  viewerId?: string
  // Simulates window.membridge's presence (the Electron bridge). Defaults to
  // true so most fixtures exercise the native-picker path; a test for the
  // plain-browser fallback passes filePickerAvailable: false.
  filePickerAvailable?: boolean
  // What pickPaths() resolves to when the picker is available. Defaults to
  // [] (the "user cancelled" case) so a test must opt in to a real
  // selection rather than getting one by accident.
  pickPathsResult?: string[]
  // Settings.webUrl override. Defaults to the real shipped lib/backend.json
  // value so a plain fixture exercises the actual "Copy invite link" path;
  // pass null to exercise the no-hosted-join-page degrade path (falls back
  // to sharing the standing invite code).
  webUrl?: string | null
  // Settings.hooksVersion override. Defaults to both 'current' (the quiet,
  // nothing-to-do case); pass 'outdated'/'unknown' to exercise the
  // Update-hooks control's other two chip states.
  hooksVersion?: HooksVersionStatus
  // updateHooks()'s result. Defaults to both hooks succeeding. Override
  // per-hook -- e.g. { stop: { ok: false, detail: '...' }, recall: { ok: true, detail: '...' } }
  // -- to exercise the UI's failure-surfacing path (a real per-hook failure,
  // not a request-level rejection, which failWith above already covers).
  hooksUpdateResult?: HookUpdateResult
}

export class FakeDataClient implements DataClient {
  readonly capabilities: Capabilities
  constructor(private opts: FakeOptions = {}) {
    // Transport support only — the viewer's role decides authorization.
    this.capabilities = {
      daemonControl: true,
      localPaths: true,
      teamAdminSupported: true,
      filePicker: opts.filePickerAvailable ?? true,
    }
  }
  private guard<T>(value: T): Promise<T> {
    if (this.opts.failWith) return Promise.reject(new Error(this.opts.failWith))
    return Promise.resolve(value)
  }
  // Every fixture that models "the viewer's own row" reads this instead of
  // hardcoding 'me' -- so a test that passes viewerId: 'usr_9f2a' proves
  // guards downstream key off the real DataClient value, not a sentinel
  // string that happens to match a hardcoded default (Task 18 finding).
  private get viewerId(): string {
    return this.opts.viewerId ?? 'me'
  }
  getStatus() {
    return this.guard<Status>({
      running: true, version: '0.1.7', solo: !!this.opts.solo, setupDone: true,
      projectCount: this.opts.empty ? 0 : 3, intervalSec: 60, lastSync: '2026-07-29T21:00:00Z',
      teamLastSync: this.opts.solo ? null : (this.opts.teamLastSync !== undefined ? this.opts.teamLastSync : '2026-07-29T21:00:00Z'),
      tools: ['Claude Code', 'Codex'],
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
        shared: !this.opts.solo, memberIds: this.opts.solo ? [this.viewerId] : [this.viewerId, 'andrew', 'sarah'],
        sessionsThisWeek: 31, dailyCounts: [3, 5, 2, 6, 4, 5, 6], // must sum to sessionsThisWeek (server.js dailySessionBuckets partition invariant)
        latestSummary: { text: 'Hook ownership now decided by durability, not who ran last', author: 'Andrew', at: '2026-07-29T19:00:00Z' },
        sync: { state: 'up-to-date' },
      },
      {
        path: '/Users/x/sublease', name: 'sublease', exists: true, paused: false,
        lastSync: '2026-07-23T10:00:00Z', lastActivity: '2026-07-29T08:00:00Z',
        sessionsTotal: 40, tools: ['Claude Code'],
        shared: false, memberIds: [this.viewerId],
        sessionsThisWeek: 4, dailyCounts: [1, 0, 1, 0, 1, 1, 0], // must sum to sessionsThisWeek (server.js dailySessionBuckets partition invariant)
        latestSummary: { text: 'Listing flow validates addresses before payment', author: 'You', at: '2026-07-23T10:00:00Z' },
        sync: { state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' },
      },
    ])
  }
  getLiveSessions() {
    return this.guard<LiveSession[]>(this.opts.empty ? [] : [
      { id: 's1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', projectName: 'membridge', startedAt: '2026-07-29T20:36:00Z', intent: 'make the summary hook fire on session boundaries, not only on stop' },
      { id: 's2', author: 'You', authorId: this.viewerId, tool: 'Claude Code', projectName: 'membridge', startedAt: '2026-07-29T21:00:00Z', intent: 'rebuild the apps interface from the ground up' },
    ])
  }
  getProjectStream() {
    return this.guard<StreamEntry[]>([
      { id: 'e1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T19:00:00Z', live: true, outcome: 'Hook ownership now decided by durability, not who ran last.', intent: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js'], session: 's-e1' },
    ])
  }
  // Feed fixture: 5 entries across 2 projects, 2 named authors + "you", 2
  // tools, spanning 2 UTC calendar days -- enough to exercise day-grouping,
  // every filter, and (via a caller-supplied `before`) backward paging
  // without a live daemon.
  private feedFixture(): FeedEntry[] {
    return [
      { id: 'f1', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-29T20:36:00Z', live: true, outcome: '', intent: 'make the summary hook fire on session boundaries, not only on stop', files: [], project: 'membridge', projectPath: '/Users/x/membridge', session: 's-f1' },
      { id: 'f2', author: 'You', authorId: this.viewerId, tool: 'Claude Code', at: '2026-07-29T19:00:00Z', live: false, outcome: 'Hook ownership now decided by durability, not who ran last.', intent: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js'], project: 'membridge', projectPath: '/Users/x/membridge', session: 's-f2' },
      { id: 'f3', author: 'Sarah', authorId: 'sarah', tool: 'Claude Code', at: '2026-07-29T10:00:00Z', live: false, outcome: 'Listing flow validates addresses before payment.', intent: 'validate the address before charging the card', files: ['lib/listing.js'], project: 'sublease', projectPath: '/Users/x/sublease', session: 's-f3' },
      { id: 'f4', author: 'Andrew', authorId: 'andrew', tool: 'Codex', at: '2026-07-28T22:00:00Z', live: false, outcome: 'Ports fixed and pushed.', intent: 'fix the port collision in the test suite', files: ['test/run-tests.js'], project: 'membridge', projectPath: '/Users/x/membridge', session: 's-f4' },
      { id: 'f5', author: 'You', authorId: this.viewerId, tool: 'Claude Code', at: '2026-07-28T18:00:00Z', live: false, outcome: 'Landing page deployed.', intent: null, files: [], project: 'sublease', projectPath: '/Users/x/sublease', session: 's-f5' },
    ]
  }
  getFeed(filters: FeedFilters, opts: { limit: number; before: string | null }) {
    if (this.opts.empty) return this.guard<FeedPage>({ entries: [], nextBefore: null })
    let entries = this.feedFixture()
      .filter(e => !filters.author || e.authorId === filters.author)
      .filter(e => !filters.project || e.projectPath === filters.project)
      .filter(e => !filters.source || e.tool === filters.source)
      .sort((a, b) => b.at.localeCompare(a.at))
    if (opts.before) entries = entries.filter(e => e.at <= opts.before!)
    const page = entries.slice(0, opts.limit)
    const nextBefore = entries.length > opts.limit ? page[page.length - 1].at : null
    return this.guard<FeedPage>({ entries: page, nextBefore })
  }
  syncProject() { return this.guard<void>(undefined) }
  syncAll() { return this.guard<void>(undefined) }
  setProjectPaused() { return this.guard<void>(undefined) }
  copyForAI() { return this.guard('digest text') }
  getProjectAccess() {
    return this.guard({
      members: [{ memberId: this.viewerId, canSee: true }, { memberId: 'andrew', canSee: true }, { memberId: 'sarah', canSee: false }],
      defaultAccess: true,
    })
  }
  setProjectAccess() { return this.guard<void>(undefined) }
  setProjectAccessDefault() { return this.guard<void>(undefined) }
  getAccessMatrix() {
    return this.guard<AccessMatrix>({
      members: [{ id: this.viewerId, name: 'Marco' }, { id: 'andrew', name: 'Andrew' }, { id: 'sarah', name: 'Sarah' }],
      rows: [
        { projectPath: '/Users/x/membridge', projectName: 'membridge', shared: true, access: { [this.viewerId]: true, andrew: true, sarah: true } },
        { projectPath: '/Users/x/sublease', projectName: 'sublease', shared: false, access: { [this.viewerId]: true, andrew: false, sarah: false } },
      ],
    })
  }
  // 'andrew' rounds this out to the 3 members getSettings().team.memberCount
  // already claims, and to the 3 memberIds the shared 'membridge' project
  // fixture lists above -- he was previously referenced by getLiveSessions(),
  // getProjectAccess(), and getAccessMatrix() but absent here, so anything
  // joining those against getMembers() (Task 9's AccessPanel) silently
  // dropped him.
  getMembers() {
    return this.guard<Member[]>([
      { id: this.viewerId, name: 'Marco', email: 'marco@melika.com', role: this.opts.role ?? 'owner', joinedAt: '2026-07-22T18:58:00Z', projectCount: 3, lastSharedAt: '2026-07-29T21:00:00Z', keyAlert: false },
      { id: 'andrew', name: 'Andrew', email: 'andrew@acme.dev', role: 'admin', joinedAt: '2026-07-20T09:00:00Z', projectCount: 3, lastSharedAt: '2026-07-29T19:00:00Z', keyAlert: false },
      { id: 'sarah', name: 'Sarah', email: 'sarah@acme.dev', role: 'member', joinedAt: '2026-07-27T16:31:00Z', projectCount: 1, lastSharedAt: null, keyAlert: false },
    ])
  }
  getInvites() { return this.guard<Invite[]>([{ id: 'i1', email: 'dana@acme.dev', expiresAt: '2026-08-04T00:00:00Z', role: 'member' }]) }
  inviteMember() { return this.guard<void>(undefined) }
  createInviteLink() { return this.guard<{ token: string }>({ token: 'tok_9f2aQ7' }) }
  revokeInvite() { return this.guard<void>(undefined) }
  setMemberRole() { return this.guard<void>(undefined) }
  removeMember() { return this.guard<void>(undefined) }
  getAudit() {
    return this.guard<AuditEvent[]>([
      { id: 'a1', at: '2026-07-29T14:02:00Z', actorName: 'Andrew', action: 'unshared', objectType: 'project', objectLabel: 'billing-poc', detail: null },
    ])
  }
  // Shared by getInsights() and getSkeletonStats() -- both read the same
  // underlying /api/savings ledger in the real daemon, so the fixture must
  // not drift into two different answers for the same skeletonAvailable flag.
  private skeletonStats(): SkeletonStats {
    return this.opts.skeletonAvailable === false
      ? { available: false }
      : { available: true, repeatOpens: 1204, answeredFirst: 818 }
  }
  // Same skeletonAvailable flag drives both -- in the real daemon, `assists`
  // and `skeleton` come off the same /api/savings totals, so a fixture that
  // could make one available and the other not would model a state the real
  // server never produces. recallServed matches skeleton's answeredFirst
  // (818) on purpose: both read the identical avoided.serves number.
  private assistsStats(): AssistsStats {
    return this.opts.skeletonAvailable === false
      ? { available: false }
      : { available: true, total: 876, byKind: { recallServed: 818, teammateNotes: 46, mcpQueries: 12 } }
  }
  getSkeletonStats() {
    return this.guard<SkeletonStats>(this.skeletonStats())
  }
  getInsights(window: 7 | 30 | 90) {
    return this.guard<Insights>({
      window,
      sessions: { count: 412, deltaPct: 18 },
      membersSyncing: { ok: 2, total: 3 },
      entriesShared: { count: 187, delta: 31 },
      skeleton: this.skeletonStats(),
      assists: this.assistsStats(),
      perPerson: [{ id: this.viewerId, name: 'Marco', sessions: 214, shared: 205 }],
      topProjects: [{ name: 'membridge', sessions: 184, people: 3 }],
      problems: [
        // Absence-phrased, matching lib/api-insights.js's silentTeammateProblems
        // exactly ("Nothing has arrived from X" / never a diagnosis of their
        // machine -- see Task 18 Part C). This machine cannot see why Sarah's
        // daemon has gone quiet, only that nothing has arrived from her.
        { id: 'p1', severity: 'broken', headline: 'Nothing has arrived from Sarah', scale: 'joined 3 days ago · 0 entries shared', action: { label: 'Send setup steps', kind: 'setup-steps' } },
        { id: 'p2', severity: 'minor', headline: '2 sessions missing summaries', scale: 'of 412 · both crashed mid-session', action: null },
      ],
      concentration: [{ projectName: 'billing-poc', onlyPerson: 'Andrew', detail: '41 sessions' }],
      byTool: [{ tool: 'Claude Code', sessions: 268 }],
    })
  }
  getSettings() {
    return this.guard<Settings>({
      delivery: [
        { id: 'context-block', label: 'Context block', description: 'A small skeleton written into CLAUDE.md, AGENTS.md, GEMINI.md', installed: true, enabled: null, detail: '' },
        {
          id: 'summaries', label: 'Session summaries',
          description: 'A Claude Code Stop-hook that distills each session into a summary as it ends.',
          installed: true, enabled: true, detail: '',
        },
        { id: 'recall', label: 'Recall', description: 'Surfaces a relevant past note the moment a matching file is opened.', installed: true, enabled: null, detail: 'Installed as a Claude Code hook.' },
        { id: 'mcp', label: 'MCP server', description: 'Lets any MCP-capable tool query team memory directly', installed: false, enabled: null, detail: '' },
      ],
      hooksVersion: this.opts.hooksVersion ?? { stop: 'current', recall: 'current' },
      privacy: {
        endToEnd: true, plaintextShared: false, redactionBuiltIn: 18, redactionCustom: 2, excludedPaths: 3,
        redactExtra: ['sk-custom-[a-z0-9]+', 'ACME_[A-Z]+_KEY'],
        exclude: ['node_modules', 'dist', '.git'],
        excludeStale: [],
      },
      daemon: { running: true, port: 7391, version: '0.1.7', startAtLogin: true, intervalSec: 300, updateAvailable: null },
      team: this.opts.solo ? null : { id: 'team-1', name: 'MemBridge HQ', role: this.opts.role ?? 'owner', memberCount: 3, inviteCode: 'INV-7F3K9Q' },
      viewerId: this.viewerId,
      webUrl: this.opts.webUrl !== undefined ? this.opts.webUrl : 'https://join.membridge.me',
      contextFiles: {
        targets: ['CLAUDE.md', 'AGENTS.md'],
        extraTargets: { gemini: false, cursor: false, windsurf: false, copilot: false },
        extraTargetFiles: {
          gemini: 'GEMINI.md', cursor: '.cursor/rules/membridge.mdc', windsurf: '.windsurfrules', copilot: '.github/copilot-instructions.md',
        },
      },
    })
  }
  setSetting() { return this.guard<void>(undefined) }
  registerMcp() {
    return this.guard<McpRegisterResult>({
      rows: [
        { agent: 'claude-code', status: 'registered', detail: null },
        { agent: 'codex', status: 'unchanged', detail: 'already registered' },
      ],
    })
  }
  updateHooks() {
    return this.guard<HookUpdateResult>(this.opts.hooksUpdateResult ?? {
      stop: { ok: true, detail: 'rewritten to the current version' },
      recall: { ok: true, detail: 'rewritten to the current version' },
    })
  }

  restartDaemon() { return this.guard<void>(undefined) }
  checkForUpdates() { return this.guard({ current: '0.1.7', latest: '0.1.7', updateAvailable: null }) }
  openConfigFile() { return this.guard<void>(undefined) }
  openMemoryFile() { return this.guard<void>(undefined) }
  leaveTeam() { return this.guard<void>(undefined) }
  addProject() { return this.guard<void>(undefined) }

  pickPaths() {
    if (!this.capabilities.filePicker) {
      return Promise.reject(new Error('pickPaths is unavailable: this window has no Electron bridge (window.membridge).'))
    }
    return this.guard<string[]>(this.opts.pickPathsResult ?? [])
  }
}
