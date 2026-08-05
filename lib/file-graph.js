'use strict';
// The file graph: which memories touched the same code.
//
// Every entry already carries the files its session edited. Read across the
// whole corpus that is a bipartite graph — entries on one side, files on the
// other — and two entries joined through a file are, by construction, about
// the same code. That is a relation the lexical ranker cannot see at all:
// BM25 joins entries that used the same WORDS, and two sessions can rework
// the same function while describing it in completely different language.
//
// WHY THIS IS WORTH HAVING TWICE OVER. The same graph serves two callers that
// look unrelated:
//
//   - lib/search-eval.js labels with it. Two sessions editing one file are
//     related whether or not anyone wrote that down, so the graph yields
//     ground truth nobody had to annotate.
//   - ranking uses it as a signal (pseudo-relevance feedback over files).
//
// Those two uses are in tension, and the tension is the reason `excludeFiles`
// exists below. A label that says "A and B share vault.tf" scores a ranker
// that boosts "shares vault.tf" at 100% while proving nothing whatsoever. The
// eval therefore holds out the linking file and asks the ranker to reach the
// same neighbour through OTHER evidence. Any caller that ranks and labels
// from one graph without holding something out is measuring its own wiring.
//
// IDF, ON THE FILE AXIS. The old hand-rolled scorer's real defect was having
// no IDF: a word in every entry counted as much as a word in one. The exact
// same mistake is available here and is even easier to make, because a repo
// has files that almost every session touches — package.json, the lockfile,
// README, a barrel index. Joined through those, every memory neighbours every
// other memory and the graph degenerates into a complete graph that says
// nothing. So a file's weight falls with the number of entries that touched
// it, and the hub files that would otherwise dominate contribute nearly zero.
//
// Entry degree is normalized for the mirror-image reason: a sweeping refactor
// that touched 300 files must not become everyone's nearest neighbour just by
// being large. That part is cosine over IDF-weighted file vectors, so the hub
// ENTRY is damped by the geometry itself.
//
// Cosine alone is not enough for the hub FILE, though, and the reason is easy
// to miss: cosine compares DIRECTION, not magnitude. Two entries that each
// touched nothing but package.json have identical file vectors, so they score
// a perfect 1 no matter how worthless package.json is — the IDF weight
// divides straight back out through the norms. Weighting the vectors cannot
// fix that; the weight has to survive the normalization. So affinity is
// cosine SCALED by the weight of the strongest file the two actually share,
// which bounds a link by the quality of its best evidence: sharing only a
// lockfile is a near-zero score even when it is the only thing either entry
// touched. Affinity is 1 only for entries that share a file unique to them.
//
// PURE. No fs, no config, no SQLite — entries in, numbers out. The corpus is
// assembled by lib/activity.js and handed here already redacted, exactly like
// lib/search.js; this module never learns where memories live.

// Above this many entries a file is treated as pure noise and skipped when
// expanding neighbours. This is a PERFORMANCE guard, not a quality one — the
// weighting below has already driven such a file's contribution to almost
// nothing, but walking a 10,000-entry adjacency list to add ~0 to each score
// is the difference between a graph query that is instant and one that is not.
const HUB_FILE_ENTRIES = 500;

// Normalized file identity. Entries arrive from several lanes (local events,
// team rows, archive) and differ in leading "./" and trailing slashes; a path
// that fails to unify here silently splits one file into two graph nodes and
// the edge between those entries is lost, so this is deliberately blunt.
function normFile(f) {
  if (f == null) return null;
  const s = String(f).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '' ? null : s;
}

// Bipartite adjacency both ways. Built once per corpus and reused: callers ask
// many questions of one graph (every entry's neighbours, in the eval's case),
// and rebuilding per question is what makes a graph feature look expensive.
//
// `keyOf` is injected rather than imported from lib/activity.js — the same
// no-cycle rule lib/search-index.js follows. The caller already knows how it
// identifies an entry; this module only needs the identity to be stable.
function buildGraph(entries, keyOf) {
  const byFile = new Map(); // file -> Set(key)
  const byKey = new Map();  // key  -> Set(file)
  for (const e of (entries || [])) {
    if (!e) continue;
    const key = keyOf ? keyOf(e) : e.key;
    if (!key) continue;
    const files = Array.isArray(e.files) ? e.files : [];
    for (const raw of files) {
      const f = normFile(raw);
      if (!f) continue;
      let fset = byFile.get(f);
      if (!fset) { fset = new Set(); byFile.set(f, fset); }
      fset.add(key);
      let kset = byKey.get(key);
      if (!kset) { kset = new Set(); byKey.set(key, kset); }
      kset.add(f);
    }
  }
  // Corpus size for IDF. Entries with no files are not nodes here and are
  // deliberately not counted: they cannot make a file look common, and
  // including them would deflate every weight in proportion to how much of
  // the corpus happens to carry file lists at all.
  return { byFile, byKey, total: byKey.size };
}

// A file's discriminating power, in (0, 1]: ~1 for a file only a couple of
// sessions touched, ~0 for one that every session touches.
//
// This is textbook IDF and has to be measured RELATIVE TO THE CORPUS, not off
// the raw count. "Six sessions touched this file" means opposite things in a
// corpus of six and a corpus of fifty thousand, and a bare 1/log(n) cannot
// tell those apart — it would call a file that literally every entry touched
// a moderately good link. Smoothed (the +1/+0.5) so a file touched by the
// whole corpus lands near zero instead of exactly zero, which keeps a small
// corpus from collapsing every weight to 0 and every affinity with it.
function fileWeight(graph, file) {
  const n = graph.byFile.has(file) ? graph.byFile.get(file).size : 0;
  if (n <= 0) return 0;
  const total = graph.total || 1;
  const w = Math.log((total + 1) / (n + 0.5)) / Math.log(total + 1);
  return Math.max(0, Math.min(1, w));
}

// Squared-weight norm of one entry's file set, the denominator half of the
// cosine below. Cached on the graph because the eval asks for it O(n) times
// per entry and it depends on nothing but the graph itself.
function normOf(graph, key, exclude) {
  if (!exclude && graph._norms && graph._norms.has(key)) return graph._norms.get(key);
  const files = graph.byKey.get(key);
  if (!files) return 0;
  let sum = 0;
  for (const f of files) {
    if (exclude && exclude.has(f)) continue;
    const w = fileWeight(graph, f);
    sum += w * w;
  }
  const norm = Math.sqrt(sum);
  if (!exclude) {
    if (!graph._norms) graph._norms = new Map();
    graph._norms.set(key, norm);
  }
  return norm;
}

// Cosine similarity over IDF-weighted file vectors, in [0, 1]. 1 means the two
// entries touched exactly the same files; 0 means they share none that matter.
//
// `excludeFiles` removes files from BOTH sides before comparing — the held-out
// protocol from the header. Excluding on one side only would leave the file in
// the denominator and quietly shrink every score instead of removing the edge.
function affinity(graph, keyA, keyB, opts = {}) {
  if (keyA === keyB) return 0; // an entry is not its own neighbour
  const a = graph.byKey.get(keyA);
  const b = graph.byKey.get(keyB);
  if (!a || !b) return 0;
  const exclude = opts.excludeFiles instanceof Set
    ? opts.excludeFiles
    : (Array.isArray(opts.excludeFiles) ? new Set(opts.excludeFiles.map(normFile)) : null);
  let dot = 0;
  let strongest = 0; // best shared evidence — see the header on why cosine alone fails
  // Walk the smaller set: the intersection is what is wanted, and file sets
  // are wildly uneven in size (a one-file fix against a 300-file refactor).
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const f of small) {
    if (exclude && exclude.has(f)) continue;
    if (!large.has(f)) continue;
    const w = fileWeight(graph, f);
    dot += w * w;
    if (w > strongest) strongest = w;
  }
  if (dot === 0) return 0;
  const na = normOf(graph, keyA, exclude);
  const nb = normOf(graph, keyB, exclude);
  if (na === 0 || nb === 0) return 0;
  return (dot / (na * nb)) * strongest;
}

// Every entry sharing at least one non-excluded file with `key`, strongest
// first. `minAffinity` is the quality gate that matters in practice: a pair
// joined only through package.json scores near zero, and admitting it as a
// neighbour is what turns this graph into noise.
function neighbours(graph, key, opts = {}) {
  const files = graph.byKey.get(key);
  if (!files) return [];
  const exclude = opts.excludeFiles instanceof Set
    ? opts.excludeFiles
    : (Array.isArray(opts.excludeFiles) ? new Set(opts.excludeFiles.map(normFile)) : null);
  const min = Number.isFinite(opts.minAffinity) ? opts.minAffinity : 0;
  const candidates = new Set();
  for (const f of files) {
    if (exclude && exclude.has(f)) continue;
    const on = graph.byFile.get(f);
    if (!on || on.size > HUB_FILE_ENTRIES) continue; // see HUB_FILE_ENTRIES
    for (const other of on) if (other !== key) candidates.add(other);
  }
  const out = [];
  for (const other of candidates) {
    const score = affinity(graph, key, other, { excludeFiles: exclude });
    if (score > min) out.push({ key: other, affinity: score });
  }
  // Ties broken by key so the order is total and a caller comparing two runs
  // is comparing ranking, not Set iteration order.
  out.sort((x, y) => (y.affinity - x.affinity) || String(x.key).localeCompare(String(y.key)));
  if (Number.isFinite(opts.limit)) return out.slice(0, opts.limit);
  return out;
}

// How strongly one entry connects to a SET of files (a query's file footprint)
// rather than to another entry. Same weighting, same normalization; this is
// the shape ranking wants, where the other side of the comparison is context
// rather than a specific memory.
function affinityToFiles(graph, key, files, opts = {}) {
  const own = graph.byKey.get(key);
  if (!own || !Array.isArray(files) || files.length === 0) return 0;
  const exclude = opts.excludeFiles instanceof Set
    ? opts.excludeFiles
    : (Array.isArray(opts.excludeFiles) ? new Set(opts.excludeFiles.map(normFile)) : null);
  const want = new Set();
  for (const f of files) {
    const n = normFile(f);
    if (n && !(exclude && exclude.has(n))) want.add(n);
  }
  if (want.size === 0) return 0;
  let dot = 0;
  let wantNorm = 0;
  let strongest = 0;
  for (const f of want) {
    const w = fileWeight(graph, f);
    wantNorm += w * w;
    if (own.has(f)) { dot += w * w; if (w > strongest) strongest = w; }
  }
  if (dot === 0) return 0;
  const na = normOf(graph, key, exclude);
  const nb = Math.sqrt(wantNorm);
  if (na === 0 || nb === 0) return 0;
  return (dot / (na * nb)) * strongest;
}

module.exports = {
  buildGraph, neighbours, affinity, affinityToFiles, fileWeight, normFile,
  HUB_FILE_ENTRIES,
};
