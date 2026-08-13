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
| Avatar storage | **Two columns on `team_members`, all teams** | `avatar` (glyph key) and `avatar_color` (a second, independent choice). Same RPC, same editor, same scope as the name. Neither is unique — two people may pick the same glyph, the same color, or both. |
| Avatar art | **A React component, glyph and color chosen independently** | Superseded the original SVG-sprite-sheet plan (see Architecture §5). Andrew delivered 15 stroked glyphs; color is a separate pick from 10 token colors, giving 150 combinations from one component instead of one sprite sheet Andrew would need to hand-draw combinations into. |
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
     The server validates *shape* only; it cannot know which glyph keys the
     client's `AvatarGlyph` component actually recognises (§5).
   - `avatar_color text` — a second, independent choice (glyph × color; see
     §5 and the Decisions table). Null means "use the color `colorForId`
     already derives from my user id" — the same shape as null `avatar`, and
     for the same reason: a caller must be able to say "go back to my
     derived color" as an explicit act, not merely by omitting the field.
     `check (avatar_color is null or avatar_color ~ '^#[0-9A-Fa-f]{6}$')`.
   - `name_released_at timestamptz` — null means "this name is protected".
3. **`unique_member_name(p_team, p_name)`** — trims its argument, then returns
   it if free in that team, else `p_name 2`, `p_name 3`, … truncating the base
   so the suffix fits inside 80 characters. Freeness is tested through
   `normalize_member_name` against rows with `name_released_at is null`, the
   same predicate the index uses, so the helper and the constraint can never
   disagree about what "taken" means.
4. **A single `before insert` trigger on `team_members`**, not a rewrite of the
   four insert paths. The trigger (`team_members_dedupe_name`) calls
   `unique_member_name` on every row before it lands, so `create_team`,
   `join_team`, `redeem_invite`, `redeem_onboarding_invite` — and anything
   added later — are covered automatically, with no insert site needing to
   know the suffixing rule. This is a deviation from the original plan to
   rewrite each of the four RPCs individually; the trigger was chosen instead
   because it cannot be forgotten by a future insert path the way a per-RPC
   convention can.

   **The residual this accepts.** Two people joining the same team with the
   same name at the same instant both fire the trigger before either
   transaction commits, so both could compute the same suffix (`marco 2`) and
   the second's insert would then collide on the unique index. This is closed
   by a per-team advisory lock taken inside `unique_member_name`
   (`pg_advisory_xact_lock`, keyed on the team id): every insert into that
   team's roster serializes on name assignment, so the second joiner's
   trigger blocks until the first commits, then computes `marco 3` against
   the now-committed roster instead of colliding. The lock is
   transaction-scoped and releases automatically at commit or rollback.
   `set_display_name` (an existing member renaming) takes the same per-team
   lock before it writes, for the same reason from the other direction — a
   rename committing between a joiner's not-exists probe and its insert would
   otherwise reopen the identical race. See `057_member_identity.sql`'s
   header for the full mechanics, including why the lock order across
   multiple teams has to be `order by team_id` rather than arbitrary.
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
7. **`set_display_name(p_name, p_avatar, p_avatar_color)`** — see below,
   including the per-team advisory lock it also takes and the audit rows it
   writes.

All new functions pin `set search_path`. For the two functions actually meant
to be called directly by a client (`set_display_name`, `team_members_list`),
grants follow 042's pattern: `revoke execute from public, anon`, `grant
execute to authenticated`.

**`revoke ... from public, anon` alone does not make a function private.**
Supabase's own default privileges separately grant `authenticated` EXECUTE on
every newly created public-schema function, independently of anything this
repo's migrations write — so a function revoked only from `public, anon` is
still callable by any signed-in user holding a session token. `057` got this
half right for the two internal helpers below, `unique_member_name` and
`team_members_dedupe_name`: it revoked `public, anon` but never named
`authenticated`, and neither should be directly callable —
`unique_member_name` takes a caller-supplied, unchecked team id (by design,
for the join-time case where the caller is not yet a member) and
`team_members_dedupe_name` is a trigger function meant to fire only on
`INSERT`. The gap that left in production, and the migration that actually
closes it, is `059_revoke_unique_member_name_authenticated.sql` — read its
header for the worked example: **a function that must not be
caller-invocable needs `revoke execute ... from authenticated` too, with no
replacement grant**, not just `from public, anon`.

### 2. `set_display_name(p_name text, p_avatar text, p_avatar_color text)`

`security definer`, returns the values actually written.

1. Trim; reject length outside 1..80 with a distinct error code (`MB002`).
   Reject an `avatar` or `avatar_color` that fails the same shape checks the
   columns carry (§1.2), also `MB002`.
2. **Lazy release.** Any row colliding with the requested name whose owning
   account has `deleted_at < now() - interval '10 days'` gets
   `name_released_at = now()`, in this same transaction. No cron job, and the
   departed person's `display_name` is preserved for the roster.
3. **Pre-check** for a collision, purely to build a good message naming the team
   and the holder. It is not the enforcement mechanism.
4. **Per-team advisory lock**, taken for every team the caller belongs to,
   `order by team_id`. This is the same `pg_advisory_xact_lock` mechanism
   `unique_member_name` takes on the insert side (§1.4's residual note) —
   without it here, a rename could commit between a concurrent joiner's
   not-exists probe and that joiner's insert, reopening the identical race
   from the other direction. The `order by team_id` is load-bearing, not
   decoration: two callers each locking the same two teams in different
   orders is the textbook lock-ordering deadlock, and sorting by team id
   gives every caller — rename or join — the same order regardless of which
   teams they happen to touch.
5. **`update team_members set display_name = ..., avatar = p_avatar,
   avatar_color = p_avatar_color, name_released_at = null where user_id =
   auth.uid() returning team_id, display_name, avatar, avatar_color`** — one
   statement, so all-teams is atomic without explicit transaction
   management, and a collision in any one team rolls back every team.

   `p_avatar` and `p_avatar_color` are assigned directly, **not**
   `coalesce(p_avatar, avatar)`. The editor always submits every field
   together, and null is a meaningful value for both: "no mark, use my
   initial" and "no color, use my derived color". Coalescing would make
   those choices unexpressible — you could pick an avatar but never take it
   off.
6. **One `member-renamed` audit row per team touched**, written inside this
   same transaction rather than by the daemon — see §3 for why. The UPDATE's
   `returning` output is consumed by a `for ... in ... loop`, not a bare
   `into`, specifically because every returned row is also a team this
   rename must be audited against, and PL/pgSQL's bare `into` silently
   keeps only the first row when several match. Each iteration inserts one
   `team_audit` row, carrying that team's old name (snapshotted from
   `team_members` immediately before the UPDATE, while the locks from step 4
   are already held, since it is the only remaining moment the pre-rename
   name still exists) and new name.
7. **Catch `unique_violation`** and raise the same collision error. This is the
   path two simultaneous claims actually take; the index is the arbiter.

Both collision raises use a dedicated `errcode = 'MB001'`. The daemon maps that
one code to HTTP 409, so rewording the message can never break the mapping.

Zero rows updated is not an error — it is the signed-in-with-no-team case,
and correctly writes no audit rows either, since there is no team to file
one against.

### 3. Daemon and HTTP

`teamsync.setDisplayName(config, name, avatar, avatarColor)`:

- Calls the RPC, and writes `credentials.json` **only after it succeeds**. This
  is the exact location of this repo's characteristic bug — a fail-open path plus
  an unconditional success flag — so the local write must be unreachable from
  every error branch. A machine that believes it renamed itself keeps stamping a
  name the server rejected onto every entry it pushes.
- Stores the server's returned values, not the requested ones, so a trim on the
  server cannot desynchronise the two.

`sessionToCredentials` must carry `avatar` and `avatarColor` across login and
refresh the way it already carries `displayName` (`lib/teamsync.js:210-211`),
or a token refresh silently drops one or both.

`POST /api/team/set-display-name` — 400 on empty or overlong, **409 on
collision**, 200 with `{ displayName, avatar, avatarColor }`.

**The `member-renamed` audit row is written inside `set_display_name` itself,
not by the daemon.** This deviates from the pattern most other audited
actions follow (daemon calls `apiAccess.recordAudit` after the mutation
succeeds). It cannot follow that pattern here: `team_audit`'s insert policy
requires manager role (`is_team_manager(team_id) and actor_id = auth.uid()`),
but renaming yourself is self-service for every member, manager or not, and
`recordAudit` swallows its own failures by design (`lib/api-access.js`) so
that a failed log never turns a completed action into a false error. Put
those two facts together for a plain member and a daemon-side `recordAudit`
call would be silently refused by RLS and silently swallowed by
`recordAudit` — a 200 response with no audit row anywhere, the exact
fail-open-plus-unconditional-success shape this repo treats as its
characteristic bug. Writing the row inside the `security definer` RPC's own
transaction is the only way to log an action a plain member is allowed to
take on themself. One row is written per team the rename touched (the RPC
updates every team a member belongs to in one statement), not one row filed
under an arbitrary "first" team — the RPC is the only actor that knows which
teams were actually written.

`GET /api/team` returns `avatar` and `avatarColor` alongside `displayName`
(`lib/server.js:2814-2815`).

### 4. UI

**Shell.** `rail-identity` (`ui/src/app/Shell.tsx:218`) becomes
`role="button" tabIndex={0}` with `onDoubleClick` and an Enter/Space key handler.
Deliberately not a real `<button>`, which would activate on single click. A
`title` states that double-clicking renames.

**Editor.** The existing `FormDialog` + `useDialogFocus`, holding a name input
and the avatar picker, saved in one call. A 409 renders inline beneath the input
with the dialog open and the typed text intact. Success invalidates the account
and roster queries so the rail and the Members list both relabel.

**DataClient.** `setDisplayName(name, avatar, avatarColor)` added to the
interface, `LocalDaemonClient` and `FakeDataClient`.

### 5. Avatar rendering — `AvatarGlyph.tsx`, not a sprite sheet

The original plan below was superseded once the art arrived: instead of an
SVG sprite sheet with `<symbol>` elements and a `?raw` import, the glyphs
shipped as a React component, `ui/src/components/AvatarGlyph.tsx` —
15 stroked marks ("Signal" family) in the language of the MemBridge wordmark,
over a flat token-color circle. **Shape and color are chosen
independently** — `GLYPHS` (15 keys) and `AVATAR_COLORS` (10 token colors,
the first eight carried forward unchanged from `Avatar.tsx`'s existing
`PALETTE` so a user who never picks keeps their current color) are separate
enums, giving 150 distinct combinations from one component rather than one
sprite Andrew would need to hand-draw every combination into. This is why
`team_members` carries two independent columns (`avatar`, `avatar_color`),
not one — see the Decisions table.

`Avatar` is used at 14 sites and none of them change. It already receives
`id`, so a context provider mounted once in `Shell` publishes an
`id → (avatar, avatarColor)` map built from the roster query the app already
runs, and `Avatar` looks itself up, rendering `AvatarGlyph` when a glyph is
set and falling back to the initial otherwise. Tests that render `Avatar`
with no provider get an empty map and fall back to the initial, which is
today's behaviour.

**Unknown keys fall back to the initial** — the case where a teammate on a
newer build picked a glyph or color this build's component does not
recognise.

**Editor reachability.** The picker is reachable from two places — the rail
footer's double-click (§4 above) and a row in Settings — through one shared
dialog, `ui/src/app/IdentityDialog.tsx`, so the two entry points cannot drift
into two different pickers or two different validation paths.

<details>
<summary>Original plan (superseded, kept for history)</summary>

**Sprite contract.** `ui/src/assets/avatars.svg`, injected once at app root. One
`<symbol id="mb-avatar-<key>" viewBox="0 0 24 24">` per mark, paths using
`fill="currentColor"` so the existing per-person palette tints them. Marks must
stay legible at 16px, the smallest current usage. Roughly 8 crude placeholder
marks ship with this work; Andrew's file replaces it and nothing else changes.

</details>

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
| Two people join at once as the same name | Serialised by the per-team advisory lock (§1.4); second becomes `marco 3` |
| Joiner's name already taken | Silently becomes `marco 2`; they are not told |
| Daemon offline | Rename fails visibly; `credentials.json` untouched |
| Signed out | Footer shows Sign in; no editor |
| Teammate picks a glyph or color absent from this build's `AvatarGlyph` component | Falls back to the initial |

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
| Migration | No local run; `057_member_identity.sql` and `059_revoke_unique_member_name_authenticated.sql` each carry a documented "verify after applying" block per `053`. `node test/run.js migration-state` and `node test/run.js definer-function-hardening` check the repo's own claims about both files (numbering, registry, ACL statements); neither can verify what is actually live |

No test failure is filed or fixed before `node scripts/verify-finding.js`
returns CONFIRMED.
