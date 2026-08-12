# Member identity: self-rename and pickable avatars

**Date:** 2026-08-12
**Status:** approved, ready for planning

## Problem

A person's display name is set once — at signup, login or join — and there is no
way to change it afterwards. It is whatever `sessionToCredentials` derived, which
for an OAuth user with no metadata is the local part of their email address.

Nothing stops two members of the same team carrying the same name. `team_members`
is keyed `(team_id, user_id)` and `display_name` has only a 1..80 length check
(`supabase/schema.sql:20`). Two people called `marco` make the feed, the members
list and every avatar row ambiguous, and the product's entire job is making it
legible who knew what.

Avatars today are an initial on a colour derived from the user id
(`ui/src/components/Avatar.tsx`). Two people whose names start with the same
letter are distinguished only by hue.

## What we are building

1. Double-clicking your name in the rail footer opens an editor for your display
   name and your avatar.
2. A name must be unique within each team you belong to. Taking a name someone
   else holds is refused with an error naming the clash.
3. A small set of pickable avatar marks, chosen in the same editor, visible to
   teammates.

## Decisions

Each of these was asked and answered; they are recorded here because the
reasoning is not recoverable from the diff.

| Decision | Choice | Why |
|---|---|---|
| History | **Leave alone** | Entries carry a frozen `author_name` stamped at push time (`lib/teamsync.js:1037`). Renaming does not rewrite it. Accepted cost: the Feed shows old entries under the old name. |
| Scope | **All teams at once** | The rail footer is global chrome, not a team-scoped surface. One identity per person. |
| Uniqueness | **Case- and space-insensitive** | `Marco`, `marco`, `marco ` and `Marco  B` vs `Marco B` all collide. Byte-exact matching permits exactly the confusion the rule exists to stop. |
| Enforcement | **DB unique index + RPC** | The database arbitrates the race, the all-teams update is atomic for free, and the invariant survives clients that do not know about it. |
| Affordance | **Double-click + keyboard** | Double-click as asked, plus Enter on a focused control. Double-click alone is invisible and unreachable without a mouse. |
| Join collision | **Silent auto-suffix** | A joiner is often at a CLI with no input box and their name comes from local credentials. Rejecting the join is a dead end at onboarding. Rename still errors, because there the person *is* looking at an input box. |
| Deleted accounts | **Reserved 10 days, then reusable** | Deletion sets `auth.users.deleted_at` and leaves the member row (`053:35`), so without this a departed teammate's name is locked up forever. |
| Avatar storage | **Column on `team_members`, all teams** | Same RPC, same editor, same scope as the name. Not unique — two people may pick the same mark. |
| Avatar art | **One SVG sprite sheet, supplied by Andrew** | Plumbing ships now against placeholder marks; the real file is a drop-in replacement. |
| Audit | **Record `member-renamed`** | The only record that explains why a familiar name became an unfamiliar one. |

## Architecture

### 1. Migration `057_member_identity.sql`

One migration, not two. The internal ordering is load-bearing: if the unique
index existed before the join paths knew how to auto-suffix, every colliding
join would hard-fail. That window must not exist, and two migrations create it.

Sections in order:

1. **`normalize_member_name(text)`** — `lower(regexp_replace(btrim(coalesce(t,'')), '\s+', ' ', 'g'))`,
   declared `immutable` so it can be used in an index.
2. **Columns** on `team_members`:
   - `avatar text` — null means "use the initial". `check (avatar is null or avatar ~ '^[a-z0-9-]{1,32}$')`.
     The server validates *shape* only; it cannot know which keys the client's
     sprite contains.
   - `name_released_at timestamptz` — null means "this name is protected".
3. **`unique_member_name(p_team, p_name)`** — trims its argument, then returns
   it if free in that team, else `p_name 2`, `p_name 3`, … truncating the base
   so the suffix fits inside 80 characters. Freeness is tested through
   `normalize_member_name` against rows with `name_released_at is null`, the
   same predicate the index uses, so the helper and the constraint can never
   disagree about what "taken" means.
4. **Rewrite the four insert paths** to call it: `create_team`, `join_team`,
   `redeem_invite`, `redeem_onboarding_invite`. Each insert sits in a bounded
   retry loop (5 attempts) — two simultaneous joins can both compute `marco 2`,
   and without the retry the index reintroduces the dead end this avoids.
5. **Pre-release legacy duplicates** — stamp `name_released_at = now()` on all
   but the earliest joiner of any existing duplicate group. Production had zero
   duplicates when this was written, but one appearing before the apply would
   fail index creation and kill the migration. Non-destructive: the later joiner
   keeps their name, it is merely unprotected.
6. **The index**:
   ```sql
   create unique index team_members_display_name_unique
     on public.team_members (team_id, public.normalize_member_name(display_name))
     where name_released_at is null;
   ```
   Partial on `name_released_at is null` because a predicate must be immutable —
   `deleted_at > now() - interval '10 days'` cannot appear in one, so the grace
   period is expressed by a column the RPC stamps rather than by the predicate.
7. **`set_display_name(p_name, p_avatar)`** — see below.

All new functions follow `042_definer_function_hardening.sql`: pin
`set search_path`, `revoke execute from public, anon`, `grant execute to authenticated`.

### 2. `set_display_name(p_name text, p_avatar text)`

`security definer`, returns the values actually written.

1. Trim; reject length outside 1..80 with a distinct error code.
2. **Lazy release.** Any row colliding with the requested name whose owning
   account has `deleted_at < now() - interval '10 days'` gets
   `name_released_at = now()`, in this same transaction. No cron job, and the
   departed person's `display_name` is preserved for the roster.
3. **Pre-check** for a collision, purely to build a good message naming the team
   and the holder. It is not the enforcement mechanism.
4. **`update team_members set display_name = ..., avatar = p_avatar where user_id = auth.uid()`**
   — a single statement, so all-teams is atomic without explicit transaction
   management, and a collision in any one team rolls back every team.

   `p_avatar` is assigned directly, **not** `coalesce(p_avatar, avatar)`. The
   editor always submits both fields together, and null is a meaningful value:
   it is the "no mark, use my initial" choice. Coalescing would make that choice
   unexpressible — you could pick an avatar but never take it off.
5. **Catch `unique_violation`** and raise the same collision error. This is the
   path two simultaneous claims actually take; the index is the arbiter.

Both collision raises use a dedicated `errcode = 'MB001'`. The daemon maps that
one code to HTTP 409, so rewording the message can never break the mapping.

Zero rows updated is not an error — it is the signed-in-with-no-team case.

### 3. Daemon and HTTP

`teamsync.setDisplayName(config, name, avatar)`:

- Calls the RPC, and writes `credentials.json` **only after it succeeds**. This
  is the exact location of this repo's characteristic bug — a fail-open path plus
  an unconditional success flag — so the local write must be unreachable from
  every error branch. A machine that believes it renamed itself keeps stamping a
  name the server rejected onto every entry it pushes.
- Stores the server's returned values, not the requested ones, so a trim on the
  server cannot desynchronise the two.

`sessionToCredentials` must carry `avatar` across login and refresh the way it
already carries `displayName` (`lib/teamsync.js:209`), or a token refresh
silently drops the avatar.

`POST /api/team/set-display-name` — 400 on empty or overlong, **409 on
collision**, 200 with `{ displayName, avatar }`. Records a `member-renamed`
audit row via the existing `apiAccess.recordAudit`, carrying old and new name.

`GET /api/team` returns `avatar` alongside `displayName` (`lib/server.js:2813`).

### 4. UI

**Shell.** `rail-identity` (`ui/src/app/Shell.tsx:218`) becomes
`role="button" tabIndex={0}` with `onDoubleClick` and an Enter/Space key handler.
Deliberately not a real `<button>`, which would activate on single click. A
`title` states that double-clicking renames.

**Editor.** The existing `FormDialog` + `useDialogFocus`, holding a name input
and the avatar picker, saved in one call. A 409 renders inline beneath the input
with the dialog open and the typed text intact. Success invalidates the account
and roster queries so the rail and the Members list both relabel.

**DataClient.** `setDisplayName(name, avatar)` added to the interface,
`LocalDaemonClient` and `FakeDataClient`.

### 5. Avatar rendering — no call-site churn

`Avatar` is used at 14 sites and none of them change. It already receives `id`,
so a context provider mounted once in `Shell` publishes an `id → avatar` map
built from the roster query the app already runs, and `Avatar` looks itself up.
Tests that render `Avatar` with no provider get an empty map and fall back to
the initial, which is today's behaviour.

**Sprite contract.** `ui/src/assets/avatars.svg`, injected once at app root. One
`<symbol id="mb-avatar-<key>" viewBox="0 0 24 24">` per mark, paths using
`fill="currentColor"` so the existing per-person palette tints them. Marks must
stay legible at 16px, the smallest current usage. Roughly 8 crude placeholder
marks ship with this work; Andrew's file replaces it and nothing else changes.

**Unknown keys fall back to the initial** — the case where a teammate on a newer
build picked a mark this build's sprite does not contain.

## Edge cases

| Case | Behaviour |
|---|---|
| Rename to your own name, different case | Allowed; same row, so the index sees no conflict |
| Signed in, no team yet | No member rows; local credentials only, uniqueness vacuous |
| Free in two teams, taken in a third | Whole rename fails; error names the team |
| Two people claim one name simultaneously | Index decides; loser gets 409 |
| Member left or was removed | Row gone, name immediately free |
| Account soft-deleted < 10 days | Name still reserved |
| Account soft-deleted > 10 days | Released lazily on next attempt; `display_name` preserved |
| Name trims to empty | 400 before any network call |
| Name longer than 80 chars | 400 before any network call |
| Two people join at once as the same name | Retry loop; second becomes `marco 3` |
| Joiner's name already taken | Silently becomes `marco 2`; they are not told |
| Daemon offline | Rename fails visibly; `credentials.json` untouched |
| Signed out | Footer shows Sign in; no editor |
| Teammate picks a mark absent from this build's sprite | Falls back to the initial |

## Accepted costs

Recorded so they are not later mistaken for defects:

1. **The Feed shows your new avatar beside your old name** on entries pushed
   before the rename. Avatars are read live from the roster; `author_name` is
   frozen. This follows from the decision to leave history alone.
2. **A silent auto-suffix** means a person can be `marco 2` without knowing why
   until they open the editor.
3. **A legacy duplicate name is unprotected**, not corrected — the pre-release
   step frees the index without touching anyone's name.

## Non-goals

- Rewriting `author_name` on existing entries.
- Uploading custom avatar images. The set is fixed and bundled.
- Uniqueness of avatars. Two people may pick the same mark.
- Renaming anyone other than yourself. Admin-renames-member is a separate ask.

## Verification

Per `.claude/rules/testing.md`, only what is touched:

| Area | Command |
|---|---|
| React app | `cd ui && npx tsc --noEmit`, then `npx vitest run` on `Shell.test.tsx`, `components.test.tsx` and the new identity-editor test |
| Daemon / teamsync | `node test/run.js display-name` (new suite in `test/suites/`) |
| Migration | No local run; carries a documented "verify after applying" block per `053` |

No test failure is filed or fixed before `node scripts/verify-finding.js`
returns CONFIRMED.
