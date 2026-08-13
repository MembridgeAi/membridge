// Area tags for a day card: which parts of the codebase a day's work touched.
//
// Derived from FILE PATHS, not from anything an agent wrote, so it works on
// every session already captured rather than only on new ones. See
// docs/superpowers/specs/2026-08-12-session-headers-and-day-tags-design.md.

/** The fixed vocabulary. Fixed rather than freeform because these are SCANNED:
 *  "UI/UX" and "UI" and "Frontend" as three separate tags would defeat the
 *  entire purpose. */
export type Area =
  | 'Data/Schema' | 'Build/CI' | 'Tests' | 'Docs'
  | 'UI/UX' | 'Integrations' | 'Config' | 'Backend'

/** Ordered. FIRST MATCH WINS, and the order carries two decisions:
 *
 *    * Tests precedes UI/UX, so ui/**\/*.test.tsx is Tests. A test is a test
 *      wherever it lives.
 *    * Tests precedes Integrations, so test/suites/mcp-config.test.js is Tests
 *      rather than Integrations; Integrations is for integration CODE.
 *
 *  Changing this order changes what every historical card says, so it is not a
 *  detail to tidy. */
const AREA_RULES: Array<{ area: Area; patterns: RegExp[] }> = [
  { area: 'Data/Schema', patterns: [/(^|\/)(migrations?|supabase|prisma|db)\//i, /\.sql$/i] },
  { area: 'Build/CI', patterns: [/(^|\/)\.github\//i, /(^|\/)(Dockerfile|Makefile)$/i, /(^|\/)(webpack|vite|rollup|esbuild)\.config\./i] },
  { area: 'Tests', patterns: [/(^|\/)(tests?|spec|__tests__|e2e)\//i, /\.(test|spec)\.[jt]sx?$/i] },
  { area: 'Docs', patterns: [/(^|\/)docs?\//i, /\.mdx?$/i] },
  { area: 'UI/UX', patterns: [/(^|\/)(ui|frontend|client|components?|views?|templates?|styles?|public)\//i, /\.(tsx|jsx|vue|svelte|css|scss|less|html)$/i] },
  { area: 'Integrations', patterns: [/(^|\/)(adapters?|connectors?|integrations?|hooks?)\//i, /(^|\/)(mcp|webhook|oauth)[-.]?[a-z]*\.[jt]s$/i] },
  { area: 'Config', patterns: [/(^|\/)\.claude\//i, /(^|\/)(config|settings)\.[a-z]+$/i, /(^|\/)\.[a-z]+rc/i, /(^|\/)\.env/i] },
  { area: 'Backend', patterns: [/(^|\/)(lib|src|server|api|services?|bin|scripts|app)\//i, /\.(js|ts|py|rb|go|rs|java|php)$/i] },
]

/** Agent working files are not project work. Measured: before this filter, 33
 *  distinct unmatched paths across the whole local corpus were scratchpad
 *  screenshots and task output; after it, 6. Left in, they inflate a day's file
 *  count and can hand a tag to a session that edited nothing but its own
 *  scratch. */
const NOT_PROJECT: RegExp[] = [
  /(^|\/)(private\/)?tmp\//i,
  /(^|\/)scratchpad\//i,
  /(^|\/)tasks\/[a-z0-9]+\.output$/i,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  /(^|\/)(dist|build|coverage)\//,
  /\.(png|jpe?g|gif|webp|svg|ico|lock)$/i,
  /(^|\/)package-lock\.json$/,
]

/** Almost all work in this repo happens inside a worktree, so a raw path
 *  beginning `.claude/worktrees/` is the COMMON case, not an edge one -- and
 *  left raw it matches the Config rule, tagging every worktree session
 *  `Config`.
 *
 *  This is a string-level approximation of lib/repo-root.js ledgerKeyFor,
 *  which is a Node module and unreachable from the browser bundle. A path shape
 *  not handled here yields a wrong tag, which is cheap and visible; see the
 *  "Deviation" section of the plan for why that trade was taken over
 *  normalising daemon-side. */
export function repoRelative(file: string): string {
  return String(file || '')
    .replace(/^.*?\.claude\/worktrees\/[^/]+\//, '')
    .replace(/^.*?\.worktrees\/[^/]+\//, '')
    .replace(/^\/(?:Users|home)\/[^/]+\/[^/]+\/[^/]+\//, '')
    .replace(/^\.\//, '')
}

export function isProjectFile(file: string): boolean {
  const f = repoRelative(file)
  return !!f && !NOT_PROJECT.some(p => p.test(f))
}

/** The area a file belongs to, or null when it is excluded or unrecognised.
 *  Null is a real answer, not a failure: `runs/x/mission.json` genuinely is not
 *  one of the eight. */
export function areaOf(file: string): Area | null {
  const f = repoRelative(file)
  if (!f || !isProjectFile(f)) return null
  for (const { area, patterns } of AREA_RULES) {
    for (const p of patterns) if (p.test(f)) return area
  }
  return null
}

/** Areas that earn a tag on PRESENCE rather than on share.
 *
 *  The split is the whole design. Measured over the local corpus, tagging every
 *  area a day touched put Docs on 73% of cards and UI/UX on 68% -- a tag that
 *  fires on most cards cannot answer "who worked on X". But a flat share
 *  threshold has the opposite failure: it silenced Integrations completely,
 *  because MCP work is two files inside a twenty-file day.
 *
 *  So: areas touched by almost everything must earn their tag, and areas
 *  touched by almost nothing are worth saying whenever they appear. */
const PUNCTUAL: ReadonlySet<Area> = new Set<Area>(['Data/Schema', 'Build/CI', 'Integrations'])

/** Share of a card's recognised files an AMBIENT area must reach. */
const AMBIENT_SHARE = 0.25

/** Most tags a card carries. Past three the strip stops being scannable, which
 *  is the only thing it is for. */
const TAG_LIMIT = 3

export interface AreaTag {
  area: Area
  /** Distinct files this card touched in this area. Drives the ordering, and
   *  is exposed so the renderer can title the tag. */
  files: number
}

/** The areas a day's files earn, most-touched first, at most three.
 *
 *  Counts DISTINCT files, not touches: a day that edited one file thirty times
 *  worked in one area, and weighting by touch count would let a single
 *  hot file outrank a whole subsystem. */
export function areaTagsFor(files: Array<{ file: string }>): AreaTag[] {
  const seen = new Set<string>()
  const counts = new Map<Area, number>()
  let total = 0
  for (const { file } of files) {
    const key = repoRelative(file)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const area = areaOf(key)
    if (!area) continue
    counts.set(area, (counts.get(area) ?? 0) + 1)
    total++
  }
  if (total === 0) return []

  // Sorted by weight, ties broken on name so the same day always renders the
  // same strip -- an unstable order would make a card flicker between renders.
  const ranked = [...counts.entries()]
    .map(([area, n]): AreaTag => ({ area, files: n }))
    .sort((a, b) => b.files - a.files || a.area.localeCompare(b.area))

  const kept = ranked.filter(t => PUNCTUAL.has(t.area) || t.files / total >= AMBIENT_SHARE)
  // A card with recognised files always says something: if every area fell
  // below the bar, the heaviest one is still the truest thing available.
  return (kept.length > 0 ? kept : ranked.slice(0, 1)).slice(0, TAG_LIMIT)
}
