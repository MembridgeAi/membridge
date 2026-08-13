# Runbook — the SQL waiting to be applied

**Written for whoever sits down to apply these, without having been in the sessions that wrote them.** You should not need to open a single migration header to follow this. If you want the reasoning behind any one of them, it is in that file's header; this page is the order, the risks and the checks.

Status of every migration lives in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Update it as you go — the row is the record that a thing was applied, and a test fails if a file has no row.

---

## Migration number registry — claim a number here BEFORE writing the file

**This table is the single source for which migration numbers are taken.** Three collisions happened in one day because numbers were allocated by hand, in conversation, across parallel branches that could not see each other's files. A number is not free because `ls supabase/migrations` does not show it — it is free because it is not in this table.

`test/suites/migration-state.test.js` enforces this: a migration file whose number has no row here fails the gate, and a number claimed twice fails it too.

It starts at **037**, the point from which parallel lanes began allocating concurrently. Everything below that is settled history and is tracked in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md) alone.

| Number | What it does | Branch that holds it | Applied |
|--------|--------------|----------------------|---------|
| 037 | `project_access` writes scoped to the project's own team | `agent-sec` | no |
| 038 | Invite redemption claims a use atomically | `agent-sec` | no |
| 039 | `team_audit.created_at` stamped by the database | `agent-sec` | no |
| 040 | DELETE on `memory_entries` revoked from ordinary clients | `agent-sec` | no |
| 041 | `project_stats` carries `archived_at` | `agent-backend2` | yes |
| 042 | Definer-function grants + `is_team_member_uid` caller check | `agent-sec` | yes |
| 043 | Blanket table grants revoked on three internal tables | `agent-sec` | yes |
| 044 | Removal rotates the standing invite code | `agent-removal` | yes |
| 045 | Leaving a team rotates the standing invite code | `agent-removal` | yes |
| 046 | Joining a team writes an audit row | `agent-removal` | yes |
| 047 | Two scoped Postgres roles for the ops panel | `agent-sec` | no |
| 048 | `ops_audit.via_role` — records the verified credential beside the self-reported actor | `agent-sec` | no |
| 049 | Records a voluntary departure in the audit trail | `agent-removal` | yes |
| 050 | Stops the audit trail pinning a deleted account open | `agent-removal` | yes |
| 051 | Drops the now-vestigial `memory_entries_delete` policy | `agent-sec` | yes |
| 052 | Account-deletion FK actions on five uncontested constraints — PARKED, see `docs/ACCOUNT-DELETION.md` §6 | `agent-deletion` | no |
| 053 | `team_members_list` carries `deleted_at`, so soft-deleted accounts stop receiving team keys | `agent-deletion` | no |
| 054 | Three definer-surface findings from the jamal audit: `peek_invite` name leak on revoked/expired/exhausted tokens, `can_see_project` latent terminal-`true`, and `projects_materialize_access` PUBLIC grant | `agent-sec-jamal-01` | yes |

| 055 | `team_insights_rollup` — the Insights BREAKDOWNS (per-person, top projects, by-tool, concentration, silent-teammate) counted in the database instead of folded from a 2,000-row capped fetch | `agent-insights-agg` | no |

| 056 | `team_feed` off the default PUBLIC grant that four drop+create migrations kept restoring, with the paired grant that stops the revoke being an outage | `agent-insights-agg` | no |

| 057 | Per-team unique display names (case/whitespace-insensitive), a member avatar choice, and `set_display_name` | `feat/member-identity-rename` | yes (2026-08-13, **catalog-verified** 2026-08-13 — see MIGRATION-STATE.md) |
| 058 | `transfer_ownership` and `delete_team` — the owner of a team could never leave it and never delete it, because `leave_team` refuses owners, `set_role` cannot grant 'owner' and no disband existed. `delete_team` is gated on owner AND exactly one remaining member, so it can never reach another person's memory | `feat/settings-team-danger-zone` | yes |
| 059 | Revokes `authenticated` EXECUTE on `unique_member_name`/`team_members_dedupe_name` — closes the cross-team display-name enumeration oracle that 057's `public, anon`-only revoke left open (Supabase grants `authenticated` EXECUTE on new public-schema functions by default, and 057 never named that role) | `feat/member-identity-rename` | no |

**Next free number: 060.** 057, 058 and 059 are all claimed and all now visible on this branch — the two "claimed elsewhere" notes that stood here while the lanes were separate are gone, because the lanes have met.


To claim one: add the row first, in the same commit as the migration. If you are on a branch that cannot see another lane's files, this table is the only thing that will tell you the number is taken — which is exactly the situation that produced all three collisions.

---

## Before you start

- **Paste into the Supabase SQL editor. Never `supabase db push` in this project.** `supabase_migrations.schema_migrations` holds only two rows, so a push would try to re-run thirty-plus files against a database that already has most of their effects.
- The editor runs each paste in one transaction. If a statement fails, nothing from that file is applied — you can fix and re-paste.
- **Every file here is safe to re-run.** If you lose your place, re-pasting one you already did is a no-op.
- Nothing here has been run against any database by the sessions that wrote it.

---

## The order

**Most of this table is already done.** Reconciled read-only against production
on 2026-08-08: every struck-through row is live and must not be pasted. What is
genuinely outstanding is **`053`, `055` and `056`** — plus `047`, which is
separate and has its own section at the end.

`031` is struck for a *different* reason from the rest: its behaviour is live
AND the file is a reconstruction, so applying it would overwrite production with
a guess for no gain. Read its row before touching it.

Apply the remaining ones in numeric order.

| # | File | What it does, in one sentence |
|---|------|-------------------------------|
| ~~1~~ | `037_project_access_team_scope.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query; see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. Stopped someone using their own team to grant or revoke access to **another** team's project. |
| ~~2~~ | `038_invite_redeem_atomic.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query; see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. Made an invite's "max uses" limit actually hold when two people redeem at the same moment. |
| ~~3~~ | `039_team_audit_created_at.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query; see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. Stopped an admin writing audit-log entries with a false timestamp. |
| ~~4~~ | `040_revoke_memory_entries_delete.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query; see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. Verdict rests on `aclexplode`, not `information_schema.role_table_grants`, which under-reports. Pairs with 051, also applied. |
| ~~5~~ | `042_definer_function_hardening.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (all three functions clean of PUBLIC/anon); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~6~~ | `043_revoke_blanket_table_grants.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (no acl entry names anon or authenticated); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~7~~ | `041_project_stats_carry_archived.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (view def carries `archived_at`); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~8~~ | `044_removal_rotates_invite_code.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (`remove_member` rotates `invite_code`); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~9~~ | `045_leave_rotates_invite_code.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (`leave_team` rotates `invite_code`); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~10~~ | `046_audit_member_joined.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (`team_members_audit_join` present); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~11~~ | `049_audit_member_left.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (`team_members_audit_leave` present); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~12~~ | `050_team_audit_actor_set_null.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (`confdeltype = n`); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~13~~ | `051_drop_memory_entries_delete_policy.sql` | **ALREADY APPLIED — SKIP.** Reconciled against production 2026-08-08 with this row's own query (policy returns no rows); see [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Do not paste it. |
| ~~14~~ | `031_ensure_rls_event_trigger.sql` | **DO NOT APPLY.** Re-verified against production 2026-08-08: the live `rls_auto_enable` already carries every distinctive string in this file — the fail-closed `raise exception`, its detail/hint text, the `pg_catalog` search_path and the skip-logging branch. The behaviour is already there. AND this file is a RECONSTRUCTION of an object that predates the repo, so `create or replace` would overwrite live behaviour with a guess for no gain. Nothing to do. |
| ~~15~~ | `053_team_members_list_deleted_at.sql` | **057 IS APPLIED — SKIP.** Lets a client tell a soft-deleted account from a live one, so a departed member stops receiving team encryption keys. **NOT independent of 057 — apply-order matters.** `057_member_identity.sql` §3 drops and recreates this same function (`team_members_list`) to add `avatar`/`avatar_color`, and its version of the function ALSO carries this file's `deleted_at` column. If you are applying both files: apply 057 and skip this one — 057 alone already gives you everything 053 does. If you apply 053 AFTER 057, its `create or replace` overwrites 057's version with one that has no `avatar`/`avatar_color` columns, so `team_members_list` silently stops returning them and every teammate's avatar goes blank client-side with no error. Applying 053 alone (057 not yet shipped) is still fine and unchanged. Independent of everything ELSE above — any order, on its own, with respect to non-057 files. *(deletion lane)* |
| ~~16~~ | `054_sec_jamal_01.sql` | **ALREADY APPLIED — SKIP.** Verified against production 2026-08-08 with all three of the file's own queries; see the 054 row in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Left in this table rather than deleted so the numbering stays legible and so it is obvious this was checked rather than dropped. Do not paste it. *(sec lane)* |
| 17 | `055_team_insights_rollup.sql` | Makes the per-person and per-project numbers on Insights real totals instead of a quarter-short sample, and stops the screen naming somebody as a project's only contributor on the strength of an incomplete read. Adds a new function, touches nothing existing — any order, on its own, and safe to apply before or after the client ships. *(insights lane)*
| 18 | `056_team_feed_revoke_public.sql` | Stops `team_feed` being callable by PUBLIC. No data is exposed today — `is_team_member` denies a null identity — so this is defence in depth, not a live leak. **Apply in the same session as 055.** Self-verifying: it raises rather than silently doing nothing. *(insights lane)* |
| 19 | `057_member_identity.sql` | Lets a member rename themselves and pick an avatar, with display names enforced unique per team by a partial unique index (not a client check). Adds columns to `team_members`, a dedupe-on-insert trigger, and `set_display_name`. **NOT independent of 053 — apply-order matters.** §3 drops and recreates `team_members_list` (053's function) to add `avatar`/`avatar_color` to what it returns, carrying 053's `deleted_at` column forward in the same definition — apply THIS file and skip 053 entirely; do not apply 053 afterward (see 053's row above for what that breaks). Independent of everything ELSE above — any order, on its own, with respect to non-053 files. *(member-identity lane)* |
| 20 | `059_revoke_unique_member_name_authenticated.sql` | 057 is already applied to production, and as applied its revoke line only removed `public`/`anon` from `unique_member_name`/`team_members_dedupe_name` — it never named `authenticated`, which Supabase grants EXECUTE to on every new public-schema function by default. This file closes that: two `revoke ... from authenticated` statements, nothing else. **Must go AFTER 057, not before** — both functions have to exist first, or the `revoke` raises "function does not exist" on a fresh database. On `mefgbiecvoszjorwzkfz` this is moot (057 already ran), but say it plainly for any other environment. Otherwise independent of everything else in this table, including 058 — no `create function`, no other ordering constraint. *(member-identity lane)* |

**`052_account_deletion_fk_actions.sql` is deliberately NOT in this table.** It
is parked pending a product decision — see `docs/ACCOUNT-DELETION.md` section 6
— and applying it alone would remove five guardrails without making account
deletion actually work, since `memory_entries.author_id` still blocks every
real user until that decision lands. It belongs to a later batch, once section
6 is settled, not to this one.

**Why `031` is struck rather than ordered last.** This paragraph used to say
"do it when the other five are known good". That instruction is now withdrawn:
the 2026-08-08 reconciliation found the live `rls_auto_enable` already carries
every distinctive string in the file, so there is nothing to gain by running it.
And it remains the only file here reconstructed from a live object rather than
written from scratch, so `create or replace` would replace working production
behaviour with our best guess at it. Live behaviour plus zero gain plus a
non-trivial downside is not a "do it carefully" — it is a "do not do it".

If 031 ever genuinely needs to change, diff `pg_get_functiondef` against the
file first and write a new migration for the delta. Do not paste this one.

---

## The one hard dependency

> ### `038` must be applied **before** the app release that carries the new invite defaults — never after.
>
> The app change (in `lib/server.js`) starts giving every new invite a 7-day expiry and a 1-use limit. `038` is what makes that 1-use limit hold under simultaneous redemption.
>
> - `038` applied first, app shipped later → fine. The fix is in place before anything relies on it.
> - App shipped first, `038` later → **there is a window where the app tells people an invite is single-use and it is not.** Two people clicking the same link at the same moment both get in.
>
> If you are applying these and the release has not gone out yet, you are fine — just do `038` now.
>
> ### The same constraint applies to `044`, `045` and `046`
>
> All three say it in their own headers: **apply to the live database before shipping the client, not after.** And all three warn that CI cannot catch a miss, because the offline tests run against a mock that already models the new behaviour. If the client ships first, the symptom is *silence* — the app works, nothing errors, and the protection simply is not there.
>
> So the rule for this whole batch is one line: **apply everything here before the next release goes out.**

There is ONE ordering constraint among these fourteen, `050` (below), and no others — confirmed by merging all three branches together and reading every header, not assumed. `041`, `044`, `045` and `046` each state in their own headers that they are order-independent, and `046` and `038` were checked against each other in both directions. Each one touches a different thing, and none of them depends on another having run first.

`047` is the exception to that and is not in the table above: it changes the credential the ops panel logs in with, so it is a database step **and** a Worker deploy. It has its own section, its own order, and its own rollback.

---

## Applying them, with the check for each

### 1. `037_project_access_team_scope.sql`

**Does:** stops a `project_access` row naming a project outside the team that wrote it.

**After applying, check:** open a project you manage and toggle a teammate's access to it. It should work exactly as before.

**If that breaks,** the new rule is stricter than intended — it requires the project to be visible to you under the normal project rules, which for a manager of that team it always is. Report it rather than working around it.

**This second step is NOT optional, and it is not cleanup — it is the fix for every row that already exists.** A database rule of this kind is checked when a row is *written*. Rows written before it went in were never checked against it, and the database still honours them exactly as before. So applying the migration protects future writes and changes nothing at all about the ones already there. Run this to see what is there:

```sql
select a.team_id, a.project_key, a.member_id, a.can_see, a.updated_at, a.updated_by
  from public.project_access a
 where not exists (select 1 from public.projects p
                    where p.id::text = a.project_key and p.team_id = a.team_id)
 order by a.updated_at desc;
```

**How many rows this returns is unknown — nobody has run it.** Running it is how it becomes known, which is the whole reason it is a separate step rather than something the migration does for you.

If it returns rows, **read them before deleting anything** — the query also matches harmless leftovers from deleted projects, not just bad grants. The matching `delete` is in `037`'s header when you want it.

**If you skip this step:** every mismatched row that already exists carries on granting or denying somebody access to a project in another team, indefinitely. Nothing will go red about it, no test will catch it, and the migration you just applied will not touch it. The only thing that finds those rows is the query above.

---

### 2. `038_invite_redeem_atomic.sql`

**Does:** an invite's use is now claimed atomically, so a 1-use invite can only ever admit one person.

**See the dependency box above — this one has a release-ordering constraint.**

**After applying, check:** create an invite and redeem it once. It should work normally. Redeeming a second time on a 1-use invite should say *"this invite link has already been used."*

**Also check:** redeeming an invite you have already used (i.e. you are already on the team) should still be a harmless no-op and should **not** consume one of its uses.

---

### 3. `039_team_audit_created_at.sql`

**Does:** the database now stamps the time on every audit-log row, so the time cannot be supplied by whoever is writing it.

**After applying, check:** do anything that writes an audit entry — create an invite, change someone's role — then open the audit trail. The new entry should appear with the correct current time.

**Note:** existing rows are untouched. This only guarantees the property from now on.

---

### 4. `040_revoke_memory_entries_delete.sql`

**Does:** the app offers people a way to delete their own synced memory, and that path records what was deleted. It was also possible to do the same thing by calling the database API directly, which deleted the rows and recorded nothing. This removes that second path.

**After applying, check:** the self-serve deletion in the app still works — delete your own entries for one project and confirm they go, and that the action shows up in the audit trail. The supported path runs with elevated rights and is unaffected by this change; only the direct one closes.

**If deletion stops working entirely,** that is the signal that the app's delete is not going through the intended function. Report it rather than re-granting the permission — re-granting restores the unrecorded path too.

---

### 4b. `051_drop_memory_entries_delete_policy.sql` — the pair to step 4

**Does:** step 4 took away the *permission* to delete shared memory directly. This removes the *rule* that used to allow it, which now has nothing to act on.

**Apply it any time, before or after step 4** — it needs nothing else and either order is safe.

**After applying, check:** the same thing as step 4 — self-serve deletion in the app still works, and still shows in the audit trail. Nothing else should change, because the rule being removed already had no effect.

**Why bother removing something that does nothing:** if the permission is ever restored — most likely by someone running a broad `grant` across the schema, which is how it got there originally — then with the rule still present, direct unrecorded deletion quietly works again. With the rule gone, the database refuses regardless. Removing it is the stronger of the two states, not the tidier one.

---

### 5. `042_definer_function_hardening.sql`

**Does:** three database functions were callable by anyone holding the public key; they now are not. Separately, a function that answered *"is person X on team Y?"* now refuses unless you are on team Y yourself.

**After applying, run the smoke test — this is the one with a real regression risk:**

> **Have an existing member share the team with someone new, and confirm the new joiner can read existing team history.**
>
> This is the flow that broke once before (a new member joined but could not decrypt anything). The function this migration changed is the one that check runs through. If a new joiner can see history, you are good.

**Also check:** the ops dashboard still loads (it uses a different credential and should be unaffected), and normal team feed / project pages still load.

**If the new-joiner check fails,** the added condition in `is_team_member_uid` is the only thing that changed — say so and it can be reverted on its own.

---

### 6. `043_revoke_blanket_table_grants.sql`

**Does:** removes a default permission that was never used but was sitting on three internal tables — including the one holding unredeemed invite tokens.

**After applying, check:** the ops dashboard still loads and shows teams. It reaches these tables with a different credential that this change does not touch.

**Also check:** redeeming an onboarding invite still creates a team.

**Deliberately not included:** the feedback form and the waitlist signup on the site also have this kind of permission, and they **need** it — they exist to accept submissions from people who are not logged in. They are left alone on purpose. Do not "finish the job" by adding them.

---

### 7-12. The other lanes' six — `041`, `044`, `045`, `046`, `049`, `050`

These come from the backend and removal lanes rather than the security one. They are grouped because the instruction is the same for all four: **paste, then check the one behaviour each names.** Each file's own header carries the detail.

| File | After applying, check |
|------|------------------------|
| `041_project_stats_carry_archived.sql` | The team hub still lists projects, and archived ones now appear rather than silently vanishing. |
| `044_removal_rotates_invite_code.sql` | Remove a member from a test team; the team's invite code should change. Confirm the old code no longer lets them re-join. |
| `045_leave_rotates_invite_code.sql` | Same, but have the member leave voluntarily rather than being removed. |
| `046_audit_member_joined.sql` | Have someone join a team; a "member joined" entry should appear in that team's audit trail. It did not before. |
| `049_audit_member_left.sql` | Have someone leave; a "member left" entry should appear, distinct from a removal. |
| `050_team_audit_actor_set_null.sql` | See the box below — this one has a real constraint. |

> ### `050` must go in with `046` and `049` — do not apply those and leave this one
>
> `046` and `049` give every member audit rows naming them as the actor. `team_audit.actor_id` references the user with no delete rule, so **an account with any audit row cannot be deleted.** Before `046` a plain member had no audit rows at all, so this never bit. `050` is the fix, written by the lane that caused it.
>
> Applying `046`/`049` without `050` therefore makes account deletion *worse than it is today*. If you apply one, apply all three.
>
> `050`'s own header is worth reading if you ever handle a deletion request: it records that account deletion is blocked by **six** foreign keys, five of which predate all of this. `050` fixes one. It does not make account deletion work.

`041`, `044`, `045`, `046` and `049` are order-independent — of each other and of everything above. `044` and `045` may be applied in either order or one without the other; `046` was checked against `038` in both directions during the merge dry run.

**All three of the removal lane's migrations carry the same deploy gate as `038`** — apply before the client ships, not after. See the box near the top.

---

### 14. `031_ensure_rls_event_trigger.sql`

**Does:** there is a safety net that switches on row-level security whenever a table is created. Today, if it fails, it writes a line to a log nobody reads and lets the table be created anyway. After this, it refuses the creation.

**Read this before applying:** this file was reconstructed from the version already running in production, because nobody had the original. The live version has been read and compared, and the differences are accounted for — that is recorded in the file. This is the only migration here in that position.

**After applying, check:** create a throwaway table and confirm it comes out with row-level security already on, then drop it.

```sql
create table public.rls_smoke_test (id int);
select relrowsecurity from pg_class where relname = 'rls_smoke_test';  -- expect: t
drop table public.rls_smoke_test;
```

**If that errors instead of succeeding,** the safety net is now refusing a creation it should have allowed. That is the fail-closed behaviour working too eagerly — it is recoverable, and the error message says what to do. Do not drop the trigger to get past it.

---

---

## 15. `047_ops_panel_roles.sql` — do this one separately

**This one is different from the six above and should not be done in the same sitting.** The others fix something and are finished when the SQL is applied. This one changes *which credential the ops panel logs in with*, so it is a database step **and** a Worker deploy, and the two have to happen in the right order.

**Does:** the ops panel currently logs into the database with a key that can read and write everything, ignoring all the protections above. This creates two much smaller logins — one that can only read the four things the panel displays, one that can only perform the four actions it offers — and neither can touch a table directly at all.

### The safe part, which you can do any time

**Applying `047` on its own changes nothing.** It only creates the two new logins; it does not remove the old one, and nothing uses the new ones until the Worker is redeployed. If you apply it and stop there, the panel carries on exactly as before. That is deliberate.

After applying, check both logins exist and neither can bypass the security rules:

```sql
select rolname, rolbypassrls, rolcanlogin from pg_roles
 where rolname in ('ops_panel_read','ops_panel_write');
-- expect two rows, both with rolbypassrls = f
```

And the check that proves the point — neither can read a table:

```sql
select has_table_privilege('ops_panel_read', 'public.teams', 'SELECT') as should_be_false;
```

### The part that needs care — switching the panel over

**Order matters. Do not deploy the Worker first.**

1. Apply `047` (above).
2. Mint two access tokens, one per role. They are signed with the project's JWT secret (Supabase dashboard → Project Settings → API). Each is an ordinary Supabase JWT whose `role` claim is `ops_panel_read` or `ops_panel_write` instead of `service_role`.
   > **Check this first:** newer Supabase projects have moved to a different key system. If your project shows "JWT Signing Keys" rather than a single "JWT Secret", the minting step is different and it is worth confirming the approach before going further, rather than discovering it half way.
3. Set both as Worker secrets — this prompts, so the values never reach your shell history:
   ```
   wrangler secret put OPS_READ_KEY
   wrangler secret put OPS_WRITE_KEY
   ```
4. Deploy the Worker.
5. **Check, in this order:**
   - The panel loads and shows real numbers.
   - **The recent-activity list is NOT empty.** This is the important one — see below.
   - Perform one harmless action (set a note on a team). It should succeed.

### Why "is the list empty?" is the check that matters

If one permission is missing, the panel does **not** break. It renders with an empty activity list, which looks exactly like a quiet week. That is the failure worth guarding against, because it is the one you would not notice.

The Worker now reports this rather than hiding it: the response carries a `degraded` field naming anything that failed. If the list looks empty and you want to be sure, open the browser's network tab on the panel's `/api` request and look at `degraded` — it should be `[]`.

### Rollback — you can do this without me

**If anything looks wrong at any point, roll the Worker back. That is the whole recovery.**

```
wrangler rollback
```

The previous version uses the original `SUPABASE_SERVICE_KEY`, which this change **does not touch or remove**. It keeps working the entire time. There is no window where the panel has no valid credential unless you delete that secret — so don't, not until this has been running happily for a while.

You do not need to undo anything in the database to recover. The two new logins sitting unused are harmless. If you want them gone anyway, the exact statements are at the bottom of `047`, commented out — but do the Worker rollback first, or you will pull the credential out from under a running panel.

### While you are here: `048_ops_audit_via_role.sql`

**Does:** adds one column to the ops audit log recording *which credential* a write arrived under, next to the operator name the panel reports.

**Apply it any time — it is additive and affects nothing else.** No check needed beyond the panel still loading.

**What it is for, so it is not mistaken for more:** the operator name in the ops audit log is **self-reported**. The panel fills it in from the verified sign-in, so it is right in normal use — but anyone holding the panel's write key could pass a different name, and that cannot be fixed in the database (the reasoning is in the file). This column records something the database *can* check: after you switch the panel over in the step above, every legitimate write shows `ops_panel_write`. A row showing anything else means something called the database without going through the panel.

It does not tell you which of the three of you did something. All three share one credential.

---

### What is deliberately still outstanding

The old all-powerful key still exists and still works — on purpose, because it is the rollback. Removing its access is a separate change for later, once the new logins have proven themselves. Doing both at once would delete the safety net in the same step that needs it.

---

## If you are the one merging these branches together

Three branches carry this work — `agent-sec`, `agent-backend2` and `agent-removal` — and merging them was dry-run once (SEC-14) so the surprises are known. Two things need a human decision:

1. **`test/mock-supabase.js` conflicts, and the resolution is "keep both".** Two lanes each appended flags to the same object. Taking either side alone silently drops the other lane's test flag, which turns one of their suites green for the wrong reason. Keep both blocks.

2. **The `(other branch)` notes in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md) go stale the moment you merge.** Five rows carry that qualifier because the file lives on one branch and cannot see the others. Once merged, the files ARE on disk and the qualifier should come out. It is deliberately ugly so it gets noticed.

3. **Check for two files sharing a migration number.** This already happened once: `agent-removal` committed a migration as `048` while the registry had assigned `048` elsewhere. Git does **not** conflict on that — different filenames, different paths, both files simply coexist — so it survives a merge in silence and only surfaces when someone applies them. `test/suites/migration-state.test.js` now fails on it; run that suite after merging, before doing anything else.

4. **`test/mock-supabase.js` has THREE places where two lanes both added something, and git only conflicts on one of them.** This is the important entry. Two of the three merge *silently* and produce a file that is syntactically fine and behaviourally wrong:

   | What | Does git conflict? | What goes wrong if you don't fix it |
   |------|--------------------|--------------------------------------|
   | The `flags` object | **Yes** | You resolve it, so it gets attention. Keep both. |
   | The `/auth/v1/logout` handler | **No** | Two handlers for one route. The first wins and the second — the one honouring `failLogout` — becomes dead code, so a test that checks sign-out reports a *refused* revocation honestly fails for the wrong reason. |
   | The `return { ... }` at the end | **No** | Two `return`s in one function. The first wins and **everything after it is unreachable**, including helpers the second lane defined. The symptom is `mock.deleteTeamCascade is not a function`, three suites away from the cause. |

   After merging, check for both by hand — they are one-line checks and they are not optional:

   ```
   grep -c "url.pathname === '/auth/v1/logout'" test/mock-supabase.js   # must be 1
   grep -c "^  return { server"                 test/mock-supabase.js   # must be 1
   ```

   The fix in both cases is to collapse the two into one that does both jobs. Working versions of both are in the SEC-14 dry-run tree.

5. **Two ways a verification grep passes while the state is wrong.** Both were hit for real during the renumber, and both are the same shape as the hazards above — the check succeeds and tells you nothing.

   - **Grepping for the number you moved *away from* proves nothing about where it landed.** A clean result for the old number is consistent with the rename having gone somewhere wrong, or nowhere. It confirms only that the old value is absent. What catches a botched rename is reading the renamed files, not searching for their former name.
   - **A single-number grep is structurally blind to one number meaning two things.** After a renumber pass, `049` referred both to the file just renamed *into* 049 and to references already sitting at 049 for something else — indistinguishable to any search for the string. The only thing that finds it is auditing per number and reading each hit in context.

   Practical rule: after a renumber, list every migration number on disk and read what claims it, rather than grepping for the numbers you touched.

6. **`agent-hunt` does NOT merge cleanly — 11 files, 18 conflict regions**, and a large share of them are self-inflicted. It was never part of the dry run, and it is not test-only: it changes `lib/server.js`, `lib/teamsync.js`, `lib/feed.js`, `lib/digest.js` and `lib/team-archive.js`, plus the headers of four already-applied migrations (`031`–`034`).

   Five of the conflicts are `add/add` on test suites, and the cause is worth naming because it is a habit, not an accident: those files were brought onto the security branch with `git checkout agent-hunt -- <file>` rather than by merging or cherry-picking. **A file copied that way has no shared history with the original, so git cannot three-way merge it and reports add/add — a conflict guaranteed at the moment of import, and invisible until someone merges the branch properly.** If you need one file from another branch and it may ever be merged, cherry-pick the commit instead.

   Of `agent-hunt`'s 19 test suites, 14 would merge with no conflict; the 5 that conflict are the ones that were imported. Which of its deliberate red findings are now closed by the other lanes' fixes is being audited from the hunt side separately.

Everything else merged cleanly, and the combined test suite was run — see the SEC-14 report.

**This section exists because the merge had to be dry-run twice in one evening**, and the second run found more than the first.

A lane moved underneath the dry run three separate times: it committed a new migration mid-run, committed another, and began renumbering — all while the merge was being assembled and tested. **That is the normal condition when several lanes are active, not an accident of timing to be waited out.**

The practical consequence, and the reason this is written down rather than left as a war story:

> **A dry run proves the shape composes. It cannot prove the shape is still current.**
>
> The SEC-14 run measured `2103/2103` node checks across 54 suites plus `992` UI tests. **What that figure actually covers is narrower than "the batch":** `agent-sec` and `agent-removal` were merged whole; `agent-backend2` was merged at a point it has since moved two commits beyond; `agent-hunt` was never merged at all and is nineteen commits away. So it is two branches whole and one stale — a real result about a real assembled tree, and not a claim about today's branches.
>
> The sharpest illustration: one of the backend lane's commits was authored **seventy-seven seconds after the assembly HEAD**, about a minute into the test run. Not a missed merge — work that did not exist when the tree was built. With six lanes live, a dry run is stale within two minutes of starting.
>
> Whoever does the real merge must re-run these checks at merge time — the two `grep -c` commands above, `node test/run.js migration-state`, and the full suite — against whatever the branches actually contain *then*. Do not trust this section, or any report, as evidence about a tree you have not just assembled yourself. The checks are cheap; the report has a timestamp and the branches do not care about it.

---

## When you are done

1. Update each row in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md) from **NOT applied** to **applied**, with today's date at the top of the file. Each row already carries the query that proves it.
2. If you stopped part way, leave the remaining rows as they are — that is what they are for.

## One thing that is not fixed by any of this

The ops dashboard holds a database key that bypasses **all** of the protections above. Everything in this runbook constrains what ordinary users and the app can do; none of it constrains that key. Narrowing it to a read-only role is a separate, larger piece of work that has not been done. Worth knowing when reading any claim that a table is "protected".
