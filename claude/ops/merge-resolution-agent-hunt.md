# Merging `agent-hunt`: the resolution, file by file

Written 2026-08-05 by the lane that authored the conflicting suites. Computed
with `git merge-tree` (pure computation — nothing was merged, checked out, or
pushed to produce this).

**Headline: no conflict here is a disagreement about correct behaviour.** Every
one is either a strict superset or a union of complementary content. Where one
side should simply be taken, this says so — `merge-collisions.md` previously
implied all seven were unions, and that was wrong.

## The mechanical cause, and why it hid

The security lane imported four suites with `git checkout agent-hunt -- <file>`
rather than cherry-picking. A file copied that way carries **no shared
history**, so git cannot three-way merge it and reports `add/add` even when one
side is a byte-identical superset. The conflict existed from the moment of
import and stayed invisible because nobody had merged this branch.

Consequence worth noting: the imported copies are **frozen at import time**.
`project-access-team-scope.test.js` is the case where that matters — see below.

## Conflict inventory

> **Status correction, 2026-08-05 (late).** An earlier version of this round's
> handoff listed the `files` / `changes[].file` wire leak as the one finding no
> lane had closed. That was wrong: `agent-backend2` closed it in `340647d`, and
> the branch had moved since the ref this lane read. Verified after the fact by
> substituting that branch's `lib/teamsync.js` and running the suite — 18/18,
> all five pinned checks green. See the header of
> `test/suites/wire-redaction.test.js` for the mechanism and the correction.
>
> Only ONE finding from this lane remains genuinely open: the `project_access`
> read side (`can_see_project` has no team scope), plus the existing-rows check
> beside it.

| Target | Conflicts |
|---|---|
| `master` | **none** — `agent-hunt` merges to master clean |
| `agent-backend2` | **none** |
| `agent-revoke` | 1 (`revocation-state-reset.test.js`) |
| `agent-removal` | 1 (`invite-lifetime.test.js`) |
| `agent-sec` | 9 — 4 suites, `MIGRATION-STATE.md`, `cloudflare/README.md`, migrations 031–034 |

## The five `add/add` suites

### 1. `ops-api-auth.test.js` — TAKE `agent-hunt`
Strict superset. Same 10 checks, **zero non-comment differences**. The only
delta is a 10-line STATUS header recording that the allowlist fix lives on
`agent-sec` e538edf. Nothing of theirs is lost.

### 2. `rls-guardrail.test.js` — TAKE `agent-hunt`
Same: 3 checks, **zero non-comment differences**, plus a 9-line STATUS header
pointing at `agent-sec` 8cd3f6f.

### 3. `revocation-state-reset.test.js` — TAKE `agent-hunt`
Same again: **zero non-comment differences**, plus a STATUS header. Note this
one still conflicts as `add/add` despite having been byte-identical until I
added that header — the no-shared-history mechanism, not divergence.

### 4. `migration-state.test.js` — TAKE `agent-sec`
**The one case where picking a side is correct, and it is not my side.**
`agent-sec` has all 6 of this branch's checks plus 6 more (registry
number-uniqueness, apply-order coverage, dated reconstruction evidence). The
single non-comment line unique to `agent-hunt` — `const ghosts = [...]` — is
superseded: they rewrote that same check to tolerate an `applied (other
branch)` qualifier, which is a real refinement for exactly this multi-lane
situation. Taking theirs loses nothing.

### 5. `project-access-team-scope.test.js` — UNION, and **read this one carefully**

Genuinely diverged, and the frozen-copy problem bites here.

- Only on `agent-hunt`: `can_see_project resolves a project_access row within
  the project's own team` (the read-side finding — **still open**, verified
  against their branch) and `rows already in project_access are addressed, not
  just future writes`.
- Only on `agent-sec`: `a project_access row cannot settle access for a project
  outside its own team` (their fix-proving check). **Keep it.**
- Shared by name, **different by implementation**: `a project_access write
  cannot name a project outside its own team`.

**Take this branch's implementation of the shared check.** Their copy is the
pre-tightening version, which accepts `policyScopes = [insert, update].filter(p
=> /project_key/i.test(p.sql))` — satisfied by `and project_access.project_key
is not null`, a policy that names the column and correlates nothing. This
branch replaced that with `policyCorrelatesProjectToTeam()`, which requires the
policy to reach `public.projects` and tie **both** columns, and proved by decoy
that the cosmetic version is rejected. Resolving in their favour silently
reinstates a check that passes on a fix that does not work.

Union = their new check + this branch's two + this branch's tightened
implementation of the shared one + `policyCorrelatesProjectToTeam` and
`existingRowsAddressed` helpers. Result should be 6 checks.

### 6. `invite-lifetime.test.js` — TAKE `agent-removal`

Not on the five, but it conflicts and the answer is unambiguous.

They already solved the fixture problem this branch's STATUS header flagged as
"belongs to the merge". `044` makes `my_teams()` return a null `invite_code` to
non-managers, which kills the premise of three checks here (a plain member
reads the code, then reuses it after removal). Their version reads the code
**through the owner**, with the rationale recorded: closing the member-side
read narrows how a member *obtains* the code, it does not retract a copy they
already hold — and the member-side read returning null is pinned separately in
`removal-durability.test.js` with the opposite expectation.

They also merged two of this branch's checks into one that is strictly
stronger: it asserts the `member-joined` count is exactly 1, which is failable
in both directions (0 = the join was never audited; 2 = a re-join was recorded).

The only thing lost is this branch's STATUS header prose, which is now
**obsolete** — it says the fixture rewrite is outstanding, and it isn't.

## Migrations 031–034 — union, and the two lanes need each other

Both lanes independently deleted the same stale `UNAPPLIED AS OF THIS COMMIT`
marker and replaced it with a dated `APPLIED` claim. **They agree on every
fact** — same status, same date. What differs is what each kept.

- `agent-sec` contributes the **form**: `APPLIED — LIVE. Verified against the
  running database on <date>, in the audit that also confirmed ...`, quoting the
  previous text and cross-referencing the sibling migrations. Prefer this
  wording — the ledger gate enforces the convention mechanically.
- `agent-hunt` contributes the **evidence**: for 032, 033 and 034 it carries the
  settling query and the result it returned (`pg_get_triggerdef`, `pg_policy`,
  `pg_indexes`), plus the project id. **`agent-sec` drops the query from all
  three.** That is the loss to avoid: the query is what makes the claim
  re-checkable rather than merely re-asserted.

The two conventions converge rather than compete — `agent-sec`'s own
dated-evidence gate *requires* a catalog query (`pg_get_functiondef`,
`pg_policy`, `pg_trigger`, `information_schema`) next to a date, and this
branch's headers are what supply it.

Per file:

- **031** — take `agent-sec` wholesale. Both added an identical first paragraph
  (their copy came from here), then they added the `LIVE SHAPE VERIFIED
  2026-08-05` named marker the gate looks for, **and fixed differences 2 and 3
  in the SQL**, which this branch only documented as outstanding. Strictly ahead.
- **032** — their status line + this branch's `pg_get_triggerdef` query and its
  returned trigger definition.
- **033** — their status line *and* their DELETE-policy correction (additive,
  not present here) + this branch's `pg_policy` query and the observed
  `AND can_see_project(project_id)` result.
- **034** — their status line + this branch's `pg_indexes` query, the observed
  `INCLUDE (can_see)` index definition, and the `WHAT THIS COMMIT COULD NOT
  DEMONSTRATE` caveat, which they do not carry.

## Not a conflict, but correct the record

`agent-hunt` is **not test-only** — it carries ~790 changed lines across
`lib/digest.js`, `lib/feed.js`, `lib/server.js`, `lib/team-archive.js` and
`lib/teamsync.js`. None of it is from the security-audit work: it is inherited
feature work already merged into this branch (`feat(daemon): per-day digest,
self-serve deletion, and an instant-keyed feed dedupe`, `fix/digest-statement-quality`).
It auto-merges against every sibling lane and conflicts with none, and
`agent-hunt` merges to `master` with no conflicts at all. The audit commits
themselves touch only `test/` and `claude/ops/`.
