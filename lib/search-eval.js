'use strict';
// Search evaluation with labels nobody had to write.
//
// THE PROBLEM WITH THE HARNESS WE ALREADY HAVE. test/suites/recall-quality.js
// scores real end-to-end searches, but every label in it is hand-authored: a
// human invented the rows, the query, and the answer. That catches
// regressions against cases we already thought of, and by construction it
// cannot catch anything else — the ranker is being graded against the
// imagination of whoever wrote the fixtures, on a corpus of seven scenarios.
//
// THE LABEL. Two sessions that edited the same file were working on the same
// code. Nobody has to annotate that; it is already recorded in every entry's
// file list, across the whole real corpus. So: seed a query from one session's
// PROSE, and the sessions that touched its files are the ones that should come
// back. Labels for as many cases as there are entries, from data that was
// always there.
//
// WHY THE LABEL IS NOT CIRCULAR. The label comes from what a session EDITED;
// the lexical ranker scores what a session WROTE. Those are independent
// signals, which is the whole reason this works as an eval instead of a
// tautology — and it is also exactly what makes the metric meaningful, since
// two people reworking one function while describing it in different words is
// precisely the miss BM25 cannot see.
//
// Two things protect that independence, and both are load-bearing:
//
//   - queries are synthesized from PROSE ONLY, never from the file list, even
//     though `files` is itself a searchable field in the index. A query
//     carrying "infra/vault.tf" would retrieve file-neighbours by string
//     match and score the label against itself.
//   - the seed's linking files are HELD OUT when a ranker that uses the file
//     graph is scored (see `heldOut` on each case). Grading a file-graph
//     ranker on file-overlap labels without holding the linking file out
//     measures whether the boost is plugged in, not whether it helps.
//
// WHAT A GOOD SCORE MEANS. recall@k here is "when someone searches in the
// language of one session, how much of the work on that same code comes
// back". It will not approach 1 and should not: some sessions genuinely share
// a file and nothing else, and no ranker should surface an unrelated
// stylistic pass over the same file. The number is for COMPARING rankers on
// one corpus, never for claiming an absolute quality bar.
const searchLib = require('./search');
const fileGraph = require('./file-graph');

// Prose only — see the header. Kept as its own list rather than reusing
// lib/search.js's FIELD_WEIGHTS, which deliberately includes `files`.
const PROSE_FIELDS = ['headline', 'ask', 'goal', 'summary', 'decisions', 'gotchas'];

// A term in more than this share of the corpus carries no signal and makes a
// synthesized query look like a sentence instead of a search. Mirrors what a
// person actually types (keywords, not prose) and what the tool's own
// description asks for.
const MAX_DF_RATIO = 0.2;
const DEFAULT_TERMS = 4;

function proseOf(entry) {
  const parts = [];
  for (const f of PROSE_FIELDS) {
    const v = entry && entry[f];
    if (typeof v === 'string' && v.trim()) parts.push(v);
  }
  return parts.join(' ');
}

// Document frequency per term across the corpus, so query synthesis can drop
// the terms that cannot discriminate. Same tokenizer as the ranker, on
// purpose: a query built with different tokenization than the thing being
// graded would fail on splitting rules rather than on relevance.
function documentFrequencies(entries) {
  const df = new Map();
  for (const e of entries) {
    const seen = new Set(searchLib.tokenize(proseOf(e)));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  return df;
}

// The query a person plausibly types to find this session again: its rarest
// few words, in the order they appear. Deterministic — no sampling — so two
// runs over one corpus produce identical cases and a metric difference
// between them is a ranker difference.
function synthesizeQuery(entry, df, total, opts = {}) {
  const want = Number.isFinite(opts.terms) ? opts.terms : DEFAULT_TERMS;
  // Never below 1. A share-of-corpus cutoff is meaningless on a small corpus:
  // at 20% of four entries the threshold is 0.8, so EVERY term — including
  // one appearing in a single entry, which is maximally discriminating — is
  // "too common", every query comes out empty, and the harness silently
  // reports zero cases rather than a bad score. A term in one document is
  // never common, whatever the corpus size.
  const ratio = Number.isFinite(opts.maxDfRatio) ? opts.maxDfRatio : MAX_DF_RATIO;
  const maxDf = Math.max(1, ratio * total);
  const seen = new Set();
  const kept = [];
  for (const t of searchLib.tokenize(proseOf(entry))) {
    if (seen.has(t)) continue;
    seen.add(t);
    const freq = df.get(t) || 0;
    if (freq > maxDf) continue; // too common to discriminate
    kept.push({ term: t, df: freq });
  }
  // Rarest first, then original order for ties — the informative words lead,
  // which is what a person's keywords look like.
  kept.sort((a, b) => a.df - b.df);
  return kept.slice(0, want).map(k => k.term).join(' ');
}

// One case per entry that can produce both a query and at least one labelled
// neighbour. Entries that cannot are SKIPPED rather than scored as zero: an
// entry with no files has no label, and counting it as a miss would punish the
// ranker for a gap in the corpus.
//
// Each case carries `heldOut` — the seed's own files. A ranker that consults
// the file graph must be scored with these excluded, so it has to reach the
// neighbour through other evidence than the edge that defined the label.
function buildCases(entries, keyOf, opts = {}) {
  const list = (entries || []).filter(Boolean);
  const graph = fileGraph.buildGraph(list, keyOf);
  const df = documentFrequencies(list);
  const total = list.length || 1;
  const minAffinity = Number.isFinite(opts.minAffinity) ? opts.minAffinity : 0.05;
  const cases = [];
  for (const e of list) {
    const key = keyOf ? keyOf(e) : e.key;
    if (!key) continue;
    const query = synthesizeQuery(e, df, total, opts);
    if (!query) continue; // nothing distinctive enough to search for
    const rel = fileGraph.neighbours(graph, key, { minAffinity });
    if (rel.length === 0) continue; // unlabelled, not a failure
    cases.push({
      seed: key,
      query,
      relevant: rel.map(r => r.key),
      affinities: new Map(rel.map(r => [r.key, r.affinity])),
      heldOut: [...(graph.byKey.get(key) || [])],
    });
  }
  return { cases, graph, df };
}

// Score a ranker over the cases. `rank` is (query, caseObj) => [key, ...] in
// ranked order; the caller supplies it, so this module never decides what is
// being evaluated and the same harness grades the lexical ranker, a
// file-graph ranker, or any future one.
//
// The SEED is removed from the returned ranking before scoring. It is the
// thing the query was written from, it will rank first on any sane ranker,
// and leaving it in would inflate every metric by a constant that has nothing
// to do with quality.
function score(cases, rank, opts = {}) {
  const k = Number.isFinite(opts.k) ? opts.k : 10;
  const per = [];
  for (const c of cases) {
    const ranked = (rank(c.query, c) || []).filter(key => key !== c.seed);
    const top = ranked.slice(0, k);
    const relevant = new Set(c.relevant);
    let hits = 0;
    let firstRank = 0;
    for (let i = 0; i < top.length; i++) {
      if (!relevant.has(top[i])) continue;
      hits += 1;
      if (!firstRank) firstRank = i + 1;
    }
    per.push({
      seed: c.seed,
      query: c.query,
      relevant: c.relevant.length,
      // Recall is against min(|relevant|, k): with 40 labelled neighbours and
      // k=10 even a perfect ranker caps at 0.25, and averaging that in would
      // read as a ranking failure when it is an arithmetic one.
      recall: hits / Math.min(relevant.size, k),
      precision: top.length ? hits / top.length : 0,
      rr: firstRank ? 1 / firstRank : 0,
      hits,
    });
  }
  const mean = f => (per.length ? per.reduce((s, r) => s + f(r), 0) / per.length : 0);
  return {
    cases: per.length,
    k,
    recall: mean(r => r.recall),
    precision: mean(r => r.precision),
    mrr: mean(r => r.rr),
    per,
  };
}

// Real queries actually typed, from lib/retrievals.js's log — the shape fix
// that made `q` durable exists for this. Synthesized queries cover the whole
// corpus evenly; these cover what people really ask, which is neither evenly
// distributed nor guessable. Both matter, so both are offered and neither is
// the default.
//
// A serve with no `q` is skipped: those are the pre-shape lines, unlabelled by
// definition, and inventing a query for them would be fabricating eval data.
function casesFromServes(serves, entries, keyOf, opts = {}) {
  const list = (entries || []).filter(Boolean);
  const graph = fileGraph.buildGraph(list, keyOf);
  const minAffinity = Number.isFinite(opts.minAffinity) ? opts.minAffinity : 0.05;
  const cases = [];
  for (const s of (serves || [])) {
    if (!s || typeof s.q !== 'string' || !s.q.trim()) continue;
    const seed = Array.isArray(s.keys) ? s.keys[0] : null; // rank order: [0] is the top hit
    if (!seed || !graph.byKey.has(seed)) continue;
    const rel = fileGraph.neighbours(graph, seed, { minAffinity });
    if (rel.length === 0) continue;
    cases.push({
      seed,
      query: s.q,
      relevant: rel.map(r => r.key),
      affinities: new Map(rel.map(r => [r.key, r.affinity])),
      heldOut: [...(graph.byKey.get(seed) || [])],
      real: true,
    });
  }
  return { cases, graph };
}

module.exports = {
  buildCases, casesFromServes, score, synthesizeQuery, documentFrequencies, proseOf,
  PROSE_FIELDS, MAX_DF_RATIO, DEFAULT_TERMS,
};
