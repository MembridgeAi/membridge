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

Resolution guidance: these are UNIONS, not either/or. The finding checks and
the fix checks assert different properties and both should survive. Merging by
picking a side is what loses one of them.

`test/suites/invite-lifetime.test.js` needs more than a union — see that file's
STATUS header. Three of its checks are built on a premise
`044_removal_rotates_invite_code.sql` removes (a plain member can read the
invite code), so they abort at their own fixture precondition against the fixed
model rather than passing or failing. Rewriting that fixture belongs to the
merge, not to either branch alone.

## Clean — byte-identical, merges without conflict

`test/suites/revocation-state-reset.test.js` is identical on `agent-hunt` and
`agent-revoke`. That lane forked from an earlier `agent-hunt`, carried the
failing checks across unchanged, and fixed the product code underneath them.
The checks go green on merge with no edit to any assertion.

This is the shape worth copying: the finding travels with the fix, and the
red-to-green transition is the proof the fix works. A lane that rewrites the
finding's assertions alongside its fix destroys that evidence.

## Same-numbered migrations

Not enumerated here — `agent-sec` and `agent-removal` have both been
renumbering (`chore(db): renumber ...` commits on each), and `claude/ops/` already
carries a migration ledger. Check it before assuming a number is free.
