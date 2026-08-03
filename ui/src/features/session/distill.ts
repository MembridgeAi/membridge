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
