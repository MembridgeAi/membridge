'use strict';
// The file graph (lib/file-graph.js) and the eval harness built on it
// (lib/search-eval.js). Run directly, or via `node test/run.js search-eval`.
//
// Two things are being pinned here, and the second matters more than the
// first. One: the graph weights files by how discriminating they are, so a
// lockfile every session touches does not make every memory a neighbour of
// every other. Two: the harness cannot grade a ranker using the very edge
// that produced the label — the held-out protocol is the only thing standing
// between "an eval" and "a ranker being marked by itself", so it is asserted
// directly rather than trusted to stay wired.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const keyOf = e => e.key;

async function main() {
  const fileGraph = require('../../lib/file-graph');
  const searchEval = require('../../lib/search-eval');

  // --- the graph ---
  {
    const entries = [
      { key: 'a', files: ['lib/vault.js', 'package.json'] },
      { key: 'b', files: ['lib/vault.js', 'package.json'] },
      { key: 'c', files: ['lib/unrelated.js', 'package.json'] },
      { key: 'd', files: ['package.json'] },
      { key: 'e', files: ['package.json'] },
      { key: 'f', files: ['package.json'] },
    ];
    const g = fileGraph.buildGraph(entries, keyOf);

    check('graph: adjacency is built both ways', () => {
      assert.deepStrictEqual([...g.byFile.get('lib/vault.js')].sort(), ['a', 'b']);
      assert.deepStrictEqual([...g.byKey.get('a')].sort(), ['lib/vault.js', 'package.json']);
    });

    check('graph: paths normalize, so one file is never split into two nodes', () => {
      const n = fileGraph.buildGraph([
        { key: 'x', files: ['./lib/a.js'] },
        { key: 'y', files: ['lib\\a.js'] },
      ], keyOf);
      assert.strictEqual(n.byFile.size, 1, './lib/a.js and lib\\a.js did not unify');
      assert.deepStrictEqual([...n.byFile.get('lib/a.js')].sort(), ['x', 'y']);
    });

    check('graph: a file everyone touches weighs far less than a rare one', () => {
      const rare = fileGraph.fileWeight(g, 'lib/vault.js'); // 2 entries
      const hub = fileGraph.fileWeight(g, 'package.json');  // 6 entries
      assert.ok(rare > hub, `expected the rare file to weigh more (${rare} vs ${hub})`);
      assert.ok(hub < 0.5, `a 6-entry hub file still weighs ${hub}; IDF on files is not biting`);
    });

    check('graph: sharing ONLY a hub file is a near-zero link, not a neighbour', () => {
      // c and d share package.json and nothing else. This is the degenerate
      // case the weighting exists to kill: without it every entry in a repo
      // neighbours every other through the lockfile.
      const weak = fileGraph.affinity(g, 'c', 'd');
      const real = fileGraph.affinity(g, 'a', 'b');
      assert.ok(real > weak * 2, `a real shared file (${real}) did not beat a hub-only one (${weak})`);
      assert.deepStrictEqual(fileGraph.neighbours(g, 'd', { minAffinity: 0.05 }), [],
        'a hub-only link survived the affinity gate');
    });

    check('graph: an entry is never its own neighbour', () => {
      assert.strictEqual(fileGraph.affinity(g, 'a', 'a'), 0);
      assert.ok(!fileGraph.neighbours(g, 'a').some(n => n.key === 'a'));
    });

    check('graph: affinity is symmetric', () => {
      assert.strictEqual(fileGraph.affinity(g, 'a', 'b'), fileGraph.affinity(g, 'b', 'a'));
    });

    check('graph: identical file sets score their BEST SHARED FILE, not a flat 1', () => {
      // The trap cosine alone walks into. Both (a,b) and (d,e) have identical
      // file vectors, so both have cosine exactly 1 — but a/b share a real
      // source file while d/e share nothing but the lockfile. If affinity
      // were pure cosine those two pairs would be indistinguishable, and
      // every entry in a repo would be a perfect neighbour of every other
      // through package.json. Scaling by the strongest shared file's weight
      // is what separates them.
      const ab = fileGraph.affinity(g, 'a', 'b');
      const de = fileGraph.affinity(g, 'd', 'e');
      assert.ok(Math.abs(ab - fileGraph.fileWeight(g, 'lib/vault.js')) < 1e-9,
        `identical sets should score the best shared file's weight, got ${ab}`);
      assert.ok(Math.abs(de - fileGraph.fileWeight(g, 'package.json')) < 1e-9,
        `identical sets should score the best shared file's weight, got ${de}`);
      assert.ok(ab > de * 5,
        `a real shared file (${ab}) barely beat a lockfile-only pair (${de}); both are cosine 1`);
    });

    check('graph: entries sharing no files score 0', () => {
      const two = fileGraph.buildGraph([
        { key: 'p', files: ['lib/one.js'] },
        { key: 'q', files: ['lib/two.js'] },
      ], keyOf);
      assert.strictEqual(fileGraph.affinity(two, 'p', 'q'), 0);
    });

    check('graph: a sweeping refactor does not become everyone\'s nearest neighbour', () => {
      // The mirror image of the hub-file problem: one entry touching
      // everything would otherwise sit at the top of every neighbour list.
      const wide = [];
      for (let i = 0; i < 40; i++) wide.push(`lib/f${i}.js`);
      const gg = fileGraph.buildGraph([
        { key: 'refactor', files: wide },
        { key: 'focused-1', files: ['lib/f0.js'] },
        { key: 'focused-2', files: ['lib/f0.js'] },
      ], keyOf);
      const toRefactor = fileGraph.affinity(gg, 'focused-1', 'refactor');
      const toPeer = fileGraph.affinity(gg, 'focused-1', 'focused-2');
      assert.ok(toPeer > toRefactor,
        `the 40-file refactor (${toRefactor}) outranked a true peer (${toPeer})`);
    });

    check('graph: excludeFiles removes the edge — the held-out protocol', () => {
      assert.ok(fileGraph.affinity(g, 'a', 'b') > 0);
      assert.strictEqual(
        fileGraph.affinity(g, 'a', 'b', { excludeFiles: ['lib/vault.js', 'package.json'] }), 0,
        'holding out every shared file left an edge behind; the eval would grade itself');
      assert.deepStrictEqual(
        fileGraph.neighbours(g, 'a', { excludeFiles: ['lib/vault.js'], minAffinity: 0.05 }), [],
        'neighbours ignored excludeFiles');
    });

    check('graph: affinityToFiles scores an entry against a file footprint', () => {
      assert.ok(fileGraph.affinityToFiles(g, 'a', ['lib/vault.js']) > 0);
      assert.strictEqual(fileGraph.affinityToFiles(g, 'a', ['lib/nothing.js']), 0);
      assert.strictEqual(fileGraph.affinityToFiles(g, 'a', []), 0);
      assert.strictEqual(
        fileGraph.affinityToFiles(g, 'a', ['lib/vault.js'], { excludeFiles: ['lib/vault.js'] }), 0,
        'affinityToFiles ignored excludeFiles');
    });
  }

  // --- query synthesis ---
  {
    const corpus = [];
    for (let i = 0; i < 10; i++) {
      corpus.push({ key: `c${i}`, summary: 'the service handles requests', files: ['lib/x.js'] });
    }
    corpus.push({
      key: 'rare', summary: 'the service handles requests', files: ['lib/x.js'],
      decisions: 'quaternion slerp interpolation replaced euler angles',
    });
    const df = searchEval.documentFrequencies(corpus);

    check('eval: a synthesized query keeps the RARE terms and drops corpus-wide ones', () => {
      const q = searchEval.synthesizeQuery(corpus[corpus.length - 1], df, corpus.length);
      const terms = q.split(' ');
      assert.ok(terms.includes('quaternion'), `expected the distinctive term, got "${q}"`);
      for (const common of ['service', 'handles', 'requests']) {
        assert.ok(!terms.includes(common),
          `"${common}" appears in every entry and cannot discriminate, but survived into "${q}"`);
      }
    });

    check('eval: query synthesis reads PROSE ONLY, never the file list', () => {
      // A query carrying the seed's own file paths would retrieve its
      // file-neighbours by string match and score the label against itself —
      // `files` is a searchable field in the index, so this is a real path.
      const e = { key: 'z', summary: 'oscillator drift correction', files: ['infra/telemetry-collector.tf'] };
      const q = searchEval.synthesizeQuery(e, searchEval.documentFrequencies([e]), 1);
      assert.ok(!/telemetry|collector|\.tf/.test(q),
        `a file path leaked into the synthesized query: "${q}"`);
      assert.ok(!searchEval.proseOf(e).includes('telemetry-collector'),
        'proseOf must not reach the file list');
    });

    check('eval: an entry with no distinctive prose yields no query, so no case', () => {
      assert.strictEqual(searchEval.synthesizeQuery(corpus[0], df, corpus.length), '');
    });
  }

  // --- case construction ---
  {
    const entries = [
      { key: 'v1', decisions: 'vault rotation moved to the read path first', files: ['infra/vault.tf'] },
      { key: 'v2', decisions: 'sealing ceremony automated with a systemd timer', files: ['infra/vault.tf'] },
      { key: 'lonely', decisions: 'zeppelin notebook upgrade', files: ['other/zeppelin.py'] },
      { key: 'nofiles', decisions: 'kubernetes ingress annotations tidied', files: [] },
    ];

    check('eval: a case is built only where BOTH a query and a label exist', () => {
      const { cases } = searchEval.buildCases(entries, keyOf, { minAffinity: 0.05 });
      const seeds = cases.map(c => c.seed).sort();
      assert.deepStrictEqual(seeds, ['v1', 'v2'],
        'entries with no file-neighbour must be SKIPPED, not scored as misses');
    });

    check('eval: a case labels the seed\'s file-neighbours as relevant', () => {
      const { cases } = searchEval.buildCases(entries, keyOf, { minAffinity: 0.05 });
      const c = cases.find(x => x.seed === 'v1');
      assert.deepStrictEqual(c.relevant, ['v2']);
    });

    check('eval: a case carries the seed\'s files as heldOut, for the held-out protocol', () => {
      const { cases } = searchEval.buildCases(entries, keyOf, { minAffinity: 0.05 });
      const c = cases.find(x => x.seed === 'v1');
      assert.deepStrictEqual(c.heldOut, ['infra/vault.tf'],
        'without heldOut a file-graph ranker would be graded on the edge that made the label');
    });
  }

  // --- metrics ---
  {
    const cases = [{ seed: 's', query: 'q', relevant: ['r1', 'r2'], heldOut: [] }];

    check('metrics: a perfect ranking scores recall 1, mrr 1', () => {
      const res = searchEval.score(cases, () => ['r1', 'r2'], { k: 10 });
      assert.strictEqual(res.recall, 1);
      assert.strictEqual(res.mrr, 1);
      assert.strictEqual(res.precision, 1);
    });

    check('metrics: the SEED is stripped before scoring, never counted as a win', () => {
      // The seed is what the query was written from; it ranks first on any
      // sane ranker, and leaving it in would inflate every metric.
      const res = searchEval.score(cases, () => ['s', 'r1', 'r2'], { k: 10 });
      assert.strictEqual(res.mrr, 1, 'the seed was counted as the first result');
      assert.strictEqual(res.precision, 1, 'the seed was counted in the served page');
    });

    check('metrics: a miss scores 0 and does not throw', () => {
      const res = searchEval.score(cases, () => ['nope'], { k: 10 });
      assert.strictEqual(res.recall, 0);
      assert.strictEqual(res.mrr, 0);
      const empty = searchEval.score(cases, () => [], { k: 10 });
      assert.strictEqual(empty.recall, 0);
      assert.strictEqual(empty.precision, 0);
    });

    check('metrics: reciprocal rank reflects WHERE the first hit landed', () => {
      const res = searchEval.score(cases, () => ['x', 'x2', 'r1'], { k: 10 });
      assert.ok(Math.abs(res.mrr - 1 / 3) < 1e-9, `expected 1/3, got ${res.mrr}`);
    });

    check('metrics: recall is capped by k, so a big label set is not an automatic fail', () => {
      // 20 labelled neighbours and k=5: even a perfect ranker can only serve
      // 5 of them, and dividing by 20 would read as a ranking failure when it
      // is an arithmetic one.
      const many = [{ seed: 's', query: 'q', heldOut: [], relevant: Array.from({ length: 20 }, (_, i) => `r${i}`) }];
      const res = searchEval.score(many, () => Array.from({ length: 20 }, (_, i) => `r${i}`), { k: 5 });
      assert.strictEqual(res.recall, 1, 'a perfect ranking scored below 1 purely because k < |relevant|');
    });
  }

  // --- real queries from the retrievals log ---
  {
    const entries = [
      { key: 'v1', decisions: 'vault rotation', files: ['infra/vault.tf'] },
      { key: 'v2', decisions: 'sealing ceremony', files: ['infra/vault.tf'] },
    ];

    check('eval: real serves become cases, keyed on the top-ranked hit', () => {
      const { cases } = searchEval.casesFromServes(
        [{ q: 'vault rotation', keys: ['v1', 'v2'] }], entries, keyOf, { minAffinity: 0.05 });
      assert.strictEqual(cases.length, 1);
      assert.strictEqual(cases[0].query, 'vault rotation');
      assert.strictEqual(cases[0].seed, 'v1', 'the seed must be the top hit, which keys[0] is');
      assert.deepStrictEqual(cases[0].relevant, ['v2']);
    });

    check('eval: pre-shape serves (no q) are skipped, never given an invented query', () => {
      const { cases } = searchEval.casesFromServes(
        [{ keys: ['v1'] }, { q: '', keys: ['v1'] }], entries, keyOf, { minAffinity: 0.05 });
      assert.deepStrictEqual(cases, [],
        'a serve with no recorded query became eval data anyway');
    });
  }

  // --- end to end, through the real search path ---
  {
    const util = require('../../lib/util');
    const activity = require('../../lib/activity');

    // Three sessions on one file, described in DELIBERATELY different words.
    // This is the case the whole exercise is about: lexical search cannot see
    // that they are related, and the file graph can.
    const projPath = path.join(ROOT, 'projects', 'evalproj');
    fs.mkdirSync(path.join(projPath, '.membridge'), { recursive: true });
    const state = util.loadState();
    state.projects[projPath] = {
      events: [],
      teamEntries: [
        {
          author: 'A', ts: '2026-06-01T00:00:00.000Z', source: 'Claude Code', session: 'ev-1',
          decisions: 'porcupine quantizer rebuilt against frozen centroids',
          files: ['lib/quant.js'], distilled: true,
        },
        {
          author: 'B', ts: '2026-06-02T00:00:00.000Z', source: 'Claude Code', session: 'ev-2',
          decisions: 'marmoset codebook pruning now runs before serialization',
          files: ['lib/quant.js'], distilled: true,
        },
        {
          author: 'C', ts: '2026-06-03T00:00:00.000Z', source: 'Claude Code', session: 'ev-3',
          decisions: 'wildebeest telemetry sampling dropped to one percent',
          files: ['lib/telemetry.js'], distilled: true,
        },
      ],
    };
    util.saveState(state);

    check('eval e2e: the harness builds cases from a real corpus and scores the live ranker', () => {
      const ctx = activity.loadContext();
      // projectCorpus splits the corpus by provenance; the eval wants the
      // whole thing, since a file link is a file link whoever recorded it.
      const { local, team } = activity.projectCorpus(
        projPath, ctx.state.projects[projPath], ctx.config, ctx.regexes);
      const entries = [...local, ...team];
      assert.ok(entries.length >= 3, `fixture: expected the planted rows, got ${entries.length}`);
      const withKeys = entries.map(e => ({ ...e, key: activity.eventKey(e) }));
      const { cases } = searchEval.buildCases(withKeys, keyOf, { minAffinity: 0.05 });

      // ev-1 and ev-2 share lib/quant.js, so each labels the other. ev-3
      // shares nothing and yields no case.
      assert.strictEqual(cases.length, 2, `expected the two quant.js sessions, got ${cases.length}`);

      const res = searchEval.score(cases, query => {
        const out = activity.searchMemory({ query, limit: 10 });
        return out.results.map(r => activity.eventKey(r));
      }, { k: 10 });

      assert.strictEqual(res.cases, 2);
      // The metric is REPORTED, not asserted at a threshold. These sessions
      // share no vocabulary at all, so a lexical ranker is expected to score
      // ~0 here — that gap is the finding, and pinning a floor would only
      // pin today's number. What must hold is that the harness ran and
      // produced a well-formed metric.
      for (const m of ['recall', 'precision', 'mrr']) {
        assert.ok(Number.isFinite(res[m]) && res[m] >= 0 && res[m] <= 1,
          `${m} came back as ${res[m]}, which is not a score`);
      }
      h.log?.(`  lexical baseline on this fixture: recall=${res.recall.toFixed(3)} mrr=${res.mrr.toFixed(3)}`);
    });

    // --- the backfill, end to end ---
    // ev-1 and ev-2 both touched lib/quant.js and share NOT ONE WORD. That is
    // the whole case for the file graph, and the one BM25 cannot answer at any
    // weighting, so these run against the real search path rather than a unit.
    check('backfill: a file-neighbour with zero lexical overlap comes back', () => {
      const res = activity.searchMemory({ query: 'porcupine quantizer centroids', limit: 10 });
      const sessions = res.results.map(r => r.session);
      assert.ok(sessions.includes('ev-1'), `fixture: the lexical hit is missing from [${sessions}]`);
      assert.ok(sessions.includes('ev-2'),
        `ev-2 shares lib/quant.js and no vocabulary; the file graph did not reach it: [${sessions}]`);
      assert.ok(!sessions.includes('ev-3'),
        `ev-3 shares neither words nor files and must not be backfilled: [${sessions}]`);
    });

    check('backfill: a backfilled row sits BELOW every lexical hit', () => {
      const res = activity.searchMemory({ query: 'porcupine quantizer centroids', limit: 10 });
      const sessions = res.results.map(r => r.session);
      assert.ok(sessions.indexOf('ev-1') < sessions.indexOf('ev-2'),
        `a file neighbour outranked a real lexical hit: [${sessions}]`);
    });

    check('backfill: a backfilled row is LABELLED as one, not passed off as a match', () => {
      const res = activity.searchMemory({ query: 'porcupine quantizer centroids', limit: 10 });
      const lexical = res.results.find(r => r.session === 'ev-1');
      const graphed = res.results.find(r => r.session === 'ev-2');
      assert.ok(graphed.fileAffinity > 0, 'no fileAffinity on a backfilled row');
      assert.strictEqual(lexical.fileAffinity, undefined,
        'a genuine lexical hit was labelled as a file-graph result');
      assert.deepStrictEqual(graphed.matched, [],
        'a backfilled row claimed lexical field matches it does not have');
    });

    check('backfill: total counts what was served, never fewer than results', () => {
      const res = activity.searchMemory({ query: 'porcupine quantizer centroids', limit: 10 });
      assert.ok(res.total >= res.results.length,
        `total ${res.total} is below the ${res.results.length} results actually returned`);
    });

    check('backfill: a FULL page gets none — no lexical hit is ever displaced', () => {
      const res = activity.searchMemory({ query: 'porcupine quantizer centroids', limit: 1 });
      assert.strictEqual(res.results.length, 1);
      assert.strictEqual(res.results[0].session, 'ev-1',
        'the backfill displaced the lexical hit instead of filling empty slots');
    });

    check('backfill: the user\'s filters bind on backfilled rows too', () => {
      // ev-2 is the backfill candidate and its author is B. Filtering to A must
      // drop it, exactly as it would a lexical hit — a backfill that ignored
      // filters would serve a teammate the rows they just filtered away.
      const res = activity.searchMemory({ query: 'porcupine quantizer centroids', author: 'A', limit: 10 });
      const sessions = res.results.map(r => r.session);
      assert.ok(!sessions.includes('ev-2'),
        `an author filter did not bind on the backfilled row: [${sessions}]`);
      const dated = activity.searchMemory({
        query: 'porcupine quantizer centroids', until: '2026-06-01', limit: 10 });
      assert.ok(!dated.results.map(r => r.session).includes('ev-2'),
        'a date bound did not bind on the backfilled row');
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
