import { localDayKey } from '../../data/localTime'
import { clipWords } from '../../data/mappers'
import type { FeedEntry } from '../../data/types'

// Consolidated day cards: one card per PERSON per local calendar day, across
// every project they touched. The feed's problem was volume of the wrong
// kind -- one teammate's afternoon landed as eight near-identical rows, and
// "what did Marco do today" took scrolling to answer. The card answers it in
// one sentence and keeps the detail one click away.
//
// A person's day is ONE thing to them, not one thing per repo. Keying the card
// on the project as well split that day into a card per checkout, and measured
// live against /api/feed it produced four cards for two people:
//
//     marco / Membridge       15 rows
//     You   / membridge-site   9 rows
//     You   / membridge       18 rows
//     You   / Membridge       18 rows
//
// The last two are the same project reached from its two sides, and the middle
// two are one person's morning and afternoon. The card is now keyed on the
// person alone and carries the projects it spans as a LIST (dayProjects
// below), so that same feed renders as two cards.
//
// Everything here is pure and deterministic: same entries in, same cards out,
// no clock read, no model called. FeedPage owns the rendering and the day
// dividers above these cards.

// ---------------------------------------------------------------------------
// Grouping key
// ---------------------------------------------------------------------------

/** Normalize one component of the key: ids are compared exactly, display names
 *  case-insensitively, and whitespace never decides identity. */
function part(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

// Ids where available, display names as the fallback -- and the fallback is
// load-bearing, not defensive noise:
//   - authorId is null on team rows pushed before the author_id column existed
//     (lib/feed.js normalizeTeam), so keying on the id alone would fold EVERY
//     such teammate into one card for the day.
//   - projectPath is ALWAYS null on team rows (normalizeTeam sets it null on
//     purpose -- a teammate's absolute path is not a fact this machine has),
//     so keying on the path alone would fold every teammate project together.
// The namespaces (`id:` / `path:` / `name:`) keep the fallbacks apart, so a
// person whose display name happens to equal someone else's user id can never
// collide.
function authorPart(e: FeedEntry): string {
  return e.authorId ? `id:${part(e.authorId)}` : `name:${part(e.author)}`
}

/** Which project an entry belongs to, in the ONE precedence that survives a
 *  round trip through team sync: projectId, then projectPath, then the display
 *  name. This is lib/feed.js's own dedupeKey precedence, and it is canonical
 *  for exactly this problem.
 *
 *  Why the order matters, measured live against /api/feed: work done in a
 *  LINKED project reaches this machine twice, once as a local row and once as
 *  its own synced-back twin. normalizeLocal stamps projectId and projectPath
 *  and calls the project "membridge"; normalizeTeam stamps the SAME projectId,
 *  nulls projectPath, and calls it "Membridge". Keying on path-then-name split
 *  one person's single afternoon across two cards that each claimed their own
 *  session count. Keying on projectId first folds them, because projectId is
 *  the one component both shapes carry.
 *
 *  projectPath stays the second choice rather than being dropped: an UNLINKED
 *  local project has no projectId at all (membridge-site, live, is one), and
 *  falling straight through to the display name would merge two unlinked
 *  projects that happen to share a folder name. */
export function projectPart(e: FeedEntry): string {
  if (e.projectId) return `id:${part(e.projectId)}`
  if (e.projectPath) return `path:${part(e.projectPath)}`
  return `name:${part(e.project)}`
}

/** One project a card spans. `count` is entries, which is what orders the
 *  list: the project a person spent the day in leads, the one they dipped into
 *  trails. */
export interface DayProject {
  /** projectPart, so two rows the feed considers one project are one entry
   *  here. Without that precedence a linked project's local rows and its own
   *  synced-back twins would list as "membridge" AND "Membridge" on the same
   *  card, which is the split the card key used to have, moved one level in. */
  key: string
  /** The display name to render. Prefers the name off a row that carries a
   *  projectPath (this machine's own folder, the name the reader recognises)
   *  over the backend's differently-capitalised copy of it. */
  name: string
  count: number
}

export function dayProjects(entries: FeedEntry[]): DayProject[] {
  const byKey = new Map<string, DayProject & { fromLocal: boolean }>()
  for (const e of entries) {
    const key = projectPart(e)
    const name = (e.project || '').trim()
    const seen = byKey.get(key)
    if (!seen) {
      byKey.set(key, { key, name, count: 1, fromLocal: !!e.projectPath })
      continue
    }
    seen.count++
    if (!seen.fromLocal && e.projectPath) {
      seen.name = name
      seen.fromLocal = true
    }
  }
  // Count descending, then by name so a tie is stable rather than dependent
  // on which page of the feed happened to arrive first.
  return [...byKey.values()]
    .map(({ key, name, count }) => ({ key, name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
}

/** Separator inside a day card key. A NUL can appear in neither part (a user
 *  id, a date), which is what makes the key unambiguous where a printable
 *  separator would not be: a display name may legitimately contain any
 *  punctuation you might otherwise reach for. */
const KEY_SEP = '\x00'

/** author + LOCAL calendar day. No project component: a person's day spans
 *  whatever they worked on, and the projects ride along on the card as a list.
 *
 *  localDayKey (never toISOString().slice(0,10)) is the whole point of the day
 *  half: an evening session west of Greenwich has a UTC date of TOMORROW,
 *  which split one afternoon across two cards and filed the later half under a
 *  day that had not happened yet. Same bug, same fix, as dayLabel and
 *  ProjectPage's grouping. */
export function dayCardKey(e: FeedEntry): string {
  return `${localDayKey(new Date(e.at))}${KEY_SEP}${authorPart(e)}`
}

/** Separator between the slug's parts, below. base64url's alphabet is
 *  `A-Za-z0-9-_` and contains no tilde, so the separator can never appear
 *  inside a part and two different keys can never slug the same. */
const SLUG_SEP = '~'

/** One key part as base64url: URL-safe, and -- the whole point -- carrying no
 *  percent escape for anything downstream to decode. */
function encodePart(part: string): string {
  const bytes = new TextEncoder().encode(part)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The inverse, for the ONE reader that needs it (daySlugDay). Returns null
 *  rather than throwing for anything that is not a part this module minted:
 *  a slug arrives from the address bar, so it is hand-editable text. */
function decodePart(part: string): string | null {
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** The same key, safe to carry in a URL path segment.
 *
 *  The key's NUL separator cannot go in a URL: `encodeURIComponent` turns it
 *  into `%00`, and a null byte in a path is rejected or stripped by enough of
 *  the stack that it is not worth relying on. Each PART is encoded instead and
 *  joined by SLUG_SEP.
 *
 *  base64url PER PART, not encodeURIComponent, and the difference is the whole
 *  bug this once had. The slug does not travel to a server, it travels through
 *  the ROUTER, and wouter runs decodeURI over location.pathname before it
 *  matches (wouter/src/paths.js `unescape`). Every percent triple outside the
 *  reserved set is therefore already gone by the time DayPage sees the param:
 *
 *      "Marco Melika"  ->  %20     ->  a literal space in params.daySlug
 *      "Renee" with an accent -> %C3%A9 -> the literal accented character
 *      "o~brien"       ->  %7E     ->  a literal tilde, which defeated the
 *                                      separator escaping entirely
 *
 *  while the card's own slug still carried the escapes, so the two sides never
 *  matched and clicking a visible card answered "That day is not in view".
 *  base64url is fixed under decodeURI -- there is no percent escape in it to
 *  decode -- so the bytes the router hands back are the bytes the card minted.
 *  It reaches the fallback names hardest (dayCards.authorPart falls back to the
 *  display name for team rows pushed before author_id existed), which is
 *  exactly where spaces and accents live.
 *
 *  One-way as a whole: nothing rebuilds a key from a slug, and DayPage finds
 *  its card by matching slugs, so a slug that decodes is never confused with a
 *  day that exists. daySlugDay below reads back the day HALF only, for a
 *  bounded question that a slug comparison cannot answer. */
export function daySlug(key: string): string {
  return key.split(KEY_SEP).map(encodePart).join(SLUG_SEP)
}

/** The LOCAL calendar day a slug names ("2026-07-29"), or null when it names
 *  none. That day is the first part of every key dayCardKey mints.
 *
 *  Read back so the day view knows when it has paged far enough: "have I
 *  loaded past the start of this day" is answerable from the day alone, where
 *  "is this card here yet" is not (an absent card is indistinguishable from
 *  one page short of it). Defensive by contract -- a hand-edited or truncated
 *  slug returns null rather than throwing into a render path. */
export function daySlugDay(slug: string): string | null {
  const day = decodePart(String(slug || '').split(SLUG_SEP)[0])
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

// ---------------------------------------------------------------------------
// Synced-back twins
// ---------------------------------------------------------------------------

/** Comparable instant, not the raw string. The backend round-trips a timestamp
 *  through timestamptz, so the twin of a local `...:53.550Z` can come back as
 *  `...:53.55+00:00` -- the same moment, a different string, and therefore a
 *  different streamEntryId, which is why FeedPage's dedupeById never caught
 *  these. Unparseable input keeps its raw text rather than collapsing every
 *  bad stamp onto NaN. */
function instantKey(at: string): string {
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? `raw:${at}` : `ms:${ms}`
}

/** Fold each piece of work that reached this machine twice back down to one.
 *
 *  This is load-bearing now, and more so than when the card was keyed on the
 *  project. Then a twin at worst produced a second card. Keyed on the person,
 *  both copies land in the SAME card and every aggregate is computed over
 *  both: the files list would count each path twice, a session's prompts would
 *  be listed twice, and "18 rows" of work would report as 36.
 *
 *  mappers.collapseSessionCheckpoints used to hide this by accident -- it
 *  reduced a session to its single newest row, folding the twins as a side
 *  effect -- but every entry off /api/feed is one captured PROMPT
 *  (lib/memorydb.js mints one per prompt event and attaches the summary to
 *  whichever one the Stop hook landed on), so collapsing to one row per
 *  session throws away every prompt but the last. The prompt roll-up is made
 *  of exactly that data, so FeedPage no longer collapses, and the twins it was
 *  incidentally hiding have to be folded here on purpose.
 *
 *  Same work means: the same non-null session id, the same project by the
 *  precedence above, and the same instant. A session id is the strongest
 *  identity in this data, and two different prompts of one session sharing a
 *  millisecond is not a thing that happens.
 *
 *  A session-less row (`session: null`, the rare bare-plumbing entry) is never
 *  folded, for the reason collapseSessionCheckpoints documents: such a row is
 *  only ever itself, and keying it off '' would fold every unrelated one in
 *  the day together.
 *
 *  The survivor is the row WITH a projectPath, i.e. the local one: its `ask`
 *  was never clipped for the wire, and its liveness is judged on the session's
 *  own events rather than on when a row happened to sync (lib/feed.js
 *  liveBasis). Input order is otherwise preserved. */
export function dedupeSyncedTwins(entries: FeedEntry[]): FeedEntry[] {
  const out: FeedEntry[] = []
  const indexByKey = new Map<string, number>()
  for (const e of entries) {
    if (!e.session) {
      out.push(e)
      continue
    }
    const key = `${e.session}\x00${projectPart(e)}\x00${instantKey(e.at)}`
    const seenAt = indexByKey.get(key)
    if (seenAt === undefined) {
      indexByKey.set(key, out.length)
      out.push(e)
      continue
    }
    if (!out[seenAt].projectPath && e.projectPath) out[seenAt] = e
  }
  return out
}

// ---------------------------------------------------------------------------
// The overview sentence
// ---------------------------------------------------------------------------

/** Said when the day has entries but none of them landed any text. Plain, and
 *  deliberately not a sentence about the work: nothing here knows what the work
 *  was, and inventing a summary is the one thing this must never do. */
export const NO_SUMMARY_OVERVIEW = 'No summary yet for this day.'

/** Said when the day's rows arrived as ciphertext this machine could not read.
 *  A DIFFERENT fact from the line above, and the reason `undecryptable` is
 *  carried at all: an EntryRow renders both states as "No summary yet", so a
 *  reader has no way to tell a quiet day from a broken key. Names the state
 *  without claiming to know what was in it. */
export const OPAQUE_OVERVIEW = 'Encrypted: these sessions could not be read on this machine.'

export type DayOverviewKind = 'distilled' | 'summary' | 'undecryptable' | 'none'

export interface DayOverview {
  kind: DayOverviewKind
  /** The sentence to render. For 'distilled'/'summary' it is one existing
   *  entry's `outcome` VERBATIM; for the other two it is the matching constant
   *  above. Never assembled from more than one entry. */
  text: string
}

// THE RULE, in order, and it is a PICK rather than a derivation -- no
// summarizing pass, no concatenation of several rows into a sentence nobody
// wrote:
//
//   1. the NEWEST entry that is distilled AND carries an outcome. `distilled`
//      is the daemon's own marker that a real summarizing pass ran (lib/feed.js;
//      it is the same gate mappers.ts's hasSummary uses), so this is "the best
//      settled statement of where the day ended up".
//   2. else the NEWEST entry carrying any outcome at all. A harvested line is
//      weaker than a distilled one but it is still something a human wrote
//      about this work, which beats a placeholder.
//   3. else, if any of the day's rows failed to decrypt, say exactly that.
//   4. else say the day is un-summarized, plainly.
//
// Newest-first at both steps because a day's later work supersedes its earlier
// work: the last thing a session landed is what "where does this stand" means.
//
// Steps 1 and 2 both require a NON-EMPTY outcome and explicitly skip an
// undecryptable row. An undecryptable row already arrives with an empty
// outcome (the daemon nulls the content fields fail-closed rather than trust
// the server's plaintext columns), so the second condition is belt-and-braces
// against a future row that carries server-supplied text -- text this client
// could not verify, and which must never become the day's headline.
function overviewCandidates(entries: FeedEntry[]): FeedEntry[] {
  return [...entries]
    .filter(e => !!e.outcome && !e.undecryptable)
    .sort((a, b) => b.at.localeCompare(a.at))
}

export function pickDayOverview(entries: FeedEntry[]): DayOverview {
  const candidates = overviewCandidates(entries)
  const best = candidates.find(e => e.distilled) ?? candidates[0]
  if (best) {
    return { kind: best.distilled ? 'distilled' : 'summary', text: best.outcome }
  }
  if (entries.some(e => e.undecryptable)) {
    return { kind: 'undecryptable', text: OPAQUE_OVERVIEW }
  }
  return { kind: 'none', text: NO_SUMMARY_OVERVIEW }
}

// ---------------------------------------------------------------------------
// Text helpers, mirroring features/session/distill.ts. They are duplicated
// rather than imported because distill.ts keeps them private and every public
// entry point there takes a Session, a different shape from a feed entry (and
// one carrying a `checkpoints` trail that /api/feed does not ship at all).
// The rules are the same ones, for the same reasons, so they must stay in
// step: a run of whitespace is not a line break, and case plus trailing
// punctuation is not a difference a reader would call distinct.
// ---------------------------------------------------------------------------

function oneLine(text: string | null | undefined): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function sameLineKey(text: string): string {
  return oneLine(text).toLowerCase().replace(/[.!?;:,\s]+$/, '')
}

// ---------------------------------------------------------------------------
// Files touched
// ---------------------------------------------------------------------------

/** How many paths the expanded card names before the rest go behind "+N
 *  more". A day of real work touches 30 to 60 files; an unbounded list is a
 *  scroll, not an answer, and the point of this section is the blast radius at
 *  a glance. */
export const DAY_FILE_LIMIT = 12

/** Supporting churn that tends to dominate a planning-heavy day. Same ranking
 *  EntryRow.rowFiles applies for the same reason, used here only to break ties
 *  between files touched the same number of times. */
const SUPPORTING = /^(docs?|specs?|\.github|\.claude|claude)\//

export interface DayFile {
  file: string
  /** Entries that named this file. Most-touched first is the ordering the
   *  section promises, and it is a real signal: the file a day kept coming
   *  back to is the file the day was about. */
  touches: number
  /** The agent's own one-line highlight for this file, off `changes[].note`
   *  (lib/changes.js). Null when no session wrote one. */
  note: string | null
}

export function dayFiles(entries: FeedEntry[]): DayFile[] {
  const byFile = new Map<string, DayFile>()
  for (const e of entries) {
    for (const file of e.files) {
      if (!file) continue
      const seen = byFile.get(file)
      if (seen) seen.touches++
      else byFile.set(file, { file, touches: 1, note: null })
    }
    // Notes ride on `changes`, which can name a file the entry's `files` array
    // does not, so this both annotates and (rarely) adds.
    for (const c of e.changes) {
      if (!c.file) continue
      const seen = byFile.get(c.file)
      if (!seen) byFile.set(c.file, { file: c.file, touches: 1, note: oneLine(c.note) || null })
      else if (!seen.note && c.note) seen.note = oneLine(c.note)
    }
  }
  return [...byFile.values()].sort((a, b) => {
    if (a.touches !== b.touches) return b.touches - a.touches
    const aSupporting = SUPPORTING.test(a.file) ? 1 : 0
    const bSupporting = SUPPORTING.test(b.file) ? 1 : 0
    if (aSupporting !== bSupporting) return aSupporting - bSupporting
    return a.file.localeCompare(b.file)
  })
}

// ---------------------------------------------------------------------------
// Sessions and their prompts
// ---------------------------------------------------------------------------

/** Longest prompt rendered whole in a day card. A captured prompt runs to
 *  thousands of characters (someone pastes a stack trace, or a whole spec),
 *  and one of those unclipped is taller than everything else on the card put
 *  together. The session page renders the full chain, and the session header
 *  above each group links straight at it, so nothing is lost, only deferred. */
const DAY_PROMPT_MAX = 200

export interface DayPrompt {
  key: string
  at: string
  /** The prompt as asked, clipped on a word boundary at DAY_PROMPT_MAX.
   *  Verbatim otherwise: never re-worded, never summarized. */
  text: string
  clipped: boolean
}

export interface DaySession {
  /** Stable React key. The session id where there is one, the entry id where
   *  there is not, so two session-less rows never share a key. */
  key: string
  /** The raw session id, null for a bare-plumbing row. Null means there is no
   *  session page to link at, and the header renders without a link. */
  session: string | null
  tool: string
  /** Which project this session ran in, display name. A card spans projects
   *  now, so a session group that does not say which one it belongs to leaves
   *  the reader guessing; when the card has one project it is redundant, and
   *  the renderer drops it there rather than repeating it per group. */
  project: string
  /** Oldest and newest entry in the group. Equal when the session landed one
   *  entry, which the renderer shows as a single time rather than a range. */
  startedAt: string
  endedAt: string
  live: boolean
  /** Oldest first: a session's prompts are a sequence, and reading them
   *  backwards reads as nonsense. Same call distill.ts makes for the
   *  checkpoint trail, and the opposite of the newest-first rule the SESSIONS
   *  themselves follow, which is a scan. */
  prompts: DayPrompt[]
  entries: FeedEntry[]
}

/** Group a day's entries into its sessions, newest session first, each
 *  session's own entries oldest first. */
export function daySessions(entries: FeedEntry[]): DaySession[] {
  const byKey = new Map<string, FeedEntry[]>()
  for (const e of entries) {
    const key = e.session || `entry:${e.id}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(e)
    else byKey.set(key, [e])
  }

  const sessions: DaySession[] = []
  for (const [key, bucket] of byKey) {
    const oldestFirst = [...bucket].sort((a, b) => a.at.localeCompare(b.at))
    const newest = oldestFirst[oldestFirst.length - 1]
    const prompts: DayPrompt[] = []
    const seen = new Set<string>()
    for (const e of oldestFirst) {
      // `intent` is the entry's captured ask (mappers.intentOf already drops
      // blanks and the daemon's "(not captured)" placeholder), so an entry
      // that never carried a prompt contributes nothing rather than a blank
      // bullet. Duplicates are dropped: a re-summarized session can land the
      // same ask twice.
      const flat = oneLine(e.intent)
      if (!flat) continue
      const dedupeKey = sameLineKey(flat)
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const clipped = flat.length > DAY_PROMPT_MAX
      prompts.push({ key: e.id, at: e.at, text: clipped ? clipWords(flat, DAY_PROMPT_MAX) : flat, clipped })
    }
    sessions.push({
      key,
      session: newest.session,
      tool: newest.tool,
      project: newest.project,
      startedAt: oldestFirst[0].at,
      endedAt: newest.at,
      live: oldestFirst.some(e => e.live),
      prompts,
      entries: oldestFirst,
    })
  }
  return sessions.sort((a, b) => b.endedAt.localeCompare(a.endedAt))
}

// ---------------------------------------------------------------------------
// Bullet points: what was done
// ---------------------------------------------------------------------------

/** Longest bullet rendered whole. A bullet longer than this is a paragraph,
 *  and a paragraph is the thing this list exists instead of. */
const DAY_BULLET_MAX = 220

export interface DayBullet {
  key: string
  text: string
}

/** One field's worth of points, and ONLY when the writer actually made a list.
 *
 *  A newline is the authoritative boundary, so text written from v0.2.8 onward
 *  splits into the points its author wrote. Older text cannot: before daf624a,
 *  digest.clip and digest.plainText both ran replace(/\s+/g, ' ') on every
 *  path out of storage, so every multi-line note in the archive was flattened
 *  to one paragraph and the structure is not recoverable. Sentence-splitting
 *  that paragraph back apart is what produces the shredded half-sentences this
 *  list was rejected for once already, so it is not done here: flattened prose
 *  is taken WHOLE when it is already short enough to read as a bullet, and
 *  otherwise left to the session's own outcome line, which says the same thing
 *  in one line by construction. */
function listPoints(text: string | null): string[] {
  const raw = String(text || '')
  if (!raw.trim()) return []
  if (raw.includes('\n')) {
    return raw.split('\n').map(p => oneLine(p).replace(/^[-*•]\s*/, '')).filter(Boolean)
  }
  const flat = oneLine(raw).replace(/^[-*•]\s*/, '')
  return flat && flat.length <= DAY_BULLET_MAX ? [flat] : []
}

/** The day's bullets: what this person actually did, aggregated across every
 *  session of the day into one skimmable list, oldest work first.
 *
 *  Each session contributes its OUTCOME line first. That line is the headline
 *  the distiller wrote, or the first sentence of its summary (mappers.outcomeOf
 *  makes that choice once, for the whole app), which is already "what was
 *  fixed" in one line and is the shape Andrew asked for: "Added a back button
 *  to the daycards in feed". Its decisions and gotchas follow, but only where
 *  they arrived as a real list, per listPoints above.
 *
 *  Deduped across the whole day, and any bullet that merely restates the
 *  card's overview sentence is dropped: that sentence is already the first
 *  thing on the card, and repeating it under a heading reads as a rendering
 *  bug. Not capped, because this is the substance of the card, and a cap would
 *  hide the day's work behind no control at all.
 *
 *  distilledBullets (features/session/distill.ts) is the closer relative and
 *  would be the better source, since a checkpoint trail is per-checkpoint
 *  distilled text. It is not reachable from here: /api/feed carries no
 *  `checkpoints` field at all (lib/feed.js normalizeLocal/normalizeTeam ship
 *  neither), so the trail exists only on the session-detail payload. */
export function dayBullets(sessions: DaySession[], overview: DayOverview): DayBullet[] {
  const out: DayBullet[] = []
  const seen = new Set<string>()
  if (overview.kind === 'distilled' || overview.kind === 'summary') seen.add(sameLineKey(overview.text))

  const push = (text: string, keyBase: string) => {
    const flat = oneLine(text)
    if (!flat) return
    const key = sameLineKey(flat)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ key: `${keyBase}:${out.length}`, text: flat.length > DAY_BULLET_MAX ? clipWords(flat, DAY_BULLET_MAX) : flat })
  }

  // Oldest session first, so the list reads in the order the work happened
  // (distilledBullets' rule). `sessions` arrives newest-first for the scan
  // above it, so this walks it backwards rather than re-sorting a copy.
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]
    // Newest outcome in the session, since a later checkpoint supersedes an
    // earlier one, which is the same newest-wins rule pickDayOverview follows.
    for (let j = session.entries.length - 1; j >= 0; j--) {
      const outcome = session.entries[j].outcome
      if (!outcome) continue
      push(outcome, session.key)
      break
    }
    for (const e of session.entries) {
      for (const point of listPoints(e.decisions)) push(point, session.key)
      for (const point of listPoints(e.gotchas)) push(point, session.key)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The card's face
// ---------------------------------------------------------------------------

/** How many sentences of intent the card's face carries: "1-3 sentances
 *  depending on how much has been done that day".
 *
 *  "How much has been done" wants a PROMPT COUNT, and there is no such field:
 *  /api/feed carries none (nothing in lib/feed.js normalizeLocal/normalizeTeam
 *  emits one), and adding the daemon field was deliberately deferred. The
 *  proxy used instead is the DISTINCT SESSION COUNT, chosen over the two other
 *  candidates because it is the only one that tracks "separate pieces of work"
 *  rather than volume: entry count rises with a chatty session that did one
 *  thing, and file count rises with a single wide refactor.
 *
 *  Kept as its own named function, doing nothing else, so that swapping the
 *  proxy when a real prompt count lands is a one-line change with its own
 *  test rather than an archaeology exercise. */
export function dayIntentSentences(sessionCount: number): number {
  if (sessionCount >= 4) return 3
  if (sessionCount >= 2) return 2
  return 1
}

/** The card's second line: the day's own bullets, as far as the rule above
 *  allows, joined into sentences.
 *
 *  Every sentence is text the distiller wrote about work that happened, taken
 *  whole. Nothing here composes a claim out of fragments, and nothing is said
 *  at all when the day landed nothing -- an empty string, which the renderer
 *  drops rather than filling with a placeholder.
 *
 *  Terminal punctuation is added only where the source line lacks it. A
 *  clipped line already ends in an ellipsis, and "…." is a rendering bug. */
export function dayIntent(bullets: DayBullet[], sessionCount: number): string {
  return bullets
    .slice(0, dayIntentSentences(sessionCount))
    .map(b => (/[.!?…]$/.test(b.text) ? b.text : `${b.text}.`))
    .join(' ')
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface DayCard {
  /** dayCardKey -- stable across renders, so React keeps a card's identity
   *  across a poll that appends new entries to it. */
  key: string
  /** The same key as a URL path segment, which is what the day view is
   *  addressed by. Carried on the card rather than derived at each link, so
   *  the feed's href and the day view's lookup can never disagree. */
  slug: string
  author: string
  authorId: string
  /** Every project this person touched today, busiest first. A card spans
   *  projects, so there is no single `project` to name. */
  projects: DayProject[]
  /** The card's NEWEST entry's timestamp. This is what orders the cards and
   *  what the day divider above them is derived from. */
  at: string
  /** True when ANY entry is live. Note what the daemon's flag means for a
   *  teammate: 'synced-row', i.e. one of their rows reached this machine
   *  recently (lib/feed.js normalizeTeam's liveBasis). It is NOT presence, and
   *  no copy anywhere may say a teammate is working right now. */
  live: boolean
  /** Distinct sessions, not rows. */
  sessionCount: number
  overview: DayOverview
  /** The card's face, under the overview sentence: 1 to 3 sentences of what
   *  was actually done, one step more specific than the sentence above it.
   *  Empty when the day landed nothing to say. */
  intent: string
  files: DayFile[]
  bullets: DayBullet[]
  /** Newest session first, each holding its own prompts oldest-first. Every
   *  entry of the day is reachable through these, so the card carries no
   *  second flat copy of them. */
  sessions: DaySession[]
}

/** Fold a flat feed into day cards, newest activity first.
 *
 *  Callers pass entries that have been through dedupeById; the synced-twin
 *  fold happens HERE rather than at the caller, because every count on the
 *  card is derived after it and a caller that forgot would double every one of
 *  them. It is idempotent, so a caller folding them as well is harmless. */
export function buildDayCards(rawEntries: FeedEntry[]): DayCard[] {
  const entries = dedupeSyncedTwins(rawEntries)
  const byKey = new Map<string, FeedEntry[]>()
  for (const e of entries) {
    const key = dayCardKey(e)
    const bucket = byKey.get(key)
    if (bucket) bucket.push(e)
    else byKey.set(key, [e])
  }

  const cards: DayCard[] = []
  for (const [key, bucket] of byKey) {
    // Sorted here rather than trusting the caller's order -- the same
    // defensive stance groupByDay takes, and `at` is what stamps the card.
    const sorted = [...bucket].sort((a, b) => b.at.localeCompare(a.at))
    const newest = sorted[0]
    const sessions = daySessions(sorted)
    const overview = pickDayOverview(sorted)
    const bullets = dayBullets(sessions, overview)
    cards.push({
      key,
      slug: daySlug(key),
      author: newest.author,
      authorId: newest.authorId,
      projects: dayProjects(sorted),
      at: newest.at,
      live: sorted.some(e => e.live),
      // Sessions, not rows: a session id identifies a session, and a
      // session-less row (the rare bare-plumbing entry) is only ever itself.
      // daySessions keys such a row off its own entry id for that reason, so
      // counting groups here can never fold unrelated ones into one session.
      sessionCount: sessions.length,
      overview,
      intent: dayIntent(bullets, sessions.length),
      files: dayFiles(sorted),
      bullets,
      sessions,
    })
  }
  return cards.sort((a, b) => b.at.localeCompare(a.at))
}
