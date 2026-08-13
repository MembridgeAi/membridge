# 0.4.0 — merge plan, verified 2026-08-13

Every step below was rehearsed end to end in a throwaway worktree off
`origin/master` (`a4754a3`) and came back conflict-free, then gated. Nothing has
been pushed. The rehearsal result is kept on the branch `tmp/integration-0.4.0`
if you want to inspect the finished tree before doing it yourself; delete it
afterwards.

## The order

Merge in exactly this order. The version bump is last so the tagged commit is
the one that says 0.4.0.

```bash
git checkout master && git pull --ff-only
git merge --no-ff docs/readme-honesty-and-voice
git merge --no-ff docs/reddit-research-route
git merge --no-ff fix/migration-state-035
git merge --no-ff feat/auth-screen-redesign
git merge --no-ff feat/member-identity-rename
git merge --no-ff docs/release-notes-0.4.0
git merge --no-ff chore/version-0.4.0
```

Then push, let CI run, and tag from the version-bump commit.

## What is NOT in it

- **`feat/session-area-headers` — held.** Its missing fix-wave re-review has now
  been run. It came back *keep held*, on evidence: the commit named "stop the
  area parsers losing a teammate's text" still strips any bracketed prefix
  shorter than 21 characters, so a point written `[WIP] Rate limit raised to 10s`
  renders with `[WIP]` gone, and `[#1244]` renders as a codebase-area heading the
  tag vocabulary cannot produce. A second commit states an ordering bound the
  code does not honour. Both are small and fixable; the branch is one fix wave
  from shipping.
- **`integrate/feed-rework`, `chore/consolidate-2026-08-10`** — both 37 commits
  behind master and not named in the release notes. Out of scope here; they need
  their own reconciliation before they mean anything.

## Migrations — do this by hand, in this order

`057` and `058` are already applied and both are catalog-verified. The runbook's
apply order now strikes every applied file, so what is genuinely outstanding is:

| Apply | Why it cannot wait |
|---|---|
| `059_revoke_unique_member_name_authenticated.sql` | Closes a gap that is **open in production right now** |
| `055`, `056` | Pre-existing, unrelated to this lane |

**`059` must go after `057`, never before** — it revokes on functions `057`
creates, so on a fresh database the reverse order raises.

**Do not apply `053`.** `057` supersedes it and carries its `deleted_at` change
forward. Applying `053` after `057` silently reverts `team_members_list` to a
definition without the avatar columns, and every teammate's avatar goes blank
with no error and no failing test. Its runbook row is struck for this reason.

### Why 059 exists

Verifying `057` against the live catalog turned up something the repo could not
show. Supabase's default privileges grant EXECUTE on every new public-schema
function to `authenticated`, and `057`'s revoke named only `public, anon`. So
`unique_member_name` — `security definer`, taking an unchecked team id — is
callable today by any signed-in user, letting them probe whether a display name
is taken on a team they do not belong to. `059` is two `revoke` statements.

## Verification already done

On the fully integrated tree, not on the branches separately:

| Check | Result |
|---|---|
| `migration-state` | 17/17 |
| `display-name` | 18/18 |
| `definer-function-hardening` | 8/8 |
| `audit-story` / `join-audit` / `departure-audit` | 15/15, 12/12, 10/10 |
| `cd ui && npx tsc --noEmit` | clean |
| Shell, components, IdentityDialog, SettingsPage, distill | 167/167 |
| `package.json` + `app/package.json` | both `0.4.0` |

CI is still the gate that matters — this is a local rehearsal, not a substitute
for it.

## Branches that exist only on this machine

These have **no remote branch**, so the work exists in one place:

- `feat/member-identity-rename`
- `feat/auth-screen-redesign`
- `chore/version-0.4.0`
- `feat/session-area-headers`

Worth pushing them before anything else, whatever you decide about merging.
