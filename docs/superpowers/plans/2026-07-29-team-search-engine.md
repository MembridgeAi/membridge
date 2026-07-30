# Team Search Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the MCP `search_memory` tool from a substring match over two fields into a ranked search engine over the full team memory — every field, every teammate, and history far older than the 100-row cache window — so an agent can answer "who touched auth and why" across a 5+ person team.

**Architecture:** Three layers. (1) Widen what search can see: the MCP layer currently drops `decisions`/`gotchas`/`headline`/`session` from team rows, and the cache caps team history at 100 rows/project (~20 days for a 2-person team) — a new durable per-project archive fed by the daemon's existing pull keeps the long tail locally, preserving the invariant that an MCP call never needs team credentials. (2) A dependency-free ranked scorer (`lib/search.js`, pure functions — scale is ≤ ~200 entries/project, so a linear scan wins over any index). (3) Anonymous usage counters for MCP tools so the next product decision has data. No UI surface — that is deliberate (research: humans need "a way to ask," which is the agent; a dashboard ask-box is a post-rebuild decision).

**Tech Stack:** Node ≥18, zero new dependencies. Existing modules: `lib/mcp.js`, `lib/feed.js`, `lib/teamsync.js`, `lib/counters.js`, `test/run-tests.js` (single-file offline suite).

## Global Constraints

Every task's requirements implicitly include all of these.

- **No new runtime dependencies.** `package.json` dependencies stay exactly: `@modelcontextprotocol/sdk`, `libsodium-wrappers`, `web-tree-sitter`, `zod`.
- **Baseline:** clean origin/master passes **1151/1152**. The one pre-existing failure is `counters: an unset endpoint never sends (self-hosted builds)` (regression from b64cff0, fixed in a separate session). Do NOT fix or chase it here. If that fix merges under you, the baseline becomes 1152/1152. Every task boundary must match or exceed the baseline you recorded at its start.
- **Tests:** all offline, appended to `test/run-tests.js` as `check('name', fn)` inside `main()`. Async checks MUST be `await check(...)` — a rejected assertion otherwise kills the suite as an unhandled rejection. Never hardcode a port; use the suite's `P(n)` probed-port convention. Run the suite with `node test/run-tests.js`.
- **The MCP tool list stays exactly six.** `test/run-tests.js:13493` asserts the exact sorted list `['get_project_memory','get_recent_activity','list_projects','recall','search_memory','why']`. We change `search_memory`'s schema, never add a tool.
- **MCP invariants** (stated at `lib/mcp.js:2-13`, `145-149`): an MCP call never requires team credentials; never writes memory, `events.jsonl`, or `sessionState`; stdout is the JSON-RPC wire — no stray prints. Task 9's usage tally is the one documented exception to "writes nothing" and it must never touch memory or the ledger.
- **Redaction:** every text field returned to an MCP client passes through the boundary redaction in `lib/mcp.js` / `feed.normalize*` closures. Team rows are stored RAW at rest (`proj.teamEntries` and the new archive) — scoring and results must only ever use post-normalize (redacted) entries. Always redact before clip.
- **Project/file identity:** cross-machine project identity is the server-side `projectId` (UUID), never a filesystem path (`lib/repo-root.js:14-25` documents the worktree-fragmentation trap). File filters use substring matching, never path equality — local files are project-relative, team files are checkout-relative wire keys.
- **Do not touch** `ui/`, `lib/dashboard/`, `web/`, or `lib/digest.js`'s injection code — the interface-rebuild branch owns those.
- **Commits:** conventional format (`feat:`, `test:`, `fix:`, `docs:`), one commit per task, on branch `worktree-team-search-engine`.
- **Style:** match the codebase — plain Node modules, block-comment headers explaining *why*, small pure functions with table tests (see `lib/counters.js`, `lib/redundancy.js` for the house idiom). New modules stay under ~400 lines.

## File Structure

| File | Role |
| --- | --- |
| `lib/search.js` (new) | Pure tokenizer + weighted field scorer + ranker. No fs/state/network. |
| `lib/team-archive.js` (new) | Durable per-project archive of pulled team rows under `~/.membridge/team-archive/`. |
| `lib/mcp-usage.js` (new) | Best-effort `{tool: lastUsedIso}` tally the daemon's counters tick reads. |
| `lib/mcp.js` (modify) | Widen team-row pass-through; defer git derivation; rewire `search_memory`; read archive; record usage. |
| `lib/feed.js` (modify) | Export `dedupeKey` (already exists internally at `:116-119`). |
| `lib/teamsync.js` (modify) | Extract `mapPulledRow`; archive append on pull; backward backfill walker. |
| `lib/counters.js` (modify) | `mcp_tool_used` counter + `MCP_TOOLS` allowlist + `readMcpUsage`. |
| `bin/membridge.js` (modify) | Thread MCP usage into the counters tick. |
| `cloudflare/counters-worker/src/index.js` (modify) | Mirror the new counter name + `tool` dim allowlist. |
| `test/run-tests.js` (modify) | New checks in section 14 (MCP), a new search-engine section, teamsync + counters sections. |
| `docs/guide.md`, `CHANGELOG.md` (modify) | Document the six tools, new search params, archive. |

---

### Task 1: Widen the team-row pass-through in `allActivity`

The MCP layer whitelists 8 fields off each cached team row (`lib/mcp.js:160-169`) and silently drops `session`, `goal`, `decisions`, `gotchas`, `headline`, `distilled`, `undecryptable` — fields `feed.normalizeTeam` (`lib/feed.js:69-111`) already knows how to carry, and which `pullProject` (`lib/teamsync.js:1241-1265`) already stores. Measured on live data, `ask` is null on 80% of team rows — the dropped fields are most of the remaining signal.

**Files:**
- Modify: `lib/mcp.js:159-170`
- Test: `test/run-tests.js` (section 14, extend the Priya fixture at `:13469-13476` and add one check)

**Interfaces:**
- Consumes: `feed.normalizeTeam(row, {redact})` — reads `row.session`, `row.goal`, `row.decisions`, `row.gotchas`, `row.headline`, `row.distilled`, `row.undecryptable` (verified at `lib/feed.js:84-104`).
- Produces: team entries in `allActivity()`'s output now carry `session`, `goal`, `decisions`, `gotchas`, `headline`, `distilled` (redacted), and the `undecryptable` marker. Tasks 3, 4, 8 rely on these fields existing.

- [ ] **Step 1: Extend the planted teammate fixture and write the failing check.** In `test/run-tests.js`, find the planted `teamEntries` fixture (search for `sk-tamper-mcp-999`). Extend the planted entry with the deliberate fields (keep every existing field exactly as is):

```js
        ask: 'rotate creds token=sk-tamper-mcp-999',
        goal: 'rotate all vault credentials',
        decisions: 'JWT rotation happens in vault, never in app config',
        gotchas: 'terraform apply needs a manual approve step',
        headline: 'Rotated vault tokens',
        summary: 'stored the new token api_key=sk-tamper-mcp-888 in the vault',
```

Then, directly after the existing `mcp: get_recent_activity merges local + teammate entries…` check, add:

```js
    check('mcp: team rows carry session/goal/decisions/gotchas/headline through to activity', () => {
      const priya = recent.entries.find(e => e.author === 'Priya');
      assert.strictEqual(priya.session, 'p1', 'session dropped');
      assert.strictEqual(priya.goal, 'rotate all vault credentials', 'goal dropped');
      assert.ok(/vault/.test(priya.decisions || ''), 'decisions dropped');
      assert.ok(/manual approve/.test(priya.gotchas || ''), 'gotchas dropped');
      assert.strictEqual(priya.headline, 'Rotated vault tokens', 'headline dropped');
    });
```

- [ ] **Step 2: Run to verify it fails.** `node test/run-tests.js` → this check FAILS with `session dropped` (the whitelist nulls it). All other counts match baseline.

- [ ] **Step 3: Implement.** In `lib/mcp.js`, replace the object literal inside the `for (const e of proj.teamEntries || [])` loop:

```js
    for (const e of proj.teamEntries || []) {
      // Pass through everything normalizeTeam knows how to carry — the
      // stored row shape is pullProject's `mapped` (lib/teamsync.js). An
      // omission here silently blinds search and activity to that field.
      team.push(feed.normalizeTeam({
        author_name: e.author,
        project_name: name,
        ts: e.ts,
        source: e.source,
        session: e.session,
        ask: e.ask,
        goal: e.goal,
        decisions: e.decisions,
        gotchas: e.gotchas,
        summary: e.summary,
        headline: e.headline,
        distilled: e.distilled,
        files: e.files,
        changes: e.changes,
        ...(e.undecryptable ? { undecryptable: true } : {}),
      }, { redact }));
    }
```

- [ ] **Step 4: Run to verify it passes.** `node test/run-tests.js` → new check passes; the section's secret-leak assertions still pass (the new fields carry no secrets, and normalizeTeam redacts them anyway).

- [ ] **Step 5: Commit.**

```bash
git add lib/mcp.js test/run-tests.js
git commit -m "fix(mcp): stop dropping decisions/gotchas/headline/session from team rows"
```

---

### Task 2: Defer git-change derivation on the MCP read path

`lib/mcp.js:156` calls `memorydb.buildEntries(key, proj, config)` without `{ deferChanges: true }`, so every `search_memory` / `get_recent_activity` call spawns `git` subprocesses for every summary-bearing entry of every tracked project. `lib/server.js:542-554` shows the fix pattern: defer, then derive only for entries that survive the page slice, and strip `_highlights` before the JSON boundary.

**Files:**
- Modify: `lib/mcp.js` (the `allActivity` buildEntries call, plus `getRecentActivity` and `searchMemory`)
- Test: `test/run-tests.js` (section 14)

**Interfaces:**
- Consumes: `memorydb.buildEntries(projectPath, proj, config, { deferChanges: true })` and `memorydb.deriveEntryChanges(projectPath, files, highlights, regexes)` (signatures at `lib/memorydb.js:103,108`).
- Produces: `deriveDeferred(entries, regexes)` in `lib/mcp.js` — takes sliced entries, fills `changes` for local entries carrying `_highlights`, deletes `_highlights`, returns the same array. Task 4 calls it on ranked results.

- [ ] **Step 1: Write the failing checks.** In section 14, after the Task 1 check, add:

```js
    const { data: recent2 } = await callJson('get_recent_activity', { limit: 20 });
    check('mcp: deferred git derivation never leaks _highlights into a response', () => {
      assert.ok(!JSON.stringify(recent2).includes('_highlights'), '_highlights leaked');
    });
    check('mcp: buildEntries on the MCP path defers git-change derivation', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp.js'), 'utf8');
      assert.ok(src.includes('deferChanges: true'), 'MCP path still derives changes eagerly for every project');
      assert.ok(src.includes('deriveEntryChanges'), 'no derive-for-survivors pass');
    });
```

(Source-shape checks are an accepted idiom in this suite — see the pinned call-site greps near the end of `main()`.)

- [ ] **Step 2: Run to verify the source-shape check fails.** `node test/run-tests.js` → FAIL: `MCP path still derives changes eagerly…`.

- [ ] **Step 3: Implement.** In `lib/mcp.js`:

Change the buildEntries call in `allActivity`:

```js
    for (const e of memorydb.buildEntries(key, proj, config, { deferChanges: true })) {
```

Add below `allActivity` (mirrors `lib/server.js:548-554`, same defensive re-redact):

```js
// Deferred git-change derivation, mirroring lib/server.js: buildEntries
// above skipped the git-subprocess step for EVERY entry of EVERY project;
// run it here only for the local entries that survived the caller's slice,
// then strip the internal carrier so it never reaches the JSON boundary.
function deriveDeferred(entries, regexes) {
  const redact = t => digest.redactText(t, regexes);
  for (const e of entries) {
    if (e.origin === 'local' && e._highlights) {
      e.changes = memorydb.deriveEntryChanges(e.projectPath, e.files, e._highlights, regexes)
        .map(c => (c.note ? { ...c, note: redact(c.note) } : c));
    }
    if (e._highlights) delete e._highlights;
  }
  return entries;
}
```

Wire both consumers:

```js
function getRecentActivity(limit) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes);
  const { entries } = feed.buildFeed({ local, team, limit: limit || 50 });
  return { entries: deriveDeferred(entries, regexes) };
}
```

and in `searchMemory`, wrap the final entries the same way (Task 4 rewrites this function; until then apply it to the existing `buildFeed` result: `return { query, results: deriveDeferred(entries, regexes) };`).

- [ ] **Step 4: Run to verify everything passes.** `node test/run-tests.js` → both new checks pass; the existing `get_recent_activity` teammate-changes assertion still passes (team rows are unaffected by deferral — their `changes` ride the wire).

- [ ] **Step 5: Commit.**

```bash
git add lib/mcp.js test/run-tests.js
git commit -m "perf(mcp): defer git-change derivation to served entries only"
```

---

### Task 3: `lib/search.js` — tokenizer and ranked scorer

Pure module, no fs/state/network, table-tested. Design points that are load-bearing: **no recency weighting** (cross-teammate overlap has ~50-day median — a recency boost recreates the exact blindness this engine exists to fix; timestamp is a tiebreak only), **files are a first-class match field** (densest signal on team rows), and **AND-biased multi-term matching** (an entry must match a majority of distinct terms or it scores 0).

**Files:**
- Create: `lib/search.js`
- Test: `test/run-tests.js` (new section `// --- 14b. search engine (lib/search.js) ---` placed directly after section 14's closing brace)

**Interfaces:**
- Consumes: normalized feed entries (shapes from `feed.normalizeLocal` / `feed.normalizeTeam`): reads `headline`, `decisions`, `gotchas`, `goal`, `ask`, `summary`, `files[]`, `changes[].note`, `project`, `author`, `ts`.
- Produces: `tokenize(text) -> string[]`, `scoreEntry(entry, queryTokens, rawQuery) -> {score, matched}`, `rankEntries(entries, rawQuery) -> entries'` (shallow copies with `score:number` and `matched:string[]` attached, sorted score-desc then ts-desc; zero-score entries dropped; inputs never mutated). Task 4 calls `rankEntries`.

- [ ] **Step 1: Write the failing tests.** Add the new section to `test/run-tests.js` (top of the block: `const search = require('../lib/search');`):

```js
  // --- 14b. search engine (lib/search.js): pure ranked scoring ---
  {
    const search = require('../lib/search');

    check('search: tokenize keeps identifiers and file names whole, drops stopwords', () => {
      assert.deepStrictEqual(search.tokenize('Rotated auth.js and JWT_SECRET handling.'),
        ['rotated', 'auth.js', 'jwt_secret', 'handling']);
      assert.deepStrictEqual(search.tokenize('the and of'), []);
      assert.deepStrictEqual(search.tokenize(''), []);
      assert.deepStrictEqual(search.tokenize(null), []);
    });

    check('search: deliberate fields (decisions) outrank harvested prose (summary)', () => {
      const a = { ts: '2026-07-01T00:00:00.000Z', summary: 'touched auth flow' };
      const b = { ts: '2025-01-01T00:00:00.000Z', decisions: 'auth stays in middleware' };
      const ranked = search.rankEntries([a, b], 'auth');
      assert.strictEqual(ranked.length, 2);
      assert.strictEqual(ranked[0].decisions, 'auth stays in middleware');
      assert.ok(ranked[0].score > ranked[1].score);
    });

    check('search: an old exact hit beats a recent partial one (no recency weighting)', () => {
      const recentPartial = { ts: '2026-07-01T00:00:00.000Z', summary: 'token cleanup pass' };
      const oldExact = {
        ts: '2026-01-01T00:00:00.000Z', headline: 'rewrote token refresh',
        decisions: 'token refresh lives in the gotrue passthrough',
        files: ['lib/token-refresh.js'],
      };
      const ranked = search.rankEntries([recentPartial, oldExact], 'token refresh');
      assert.strictEqual(ranked[0].headline, 'rewrote token refresh');
    });

    check('search: multi-term queries are AND-biased — one flooded term is not a match', () => {
      const noise = { ts: '2026-07-01T00:00:00.000Z', summary: 'auth auth auth everywhere auth' };
      assert.deepStrictEqual(search.rankEntries([noise], 'auth vault rotation epochs'), []);
    });

    check('search: file-only team rows are findable (ask/summary null on most team rows)', () => {
      const row = { ts: '2026-07-01T00:00:00.000Z', ask: null, summary: null, files: ['infra/vault.tf'] };
      const ranked = search.rankEntries([row], 'vault');
      assert.strictEqual(ranked.length, 1);
      assert.deepStrictEqual(ranked[0].matched, ['files']);
    });

    check('search: rankEntries never mutates its inputs', () => {
      const e = { ts: '2026-07-01T00:00:00.000Z', summary: 'auth' };
      const before = JSON.stringify(e);
      search.rankEntries([e], 'auth');
      assert.strictEqual(JSON.stringify(e), before);
    });

    check('search: equal scores tiebreak newest-first', () => {
      const older = { ts: '2026-01-01T00:00:00.000Z', summary: 'vault work' };
      const newer = { ts: '2026-06-01T00:00:00.000Z', summary: 'vault work' };
      const ranked = search.rankEntries([older, newer], 'vault');
      assert.strictEqual(ranked[0].ts, '2026-06-01T00:00:00.000Z');
    });
  }
```

- [ ] **Step 2: Run to verify they fail.** `node test/run-tests.js` → the suite dies at `require('../lib/search')` (module not found) — that counts as the red step; note it and move on.

- [ ] **Step 3: Implement `lib/search.js`.** Create the file with exactly this content:

```js
// Ranked search over normalized feed entries (lib/feed.js shapes). Pure
// functions only — no fs, no state, no network — so the MCP server and any
// future dashboard surface share one scorer with no side effects.
//
// Load-bearing design points:
// - Zero dependencies: hand-rolled tokenizer + weighted field scorer. At the
//   observed scale (<= ~200 entries per project) a linear scan beats any
//   index we would have to keep consistent.
// - NO recency weighting. Cross-teammate overlap has no recency (median ~50
//   days between one dev's work and a teammate re-covering it), so a recency
//   boost would recreate exactly the blindness this engine exists to fix.
//   Timestamp is a tiebreak only.
// - Callers hand in entries that already passed the feed normalizers'
//   redaction closure; this module never sees raw-at-rest team rows.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'with', 'was', 'be', 'are', 'at', 'by', 'from', 'as', 'we',
  'i', 'you', 'my', 'our', 'did', 'do', 'does', 'what', 'who', 'why', 'how',
  'when', 'where',
]);

// Keep _ $ . - inside tokens so identifiers and file names survive whole
// (auth.js, snake_case, kebab-case), then trim punctuation left by sentence
// position ("handling." -> "handling").
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_$.\-]+/)
    .map(t => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// Weights favor what a teammate wrote deliberately (headline, decisions,
// gotchas) over harvested prose, and file paths over both — "who touched
// auth" must hit files even when no summary exists (on live data, 80% of
// team rows carry no ask; files is their densest content signal).
const FIELD_WEIGHTS = {
  headline: 4,
  decisions: 4,
  gotchas: 4,
  files: 3,
  goal: 3,
  ask: 2,
  summary: 2,
  changeNotes: 2,
  project: 1,
  author: 1,
};

function fieldText(entry, field) {
  if (field === 'files') return (entry.files || []).join(' ');
  if (field === 'changeNotes') return (entry.changes || []).map(c => (c && c.note) || '').join(' ');
  return entry[field] || '';
}

// Score one entry. { score: 0 } means "not a result". Multi-term queries are
// AND-biased: the entry must match a strict majority of distinct terms
// somewhere, or one flooded common word would drown a specific query.
function scoreEntry(entry, queryTokens, rawQuery) {
  if (!queryTokens.length) return { score: 0, matched: [] };
  const matchedTerms = new Set();
  let score = 0;
  const matched = [];
  for (const field of Object.keys(FIELD_WEIGHTS)) {
    const text = fieldText(entry, field);
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    let fieldHits = 0;
    for (const q of queryTokens) {
      // Substring over tokens: "auth" must hit "auth.js" and "author-auth".
      for (const t of tokens) {
        if (t === q || t.includes(q)) { fieldHits += 1; matchedTerms.add(q); break; }
      }
    }
    if (fieldHits > 0) {
      score += fieldHits * FIELD_WEIGHTS[field];
      matched.push(field);
    }
  }
  const needed = Math.floor(queryTokens.length / 2) + 1;
  if (matchedTerms.size < needed) return { score: 0, matched: [] };
  // Verbatim-phrase bonus: the whole query inside one deliberate field is a
  // far stronger signal than its words scattered across fields.
  const phrase = String(rawQuery || '').toLowerCase().trim();
  if (phrase.length >= 4) {
    for (const field of ['headline', 'decisions', 'gotchas', 'ask', 'summary', 'goal']) {
      if (fieldText(entry, field).toLowerCase().includes(phrase)) { score += 5; break; }
    }
  }
  return { score, matched };
}

// Rank: score everything, drop zeros, sort score-desc with newest-first ts
// as the ONLY tiebreak. Returns shallow copies; inputs are never mutated.
function rankEntries(entries, rawQuery) {
  const queryTokens = [...new Set(tokenize(rawQuery))];
  const scored = [];
  for (const e of entries || []) {
    const { score, matched } = scoreEntry(e, queryTokens, rawQuery);
    if (score > 0) scored.push({ ...e, score, matched });
  }
  scored.sort((a, b) => (b.score - a.score) ||
    String(b.ts || '').localeCompare(String(a.ts || '')));
  return scored;
}

module.exports = { tokenize, scoreEntry, rankEntries, FIELD_WEIGHTS };
```

- [ ] **Step 4: Run to verify all seven checks pass.** `node test/run-tests.js`.

- [ ] **Step 5: Commit.**

```bash
git add lib/search.js test/run-tests.js
git commit -m "feat(search): dependency-free ranked scorer over memory entries"
```

---

### Task 4: Rewire `search_memory` — ranked results, filters, honest description

Replace the substring filter (`lib/mcp.js:182-195`) with the ranker plus structured filters. Same tool name — the six-tool list is pinned by a test and must not change. The result shape stays `{query, results}` (agents already parse it) and gains `total`; entries gain `score` and `matched`.

**Files:**
- Modify: `lib/mcp.js` (`searchMemory` + the `search_memory` registration in `registerTools`), `lib/feed.js` (export `dedupeKey`)
- Test: `test/run-tests.js` (section 14)

**Interfaces:**
- Consumes: `searchLib.rankEntries` (Task 3), `deriveDeferred` (Task 2), `feed.dedupeKey(entry)` (exists at `lib/feed.js:116-119`; this task exports it).
- Produces: `searchMemory(args)` where `args = {query, author?, project?, file?, tool?, since?, until?, limit?}` → `{query, total, results}`. Task 8 extends the same function's input set with archive rows and does not change this signature.

- [ ] **Step 1: Write the failing tests.** In section 14, after the existing `search_memory returns no results` check, add:

```js
    const { data: sDecide } = await callJson('search_memory', { query: 'vault rotation' });
    check('mcp: search_memory matches team decisions, not just ask/summary', () => {
      assert.ok(sDecide.results.some(r => r.author === 'Priya'),
        'a decisions-only match was missed (query terms only appear in the decisions field)');
      assert.ok(!JSON.stringify(sDecide).includes('sk-tamper-mcp'), 'secret leaked');
    });

    check('mcp: search results are ranked (score desc) and carry matched fields', () => {
      assert.ok(sDecide.results.every(r => typeof r.score === 'number' && Array.isArray(r.matched)));
      const scores = sDecide.results.map(r => r.score);
      assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a), 'results not score-ordered');
    });

    const { data: sFile } = await callJson('search_memory', { query: 'vault', file: 'vault.tf' });
    check('mcp: search_memory file filter narrows to entries touching the file', () => {
      assert.ok(sFile.results.length >= 1, 'file-filtered search found nothing');
      assert.ok(sFile.results.every(r => (r.files || []).some(f => f.includes('vault.tf'))));
    });

    const { data: sAuthor } = await callJson('search_memory', { query: 'vault', author: 'priya' });
    check('mcp: search_memory author filter is a case-insensitive substring', () => {
      assert.ok(sAuthor.results.length >= 1 && sAuthor.results.every(r => r.author === 'Priya'));
    });

    const { data: sTool } = await callJson('search_memory', { query: 'vault', tool: 'Codex' });
    check('mcp: search_memory tool filter matches the source exactly', () => {
      assert.ok(sTool.results.length >= 1 && sTool.results.every(r => r.source === 'Codex'));
    });
```

Note for the fixture: the Priya entry's `decisions` ('JWT rotation happens in vault, never in app config') is the ONLY place both `vault` and `rotation` appear together on a team row — that is what makes the first check prove decisions-matching. Also update the existing keyword check if its `results.some(...)` shape assertions conflict (they should not — `ask`/`summary` still exist on results).

- [ ] **Step 2: Run to verify they fail.** `node test/run-tests.js` → `search_memory` rejects the unknown `file`/`author`/`tool` args or misses the decisions-only match (current matcher reads ask/summary only).

- [ ] **Step 3: Implement.** In `lib/feed.js`, add `dedupeKey` to the module exports (it is defined at `:116`; just export it alongside the existing exports). In `lib/mcp.js`, add `const searchLib = require('./search');` at the top, then replace `searchMemory`:

```js
// Ranked search (lib/search.js) over everything cached on this machine:
// your entries plus teammates' pulled rows, across every tracked project.
// Filters narrow BEFORE ranking. File filtering is a substring match on
// purpose: local files are project-relative, team files arrive as
// checkout-relative wire keys, and worktree prefixes differ per machine —
// exact path equality across those schemes is a known trap (lib/repo-root.js).
function searchMemory(args) {
  const { state, config, regexes } = loadContext();
  const { local, team } = allActivity(state, config, regexes);
  // Same collision rule as buildFeed: local wins over its own pushed twin.
  const seen = new Set(local.map(feed.dedupeKey));
  const all = local.concat(team.filter(t => !seen.has(feed.dedupeKey(t))));
  const needle = v => String(v).toLowerCase();
  const filtered = all.filter(e => {
    if (args.author && !needle(e.author || '').includes(needle(args.author))) return false;
    if (args.project && !needle(e.project || '').includes(needle(args.project))) return false;
    if (args.tool && needle(e.source || '') !== needle(args.tool)) return false;
    if (args.since && String(e.ts || '') < args.since) return false;
    if (args.until && String(e.ts || '') > args.until) return false;
    if (args.file && !(e.files || []).some(f => needle(f).includes(needle(args.file)))) return false;
    return true;
  });
  const ranked = searchLib.rankEntries(filtered, args.query);
  const results = deriveDeferred(ranked.slice(0, args.limit || 20), regexes);
  return { query: args.query, total: ranked.length, results };
}
```

Update the `search_memory` registration in `registerTools` — keep the existing annotation object exactly as the other five tools have it (the tool-list test asserts `readOnlyHint`/`destructiveHint` on all six), and replace description + schema:

```js
  server.registerTool('search_memory', {
    title: 'Search team memory',
    description: 'Ranked search over everything MemBridge remembers on this machine: your sessions and your teammates\' shared work (asks, summaries, decisions, gotchas, headlines, files touched) across all tracked projects. Use for "who touched X", "why was Y done this way", "has anyone dealt with Z" questions. Results are ranked by relevance, not date — old work surfaces when it matches.',
    inputSchema: {
      query: z.string().min(1).describe('keywords, a file name, or a topic'),
      author: z.string().optional().describe('only entries by this teammate (name substring)'),
      project: z.string().optional().describe('only this project (name substring)'),
      file: z.string().optional().describe('only entries touching this file (path substring)'),
      tool: z.string().optional().describe('only this source tool, e.g. "Claude Code" or "Codex"'),
      since: z.string().optional().describe('ISO date lower bound, e.g. "2026-06-01"'),
      until: z.string().optional().describe('ISO date upper bound'),
      limit: z.number().int().positive().max(200).optional(),
    },
    annotations: /* copy the exact annotations object the current registration uses */
  }, async (args) => textResult(searchMemory(args)));
```

(Adopt the surrounding registrations' exact `annotations` literal — do not invent new hint fields.)

- [ ] **Step 4: Run to verify everything passes.** `node test/run-tests.js` → all five new checks pass, the two pre-existing search checks pass, the six-tool-list check passes untouched.

- [ ] **Step 5: Commit.**

```bash
git add lib/mcp.js lib/feed.js test/run-tests.js
git commit -m "feat(mcp): ranked search_memory with author/project/file/tool/date filters"
```

---

### Task 5: `lib/team-archive.js` — durable team history

`proj.teamEntries` is a working cache: `pullProject` truncates it to the newest 100 rows (`MAX_TEAM_ENTRIES`, `lib/teamsync.js:37,1274`) — about 20 days of a 2-person team, less at 5+. Rows are fetched, merged, then discarded, and the cursor advances so they are never re-fetched. This module is the durable side: every pull also appends here (Task 6), and search reads it (Task 8). MCP stays credential-free because the daemon writes the archive and search only reads local files.

**Files:**
- Create: `lib/team-archive.js`
- Test: `test/run-tests.js` (new section `// --- 14c. team archive (lib/team-archive.js) ---` after 14b)

**Interfaces:**
- Consumes: `util.homeDir()` (returns `~/.membridge`, `MEMBRIDGE_HOME`-overridable — the tests rely on that isolation), rows in `pullProject`'s `mapped` shape: `{author, ts, source, session, ask, goal, decisions, gotchas, summary, headline, distilled, files, changes, undecryptable?}`.
- Produces:
  - `archivePath(projectId) -> string` (`<home>/team-archive/<projectId>.json`; projectId is the server-side UUID — never a filesystem path)
  - `loadArchive(projectId) -> {version, projectId, backfill: {done:boolean, before:string|null}, rows: []}` (fails open: missing/corrupt file → empty archive)
  - `appendRows(projectId, mappedRows) -> number` (merge by `` `${author}|${ts}|${source}` `` with replace-on-collision — same rule as `pullProject:1192-1196`; ts-ascending sort; cap `MAX_ARCHIVE_ROWS = 5000` keeping the newest; atomic tmp+rename write, mode 0600; swallows write errors)
  - `setBackfill(projectId, {done, before}) -> void`
  - Tasks 6, 7, 8 consume all four.

- [ ] **Step 1: Write the failing tests.**

```js
  // --- 14c. team archive (lib/team-archive.js): durable pulled-row history ---
  {
    const teamArchive = require('../lib/team-archive');

    check('team-archive: append merges by (author|ts|source), replaces on re-push, sorts by ts', () => {
      const pid = 'arc-proj-1';
      teamArchive.appendRows(pid, [
        { author: 'A', ts: '2026-01-02T00:00:00.000Z', source: 'Codex', summary: 'v1' },
      ]);
      teamArchive.appendRows(pid, [
        { author: 'A', ts: '2026-01-02T00:00:00.000Z', source: 'Codex', summary: 'v2' },
        { author: 'B', ts: '2026-01-01T00:00:00.000Z', source: 'Claude Code', summary: 'older' },
      ]);
      const arc = teamArchive.loadArchive(pid);
      assert.strictEqual(arc.rows.length, 2, 're-pushed row duplicated instead of replaced');
      assert.strictEqual(arc.rows[0].author, 'B', 'rows not ts-ascending');
      assert.strictEqual(arc.rows[1].summary, 'v2', 'replace-on-collision lost the newer version');
    });

    check('team-archive: a corrupt file fails open as an empty archive', () => {
      const p = teamArchive.archivePath('arc-bad');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{definitely not json');
      const arc = teamArchive.loadArchive('arc-bad');
      assert.deepStrictEqual(arc.rows, []);
      assert.strictEqual(arc.backfill.done, false);
    });

    check('team-archive: the cap keeps the newest rows', () => {
      const pid = 'arc-cap';
      const mk = i => ({
        author: 'A', source: 'Codex', summary: `row ${i}`,
        ts: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
      });
      teamArchive.appendRows(pid, Array.from({ length: 5010 }, (_, i) => mk(i)));
      const arc = teamArchive.loadArchive(pid);
      assert.strictEqual(arc.rows.length, 5000);
      assert.strictEqual(arc.rows[arc.rows.length - 1].summary, 'row 5009', 'newest row lost to the cap');
      assert.strictEqual(arc.rows[0].summary, 'row 10', 'cap kept the oldest instead of the newest');
    });

    check('team-archive: setBackfill round-trips and survives appends', () => {
      const pid = 'arc-bf';
      teamArchive.setBackfill(pid, { done: false, before: '2026-05-01T00:00:00.000Z' });
      teamArchive.appendRows(pid, [{ author: 'A', ts: '2026-06-01T00:00:00.000Z', source: 'Codex' }]);
      const arc = teamArchive.loadArchive(pid);
      assert.strictEqual(arc.backfill.before, '2026-05-01T00:00:00.000Z');
      assert.strictEqual(arc.backfill.done, false);
    });
  }
```

- [ ] **Step 2: Run to verify they fail** (module not found).

- [ ] **Step 3: Implement `lib/team-archive.js`.**

```js
// Durable per-project archive of pulled teammate rows.
//
// proj.teamEntries in state.json is a WORKING CACHE: pullProject truncates
// it to the newest MAX_TEAM_ENTRIES (100) — roughly 20 days for a 2-person
// team, under a week for a busy 5-person one — and the pull cursor advances,
// so older rows are gone from this machine forever. Search needs the long
// tail (cross-teammate overlap has a ~50-day median), so every pull also
// appends its mapped rows here, and search reads cache + archive merged.
//
// Storage: one JSON file per server-side project id under
// <homeDir>/team-archive/<projectId>.json. projectId is the team backend's
// UUID — stable across machines and worktrees, never derived from a path
// (lib/repo-root.js documents why path-derived keys fragment).
//
// Rows are stored in pullProject's `mapped` shape, RAW at rest — exactly
// like proj.teamEntries. Redaction happens at every read boundary (the feed
// normalizers' redact closure), never trusted from rest.
//
// Every function fails open: an unreadable archive is an empty one, and a
// failed write must never break a pull or a search.

const fs = require('fs');
const path = require('path');
const util = require('./util');

const MAX_ARCHIVE_ROWS = 5000;
const rowKey = r => `${r.author}|${r.ts}|${r.source}`;

function archiveDir() {
  return path.join(util.homeDir(), 'team-archive');
}

function archivePath(projectId) {
  // projectId is a server-issued UUID; strip anything path-hostile anyway.
  return path.join(archiveDir(), `${String(projectId).replace(/[^A-Za-z0-9-]/g, '_')}.json`);
}

function emptyArchive(projectId) {
  return { version: 1, projectId, backfill: { done: false, before: null }, rows: [] };
}

function loadArchive(projectId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivePath(projectId), 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rows)) return emptyArchive(projectId);
    if (!parsed.backfill || typeof parsed.backfill !== 'object') parsed.backfill = { done: false, before: null };
    return parsed;
  } catch {
    return emptyArchive(projectId);
  }
}

function saveArchive(arc) {
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    const p = archivePath(arc.projectId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(arc), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { /* fail-open: the archive is an accelerator, never a blocker */ }
}

// Merge-by-key with replace-on-collision — the same rule as pullProject's
// cache merge: a row re-arriving under the same (author, ts, source) is by
// definition a NEWER version (drift re-push, reshare).
function appendRows(projectId, mappedRows) {
  if (!Array.isArray(mappedRows) || !mappedRows.length) return 0;
  const arc = loadArchive(projectId);
  const seen = new Map(arc.rows.map((r, i) => [rowKey(r), i]));
  for (const r of mappedRows) {
    if (!r || !r.author || !r.ts) continue;
    const k = rowKey(r);
    if (seen.has(k)) arc.rows[seen.get(k)] = r;
    else { seen.set(k, arc.rows.length); arc.rows.push(r); }
  }
  arc.rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  arc.rows = arc.rows.slice(-MAX_ARCHIVE_ROWS);
  saveArchive(arc);
  return arc.rows.length;
}

function setBackfill(projectId, backfill) {
  const arc = loadArchive(projectId);
  arc.backfill = { done: !!backfill.done, before: backfill.before || null };
  saveArchive(arc);
}

module.exports = { archivePath, loadArchive, appendRows, setBackfill, MAX_ARCHIVE_ROWS };
```

- [ ] **Step 4: Run to verify the four checks pass.** `node test/run-tests.js`.

- [ ] **Step 5: Commit.**

```bash
git add lib/team-archive.js test/run-tests.js
git commit -m "feat(team): durable per-project archive of pulled teammate rows"
```

---

### Task 6: Archive every pull

Hook the archive into `pullProject` (`lib/teamsync.js:1165-1277`): collect each pass's `mapped` rows and append them to the archive after the merge, before/independent of the cache slice. Fail-open — the archive must never break a pull.

**Files:**
- Modify: `lib/teamsync.js` (`pullProject`)
- Test: `test/run-tests.js` (extend the existing teamsync pull tests — find them by searching for `pullProject` or `teamEntries` assertions against the mock Supabase harness in `test/mock-supabase.js`)

**Interfaces:**
- Consumes: `teamArchive.appendRows(link.projectId, mappedRows)` (Task 5). `link.projectId` is already in scope in `pullProject`.
- Produces: after any pull, `teamArchive.loadArchive(link.projectId).rows` contains every row the pass mapped — including rows the `slice(-MAX_TEAM_ENTRIES)` discards from the cache.

- [ ] **Step 1: Write the failing test.** Locate the existing pull test that seeds rows through the mock Supabase server and asserts on `proj.teamEntries` (search `test/run-tests.js` for `MAX_TEAM_ENTRIES` or a pull test seeding >100 rows; if none seeds past the cap, add one following the section's existing seeding pattern). Add a check in that section:

```js
    // Seed 120 teammate rows through the mock server, run one pull pass.
    // The cache must hold the newest 100; the archive must hold all 120.
    check('teamsync: a pull archives every mapped row, beyond the cache cap', () => {
      assert.strictEqual(proj.teamEntries.length, 100, 'cache cap changed — update this test deliberately');
      const arc = require('../lib/team-archive').loadArchive(linkProjectId);
      assert.strictEqual(arc.rows.length, 120, 'rows sliced from cache were not archived');
      assert.ok(arc.rows[0].ts < proj.teamEntries[0].ts, 'archive lost the pre-cap tail');
    });
```

Adapt `proj` / `linkProjectId` to the surrounding test's actual variable names; the assertions are the contract. If the mock harness paginates (PULL_LIMIT=200), 120 rows arrive in one pass.

- [ ] **Step 2: Run to verify it fails** (archive empty).

- [ ] **Step 3: Implement.** In `lib/teamsync.js`: add `const teamArchive = require('./team-archive');` with the other requires. In `pullProject`, collect the pass's rows — declare `const mappedRows = [];` before the `for (const r of rows)` loop, add `mappedRows.push(mapped);` right after `const mapped = {...}` is built, and after the `existing.sort(...)` line insert:

```js
  // Archive every pulled row durably BEFORE the cache slice discards the old
  // tail — search's historical reach depends on this (the state cache keeps
  // only the newest MAX_TEAM_ENTRIES rows; see lib/team-archive.js).
  try { teamArchive.appendRows(link.projectId, mappedRows); } catch { /* never break a pull */ }
```

- [ ] **Step 4: Run to verify it passes**, and that every pre-existing teamsync check still passes (the merge/slice/cursor behavior is untouched).

- [ ] **Step 5: Commit.**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat(team): archive pulled rows before the cache cap discards them"
```

---

### Task 7: Backfill history older than the cursor

Existing installs have `teamPullTs` far past their team's origin — rows older than the current cache were pulled once and discarded, and forward pulls never revisit them. Add a backward walker: one page per sync pass (gentle, 200 rows/tick), from "now" back to exhaustion, then done-forever. Fresh links do not need it (their forward pull starts at epoch and Task 6 archives everything) but running it anyway is harmless — it terminates on the first empty page.

**Files:**
- Modify: `lib/teamsync.js` (extract `mapPulledRow` from `pullProject`'s loop body; add `backfillArchivePage`; call it where `pullProject` is called in the sync pass)
- Test: `test/run-tests.js` (teamsync section, mock Supabase)

**Interfaces:**
- Consumes: the extracted `mapPulledRow(r, link, teamCrypto) -> mapped` (the decrypt-on-pull + field-mapping body currently inline at `lib/teamsync.js:1197-1265` — extraction must be behavior-identical, including the fail-closed `undecryptable` path and `warnOnce` keys), `rest(config, creds, 'GET', q)`, the `selectCols`/`SELECT_COLUMN_MISSING_RX` fallback pattern (`:1167-1189` — extract it too so both callers share one `fetchMemoryRows(config, creds, where)` helper), `teamArchive` (Task 5).
- Produces: `backfillArchivePage(config, creds, proj, link, teamCrypto) -> number` (rows archived this pass). Archive `backfill.done` flips true when a page comes back short/empty. `proj.teamPullTs` is NEVER touched by backfill.

- [ ] **Step 1: Write the failing test.** In the teamsync section, using the same mock-server seeding pattern:

```js
    // 450 historical rows, cursor already advanced past all of them (the
    // "existing install" shape). Three backfill passes at PULL_LIMIT=200
    // must drain them newest-first and then mark done.
    await check('teamsync: backfill walks history backward one page per pass, then stops forever', async () => {
      /* seed 450 rows with created_at older than proj.teamPullTs via the mock server */
      const before1 = await teamsync.backfillArchivePage(config, creds, proj, link, null);
      const before2 = await teamsync.backfillArchivePage(config, creds, proj, link, null);
      const before3 = await teamsync.backfillArchivePage(config, creds, proj, link, null);
      assert.deepStrictEqual([before1, before2, before3], [200, 200, 50]);
      const arc = require('../lib/team-archive').loadArchive(link.projectId);
      assert.strictEqual(arc.rows.length, 450);
      assert.strictEqual(arc.backfill.done, true);
      const before4 = await teamsync.backfillArchivePage(config, creds, proj, link, null);
      assert.strictEqual(before4, 0, 'a done backfill fetched again');
      assert.strictEqual(proj.teamPullTs, savedCursor, 'backfill moved the FORWARD cursor');
    });
```

(Adapt seeding/`config`/`creds`/`link` plumbing to the surrounding tests' harness; export `backfillArchivePage` from teamsync for this.)

- [ ] **Step 2: Run to verify it fails** (`backfillArchivePage` is not a function).

- [ ] **Step 3: Implement.** In `lib/teamsync.js`:

1. Extract the loop body of `pullProject` (`let content = r; ... const mapped = {...}`) into a top-level `async function mapPulledRow(r, link, teamCrypto)` returning `mapped`. `pullProject` calls it inside its loop — behavior byte-identical (keep the `warnOnce` context handling exactly as is).
2. Extract the select-columns fetch (the `for(;;)` with `SELECT_COLUMN_MISSING_RX` at `:1167-1189`) into `async function fetchMemoryRows(config, creds, where)` where `where` is the query-string fragment after `memory_entries?`; `pullProject` builds its fragment from the cursor as today.
3. Add:

```js
// Backward archive backfill: existing installs advanced teamPullTs long ago,
// so rows older than the cache were pulled once and discarded. Walk history
// newest-first, ONE page per sync pass (200 rows — gentle on the backend and
// on the tick), archive each page, and flip backfill.done on the first short
// or empty page. Never touches proj.teamPullTs: forward pulls own that.
async function backfillArchivePage(config, creds, proj, link, teamCrypto) {
  const arc = teamArchive.loadArchive(link.projectId);
  if (arc.backfill.done) return 0;
  const before = arc.backfill.before || new Date().toISOString();
  const where = `project_id=eq.${link.projectId}` +
    `&author_id=neq.${creds.userId}` +
    `&created_at=lt.${encodeURIComponent(before)}` +
    `&order=created_at.desc&limit=${PULL_LIMIT}`;
  const rows = await fetchMemoryRows(config, creds, where);
  if (!rows || !rows.length) {
    teamArchive.setBackfill(link.projectId, { done: true, before });
    return 0;
  }
  const mapped = [];
  for (const r of rows) mapped.push(await mapPulledRow(r, link, teamCrypto));
  teamArchive.appendRows(link.projectId, mapped);
  teamArchive.setBackfill(link.projectId, {
    done: rows.length < PULL_LIMIT,
    before: rows[rows.length - 1].created_at,
  });
  return rows.length;
}
```

4. Call it in the sync pass directly after the existing `pullProject(...)` call for each linked project (find the call site with `grep -n "pullProject(" lib/teamsync.js`), wrapped `try/catch` like other best-effort steps, passing the same `teamCrypto`. Export `backfillArchivePage` in `module.exports`.

- [ ] **Step 4: Run to verify it passes**, plus the full suite — the `mapPulledRow`/`fetchMemoryRows` extraction must leave every existing pull/encryption test green.

- [ ] **Step 5: Commit.**

```bash
git add lib/teamsync.js test/run-tests.js
git commit -m "feat(team): backfill the archive backward to the team's first row"
```

---

### Task 8: Search reads the archive

`allActivity` gains an opt-in archive read so `search_memory` reaches full history while `get_recent_activity` / `get_project_memory` keep their exact current behavior (recent views never need the long tail, and their payloads must not grow).

**Files:**
- Modify: `lib/mcp.js` (`allActivity` signature + `searchMemory`)
- Test: `test/run-tests.js` (section 14)

**Interfaces:**
- Consumes: `teamArchive.loadArchive(projectId)` (Task 5); the project's team link for its `projectId` — read via the same local, credential-free helper teamsync/dashboard use for `.membridge/team.json` (find it: `grep -n "team.json" lib/*.js`; reuse, do not reimplement).
- Produces: `allActivity(state, config, regexes, opts)` where `opts.includeArchive: true` merges archive rows (cache rows win by `(author|ts|source)` key) through the SAME `normalizeTeam` adapter as Task 1. Only `searchMemory` passes it.

- [ ] **Step 1: Write the failing test.** In section 14, plant an archive row too old for any cache, then search for it:

```js
    // A 60-day-old archived row — far outside the cache window — must be
    // findable by search, and must NOT appear in recent activity.
    {
      const teamArchive = require('../lib/team-archive');
      const oldTs = new Date(Date.now() - 60 * 86400000).toISOString();
      teamArchive.appendRows('mcp-app-project-uuid', [{
        author: 'Priya', ts: oldTs, source: 'Codex', session: 'p0',
        ask: null, summary: null, goal: null,
        decisions: 'chose libsodium sealed boxes over NaCl streams for epoch keys',
        gotchas: null, headline: null, distilled: true,
        files: ['lib/teamcrypto.js'], changes: null,
      }]);
      /* write .membridge/team.json in projMcp linking projectId
         'mcp-app-project-uuid' — copy the shape an existing team-link test
         writes (grep for team.json in the teamsync test sections). */
    }

    const { data: sArchive } = await callJson('search_memory', { query: 'sealed boxes epoch' });
    await check('mcp: search reaches archived history older than the team cache', async () => {
      const hit = sArchive.results.find(r => /sealed boxes/.test(r.decisions || ''));
      assert.ok(hit, '60-day-old archived decision not found');
      assert.strictEqual(hit.author, 'Priya');
    });

    const { data: recent3 } = await callJson('get_recent_activity', { limit: 50 });
    check('mcp: recent activity does NOT read the archive (payload stays bounded)', () => {
      assert.ok(!JSON.stringify(recent3).includes('sealed boxes'),
        'archive rows leaked into get_recent_activity');
    });
```

- [ ] **Step 2: Run to verify the first check fails** (archive not read).

- [ ] **Step 3: Implement.** In `lib/mcp.js`:

1. `allActivity(state, config, regexes, opts = {})`. After the existing team loop for each project, add:

```js
    if (opts.includeArchive) {
      const link = readTeamLink(key); // the existing .membridge/team.json reader
      if (link && link.projectId) {
        const seen = new Set((proj.teamEntries || []).map(e => `${e.author}|${e.ts}|${e.source}`));
        for (const e of teamArchive.loadArchive(link.projectId).rows) {
          if (seen.has(`${e.author}|${e.ts}|${e.source}`)) continue;
          team.push(feed.normalizeTeam({
            author_name: e.author, project_name: name, ts: e.ts, source: e.source,
            session: e.session, ask: e.ask, goal: e.goal, decisions: e.decisions,
            gotchas: e.gotchas, summary: e.summary, headline: e.headline,
            distilled: e.distilled, files: e.files, changes: e.changes,
            ...(e.undecryptable ? { undecryptable: true } : {}),
          }, { redact }));
        }
      }
    }
```

(`readTeamLink` = whatever the grep in Interfaces found — use its real name. The adapter object is intentionally identical to Task 1's; archive rows and cache rows are the same shape.)

2. `searchMemory` passes the flag: `allActivity(state, config, regexes, { includeArchive: true })`. The other callers stay two/three-arg.

- [ ] **Step 4: Run to verify all checks pass** — including the untouched `get_recent_activity` checks (payload unchanged) and every redaction check (archive rows pass through `normalizeTeam`'s redact closure like any team row).

- [ ] **Step 5: Commit.**

```bash
git add lib/mcp.js test/run-tests.js
git commit -m "feat(mcp): search_memory reaches the full archived team history"
```

---

### Task 9: `mcp_tool_used` counter (client, MCP tally, worker mirror)

We currently have zero data on whether MCP tools get used — that gap is why the search-UI decision had to be researched externally. Add a bounded, anonymous presence counter: which tools were used in the last 24h. Never counts, never arguments. The MCP process must not gain network calls, so it tallies locally (`lib/mcp-usage.js`) and the daemon's existing counters tick reports.

**Files:**
- Create: `lib/mcp-usage.js`
- Modify: `lib/counters.js`, `lib/mcp.js` (`registerTools`), `bin/membridge.js` (`countersTick`), `cloudflare/counters-worker/src/index.js`
- Test: `test/run-tests.js` (counters section at `:16586+` and section 14)

**Interfaces:**
- Consumes: `util.homeDir()`; the diagnostics kill switch (`diagnostics.diagnosticsEnabled(config)` — the same gate `emitCounters` uses at `lib/counters.js:150-155`).
- Produces:
  - `lib/mcp-usage.js`: `recordToolUse(tool, {config, now}) -> void` (silent, atomic write of `{tool: lastUsedIso}` to `<home>/mcp-usage.json`, mode 0600; no-op when diagnostics are disabled or the tool is not in the allowlist) and `toolsUsedWithin(ms, {now}) -> string[]`.
  - `lib/counters.js`: `MCP_TOOLS` allowlist (the six tool names), `'mcp_tool_used'` in `COUNTER_NAMES`, `buildCounters({..., mcpToolsUsed})` emitting one `{name:'mcp_tool_used', dims:{tool}}` per used tool. `emitCounters` gains `opts.mcpToolsUsed` threaded through.
  - Worker: `'mcp_tool_used'` in `COUNTER_NAMES`, `tool: Set(<six names>)` in `DIM_VALUES`.

- [ ] **Step 1: Write the failing tests.** In the counters section:

```js
    check('counters: mcp_tool_used rides buildCounters, one per used tool, allowlisted', () => {
      const built = counters.buildCounters({ mcpToolsUsed: ['search_memory', 'why', 'not_a_tool'] });
      const mcp = built.filter(c => c.name === 'mcp_tool_used');
      assert.deepStrictEqual(mcp.map(c => c.dims.tool).sort(), ['search_memory', 'why'],
        'unknown tool leaked or a known one dropped');
      assert.ok(counters.signatureOf(built).includes('search_memory'),
        'usage change must change the signature so it actually sends');
    });

    check('counters: worker allowlist mirrors the client (drift check)', () => {
      const worker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'counters-worker', 'src', 'index.js'), 'utf8');
      assert.ok(worker.includes("'mcp_tool_used'"), 'worker COUNTER_NAMES missing mcp_tool_used');
      for (const t of counters.MCP_TOOLS) {
        assert.ok(worker.includes(`'${t}'`), `worker DIM_VALUES missing tool ${t}`);
      }
    });

    check('mcp-usage: records within the allowlist, honors the kill switch, reads back a 24h window', () => {
      const mcpUsage = require('../lib/mcp-usage');
      const now = Date.now();
      mcpUsage.recordToolUse('search_memory', { config: {}, now });
      mcpUsage.recordToolUse('why', { config: {}, now: now - 25 * 3600000 });      // stale
      mcpUsage.recordToolUse('not_a_tool', { config: {}, now });                    // rejected
      mcpUsage.recordToolUse('recall', { config: { diagnostics: { enabled: false } }, now }); // killed
      assert.deepStrictEqual(mcpUsage.toolsUsedWithin(24 * 3600000, { now }), ['search_memory']);
    });
```

And in section 14 (source-shape, pinning the wiring):

```js
    check('mcp: every tool handler records usage through the tally', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp.js'), 'utf8');
      assert.ok(src.includes("require('./mcp-usage')"), 'mcp-usage not wired');
      assert.ok((src.match(/recordToolUse\(/g) || []).length >= 1, 'no recordToolUse call');
    });
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement.**

`lib/mcp-usage.js`:

```js
// Anonymous MCP usage tally. The MCP server is read-only toward MEMORY (it
// never writes events.jsonl, sessionState, or state.json — lib/mcp.js). This
// file is the one deliberate write, and it is not memory: a best-effort
// { toolName: lastUsedIso } map under the membridge home so the DAEMON's
// counters tick can report WHICH tools see use — never how often, never
// with what arguments. Respects the diagnostics kill switch at record time:
// an opted-out install never even tallies. Every path swallows errors — a
// failed tally must never surface into a tool response, and the MCP process
// must never gain a network call for this.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const diagnostics = require('./diagnostics');
const { MCP_TOOLS } = require('./counters');

function tallyPath() { return path.join(util.homeDir(), 'mcp-usage.json'); }

function readTally() {
  try { return JSON.parse(fs.readFileSync(tallyPath(), 'utf8')) || {}; }
  catch { return {}; }
}

function recordToolUse(tool, opts = {}) {
  try {
    if (!MCP_TOOLS.includes(tool)) return;
    if (opts.config && !diagnostics.diagnosticsEnabled(opts.config)) return;
    const tally = readTally();
    tally[tool] = new Date(opts.now || Date.now()).toISOString();
    const p = tallyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(tally), { mode: 0o600 });
    fs.renameSync(`${p}.tmp`, p);
  } catch { /* never break a tool call over telemetry */ }
}

function toolsUsedWithin(ms, opts = {}) {
  const now = opts.now || Date.now();
  const tally = readTally();
  return MCP_TOOLS.filter(t => {
    const ts = Date.parse(tally[t] || '');
    return Number.isFinite(ts) && now - ts <= ms;
  });
}

module.exports = { recordToolUse, toolsUsedWithin, tallyPath };
```

(Verify `diagnostics.diagnosticsEnabled(config)`'s real export name at `lib/diagnostics.js` — `lib/counters.js:150-155` calls it; mirror that call exactly. Beware the require cycle counters↔mcp-usage: `mcp-usage` requires only `MCP_TOOLS` from counters; if `lib/counters.js` ends up requiring `mcp-usage`, move `MCP_TOOLS` into `mcp-usage` and have counters require it instead — one direction only.)

`lib/counters.js`: add to the allowlists block:

```js
const MCP_TOOLS = ['get_project_memory', 'get_recent_activity', 'list_projects', 'recall', 'search_memory', 'why'];
```

add `'mcp_tool_used'` to `COUNTER_NAMES`; in `buildCounters`, after the existing conditional pushes:

```js
  for (const tool of (opts.mcpToolsUsed || [])) {
    if (MCP_TOOLS.includes(tool)) out.push({ name: 'mcp_tool_used', dims: { tool } });
  }
```

(match `buildCounters`' actual parameter style — it currently destructures one options object), export `MCP_TOOLS`, and thread `opts.mcpToolsUsed` through `emitCounters` into its `buildCounters` call.

`bin/membridge.js` (`countersTick`, `:172-178`): compute and pass the window:

```js
    const mcpToolsUsed = require('../lib/mcp-usage').toolsUsedWithin(24 * 3600000, {});
    // ...existing emitCounters call gains: mcpToolsUsed
```

`lib/mcp.js` (`registerTools`): record at the top of each of the six handlers — one line each, e.g. for search: `mcpUsage.recordToolUse('search_memory', { config: loadContext().config });` — or wrap once:

```js
  const tracked = (name, fn) => async (args) => {
    try { mcpUsage.recordToolUse(name, { config: loadContext().config }); } catch { /* never block a tool */ }
    return fn(args);
  };
```

and wrap each registered handler with `tracked('why', ...)` etc. (wrapper preferred — one place, six call sites).

`cloudflare/counters-worker/src/index.js`: add `'mcp_tool_used'` to the `COUNTER_NAMES` set and `tool: new Set(['get_project_memory', 'get_recent_activity', 'list_projects', 'recall', 'search_memory', 'why'])` to `DIM_VALUES` (`:28-33`). Update the sync-comment.

- [ ] **Step 4: Run to verify everything passes.** `node test/run-tests.js`. The pre-existing `counters: an unset endpoint never sends` failure stays exactly as it was — untouched.

- [ ] **Step 5: Commit.**

```bash
git add lib/mcp-usage.js lib/counters.js lib/mcp.js bin/membridge.js cloudflare/counters-worker/src/index.js test/run-tests.js
git commit -m "feat(counters): anonymous mcp_tool_used presence counter"
```

**Release-order note (goes in the PR description, not code):** the worker must be deployed (`wrangler deploy` in `cloudflare/counters-worker/`, operator step) BEFORE any client release carrying this — the worker rejects a whole payload containing an unknown counter name, heartbeat included. Old clients are unaffected either way.

---

### Task 10: Documentation

**Files:**
- Modify: `docs/guide.md` (MCP section), `CHANGELOG.md`

- [ ] **Step 1: Update `docs/guide.md`'s MCP section.** It currently lists four tools; list all six (`list_projects`, `get_project_memory`, `get_recent_activity`, `search_memory`, `why`, `recall`). For `search_memory`, document: ranked (relevance, not date), the filter parameters (`author`, `project`, `file`, `tool`, `since`, `until`), that it searches decisions/gotchas/headlines/files — not just prompts — and that it reaches the full team history synced to this machine (the archive). One short paragraph on the archive under the team-sync section: pulled teammate rows are kept durably on your machine under `~/.membridge/team-archive/`, same trust domain as the existing cache, raw at rest, redacted at every read boundary. Do not restructure the guide or fix unrelated content (the guide has known staleness being handled elsewhere).

- [ ] **Step 2: Add a CHANGELOG entry** under the unreleased heading, matching the file's existing style:

```markdown
- Ranked team memory search: `search_memory` now scores across decisions,
  gotchas, headlines, files, and prompts with author/project/file/tool/date
  filters, and reaches the full synced team history (new durable archive) —
  not just the recent cache window.
- Anonymous `mcp_tool_used` counter (same kill switch as all diagnostics).
```

- [ ] **Step 3: Run the full suite one last time.** `node test/run-tests.js` → must match or exceed the recorded baseline (1151/1152, or 1152/1152 if the counters fix merged).

- [ ] **Step 4: Commit.**

```bash
git add docs/guide.md CHANGELOG.md
git commit -m "docs: document ranked search_memory, team archive, and usage counter"
```

---

## Self-review notes

- Spec coverage: widened fields (T1), perf (T2), scorer (T3), tool rewiring (T4), durable history (T5–T7), search reach (T8), usage data (T9), docs (T10). The dashboard "Ask" box is deliberately out of scope (post-rebuild decision — see the research summary in the session that produced this plan).
- Known adaptation points (deliberate, each with a locating grep): the teamsync test harness variable names (T6/T7), the `.membridge/team.json` reader's real name (T8), `buildCounters`' exact options destructuring (T9), and the `annotations` literal on tool registration (T4). Everything else is verbatim.
- Type consistency check: `mapped` row shape (teamsync) = archive row shape (T5) = the adapter input in T1/T8 — one shape, three sites, all listed field-for-field. `rankEntries` output carries `score`/`matched`; T4's tests assert both.
- The suite's exact six-tool assertion is never touched; no task adds a tool.
