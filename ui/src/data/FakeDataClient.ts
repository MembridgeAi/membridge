import type { DataClient, Capabilities } from './DataClient'
// The real mapper, deliberately imported by the FAKE client. A fixture that
// hands back domain objects it authored itself can never fail the way the app
// fails -- see teamMembers() below and fixtureBoundary.test.ts.
import {
  mapFeedEntry, mapLiveSession, mapMember, mapProjectRow, mapSession, mapStreamEntry,
  type MemberActivity, type RawFeedEntry, type RawMemberRow, type RawProjectRow, type RawSessionPayload,
} from './mappers'

import type {
  AccessMatrix, AdoptResult, AssistsStats, AuditEvent, DaemonHealth, DeleteMyDataResult, DeleteProjectResult, DiscoveredProject, FeedEntry, FeedFilters, FeedPage, HooksVersionStatus, HookUpdateResult, Insights,
  Invite, InviteOptions, LiveSession, McpRegisterResult, Member, MyData, Project, Role, SearchPage, Session, SessionPrompt, Settings, SharePromptsMode, SignOutResult, SignUpResult, SkeletonStats, Status, StreamEntry,
  TeamAccount,
} from './types'

/** A wire feed row with everything optional defaulted, so a fixture states only
 *  the fields it is actually about. Feed rows are what mapProjectRow derives
 *  `latestSummary` and `recentAuthorIds` from, so authoring them raw is how the
 *  project fixture gets those two fields from the real mapper instead of
 *  asserting them into existence. */
/** What a fixture states about one wire row: the project it belongs to, plus
 *  whatever else that row is actually about. Everything else is defaulted. */
type RawEntrySpec = Partial<RawFeedEntry> & Pick<RawFeedEntry, 'project' | 'projectPath'>

function rawFeedEntry(over: Partial<RawFeedEntry> & Pick<RawFeedEntry, 'project' | 'projectPath'>): RawFeedEntry {
  return {
    ts: '2026-07-28T10:00:00Z',
    author: 'Someone',
    // Null by default, and that is the REALISTIC default, not a shortcut:
    // measured against the live daemon, authorId is null on every row (see
    // RawFeedEntry.self in mappers.ts). A fixture where every row has an id
    // would make recentAuthorIds look more reliable than it is.
    authorId: null,
    source: 'Claude Code',
    session: null,
    projectId: null,
    ask: '',
    summary: null,
    distilled: false,
    files: [],
    goal: null,
    headline: null,
    live: false,
    ...over,
  }
}

export interface FakeOptions {
  /** Models an older daemon whose team row carries no member_count, so
   *  TeamSummary.memberCount is null. That state was UNREACHABLE from this
   *  fixture (it typed the field `number`), which is why nothing caught the
   *  null branch of memberCountLabel -- "unknown" and "empty" are different
   *  facts and only one of them may be printed. */
  memberCountUnknown?: boolean
  /** Models a sign-out whose BACKEND revocation failed, carrying the daemon's
   *  wording. Null/absent = the backend confirmed the session was ended. */
  signOutRevokeError?: string | null
  solo?: boolean
  role?: Role
  // The daemon's sync-loop health (Status.health). Omitted => the healthy 'ok'
  // fixture. Pass an object to drive 'erroring'/'stalled'/'unknown'. Pass NULL
  // to model a daemon older than the field, which sends `running` alone -- the
  // one case a client must not render as 'unknown', since the ignorance is the
  // client's, not the daemon's.
  health?: DaemonHealth | null
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
  // updateHooks()'s result. Defaults to every hook succeeding. Override
  // per-hook -- e.g. { stop: { ok: false, detail: '...' }, recall: { ok: true, detail: '...' } }
  // -- to exercise the UI's failure-surfacing path (a real per-hook failure,
  // not a request-level rejection, which failWith above already covers).
  hooksUpdateResult?: HookUpdateResult
  // Scales the team fixture (members, access matrix, settings memberCount)
  // to N members -- the constant-width Access cell must prove the table's
  // column count is IDENTICAL at 3 and 30 members, and the popover's search
  // appears only above 8. The shared project's roster stays a strict subset
  // (6 of N) so the "+N chip and count label" case is real, not "whole team".
  teamSize?: number
  // Whether this machine has credentials at all (GET /api/team's
  // `authenticated`). Defaults true, because every fixture that predates the
  // Team page models a signed-in machine; pass false for the signed-out
  // state, which is a DIFFERENT state from solo (no team) and used to be
  // indistinguishable from it in the UI.
  authenticated?: boolean
  // Puts the viewer on a SECOND team. Reachable (nothing stops a second
  // join) and only partly served by an app that reads teams[0] everywhere,
  // so the state has to be testable.
  secondTeam?: boolean
  // discoverProjects()'s result (the add-project dialog's scan). Defaults to
  // a mixed fixture (one already-watched row plus two untracked ones); pass
  // [] for the "nothing new on this machine" empty state.
  discovered?: DiscoveredProject[]
  // Adds two archived rows to getProjects(): one whose folder exists and one
  // whose folder is gone (missing) -- the Archived section's two render
  // states. Opt-in so fixtures that predate archiving are untouched.
  withArchived?: boolean
  // Settings.team.sharePrompts override. Defaults to 'off' (the daemon's own
  // silent default -- teamsync's `=== true` check treats anything else as
  // off), so a plain fixture models a fresh install that has not touched
  // the setting. Only meaningful in team mode; ignored on solo.
  sharePrompts?: SharePromptsMode
}

// A 60-prompt session's chain, newest-first (one prompt a minute counting
// back from the base) -- exercises the 5-then-25 paging without a live
// daemon or a hand-written 60-row literal.
/**
 * A faithful port of lib/activity.js's `matchesAuthor`, which is what the real
 * /api/search actually applies. The previous inline filter here was
 * `e.authorId === filters.author`: exact id equality, and no notion of the
 * leading '!' the "Hide mine" control sends. That modelled neither half of the
 * daemon's behaviour, so a test could assert a negated filter was SENT and the
 * fake would quietly return the wrong rows for it either way.
 *
 * Two deliberate fidelity gaps remain, both belonging to the daemon ticket
 * rather than to this file:
 *   - Real rows carry `authorId: null` for EVERY author, local and teammate
 *     alike (measured against a live daemon), so on real data the id branch
 *     below can never fire and only the name substring can match. These
 *     fixtures still carry ids, which is exactly why the suite stayed green
 *     over a person filter that returns nothing in production.
 *   - Real display names alias -- one teammate appears as both "Andrew Brown"
 *     and "andrewludwigbrown" -- so name matching is partial on real data in a
 *     way no fixture here reproduces.
 * Making the fixtures realistic turns the person-filter tests red, and they
 * cannot go green until the daemon exposes a usable identity. Left as is on
 * purpose; see the notes on those tests in features/search/SearchPage.test.tsx.
 */
function matchesAuthorLikeDaemon(e: { author: string; authorId: string }, filter: string | null): boolean {
  if (!filter) return true
  const negated = filter.startsWith('!')
  const want = negated ? filter.slice(1) : filter
  if (!want) return true
  const hit = e.authorId === want || e.author.toLowerCase().includes(want.toLowerCase())
  return negated ? !hit : hit
}

function longPromptChain(count: number): SessionPrompt[] {
  const base = Date.parse('2026-07-28T22:00:00Z')
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(base - i * 60_000).toISOString(),
    ask: `prompt number ${count - i} of the long refactor`,
    files: i % 3 === 0 ? ['test/run-tests.js'] : [],
  }))
}

// Session-detail fixtures (Task 3), keyed by the SAME session ids the feed
// fixture rows carry so a row's link resolves in fake mode: one live
// (s-f1), one finished with a full brief (s-f2), one with empty
// decisions/gotchas (s-f3), and one 60-prompt session (s-f4).
// Authored as WIRE payloads and mapped on read (see getSession below), not as
// Session objects. mapSession is pure normalization -- every field is
// `raw.x || default` -- which is exactly the kind of mapper a fixture can drift
// away from without anything failing: author a Session directly and you get to
// skip every default the app actually depends on.
const SESSION_FIXTURES: Record<string, RawSessionPayload> = {
  's-f1': {
    session: 's-f1', project: 'membridge', projectPath: '/Users/x/membridge',
    author: 'Andrew', authorId: 'andrew', source: 'Codex',
    startedAt: '2026-07-29T20:30:00Z', endedAt: '2026-07-29T20:36:00Z', live: true,
    summary: null, summaryFull: null, goal: null, headline: null,
    decisions: null, gotchas: null, files: [], changes: [], checkpoints: [],
    prompts: [{ ts: '2026-07-29T20:36:00Z', ask: 'make the summary hook fire on session boundaries, not only on stop', files: [] }],
  },
  's-f2': {
    session: 's-f2', project: 'membridge', projectPath: '/Users/x/membridge',
    author: 'Andrew', authorId: 'andrew', source: 'Claude Code',
    startedAt: '2026-07-29T19:00:00Z', endedAt: '2026-07-29T20:30:00Z', live: false,
    summary: 'Hook ownership now decided by durability, not who ran last.',
    summaryFull: 'Hook ownership now decided by durability, not who ran last. The stop path and the recall path share one gate. This third sentence must never render in the header.',
    goal: 'make the summary hook fire on session boundaries',
    headline: 'Hook ownership now decided by durability, not who ran last.',
    decisions: 'Durability beats recency because a crashed run must not steal the hook.',
    gotchas: 'settings.json rewrites drop unknown keys, so merge before writing.',
    files: ['lib/hooks.js', 'test/run-tests.js'],
    changes: [
      { file: 'lib/hooks.js', status: 'edited', add: 41, del: 12, note: 'ownership gate', dep: false },
      { file: 'test/run-tests.js', status: 'edited', add: 88, del: 2, note: null, dep: false },
    ],
    checkpoints: [
      { ts: '2026-07-29T19:40:00Z', text: 'Gate extracted; stop path green.' },
      { ts: '2026-07-29T20:30:00Z', text: 'Hook ownership now decided by durability, not who ran last.' },
    ],
    prompts: [
      { ts: '2026-07-29T20:00:00Z', ask: 'now make recall use the same gate', files: ['lib/hooks.js'] },
      { ts: '2026-07-29T19:00:00Z', ask: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js', 'test/run-tests.js'] },
    ],
  },
  's-f3': {
    session: 's-f3', project: 'sublease', projectPath: '/Users/x/sublease',
    author: 'Sarah', authorId: 'sarah', source: 'Claude Code',
    startedAt: '2026-07-29T09:00:00Z', endedAt: '2026-07-29T10:00:00Z', live: false,
    summary: 'Listing flow validates addresses before payment.',
    summaryFull: 'Listing flow validates addresses before payment.',
    goal: 'validate the address before charging the card',
    headline: 'Listing flow validates addresses before payment.',
    decisions: null, gotchas: null,
    files: ['lib/listing.js'],
    changes: [{ file: 'lib/listing.js', status: 'edited', add: 9, del: 1, note: null, dep: false }],
    checkpoints: [],
    prompts: [{ ts: '2026-07-29T09:00:00Z', ask: 'validate the address before charging the card', files: ['lib/listing.js'] }],
  },
  's-f4': {
    session: 's-f4', project: 'membridge', projectPath: '/Users/x/membridge',
    author: 'Andrew', authorId: 'andrew', source: 'Codex',
    startedAt: '2026-07-28T21:01:00Z', endedAt: '2026-07-28T22:00:00Z', live: false,
    summary: 'Ports fixed and pushed.',
    summaryFull: 'Ports fixed and pushed.',
    goal: 'fix the port collision in the test suite',
    headline: 'Ports fixed and pushed.',
    decisions: 'Rotated fixture ports per run instead of pinning one block.',
    gotchas: null,
    files: ['test/run-tests.js'],
    changes: [{ file: 'test/run-tests.js', status: 'edited', add: 30, del: 30, note: 'port rotation', dep: false }],
    checkpoints: [],
    prompts: longPromptChain(60),
  },
  // The intent-too-long case: a whole pasted prompt captured as the goal.
  // Real sessions carry these routinely, and rendering one verbatim as the
  // intent line is what pushed the rest of the page off the screen.
  's-f5': {
    session: 's-f5', project: 'membridge', projectPath: '/Users/x/membridge',
    author: 'Andrew', authorId: 'andrew', source: 'Claude Code',
    startedAt: '2026-07-28T14:00:00Z', endedAt: '2026-07-28T15:05:00Z', live: false,
    summary: 'Rate limit raised and the date fixed.',
    summaryFull: 'Rate limit raised and the date fixed.',
    goal: `${'please do the thing '.repeat(40)}now`,
    headline: 'Rate limit raised and the date fixed.',
    decisions: null, gotchas: null,
    files: ['ui/src/features/feed/FeedPage.tsx'],
    changes: [{ file: 'ui/src/features/feed/FeedPage.tsx', status: 'edited', add: 12, del: 4, note: null, dep: false }],
    checkpoints: [
      { ts: '2026-07-28T14:30:00Z', text: 'Fixed the date in the UI.' },
      { ts: '2026-07-28T15:00:00Z', text: 'Raised the rate limit from 3 to 10 seconds.' },
    ],
    prompts: [{ ts: '2026-07-28T14:00:00Z', ask: 'start', files: ['ui/src/features/feed/FeedPage.tsx'] }],
  },
}

export class FakeDataClient implements DataClient {
  readonly capabilities: Capabilities
  /**
   * Whether this machine is currently signed in. MUTABLE, and seeded from
   * `opts.authenticated` rather than read from it on every call.
   *
   * It used to be read straight off `opts`, which made signing out
   * unrepresentable: signOut() resolved, the app re-rendered, and
   * getTeamAccount() still said `authenticated: true`, so the SIGNED-OUT VIEW
   * never appeared in any test. A whole application state the fixtures could
   * not express is a hole the same shape as a mapper they route around -- and
   * this is the state a user is in at the moment they are trying to establish
   * whether their session is over, which is now also the screen carrying the
   * revocation warning.
   *
   * The real client is stateful here too (the daemon deletes credentials.json),
   * so modelling it as state rather than as a constructor constant is the
   * faithful shape, not a convenience.
   */
  private signedIn: boolean

  constructor(private opts: FakeOptions = {}) {
    this.signedIn = opts.authenticated ?? true
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
  // `health` follows opts.health, and `running` is DERIVED from it exactly the
  // way lib/server.js derives it (ok/erroring are running; stalled/unknown are
  // not) -- so a fixture can never present a combination the daemon cannot
  // produce, which is the only way a test of these states proves anything.
  // opts.health === null models the daemon that predates the field: `health` is
  // omitted entirely and `running` stays true.
  getStatus() {
    const health = this.opts.health === undefined
      ? { state: 'ok' as const, lastTickAt: '2026-07-29T21:00:00Z', lastTickError: null, staleForSec: 5 }
      : this.opts.health
    return this.guard<Status>({
      ...(health ? { health } : {}),
      running: health ? (health.state === 'ok' || health.state === 'erroring') : true,
      version: '0.1.7', solo: !!this.opts.solo, setupDone: true,
      projectCount: this.opts.empty ? 0 : 3, intervalSec: 60, lastSync: '2026-07-29T21:00:00Z',
      teamLastSync: this.opts.solo ? null : (this.opts.teamLastSync !== undefined ? this.opts.teamLastSync : '2026-07-29T21:00:00Z'),
      tools: ['Claude Code', 'Codex'],
      encryption: { enabled: true, plaintextOff: true, paused: null, keyAlerts: 0 },
      auth: { paused: null, detail: null, since: null },
    })
  }
  // The team roster, scaled by opts.teamSize (default: the 3 named members).
  // Every surface that lists members (getMembers, getAccessMatrix, settings
  // memberCount, the shared project's roster) reads THIS so a scaled fixture
  // cannot drift into different answers per surface.
  private teamMembers(): Member[] {
    // AUTHORED AS WIRE ROWS, THEN PUT THROUGH THE REAL MAPPER. This fixture
    // used to return `Member` literals directly, which meant no component test
    // could ever see what mapMember does to a row -- a field the mapper drops
    // stayed visible here and the app was the only place it went missing. That
    // is not hypothetical: it is exactly how #59's `preFixLocal` would have
    // vanished, and it is why `member.email` looked populated on every screen
    // while production rendered a blank (mapMember hardcodes email: '',
    // because the members RPC has never returned one).
    //
    // The rule for this file: if a mapper exists for a type, the fixture
    // authors the RAW shape and maps it. See fixtureBoundary.test.ts for which
    // types are covered and which are still outstanding.
    //
    // #59: `preFixLocal` splits this roster into the two cases the person
    // filter cannot otherwise tell apart, so a fixture that gave everyone the
    // same value would let the UI hardcode either answer and stay green.
    //   Andrew -- has unattributable local history (the gap case): filtering
    //             by him can return zero over rows that exist.
    //   Marco, Sarah, and the scaled-out members -- an explicit zero, the
    //             case where a zero result really does mean nothing found.
    //
    // keyStatus covers ALL THREE values on purpose: Sarah 'alert', Marco 'ok',
    // Andrew 'unknown'. A roster where every row shared one value would let a
    // truthiness read (`if (m.keyStatus)`) pass -- and that read is the one
    // edit that silently restores the always-on chip.
    const base: Array<{ row: RawMemberRow; activity: MemberActivity }> = [
      {
        row: { user_id: this.viewerId, display_name: 'Marco', role: this.opts.role ?? 'owner', joined_at: '2026-07-22T18:58:00Z', preFixLocal: { entries: 0, projects: 0 }, keyStatus: 'ok' },
        activity: { projectCount: 3, lastSharedAt: '2026-07-29T21:00:00Z' },
      },
      {
        row: { user_id: 'andrew', display_name: 'Andrew', role: 'admin', joined_at: '2026-07-20T09:00:00Z', preFixLocal: { entries: 7, projects: 2 }, keyStatus: 'unknown' },
        activity: { projectCount: 3, lastSharedAt: '2026-07-29T19:00:00Z' },
      },
      {
        row: { user_id: 'sarah', display_name: 'Sarah', role: 'member', joined_at: '2026-07-27T16:31:00Z', preFixLocal: { entries: 0, projects: 0 }, keyStatus: 'alert' },
        activity: { projectCount: 1, lastSharedAt: null },
      },
    ]
    const size = this.opts.teamSize ?? base.length
    const out = base.slice(0, Math.min(size, base.length))
    for (let i = base.length + 1; i <= size; i++) {
      out.push({
        row: { user_id: `m${i}`, display_name: `Member ${i}`, role: 'member', joined_at: '2026-07-25T12:00:00Z', preFixLocal: { entries: 0, projects: 0 }, keyStatus: 'ok' },
        activity: { projectCount: 1, lastSharedAt: null },
      })
    }
    return out.map(({ row, activity }) => mapMember(row, activity))
  }
  // The shared project's ACCESS roster: a strict subset (6 of N) once the team
  // is bigger than 6, so the Access cell's "+N chip and count label" case is a
  // real state rather than always collapsing to "whole team".
  //
  // getProjects() below also seeds `recentAuthorIds` from this, which is not a
  // naming slip: making the fixture's recent authors a subset of the people with
  // access keeps a demo screen plausible. Nothing may infer from that overlap --
  // in production the two are unrelated sets, which is the whole reason
  // recentAuthorIds stopped being called memberIds (see types.ts).
  private sharedMemberIds(): string[] {
    if (this.opts.solo) return [this.viewerId]
    return this.teamMembers().slice(0, 6).map(m => m.id)
  }
  /**
   * Projects, authored as wire rows + a wire feed page and put through the real
   * mapProjectRow — same as teamMembers() and for the same reason.
   *
   * Four of Project's fields are DERIVED rather than copied, and this fixture
   * used to assert all four into existence:
   *   shared           <- !!row.team
   *   recentAuthorIds  <- distinct authorIds on this project's feed rows
   *   latestSummary    <- newest feed row carrying a headline or summary
   *   sync             <- syncStateOf(row, intervalSec)
   *
   * The `sync` one was why this conversion looked blocked. It is not:
   * syncStateOf never reads the wall clock — it compares the row's OWN
   * lastActivity against its OWN lastSync against a grace of
   * intervalSec * SYNC_GRACE_INTERVALS. So the states below are produced by the
   * same timestamps the fixture already carried, not simulated:
   *   membridge      lastActivity == lastSync            -> lag 0        -> up-to-date
   *   sublease       2026-07-29T08 vs 2026-07-23T10      -> ~6 days      -> behind
   *   old-prototype  paused: true                        -> paused (wins outright)
   * Nothing here fakes a timing outcome; change a timestamp and the state
   * changes with it, exactly as it would against the daemon.
   *
   * ONE FEED ARRAY FOR ALL PROJECTS, passed whole to every mapProjectRow call,
   * because that is what the real client does: entriesForProject filters one
   * shared page per project. Passing each project a pre-filtered array would
   * hide the filter, which is itself part of what the mapper does.
   */
  getProjects() {
    if (this.opts.empty) return this.guard<Project[]>([])

    // Only ONE entry per project carries text, so latestSummaryFor picks it
    // regardless of position and the fixture does not depend on array order to
    // stay correct.
    const feed: RawFeedEntry[] = [
      // membridge's summary row. authorId null on purpose: it keeps Andrew as
      // the summary's AUTHOR NAME without adding him to recentAuthorIds, which
      // is what lets the solo fixture keep this summary while its author list
      // collapses to just the viewer.
      rawFeedEntry({
        project: 'membridge', projectPath: '/Users/x/membridge',
        author: 'Andrew', authorId: null, ts: '2026-07-29T19:00:00Z',
        headline: 'Hook ownership now decided by durability, not who ran last',
      }),
      // The people seen on membridge lately. Textless, so they cannot displace
      // the summary above; present only to be counted as authors.
      ...this.sharedMemberIds().map(id => rawFeedEntry({
        project: 'membridge', projectPath: '/Users/x/membridge', authorId: id,
      })),
      rawFeedEntry({
        project: 'sublease', projectPath: '/Users/x/sublease',
        author: 'You', authorId: this.viewerId, ts: '2026-07-23T10:00:00Z',
        headline: 'Listing flow validates addresses before payment',
      }),
      // Archived pair: an author but no text, so latestSummary comes back null
      // from the mapper rather than being written as null here.
      rawFeedEntry({ project: 'old-prototype', projectPath: '/Users/x/old-prototype', authorId: this.viewerId }),
      rawFeedEntry({ project: 'deleted-folder', projectPath: '/Users/x/deleted-folder', authorId: this.viewerId }),
    ]

    const rows: RawProjectRow[] = [
      {
        path: '/Users/x/membridge', name: 'membridge', exists: true, archived: false, missing: false, paused: false,
        lastSync: '2026-07-29T19:00:00Z', lastActivity: '2026-07-29T19:00:00Z',
        sessionsTotal: 184, tools: ['Claude Code', 'Codex'],
        // `shared` is derived from this, not stated: a team link present means
        // shared. Solo installs have no link at all.
        team: this.opts.solo ? null : { projectId: 'tp-membridge', teamId: 'team-1' },
        sessionsThisWeek: 31, dailyCounts: [3, 5, 2, 6, 4, 5, 6], // must sum to sessionsThisWeek (server.js dailySessionBuckets partition invariant)
      },
      {
        path: '/Users/x/sublease', name: 'sublease', exists: true, archived: false, missing: false, paused: false,
        lastSync: '2026-07-23T10:00:00Z', lastActivity: '2026-07-29T08:00:00Z',
        sessionsTotal: 40, tools: ['Claude Code'],
        team: null,
        sessionsThisWeek: 4, dailyCounts: [1, 0, 1, 0, 1, 1, 0], // must sum to sessionsThisWeek (server.js dailySessionBuckets partition invariant)
      },
    ]
    if (this.opts.withArchived) {
      rows.push(
        {
          path: '/Users/x/old-prototype', name: 'old-prototype', exists: true, archived: true, missing: false, paused: true,
          lastSync: '2026-06-30T10:00:00Z', lastActivity: '2026-06-30T10:00:00Z',
          sessionsTotal: 12, tools: ['Claude Code'], team: null,
          sessionsThisWeek: 0, dailyCounts: [0, 0, 0, 0, 0, 0, 0],
        },
        {
          path: '/Users/x/deleted-folder', name: 'deleted-folder', exists: false, archived: true, missing: true, paused: true,
          lastSync: '2026-06-01T10:00:00Z', lastActivity: '2026-06-01T10:00:00Z',
          sessionsTotal: 3, tools: ['Codex'], team: null,
          sessionsThisWeek: 0, dailyCounts: [0, 0, 0, 0, 0, 0, 0],
        },
      )
    }
    return this.guard<Project[]>(rows.map(row => mapProjectRow(row, feed)))
  }
  getLiveSessions() {
    // mapLiveSession derives the id from `session`, the tool from `source`,
    // and `outcome` from outcomeOf(...) || null -- so a live session with no
    // headline yet comes back with a null outcome because the mapper says so.
    const rows: RawEntrySpec[] = [
      { session: 's1', ts: '2026-07-29T20:36:00Z', author: 'Andrew', authorId: 'andrew', source: 'Codex', live: true,
        goal: 'make the summary hook fire on session boundaries, not only on stop',
        project: 'membridge', projectPath: '/Users/x/membridge' },
      { session: 's2', ts: '2026-07-29T21:00:00Z', author: 'You', authorId: this.viewerId, source: 'Claude Code', live: true,
        goal: 'rebuild the apps interface from the ground up',
        project: 'membridge', projectPath: '/Users/x/membridge' },
    ]
    return this.guard<LiveSession[]>(this.opts.empty ? [] : rows.map(e => mapLiveSession(rawFeedEntry(e))))
  }
  // null for an unknown id -- FakeDataClient must model the real client's
  // "evicted session" resolution, not throw, so the not-in-memory page state
  // is exercisable in tests.
  getSession(sessionId: string) {
    const raw = SESSION_FIXTURES[sessionId]
    // Mapped here rather than stored mapped, so a change to mapSession's
    // normalization reaches every test that opens a session page.
    return this.guard<Session | null>(raw ? mapSession(raw) : null)
  }
  /**
   * Honours BOTH the project asked for and `empty`. It used to ignore its
   * argument and return the same row for every project, which meant
   * `{ empty: true }` produced a combination the daemon cannot: no projects at
   * all, yet a populated project stream. Reaching the no-sessions state
   * required stubbing the method per test, so the state existed only where
   * someone had already thought to fake it.
   */
  getProjectStream(projectPath: string) {
    if (this.opts.empty) return this.guard<StreamEntry[]>([])
    const rows: RawEntrySpec[] = [
      // distilled: true so the `!!e.distilled` passthrough is OBSERVABLE. With
      // every boolean left at the default, a mapper that inverted them looked
      // identical -- which is how those three survived mutation.
      { session: 's-e1', ts: '2026-07-29T19:00:00Z', author: 'Andrew', authorId: 'andrew', source: 'Codex', live: true,
        headline: 'Hook ownership now decided by durability, not who ran last.',
        goal: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js'],
        distilled: true,
        project: 'membridge', projectPath: '/Users/x/membridge' },
    ]
    return this.guard<StreamEntry[]>(
      rows.filter(e => !projectPath || e.projectPath === projectPath).map(e => mapStreamEntry(rawFeedEntry(e))),
    )
  }
  // Feed fixture: 5 entries across 2 projects, 2 named authors + "you", 2
  // tools, spanning 2 UTC calendar days -- enough to exercise day-grouping,
  // every filter, and (via a caller-supplied `before`) backward paging
  // without a live daemon.
  private feedFixture(): FeedEntry[] {
    // Wire rows, mapped. `outcome` and `intent` are DERIVED here, not stated:
    // outcomeOf prefers a headline and otherwise clips the summary's first
    // sentence to OUTCOME_MAX, and intentOf prefers `goal` over `ask`. Stating
    // them as literals meant no test ever exercised either rule -- including
    // the clipping, which is the one most likely to change.
    //
    // `id` is now the mapper's composite (session|ts) rather than 'f1'..'f5'.
    // It is an internal key -- FeedPage dedupes on it and DayCard uses it as a
    // React key -- and no test asserts it. Session links read `session`, which
    // is unchanged.
    const rows: RawEntrySpec[] = [
      { session: 's-f1', ts: '2026-07-29T20:36:00Z', author: 'Andrew', authorId: 'andrew', source: 'Codex', live: true,
        goal: 'make the summary hook fire on session boundaries, not only on stop',
        project: 'membridge', projectPath: '/Users/x/membridge' },
      { session: 's-f2', ts: '2026-07-29T19:00:00Z', author: 'You', authorId: this.viewerId, source: 'Claude Code',
        headline: 'Hook ownership now decided by durability, not who ran last.',
        goal: 'make the summary hook fire on session boundaries', files: ['lib/hooks.js'],
        project: 'membridge', projectPath: '/Users/x/membridge' },
      { session: 's-f3', ts: '2026-07-29T10:00:00Z', author: 'Sarah', authorId: 'sarah', source: 'Claude Code',
        headline: 'Listing flow validates addresses before payment.',
        goal: 'validate the address before charging the card', files: ['lib/listing.js'],
        project: 'sublease', projectPath: '/Users/x/sublease' },
      { session: 's-f4', ts: '2026-07-28T22:00:00Z', author: 'Andrew', authorId: 'andrew', source: 'Codex',
        headline: 'Ports fixed and pushed.',
        goal: 'fix the port collision in the test suite', files: ['test/run-tests.js'],
        project: 'membridge', projectPath: '/Users/x/membridge' },
      // No goal and no ask, so intentOf yields null -- the "nothing to show"
      // case, derived rather than written as `intent: null`.
      { session: 's-f5', ts: '2026-07-28T18:00:00Z', author: 'You', authorId: this.viewerId, source: 'Claude Code',
        headline: 'Landing page deployed.',
        project: 'sublease', projectPath: '/Users/x/sublease' },
    ]
    return rows.map(e => mapFeedEntry(rawFeedEntry(e)))
  }
  getFeed(filters: FeedFilters, opts: { limit: number; before: string | null }) {
    if (this.opts.empty) return this.guard<FeedPage>({ entries: [], nextBefore: null, dayDigests: [] })
    let entries = this.feedFixture()
      .filter(e => !filters.author || e.authorId === filters.author)
      .filter(e => !filters.project || e.projectPath === filters.project)
      .filter(e => !filters.source || e.tool === filters.source)
      .sort((a, b) => b.at.localeCompare(a.at))
    if (opts.before) entries = entries.filter(e => e.at <= opts.before!)
    const page = entries.slice(0, opts.limit)
    const nextBefore = entries.length > opts.limit ? page[page.length - 1].at : null
    // No dayDigests: the fixture transport deliberately exercises the
    // no-digest daemon, which is the state every client must degrade to. Tests
    // that need one supply it by mocking getFeed.
    return this.guard<FeedPage>({ entries: page, nextBefore, dayDigests: [] })
  }
  // The demo/test transport's search: the same fixture rows, filtered by a
  // plain case-insensitive substring over the fields the real scorer weights
  // highest. No ranking model here on purpose -- the fixture is for driving
  // the UI's states (results / empty / typing), and duplicating lib/search.js
  // in TypeScript would create a second scorer to keep in sync.
  search(query: string, filters: FeedFilters, limit: number) {
    const q = query.trim().toLowerCase()
    if (!q || this.opts.empty) return this.guard<SearchPage>({ query: q, total: 0, results: [] })
    const hits = this.feedFixture()
      .filter(e => matchesAuthorLikeDaemon(e, filters.author))
      .filter(e => !filters.project || e.projectPath === filters.project)
      .filter(e => !filters.source || e.tool === filters.source)
      .map(e => {
        const matched: string[] = []
        if (e.outcome.toLowerCase().includes(q)) matched.push('summary')
        if ((e.intent || '').toLowerCase().includes(q)) matched.push('ask')
        if (e.files.some(f => f.toLowerCase().includes(q))) matched.push('files')
        if (e.author.toLowerCase().includes(q)) matched.push('author')
        return { ...e, score: matched.length, matched }
      })
      .filter(e => e.matched.length > 0)
      .sort((a, b) => (b.score - a.score) || b.at.localeCompare(a.at))
    return this.guard<SearchPage>({ query: q, total: hits.length, results: hits.slice(0, limit) })
  }
  syncProject() { return this.guard<void>(undefined) }
  syncAll() { return this.guard<void>(undefined) }
  setProjectPaused() { return this.guard<void>(undefined) }
  // The path parameters are declared (unlike the sync stubs above) so tests
  // can mockImplementation per-path for partial-failure scenarios.
  archiveProject(_projectPath: string) { return this.guard<void>(undefined) }
  unarchiveProject(_projectPath: string) { return this.guard<void>(undefined) }
  // Defaults to a real local delete. Tests override with a refusal body
  // ({ archived: false, message }) to drive the refused-delete path.
  deleteProject(projectPath: string) {
    return this.guard<DeleteProjectResult>({ path: projectPath, scope: 'local', deleted: true })
  }
  copyForAI() { return this.guard('digest text') }
  // The path is declared (same reason archiveProject's is): tests spy on this
  // to assert WHICH project's access the projects grid asked for, and a
  // zero-arg signature made that assertion untypable.
  getProjectAccess(_projectPath: string) {
    return this.guard({
      members: [{ memberId: this.viewerId, canSee: true }, { memberId: 'andrew', canSee: true }, { memberId: 'sarah', canSee: false }],
      defaultAccess: true,
    })
  }
  setProjectAccess() { return this.guard<void>(undefined) }
  setProjectAccessDefault() { return this.guard<void>(undefined) }
  getAccessMatrix() {
    const members = this.teamMembers()
    const sharedIds = new Set(this.sharedMemberIds())
    return this.guard<AccessMatrix>({
      members: members.map(m => ({ id: m.id, name: m.name })),
      rows: [
        { projectPath: '/Users/x/membridge', projectName: 'membridge', shared: true, access: Object.fromEntries(members.map(m => [m.id, sharedIds.has(m.id)])) },
        { projectPath: '/Users/x/sublease', projectName: 'sublease', shared: false, access: Object.fromEntries(members.map(m => [m.id, m.id === this.viewerId])) },
      ],
    })
  }
  // All member surfaces read teamMembers() above, so the roster, the matrix,
  // settings memberCount and the shared project's fixture author set always
  // agree -- 'andrew' was once absent here while three other fixtures
  // referenced him, and anything joining those against getMembers() silently
  // dropped him.
  getMembers() {
    return this.guard<Member[]>(this.teamMembers())
  }
  // The Team page's state source. Reads the SAME opts the settings fixture
  // reads (solo, role, webUrl, viewerId) so the two surfaces can never
  // disagree about whether this machine is on a team; `authenticated` is the
  // one fact only this payload carries.
  getTeamAccount() {
    const authenticated = this.signedIn
    const onTeam = authenticated && !this.opts.solo
    return this.guard<TeamAccount>({
      configured: true,
      authenticated,
      user: authenticated ? { userId: this.viewerId, email: 'marco@melika.com', displayName: 'Marco' } : null,
      // A second team only when a test asks for it (opts.secondTeam): every
      // other fixture keeps modelling the one-team norm.
      teams: this.teamFixtures(),
      inviteCode: onTeam ? 'INV-7F3K9Q' : null,
      webUrl: this.opts.webUrl !== undefined ? this.opts.webUrl : 'https://join.membridge.me',
      error: null,
    })
  }
  // Resolves the identity the daemon confirmed, never the password it was
  // given -- the fixture models the real contract, where the password exists
  // only for the duration of the request.
  signIn(credentials: { email: string; password: string }) {
    // Round-trips: a fixture that can only go one way cannot cover sign-in
    // FROM the signed-out view, which is the other half of this screen.
    this.signedIn = true
    return this.guard<{ email: string; displayName: string | null }>({ email: credentials.email, displayName: 'Andrew' })
  }
  /** The one fixture address that already has an account. A constant rather
   *  than a literal repeated per test, so a test cannot silently drift onto a
   *  different address and start exercising the fresh-signup path instead. */
  static readonly REGISTERED_EMAIL = 'taken@acme.dev'

  // needs-confirmation is the DEFAULT fixture answer on purpose -- it is what
  // a real Supabase project with email confirmation on returns, and the state
  // a UI is most likely to forget to render.
  signUp(credentials: { displayName: string; email: string; password: string }) {
    if (credentials.email.toLowerCase() === FakeDataClient.REGISTERED_EMAIL) {
      return this.guard<SignUpResult>({ status: 'email-exists', email: credentials.email })
    }
    return this.guard<SignUpResult>({ status: 'needs-confirmation', email: credentials.email })
  }
  // Default is the good path: the backend confirmed the revocation. The
  // failure is opt-in via `signOutRevokeError` rather than the default,
  // because a fixture that failed revocation by default would make every
  // unrelated sign-out test render the warning.
  signOut() {
    const err = this.opts.signOutRevokeError ?? null
    // The local credential delete is UNCONDITIONAL in the daemon -- a user
    // offline must still be able to sign out of their own laptop -- so this
    // flips regardless of whether the backend revocation succeeded. That is
    // exactly why a failed revocation still lands the user on the signed-out
    // view, and why that view has to carry the warning.
    this.signedIn = false
    return this.guard<SignOutResult>({ revoked: !err, revokeError: err })
  }
  createTeam(name: string) {
    return this.guard<{ id: string; inviteCode: string | null }>({ id: 'team-new', inviteCode: `INV-${name.slice(0, 3).toUpperCase()}` })
  }
  // Resolves whatever the real daemon would after normalizing the input --
  // the fixture deliberately does NOT validate the code's shape, because the
  // daemon accepts a token, a UUID and a pasted URL and the UI must not be
  // written against a narrower idea of what is valid.
  joinTeam() { return this.guard<{ id: string; name: string }>({ id: 'team-acme', name: 'Acme AI' }) }

  // Genuinely nothing to do: this fake resolves fixtures directly and has no
  // request cache to stand down. Kept as an explicit no-op (not omitted) so a
  // test can still spy on it and prove Recheck asks the transport for a real
  // round trip -- which is the only thing the UI can be held to here.
  forgetCachedReads(): void {}

  // The selection is real state here, not a no-op stub: every team-scoped
  // fixture below reads selectedTeam(), so a test can prove the app actually
  // follows the switch rather than only that a control was clicked.
  private teamId: string | null = null
  selectedTeamId() { return this.teamId }
  selectTeam(teamId: string | null) { this.teamId = teamId }
  /** The team fixture the current selection points at (first, by default). */
  private selectedTeam(): { id: string; name: string; role: Role; memberCount: number | null } | null {
    const teams = this.teamFixtures()
    if (!teams.length) return null
    return teams.find(t => t.id === this.teamId) ?? teams[0]
  }
  private teamFixtures(): { id: string; name: string; role: Role; memberCount: number | null }[] {
    const authenticated = this.signedIn
    if (!(authenticated && !this.opts.solo)) return []
    return [
      { id: 'team-1', name: 'MemBridge HQ', role: this.opts.role ?? 'owner', memberCount: this.opts.memberCountUnknown ? null : this.teamMembers().length },
      ...(this.opts.secondTeam ? [{ id: 'team-2', name: 'Weekend Side Project', role: 'member' as Role, memberCount: 2 }] : []),
    ]
  }
  renameTeam() { return this.guard<void>(undefined) }
  rotateInviteCode() { return this.guard<string>('INV-NEW42X') }
  // Two live invites: one time-limited and partly used, one open-ended and
  // untouched -- the two shapes the row has to render honestly (an expiry vs
  // "never expires", a use count vs "unlimited").
  getInvites() {
    return this.guard<Invite[]>([
      { id: 'i1', createdAt: '2026-07-28T09:00:00Z', expiresAt: '2026-08-04T00:00:00Z', maxUses: 5, useCount: 2, revoked: false },
      { id: 'i2', createdAt: '2026-07-20T09:00:00Z', expiresAt: null, maxUses: null, useCount: 0, revoked: false },
    ])
  }
  // Takes the options so a test can assert what the SCREEN decided, not just
  // that something was minted. The token is fixed; the interesting assertion
  // is the bounds the caller asked for.
  createInviteLink(_teamId: string, _options: InviteOptions) {
    return this.guard<{ token: string }>({ token: 'tok_9f2aQ7' })
  }
  revokeInvite() { return this.guard<void>(undefined) }
  setMemberRole() { return this.guard<void>(undefined) }
  removeMember() { return this.guard<void>(undefined) }
  // Three projects covering the states the confirmation screen has to render
  // without lying: one this machine has locally (nameable by folder), one only
  // ever synced from ANOTHER machine (path null -- the preview still counts it,
  // because the delete still removes it), and one with a single entry, so the
  // copy is exercised against a count that must not read "1 entries".
  getMyData() {
    return this.guard<MyData>({
      projects: [
        { projectId: 'p1', name: 'membridge', path: '/Users/andrew/membridge', entries: 412, firstTs: '2026-06-02T11:20:00Z', lastTs: '2026-08-06T18:04:00Z' },
        { projectId: 'p2', name: 'checkout-api', path: null, entries: 87, firstTs: '2026-07-14T08:00:00Z', lastTs: '2026-08-01T16:30:00Z' },
        { projectId: 'p3', name: 'scratch', path: '/Users/andrew/scratch', entries: 1, firstTs: '2026-08-05T09:12:00Z', lastTs: '2026-08-05T09:12:00Z' },
      ],
      total: 500,
    })
  }
  // `projects` is deliberately SMALLER than the project count above: p2 has no
  // local link, so no watermark can land on it. That gap is real and the UI
  // must not present the two numbers as the same thing.
  deleteMyData() { return this.guard<DeleteMyDataResult>({ deleted: 500, projects: 2 }) }
  // One row per action family the trail can now record, so the panel's
  // rendering is exercised against real shapes rather than one synthetic
  // event: a project-access change (UUID key, friendly path in objectName),
  // a membership change, a role change (whose new role lives in detail), and
  // an action nothing knows how to phrase (the fallback path).
  getAudit() {
    return this.guard<AuditEvent[]>([
      {
        id: 'a1', at: '2026-07-29T14:02:00Z', actorName: 'Andrew', action: 'access-revoked',
        objectType: 'project', objectLabel: '8f21c0de-1c44-4a0b-9a0e-2b6d5f7c1234',
        objectName: '/Users/x/billing-poc', targetName: 'Dana',
        detail: JSON.stringify({ path: '/Users/x/billing-poc', memberId: 'dana', canSee: false }),
      },
      {
        id: 'a2', at: '2026-07-29T13:40:00Z', actorName: 'Andrew', action: 'member-removed',
        objectType: 'member', objectLabel: 'usr_gone', objectName: null, targetName: 'Priya',
        detail: JSON.stringify({ memberId: 'usr_gone', targetName: 'Priya' }),
      },
      {
        id: 'a3', at: '2026-07-29T11:05:00Z', actorName: 'Marco', action: 'role-changed',
        objectType: 'member', objectLabel: 'sarah', objectName: null, targetName: 'Sarah',
        detail: JSON.stringify({ memberId: 'sarah', role: 'admin' }),
      },
      {
        id: 'a4', at: '2026-06-30T09:00:00Z', actorName: 'Andrew', action: 'unshared',
        objectType: 'project', objectLabel: 'billing-poc', objectName: null, targetName: null, detail: null,
      },
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
      // 818 + 46 = 864, and the MCP figure sits outside that sum -- a fixture
      // that folded it in could not model the real payload, where the gauge
      // is bounded by the tool allowlist (6) and the counters are not.
      : { available: true, total: 864, byKind: { recallServed: 818, teammateNotes: 46 }, mcpTools: { inUse: 4, total: 6 } }
  }
  getSkeletonStats() {
    return this.guard<SkeletonStats>(this.skeletonStats())
  }
  getInsights(window: 7 | 30 | 90) {
    return this.guard<Insights>({
      window,
      exact: true,
      truncated: false,
      // T-71: the daemon fetches priorStart..now (2 * window). On an
      // untruncated fetch both fields hold `window * 2` -- the "reached"
      // number equals the daemon's requested span. Truncated tests override
      // both, exactly like the sessions/entries counts above.
      lookbackDays: window * 2,
      coveredDays: window * 2,
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
      // Follows the SELECTION, not always the first team -- this is what the
      // rail and the Settings Team group render, so a switch has to be
      // observable here or the switcher is only pretending.
      team: (() => {
        const t = this.selectedTeam()
        // Settings.team.memberCount is `number`, NOT `number | null` -- the two
        // payloads model different things and only TeamSummary (the account's
        // team list) carries the older-daemon unknown. Falling back to the real
        // roster length here keeps memberCountUnknown scoped to the surface it
        // is about instead of quietly widening a second type.
        return t ? {
          ...t,
          memberCount: t.memberCount ?? this.teamMembers().length,
          inviteCode: 'INV-7F3K9Q',
          // Defaults to 'off' unless a test explicitly overrides it -- matches
          // the daemon's own default (teamsync's `=== true` check).
          sharePrompts: this.opts.sharePrompts ?? 'off',
        } : null
      })(),
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
      search: { ok: true, detail: 'rewritten to the current version' },
    })
  }

  restartDaemon() { return this.guard<void>(undefined) }
  // Explicitly the DataClient signature, not the narrow shape TS would infer
  // from this one fixture: `latest` legitimately comes back null (the daemon's
  // network probe failed) and `updateAvailable` legitimately comes back a
  // version string, and a test overriding this method has to be able to say so.
  checkForUpdates() {
    return this.guard<{ current: string; latest: string | null; updateAvailable: string | null }>(
      { current: '0.1.7', latest: '0.1.7', updateAvailable: null },
    )
  }
  openConfigFile() { return this.guard<void>(undefined) }
  openMemoryFile() { return this.guard<void>(undefined) }
  leaveTeam() { return this.guard<void>(undefined) }
  transferOwnership() { return this.guard<void>(undefined) }
  disbandTeam() { return this.guard<void>(undefined) }

  // Discovery fixture: two untracked folders with real activity plus one
  // already-watched row, so the dialog's "already added" filtering is
  // exercised by the DEFAULT fixture rather than only by an opt-in one.
  discoverProjects() {
    if (this.opts.discovered) return this.guard<DiscoveredProject[]>(this.opts.discovered)
    return this.guard<DiscoveredProject[]>([
      { path: '/Users/x/membridge', name: 'membridge', tracked: true, sessionCount: 184, tools: ['Claude Code', 'Codex'] },
      { path: '/Users/x/polycopy', name: 'polycopy', tracked: false, sessionCount: 12, tools: ['Claude Code'] },
      { path: '/Users/x/site', name: 'site', tracked: false, sessionCount: 3, tools: ['Codex'] },
    ])
  }

  adoptProjects(paths: string[]) {
    return this.guard<AdoptResult>({ adopted: paths, skipped: [], historyWithheld: [] })
  }

  pickPaths() {
    if (!this.capabilities.filePicker) {
      return Promise.reject(new Error('pickPaths is unavailable: this window has no Electron bridge (window.membridge).'))
    }
    return this.guard<string[]>(this.opts.pickPathsResult ?? [])
  }
}
