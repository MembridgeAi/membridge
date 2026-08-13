#!/usr/bin/env node
// Backtest for the proposed path -> area mapping (day-card tags + session headers).
// READ-ONLY against ~/.membridge/state.json. Nothing here writes anything.
//
// Answers three questions the design depends on:
//   1. What fraction of sessions get at least one tag?
//   2. How many distinct areas does a real session touch (tag-soup risk)?
//   3. Is each tag actually RIGHT? (prints a judgeable sample)
//
// This produced every measured number in
// 2026-08-12-session-headers-and-day-tags-design.md. It is committed so those
// numbers are reproducible rather than asserted, and so the distribution
// invariant ("no area tags more than 50% of sessions") can become a real test
// during implementation.
//
// It runs against the AUTHOR'S OWN ~/.membridge/state.json, so output differs
// per machine. It is evidence, not a test, until it is ported into
// test/suites/ against fixtures.

const os = require('os')
const fs = require('fs')

const state = JSON.parse(fs.readFileSync(os.homedir() + '/.membridge/state.json', 'utf8'))

// --- path normalisation -----------------------------------------------------
// The repo landmine: .claude/worktrees/<name>/lib/scan.js must key as lib/scan.js
// or every worktree session tags as "Config".
//
// DO NOT COPY THIS INTO PRODUCTION. It is a string-level APPROXIMATION of
// repoRoot.ledgerKeyFor, good enough to measure a distribution over one known
// machine's history. The absolute-path rule below assumes a ~/x/y/ checkout
// depth and is wrong for any other layout. The real implementation must call
// repoRoot.ledgerKeyFor / wireKeyFor, which ask git instead of guessing.
function normalise(file) {
  return String(file || '')
    .replace(/^.*?\.claude\/worktrees\/[^/]+\//, '')
    .replace(/^.*?\.worktrees\/[^/]+\//, '')
    .replace(/^\/Users\/[^/]+\/[^/]+\/[^/]+\//, '')
    .replace(/^\.\//, '')
}

// Agent working files are not project work. Left in, they inflate file counts
// and hand tags to sessions that edited nothing but their own scratch.
const NOT_PROJECT = [
  /(^|\/)(private\/)?tmp\//i, /\/scratchpad\//i, /\/tasks\/[a-z0-9]+\.output$/i,
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)(dist|build|coverage)\//,
  /\.(png|jpe?g|gif|webp|svg|ico|lock)$/i, /(^|\/)package-lock\.json$/,
]
const isProjectFile = f => f && !NOT_PROJECT.some(p => p.test(f))

// --- the candidate vocabulary ----------------------------------------------
// Eight areas, ordered by PRECEDENCE: first match wins. Order is the whole
// design here -- ui/src/FeedPage.test.tsx matches both UI and Tests, and which
// one it gets is a product decision, not a detail.
const AREAS = [
  ['Data/Schema', /(^|\/)(migrations?|supabase|prisma|db)\//i, /\.sql$/i],
  ['Build/CI',    /(^|\/)\.github\//i, /(^|\/)(Dockerfile|Makefile|\.gitlab-ci\.yml)$/i, /(^|\/)(webpack|vite|rollup|esbuild)\.config\./i],
  ['Tests',       /(^|\/)(tests?|spec|__tests__|e2e)\//i, /\.(test|spec)\.[jt]sx?$/i],
  ['Docs',        /(^|\/)docs?\//i, /\.mdx?$/i],
  ['UI/UX',       /(^|\/)(ui|frontend|client|components?|views?|templates?|styles?|public)\//i, /\.(tsx|jsx|vue|svelte|css|scss|less|html)$/i],
  ['Integrations',/(^|\/)(adapters?|connectors?|integrations?|hooks?)\//i, /(^|\/)(mcp|webhook|oauth)[-.]?[a-z]*\.[jt]s$/i],
  ['Config',      /(^|\/)\.claude\//i, /(^|\/)(config|settings)\.[a-z]+$/i, /^\.[a-z]+rc/i, /(^|\/)\.env/i],
  ['Backend',     /(^|\/)(lib|src|server|api|services?|bin|scripts|app)\//i, /\.(js|ts|py|rb|go|rs|java|php)$/i],
]

function areaOf(file) {
  const f = normalise(file)
  if (!f) return null
  for (const [name, ...patterns] of AREAS) {
    for (const p of patterns) if (p.test(f)) return name
  }
  return null
}

// --- gather sessions --------------------------------------------------------
// A session is the unit a day card renders, so coverage must be measured per
// session, never per event (an event is a single file touch).
const sessions = new Map()
let totalEvents = 0, teamRows = 0

for (const [projPath, proj] of Object.entries(state.projects || {})) {
  for (const e of proj.events || []) {
    totalEvents++
    const key = e.session || `${projPath}:${(e.ts || '').slice(0, 10)}`
    if (!sessions.has(key)) sessions.set(key, { files: new Set(), project: projPath, ts: e.ts })
    const nf = normalise(e.file)
    if (nf && isProjectFile(nf)) sessions.get(key).files.add(nf)
  }
  for (const t of proj.teamEntries || []) {
    teamRows++
    const key = `team:${t.session || t.ts}`
    if (!sessions.has(key)) sessions.set(key, { files: new Set(), project: projPath, ts: t.ts, team: true })
    const s = sessions.get(key)
    const add = f => { const n = normalise(f); if (n && isProjectFile(n)) s.files.add(n) }
    for (const f of t.files || []) add(f)
    for (const c of t.changes || []) if (c && c.file) add(c.file)
  }
}

// --- score ------------------------------------------------------------------
const all = [...sessions.values()]
const withFiles = all.filter(s => s.files.size > 0)

const tagged = []
const areaCounts = new Map()
const unmatched = new Map()
const spread = []

// Three candidate selection rules, scored side by side. "Touched" is what the
// first pass did and it produced tags that fire on every card; the other two
// ask whether the area was a MATERIAL share of the session.
const RULES = {
  touched:   ranked => ranked.map(r => r[0]),
  top3:      ranked => ranked.slice(0, 3).map(r => r[0]),
  material:  (ranked, total) => {
    const keep = ranked.filter(([, n]) => n / total >= 0.25).slice(0, 3)
    return (keep.length ? keep : ranked.slice(0, 1)).map(r => r[0])
  },
  // AMBIENT vs PUNCTUAL. Docs and Tests are touched by almost every session, so
  // they only mean something at a material share. Data/Schema, Build/CI and
  // Integrations are rarely touched at all, so touching them IS the signal --
  // "they went into the MCP server" survives being 2 files out of 20.
  salience: (ranked, total) => {
    const PUNCTUAL = new Set(['Data/Schema', 'Build/CI', 'Integrations'])
    // Punctual areas bypass the THRESHOLD but get no ordering privilege: a
    // single .github file must not headline a session that was really UI work.
    // `ranked` is already sorted by weight, so filtering preserves that order.
    const keep = ranked.filter(([a, n]) => PUNCTUAL.has(a) || n / total >= 0.25)
    return (keep.length ? keep : ranked.slice(0, 1)).slice(0, 3).map(r => r[0])
  },
}
const RULE_NAMES = ['touched', 'top3', 'material', 'salience']
const ruleCounts = Object.fromEntries(RULE_NAMES.map(n => [n, new Map()]))
const ruleSizes = Object.fromEntries(RULE_NAMES.map(n => [n, []]))

for (const s of withFiles) {
  const counts = new Map()
  let total = 0
  for (const f of s.files) {
    const a = areaOf(f)
    if (a) { counts.set(a, (counts.get(a) || 0) + 1); total++ }
    else unmatched.set(f, (unmatched.get(f) || 0) + 1)
  }
  if (counts.size === 0) continue
  spread.push(counts.size)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  for (const [name, fn] of Object.entries(RULES)) {
    const picked = fn(ranked, total)
    ruleSizes[name].push(picked.length)
    for (const a of picked) ruleCounts[name].set(a, (ruleCounts[name].get(a) || 0) + 1)
  }
  tagged.push({ ...s, ranked, total, top: RULES.salience(ranked, total) })
  for (const [a] of counts) areaCounts.set(a, (areaCounts.get(a) || 0) + 1)
}

const pct = (n, d) => d ? `${Math.round((n / d) * 100)}%` : 'n/a'
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

console.log('=== CORPUS ===')
console.log(`local events        ${totalEvents}`)
console.log(`team rows           ${teamRows}`)
console.log(`sessions            ${all.length}`)
console.log('')
console.log('=== COVERAGE (the blocker) ===')
console.log(`sessions with files ${withFiles.length}  (${pct(withFiles.length, all.length)} of all sessions)`)
console.log(`sessions tagged     ${tagged.length}  (${pct(tagged.length, all.length)} of all, ${pct(tagged.length, withFiles.length)} of those with files)`)
console.log('')
console.log('=== TAG SOUP RISK ===')
console.log(`distinct areas per tagged session: median ${median(spread)}, max ${Math.max(0, ...spread)}`)
const capped = spread.filter(n => n > 3).length
console.log(`sessions exceeding a 3-tag cap:    ${capped} (${pct(capped, tagged.length)})`)
console.log('')
console.log('=== SELECTION RULES: does the tag DISCRIMINATE? ===')
console.log('(a tag firing on >50% of sessions cannot answer "who worked on X")')
for (const name of RULE_NAMES) {
  const dist = [...ruleCounts[name].entries()].sort((x, y) => y[1] - x[1])
  const avg = (ruleSizes[name].reduce((a, b) => a + b, 0) / ruleSizes[name].length).toFixed(1)
  const noisy = dist.filter(([, n]) => n / tagged.length > 0.5).map(([a]) => a)
  console.log(`\n  --- ${name} --- avg ${avg} tags/session; ${noisy.length} tag(s) fire on >50%: ${noisy.join(', ') || 'none'}`)
  for (const [a, n] of dist) console.log(`      ${a.padEnd(14)} ${String(n).padStart(4)}  ${pct(n, tagged.length)}`)
}
console.log('')
console.log('=== UNMATCHED FILES (would produce no tag) ===')
const un = [...unmatched.entries()].sort((a, b) => b[1] - a[1])
console.log(`distinct unmatched paths: ${un.length}`)
for (const [f, n] of un.slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${f}`)
console.log('')
console.log('=== SAMPLE FOR JUDGING (are these tags actually right?) ===')
const sample = tagged.filter(s => s.files.size >= 2).slice(-25)
for (const s of sample) {
  console.log(`\n[${s.top.join('] [')}]   (${s.files.size} files)`)
  for (const f of [...s.files].slice(0, 6)) console.log(`    ${areaOf(f) || '??'.padEnd(12)} <- ${f}`)
}
