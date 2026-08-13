import { clipWords } from '../../data/mappers'
import type { Session } from '../../data/types'

// Distillation for the session page: the one-liner bullets under the summary,
// and the intent line that used to render a whole prompt verbatim.
//
// Both are pure and defensive. Nothing here throws on damaged history: a
// missing field, a blank string, or a checkpoint trail full of duplicates
// degrades to a shorter list, never to an exception in a render path.

/** One line's worth of text. Measured against real checkpoint trails: the
 *  distilled one-liners run 40 to 120 characters, and a captured prompt runs
 *  to thousands, so this is the boundary between "a line" and "a paragraph
 *  that broke the page". */
export const INTENT_MAX = 160

/** Collapse every run of whitespace to a single space. A multi-line prompt
 *  rendered verbatim grows the line vertically no matter how it is clipped. */
function oneLine(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/** The comparison key for "is this the same line": case and whitespace and
 *  trailing punctuation are not differences a reader would call distinct. */
function sameLineKey(text: string): string {
  return oneLine(text).toLowerCase().replace(/[.!?;:,\s]+$/, '')
}

/** The intent line, clipped to one line, with `clipped` saying whether the
 *  reader is being shown less than was captured. The caller renders a
 *  disclosure control only when something was actually cut, so a short
 *  intent never grows a control that does nothing. */
export function shortIntent(text: string): { text: string; clipped: boolean } {
  const flat = oneLine(text)
  if (flat.length <= INTENT_MAX) return { text: flat, clipped: false }
  return { text: clipWords(flat, INTENT_MAX), clipped: true }
}

/** The distilled one-liners: "fixed the date in the UI", "raised the rate
 *  limit from 3 to 10 seconds".
 *
 *  Source is the session's own CHECKPOINT TRAIL -- these are already distilled
 *  per-checkpoint summaries (lib/digest.js sessionSummaries, Distilled events
 *  preferred over harvested ones), so no new derivation is invented here.
 *  Oldest-first, so the list reads in the order the work happened.
 *
 *  Three rules, each earned:
 *    * a checkpoint that merely repeats the page header is dropped -- it is
 *      the settled summary, already rendered above as the header.
 *    * duplicates and blanks are dropped, since a stalled session appends the
 *      same line repeatedly.
 *    * a paragraph-length checkpoint is clipped to one line rather than
 *      dumping the whole thing into what is meant to be a scannable list.
 *
 *  When a session has no checkpoints at all (distillation never ran, or the
 *  Stop hook was silent), the key-file notes are the fallback: the agent's own
 *  per-file highlight is the only other distilled text on the payload. */
export function distilledBullets(session: Session): string[] {
  const header = new Set<string>()
  for (const line of [session.headline, session.summary]) {
    if (line) header.add(sameLineKey(line))
  }

  const out: string[] = []
  const seen = new Set<string>()
  const push = (text: string) => {
    const flat = oneLine(text)
    if (!flat) return
    const key = sameLineKey(flat)
    if (!key || seen.has(key) || header.has(key)) return
    seen.add(key)
    out.push(flat.length > INTENT_MAX ? clipWords(flat, INTENT_MAX) : flat)
  }

  const checkpoints = Array.isArray(session.checkpoints) ? session.checkpoints : []
  for (const c of checkpoints) push(c && c.text ? c.text : '')
  if (out.length > 0) return out

  const changes = Array.isArray(session.changes) ? session.changes : []
  for (const c of changes) {
    if (c && c.note) push(`${c.file}: ${c.note}`)
  }
  return out
}

/** One field's worth of points. A newline means the writer already made a
 *  list, so it is the authoritative boundary; a paragraph offers only its
 *  sentences. Leading bullet markers are stripped so the list renders as one
 *  shape whichever way the text arrived. */
function splitPoints(text: string | null): string[] {
  const raw = String(text || '')
  if (!raw.trim()) return []
  const pieces = raw.includes('\n') ? raw.split('\n') : raw.split(/(?<=[.!?])\s+/)
  return pieces.map(p => oneLine(p).replace(/^[-*•]\s*/, '')).filter(Boolean)
}

/** Fewest points worth splitting under headings. Below this, headings cost
 *  more than they buy: with a hard ceiling of 4 points per field, three
 *  headings over one line each is a common shape, not a hypothetical one. */
export const GROUP_MIN_POINTS = 4

/** Fewest distinct areas worth splitting. One heading over the whole list says
 *  nothing the list did not already say. */
export const GROUP_MIN_AREAS = 2

export interface WhatGroup {
  /** The area these points share, or null for the unlabelled group -- either
   *  the whole list when it is not worth grouping, or the trailing points that
   *  carried no area of their own. */
  area: string | null
  points: string[]
}

/** Read a leading "[Area] " off a point. Mirrors lib/hooks.js splitAreaPrefix,
 *  deliberately WITHOUT a copy of the vocabulary: the hook is the only place
 *  the valid set is enforced, so this renders whatever label was written and a
 *  future ninth area needs no change here.
 *
 *  Anchored and length-bounded, so a bracket mid-sentence ("Fixed the [object
 *  Object] label") is not mistaken for a prefix and silently eaten. */
function parseAreaPoint(text: string): { area: string | null; point: string } {
  const flat = oneLine(text)
  const m = /^\[([^\][]{1,20})\]\s*(.*)$/.exec(flat)
  if (!m) return { area: null, point: flat }
  return { area: m[1].trim(), point: m[2].trim() }
}

/** The merged "What" widget: the session's decisions followed by its gotchas,
 *  grouped under the area each point named.
 *
 *  Grouping engages only at GROUP_MIN_POINTS across GROUP_MIN_AREAS; otherwise
 *  the whole list comes back as one unlabelled group and renders exactly as it
 *  did before areas existed. Every session captured before this shipped has no
 *  prefixes at all and lands in that case by construction, which is the
 *  intended degradation, not a gap.
 *
 *  Areas keep FIRST-SEEN order rather than being sorted: decisions come before
 *  gotchas and the hook asks for the most important first, so first-seen is
 *  the writer's own ordering. Sorting would overwrite it with the alphabet.
 *
 *  A gotcha that merely restates a decision is dropped, as before: the two
 *  fields are one list here, and the same sentence twice reads as a bug. */
export function whatGroups(session: Session): WhatGroup[] {
  const seen = new Set<string>()
  const order: string[] = []
  const byArea = new Map<string, string[]>()
  const loose: string[] = []

  for (const field of [session.decisions, session.gotchas]) {
    for (const piece of splitPoints(field)) {
      const { area, point } = parseAreaPoint(piece)
      const key = sameLineKey(point)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (area === null) { loose.push(point); continue }
      if (!byArea.has(area)) { byArea.set(area, []); order.push(area) }
      byArea.get(area)!.push(point)
    }
  }

  const total = loose.length + [...byArea.values()].reduce((n, ps) => n + ps.length, 0)
  if (total === 0) return []

  // Not worth grouping: hand back one flat list, in the order the points were
  // written, with prefixes stripped -- a reader should never see the raw
  // "[UI/UX] " markup whichever branch runs.
  if (total < GROUP_MIN_POINTS || order.length < GROUP_MIN_AREAS) {
    const flat: string[] = []
    for (const area of order) flat.push(...byArea.get(area)!)
    flat.push(...loose)
    return [{ area: null, points: flat }]
  }

  const groups: WhatGroup[] = order.map(area => ({ area, points: byArea.get(area)! }))
  if (loose.length > 0) groups.push({ area: null, points: loose })
  return groups
}
