# Project Context System — guaranteed agent orientation across every repo

_Date: 2026-08-26 · Status: draft, awaiting Andrew's review_

## Problem

Twelve repos on this machine. One of them (`membridge`) has agent scaffolding;
one more (`aletheia`) has a bare `CLAUDE.md`; the other ten have nothing. A
fresh agent session in `aula`, `mathetes` or `salon-pitch` starts blind and
re-derives the same facts every time — which is the exact failure MemBridge
exists to fix, unfixed in Andrew's own working set.

The naive remedy is "write more docs and tell the agent to read them." That
fails for a reason worth stating precisely: **an instruction to read a file is
a request the model can decline.** Under load, or deep in a task, it will.
Anything load-bearing must be *injected*, not *requested*.

This spec defines what gets written, where it goes so that it is guaranteed to
be in context, how it keeps itself current, and how it reaches all twelve repos
without fabricating architecture for codebases nobody has read.

## Decisions made with Andrew

- **Rides on MemBridge.** Reuse its project registry and its already-global
  hooks rather than growing a second, competing aggregation layer.
- **Two-tier guidance.** Per-project skills for procedures; nested `CLAUDE.md`
  for per-directory context. Not a skill file in all 218 directories.
- **Self-improvement is hook-triggered, model-judged.** A deterministic trigger
  fires every session; the model decides whether anything durable was learned.
- **Pilot on `membridge`, propagate on touch.** Mechanism deploys everywhere
  immediately; content is authored per-repo by an agent that has read the code.

## The injection model (verified, not assumed)

Every claim below was tested from inside a live session on 2026-08-26, by
observing what was and was not present in the context window.

| Tier | Channel | Lands | Model choice |
|---|---|---|---|
| **1** | `~/.claude/CLAUDE.md`, `<proj>/CLAUDE.md`, `<proj>/.claude/rules/*.md`, SessionStart hook stdout, `MEMORY.md` | Before the first generated token | **None** |
| **2** | nested `<dir>/CLAUDE.md` | The instant any file in that subtree is read | **None** |
| **3** | Skill bodies | Only when the model elects to invoke | Discretionary |
| **4** | "Also read `ARCHITECTURE.md`" clauses | Only on compliance | Discretionary |

Evidence for tier 1: all three of `membridge/.claude/rules/*.md` were present
in context, labelled "project instructions", with no `@`-import anywhere in
`CLAUDE.md` — the harness auto-loads that directory.

Evidence for tier 2: `docs/agent-team/CLAUDE.md` was **absent** at session
start; reading one unrelated `.js` file in that directory caused all 9,401
bytes of it to be injected automatically, as a system message.

Evidence for tier 3 cost: the `team` skill carries a 24,271-byte body that
costs 504 bytes of description while idle — a 48x compression for knowledge
that is not needed this session.

**Design consequence.** Tier 1 is scarce and is spent on orientation only.
Tier 2 is the workhorse: deterministic like tier 1, lazy like a skill. Tier 3
is for genuine procedures. Nothing load-bearing is ever placed in tier 4.

### The budget

Tier 1 is charged to every session in a repo whether or not it is relevant.
`membridge` currently spends ~2,500 tokens of it on three rules files,
including a Reddit-research procedure needed perhaps monthly.

**Hard cap: `.claude/rules/` totals <= 1,500 tokens per project**, enforced by
the audit skill (below). Content that does not fit is not important enough to
be always-on and belongs in tier 2 or 3. This makes the system a net *reduction*
in per-session context for `membridge`, not an addition.

## Artifacts

Per project:

```
<project>/
  CLAUDE.md                     tier 1 — MemBridge owns between its markers.
                                We never write inside them. Nothing we add here.
  ARCHITECTURE.md               human-facing depth. Named by orientation.md so
                                an agent needing detail knows it exists.
  .claude/
    rules/
      orientation.md            tier 1, <= ~40 lines. What this project is, its
                                landmines, where things live, what to run.
                                THIS is the pre-existing injection.
    skills/
      run/SKILL.md              tier 3 — start it locally
      debug/SKILL.md            tier 3 — diagnose it
      deploy/SKILL.md           tier 3 — ship it
      test/SKILL.md             tier 3 — only if the repo has a real gate
  <dir>/CLAUDE.md               tier 2 — one per major source directory
```

Machine-readable coverage manifest at `.claude/context-manifest.json`:

```json
{
  "version": 1,
  "scaffoldedAt": "2026-08-26T00:00:00Z",
  "tier1TokenBudget": 1500,
  "covered": ["lib", "ui", "test", "supabase"],
  "skills": ["run", "debug", "deploy", "test"],
  "contentStatus": { "lib": "authored", "ui": "stub", "test": "stub" }
}
```

`contentStatus` is what makes "automatic everywhere" honest: a `stub` is a
scaffolded file that says, in as many words, *nobody has read this directory
yet*. It never pretends to knowledge it lacks.

## Scoping: all twelve repos

Surveyed 2026-08-26. Directory counts are depth <= 3, excluding
`node_modules`, `.git`, build output and worktrees.

| Project | Stack | Dirs | Entry / scripts | Scope |
|---|---|---|---|---|
| `membridge/membridge` | Node + React | 80 | `bin/membridge.js`, `test/run.js` | **Full** |
| `Desktop/aula` | Node | 26 | `dev, web, test, replay, typecheck` | **Full** |
| `Desktop/mathetes` | Python | 20 | `app.py`, has `deploy/` | **Full** |
| `Desktop/aletheia` | Python | 19 | `capture/fusion/scoring/simulate` | **Full** |
| `command-center` | Node | 15 | `server.js`, has `deploy/`, `test/` | **Full** |
| `Desktop/legal-rags` | Python | 15 | `main.py`, `index_store/` | **Full** |
| `Documents/salon-pitch` | Node + Prisma | 13 | 14 scripts, a real CLI pipeline | **Full** |
| `Desktop/adblock` | Node | 11 | `fetch, build, test, test:e2e` | **Full** |
| `membridge/membridge-site` | Static | 7 | content dirs only | Minimal |
| `agent-board` | Node | 6 | `server.js`, `start` | Minimal |
| `Desktop/watchfloor` | Node + Express | 4 | `app.js`, `server.js` | Minimal |
| `Desktop/ryple` | Python | 2 | `sources/` only | Minimal |

**Full scope** — orientation.md, ARCHITECTURE.md, nested `CLAUDE.md` per major source
directory, and the skills the repo can actually support.

**Minimal scope** — orientation.md and a `run` skill. Nested `CLAUDE.md` per directory
is overhead on a repo with four directories; the orientation file covers it.

Skills are only scaffolded where the underlying capability exists. `ryple` has
no tests, so it gets no `test` skill — a skill that documents a command nobody
can run is worse than its absence. The scaffolder reads `package.json` scripts,
`requirements.txt`, and the presence of `deploy/` and `tests/` to decide.

## The self-improvement loop

### Why it cannot modify MemBridge's hook

MemBridge's Stop hook is product code, regenerated by `membridge setup-hooks`.
Any edit is destroyed on the next run. It also *blocks the stop* to request a
checkpoint; a second blocking Stop hook would compound with a loop guard never
designed for a peer.

So: a **sibling, non-blocking** Stop hook, registered as a second entry in the
`Stop` array of `~/.claude/settings.json`. It never blocks, never interferes,
and survives `setup-hooks` untouched.

### Queue and drain

```
Session ends
  └─ Stop hook (sibling, non-blocking, exit 0 always)
       └─ appends a candidate to ~/.claude/context-findings.jsonl
            { ts, project, session, text, suggestedTarget }

Next session in that project
  └─ SessionStart surfaces: "3 pending context findings for <project> — file them?"
       └─ the agent routes each with full judgement:
            procedure          -> the relevant skill
            architectural fact -> ARCHITECTURE.md
            directory landmine -> that directory's CLAUDE.md
```

Blocking is free at session *start* and expensive at session *end*, so
judgement is preserved without a second end-of-session block. The queue is
durable, so a finding survives a crashed session.

Every appended line carries its date. Staleness becomes visible rather than
silent — the same provenance discipline MemBridge already applies to memory.

### What counts as a finding

Only durable operational knowledge: a non-obvious command, a landmine, a
failure mode and its diagnosis, a corrected architectural claim. Explicitly
**not** what the session did — MemBridge already records that, and duplicating
it is how the docs fill with noise and stop being read.

## The registry

`~/projects/INDEX.md`, generated by a `project-registry` skill, never
hand-edited. Sourced from MemBridge's project list plus a filesystem scan.

Columns: project, path, stack, one-line purpose, MemBridge-tracked, doc
coverage (from each `context-manifest.json`), last activity.

**Pointers, never copies.** A copy of an architecture doc is stale the moment
the source changes. A pointer can only be wrong about membership, which
regeneration fixes.

Turning on MemBridge capture for the other ten repos (`membridge track`) is
part of this work: the registry's "last activity" column is only real if
capture is on, and it is currently on for two of twelve.

## Anti-staleness

A `context-audit` skill, run on demand, asserts the guarantees rather than
trusting them:

1. **Coverage** — every directory listed in `covered` still exists and still
   has a `CLAUDE.md`.
2. **Budget** — `.claude/rules/` is under the tier-1 token cap.
3. **Claim liveness** — every shell command quoted in a skill resolves; every
   file path referenced still exists; every named function is still present.
4. **Stub inventory** — how many directories are still `stub`, so partial
   coverage is never mistaken for complete coverage.

Doc systems die because nobody notices they have started lying. This makes
lying detectable in one command.

## Propagation to all twelve

A `scaffold-context` skill, invoked per repo. It is the same operation
everywhere, which is why it can be automatic:

1. Read `package.json` / `requirements.txt` / directory shape.
2. Write `orientation.md` from **verifiable** facts only — stack, entry points,
   real scripts, test command. No invented architecture.
3. Create nested `CLAUDE.md` stubs for each major source directory, each
   explicitly marked as unread.
4. Write `context-manifest.json` with everything marked `stub`.
5. Scaffold only the skills the repo can support.

Then, on touch: the SessionStart drain notices `contentStatus` is `stub` for a
directory the session is working in, and offers to author it — by an agent that
has just read that code. This is how the content becomes real without anyone
writing twelve architecture documents from a shallow skim.

**The split that makes "automatic" safe:** mechanism deploys to all twelve on
day one; content is earned per-directory, and its absence is always visible.

## Rollout

**Phase 1 — prove it here.** `membridge` gets the full treatment by hand:
`orientation.md` (migrating `agent-team.md` down to <= 1,500 tokens),
`ARCHITECTURE.md`, nested `CLAUDE.md` for `lib/`, `ui/`, `test/`, `supabase/`,
and the four skills. `testing.md`'s per-area table moves to `test/CLAUDE.md`,
where it fires automatically on touch; `research.md`'s procedure moves to a
skill. The one-line "never run the full suite" prohibition stays in tier 1.

**Phase 2 — the machinery.** Sibling Stop hook, the findings queue, the
SessionStart drain, `context-audit`, `project-registry`, `scaffold-context`.

**Phase 3 — everywhere.** Run `scaffold-context` across the other eleven.
`membridge track` on the ten untracked repos. Generate `~/projects/INDEX.md`.

**Phase 4 — earn the content.** Stubs are filled as Andrew works in each repo.
No deadline; the audit reports the stub count so progress is legible.

## Verification

The prose is not machine-checkable, but every mechanism is:

| # | Claim | Test |
|---|---|---|
| V1 | The sibling hook never blocks | Scripted session ends; assert exit 0, no block, MemBridge's own capture unaffected |
| V2 | Findings reach the queue | Session that learns something appends exactly one JSONL line with the right project key |
| V3 | The drain surfaces them | Next SessionStart in that project reports the pending count |
| V4 | Routing lands correctly | A planted procedural finding ends in the skill, not `ARCHITECTURE.md` |
| V5 | Audit catches lies | Plant a false command in a skill; assert non-zero exit |
| V6 | Budget is enforced | Push `.claude/rules/` over 1,500 tokens; assert failure |
| V7 | Tier 2 actually fires | Read one file in a scaffolded directory; assert its `CLAUDE.md` is injected |
| V8 | `setup-hooks` survivability | Run `membridge setup-hooks`; assert the sibling hook is still registered |

V8 is the one most likely to fail in practice and the cheapest to regress on.

## Risks

- **The hooks execute a stale MemBridge build.** All four global hooks point at
  the `0.4.0` app bundle while the source tree is `0.4.1`, and capture has been
  idle since 2026-08-13. This system inherits that. Rebuilding the app and
  re-running `setup-hooks` is a prerequisite for Phase 2, not part of it.
- **Turning on capture in ten repos writes MemBridge blocks into their
  `CLAUDE.md` files.** That is a visible, committed change to repos Andrew may
  not want touched. Per-repo opt-in, not a blanket sweep.
- **Three MemBridge daemons are currently running against one unlocked
  `state.json`**, producing an endless block-recipe re-render loop. Any work
  that depends on MemBridge state should not begin until that is resolved.
- **Tier 2 fires on touch, not at session start.** A session that reasons about
  `lib/` without reading a file in it gets no injection. Orientation must
  therefore carry the cross-cutting landmines itself, not delegate them.

## Out of scope

- Rewriting MemBridge's own hook or capture pipeline.
- Any change inside MemBridge's `CLAUDE.md` markers.
- Generating architecture documentation for repos nobody has read. Stubs only.
- Roadmap, planning or BYOK features — cut from the product on purpose.
