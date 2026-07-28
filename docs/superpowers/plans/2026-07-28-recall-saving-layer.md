# Recall Saving Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MemBridge actually save tokens: intercept file reads an agent is about to repeat and answer them with a pointer or a structural skeleton, measured honestly by the ledger built in the previous plan.

**Architecture:** A `PreToolUse` hook on Read/Grep/Glob (mirroring the existing Stop-hook machinery in `lib/hooks.js`) asks a serve policy (`lib/recall.js`) whether to answer. Tier A (same-session repeat, file unchanged) answers with a ~50-token pointer. Tier B (cross-session repeat) answers with a cached skeleton built by the daemon's hot-set warmer (`lib/skeleton.js`, web-tree-sitter with a dependency-free fallback). The hook serves only from cache and hashes the file at serve time, so it stays inside a 150 ms budget and can never serve stale content. Every serve/holdout outcome folds into the existing ledger, settled by the spec §7.1 formula; `/api/savings` and the dashboard report tokens of file reading AVOIDED; MCP gains `recall`.

**Tech Stack:** Node ≥18, CommonJS. New runtime deps (approved in spec §9): `web-tree-sitter` + grammar wasm for TS/JS/Python/Go. Tests are `check()` blocks in `test/run-tests.js`.

**Spec:** `docs/superpowers/specs/2026-07-28-membridge-token-reduction-design.md` — §4 payload, §5 serve policy, §6 terminal output, §7 attribution, §8 UI, §10 safety, §11 testing.

## Global Constraints

- **Fail-open, always** (spec §10): any exception, missing store, parse error, oversized latency → the read proceeds untouched. The hook's outermost layer catches everything and exits 0 with no output.
- **~150 ms hook budget**: the hook serves only pre-built cache entries; it never parses source or loads wasm.
- **Serve conditions** (spec §5.2, all must hold): tier A/B applies (C is built but flag-gated off); the call would pull **≥400 tokens** (from actual offset/limit, never file size); **≥2.25× compression** against that call; path not already served this session; not held out.
- **Holdout** (spec §7.2): **3%** of eligible reads, chosen deterministically by `hash(sessionId + path)`, are never intercepted. **Continuous — no 14-day window.** It is a divergence check pooled across installs, never the quoted number.
- **Terminal line** (spec §6): shown when saving > **1,000 tokens**, plus always the first interception of a session; leads with percentage, absolute in parentheses.
- **Tokens, never dollars**, in every user-facing surface (spec §8.1). Estimation: 1 token ≈ 4 chars, one place only.
- **Freshness at serve time**: re-hash the file on disk; mismatch → regenerate (daemon) or step aside (hook). Tier A additionally requires the hash to match what the agent was shown.
- **Redaction before storage and before any sync**: skeletons pass `lib/redact.js` before being written (spec §10).
- **Never intercept**: untracked/paused projects (`isTrackedProject` gate), binaries/minified/lockfiles, files with no grammar AND no recognisable structure.
- **Kill switches**: `recall.enabled` config (default true), per-project pause (existing), `MEMBRIDGE_NO_RECALL=1` env.
- CommonJS, `'use strict'`; modules ≤ ~250 lines; suite offline (`npm test`, baseline 697/697); commit via `git -c user.email=marco@melika.com -c user.name="Marco Melika"`.
- `web-tree-sitter` loads lazily in the DAEMON only — the CLI, hook and tests must not pay its startup cost; everything must degrade to the fallback stripper when wasm is unavailable.

---

### Task 1: Fallback skeleton stripper

**Files:**
- Create: `lib/skeleton-strip.js`
- Test: `test/run-tests.js` (new checks go after 'differential: incremental fold tiering matches the batch classifier'; same for all later tasks, each after its predecessor's)

**Interfaces:**
- Produces: `strip(content, ext) → { text, ok }` — dependency-free, language-agnostic skeleton by depth: keeps lines at brace/indent depth 0–1 (declarations, signatures, imports, top-level comments), replaces deeper blocks with a `…` marker line. `ok:false` when the result fails to compress (output ≥ 60% of input lines) or input looks binary/minified (any line > 2,000 chars, or NUL bytes).

- [ ] **Step 1: Failing test**

```js
check('skeleton-strip: keeps signatures, drops bodies, refuses minified input', () => {
  const { strip } = require('../lib/skeleton-strip');
  const src = [
    "'use strict';",
    "const fs = require('fs');",
    'function outer(a, b) {',
    '  const x = a + b;',
    '  if (x) {',
    '    deep();',
    '  }',
    '  return x;',
    '}',
    'module.exports = { outer };',
  ].join('\n');
  const out = strip(src, '.js');
  assert.ok(out.ok);
  assert.ok(out.text.includes('function outer(a, b) {'), 'signature survives');
  assert.ok(out.text.includes("const fs = require('fs');"), 'imports survive');
  assert.ok(!out.text.includes('deep()'), 'nested body dropped');
  assert.ok(out.text.split('\n').length < src.split('\n').length, 'smaller');
  // python: indentation depth, no braces
  const py = ['import os', 'def f(a):', '    x = a', '    return x', 'class C:', '    def m(self):', '        pass'].join('\n');
  const pout = strip(py, '.py');
  assert.ok(pout.ok && pout.text.includes('def f(a):') && !pout.text.includes('x = a'));
  // minified refusal
  assert.strictEqual(strip('x'.repeat(3000), '.js').ok, false);
});
```

- [ ] **Step 2:** `npm test 2>&1 | grep -A4 "skeleton-strip"` → FAIL (module missing)
- [ ] **Step 3:** Implement `lib/skeleton-strip.js`: track brace depth for brace languages; for `.py`/`.yml` use leading-indent depth (keep indent ≤ 1 level for py signatures — keep `def`/`class` lines at any depth ≤1, drop deeper). Insert a single `  …` line per elided block. Compute `ok` per the interface rule.
- [ ] **Step 4:** test passes; full suite green
- [ ] **Step 5:** Commit `feat(recall): dependency-free fallback skeleton stripper`

---

### Task 2: web-tree-sitter extractor behind one interface

**Files:**
- Create: `lib/skeleton.js`
- Modify: `package.json` (add `web-tree-sitter`; grammar wasm vendored under `vendor/grammars/` — download at dev time via a new `scripts/fetch-grammars.js`, committed to the repo so installs need no network)
- Modify: `scripts/prepare-app.js` (bundle `web-tree-sitter` + `vendor/grammars` into the app — the libsodium incident is the precedent: verify presence in the bundled output, not just under node)
- Test: `test/run-tests.js`

**Interfaces:**
- Produces: `skeletonize(filePath, content) → Promise<{ text, tokens, ok, engine: 'tree-sitter'|'strip' }>`; `estimateTokens(str)` (chars/4, the single estimation point); lazy async init — first call loads wasm, failures permanently fall back to `strip` for the process lifetime.

Grammar mapping: `.ts/.tsx/.js/.jsx/.mjs/.cjs → typescript/javascript`, `.py → python`, `.go → go`; everything else → fallback stripper. Tree-sitter path: keep import/export statements, type/interface/class/function signatures (walk named nodes; drop `statement_block`/`block`/`body` children, emit `…`). If tree-sitter yields `ok:false` (poor compression), fall back to strip before giving up.

- [ ] **Step 1: Failing test** (works with OR without wasm present — assert on the interface, pin `engine` only loosely):

```js
check('skeleton: skeletonize compresses source and reports its engine', async () => {
  const { skeletonize, estimateTokens } = require('../lib/skeleton');
  const src = 'export function add(a: number, b: number): number {\n  const s = a + b;\n  return s;\n}\n' +
    'export interface Row { id: string; }\n' + 'function helper() {\n  inner();\n}\n'.repeat(20);
  const out = await skeletonize('/repo/x.ts', src);
  assert.ok(out.ok);
  assert.ok(['tree-sitter', 'strip'].includes(out.engine));
  assert.ok(out.text.includes('add(a: number, b: number)'), 'signature survives');
  assert.ok(!out.text.includes('inner();'), 'bodies gone');
  assert.ok(out.tokens < estimateTokens(src) / 2.25, 'clears the compression floor on this fixture');
  assert.strictEqual(estimateTokens('abcd'.repeat(100)), 100);
});
```

- [ ] **Step 2:** FAIL → **Step 3:** implement; run `node scripts/fetch-grammars.js` once and commit the wasm files. **Step 4:** suite green; also run `node scripts/prepare-app.js` and assert (in the existing prepare-app checks' style — extend the closest check) that `app/node_modules/web-tree-sitter` and `app/vendor/grammars` exist in the bundle.
- [ ] **Step 5:** Commit `feat(recall): tree-sitter skeleton extractor with strip fallback`

---

### Task 3: Recall store

**Files:**
- Create: `lib/recall-store.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Store dir: `<project>/.membridge/recall/`; one JSON per path key (`sha1(relPath).slice(0,16).json`) + an `index.json` (path → { contentHash, skeletonTokens, fileTokens, engine, rejections, updatedAt }).
- Produces: `get(projectPath, relPath) → { skeleton, contentHash, skeletonTokens, fileTokens, rejections } | null` (null on any error — fail-open); `put(projectPath, relPath, entry)` (atomic temp+rename, skeleton passed through `redact` BEFORE write); `bumpRejection(projectPath, relPath)`; `warm(projectPath, hotPaths, config) → Promise<n>` — for each hot path (from ledger `fileReaders`/hotPaths): read file, skip if content hash unchanged, `skeletonize`, store. Serial, bounded (≤ 25 paths per call, constant).

- [ ] **Step 1: Failing test**

```js
check('recall-store: round-trips entries, redacts secrets, warms the hot set', async () => {
  const store = require('../lib/recall-store');
  const proj = path.join(ROOT, 'recall-proj'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.js'), 'const KEY = "sk-live-1234567890abcdef";\nfunction f() {\n  body();\n}\n');
  const n = await store.warm(proj, [{ file: 'a.js' }], util.getConfig());
  assert.strictEqual(n, 1);
  const e = store.get(proj, 'a.js');
  assert.ok(e && e.contentHash && e.skeletonTokens > 0);
  assert.ok(!e.skeleton.includes('sk-live-'), 'secret redacted from stored skeleton');
  assert.strictEqual(store.get(proj, 'missing.js'), null);
  store.bumpRejection(proj, 'a.js');
  assert.strictEqual(store.get(proj, 'a.js').rejections, 1);
});
```

- [ ] **Steps 2–4:** FAIL → implement (use `lib/redact.js`'s existing API — read how digest.js compiles/applies regexes and mirror it) → green.
- [ ] **Step 5:** Commit `feat(recall): per-project skeleton store with redaction and hot-set warmer`

---

### Task 4: Serve policy

**Files:**
- Create: `lib/recall.js`
- Test: `test/run-tests.js`

**Interfaces:**
- Produces: `decide(input) → { serve: false, reason } | { serve: true, tier, body, callTokens, skeletonTokens, avoidedTokensOptimistic, pct }`.
- `input`: `{ projectPath, relPath, absPath, sessionId, toolName, offset, limit, sessionState, ledger, storeEntry, fileStat, config, projectCreatedAt }` — pure function, no I/O; callers assemble inputs so the policy is table-testable.
- `sessionState` (per session, JSON under `.membridge/recall/sessions/<sid>.json`, managed by the hook task): `{ served: {relPath: contentHash}, interceptions: n }`.
- Constants (top of file, names exact): `MIN_CALL_TOKENS = 400`, `MIN_COMPRESSION = 2.25`, `HOLDOUT_PCT = 3`, `ANNOUNCE_TOKENS = 1000`, `REJECTION_LIMIT = 3`.
- Decision order (each failure returns its own `reason` string): kill-switch/config → tracked+unpaused → holdout (`sha1(sessionId + relPath)` first 4 bytes as uint32 % 100 < 3; continuous, no date window) → already served this session → rejections ≥ limit → tier: A if `sessionState.served`-adjacent history says this session already read the path (from ledger `fileReaders` + same session) AND `storeEntry.contentHash === current file hash`; B if another session read it (ledger fileReaders) and skeleton cached fresh; C only if `config.recall.tierC` truthy → call size: `limit ? limit*12 : fileStat.size/4` estimated tokens ≥ 400 (12 ≈ tokens/line, comment why) → compression: tier A body is the pointer (fixed template, ~50 tokens) — always passes; tier B requires `callTokens / skeletonTokens ≥ 2.25`.
- Tier A body: `MemBridge: this session already read <relPath> (unchanged since; hash <8hex>). Re-read only if you need to revisit specific content.`
- Tier B body: header + skeleton: `MemBridge structural summary of <relPath> (full file unchanged on disk — read it directly for implementation bodies):\n\n<skeleton>`

- [ ] **Step 1: Failing test** — table-driven over: holdout hit (deterministic — compute a (sid,path) pair that hashes into the holdout in the test, by scanning a few candidates), tier A serve with matching hash, tier A refusal on hash mismatch, tier B serve clearing 2.25×, tier B refusal below 2.25×, refusal under 400 tokens, refusal when already served, refusal at 3 rejections, tier C dark by default and lit by config flag. Assert the decision carries `callTokens` and `skeletonTokens` on a tier B serve, and `pct = round(100*(callTokens-skeletonTokens)/callTokens)`. NOTE (spec §7.1): the DECISION reports the optimistic figure; final net is only known after the session, via `net = callTokens - (skeletonTokens + followTokens)` computed in the fold (Task 6). Do not name a decision field `savedTokens` — call it `avoidedTokensOptimistic` so nothing downstream mistakes it for the settled number.
- [ ] **Steps 2–4:** FAIL → implement → green.
- [ ] **Step 5:** Commit `feat(recall): serve policy — tiers, floors, holdout, rejection learning`

---

### Task 5: The PreToolUse hook

**Files:**
- Modify: `lib/hooks.js` (new `runRecall()` + registration; mirror `runStop`'s stdin/exit contract and the setup-hooks/remove-hooks machinery — key new entries on `membridge-hook` the same way, PreToolUse matcher `"Read|Grep|Glob"`)
- Modify: `lib/membridge-hook.js` (route `recall` subcommand)
- Test: `test/run-tests.js`

**Interfaces:**
- Consumes: `recall.decide` (Task 4), `recall-store.get` (Task 3), ledger via `ledger-store.readLedger`.
- Hook contract (verified against the Stop hook's documented payload style): stdin JSON `{ session_id, cwd, tool_name, tool_input: { file_path|path|pattern, offset, limit } }`. To answer a read, print JSON to stdout: `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "<line + body>" } }` and exit 0 — the reason is what the model receives in place of the tool result. To step aside: exit 0 with no output.
- The reason's first line IS the terminal line (spec §6): `answered from MemBridge · avoided <pct>% of this read (<avoidedTokensOptimistic> tokens) — structure only, read the file directly for bodies` — included when `avoidedTokensOptimistic > ANNOUNCE_TOKENS || sessionState.interceptions === 0`. **"avoided", not "saved"** (spec §8.2), and it is the optimistic figure — a follow-up read may reduce it, which only the fold can settle; otherwise the body only.
- After serving: update sessionState (`served[relPath] = contentHash`, `interceptions++`) and append one line to `.membridge/recall/events.jsonl`: `{ ts, sessionId, relPath, tier, callTokens, skeletonTokens, holdout: false }`. **`callTokens` is mandatory** — without it the fold cannot apply the §7.1 formula and every outcome collapses back to the old all-or-nothing rule. On a holdout skip, append `{ ..., holdout: true, wouldServe: tier, callTokens }` and step aside. These events are the fold's input (Task 6), which settles them into avoided tokens.
- **Entire body wrapped in try/catch → step aside.** ~~A watchdog: `setTimeout(150ms)` that force-exits 0 without output (unref'd), in case anything hangs.~~ **Superseded (fix round 1):** the hook body is fully synchronous (it blocks on reading stdin), so the event loop never runs and that timer can never fire — a held-open stdin was measured still alive at 3004ms against the nominal 150ms. The real bound is the per-hook `timeout` (5s) on the PreToolUse settings entry, enforced by Claude Code's hook runner; the inert timer was removed rather than left looking like a budget.

- [ ] **Step 1: Failing test** — drive `runRecall` in-process the way `runStop` is tested (grep how the suite invokes hook fns): feed stdin payloads via a temp file/fd; assert (a) tier B serve prints valid JSON with deny + reason containing the skeleton and the first-interception line; (b) second identical call steps aside (already served); (c) corrupted store/file → silent step-aside, exit 0; (d) `MEMBRIDGE_NO_RECALL=1` steps aside; (e) events.jsonl rows appear with correct shapes; (f) hash mismatch on disk → step aside (no stale serve).
- [ ] **Steps 2–4:** FAIL → implement → green. Also extend the settings-registration checks: `setup-hooks` writes the PreToolUse entry alongside Stop; `remove-hooks` removes both; re-run is idempotent.
- [ ] **Step 5:** Commit `feat(recall): PreToolUse hook serves pointers and skeletons, fail-open`

---

### Task 6: Fold savings into the ledger + API

**This task owns the §7.1 formula.** The hook records what it observed; the fold settles it.

```
net = callTokens − (skeletonTokens + followTokens)
```

`followTokens` = the tokens any follow-up read of that path in the same session actually pulled, estimated from *its own* `offset`/`limit` with the same estimator the policy used; 0 when there is no follow-up. Positive is avoidance, negative is a loss.

**Files:**
- Modify: `lib/ledger-fold.js` / `lib/ledger-fold-state.js` (consume `.membridge/recall/events.jsonl`: cumulative `avoided: { tokens, serves, tierA, tierB, partialWins, netNegatives }` and, kept strictly separate, `holdout: { skips, callTokens }`; events file truncated after fold — the ledger is the durable record, events are the queue; bounded read of ≤ 10,000 lines per fold)
- Modify: `lib/scan.js` (fold-time settlement: for each serve row, find any later `read` event on the same path in the same session, estimate its tokens, apply the formula, add `net` to the running total. Call `bumpRejection` **only when `net < 0`** — a smaller, targeted follow-up is a success, and counting it would stop us serving exactly the files where skeletons work best)
- Modify: `lib/server.js` `savingsPayload` (add `avoided` and `holdout` blocks; tokens only, no cost fields; field named `avoided`, never `saved` — spec §8.2)
- Modify: `lib/recall-store.js` warm() call wired into `syncOnce` after the ledger write (hot set from the fresh ledger)
- Test: `test/run-tests.js`

- [ ] **Step 1: Failing test** — cover all three outcomes of the formula, since the middle one is new and the easiest to regress:
  - **no follow-up**: serve `callTokens 4210`, `skeletonTokens 380` → net **+3,830**, no rejection.
  - **targeted follow-up** (the case the old rule got wrong): same serve, then a same-session read of that path pulling `600` → net **+3,230**, counted in `partialWins`, and **`bumpRejection` NOT called**.
  - **full re-read**: same serve, then a same-session read pulling `4210` → net **−380**, counted in `netNegatives`, `bumpRejection` called once.

  Plus: folding twice is idempotent (truncation); holdout rows accumulate only into `holdout` and never touch `avoided`; `/api/savings` exposes `avoided`/`holdout` with no cost fields (extend the existing no-dollars assertions) and no internal keys.
- [ ] **Steps 2–4:** FAIL → implement → green. Re-run the equivalence guard (`MEMBRIDGE_REF=... node test/ledger-equivalence.js`) — must stay 0.000% (nothing in buildRequests changes).
- [ ] **Step 5:** Commit `feat(recall): savings fold into the ledger and /api/savings`

---

### Task 7: MCP `recall` tool

**Files:**
- Modify: `lib/mcp.js` (register `recall` beside the five existing tools, same registerTools pattern)
- Test: `test/run-tests.js` (the suite already drives MCP via InMemoryTransport — mirror the existing MCP checks)

**Interfaces:** `recall({ project, path })` → the same body `decide` would serve (tier B content, no session gating — MCP callers manage their own context), or a structured "no entry / stale / below floors" result. Read-only; never writes sessionState.

- [ ] **Steps 1–4:** failing check (tool listed; returns skeleton for a warmed path; clean miss for unknown path) → implement → green.
- [ ] **Step 5:** Commit `feat(recall): MCP recall tool`

---

### Task 8: Dashboard savings panel

**Files:**
- Modify: `lib/dashboard-team.js` or the relevant `lib/dashboard/` client file (find where the projects grid renders; **these files are one large template literal — a stray backtick breaks require; smoke-check with `node -e "require('./lib/dashboard/<file>')"` after EVERY edit**)
- Test: `test/run-tests.js` (payload-level assertions only — the suite has no browser)

Renders from `/api/savings`: Home stat `<total> tokens of file reading avoided · <pct>% of context loaded`; per-project `<n> avoided · <serves> reads answered`; projects with `avoided.tokens === 0` show `no repeat reads yet`. **Never the word "saved"** — spec §8.2: avoided is what we measure, saved implies the bill fell (spec §8.3 honest zero). No dollars anywhere.

- [ ] **Steps 1–4:** extend the savings payload check to cover the fields the panel reads; implement; `node -e` smoke-check; suite green.
- [ ] **Step 5:** Commit `feat(recall): savings panel in the dashboard`

---

### Task 9: Diagnostics flag (net-negative auto-report)

**Files:**
- Create: `lib/diagnostics.js`
- Modify: `lib/scan.js` (after fold: if `avoided.tokens < 0` over a project's lifetime AND serves ≥ 20 (net already accounts for follow-up reads via the §7.1 formula), pause recall for the project (config flag write) and queue one diagnostic)
- Modify: `lib/server.js` settings payload (expose `diagnostics.enabled`, default true)
- Test: `test/run-tests.js`

Payload exactly per spec §8.5 (install_id random uuid persisted in `~/.membridge/config.json`, version, net_tokens, acceptance, reads_answered, reject_reasons, languages) **plus `direct_avoided` and `holdout_divergence`** so the §7.2 divergence check can be pooled across installs — that pooling is the whole reason the holdout exists, and it is impossible without these two fields — **no code, file names, project names, or account**. POST to `config.diagnosticsUrl` (default the Supabase function URL constant; honour `diagnostics.enabled === false` and `MEMBRIDGE_NO_DIAGNOSTICS=1`). Network send is fire-and-forget with a 5 s timeout; **tests never hit the network** — point `diagnosticsUrl` at the suite's local mock server and assert the payload shape and the privacy fields' absence.

- [ ] **Steps 1–4:** failing check (net-negative project → recall paused + one queued payload with exactly the allowed keys, no path-like strings) → implement → green.
- [ ] **Step 5:** Commit `feat(recall): anonymous net-negative diagnostics with kill switches`

---

### Task 10: End-to-end proof

**Files:**
- Create: `test/recall-e2e.js` (opt-in, like ledger-equivalence)
- Test wiring: none in `npm test`

Simulates a real session against a fixture repo: write files → seed ledger history (two sessions reading the same paths) → warm → drive `runRecall` with realistic payloads → assert served bodies, then fold and assert `/api/savings.avoided.tokens > 0` end to end. **Must assert all three outcomes of the §7.1 formula** — no follow-up, targeted follow-up, and full re-read — because the targeted-follow-up case is new and the most likely to regress silently. Prints a human-readable summary: `answered N reads, X tokens of file reading avoided (P partial wins, Q net-negative), holdout skipped M`. This is the script Marco runs to SEE it work before dogfooding.

- [ ] **Steps 1–4:** write, run, green. **Step 5:** Commit `test(recall): end-to-end serve-and-measure proof`

---

## Execution notes

- Task order is dependency order; nothing is parallel-safe across tasks 3→6.
- After Task 10: rebuild the app (`npm run dist:mac`), reinstall, run `membridge setup-hooks`, and dogfood on this repo — the next real Claude Code session shows serves live, and `/api/savings` accumulates from real work.
- The three pre-fix `ledger.json` files reset on first sync (by design, previous plan).
- Bash-based reads (`cat`/`grep`) are not intercepted and not tiered — still a floor; disclosed in the spec.
