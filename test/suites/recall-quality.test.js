'use strict';
// Recall-quality harness: end-to-end scenarios against activity.searchMemory
// (state on disk -> corpus assembly -> filters -> ranking -> slice), scored
// on recall and precision like an eval, run like a test.
//
// The search suite (test/suites/search.test.js) unit-tests the SCORER on
// hand-built entries. This suite exists one level up, where the historical
// regressions actually happened: entries dropping out of the corpus assembly
// (worktree keys, archive rows, teamAccessLost), twins surviving dedup, and
// filters silently emptying the pool before ranking. Every scenario states
// WHAT a user must be able to find again, so a ranking change that breaks
// real recall fails here even if every scorer unit-check still passes.
//
// Deterministic on purpose: the ranker is lexical (lib/search.js), no
// embeddings, no LLM — so unlike an eval-with-a-model, exact recall = 1 and
// precision = 1 are fair assertions, not aspirations. Scenarios share one
// state (searches are cross-project by design), so each uses its own
// distinctive vocabulary; a probe leaking hits from another scenario is
// itself a finding (see the `exact` assertions).
//
// Run directly, or via `node test/run.js recall-quality`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// One teamEntries row with every field the wire carries, defaulted null —
// scenarios override only what they mean to be searchable.
function row(overrides) {
  return {
    author: 'Teammate', ts: '2026-07-01T00:00:00.000Z', source: 'Claude Code',
    session: null, ask: null, goal: null, summary: null, decisions: null,
    gotchas: null, headline: null, distilled: true, files: [], changes: null,
    ...overrides,
  };
}

// scenario: { name, projects: { <basename>: [rows] }, probes: [probe] }
// probe: {
//   query, args?,            — what is asked, plus optional filters
//   expect: [sessions],      — every one must appear in the top k (recall = 1)
//   forbid?: [sessions],     — none of these may appear in the top k
//   exact?: true,            — the top k contains ONLY expected sessions (precision = 1)
//   top?: session,           — this session must rank first
//   k?: number,              — result budget (default 10)
//   description,             — why a miss here is a real product failure
// }
const SCENARIOS = [
  {
    name: 'decision recall across sessions',
    projects: {
      'keycloak-api': [
        row({
          session: 'kc-decide', ts: '2026-06-10T00:00:00.000Z',
          decisions: 'keycloak migration goes read-path first, dual-write behind a flag',
        }),
        row({
          session: 'kc-cutover', ts: '2026-07-05T00:00:00.000Z',
          summary: 'keycloak migration cutover finished and the legacy sessions table is gone',
        }),
        row({
          session: 'kc-noise', ts: '2026-07-06T00:00:00.000Z',
          gotchas: 'harbor registry rejects manifests when the disk fills',
        }),
      ],
    },
    probes: [
      {
        query: 'keycloak migration',
        expect: ['kc-decide', 'kc-cutover'],
        forbid: ['kc-noise'],
        exact: true,
        top: 'kc-decide',
        k: 5,
        description: 'both halves of a decision arc come back, the deliberate decision first',
      },
    ],
  },
  {
    name: 'file-only rows are findable',
    projects: {
      'terraform-infra': [
        row({ session: 'tf-vault', ts: '2026-05-01T00:00:00.000Z', files: ['infra/vault.tf'] }),
      ],
    },
    probes: [
      {
        query: 'vault',
        expect: ['tf-vault'],
        exact: true,
        description: 'a teammate row that shared nothing but a file list is still reachable by that file',
      },
    ],
  },
  {
    name: 'project filter narrows, unfiltered spans',
    projects: {
      'ratelimit-api': [
        row({ session: 'rl-api', decisions: 'ratelimit tokens live in redis with a sliding window' }),
      ],
      'ratelimit-worker': [
        row({ session: 'rl-worker', ts: '2026-07-02T00:00:00.000Z', decisions: 'ratelimit retries back off exponentially in the worker' }),
      ],
    },
    probes: [
      {
        query: 'ratelimit',
        expect: ['rl-api', 'rl-worker'],
        exact: true,
        description: 'the same topic in two projects surfaces both when unfiltered',
      },
      {
        query: 'ratelimit',
        args: { project: 'ratelimit-api' },
        expect: ['rl-api'],
        forbid: ['rl-worker'],
        exact: true,
        description: 'a project filter must not leak the sibling project\'s work',
      },
    ],
  },
  {
    name: 'author filter',
    projects: {
      'billing-svc': [
        row({ session: 'bill-a', author: 'Alice', decisions: 'stripe billing webhooks are verified against the raw body' }),
        row({ session: 'bill-b', author: 'Bob', ts: '2026-07-03T00:00:00.000Z', decisions: 'stripe billing retries are capped at five attempts' }),
      ],
    },
    probes: [
      {
        query: 'stripe billing',
        args: { author: 'alice' },
        expect: ['bill-a'],
        forbid: ['bill-b'],
        exact: true,
        description: 'an author filter is a name substring and excludes everyone else',
      },
    ],
  },
  {
    name: 'identity twins collapse to the richer row',
    projects: {
      'gateway-svc': [
        row({
          session: 'twin-1', ts: '2026-06-20T00:00:00.000Z', author: 'andrewludwigbrown',
          summary: 'grpc gateway deadline propagation fixed',
        }),
        row({
          session: 'twin-1', ts: '2026-06-20T00:00:00.000Z', author: 'Andrew Brown',
          summary: 'grpc gateway deadline propagation fixed',
          headline: 'gateway deadlines now propagate end to end',
        }),
      ],
    },
    probes: [
      {
        query: 'grpc gateway deadline',
        expect: ['twin-1'],
        exact: true,
        k: 5,
        maxResults: 1,
        description: 'one event pushed under two display names must come back once, as the richer row',
      },
    ],
  },
  {
    name: 'old exact beats recent partial',
    projects: {
      'tokenizer-lib': [
        row({ session: 'tok-recent', ts: '2026-07-20T00:00:00.000Z', summary: 'bpe cleanup pass over the vocab tables' }),
        row({
          session: 'tok-old', ts: '2026-02-01T00:00:00.000Z',
          headline: 'bpe merges rebuilt against the frozen vocab',
          decisions: 'bpe merges are recomputed from the frozen vocab snapshot, never live counts',
        }),
      ],
    },
    probes: [
      {
        query: 'bpe merges vocab',
        expect: ['tok-old', 'tok-recent'],
        top: 'tok-old',
        description: 'relevance outranks recency: a five-month-old exact answer beats last week\'s partial one',
      },
    ],
  },
  {
    name: 'date bounds include the whole boundary day',
    projects: {
      'cron-svc': [
        row({ session: 'cron-early', ts: '2026-06-14T23:00:00.000Z', decisions: 'quartz cron misfires are coalesced' }),
        row({ session: 'cron-late', ts: '2026-06-15T09:00:00.000Z', decisions: 'quartz cron shards by tenant id' }),
      ],
    },
    probes: [
      {
        query: 'quartz cron',
        args: { since: '2026-06-15' },
        expect: ['cron-late'],
        forbid: ['cron-early'],
        exact: true,
        description: 'a bare-date since bound keeps everything from that day onward, nothing before',
      },
    ],
  },
];

async function main() {
  const util = require('../../lib/util');
  const activity = require('../../lib/activity');

  // Seed every scenario into one state up front — mirrors reality, where all
  // projects share the corpus and a query has to win against everything.
  {
    const state = util.loadState();
    for (const scenario of SCENARIOS) {
      for (const [name, rows] of Object.entries(scenario.projects)) {
        const projPath = path.join(ROOT, 'projects', name);
        fs.mkdirSync(path.join(projPath, '.membridge'), { recursive: true });
        state.projects[projPath] = { events: [], teamEntries: rows };
      }
    }
    util.saveState(state);
  }

  for (const scenario of SCENARIOS) {
    for (const probe of scenario.probes) {
      const label = `recall quality: ${scenario.name} — "${probe.query}"${probe.args ? ' ' + JSON.stringify(probe.args) : ''}`;
      check(label, () => {
        const res = activity.searchMemory({ query: probe.query, limit: probe.k || 10, ...(probe.args || {}) });
        const sessions = res.results.map(r => r.session);

        // Recall: every expected session is served. This is the assertion
        // that actually matches the product promise ("ask and it resurfaces").
        for (const want of probe.expect) {
          assert.ok(sessions.includes(want),
            `${probe.description}\n  MISSING ${want} in [${sessions.join(', ')}]`);
        }
        // Forbidden sessions: relevance leaks are failures too, not noise.
        for (const bad of (probe.forbid || [])) {
          assert.ok(!sessions.includes(bad),
            `${probe.description}\n  LEAKED ${bad} into [${sessions.join(', ')}]`);
        }
        // Precision: with `exact`, the page contains ONLY expected sessions —
        // a scenario vocabulary bleeding across projects fails loudly here.
        if (probe.exact) {
          const allowed = new Set(probe.expect);
          for (const got of sessions) {
            assert.ok(allowed.has(got),
              `${probe.description}\n  UNEXPECTED ${got} in [${sessions.join(', ')}]`);
          }
        }
        if (probe.top) {
          assert.strictEqual(sessions[0], probe.top,
            `${probe.description}\n  expected ${probe.top} first, got [${sessions.join(', ')}]`);
        }
        if (probe.maxResults != null) {
          assert.ok(sessions.length <= probe.maxResults,
            `${probe.description}\n  expected at most ${probe.maxResults} results, got [${sessions.join(', ')}]`);
        }
      });
    }
  }

  // The twins scenario also pins WHICH twin survives: the richer row (the one
  // with a headline) must be the one served, not merely "some copy of it".
  check('recall quality: the surviving twin is the richer row (headline present)', () => {
    const res = activity.searchMemory({ query: 'grpc gateway deadline' });
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].headline, 'gateway deadlines now propagate end to end',
      'dedup kept the poorer copy of the twin event');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
