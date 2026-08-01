// A result row has to answer "why is this here" without being opened.
//
// The rows that make search worth having are the ones whose match is NOT in
// the visible outcome line: a hit on `decisions`, on a file path, or deep in a
// 900-character summary. Showing the first N characters of that summary is the
// one thing guaranteed not to contain the query. So the snippet is centred on
// the match instead, and the matched run is marked so the eye lands on it.

/** One piece of a snippet: `hit` marks the run that matched the query. */
export interface SnippetPart {
  text: string
  hit: boolean
}

const WORD = /[a-z0-9_$.\-]+/gi

/** Query terms, lowercased. Mirrors lib/search.js's tokenizer closely enough
 *  for highlighting (it keeps `_ $ . -` inside tokens so identifiers and file
 *  names survive whole); it deliberately does NOT re-implement the scorer. */
export function queryTerms(query: string): string[] {
  return (query.toLowerCase().match(WORD) ?? []).filter(t => t.length >= 2)
}

/** Index of the earliest occurrence of any query term, or -1. */
function firstHit(haystack: string, terms: string[]): { at: number; term: string } | null {
  const lower = haystack.toLowerCase()
  let best: { at: number; term: string } | null = null
  for (const term of terms) {
    const at = lower.indexOf(term)
    if (at === -1) continue
    if (!best || at < best.at) best = { at, term }
  }
  return best
}

/** A window of `text` centred on its first query match, split into parts so
 *  the caller can mark the hits. Returns [] when there is nothing to show.
 *
 *  With no match anywhere (the row scored on a field this text isn't), it
 *  falls back to the head of the text -- still useful context, just not
 *  centred on anything. */
export function snippetAround(text: string | null, query: string, width = 180): SnippetPart[] {
  const source = (text || '').replace(/\s+/g, ' ').trim()
  if (!source) return []
  const terms = queryTerms(query)
  const hit = firstHit(source, terms)

  // Centre the window on the match, then pull back to word boundaries so the
  // snippet never starts or ends mid-word.
  let start = 0
  if (hit && hit.at > width / 2) {
    start = hit.at - Math.floor(width / 3)
    const space = source.indexOf(' ', start)
    if (space !== -1 && space < start + 20) start = space + 1
  }
  const end = Math.min(source.length, start + width)
  let clipped = source.slice(start, end)
  if (end < source.length) {
    const lastSpace = clipped.lastIndexOf(' ')
    if (lastSpace > width * 0.5) clipped = clipped.slice(0, lastSpace)
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = start + clipped.length < source.length ? '…' : ''

  if (!terms.length) return [{ text: prefix + clipped + suffix, hit: false }]

  // Split the window on every term occurrence. Case-insensitive, and the
  // ORIGINAL casing is preserved -- a snippet that lowercases the source
  // reads as machine output rather than as the teammate's own words.
  const parts: SnippetPart[] = []
  let cursor = 0
  const lower = clipped.toLowerCase()
  for (;;) {
    const next = firstHit(lower.slice(cursor), terms)
    if (!next) break
    const at = cursor + next.at
    if (at > cursor) parts.push({ text: clipped.slice(cursor, at), hit: false })
    parts.push({ text: clipped.slice(at, at + next.term.length), hit: true })
    cursor = at + next.term.length
  }
  if (cursor < clipped.length) parts.push({ text: clipped.slice(cursor), hit: false })
  if (prefix) parts.unshift({ text: prefix, hit: false })
  if (suffix) parts.push({ text: suffix, hit: false })
  return parts
}

/** The scorer's field names, said the way a person would. Unknown fields fall
 *  through unchanged rather than being dropped -- a new weighted field should
 *  show up as itself, not vanish. */
const FIELD_LABELS: Record<string, string> = {
  headline: 'summary',
  summary: 'summary',
  decisions: 'decisions',
  gotchas: 'gotchas',
  files: 'files',
  goal: 'intent',
  ask: 'prompt',
  changeNotes: 'changes',
  project: 'project',
  author: 'person',
}

/** Deduped, human-readable "why this row matched" labels. `headline` and
 *  `summary` both read as "summary": the distinction is a storage detail. */
export function matchLabels(matched: string[]): string[] {
  const out: string[] = []
  for (const field of matched) {
    const label = FIELD_LABELS[field] ?? field
    if (!out.includes(label)) out.push(label)
  }
  return out
}
