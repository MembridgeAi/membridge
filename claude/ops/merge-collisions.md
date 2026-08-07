# Test-suite collisions between `agent-hunt` and the fix lanes

Established 2026-08-05 by direct comparison (`git diff agent-hunt <branch> --
test/suites/`). Nothing was merged to produce this; every branch was read with
`git show`.

## Why this file exists

`agent-hunt` writes suites that PIN findings (deliberately failing). The fix
lanes write suites that PROVE the fix (passing). Several landed on the same
path independently, so a merge will present a conflict in a file where both
sides are correct about different things — and the wrong resolution ("take
theirs", "take ours") silently deletes either the finding or its fix evidence.

None of the fix branches contains any `agent-hunt` commit, so none of these
resolves by fast-forward.

## Genuine collisions — both sides exist, contents differ

| Path | Colliding branch |
|---|---|
| `test/suites/migration-state.test.js` | `agent-sec` |
| `test/suites/project-access-team-scope.test.js` | `agent-sec` |
| `test/suites/team-identity.test.js` | `agent-sec` |
| `test/suites/team-repull.test.js` | `agent-sec` |
| `test/suites/invite-lifetime.test.js` | `agent-removal` |
| `test/suites/delete-my-data.test.js` | `agent-backend2` |
| `test/suites/search-eval.test.js` | `agent-backend2` |

**CORRECTED 2026-08-05 — two claims below were wrong. See
[`merge-resolution-agent-hunt.md`](./merge-resolution-agent-hunt.md), which
supersedes this file for resolution guidance; the table above is still the
right list of files to look at.**

1. "These are UNIONS, not either/or" is too strong. Computing the real merge
   (`git merge-tree`) shows only ONE of them — `project-access-team-scope.test.js`
   — is a true union. Three are strict supersets where taking one side is
   correct and loses nothing, and `migration-state.test.js` should be resolved
   in `agent-sec`'s favour, not this branch's.
2. The list was derived from "files that differ", which is not the same as
   "files that conflict". `team-identity.test.js` and `team-repull.test.js`
   differ but auto-merge cleanly; `revocation-state-reset.test.js` conflicts
   despite having been byte-identical.

The underlying warning still stands for the one true union: merging by picking
a side loses either the finding or its evidence. It is just narrower than
stated, and the mechanical cause (`git checkout` instead of cherry-pick, so no
shared history) is now understood.

`test/suites/invite-lifetime.test.js` needs more than a union — see that file's
STATUS header. Three of its checks are built on a premise
`044_removal_rotates_invite_code.sql` removes (a plain member can read the
invite code), so they abort at their own fixture precondition against the fixed
model rather than passing or failing. Rewriting that fixture belongs to the
merge, not to either branch alone.

## The model handoff — but it still CONFLICTS (corrected)

`test/suites/revocation-state-reset.test.js`: `agent-revoke` forked from an
earlier `agent-hunt`, carried the failing checks across unchanged, and fixed
the product code underneath them. The checks go green on merge with no edit to
any assertion — that part was right and is still the shape worth copying.

What was wrong: this section originally said it "merges without conflict". It
does not. `git merge-tree` reports `add/add` on it, because the file reached
`agent-revoke` without shared history — the same import mechanism as the
`agent-sec` suites. The resolution is trivial (take `agent-hunt`: zero
non-comment differences, only an added STATUS header), but a resolution is
required, and claiming otherwise would have sent the assembler in expecting a
fast-forward.

This is the shape worth copying: the finding travels with the fix, and the
red-to-green transition is the proof the fix works. A lane that rewrites the
finding's assertions alongside its fix destroys that evidence.

## Same-numbered migrations

Not enumerated here — `agent-sec` and `agent-removal` have both been
renumbering (`chore(db): renumber ...` commits on each), and `claude/ops/` already
carries a migration ledger. Check it before assuming a number is free.
