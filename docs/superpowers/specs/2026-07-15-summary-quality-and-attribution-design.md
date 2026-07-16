# Summary Quality & Project Auto-Attribution — Design

**Date:** 2026-07-15
**Status:** Approved design, ready for implementation planning
**Scope:** Two cohesive subsystems that together make a remote teammate able to see, at a glance, *what a teammate intended, what they accomplished, and what the AI agent changed* — filed under the correct project.

---

## 1. Problem

A teammate on a remote machine reads MemBridge's synced activity (in the injected `CLAUDE.md`/`AGENTS.md` block and in the dashboard team feed) to catch up on what others' AI tools did. Today that view is degraded on two axes:

### 1a. Summary content is thrown away by structure and rendering
The distill Stop-hook already captures good raw material — `{did, decisions, gotchas}` — but:
- `scan.js` **flattens all three into one `text` blob** (`did. Decisions: … Gotchas: …`).
- `renderBlock` prints it as `Result:` **clipped to 240 chars**, cut mid-word, so `decisions`/`gotchas` are the first thing truncated away.
- **Intent** is the raw first user prompt — often noise (`"i gave you the wrong template"`) or `(prompt not shared)`.
- **Changes** is a flat, order-less filename list — a dep bump looks identical to the core feature.

So the three things a teammate needs map to: intent (weak/absent), outcome (truncated blob), changes (meaningless filename list).

### 1b. Work is filed under the wrong project
`project = the session's cwd`, stamped verbatim on every event (`lib/adapters/claude-code.js:49-62`). A session launched in `~/` but editing files in `~/Documents/Membridge/` is filed under `~/` — teammates of the Membridge project never see it, and the Stop hook writes the summary into `~/.membridge/` (wrong root). There is no project registry; `state.projects[key]` is created on demand from whatever cwd appears (`lib/digest.js:37`).

## 2. Goals

- A teammate sees **Intent · Outcome · Changes** as three distinct, scannable elements — never truncated blobs.
- One captured data model feeds **both** surfaces: a rich dashboard card and a compact, token-cheap injected block.
- "Changes" carries meaning: new/edited/deleted, deps dimmed, key files tagged.
- Sessions are filed under the project their **edits** land in, not the cwd they launched from.
- Nothing regresses: existing behavior is the fallback in every ambiguous case.

## 3. Non-goals

- No AI back-fill / model-based synthesis in the default path (BYOK advisor stays opt-out for this feature).
- No auto-discovery of untracked repos as new projects.
- No change to redaction, consent, or team-backend auth models beyond threading one new field.
- Not a dashboard visual overhaul beyond the summary card itself.

## 4. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Primary surface | **Both** — shared model, two renderers |
| 2 | "Changes" style | **Hybrid** — auto-derived file facts + agent tags on key files |
| 3 | Intent (`goal`) sharing | **Respect existing prompt-share setting** (gated like the raw ask) |
| 4 | No-checkpoint fallback | **Graceful degrade** — `Did` + auto-changes only; no AI back-fill |
| 5 | New-root policy | **Only re-file into already-tracked projects** (has a `.membridge/`) |
| 6 | Multi-repo session | **Split edits per their own root**; prompt/summary → dominant root |

---

## PART A — Richer summary data model + dual renderers

### A1. Capture schema (the Stop hook — `lib/hooks.js`)

The distillation `blockReason` prompt gains two optional fields. New line shape appended to `.membridge/summaries.jsonl`:

```json
{
  "session": "...", "ts": "...",
  "goal":      "<1 line: what you set out to do>",
  "did":       "<1-3 sentences: what you accomplished>",
  "decisions": "<key choices a teammate needs, or ''>",
  "gotchas":   "<surprises/pitfalls, or ''>",
  "highlights": [{ "file": "lib/mcp.js", "note": "the MCP server & 4 tools" }]
}
```

- `goal` and `highlights` are **optional** — a line missing them is still valid (backward compatible with existing `.jsonl`).
- `highlights` is capped (max 2 entries, `note` clipped) so the agent tags only what matters; the machine handles completeness.
- The prompt text is updated in `blockReason` and in the AGENTS.md standing-ask paragraph (`lib/digest.js:335`) to describe the two new fields, keeping "no markdown, no file lists" (file facts come from the machine, not the agent).

### A2. Storage keeps fields structured (`lib/scan.js` `scanSummaries`)

Stop flattening into `text`. A `kind:'summary'` event becomes:

```js
{
  ts, project, source: 'Distilled', kind: 'summary', session,
  text: did,                        // canonical outcome; unchanged for harvested/legacy events
  goal, decisions, gotchas,         // optional structured fields (present only when distilled)
  highlights: [{file, note}]        // optional
}
```

- `text` stays the single canonical outcome string (= `did`), so **harvested last-text summaries and all legacy stored events keep working** — they simply lack the optional fields.
- `pickSummary` / `sessionSummaries` are unchanged (they select events by tier/recency; they don't care about the new fields).

### A3. `sessionGroups` exposes the triad (`lib/digest.js`)

`sessionGroups` already returns `{ ask, summary, todos, files, … }`. It gains, pulled from the picked summary event:
- `goal` (intent), `decisions`, `gotchas`, `highlights`.
- `changes` — the derived changes model (A4), replacing the raw `files` list for rendering (raw `files` stays available for the "recently modified" footer).

### A4. Changes derivation (new module `lib/changes.js`)

Pure function: given a project root + the session's edit events, return an ordered, grouped change model:

```js
[
  { file: 'lib/mcp.js', status: 'new',     add: 312, del: 0, note: 'the MCP server & 4 tools', dep: false },
  { file: 'bin/membridge.js', status: 'edited', add: 28, del: 4, note: 'lazy mcp command', dep: false },
  { file: 'package.json', status: 'edited', dep: true }          // dependency-only → dimmed, counts omitted
]
```

- **Base signal (always available):** the deduped list of files the session's `kind:'edit'` events touched (already computed by `dedupeFiles`).
- **Enrichment (best-effort via `git`):** `status` (new/edited/deleted) and `add`/`del` line counts via `git diff --numstat` / `git status`. **Line counts are best-effort** — omitted when not confidently attributable, never faked.
- **Dep flagging:** `package.json`, lockfiles, and other dependency manifests flagged `dep:true` by name → dimmed, sorted last, counts suppressed.
- **`note`:** overlaid from the agent's `highlights` (matched by file path).
- **Degradation:** no git / file outside a repo → grouped filename list, no counts. Sorting: new → edited → deleted → deps.

### A5. Two renderers, one model

**Dashboard card** (`lib/dashboard.js` / `lib/dashboard-team.js`): Intent / Outcome (with Decisions·Gotchas sublines) / Changes (grouped, dimmed deps, tagged key files, `N files · +X −Y` header). Scannable in ~2s. (Mockup: `redesign-v1.html`.)

**Injected block** (`lib/digest.js` `renderBlock`): compact, structured, token-cheap — replaces the single truncated `Result:` line with:

```
- 2026-07-16 02:22 · andrewludwigbrown · Claude Code
  Intent:  Expose MemBridge project memory to other MCP clients
  Did:     Read-only MCP server + 4 tools (list_projects, …); lazy `membridge mcp` CLI command
  Notes:   read-only by design; MCP deps opt-in        ← decisions/gotchas, only if present
  Changes: +lib/mcp.js (new, +312) · bin/membridge.js · README.md · package.json (deps) — +441 −8
```

- Each field is independently clipped at a **generous** per-field cap (not one shared 240), so no field starves another. `Did` is the priority field.
- `Intent:` line omitted when `goal` absent or not shared (see A6).
- `Notes:` line omitted when both decisions and gotchas empty.
- Applies to both the "Recent asks across tools" (self) and "Teammates' AI activity" sections, which share this render.

### A6. Team sync (`lib/teamsync.js`)

- **`goal`** is threaded into the uploaded entry and **gated by the existing prompt-share setting**, exactly like `ask` today (`ask: share ? scrub(e.ask, 400) : null` → add `goal: share ? scrub(e.goal, 200) : null`). Backend schema gains a nullable `goal` column, with the **same predates-column graceful fallback** already used for `summary` (`teamsync.js:449-456`): on a `'goal' column` PostgREST error, retry without it.
- **Changes must be shipped, not recomputed by the reader** — a teammate has no access to the author's git. The uploaded `files` payload is enriched from a string array to the A4 change-model array (`{file, status, add, del, note, dep}`). `files` is already a JSON array column, so no type change; the reader accepts both shapes (legacy string array → filename-only render).
- `did`/`decisions`/`gotchas` continue to ship as `summary` (already always shared) — so even with prompt-sharing **off**, a teammate still gets Outcome + Changes; only Intent is withheld.

### A7. Fallback (decision #4)

A session with no distilled checkpoint (harvested last-text, or a tool without the hook) renders: `Did:` (= harvested `text`) + auto-derived `Changes:`, with **no `Intent`/`Notes`/tags**. Deterministic, zero model cost. The card/block simply omit the missing rows.

---

## PART B — Project auto-attribution

### B1. Marker resolver (new helper, e.g. `lib/project-resolve.js`)

`resolveRoot(filePath, { trackedRoots })` walks up from the file's directory to the nearest **marker** and returns the project root, or `null`:
- Marker = a directory containing `.membridge/` **or** `.git`.
- Per decision #5, a resolved root only counts if it is **already tracked** (present in `trackedRoots` = existing `state.projects` keys / dirs with `.membridge/`). A `.git` root MemBridge has never seen returns `null` → caller falls back to cwd.
- Nearest `.membridge/` wins over a higher `.git` (a tracked sub-project stays itself); otherwise the repo root (`.git`) is canonical so a monorepo is one project.
- Case-folded compare via existing `normPath` for win32 parity.

### B2. Re-homing events at scan time (`lib/scan.js`)

After adapters emit events (each still stamped `project: cwd`), a re-homing pass runs **before** `mergeEvents`:
- For each `kind:'edit'` event with a `file`, `resolveRoot(file)` → if non-null and ≠ its cwd project, **rewrite `event.project`** to the resolved root (decision #6: each edit follows its own root).
- For each session, compute the **dominant root** = the resolved root with the most edits. Re-home that session's `prompt`/`summary`/`todos` events (which have no file of their own) to the dominant root. If a session has no resolvable edits, everything stays on cwd (today's behavior).
- Events whose files resolve to `null` (untracked repo, or no marker) keep `project: cwd`.

This is a pure transform on the event list; `mergeEvents` then groups by the corrected `project`, so no downstream code changes.

### B3. Stop-hook project resolution (`lib/hooks.js` `runStop`)

The hook currently does `findProjectKey(state, cwd)`. It gains the same resolution: if the session's recent edits (already in `state`) resolve to a dominant tracked root ≠ cwd, the hook targets **that** root — so `summaries.jsonl` is written to the correct `.membridge/`, and the worthiness/checkpoint edit counts are read from the correct project. Falls back to cwd exactly as today when nothing resolves. Still fails **open** (any error → allow the stop).

### B4. Migration note

Re-homing is forward-only (new scans). Historical mis-filed events under a cwd "project" are left as-is; a `membridge rescan` could optionally re-home from source transcripts, but that is out of scope for v1.

---

## 5. Data flow (end to end)

```
agent Stop hook ─▶ summaries.jsonl {goal,did,decisions,gotchas,highlights}
transcripts ─────▶ adapters (events: prompt/edit/summary, project=cwd)
                       │
                       ▼
        scan.js: (B2) re-home events to resolved roots
                       │
        scan.js: scanSummaries → structured summary events (A2)
                       ▼
        digest.mergeEvents (group by corrected project)
                       ▼
        sessionGroups → {goal, did, decisions, gotchas, highlights, changes(A4)}
                       │
        ┌──────────────┼─────────────────────────┐
        ▼              ▼                          ▼
  renderBlock(A5)  dashboard card(A5)      teamsync upload(A6)
  injected block   human view             goal(gated)+summary+changes[]
                                                 ▼
                                          teammate pull → dashboard/team block
```

## 6. Error handling & fail-open

- Every git call in `lib/changes.js` is wrapped; failure → degrade to filename-only, never throw into the render path.
- `resolveRoot` returns `null` on any fs error → cwd fallback.
- The Stop hook keeps its absolute fail-open guarantee (B3).
- Malformed `.jsonl` lines (incl. bad `highlights`) are skipped exactly as today; missing optional fields are simply absent.
- Team backend without the `goal` column falls back gracefully (A6).

## 7. Testing

- **Unit:** `lib/changes.js` (new/edited/deleted/dep grouping, git-absent degradation, highlight overlay); `resolveRoot` (nearest marker, tracked-only gate, monorepo, null fallback); per-field clipping in `renderBlock`.
- **Integration:** `scanSummaries` structured-field round-trip + legacy-line compat; B2 re-homing (single repo, multi-repo split, dominant-root prompt attribution, untracked→cwd); Stop-hook targeting the resolved root.
- **Render snapshots:** injected block with full triad, with fallback (no goal), with prompt-sharing off (no Intent, Outcome+Changes present).
- **Team:** upload/pull with enriched `files[]` objects and legacy string arrays; `goal` gating by share setting; predates-column fallback.
- Maintain the repo's existing green suite (204/204) and add cases per above.

## 8. YAGNI / deferred

- AI back-fill of `goal` for harvested sessions (decision #4 keeps it out).
- Auto-discovery of new repos (decision #5).
- Historical re-home / `rescan` (B4).
- Per-file diff previews in the dashboard card (link/expand only).
```
