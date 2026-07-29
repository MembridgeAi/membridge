# Live teammate decisions — design

**Date:** 2026-07-28
**Status:** approved, ready for a plan
**Depends on:** the recall/ledger layer on `claude/scale-agent-waste-corpus-53abef` (52 commits ahead of master, unpushed). This spec extends `lib/hooks-recall.js`, which does not exist on master. See §12.

---

## 1. The problem

When a teammate's session decides something — *"renamed the retry cap to `maxAttempts`; don't touch `validate.ts` until migration 018 lands"* — that knowledge reaches everyone else's agent only on the next CLAUDE.md block regeneration, which agents read at session start and never again.

Four failure shapes, all of which have bitten in practice:

1. **Conflicting work** — an agent redoes or undoes what a teammate just did.
2. **Stale conventions** — an agent builds on the old name or the deprecated pattern.
3. **Known traps** — an agent walks into a pitfall a teammate already hit and documented.
4. **Human blindness** — the developer themselves does not know what changed.

These do not share a delivery trigger, and that is the central design fact. (1) and (3) are file-shaped: they matter when an agent touches a specific file. (2) is project-wide: a rename matters when writing a *brand-new* file that no teammate has ever touched, so there is no file to attach it to. (4) is not an agent surface at all.

---

## 2. What already exists (verified against the branch)

This section records probe results so the implementer does not re-derive them. Line numbers drift; the claims were true at `claude/scale-agent-waste-corpus-53abef`.

### 2.1 Decisions are already captured, already file-keyed, already on the wire

The Stop-hook distillation prompt (`lib/hooks.js:98`, `:103-105`) already asks each session for:

- `decisions` — *"choices made and why — the reasoning a teammate would need before building on or questioning this work"*
- `gotchas` — *"surprises or pitfalls hit, written so a teammate does not hit them again"*
- `highlights` — `[{file, note}]`, *"up to 2 of the most important files with a short note each on why they matter"*

`highlights` is folded into per-file change records by `lib/changes.js:90` (`deriveChanges`), producing `{file, status, add, del, note, dep}`, redacted and clipped to 80 chars locally (`lib/memorydb.js:104`).

On push (`lib/teamsync.js`, `entryToRow`), the row carries `decisions` and `gotchas` scrubbed to 240 chars, `files` (the session's edit set as relative paths), and `changes` with each `note` scrubbed to 240 chars. `encryptRow` seals `ask`, `summary`, `goal`, `decisions`, `gotchas`, `files`, `changes`, `headline` into the ciphertext. All of these are pulled back and decrypted on the receiving side (`OPTIONAL_PULL_COLUMNS`, and the content field list around `lib/teamsync.js:1152`).

**Consequence: file-keyed teammate notes already cross the wire today.** No distillation schema change, no wire change, and no migration is required for this feature. Earlier framing of "routing a decision to a file" as the biggest open design problem was wrong.

Note that `highlights` itself does *not* cross the wire — `_highlights` is deliberately stripped (`lib/server.js:485-489`, `:581`, `:643-645`). Its content survives as `changes[].note`.

### 2.2 Project identity is already git-keyed

`lib/teamsync.js` `repoUrl()` normalizes the origin remote (`git@github.com:u/r.git` and `https://github.com/u/r` both become `github.com/u/r`), and a committed `team.json` overrides it so fork clones converge on one project row rather than each minting an island. Different local paths on different machines already map to one shared project.

### 2.3 Worktrees already resolve correctly

`lib/project-resolve.js` `defaultWorktreeMain()` reads a worktree's `.git` *file*, extracts the main repo root, and redirects resolution there — deliberately ahead of the tracked/`.membridge` test, so a stray worktree marker cannot pin work to the worktree. A worktree therefore produces main-repo-root-relative paths. **This question is closed; no work needed.**

### 2.4 The recall hook fires on every read but bails early

`lib/hooks-recall.js` is registered as a PreToolUse hook on Read/Grep/Glob (`lib/hooks.js:322`) and does fire on every such call in a tracked project. However it returns at `lib/hooks-recall.js:215`:

```js
if (!storeEntry) return;
```

Skeletons are only built for the ledger's hot set, capped at `MAX_WARM_PER_CALL = 25` per sync pass (`lib/recall-store.js:31`, `warm()`). A file with no prior reads has no store entry, so the hook steps aside before doing anything else. The ordering is deliberate and performance-critical — the comment at `:206-215` explains that the store lookup is placed ahead of the ledger parse and the content hash because the hash is the most expensive thing the hook can do.

**Consequence: delivering a note on a cold file requires a lookup placed *ahead* of that gate.** It must be at least as cheap as the store lookup it precedes.

### 2.5 The current injection mechanism blocks the read

The hook's only output path today is `permissionDecision: 'deny'` with the skeleton as `permissionDecisionReason` (`lib/hooks-recall.js:271-273`). Content is injected by *refusing the tool call*. There is no code path that lets a read proceed and attaches text to it.

Claude Code does support this — `hookSpecificOutput.additionalContext` on PreToolUse, alongside `permissionDecision: "allow"` (or with the decision omitted). The docs state the string is wrapped in a system reminder and inserted "next to the tool result". MemBridge does not use it yet.

### 2.6 Sync cadence

The daemon runs a chained timeout re-reading `intervalSec` each round (`bin/membridge.js:170-173`); team sync rides the same tick, guarded against overlap (`teamTick`, `bin/membridge.js:151-164`). Default `intervalSec` is 60, floored at 15 (`lib/util.js:29`, `:161`).

The end-to-end lag decomposes as: decision made → Stop-hook distillation (minutes to hours, and dominant); distillation → push (seconds); push → local store (≤60s); local store → agent context (per-event, ~zero). Realtime push would attack the smallest controllable term while adding an auth surface with a history of fail-closed pauses. **Pull is retained.**

### 2.7 Cross-machine file identity is broken for monorepos

`readKeyFor` (`lib/ledger-fold.js:115`) and `relFile` (`lib/hooks-recall.js:99`) both compute paths relative to the **tracked project directory**, not the git root. `lib/project-resolve.js` `resolveRoot()` deliberately stops at the nearest tracked key — *"tracked sub-project or monorepo root"*.

Two teammates on the same remote tracking different depths (one at `repo`, one at `repo/packages/api`) land on the same project row via §2.2 but produce mismatched path keys. This is a real defect for this feature and is fixed here (§7), not deferred.

### 2.8 Hook API surface (from Claude Code docs)

- `additionalContext` is supported on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PostCompact` and others. It reaches the model only, wrapped in a system reminder; it does not appear as a chat message.
- `systemMessage` is a top-level output field shown to the **human** in the terminal, not to the model.
- `FileChanged` fires when a watched file changes on disk, with `matcher` naming literal filenames. It has **no decision control** — side effects only. Testing (§11) showed this also suppresses `systemMessage`, and that its matcher rejects any name containing `.` or `-`. Unusable for this feature.
- `SessionStart` matchers: `startup`, `resume`, `clear`, `compact`, `fork`.

---

## 3. Delivery model

The two failure shapes want different triggers, and they map onto the two kinds of data already arriving.

| Data | Nature | Trigger |
|---|---|---|
| `decisions` / `gotchas` prose | Project-wide fact. No file to wait for. | **On arrival** |
| `changes[].note` file notes | Meaningless until the file is touched. | **On contact** |

Each kind fires exactly once, at the only moment it can be useful. A decision never arrives twice.

Rejected alternatives:

- **Contact-only.** Gives up the rename case entirely. An agent writing a *new* file using the old name never touches any file the teammate touched, so nothing fires. It also fails when the agent already has the file in context from before the decision landed (no re-read, no hook), and when the agent finds the symbol by Grep — a file-keyed note has nothing to attach to a repo-wide search.
- **Arrival-only.** Loses the point-of-contact precision that motivates the feature, and pays for notes about files the session never opens.
- **Both triggers for both kinds.** Redundant; doubles the arrival cost for no added coverage.

### 3.1 The five delivery points

| # | Trigger | Hook | Audience | Payload |
|---|---|---|---|---|
| 1 | Daemon pulls a new decision | *(none — dashboard poll)* | Human | One line in the dashboard, no hook (§6, §11) |
| 2 | Next tool call after arrival | `PreToolUse` | Agent | Prose decisions, `additionalContext` |
| 3 | Agent reads/edits an affected file | `PreToolUse` | Agent | That file's note, `additionalContext` |
| 4 | After compaction | `PostCompact` | Agent | Still-live decisions, re-injected |
| 5 | Session start | `SessionStart` | Agent | Anything unseen, incl. catch-up brief |

Delivery point 4 is what makes the feature hold up on a long session: without it, a decision delivered in hour one is summarized away by hour four.

Delivery points 2–5 all inject via `additionalContext`; the PreToolUse ones (2 and 3) pair it with `permissionDecision: "allow"` or omit the decision entirely. **No delivery point in this feature ever denies a tool call.** The read proceeds untouched and the note attaches to the result. The one case where a note rides on a denial is §4.1, where the *recall* feature was already going to deny that read on its own account.

---

## 4. The teammate-notes index

One new per-project file, `<project>/.membridge/teammate-notes.json`, written by the daemon on each team pull and read by the hooks.

Purpose: give every delivery point a single, cheap source of truth, and keep the read path fast enough to sit ahead of the recall hook's `storeEntry` gate (§2.4).

Shape:

```json
{
  "version": 1,
  "updatedAt": "2026-07-28T10:15:00Z",
  "prose": [
    {
      "id": "<stable hash of author+ts+text>",
      "author": "Andrew",
      "ts": "2026-07-28T09:40:00Z",
      "kind": "decision",
      "text": "Renamed the retry cap to maxAttempts for SDK consistency."
    }
  ],
  "byFile": {
    "lib/validate.ts": [
      { "id": "…", "author": "Andrew", "ts": "…", "note": "blocked pending migration 018" }
    ]
  },
  "seen": {
    "prose": { "<id>": "2026-07-28T10:16:00Z" },
    "file": { "<sessionId>": { "<id>": "…" } }
  }
}
```

Constraints:

- `byFile` keys are **local** relative paths, translated from repo-root-relative on receipt (§7). The hooks do no path arithmetic at read time.
- The file is written atomically (tmp + rename), matching `lib/util.js` `saveState`, `lib/ledger-store.js` `writeLedger`, and `lib/recall-store.js` `put`.
- Any read failure is a miss, never a throw. Same fail-open contract as `recallStore.get`.
- `seen.file` is keyed by session id and pruned on write for sessions older than 7 days, so the file cannot grow without bound.
- Bounded: at most 200 prose entries and 500 `byFile` paths, oldest evicted first. The feed remains the complete record.

### 4.1 Placement in the recall hook

The `byFile` lookup goes **ahead of** `if (!storeEntry) return`. To stay within the ordering discipline established at `lib/hooks-recall.js:206-215`, it must:

- read one already-parsed, memory-resident-sized JSON file (no per-path blob reads);
- do no content hashing and no ledger parse;
- return immediately on a miss.

A note and a skeleton serve can co-occur on the same read. When they do, the skeleton serve keeps its existing `deny` semantics and the note is prepended to `permissionDecisionReason` rather than emitted as `additionalContext` — one output, not two.

---

## 5. Repetition and expiry

The rules that decide whether this stays switched on.

**Prose decisions deliver once, globally.** A rename is a fact; once delivered it is marked seen and never appears again, in any session.

**File notes deliver once per session, per file.** A standing condition (*"blocked pending 018"*) is still true tomorrow and tomorrow's agent does not know it, so it re-fires in a new session — but never twice within one.

**The clock governs repetition, not first delivery.** Anything never shown to this user never expires. Absence is not a reason to lose information.

**Seven days governs re-firing only.** After seven days a standing file note stops auto-re-appearing on contact. If it has never been delivered, it still appears in the catch-up brief regardless of age.

**Catch-up brief.** On the first session back where unseen decisions exceed the per-injection cap, deliver one block instead of a trickle:

> While you were away — 14 decisions from 3 teammates. [top 3 inline] 11 more in the feed.

**Hard cap of 3 decisions per injection**, newest first, with a pointer to the feed for the remainder.

**Conditional expiry is out of scope.** Resolving *"until migration 018 lands"* automatically when 018 appears is unbounded scope; the seven-day repetition clock covers it adequately.

**Mid-session lag.** A decision arriving while the agent is idle reaches it on the agent's next tool call, not instantly — hooks are event-driven and there is no push into an idle session (§2.8). The human has already seen delivery point 1 during that gap, so the developer is not blind.

---

## 6. The human surface

**The in-terminal line is cut.** It was to be a `FileChanged` hook emitting a
`systemMessage` when the daemon wrote `teammate-notes.json`. The spike
(`docs/superpowers/spikes/2026-07-28-filechanged-findings.md`, Claude Code
2.1.220) proved that impossible on two independent counts: `FileChanged`
suppresses `systemMessage` — its documented "no decision control" extends to
user-visible output, verified against a `SessionStart` control whose
`systemMessage` did surface in the same stream — and its matcher accepts only
letters, digits, `_` and `|`, so `teammate-notes.json` cannot be watched under
any spelling.

**The dashboard is the human surface.** It already polls every 5 seconds, so a
teammate decision is visible there within seconds of the pull with no new
mechanism. The human still learns about a decision without waiting for their
agent to act on it, which was the requirement; it just arrives in the browser
rather than the terminal.

Not adopted here, but noted for later: MemBridge ships as an Electron app, so
the daemon could raise a **native desktop notification** with no hook involved
and no context cost. That is a different mechanism from anything specced here
and needs its own design.

**The existing human surfaces are unchanged.** The Activity feed and the injected CLAUDE.md narrative block keep their current content and behaviour. This feature must not become a backdoor shrink or bloat of the CLAUDE.md block (decided 2026-07-28, token-reduction spec §5.5).

---

## 7. Cross-machine file identity

Fixes §2.7. Scope is deliberately confined to the wire boundary.

Local structures — the ledger, the recall store, `state.projects` — stay keyed to the tracked project directory. They never leave the machine, so they need no shared coordinate system, and re-keying them would be a large migration for no benefit.

**All paths that cross the wire are repo-root-relative.**

- Compute the repo root once per project via `git rev-parse --show-toplevel`, cached alongside the existing `repoUrl()` result (teamsync already spawns git per project, so this adds no new process class).
- **On push:** prefix local relative paths with the tracked-dir-to-root offset before they enter `files` and `changes[].file`.
- **On receive:** strip that offset when building `byFile`, so the hooks see local paths.

For a tracked dir of `<root>/packages/api`, the offset is `packages/api/`. Where the tracked dir *is* the root the offset is empty and behaviour is byte-identical to today.

**Mixed-format handling.** Rows already on the wire are tracked-dir-relative. A path that does not resolve as repo-root-relative is retried as tracked-relative. The fallback ages out naturally and needs no migration.

**Compatibility.** An older client receiving the new format sees a longer path string. For a monorepo teammate this is a display *fix* — teammates' file paths currently render wrong in the Activity feed — not a regression.

**Non-git and no-remote repos.** Stated plainly rather than hidden: team features require a shared remote identity, so a repo with no remote cannot join a team project. This feature neither introduces nor can close that; solo behaviour is untouched.

---

## 8. Privacy

Two rules, both explicit:

1. **Every decision text served into an agent context passes through `lib/redact.js` first** — the same gate skeletons pass. This is a backstop, not the primary defence: the text is already redacted locally before push and scrubbed again in `entryToRow`.
2. **The access boundary is team membership, not per-file read history.** Any current member of the team project receives its decisions, whether or not their sessions ever read the affected file. This is deliberate and closes the question rather than leaving it implicit.

E2E encryption is unchanged. The server continues to see only ciphertext; decryption and all routing stay client-side.

---

## 9. Token accounting

This feature cannot be made ledger-neutral and no attempt is made to present it as such. Every injected note is pure input cost, and its value is an avoided mistake — which the token ledger has no way to observe. Folding it into the avoided/injected balance would require either fabricated "avoided" figures or a feature that always reads as a loss.

**Injected note bytes are tagged at serve time** (exact attribution, not inferred from context growth) and reported as their own line in the Savings surface:

> Tokens injected as teammate notes, this period: 4,120

placed **outside** the net-savings math, with one sentence of copy explaining why it sits outside.

Wording constraints are binding: tokens, never dollars; "avoided", never "saved" (token-reduction spec §8.1/§8.2).

Expected magnitude: a prose decision is ≤240 chars plus framing, roughly 100–150 tokens, once per teammate session that recorded one. File notes are the same size and fire only on contact.

---

## 10. Failure modes

The governing rule from the recall layer holds unchanged: **every failure degrades to ordinary agent behaviour, never to broken work.**

| Failure | Behaviour |
|---|---|
| `teammate-notes.json` missing or corrupt | Treated as no notes; hooks step aside |
| Index write fails | Previous index stays valid; retried next pull |
| Dashboard not open when a decision lands | No human notice until it is opened; the agent surfaces are unaffected |
| Sync paused / auth expired | No new notes; existing index still serves |
| Path translation fails | Tracked-relative fallback (§7); on total failure, no note |
| Hook exceeds its budget | Existing 5s settings timeout applies; read proceeds |

The whole hook body stays inside the existing outer try/catch. Nothing in this feature may block a tool call or extend the read path beyond the established 150 ms working budget.

A kill switch mirrors `MEMBRIDGE_NO_RECALL`: `config.teammateNotes.enabled === false` disables all five delivery points.

---

## 11. Resolved assumptions

Both previously open questions were settled by a live test against Claude Code
2.1.220 — see `docs/superpowers/spikes/2026-07-28-filechanged-findings.md`.

1. **Does `FileChanged` accept `systemMessage`?** **No.** Suppressed. Verified
   against a `SessionStart` control whose `systemMessage` did surface in the
   same stream, same session, so this is specific to `FileChanged` rather than
   an artefact of headless mode.
2. **Can `FileChanged`'s matcher watch `teammate-notes.json`?** **No.** The
   matcher accepts letters, digits, `_` and `|` only. Both the literal filename
   and an underscore variant failed while a plain `notes` matched, so a name
   containing `.` or `-` cannot be watched at all.

Consequence: delivery point 1 is dashboard-only (§6), and `FileChanged` is
dropped from the hooks this feature registers. Delivery points 2–5 are
unaffected — they use documented, widely-used fields.

Residual risk: the test was headless. If the terminal line is ever revisited,
retest interactively before trusting the verdict.

---

## 12. Dependencies and branch state

This spec extends `lib/hooks-recall.js`, `lib/recall-store.js` and `lib/ledger.js`, which exist only on `claude/scale-agent-waste-corpus-53abef` — 52 commits ahead of master, unpushed, final review verdict READY TO MERGE. The spec itself is written on `claude/teammate-decision-updates-prep-fa5973`, a worktree off master.

**Implementation must not begin until the recall branch is merged**, or it will be written against files that do not exist on its own base.

---

## 13. Out of scope

Named explicitly so they are not absorbed:

- **Mid-session distillation checkpoints.** The dominant lag is that decisions are not distilled until a session stops. Distilling on `SubagentStop` or a periodic checkpoint would genuinely shorten it, and is a separate, larger piece.
- **Supabase realtime / push transport.** §2.6.
- **Feed or CLAUDE.md block redesign.** §6.
- **Conditional expiry.** §5.
- **Re-keying local ledger and recall store to repo-root-relative.** §7.
- **A distillation `affectedFiles` schema field.** `changes[].note` already provides file-keyed notes (§2.1). Revisit only if the two-highlight cap proves too narrow in practice.

---

## 14. Testing

- **Index construction** — table-driven over synthetic pulled rows: prose extraction, `byFile` grouping, eviction bounds, seen-pruning.
- **Path translation** — round-trip for tracked-dir == root, tracked-dir below root, and the mixed-format fallback.
- **Repetition rules** — prose once globally; file notes once per session per file; the seven-day re-fire boundary; catch-up brief above the cap.
- **Hook ordering** — a note serves on a cold file with no store entry; a note and a skeleton on the same read produce exactly one output.
- **Fail-open** — corrupt index, unwritable directory, missing git, and a forced throw each leave the read untouched.
- **Redaction** — a secret planted in a decision never reaches an injected payload.
- **Budget** — measured hook overhead on an index miss stays within the established budget.

Coverage target matches the existing suite (832/832 at time of writing); no new test may depend on network or a live backend.
