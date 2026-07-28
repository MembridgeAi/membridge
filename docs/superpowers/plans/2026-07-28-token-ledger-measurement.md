# Token Ledger (Measurement Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MemBridge measure, from session logs it already tails, exactly how many tokens each project burns re-reading files it has already read.

**Architecture:** The Claude Code adapter already iterates the assistant records that carry per-request `usage` and tool calls, and discards both. It starts emitting two new event kinds, `usage` and `read`. A new pure module `lib/ledger.js` folds those into a residence-weighted cost ledger — the same method as the reference Python implementation in `token-spend-analysis/ledger_fixed.py` — and classifies every read as first-ever, same-session repeat, or cross-session repeat. Results persist per project and are served over the existing HTTP API.

**Tech Stack:** Node ≥18, CommonJS, zero new runtime dependencies. Tests are `check()` blocks in `test/run-tests.js` using `assert`, run with `npm test`.

**Scope:** This plan is the measurement half only. It changes no agent behaviour and intercepts nothing. Skeleton extraction, the recall store, the PreToolUse hook, the holdout and the savings UI are separate plans that depend on this one.

## Global Constraints

- **Zero new runtime dependencies.** `web-tree-sitter` is approved for a later plan; nothing in this one may add a dependency.
- **CommonJS, `'use strict'` at the top of every file.** Match surrounding style.
- **Tests stay offline.** No network. Fixtures under the temp `ROOT` in `test/run-tests.js`.
- **Never modify** `token-spend-analysis/ledger_fixed.py` or `classify2.py` — they are the reference oracle for Task 8.
- **Dedupe on `message.id` is mandatory.** One API request is written as several transcript records, each repeating the same `usage`. Missing this inflates request counts and volume by roughly 2x.
- **Context size is provider-specific and must go through `normalizeUsage`.** Anthropic's three input fields are disjoint and sum to context; OpenAI's and Google's cached counts are *subsets* of their input count. Never sum fields directly. Output tokens are never part of context on any provider.
- **Prices live in exactly one place** (`lib/pricing.js`), keyed by provider. No cost arithmetic anywhere else.
- **Token figures are the product; dollar figures are optional.** The UI shows tokens by default (spec §8.1), so an unverified rate can never mislead a user.
- Files stay focused; none of the new modules should exceed ~250 lines.

---

### Task 1: Provider-agnostic usage normalisation and pricing

**Files:**
- Create: `lib/usage-normalize.js`
- Create: `lib/pricing.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing
- Produces: `normalizeUsage(raw, provider) → {input, cacheRead, cacheWrite, output, context}` and `providerOf(source, model) → 'anthropic'|'openai'|'google'|'unknown'`; `priceOf(model, provider) → {inPerMTok, outPerMTok, cacheReadMult, cacheWriteMult}`, `requestCostUsd(norm, model, provider) → {inCost, outCost}`

**This is the task that keeps the whole ledger honest across vendors.** The three providers disagree about what `input_tokens` means:

| provider | context size is | cached tokens are |
|---|---|---|
| Anthropic | `input + cache_creation + cache_read` | **separate fields**, added on |
| OpenAI / Codex | `input_tokens` alone | `cached_input_tokens`, **already inside** `input_tokens` |
| Google / Gemini | `promptTokenCount` alone | `cachedContentTokenCount`, **already inside** it |

Summing the fields uniformly would double-count every cached token on OpenAI and Google — silently, and worst on exactly the long sessions we care about most.

- [ ] **Step 1: Write the failing test**

Add to `test/run-tests.js`, after the existing `util.isTempPath` check:

```js
check('usage: provider shapes normalise to one context figure without double counting', () => {
  const { normalizeUsage, providerOf } = require('../lib/usage-normalize');

  // Anthropic: the three input fields are disjoint and sum to context.
  const a = normalizeUsage({
    input_tokens: 100, cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 10000, output_tokens: 500,
  }, 'anthropic');
  assert.strictEqual(a.context, 11100);
  assert.strictEqual(a.cacheRead, 10000);
  assert.strictEqual(a.cacheWrite, 1000);
  assert.strictEqual(a.output, 500);

  // OpenAI/Codex: cached_input_tokens is a SUBSET of input_tokens.
  const o = normalizeUsage({
    input_tokens: 18093, cached_input_tokens: 1408,
    output_tokens: 494, reasoning_output_tokens: 23,
  }, 'openai');
  assert.strictEqual(o.context, 18093, 'must not add cached on top of input');
  assert.strictEqual(o.cacheRead, 1408);
  assert.strictEqual(o.cacheWrite, 0, 'OpenAI has no cache-write concept');
  assert.strictEqual(o.output, 494 + 23, 'reasoning tokens are billed output');

  // Google/Gemini: same subset semantics, different names.
  const g = normalizeUsage({
    promptTokenCount: 8000, cachedContentTokenCount: 2000, candidatesTokenCount: 300,
  }, 'google');
  assert.strictEqual(g.context, 8000);
  assert.strictEqual(g.cacheRead, 2000);
  assert.strictEqual(g.output, 300);

  assert.strictEqual(providerOf('Claude Code', 'claude-opus-4-6'), 'anthropic');
  assert.strictEqual(providerOf('Codex', 'gpt-5'), 'openai');
  assert.strictEqual(providerOf('Gemini CLI', 'gemini-3-pro'), 'google');
});

check('pricing: cached-input rates are per-model, and prefix matching is longest-first', () => {
  const pricing = require('../lib/pricing');
  const { normalizeUsage } = require('../lib/usage-normalize');

  const a = normalizeUsage({
    input_tokens: 100, cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 10000, output_tokens: 500,
  }, 'anthropic');
  const ac = pricing.requestCostUsd(a, 'claude-opus-4-6', 'anthropic');
  // 100 @ $5 + 10000 @ $0.50 + 1000 write @ 5*1.25 = $6.75/MTok-equivalent
  const expectA = (100 * 5 + 10000 * 0.5 + 1000 * 5 * 1.25) / 1e6;
  assert.strictEqual(Math.round(ac.inCost * 1e9), Math.round(expectA * 1e9));
  assert.strictEqual(Math.round(ac.outCost * 1e9), Math.round((500 * 25 / 1e6) * 1e9));

  // The cache discount is NOT uniform across a vendor: gpt-5 caches at 0.1x
  // input while gpt-4.1 and o1 are far dearer. A provider-wide multiplier
  // would misprice most of the lineup.
  assert.strictEqual(pricing.priceOf('gpt-5', 'openai').cachedInPerMTok, 0.125);
  assert.strictEqual(pricing.priceOf('gpt-4.1', 'openai').cachedInPerMTok, 0.5);
  assert.strictEqual(pricing.priceOf('o1', 'openai').cachedInPerMTok, 7.5);

  // Longest-prefix matching: gpt-5-mini must not resolve to gpt-5.
  assert.strictEqual(pricing.priceOf('gpt-5-mini', 'openai').inPerMTok, 0.25);
  assert.strictEqual(pricing.priceOf('gpt-5', 'openai').inPerMTok, 1.25);

  // OpenAI: uncached portion at full rate, cached portion at the cached rate,
  // and no write cost at all.
  const o = normalizeUsage({ input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 100 }, 'openai');
  const expectO = (2000 * 1.25 + 8000 * 0.125) / 1e6;
  assert.strictEqual(Math.round(pricing.requestCostUsd(o, 'gpt-5', 'openai').inCost * 1e9),
    Math.round(expectO * 1e9));

  // Google caches at 0.1x across the range.
  assert.strictEqual(pricing.priceOf('gemini-2.5-pro', 'google').cachedInPerMTok, 0.125);

  // Unknown models never throw and never price at zero.
  assert.ok(pricing.priceOf('some-future-model', 'unknown').inPerMTok > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "provider shapes normalise"`
Expected: FAIL with `Cannot find module '../lib/usage-normalize'`

- [ ] **Step 3: Write the normaliser**

Create `lib/usage-normalize.js`:

```js
'use strict';
// Every vendor reports token usage in its own shape, and they disagree about
// whether cached tokens are INSIDE the input count or beside it. Getting this
// wrong double-counts cache on OpenAI and Google -- silently, and worst on the
// long sessions that matter most. Normalise once, here, and let the rest of
// the ledger be vendor-blind.

function providerOf(source, model) {
  const s = String(source || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (s.includes('claude') || m.startsWith('claude')) return 'anthropic';
  if (s.includes('codex') || s.includes('openai') || /^(gpt|o\d)/.test(m)) return 'openai';
  if (s.includes('gemini') || s.includes('google') || m.startsWith('gemini')) return 'google';
  return 'unknown';
}

function normalizeUsage(raw, provider) {
  const u = raw || {};
  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, context = 0;

  if (provider === 'openai') {
    // cached_input_tokens is a SUBSET of input_tokens -- never added on top.
    const details = u.prompt_tokens_details || {};
    context = u.input_tokens || u.prompt_tokens || 0;
    cacheRead = u.cached_input_tokens || details.cached_tokens || 0;
    input = Math.max(0, context - cacheRead);
    output = (u.output_tokens || u.completion_tokens || 0) + (u.reasoning_output_tokens || 0);
  } else if (provider === 'google') {
    // cachedContentTokenCount is likewise a subset of promptTokenCount.
    context = u.promptTokenCount || 0;
    cacheRead = u.cachedContentTokenCount || 0;
    input = Math.max(0, context - cacheRead);
    output = u.candidatesTokenCount || 0;
  } else {
    // Anthropic and anything unknown: the three input fields are disjoint.
    input = u.input_tokens || 0;
    cacheRead = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation || {};
    cacheWrite = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0)
      || (u.cache_creation_input_tokens || 0);
    output = u.output_tokens || 0;
    context = input + cacheRead + cacheWrite;
  }

  return { input, cacheRead, cacheWrite, output, context, raw: u };
}

module.exports = { providerOf, normalizeUsage };
```

- [ ] **Step 4: Write the pricing table**

Create `lib/pricing.js`:

```js
'use strict';
// Single source of truth for token pricing, in USD per 1M tokens as
// [input, cachedInput, output].
//
// The cached-input price is stored EXPLICITLY rather than as a multiplier,
// because the discount is per-MODEL, not per-provider: OpenAI's GPT-5 family
// caches at 0.1x input, GPT-4.1 and o3 at 0.25x, and o1/o3-mini at 0.5x. A
// single provider-wide multiplier would misprice most of the lineup.
//
// Cache WRITE is separate and provider-level: only Anthropic charges to
// populate the cache (1.25x input for the 5-minute TTL, 2x for the hour).
// OpenAI and Google cache implicitly at no write cost.
//
// Rates verified 2026-07-28 from developers.openai.com/api/docs/pricing and
// ai.google.dev/gemini-api/docs/pricing. THEY GO STALE. The UI reports tokens
// by default (spec section 8.1) precisely so a stale rate here cannot mislead
// anyone; a dollar figure is only ever shown when the user supplies their own
// rate or explicitly opts in.

const TABLE = {
  anthropic: {
    cacheWriteMult: 1.25,
    models: {
      'claude-fable-5': [10.0, 1.0, 50.0],
      'claude-opus-5': [5.0, 0.5, 25.0],
      'claude-opus-4-8': [5.0, 0.5, 25.0],
      'claude-opus-4-7': [5.0, 0.5, 25.0],
      'claude-opus-4-6': [5.0, 0.5, 25.0],
      'claude-opus-4-5': [5.0, 0.5, 25.0],
      'claude-sonnet-5': [3.0, 0.3, 15.0],
      'claude-sonnet-4-6': [3.0, 0.3, 15.0],
      'claude-sonnet-4-5': [3.0, 0.3, 15.0],
      'claude-haiku-4-5': [1.0, 0.1, 5.0],
    },
    fallback: [5.0, 0.5, 25.0],
  },
  openai: {
    cacheWriteMult: 0,
    models: {
      'gpt-5.6-sol': [5.0, 0.5, 30.0],
      'gpt-5.6-terra': [2.5, 0.25, 15.0],
      'gpt-5.6-luna': [1.0, 0.1, 6.0],
      'gpt-5.5': [5.0, 0.5, 30.0],
      'gpt-5.4': [2.5, 0.25, 15.0],
      'gpt-5.4-mini': [0.75, 0.075, 4.5],
      'gpt-5.4-nano': [0.2, 0.02, 1.25],
      'gpt-5.2': [1.75, 0.175, 14.0],
      'gpt-5.1': [1.25, 0.125, 10.0],
      'gpt-5-mini': [0.25, 0.025, 2.0],
      'gpt-5-nano': [0.05, 0.005, 0.4],
      'gpt-5': [1.25, 0.125, 10.0],
      'gpt-4.1-mini': [0.4, 0.1, 1.6],
      'gpt-4.1-nano': [0.1, 0.025, 0.4],
      'gpt-4.1': [2.0, 0.5, 8.0],
      'o4-mini': [1.1, 0.275, 4.4],
      'o3-mini': [1.1, 0.55, 4.4],
      'o3': [2.0, 0.5, 8.0],
      'o1-mini': [1.1, 0.55, 4.4],
      'o1': [15.0, 7.5, 60.0],
    },
    fallback: [1.25, 0.125, 10.0],
  },
  google: {
    cacheWriteMult: 0,
    models: {
      'gemini-3.6-flash': [1.5, 0.15, 7.5],
      'gemini-3.5-flash-lite': [0.3, 0.03, 2.5],
      'gemini-3.5-flash': [1.5, 0.15, 9.0],
      'gemini-3.1-flash-lite': [0.25, 0.025, 1.5],
      'gemini-2.5-pro': [1.25, 0.125, 10.0],
      'gemini-2.5-flash-lite': [0.1, 0.01, 0.4],
      'gemini-2.5-flash': [0.3, 0.03, 2.5],
    },
    fallback: [1.25, 0.125, 10.0],
  },
  unknown: { cacheWriteMult: 0, models: {}, fallback: [1.25, 0.125, 10.0] },
};

function priceOf(model, provider) {
  const p = TABLE[provider] || TABLE.unknown;
  const m = String(model || '').split('[')[0].trim().toLowerCase();
  let hit = p.models[m];
  if (!hit) {
    // Longest key first, so 'gpt-5-mini' is not shadowed by 'gpt-5'.
    const keys = Object.keys(p.models).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (m.startsWith(key)) { hit = p.models[key]; break; }
    }
  }
  const [inPerMTok, cachedInPerMTok, outPerMTok] = hit || p.fallback;
  return { inPerMTok, cachedInPerMTok, outPerMTok, cacheWriteMult: p.cacheWriteMult };
}

// Takes a NORMALISED usage object from usage-normalize.js, never a raw one.
function requestCostUsd(norm, model, provider) {
  const n = norm || {};
  const p = priceOf(model, provider);
  const inCost = ((n.input || 0) * p.inPerMTok
    + (n.cacheRead || 0) * p.cachedInPerMTok
    + (n.cacheWrite || 0) * p.inPerMTok * p.cacheWriteMult) / 1e6;
  return { inCost, outCost: (n.output || 0) * p.outPerMTok / 1e6 };
}

module.exports = { priceOf, requestCostUsd, TABLE };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -A3 -E "provider shapes normalise|cache multipliers are per-provider"`
Expected: both PASS

- [ ] **Step 6: Commit**

```bash
git add lib/usage-normalize.js lib/pricing.js test/run-tests.js
git commit -m "feat(ledger): provider-agnostic usage normalisation and pricing"
```

---

### Task 2: Adapter emits `usage` events

**Files:**
- Modify: `lib/adapters/claude-code.js:124` (the `type === 'assistant'` branch)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing (the adapter emits raw usage; normalisation happens in the ledger)
- Produces: events shaped `{ ts, project, source, kind: 'usage', session, messageId, model, usage, sidechain }` where `usage` is the **raw, unnormalised** vendor object

- [ ] **Step 1: Write the failing test**

```js
check('adapter: emits one usage event per assistant record, carrying message id', () => {
  const entries = [
    { type: 'assistant', timestamp: '2026-07-28T10:00:00Z', cwd: '/repo', sessionId: 's1',
      message: { id: 'msg_a', model: 'claude-opus-4-6',
        usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 },
        content: [{ type: 'text', text: 'hi' }] } },
    // same request, second content block -- SAME message id, repeated usage
    { type: 'assistant', timestamp: '2026-07-28T10:00:01Z', cwd: '/repo', sessionId: 's1',
      message: { id: 'msg_a', model: 'claude-opus-4-6',
        usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 },
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/repo/a.js' } }] } },
  ];
  const events = claudeAdapter.extractEvents(entries, { pendingCreates: {}, tasks: {} });
  const usage = events.filter(e => e.kind === 'usage');
  assert.strictEqual(usage.length, 2, 'adapter emits per record; ledger dedupes on messageId');
  assert.strictEqual(usage[0].messageId, 'msg_a');
  assert.strictEqual(usage[0].session, 's1');
  assert.strictEqual(usage[0].model, 'claude-opus-4-6');
  assert.strictEqual(usage[0].usage.cache_read_input_tokens, 900);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "emits one usage event"`
Expected: FAIL — `usage.length` is 0

- [ ] **Step 3: Write minimal implementation**

In `lib/adapters/claude-code.js`, inside the `else if (e.type === 'assistant' && ...)` branch, before the `for (const c of e.message.content)` loop, insert:

```js
        // Per-request token usage. Emitted once per RECORD; several records
        // share one message id when a response had multiple content blocks,
        // so the ledger dedupes on messageId rather than the adapter.
        if (e.message.usage) {
          events.push({
            ts: e.timestamp, project: e.cwd, source: this.displayName,
            kind: 'usage', session,
            messageId: e.message.id || e.uuid || null,
            model: e.message.model || null,
            usage: e.message.usage,
            sidechain: !!e.isSidechain,
          });
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "emits one usage event"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/adapters/claude-code.js test/run-tests.js
git commit -m "feat(adapter): emit per-request usage events"
```

---

### Task 2b: Codex adapter emits `usage` events

**Files:**
- Modify: `lib/adapters/codex.js` (the `event_msg` branch)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing
- Produces: the same `kind: 'usage'` event shape as Task 2, with `source: 'Codex'` so `providerOf` routes it to OpenAI semantics

Codex writes a `token_count` event carrying both a cumulative `total_token_usage` and a per-request `last_token_usage`. **Only `last_token_usage` is per-request** — using the cumulative one would make volume grow quadratically across a session.

- [ ] **Step 1: Write the failing test**

```js
check('codex adapter: emits usage from last_token_usage, not the cumulative total', () => {
  const entries = [
    { type: 'event_msg', timestamp: '2026-07-28T10:00:00Z', cwd: '/repo',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 99999, cached_input_tokens: 0, output_tokens: 9999, total_tokens: 109998 },
        last_token_usage: { input_tokens: 18093, cached_input_tokens: 1408, output_tokens: 494, reasoning_output_tokens: 23 },
      } } },
  ];
  const events = codexAdapter.extractEvents(entries, {});
  const usage = events.filter(e => e.kind === 'usage');
  assert.strictEqual(usage.length, 1);
  assert.strictEqual(usage[0].usage.input_tokens, 18093, 'must use last_token_usage, not the cumulative total');
  assert.strictEqual(usage[0].usage.cached_input_tokens, 1408);
  assert.strictEqual(usage[0].source, 'Codex');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "emits usage from last_token_usage"`
Expected: FAIL — `usage.length` is 0

- [ ] **Step 3: Write minimal implementation**

In `lib/adapters/codex.js`, inside the loop over entries where `e.type === 'event_msg'`, add a branch:

```js
      } else if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        // last_token_usage is the delta for THIS request. total_token_usage is
        // cumulative and would make session volume grow quadratically.
        events.push({
          ts: e.timestamp, project: e.cwd, source: this.displayName,
          kind: 'usage', session,
          messageId: p.turn_id || e.timestamp,
          model: p.info.model || null,
          usage: p.info.last_token_usage,
          sidechain: false,
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "emits usage from last_token_usage"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/adapters/codex.js test/run-tests.js
git commit -m "feat(adapter): emit per-request usage events from Codex logs"
```

---

### Task 3: Adapter emits `read` events with tool-call ids

**Files:**
- Modify: `lib/adapters/claude-code.js` (add `READ_TOOLS`; extend the `tool_use` loop)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: events shaped `{ ts, project, source, kind: 'read', session, file, tool, toolUseId, offset, limit, messageId }`

- [ ] **Step 1: Write the failing test**

```js
check('adapter: Read/Grep/Glob emit read events with tool id and bounded-read params', () => {
  const entries = [
    { type: 'assistant', timestamp: '2026-07-28T10:00:00Z', cwd: '/repo', sessionId: 's1',
      message: { id: 'msg_b', model: 'claude-opus-4-6', usage: { input_tokens: 1 }, content: [
        { type: 'tool_use', id: 'tu_r', name: 'Read', input: { file_path: '/repo/a.js', offset: 10, limit: 50 } },
        { type: 'tool_use', id: 'tu_g', name: 'Grep', input: { pattern: 'x', path: '/repo/lib' } },
        { type: 'tool_use', id: 'tu_e', name: 'Edit', input: { file_path: '/repo/b.js' } },
      ] } },
  ];
  const events = claudeAdapter.extractEvents(entries, { pendingCreates: {}, tasks: {} });
  const reads = events.filter(e => e.kind === 'read');
  assert.strictEqual(reads.length, 2, 'Read and Grep produce reads; Edit does not');
  const r = reads.find(e => e.tool === 'Read');
  assert.strictEqual(r.file, '/repo/a.js');
  assert.strictEqual(r.toolUseId, 'tu_r');
  assert.strictEqual(r.offset, 10);
  assert.strictEqual(r.limit, 50);
  assert.strictEqual(r.messageId, 'msg_b');
  assert.ok(events.some(e => e.kind === 'edit' && e.file === '/repo/b.js'), 'edit events still emitted');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "emit read events with tool id"`
Expected: FAIL — `reads.length` is 0

- [ ] **Step 3: Write minimal implementation**

At the top of `lib/adapters/claude-code.js`, beside `EDIT_TOOLS`:

```js
// Read-shaped tools. Their targets are what an agent re-derives context from,
// which is the waste the ledger measures.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
```

Inside the `for (const c of e.message.content)` loop, add a branch before the `EDIT_TOOLS` branch:

```js
          if (READ_TOOLS.has(c.name) && c.input) {
            const file = c.input.file_path || c.input.notebook_path || c.input.path || null;
            if (file) {
              events.push({
                ts: e.timestamp, project: e.cwd, source: this.displayName,
                kind: 'read', session, file, tool: c.name, toolUseId: c.id,
                offset: typeof c.input.offset === 'number' ? c.input.offset : null,
                limit: typeof c.input.limit === 'number' ? c.input.limit : null,
                messageId: e.message.id || null,
              });
            }
            continue;
          }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "emit read events with tool id"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/adapters/claude-code.js test/run-tests.js
git commit -m "feat(adapter): emit read events for Read/Grep/Glob"
```

---

### Task 4: Ledger — dedupe requests

**Files:**
- Create: `lib/ledger.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `normalizeUsage`, `providerOf` (Task 1); `pricing.requestCostUsd` (Task 1); `usage` events (Tasks 2, 2b)
- Produces: `buildRequests(events) → [{ messageId, ts, session, model, provider, ctx, out, inCost, outCost, sidechain }]`, ordered by `ts`, one entry per unique `(sidechain, messageId)`

- [ ] **Step 1: Write the failing test**

```js
check('ledger: folds repeated records for one message id into a single request', () => {
  const ledger = require('../lib/ledger');
  const u = { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 };
  const events = [
    { kind: 'usage', ts: '2026-07-28T10:00:00Z', session: 's1', messageId: 'm1', model: 'claude-opus-4-6', usage: u },
    { kind: 'usage', ts: '2026-07-28T10:00:01Z', session: 's1', messageId: 'm1', model: 'claude-opus-4-6', usage: u },
    { kind: 'usage', ts: '2026-07-28T10:00:02Z', session: 's1', messageId: 'm2', model: 'claude-opus-4-6', usage: u },
  ];
  const reqs = ledger.buildRequests(events);
  assert.strictEqual(reqs.length, 2, 'three records, two real requests');
  assert.strictEqual(reqs[0].ctx, 1005);
  assert.strictEqual(reqs[0].out, 20);
  assert.ok(reqs[0].inCost > 0);
  // a sidechain request with the same id is a DIFFERENT request stream
  const withSide = events.concat([
    { kind: 'usage', ts: '2026-07-28T10:00:03Z', session: 's1', messageId: 'm1', model: 'claude-opus-4-6', usage: u, sidechain: true },
  ]);
  assert.strictEqual(ledger.buildRequests(withSide).length, 3);

  // A project can hold both Claude Code and Codex sessions. Each request must
  // be normalised by ITS OWN provider -- this is where a cross-vendor bug hides.
  const mixed = ledger.buildRequests([
    { kind: 'usage', ts: 't1', session: 'a', messageId: 'x', source: 'Claude Code',
      model: 'claude-opus-4-6',
      usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 995, output_tokens: 1 } },
    { kind: 'usage', ts: 't2', session: 'b', messageId: 'y', source: 'Codex',
      model: 'gpt-5',
      usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 1 } },
  ]);
  assert.strictEqual(mixed[0].ctx, 1000, 'anthropic: fields sum to context');
  assert.strictEqual(mixed[1].ctx, 1000, 'openai: cached is inside input, not added on top');
  assert.strictEqual(mixed[0].provider, 'anthropic');
  assert.strictEqual(mixed[1].provider, 'openai');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "folds repeated records"`
Expected: FAIL with `Cannot find module '../lib/ledger'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/ledger.js`:

```js
'use strict';
// Residence-weighted token ledger. Ported from the reference implementation in
// token-spend-analysis/ledger_fixed.py, which is the oracle for the
// equivalence test in the suite.
const pricing = require('./pricing');
const { normalizeUsage, providerOf } = require('./usage-normalize');

// One API request is written to the transcript as several records -- one per
// content block -- each repeating the SAME usage object. Fold them back into a
// single request keyed on message id, or every request is counted as many
// times as it had content blocks (roughly 2x inflation).
function buildRequests(events) {
  const byKey = new Map();
  for (const e of events) {
    if (!e || e.kind !== 'usage' || !e.usage) continue;
    const key = `${e.sidechain ? 1 : 0}|${e.messageId || e.ts}`;
    if (byKey.has(key)) continue;
    const provider = providerOf(e.source, e.model);
    const norm = normalizeUsage(e.usage, provider);
    const { inCost, outCost } = pricing.requestCostUsd(norm, e.model, provider);
    byKey.set(key, {
      messageId: e.messageId || null,
      ts: e.ts,
      session: e.session || null,
      model: e.model || null,
      provider,
      ctx: norm.context,
      out: norm.output,
      inCost,
      outCost,
      sidechain: !!e.sidechain,
    });
  }
  return Array.from(byKey.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

module.exports = { buildRequests };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "folds repeated records"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/ledger.js test/run-tests.js
git commit -m "feat(ledger): fold transcript records into unique requests"
```

---

### Task 5: Ledger — residence weighting and epochs

**Files:**
- Modify: `lib/ledger.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `buildRequests` (Task 4)
- Produces: `sessionVolume(requests) → { nRequests, volume, inCost, outCost, epochs }` where `volume` is the sum of `ctx` over all requests, and `epochs` is an array of `[startIndex, endIndex]` pairs

- [ ] **Step 1: Write the failing test**

```js
check('ledger: volume sums context per request and splits epochs on context reset', () => {
  const ledger = require('../lib/ledger');
  const mk = (ts, ctx, out) => ({ ts, ctx, out, inCost: 0, outCost: 0, session: 's1', sidechain: false });
  // context grows, then drops hard (compaction) and grows again
  const reqs = [
    mk('t1', 1000, 100), mk('t2', 2000, 100), mk('t3', 3000, 100),
    mk('t4', 400, 100), mk('t5', 900, 100),
  ];
  const out = ledger.sessionVolume(reqs);
  assert.strictEqual(out.nRequests, 5);
  assert.strictEqual(out.volume, 1000 + 2000 + 3000 + 400 + 900, 'volume is the sum of per-request context');
  assert.strictEqual(out.epochs.length, 2, 'the drop at t4 starts a new epoch');
  assert.deepStrictEqual(out.epochs[0], [0, 2]);
  assert.deepStrictEqual(out.epochs[1], [3, 4]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "splits epochs on context reset"`
Expected: FAIL — `ledger.sessionVolume is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `lib/ledger.js` (before `module.exports`, and extend the export):

```js
// A context that shrinks means the window was compacted or reset. Growth is
// only meaningful within an epoch, so epochs are split at those boundaries.
const RESET_DROP_RATIO = 0.15;   // a fall of >15% of the previous context
const RESET_JUMP = 600000;       // or an implausible jump forward

function sessionVolume(requests) {
  let volume = 0, inCost = 0, outCost = 0;
  for (const r of requests) {
    volume += r.ctx;
    inCost += r.inCost || 0;
    outCost += r.outCost || 0;
  }
  const epochs = [];
  if (requests.length) {
    let start = 0;
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1];
      const gap = requests[i].ctx - prev.ctx - prev.out;
      const reset = gap < -RESET_DROP_RATIO * Math.max(prev.ctx, 1) || gap > RESET_JUMP;
      if (reset) { epochs.push([start, i - 1]); start = i; }
    }
    epochs.push([start, requests.length - 1]);
  }
  return { nRequests: requests.length, volume, inCost, outCost, epochs };
}
```

Change the export line to:

```js
module.exports = { buildRequests, sessionVolume };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "splits epochs on context reset"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/ledger.js test/run-tests.js
git commit -m "feat(ledger): per-session volume and epoch splitting"
```

---

### Task 6: Classify reads into waste tiers

**Files:**
- Create: `lib/redundancy.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `read` events (Task 3)
- Produces: `classifyReads(readEvents, editEvents) → [{ ...readEvent, tier }]` where `tier` is `'first' | 'same-session' | 'cross-session'`, and `tally(classified) → { first, sameSession, crossSession }`

- [ ] **Step 1: Write the failing test**

```js
check('redundancy: classifies reads as first, same-session repeat, or cross-session repeat', () => {
  const redundancy = require('../lib/redundancy');
  const reads = [
    { kind: 'read', ts: 't1', session: 'a', file: '/r/x.js' },  // first ever
    { kind: 'read', ts: 't2', session: 'a', file: '/r/x.js' },  // same session again
    { kind: 'read', ts: 't3', session: 'b', file: '/r/x.js' },  // different session
    { kind: 'read', ts: 't4', session: 'b', file: '/r/y.js' },  // first ever
  ];
  const out = redundancy.classifyReads(reads, []);
  assert.deepStrictEqual(out.map(r => r.tier),
    ['first', 'same-session', 'cross-session', 'first']);
  const t = redundancy.tally(out);
  assert.strictEqual(t.first, 2);
  assert.strictEqual(t.sameSession, 1);
  assert.strictEqual(t.crossSession, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "classifies reads as first"`
Expected: FAIL with `Cannot find module '../lib/redundancy'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/redundancy.js`:

```js
'use strict';
// Classifies every read against the history of the project. The three tiers
// map directly to the three recoverable mechanisms measured in the corpus
// study: cross-session repeats need memory, same-session repeats need only a
// pointer, and first reads can only be helped by compression.

function classifyReads(readEvents, editEvents) {
  const events = readEvents
    .filter(e => e && e.kind === 'read' && e.file)
    .slice()
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const seen = new Map();   // file -> Set of session ids that have read it
  const out = [];
  for (const e of events) {
    const readers = seen.get(e.file);
    let tier = 'first';
    if (readers && readers.size) {
      let otherSession = false;
      for (const s of readers) { if (s !== e.session) { otherSession = true; break; } }
      tier = otherSession ? 'cross-session' : 'same-session';
    }
    out.push(Object.assign({}, e, { tier }));
    if (!readers) seen.set(e.file, new Set([e.session]));
    else readers.add(e.session);
  }
  void editEvents;   // reserved: edit history drives the diff decision later
  return out;
}

function tally(classified) {
  const t = { first: 0, sameSession: 0, crossSession: 0 };
  for (const r of classified) {
    if (r.tier === 'first') t.first++;
    else if (r.tier === 'same-session') t.sameSession++;
    else t.crossSession++;
  }
  return t;
}

module.exports = { classifyReads, tally };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "classifies reads as first"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/redundancy.js test/run-tests.js
git commit -m "feat(ledger): classify reads into first/same-session/cross-session"
```

---

### Task 7: Persist a per-project ledger

**Files:**
- Create: `lib/ledger-store.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `sessionVolume` (Task 5), `classifyReads`/`tally` (Task 6)
- Produces: `buildProjectLedger(events) → ledger`, `writeLedger(projectPath, ledger)`, `readLedger(projectPath) → ledger|null`. Ledger shape: `{ updatedAt, sessions: n, requests: n, volume: n, inCost, outCost, reads: {first, sameSession, crossSession}, hotPaths: [{file, readers, reads}] }`

- [ ] **Step 1: Write the failing test**

```js
check('ledger-store: builds and round-trips a project ledger with a hot set', () => {
  const store = require('../lib/ledger-store');
  const proj = path.join(ROOT, 'ledger-proj');
  fs.mkdirSync(proj, { recursive: true });
  const u = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 999, output_tokens: 10 };
  const events = [
    { kind: 'usage', ts: 't1', session: 'a', messageId: 'm1', model: 'claude-opus-4-6', usage: u },
    { kind: 'usage', ts: 't2', session: 'b', messageId: 'm2', model: 'claude-opus-4-6', usage: u },
    { kind: 'read', ts: 't1', session: 'a', file: '/r/x.js' },
    { kind: 'read', ts: 't2', session: 'b', file: '/r/x.js' },
    { kind: 'read', ts: 't3', session: 'b', file: '/r/y.js' },
  ];
  const built = store.buildProjectLedger(events);
  assert.strictEqual(built.requests, 2);
  assert.strictEqual(built.volume, 2000);
  assert.strictEqual(built.sessions, 2);
  assert.strictEqual(built.reads.crossSession, 1);
  assert.strictEqual(built.hotPaths[0].file, '/r/x.js', 'x.js is read by 2 sessions so it leads the hot set');
  assert.strictEqual(built.hotPaths.length, 1, 'single-reader files are not hot');

  store.writeLedger(proj, built);
  const back = store.readLedger(proj);
  assert.strictEqual(back.volume, built.volume);
  assert.strictEqual(store.readLedger(path.join(ROOT, 'nope')), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "round-trips a project ledger"`
Expected: FAIL with `Cannot find module '../lib/ledger-store'`

- [ ] **Step 3: Write minimal implementation**

Create `lib/ledger-store.js`:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const redundancy = require('./redundancy');
const { DIR_NAME } = require('./memorydb');

const FILE = 'ledger.json';
const ledgerPath = projectPath => path.join(projectPath, DIR_NAME, FILE);

function buildProjectLedger(events) {
  const requests = ledger.buildRequests(events);
  const vol = ledger.sessionVolume(requests);
  const reads = events.filter(e => e && e.kind === 'read');
  const classified = redundancy.classifyReads(reads, events.filter(e => e && e.kind === 'edit'));

  // Hot set: paths more than one session has read. These are exactly the
  // paths a recall layer could serve, so they drive pre-warming later.
  const byFile = new Map();
  for (const r of classified) {
    let rec = byFile.get(r.file);
    if (!rec) { rec = { file: r.file, readers: new Set(), reads: 0 }; byFile.set(r.file, rec); }
    rec.readers.add(r.session);
    rec.reads++;
  }
  const hotPaths = Array.from(byFile.values())
    .filter(r => r.readers.size > 1)
    .map(r => ({ file: r.file, readers: r.readers.size, reads: r.reads }))
    .sort((a, b) => b.reads - a.reads);

  return {
    updatedAt: new Date().toISOString(),
    sessions: new Set(requests.map(r => r.session)).size,
    requests: vol.nRequests,
    volume: vol.volume,
    inCost: vol.inCost,
    outCost: vol.outCost,
    reads: redundancy.tally(classified),
    hotPaths,
  };
}

function writeLedger(projectPath, data) {
  const p = ledgerPath(projectPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 1));
  return p;
}

function readLedger(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { buildProjectLedger, writeLedger, readLedger, ledgerPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "round-trips a project ledger"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/ledger-store.js test/run-tests.js
git commit -m "feat(ledger): persist per-project ledger with hot set"
```

---

### Task 8: Equivalence test against the reference implementation

**Files:**
- Create: `test/ledger-equivalence.js`
- Read only: real transcripts under `~/.claude/projects`, and `token-spend-analysis/ledger_fixed.py` (never modify either)

**Interfaces:**
- Consumes: `buildRequests`, `sessionVolume` (Tasks 4–5), the `claude-code` adapter (Tasks 2–3)
- Produces: nothing — this is a guard, and it exists because the whole product claim rests on these numbers being right

**Important:** `external_ledger_v4.json` holds *parsed* ledgers, not raw transcripts — the corpus was stream-and-discarded, so the raw JSONL is gone. True equivalence therefore has to run both implementations over transcripts that still exist: the developer's own under `~/.claude/projects`. This is an opt-in script rather than part of `npm test`, because it needs Python and real local sessions.

- [ ] **Step 1: Write the comparison script**

Create `test/ledger-equivalence.js`:

```js
'use strict';
// Runs the JS ledger and the reference Python implementation over the SAME
// local transcripts and compares. Opt-in:
//   MEMBRIDGE_REF=/path/to/token-spend-analysis node test/ledger-equivalence.js
// Needs real sessions under ~/.claude/projects and python3 on PATH.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REF = process.env.MEMBRIDGE_REF;
if (!REF || !fs.existsSync(path.join(REF, 'ledger_fixed.py'))) {
  console.log('skipped: set MEMBRIDGE_REF to the token-spend-analysis dir');
  process.exit(0);
}

const adapter = require('../lib/adapters/claude-code');
const ledger = require('../lib/ledger');

const root = path.join(os.homedir(), '.claude', 'projects');
const files = [];
for (const dir of fs.readdirSync(root)) {
  const d = path.join(root, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith('.jsonl')) files.push(path.join(d, f));
  }
}
files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
const sample = files.slice(0, 20);
assert.ok(sample.length, 'no local transcripts found');

let checked = 0, worst = 0;
for (const file of sample) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  const events = adapter.extractEvents(entries, { pendingCreates: {}, tasks: {} });
  const mine = ledger.sessionVolume(ledger.buildRequests(events));

  const py = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(REF)})
from ledger_fixed import parse_unit
u = parse_unit(${JSON.stringify(file)})
print(json.dumps({"n": u["n_requests"], "v": u["volume"]} if u else {"n": 0, "v": 0}))
`], { encoding: 'utf8' });
  if (py.status !== 0) { console.error(py.stderr); process.exit(1); }
  const ref = JSON.parse(py.stdout);
  if (!ref.n) continue;

  const dReq = Math.abs(mine.nRequests - ref.n) / ref.n;
  const dVol = Math.abs(mine.volume - ref.v) / ref.v;
  worst = Math.max(worst, dReq, dVol);
  assert.ok(dReq <= 0.02, `${path.basename(file)}: requests ${mine.nRequests} vs ${ref.n}`);
  assert.ok(dVol <= 0.02, `${path.basename(file)}: volume ${mine.volume} vs ${ref.v}`);
  checked++;
}
console.log(`ledger equivalence: ${checked} transcripts, worst drift ${(worst * 100).toFixed(3)}%`);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `MEMBRIDGE_REF=/Users/marco/Documents/token-spend-analysis node test/ledger-equivalence.js`
Expected: FAIL on a request-count or volume assertion — most likely because the JS port counts sidechain records differently, which is exactly the drift this guard exists to catch.

- [ ] **Step 3: Fix `lib/ledger.js` until it matches**

No new module. Any mismatch is a defect in Tasks 4–5. The two most likely causes, in order:

1. **Dedupe key.** The reference keys on `(isSidechain, message.id)`. If the adapter drops `sidechain`, two distinct requests collapse into one and the count comes in low.
2. **Subagent transcripts.** The reference folds `<session-id>/subagents/*.jsonl` into the parent session. If those files are not walked, long sessions come in low.

- [ ] **Step 4: Re-run until clean**

Run: `MEMBRIDGE_REF=/Users/marco/Documents/token-spend-analysis node test/ledger-equivalence.js`
Expected: `ledger equivalence: N transcripts, worst drift <2%`

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all checks pass, including the new eight

- [ ] **Step 5: Commit**

```bash
git add test/ledger-equivalence.js
git commit -m "test(ledger): equivalence guard against the reference implementation"
```

---

### Task 9: Serve the ledger over the API

**Files:**
- Modify: `lib/server.js` (add a route beside the existing `/api/*` handlers)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `readLedger` (Task 7)
- Produces: `GET /api/savings` → `{ projects: [{ path, name, volume, requests, reads: {...}, hotPaths: n }], totals: { volume, requests, reads: {...} } }`

- [ ] **Step 1: Write the failing test**

```js
check('api: /api/savings reports per-project ledgers and totals', async () => {
  const store = require('../lib/ledger-store');
  const proj = path.join(ROOT, 'savings-proj');
  fs.mkdirSync(proj, { recursive: true });
  store.writeLedger(proj, {
    updatedAt: new Date().toISOString(), sessions: 2, requests: 10, volume: 5000,
    inCost: 0.5, outCost: 0.1,
    reads: { first: 3, sameSession: 2, crossSession: 5 },
    hotPaths: [{ file: '/r/x.js', readers: 2, reads: 4 }],
  });
  const payload = require('../lib/server').savingsPayload({ projects: { [proj]: { name: 'savings-proj' } } });
  assert.strictEqual(payload.totals.volume, 5000);
  assert.strictEqual(payload.totals.reads.crossSession, 5);
  assert.strictEqual(payload.projects[0].hotPaths, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A3 "/api/savings reports"`
Expected: FAIL — `savingsPayload is not a function`

- [ ] **Step 3: Write minimal implementation**

In `lib/server.js`, add near the other payload builders:

```js
// Per-project token ledgers. Reports TOKENS only -- never a spend figure --
// because MemBridge prices at list-price API rates while many users are on
// flat subscription plans, and a contradicting dollar number would discredit
// every figure beside it.
function savingsPayload(state) {
  const ledgerStore = require('./ledger-store');
  const projects = [];
  const totals = { volume: 0, requests: 0, reads: { first: 0, sameSession: 0, crossSession: 0 } };
  for (const [projectPath, proj] of Object.entries((state && state.projects) || {})) {
    const led = ledgerStore.readLedger(projectPath);
    if (!led) continue;
    projects.push({
      path: projectPath,
      name: (proj && proj.name) || projectPath,
      updatedAt: led.updatedAt,
      sessions: led.sessions,
      requests: led.requests,
      volume: led.volume,
      reads: led.reads,
      hotPaths: (led.hotPaths || []).length,
    });
    totals.volume += led.volume || 0;
    totals.requests += led.requests || 0;
    for (const k of Object.keys(totals.reads)) {
      totals.reads[k] += (led.reads && led.reads[k]) || 0;
    }
  }
  projects.sort((a, b) => b.volume - a.volume);
  return { projects, totals };
}
```

Register the route beside the existing `/api/` routes:

```js
    if (url.pathname === '/api/savings') return json(res, savingsPayload(state));
```

Add `savingsPayload` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -A3 "/api/savings reports"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/run-tests.js
git commit -m "feat(api): expose per-project token ledgers at /api/savings"
```

---

## Wiring note for the implementer

Tasks 1–9 build and expose the ledger but nothing calls `buildProjectLedger` on a schedule yet. That hook-up belongs in `lib/scan.js`'s `syncOnce`, alongside the existing `updateProject` call, and is deliberately the last thing done so the ledger can be tested in isolation first. Add it once Task 9 passes:

```js
    // after the existing memory update for this project
    const ledgerStore = require('./ledger-store');
    ledgerStore.writeLedger(projectPath, ledgerStore.buildProjectLedger(proj.events || []));
```

Then verify end to end with `npm test` and by starting the daemon and fetching `/api/savings`.

## Follow-on plans (not in scope here)

1. **Skeleton extraction** — `web-tree-sitter` plus the dependency-free fallback stripper.
2. **Recall store and serve policy** — tiers A/B, 2.25x compression floor, 400-token minimum, rejection learning.
3. **PreToolUse hook and MCP `recall()`** — the interception path, fail-open, 150 ms budget.
4. **Holdout, diagnostics flag and dev log** — the causal claim and the Supabase flag.
5. **Savings UI** — Home roll-up and the project Savings tab. Note `lib/dashboard/` client files are one large template literal; a stray backtick breaks `require`, so smoke-check with `node -e "require('./lib/dashboard/...')"` after every edit.
