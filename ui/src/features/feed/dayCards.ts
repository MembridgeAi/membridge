import { localDayKey, localDayRangeMs } from '../../data/localTime'
import { clipWords } from '../../data/mappers'
import type { DayDigest, FeedEntry } from '../../data/types'

// Consolidated day cards: one card per PERSON per local calendar day, across
// every project they touched. The feed's problem was volume of the wrong
// kind -- one teammate's afternoon landed as eight near-identical rows, and
// "what did Marco do today" took scrolling to answer. The card answers it in
// one sentence and keeps the detail one click away, on the day view.
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
// two are one person's morning and afternoon. The card is keyed on the person
// alone and carries the projects it spans as a LIST (dayProjects below), so
// that same feed renders as two cards.
//
// Everything here is pure and deterministic: same entries in, same cards out,
// no clock read, no model called. FeedPage owns the rendering and the day
// dividers above these cards; DayPage renders the detail.

// ---------------------------------------------------------------------------
// Grouping key
// ---------------------------------------------------------------------------

/** Normalize one component of the key: ids are compared exactly, display names
 *  case-insensitively, and whitespace never decides identity. */
function part(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

// The author id where there is one, the display name as a fallback.
//
// The id is what identifies a person: it survives a rename, where the display
// name does not, and it cannot collide the way two people called "Marco" can.
// The two live in separate namespaces (`id:` / `name:`) so a person whose
// display name happens to equal someone else's user id can never collide, and
// so that a card can never be half-keyed one way and half the other.
//
// The fallback is DEFENSIVE ONLY, and is deliberately not justified by any
// claim about the data. A previous version of this comment said authorId is
// null on team rows pushed before the author_id column existed; that is not
// true and was never true. `author_id uuid not null references auth.users(id)`
// is in the original CREATE TABLE (supabase/schema.sql:46), the RLS insert
// policy independently requires author_id = auth.uid(), and lib/teamsync.js
// sets it unconditionally. A team row therefore cannot arrive without one. The
// fallback stays because '' is a worse key than a name if one ever does, not
// because anything is known to produce it.
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
 *  one person's single afternoon in two. Keying on projectId first folds them,
 *  because projectId is the one component both shapes carry.
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

/** The local calendar day an entry belongs to, or null when its timestamp is
 *  not a time.
 *
 *  Both normalizers in lib/feed.js emit `ts: e.ts || ''`, and `new Date('')` is
 *  an Invalid Date whose local fields are all NaN. Unguarded that rendered a
 *  day divider reading "UNDEFINED UNDEFINED NAN" and gave the card a key of
 *  "NaN-NaN-NaN", which sorts ABOVE every real date and so parks the broken row
 *  at the top of the feed forever. Null is the honest answer, and every caller
 *  decides what to do with it rather than each re-deriving the check. */
export function entryDayKey(e: Pick<FeedEntry, 'at'>): string | null {
  const ms = Date.parse(e.at)
  return Number.isNaN(ms) ? null : localDayKey(new Date(ms))
}

/** The day component of an undated row's key. A single shared bucket, so such
 *  rows are visible in one place rather than scattered, and a string that
 *  sorts BELOW every real ISO date so they collect at the end of the feed
 *  instead of displacing today. */
export const UNDATED_DAY = 'undated'

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
  return `${entryDayKey(e) ?? UNDATED_DAY}${KEY_SEP}${authorPart(e)}`
}

/** The daemon's day-digest key, in this module's own key form.
 *
 *  The digest is keyed on exactly the same two things a card is -- the local
 *  day and the author part, `id:<uuid>` or `name:<display name>` -- but joined
 *  with a SPACE where dayCardKey joins with NUL. Only the FIRST space is the
 *  separator: the day half is YYYY-MM-DD and cannot contain one, while the
 *  author half routinely does ("name:marco melika"), so a split-on-every-space
 *  would shred exactly the keys the fallback exists for.
 *
 *  ONE place, deliberately. Reconciling the two separators at each join site is
 *  how a digest silently stops matching any card and every day quietly falls
 *  back to the client's own pick, with nothing on screen to say so. */
export function digestKey(key: string): string {
  const raw = String(key || '')
  const at = raw.indexOf(' ')
  return at === -1 ? raw : `${raw.slice(0, at)}${KEY_SEP}${raw.slice(at + 1)}`
}

/** Separator between the slug's parts, below. base64url's alphabet is
 *  `A-Za-z0-9-_` and contains no tilde, so the separator can never appear
 *  inside a part and two different keys can never slug the same. */
const SLUG_SEP = '~'

/** One key part as base64url: URL-safe, and -- the whole point -- carrying no
 *  percent escape for anything downstream to decode. */
function encodePart(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The inverse, for the ONE reader that needs it (daySlugDay). Returns null
 *  rather than throwing for anything that is not a part this module minted:
 *  a slug arrives from the address bar, so it is hand-editable text. */
function decodePart(value: string): string | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
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
 *  bug this design already had once. The slug does not travel to a server, it
 *  travels through the ROUTER, and wouter runs decodeURI over
 *  location.pathname before it matches (wouter/src/paths.js). Every percent
 *  triple outside the reserved set is therefore already gone by the time
 *  DayPage sees the param:
 *
 *      "Marco Melika"   ->  %20      ->  a literal space in params.daySlug
 *      "Renée"          ->  %C3%A9   ->  the literal accented character
 *      "o~brien"        ->  %7E      ->  a literal tilde, which defeated the
 *                                        separator escaping entirely
 *
 *  while the card's own slug still carried the escapes, so the two sides never
 *  matched and clicking a visible card answered "That day is not in view".
 *  base64url is a fixed point of decodeURI -- there is no percent escape in it
 *  to decode -- so the bytes the router hands back are the bytes the card
 *  minted. It reaches the fallback names hardest (authorPart falls back to the
 *  display name when there is no id), which is exactly where spaces and accents
 *  live.
 *
 *  One-way as a whole: nothing rebuilds a key from a slug, and DayPage finds
 *  its card by matching slugs, so a slug that decodes is never confused with a
 *  day that exists. daySlugDay below reads back the day HALF only, for a
 *  bounded question that a slug comparison cannot answer. */
export function daySlug(key: string): string {
  return key.split(KEY_SEP).map(encodePart).join(SLUG_SEP)
}

/** The LOCAL calendar day a slug names ("2026-07-29"), or null when it names
 *  none -- including the UNDATED_DAY bucket, which is not a day and has no
 *  instants to page towards.
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

/** Comparable instant, not the raw string.
 *
 *  CONFIRMED against real Postgres 17 (what Supabase runs), not inferred:
 *
 *      '2026-08-05T12:00:00.550Z'::timestamptz  ->  "2026-08-05T12:00:00.55+00:00"
 *
 *  Two transformations at once -- `Z` becomes `+00:00`, and the trailing zero
 *  of `.550` is trimmed to `.55` -- and PostgREST serializes every response
 *  through that path. So the twin of a local row is the same moment written
 *  differently, which makes it a DIFFERENT streamEntryId (mappers.streamEntryId
 *  is `session|ts`), which is why FeedPage's dedupeById never caught these.
 *  Unparseable input keeps its raw text rather than collapsing every bad stamp
 *  onto NaN. */
function instantKey(at: string): string {
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? `raw:${at}` : `ms:${ms}`
}

/** Fold each piece of work that reached this machine twice back down to one.
 *
 *  This is load-bearing now, and more so than when the card was keyed on the
 *  project. Then a twin at worst produced a second card. Keyed on the person,
 *  both copies land in the SAME card and every aggregate is computed over
 *  both: the files list counts each path twice, a session's prompts are listed
 *  twice, and the day view shows the same session once with the verbatim
 *  prompt and once with "(prompt not shared)" -- which reads as two different
 *  pieces of work by the same person at the same second.
 *
 *  mappers.collapseSessionCheckpoints used to hide this by accident, and that
 *  single line was the ONLY thing preventing it: it reduced a session to its
 *  newest row, and the local row deterministically sorts above its twin
 *  (`Z`, a digit and `.` all exceed `+`), so the local row with the verbatim
 *  prompt is what survived. It is the line the feed no longer runs -- every
 *  entry off /api/feed is one captured PROMPT, so collapsing on the session id
 *  alone throws away every prompt but the last, which is exactly the data the
 *  day view's roll-up is made of. So the twins it was incidentally hiding have
 *  to be folded here, on purpose, on a key that survives the round trip.
 *
 *  Nothing upstream folds them either: team_feed's WHERE clause has no
 *  self-exclusion (025_enforce_project_access.sql), so the twin genuinely
 *  reaches the client, and both the daemon's own fold and FeedPage's
 *  dedupeById key on the raw ts string, so all three fail identically.
 *
 *  A daemon-side fix is in flight and this does not wait on it, and must not:
 *  rows already in a client's cache carry both forms, and a UI that is only
 *  correct against a fixed daemon is not correct.
 *
 *  Same work means: the same session, by the same person, in the same project
 *  by the precedence above, at the same instant.
 *
 *  A session-less row (`session: null`, the rare bare-plumbing entry) is
 *  folded too, under one shared bucket name. This is the one place the usual
 *  "such a row is only ever itself" rule would be wrong: it is that rule that
 *  makes daySessions key such a row off `entry:${id}`, and that id EMBEDS the
 *  ts, so a session-less row and its twin would key differently there and
 *  render twice. The instant plus the author plus the project is what makes
 *  this safe where keying off '' alone would not be: two unrelated
 *  session-less rows by one person in one project sharing a millisecond is not
 *  a distinction any surface could draw anyway.
 *
 *  The survivor is the row WITH a projectPath, i.e. the local one: its `ask`
 *  was never clipped for the wire, and its liveness is judged on the session's
 *  own events rather than on when a row happened to sync (lib/feed.js
 *  liveBasis). Input order is otherwise preserved. */
export function dedupeSyncedTwins(entries: FeedEntry[]): FeedEntry[] {
  const out: FeedEntry[] = []
  const indexByKey = new Map<string, number>()
  for (const e of entries) {
    const session = e.session || 'no-session'
    const key = [session, authorPart(e), projectPart(e), instantKey(e.at)].join(KEY_SEP)
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
// The projects a day spans
// ---------------------------------------------------------------------------

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

/** Every project a day's entries touched, busiest first.
 *
 *  A LIST, never a single name. The card used to copy `project` and
 *  `projectPath` off its newest entry, which was meaningful only while the
 *  project was part of the key. It is not any more: a day of 7 membridge
 *  sessions and 1 sublease session would have rendered a card labelled
 *  "sublease" as if that were the scope of the whole day. */
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
  /** The sentence to render. From the daemon's day digest where there is one;
   *  otherwise one existing entry's `outcome` VERBATIM for
   *  'distilled'/'summary', or the matching constant above. Never assembled
   *  here out of more than one entry. */
  text: string
  /** Which entry the text came from, null for the two placeholder kinds. Lets
   *  a reader be sent to the session the sentence actually describes, and lets
   *  the bullet list below know which line it is already showing. For a digest
   *  it is `sources[0].entryId`, which is the same streamEntryId. */
  fromEntryId: string | null
  /** Non-null when the sentence demonstrably does not cover the whole day, in
   *  the daemon's own words. See coverageNoteFor below for when that is, and
   *  for why the daemon's note is NOT simply rendered whenever it is set. */
  coverageNote: string | null
  /** Where the sentence came from. 'digest' is the daemon's general day
   *  header; 'pick' is this module choosing one session's outcome, which is
   *  the fallback whenever no digest arrived for the day. */
  source: 'digest' | 'pick'
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
//
// This is the FALLBACK now. What the owner asked the card's first line to be
// is a general sentence over the WHOLE day ("Worked on UI fixes, app install
// and dmg"), which no pick of one session's outcome can be -- and which cannot
// be composed here either, because concatenating headline fragments produces
// garbage on real rows, a rule this module has a test enforcing. The daemon
// derives that sentence (lib/digest.js) and serves it as `dayDigests`. When one
// arrives for a day it is used verbatim; when none does -- an older daemon, or
// a day the digest could not cover -- this pick is what the card falls back to,
// because a real session's outcome beats a blank line.
function overviewCandidates(entries: FeedEntry[]): FeedEntry[] {
  return [...entries]
    .filter(e => !!e.outcome && !e.undecryptable)
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** The daemon's `kind` back into this module's vocabulary. It reuses these
 *  four values verbatim, so the mapping is identity -- but it arrives as an
 *  unvalidated string off the wire, and a value this build has never heard of
 *  must degrade to the weakest honest reading rather than be rendered as a CSS
 *  class name. 'summary' is that reading: there is text, and nothing claims it
 *  was distilled. */
function digestKind(kind: string): DayOverviewKind {
  return kind === 'distilled' || kind === 'undecryptable' || kind === 'none' ? kind : 'summary'
}

/** When the day's sentence gets a coverage warning under it, and it is a
 *  NARROWER rule than "whenever the daemon set one". Measured against Andrew's
 *  real feed, the naive version fired on 3 of 6 cards, which is the rate at
 *  which a warning stops being read.
 *
 *  The daemon derives a digest from the ONE page it is served with, and
 *  `complete` means only "this page reached back past the START of this day"
 *  (lib/digest.js: `!(partialDay && partialDay === bucket.day)`). It is a fact
 *  about a page, not about a day. A client holds several pages and may have
 *  loaded the rest itself, at which point rendering that page's note verbatim
 *  warns about a gap that no longer exists. That is what made it fire on cards
 *  showing a complete day.
 *
 *  So, in order:
 *
 *   1. Nothing on a 'none' or 'undecryptable' header. There is no sentence for
 *      the note to qualify: the header already says nothing is known, and
 *      "this summary is partial" under "No summary yet for this day" is a
 *      warning about the coverage of a non-existent summary.
 *   2. `omittedSessions` always warns. The daemon HAD those statements and
 *      dropped them to its own clause cap, so no amount of paging brings them
 *      back. This is the one coverage fact a client cannot supersede.
 *   3. Truncation warns only while this client has NOT loaded past the start of
 *      the day itself. `dayFullyLoaded` is that question, answered from the
 *      entries actually in hand.
 *
 *  The daemon's own wording is used throughout rather than a second string
 *  invented here: two sources of copy for one condition is how they drift. */
function coverageNoteFor(digest: DayDigest, kind: DayOverviewKind, dayFullyLoaded: boolean): string | null {
  if (kind === 'none' || kind === 'undecryptable') return null
  if (digest.omittedSessions > 0) return digest.coverageNote
  if (!digest.complete && !dayFullyLoaded) return digest.coverageNote
  return null
}

export function pickDayOverview(
  entries: FeedEntry[],
  digest?: DayDigest | null,
  opts: { dayFullyLoaded?: boolean } = {},
): DayOverview {
  if (digest) {
    const kind = digestKind(digest.kind)
    return {
      kind,
      text: digest.text,
      fromEntryId: digest.sources[0]?.entryId ?? null,
      coverageNote: coverageNoteFor(digest, kind, opts.dayFullyLoaded !== false),
      source: 'digest',
    }
  }
  const candidates = overviewCandidates(entries)
  const best = candidates.find(e => e.distilled) ?? candidates[0]
  if (best) {
    return {
      kind: best.distilled ? 'distilled' : 'summary',
      text: best.outcome,
      fromEntryId: best.id,
      coverageNote: null,
      source: 'pick',
    }
  }
  if (entries.some(e => e.undecryptable)) {
    return { kind: 'undecryptable', text: OPAQUE_OVERVIEW, fromEntryId: null, coverageNote: null, source: 'pick' }
  }
  return { kind: 'none', text: NO_SUMMARY_OVERVIEW, fromEntryId: null, coverageNote: null, source: 'pick' }
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

/** How many paths the day view names before the rest go behind "+N more". A
 *  day of real work touches 30 to 60 files; an unbounded list is a scroll, not
 *  an answer, and the point of that section is the blast radius at a glance. */
export const DAY_FILE_LIMIT = 12

/** A path as its last two segments, prefixed '…/' when segments were
 *  dropped. Clipped from the LEFT, always, because the filename is the one
 *  part that identifies a file and a right clip eats exactly that. Harder
 *  than shortPath on purpose: this runs three-up on a 10px line, where
 *  shortPath's 34-character budget would spend the whole row on one path. */
export function tailPath(file: string): string {
  const parts = String(file || '').split('/').filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  const tail = parts.slice(-2).join('/')
  return parts.length > 2 ? `…/${tail}` : tail
}

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
    // does not, so this both annotates and (rarely) adds. A note is a
    // description, not a visit, so it never increments `touches`.
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

/** Longest prompt rendered whole on the day view. A captured prompt runs to
 *  thousands of characters (someone pastes a stack trace, or a whole spec),
 *  and one of those unclipped is taller than everything else on the page put
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
 *  session's own entries oldest first.
 *
 *  This is what replaces the collapse the feed no longer runs, and it is the
 *  shape the owner asked for: "all their sessions ... aggregated into bullet
 *  points and main files touched, then prompts underneath". memorydb.buildEntries
 *  emits ONE entry per PROMPT, so a session with ten prompts is ten entries
 *  sharing one session id. collapseSessionCheckpoints keyed on that id alone
 *  and kept only the newest, which discarded nine of the ten. Grouping keeps
 *  all ten while still showing the session once, so the card's "1 session" and
 *  the body underneath it agree. */
export function daySessions(entries: FeedEntry[]): DaySession[] {
  const byKey = new Map<string, FeedEntry[]>()
  for (const e of entries) {
    // A session id identifies a session; a session-less row (the rare
    // bare-plumbing entry) is only ever itself. Falling back to '' would fold
    // every session-less row in a day into ONE session -- the same
    // non-scoped-key mistake collapseSessionCheckpoints documents.
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
      // bullet. Duplicates are dropped: a re-summarized session lands the same
      // ask on every one of its checkpoint rows.
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
// Tools that ran
// ---------------------------------------------------------------------------

/** Distinct tools that ran this day, busiest first (session count desc,
 *  then name asc). Blank tool names dropped. */
export function dayTools(sessions: DaySession[]): string[] {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const tool = String(s.tool || '').trim()
    if (!tool) continue
    counts.set(tool, (counts.get(tool) ?? 0) + 1)
  }
  // Sessions, not rows, and the tie breaks on the name: a chatty session must
  // not outrank a quiet one, and two tools used once each have to order the
  // same way on every poll or the card's line reshuffles under the reader.
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([tool]) => tool)
}

/** How many tools the card names before the rest become a count. Two is
 *  what fits beside three paths at the 900px floor. */
export const TOOL_LIMIT = 2

/** "Claude Code", "Claude Code, Codex", "Claude Code, Codex +1".
 *  Same eliding shape as projectLabel, deliberately: two lists on one card
 *  that elide differently read as two different kinds of thing. */
export function toolLabel(tools: string[]): string {
  const shown = tools.slice(0, TOOL_LIMIT)
  const hidden = tools.length - shown.length
  return hidden > 0 ? `${shown.join(', ')} +${hidden}` : shown.join(', ')
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

/** One session's share of the day's bullets, and the session that produced
 *  them. The day view renders these under a row that links at the session, so
 *  a reader who wants the whole run behind a point is one click from it
 *  instead of one scroll and then one click. */
export interface DayBulletGroup {
  session: DaySession
  bullets: DayBullet[]
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

/** The day's bullets: what this person actually did, GROUPED under the session
 *  that produced each of them, oldest session first.
 *
 *  Grouped rather than flat because the flat list could not say which run a
 *  point came from, and recovering that from the output meant parsing the key
 *  prefix, which is not a contract this module offers. The day view renders
 *  these under a row that links at the session, so a reader who wants the run
 *  behind a point is one click from it.
 *
 *  Each session contributes its OUTCOME line first. That line is the headline
 *  the distiller wrote, or the first sentence of its summary (mappers.outcomeOf
 *  makes that choice once, for the whole app), which is already "what was
 *  fixed" in one line and is the shape the owner asked for: "Added a back
 *  button to the daycards in feed". Its decisions and gotchas follow, but only
 *  where they arrived as a real list, per listPoints above.
 *
 *  ONE outcome per session, its newest. In practice memorydb keeps a summary
 *  on a single entry per session and strips it from the rest, so a session
 *  rarely has two to choose between; taking the newest is what makes the rule
 *  right rather than merely lucky, and it is the same newest-wins rule
 *  pickDayOverview follows -- later work supersedes earlier work.
 *
 *  Deduped across the whole day, and any bullet that merely restates the
 *  card's overview sentence is dropped: that sentence is already the first
 *  thing on the card, and repeating it under a heading reads as a rendering
 *  bug. Not capped, because this is the substance of the day view, and a cap
 *  would hide the day's work behind no control at all.
 *
 *  distilledBullets (features/session/distill.ts) is the closer relative and
 *  would be the better source, since a checkpoint trail is per-checkpoint
 *  distilled text. It is not reachable from here: /api/feed carries no
 *  `checkpoints` field at all (lib/feed.js normalizeLocal/normalizeTeam ship
 *  neither), so the trail exists only on the session-detail payload.
 *
 *  The dedupe is ONE global `seen` set across the whole day, unchanged from
 *  when this list was flat: a point that two sessions both stated appears
 *  once, under the OLDER of the two, and a group left with nothing is omitted
 *  rather than rendered as an empty heading.
 *
 *  Bullet keys are minted off a running total across the whole day rather than
 *  per group, so a key means the same thing here and in the flat list below,
 *  and two groups can never mint the same one. */
export function dayBulletGroups(sessions: DaySession[], overview: DayOverview): DayBulletGroup[] {
  const groups: DayBulletGroup[] = []
  const seen = new Set<string>()
  let total = 0
  if (overview.kind === 'distilled' || overview.kind === 'summary') seen.add(sameLineKey(overview.text))

  const push = (into: DayBullet[], text: string, keyBase: string) => {
    const flat = oneLine(text)
    if (!flat) return
    const key = sameLineKey(flat)
    if (!key || seen.has(key)) return
    seen.add(key)
    into.push({ key: `${keyBase}:${total}`, text: flat.length > DAY_BULLET_MAX ? clipWords(flat, DAY_BULLET_MAX) : flat })
    total++
  }

  // Oldest session first, so the list reads in the order the work happened
  // (distilledBullets' rule). `sessions` arrives newest-first for the scan
  // above it, so this walks it backwards rather than re-sorting a copy.
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]
    const bullets: DayBullet[] = []
    for (let j = session.entries.length - 1; j >= 0; j--) {
      const outcome = session.entries[j].outcome
      if (!outcome) continue
      push(bullets, outcome, session.key)
      break
    }
    for (const e of session.entries) {
      for (const point of listPoints(e.decisions)) push(bullets, point, session.key)
      for (const point of listPoints(e.gotchas)) push(bullets, point, session.key)
    }
    // A session whose every point was already said elsewhere contributes a
    // heading over nothing, which reads as a rendering bug. Omitted instead.
    if (bullets.length > 0) groups.push({ session, bullets })
  }
  return groups
}

/** The same bullets, flat. Defined THROUGH the grouped form rather than beside
 *  it: two implementations of "the day's points" would drift, and the count on
 *  the Summaries heading is this list's length while the rows under it come
 *  from the groups, so a drift would be a visibly wrong number. */
export function dayBullets(sessions: DaySession[], overview: DayOverview): DayBullet[] {
  return dayBulletGroups(sessions, overview).flatMap(g => g.bullets)
}

// ---------------------------------------------------------------------------
// The card's face
// ---------------------------------------------------------------------------

/** How many sentences of intent the card's face carries: the owner asked for
 *  "the brief 1-3 sentance intent", scaled by how much has been done that day.
 *
 *  "How much has been done" wants a PROMPT COUNT, and there is no such field:
 *  /api/feed carries none (nothing in lib/feed.js normalizeLocal/normalizeTeam
 *  emits one), and adding the daemon field is not this task. The proxy used
 *  instead is the DISTINCT SESSION COUNT, chosen over the two other candidates
 *  because it is the only one that tracks "separate pieces of work" rather
 *  than volume: entry count rises with a chatty session that did one thing,
 *  and file count rises with a single wide refactor.
 *
 *  Kept as its own named function, doing nothing else, so that swapping the
 *  proxy when a real prompt count lands is a one-line change with its own
 *  test rather than an archaeology exercise. */
export function dayIntentSentences(sessionCount: number): number {
  if (sessionCount >= 4) return 3
  if (sessionCount >= 2) return 2
  return 1
}

/** Longest ask the card face will quote, and it is a FILTER rather than a
 *  clip. Past this the candidate is skipped and the next one is tried; it is
 *  never truncated into the line.
 *
 *  This is listPoints' rule, applied to the same problem one field over. A
 *  captured prompt reaches this client with its newlines already gone --
 *  digest.clip and digest.plainText run replace(/\s+/g, ' ') on every path out
 *  of storage -- so a prompt that was a request followed by a pasted terminal
 *  transcript arrives as one long line with no boundary left to cut on. Clipped
 *  to fit, Andrew's feed rendered a card whose stated intent was
 *  "fix this efficiently and effectively as recommended. andrewbrown@Andrews-MacBook-Pro
 *  Downloads % defaults read /Applications/MemBridge.app/Contents/..." -- a
 *  shell session presented as what someone set out to do.
 *
 *  Dropping it costs nothing: the day view renders every prompt in full, so the
 *  text is one click away, and a card with one fewer line is better than a card
 *  with a fragment of a transcript on it.
 *
 *  180 sits above every legitimate ask measured on the live feed (the longest
 *  is 157, "those hchanges make no sense. there should be a way to see if its
 *  green without...") and above every written goal (the longest is 133, and
 *  lib/hooks GOAL_MAX bounds them anyway). Goals skip this check entirely:
 *  a goal is authored prose by construction, never a restated prompt. */
const DAY_ASK_MAX = 180

/** Total characters the intent line will spend. Reached before
 *  dayIntentSentences runs out, the line simply carries fewer asks. Whole asks
 *  or none: the budget decides HOW MANY are shown, never trims one into a
 *  fragment, so nothing on the card is ever half a sentence someone wrote. */
const DAY_INTENT_BUDGET = 280

/** Shortest ask that can stand as a statement of intent, set inside a gap
 *  measured on Andrew's real feed rather than guessed. Every short ask in the
 *  live data is a continuation that tells a reader nothing -- "ok" (2), "yes"
 *  (3), "continue" (8), "fill it in" (11) -- and the shortest one that is a
 *  real request is "letes build the bm25 fts5" (25). Nothing at all falls
 *  between 11 and 25, so the threshold sits in the middle of that gap where a
 *  few characters either way changes no decision, rather than hard against
 *  either edge.
 *
 *  This is a FILTER over candidates, not a rewrite: whatever survives is
 *  rendered exactly as it was typed. */
const DAY_ASK_MIN = 16

export interface DayAsk {
  key: string
  text: string
  /** True when this came from the session's written `goal` rather than from a
   *  raw prompt. Only used to explain the pick in tests and to keep the two
   *  sources visibly distinct in this module. */
  fromGoal: boolean
}

/** What this person set out to do, one line per session, oldest session first.
 *
 *  THE CARD'S TWO LINES ARE TWO DIFFERENT FACTS. The header states what was
 *  DONE; this states what was ASKED FOR. Built from the day's bullets instead,
 *  the two lines had ONE source -- the daemon's digest joins the same session
 *  outcomes with "; " that dayBullets lists -- so every populated card printed
 *  its own headline twice, differing only in punctuation. Andrew saw it on
 *  every card in the feed.
 *
 *  GOAL FIRST, ASK AS FALLBACK, and the distinction is the whole quality of
 *  this line. A goal is written for a reader: lib/digest.js asks the agent for
 *  "the why behind the session in your own words ... never a restated prompt",
 *  and the live values are exactly that ("Redesign the hero terminal panel on
 *  membridge.app so it demonstrates the product instead of asserting it"). An
 *  ask is whatever the person typed. mappers.intentOf already collapses the two
 *  into one field, which is why FeedEntry now carries `goal` separately: on the
 *  real feed only 4 of 89 entries have a goal, so a card that used goals alone
 *  would be blank on most days, and one that could not tell them apart would
 *  put "continue" on the feed as a statement of intent.
 *
 *  ONE line per session, its FIRST: a session's opening ask is what it was sent
 *  to do, where the prompts after it are course corrections. Taken WHOLE, never
 *  composed from fragments, deduped across the day by the same rule the bullets
 *  use. */
export function dayAsks(sessions: DaySession[]): DayAsk[] {
  const out: DayAsk[] = []
  const seen = new Set<string>()
  // Oldest session first, so the line reads in the order the day happened --
  // the same direction dayBullets reads, and `sessions` arrives newest-first.
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]
    let text: string | null = null
    let fromGoal = false
    for (const e of session.entries) {
      const goal = oneLine(e.goal)
      if (goal) { text = goal; fromGoal = true; break }
    }
    if (!text) {
      for (const e of session.entries) {
        // `intent` is goal-or-ask, so an entry carrying a goal would re-offer
        // it here; skipping those keeps this branch strictly the ask branch.
        if (oneLine(e.goal)) continue
        const ask = oneLine(e.intent)
        // Too short is a continuation, too long is a paste. Both keep looking
        // through the session rather than settling for an unreadable line.
        if (ask && ask.length >= DAY_ASK_MIN && ask.length <= DAY_ASK_MAX) { text = ask; break }
      }
    }
    if (!text) continue
    const key = sameLineKey(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    // A goal is taken whole; the clip is defensive only, since lib/hooks
    // GOAL_MAX already bounds one and the longest measured is 133.
    out.push({
      key: `${session.key}:${out.length}`,
      text: text.length > DAY_ASK_MAX ? clipWords(text, DAY_ASK_MAX) : text,
      fromGoal,
    })
  }
  return out
}

/** The card's second line: what the day was asked to do, in 1 to 3 sentences.
 *
 *  Every sentence is a goal or a prompt someone actually wrote, taken whole.
 *  Nothing here composes a claim out of fragments, and nothing is said at all
 *  when the day captured no usable ask -- an empty string, which the renderer
 *  drops rather than filling with a placeholder.
 *
 *  `skip` is the header's own text: on a day whose goal happens to match the
 *  sentence above, repeating it is the very duplication this rewrite exists to
 *  remove.
 *
 *  Terminal punctuation is added only where the source line lacks it. A clipped
 *  line already ends in an ellipsis, and "…." is a rendering bug. */
export function dayIntent(asks: DayAsk[], sessionCount: number, skip?: string | null): string {
  const skipKey = skip ? sameLineKey(skip) : null
  const parts: string[] = []
  let spent = 0
  for (const ask of asks) {
    if (parts.length >= dayIntentSentences(sessionCount)) break
    if (skipKey && sameLineKey(ask.text) === skipKey) continue
    // Always take the first one, whatever it costs: a card with a budget too
    // small for its own opening ask would render nothing at all.
    if (parts.length > 0 && spent + ask.text.length > DAY_INTENT_BUDGET) break
    parts.push(/[.!?…]$/.test(ask.text) ? ask.text : `${ask.text}.`)
    spent += ask.text.length
  }
  return parts.join(' ')
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
   *  projects, so there is no single `project` to name -- and naming one would
   *  be a claim about the day's scope that the data does not support. */
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
   *  this person set out to DO, where the sentence above says what was done.
   *  Two different facts from two different sources, which is the whole point
   *  -- built from the outcomes, as it first was, both lines said the same
   *  thing twice. Empty when the day captured no usable ask. */
  intent: string
  files: DayFile[]
  /** The distinct tools that ran this day, busiest first. Derived HERE and
   *  carried, never recomputed in the renderer: the card's last line pairs it
   *  with the files below, and two derivations of the same fact are how the
   *  line and the day view it opens start disagreeing about who did the work. */
  tools: string[]
  bullets: DayBullet[]
  /** The same bullets, under the session that produced them, oldest session
   *  first. `bullets` is this flattened, so the two can never disagree. */
  bulletGroups: DayBulletGroup[]
  /** Newest session first, each holding its own prompts oldest-first. Every
   *  entry of the day is reachable through these, so the card carries no
   *  second flat copy of them. */
  sessions: DaySession[]
}

/** The digest to use for each day, by card key.
 *
 *  A digest is derived from the ONE page it was served with, so a reader three
 *  pages deep holds several for the same day, each describing its own slice.
 *  This is a PICK of the best of them, never a merge: joining two would be
 *  composing a sentence nobody wrote.
 *
 *  RANKED ON `summarized`, NOT ON `entries`, and the difference is a defect
 *  measured on Andrew's real feed. `entries` counts prompt ROWS; `summarized`
 *  counts the distinct session statements the sentence could be built from. A
 *  page boundary routinely hands one page most of a day's rows and none of its
 *  summarized sessions: for marco on 2026-08-04, page one held 18 rows and 0
 *  statements while page two held 13 rows and 3. Ranking on rows picked page
 *  one, so a day with three perfectly good statements in hand rendered the
 *  placeholder "No summary yet for this day." and, because that page was also
 *  the truncated one, an amber coverage warning under it. Ranking on
 *  statements picks the page that can actually say something.
 *
 *  Ties break toward the digest whose page reached the day's start, then on
 *  rows, so the pick is total and stable rather than dependent on page order. */
function digestRank(d: DayDigest): [number, number, number] {
  return [d.summarized, d.complete ? 1 : 0, d.entries]
}

function outranks(a: DayDigest, b: DayDigest): boolean {
  const [x, y] = [digestRank(a), digestRank(b)]
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return false
}

function digestsByKey(digests: DayDigest[]): Map<string, DayDigest> {
  const byKey = new Map<string, DayDigest>()
  for (const d of digests) {
    const key = digestKey(d.key)
    const seen = byKey.get(key)
    if (!seen || outranks(d, seen)) byKey.set(key, d)
  }
  return byKey
}

/** Fold a flat feed into day cards, newest activity first.
 *
 *  Callers pass entries that have been through dedupeById; the synced-twin
 *  fold happens HERE rather than at the caller, because every count on the
 *  card is derived after it and a caller that forgot would double every one of
 *  them. It is idempotent, so a caller folding them as well is harmless.
 *
 *  `digests` are the daemon's day sentences off every loaded page. Absent --
 *  an older daemon, or one built before lib/digest.js -- every card falls back
 *  to pickDayOverview, which is a supported state and not a degraded one. */
export function buildDayCards(rawEntries: FeedEntry[], digests: DayDigest[] = []): DayCard[] {
  const entries = dedupeSyncedTwins(rawEntries)
  const byDigestKey = digestsByKey(digests)
  // The oldest instant anywhere in what the caller loaded. This is what lets a
  // card tell a day it has loaded WHOLE from one it is still in the middle of,
  // which is the difference between a truthful coverage warning and a stale
  // one -- see coverageNoteFor. Computed here rather than taken as an argument
  // because it is derivable from the same input and a caller that forgot to
  // pass it would silently suppress every warning.
  let oldestLoadedMs: number | null = null
  for (const e of entries) {
    const ms = Date.parse(e.at)
    if (Number.isNaN(ms)) continue
    if (oldestLoadedMs === null || ms < oldestLoadedMs) oldestLoadedMs = ms
  }
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
    // Has this client loaded past the START of this local day? The same
    // question DayPage's pager asks, through the same shared conversion, so a
    // day the feed considers whole and a day the pager stops walking for can
    // never disagree.
    const dayStart = localDayRangeMs(entryDayKey(newest) ?? '')?.start ?? null
    const dayFullyLoaded = dayStart !== null && oldestLoadedMs !== null && oldestLoadedMs < dayStart
    const overview = pickDayOverview(sorted, byDigestKey.get(key) ?? null, { dayFullyLoaded })
    // Grouped once and flattened, never computed twice: the flat list is
    // defined as the flattening, so deriving it here keeps that true and costs
    // one pass instead of two.
    const bulletGroups = dayBulletGroups(sessions, overview)
    const bullets = bulletGroups.flatMap(g => g.bullets)
    cards.push({
      key,
      slug: daySlug(key),
      author: newest.author,
      authorId: newest.authorId,
      projects: dayProjects(sorted),
      at: newest.at,
      live: sorted.some(e => e.live),
      // Sessions, not rows. daySessions keys a session-less row off its own
      // entry id, so counting groups here can never fold unrelated ones into
      // one session -- and it can never inflate either, which is the whole
      // reason the count survives the feed no longer collapsing checkpoints.
      sessionCount: sessions.length,
      overview,
      intent: dayIntent(dayAsks(sessions), sessions.length, overview.text),
      files: dayFiles(sorted),
      tools: dayTools(sessions),
      bullets,
      bulletGroups,
      sessions,
    })
  }
  return cards.sort((a, b) => b.at.localeCompare(a.at))
}
