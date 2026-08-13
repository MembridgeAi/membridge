# Migration state — the one place applied/unapplied is recorded

**Verified read-only against project `mefgbiecvoszjorwzkfz` on 2026-08-05.**
Every `applied` row below was settled by reading a system catalog, never by
reading a migration file. The query that settles each one is in the Evidence
column; re-run it rather than trusting this table.

This file exists because the same fact was previously written in three places —
a migration header, `claude/ops/queue.md`, and a handoff — and the three drifted
into three different facts. `032`, `033` and `034` each said `UNAPPLIED AS OF
THIS COMMIT` for four releases after a human had applied them, and the queue
copied that into the document the next session acts on, so work was budgeted
against a hole that was already closed.

**Rules.**

1. Applied/unapplied is recorded HERE and in the migration's own header, and
   nowhere else. Anything else links here.
2. Header stamps carry a date: `UNAPPLIED AS OF 2026-08-05` reads as stale on
   sight; `UNAPPLIED AS OF THIS COMMIT` reads as current forever. The bare form
   is banned and `node test/run.js migration-state` fails on it.
3. `unverified` is an honest state and is not the same as `unapplied`. Do not
   promote one to the other without running the query.
4. Applying a migration includes updating this table in the same change.

**What this gate can and cannot do.** `test/suites/migration-state.test.js` runs
offline, so it cannot ask production anything. It enforces that every migration
declares a state, that no file uses the undated stamp, and that a file's header
never contradicts this table. The claim's *truth* still needs a human with
credentials running the Evidence query — `supabase/AUDIT-live-state.sql` dumps
the whole picture in one paste. The gate converts silent drift into a red test;
it does not make the repo self-verifying, and nothing offline could.

| Migration | State | Evidence (read-only) |
|---|---|---|
| 002 `team_v2` | applied | superseded in place by 003/010/029; `invites` table + `create_invite` exist |
| 003 `fix_join_ambiguity` | applied | superseded in place by 029's `join_team` body |
| 004 `feed_summary` | unverified | predates this ledger |
| 005 `project_archive` | applied | `projects.archived_at` column exists |
| 006 `team_meta` | applied | `my_teams()` returns `invite_code` |
| 007 `memory_ask_nullable` | unverified | predates this ledger |
| 008 `summary_fields` | applied | `memory_entries.goal` column exists |
| 009 `e2e_encryption` | applied | `memory_entries.ciphertext` column exists |
| 010 `security_hardening` | applied | `check_invite_attempt` + `invite_attempts` exist |
| 011 `backend_hardening` | unverified | mostly commentary; no single distinctive artifact |
| 012 `memory_entries_update` | applied (superseded) | policy exists, now carrying 033's predicate |
| 013 `e2e_feed` | applied | `team_feed()` exists |
| 014 `distilled_flag` | applied | `memory_entries.distilled` column exists |
| 015 `feedback` | applied | `feedback` table exists |
| 016 `multidevice_keys` (master) | applied | `team_keys_delete_own` policy exists |
| 016 `multidevice_keys` (branch) | **NOT applied** | no `device_id` on `member_pubkeys`/`team_keys`; PKs unchanged — see `AUDIT-live-state.sql` §1 |
| 017 `headline_parity` | applied | `memory_entries.headline` column exists |
| 018 `summary_cap_and_drift_reconcile` | unverified | predates this ledger |
| 019 `ops_snapshot` | applied | `ops_log()` exists |
| 020 `ops_snapshot_v2` | unverified | predates this ledger |
| 021 `ops_panel` | applied | `ops_log()` + `onboarding_invites` exist |
| 022 `ops_snapshot_v3` | unverified | predates this ledger |
| 023 `redeem_returns_team_name` | applied | `redeem_onboarding_invite()` exists |
| 024 `project_access_and_audit` | applied | `project_access` + `team_audit` tables exist |
| 025 `enforce_project_access` | applied | `memory_entries_select` contains `can_see_project` |
| 026 `project_access_default` | applied | `projects.default_access` column exists |
| 027 `team_feed_counts` | applied | `team_feed_counts()` exists |
| 028 `enforce_project_access_default` | applied | `can_see_project()` exists |
| 029 `materialize_project_access` | applied | `project_access` populated (13 rows / 7 projects) |
| 030 `team_keys_definer_membership` | applied | `team_keys_insert` check contains `is_team_member_uid` |
| 031 `ensure_rls_event_trigger` | applied | **Re-verified 2026-08-08.** This row previously said NOT applied because "live `rls_auto_enable` lacks 031's fail-closed body". That was FALSE, and it was the dangerous direction to be wrong in: it told a reader production's RLS auto-enable fails OPEN when it fails CLOSED. Live `pg_get_functiondef` carries `set search_path to 'pg_catalog'`, the `raise exception 'rls_auto_enable: refusing to create % without row-level security'`, its `detail`/`hint` text and the skip-logging branch — every distinctive string in the file is present live. The file remains a RECONSTRUCTION, so still diff before any `create or replace`; but the behaviour 031 exists to guarantee is already in production |
| 032 `materialize_project_access_on_insert` | applied | `projects_materialize_access` trigger on `projects` |
| 033 `enforce_project_access_on_write` | applied | `memory_entries_insert`/`_update` both contain `can_see_project` |
| 034 `project_access_lookup_index` | applied | index `project_access_project_member_idx` exists |
| 035 `delete_own_entries` | applied (other branch) | `memory_entries_delete` policy + `delete_my_entries()` + `my_entry_counts()` exist. The FILE is not on this branch — it lives on `agent-backend2` and the policy is live regardless, which is SEC-2's finding: the repo does not describe production until that branch merges |
| 036 `drop_projects_insert` | applied (other branch) | Applied BY HAND on the live database before the file was written, and verified afterwards — its own header says so and warns against re-running it as if it were pending. File lives on `agent-backend2`; not on this branch |
| 041 `project_stats_carry_archived` | applied | **Reconciled 2026-08-08**, read-only against production. `select pg_get_viewdef('public.project_stats'::regclass);` — the definition carries `archived_at`, the row's own criterion. Previously recorded `not applied (other branch)`; the file is on disk here, so the qualifier is gone too |
| 044 `removal_rotates_invite_code` | applied | **Reconciled 2026-08-08**, read-only against production. `select prosrc from pg_proc where proname = 'remove_member';` — the body rotates `teams.invite_code`. Previously `not applied (other branch)`; file is on disk, qualifier dropped. Its deploy gate is therefore satisfied, not outstanding |
| 045 `leave_rotates_invite_code` | applied | **Reconciled 2026-08-08**, read-only against production. `select prosrc from pg_proc where proname = 'leave_team';` — the body rotates `teams.invite_code`. Previously `not applied (other branch)`; file is on disk, qualifier dropped |
| 046 `audit_member_joined` | applied | **Reconciled 2026-08-08**, read-only against production. `select tgname from pg_trigger where tgrelid = 'public.team_members'::regclass;` — `team_members_audit_join` is listed. Previously `not applied (other branch)`; file is on disk, qualifier dropped |
| 049 `audit_member_left` | applied | **Reconciled 2026-08-08**, read-only against production. `select tgname from pg_trigger where tgrelid = 'public.team_members'::regclass;` — **applied when `team_members_audit_leave` is listed** (it is, alongside `team_members_audit_join`). The criterion previously said only "the departure trigger", naming nothing, and a reconcile pass guessing `%left%`/`%depart%` got a FALSE NEGATIVE on a trigger actually called `...audit_leave`. The name is now written down so the next reader cannot repeat that. Previously `not applied (other branch)`; file is on disk, qualifier dropped |
| 050 `team_audit_actor_set_null` | applied | **Reconciled 2026-08-08**, read-only against production. `select confdeltype from pg_constraint where conname = 'team_audit_actor_id_fkey';` — returns `n` (SET NULL), the row's own criterion. Cast `confdeltype::text` if you concatenate it; it is Postgres's internal `"char"`. Previously `not applied (other branch)`; file is on disk, qualifier dropped |
| 051 `drop_memory_entries_delete_policy` | applied | **Reconciled 2026-08-08**, read-only against production. `select polname from pg_policy where polrelid = 'public.memory_entries'::regclass and polname = 'memory_entries_delete';` — returns NO rows, the row's own criterion. Pairs with 040, which remains unverified |
| 037 `project_access_team_scope` | applied | **Re-verified against production 2026-08-08 (read-only).** `project_access_insert` WITH CHECK is `is_team_manager(team_id) AND EXISTS (SELECT 1 FROM projects p WHERE p.id::text = project_access.project_key AND p.team_id = project_access.team_id)` — the `exists` against `public.projects` this row asks for. Original criterion kept: `select polname, pg_get_expr(polwithcheck, polrelid) from pg_policy where polname = 'project_access_insert';` — applied when the expression contains `exists` against `public.projects` |
| 038 `invite_redeem_atomic` | applied | **Re-verified against production 2026-08-08 (read-only).** `redeem_invite` body carries BOTH markers: `get diagnostics` true, `max_uses` true. Original criterion kept: `select prosrc from pg_proc where proname = 'redeem_invite';` — applied when the body contains `get diagnostics` and a WHERE carrying `max_uses`. **Must land with the INV-1 client change, not after it** |
| 039 `team_audit_created_at` | applied | **Re-verified against production 2026-08-08 (read-only).** `team_audit_stamp_created_at` is the only user trigger on `public.team_audit`. Original criterion kept: `select tgname from pg_trigger where tgrelid = 'public.team_audit'::regclass;` — applied when `team_audit_stamp_created_at` is listed |
| 040 `revoke_memory_entries_delete` | applied | **Re-verified against production 2026-08-08 (read-only).** `aclexplode` on `public.memory_entries` returns DELETE for `postgres` and `service_role` only — neither `anon` nor `authenticated`. NOTE the two sources disagree in appearance: `information_schema.role_table_grants` showed no DELETE rows at all, because it only reports grants the querying role can see; `aclexplode` over `pg_class.relacl` is authoritative and is what this verdict rests on. Pairs with 051, also applied, so the pair is COMPLETE — the privilege is revoked and the policy is dropped. Original criterion kept: `select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'memory_entries' and privilege_type = 'DELETE';` — applied when neither `anon` nor `authenticated` appears. The privilege is a Supabase PLATFORM DEFAULT that appears nowhere in `supabase/`, so the repo cannot tell you its state — only this query can |
| 042 `definer_function_hardening` | applied | **Reconciled 2026-08-08**, read-only against production. `select proname, proacl from pg_proc where proname in ('can_see_project','team_feed_counts','set_project_access_default');` — all three carry `postgres`/`authenticated`/`service_role` only, no PUBLIC and no `anon`, which is the row's own criterion. This also settles the open question from 055's security review, which saw the three clean and could not tell whether 042 had run or something else had cleaned them: 042 ran. NOTE: 042 does **not** cover `team_feed` — see 056 |
| 047 `ops_panel_roles` | **NOT applied** | `select rolname, rolbypassrls, rolcanlogin from pg_roles where rolname in ('ops_panel_read','ops_panel_write');` — applied when both exist with `rolbypassrls = f`. **Inert on its own**: it only ADDS roles and does not touch `service_role`, so the panel is unaffected until the Worker is redeployed with the new secrets. Full verification and rollback in the file |
| 048 `ops_audit_via_role` | **NOT applied** | `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ops_audit' and column_name = 'via_role';` — applied when the row comes back. Additive only; records the VERIFIED credential beside the self-reported actor. Not a fix for the forgeable actor — see the file header |
| 043 `revoke_blanket_table_grants` | applied | **Reconciled 2026-08-08**, read-only against production. `select relname, relacl from pg_class where relname in ('onboarding_invites','ops_audit','ops_team_meta');` — no acl entry names `anon` or `authenticated`; `ops_audit` and `ops_team_meta` carry `postgres`/`service_role` only |
| 052 `account_deletion_fk_actions` | **PARKED (not applied)** | `select confdeltype from pg_constraint where conname in ('teams_created_by_fkey','projects_created_by_fkey','memory_entries_author_id_fkey','invites_created_by_fkey');` — applied when all four are `n` (SET NULL) or the file's chosen action, none `a` (NO ACTION). File lives on `agent-deletion`. See `docs/ACCOUNT-DELETION.md` section 6 for the pending product decision — do not apply until that is settled; applying it alone removes guardrails without making deletion actually work, since `memory_entries.author_id` (uncontested, this file) still blocks every real user until that decision lands |
| 053 `team_members_list_deleted_at` | **NOT applied** | `select prosrc from pg_proc where proname = 'team_members_list';` — applied when the returned columns include `deleted_at`. File lives on `agent-deletion`. Independent of 052 — either order, either alone; unlike 052 this one is ready and should ship with the next batch. **SUPERSEDED BY 057 — do not apply this file if 057 has already run.** `057_member_identity.sql` §3 drops and recreates `team_members_list` and its version already carries `deleted_at` forward, plus adds `avatar`/`avatar_color`. Applying 057 alone is sufficient — 053 needs no separate apply once 057 has run. **WARNING FOR WHOEVER RE-VERIFIES THIS ROW:** the query above (`deleted_at` present) reads TRUE once 057 alone has been applied, because 057's redefinition includes that column. A green result on that query is NOT proof this file ran — check `select proname from pg_proc where proname = 'team_members_list' and prosrc like '%avatar_color%'` too; if avatar_color is present, what is live is 057's definition, not this file's, and this row should stay "NOT applied" (057's row is the one to mark applied instead). Applying 053 AFTER 057 reverts `team_members_list` to a definition with no avatar columns — see 057's row and `APPLY-RUNBOOK.md`'s row 15 for the consequence. |
| 054 `sec_jamal_01` | applied | **Re-verified 2026-08-08**, after this row spent time saying NOT applied while production already had it. Settled by running all three of the file's own nominated queries, not by reading the file. (1) `select has_function_privilege('anon', 'public.projects_materialize_access()'::regprocedure, 'EXECUTE');` → `false` (criterion: false). (2) `select prosrc from pg_proc where proname = 'peek_invite';` → nulls `team_name` on an invalid invite (criterion: met). (3) `select pg_get_functiondef('public.can_see_project(uuid)'::regprocedure);` → terminal arm is `false` (criterion: met). All three criteria are the file's own. The file's own header carries the matching APPLIED stamp, same date, same three results |
| 055 `team_insights_rollup` | **NOT applied** | `select proname, pronargs from pg_proc where proname = 'team_insights_rollup';` — applied when exactly one row comes back with `pronargs = 3`. New function, writes no data, replaces nothing; rollback is a drop (`supabase/rollback/pre-055-team-insights-rollup.sql`). Carries its own `revoke ... from public, anon`, so it does not wait on 042 to be safe. File on `agent-insights-agg` |
| 056 `team_feed_revoke_public` | **NOT applied** | `select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE';` — applied when it returns 0 (grantee 0 is PUBLIC). Takes `team_feed` off the default PUBLIC grant that four separate drop+create migrations (013, 014, 017, 025) kept restoring, and that 054:201's `from anon` revoke did not remove. Live ACL read with `aclexplode` 2026-08-08: PUBLIC, `authenticated`, `postgres` and `service_role` all hold EXECUTE, so the only change is dropping PUBLIC. The paired grant is a no-op today and is there for the next drop+create, which discards every grant. `authenticated`'s direct grant is NOT explained by the tree — provenance unknown, recorded in the file. Self-verifying: pre- and post-guards `raise exception` rather than no-op. Rollback `supabase/rollback/pre-056-team-feed-revoke-public.sql`. File on `agent-insights-agg` |
| 057 `member_identity` | **NOT applied** | `select proname, prosecdef from pg_proc where proname in ('set_display_name','normalize_member_name','unique_member_name','team_members_dedupe_name');` — applied when all four exist and the three non-`normalize_member_name` rows carry `prosecdef = true`. `select pronargs from pg_proc where proname = 'set_display_name';` — applied when it returns `3` (p_name, p_avatar, p_avatar_color), not `2`. Also: `select indexdef from pg_indexes where indexname = 'team_members_display_name_unique';` — applied when it returns a partial unique index. New columns (`team_members.avatar`, `team_members.avatar_color`, `team_members.name_released_at`), a new trigger, and new functions. **One existing function IS dropped and recreated, not additive**: `team_members_list` (053) predated avatar/avatar_color and this file's §3 adds them to its `returns table`, which `create or replace` cannot do to an existing function — same constraint 053 itself hit adding `deleted_at`. `select user_id, avatar, avatar_color from public.team_members_list('<a team id>');` — applied when the two columns come back (existing callers untouched; this is purely additive to the *shape*, not a behavior change to who can see what). **The drop discards `team_members_list`'s ACL** (the same treadmill fact this ledger already tracks for `team_feed` at 053 and 056) — §3 re-issues `revoke execute ... from public, anon` and `grant execute ... to authenticated, service_role` in the same block; `select count(*) from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.team_members_list(uuid)'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE';` — applied-and-correct when it returns `0` (no PUBLIC grant). **SUPERSEDES 053**: §3's `team_members_list` also carries 053's `deleted_at` column, so applying this file makes 053's own applied-criterion read true even though 053 never ran — see 053's row above; do not treat that query result as evidence 053 was applied, and do not apply 053 after this file (it would drop `avatar`/`avatar_color`). `unique_member_name` opens with `pg_advisory_xact_lock` to close a race through the bare `on conflict do nothing` in join_team/redeem_invite/redeem_onboarding_invite — schema.sql and 010_security_hardening.sql both got a one-line comment update alongside this file, no behavior change in either. File on `feat/member-identity-rename` |

## Migration history table

`supabase_migrations.schema_migrations` holds exactly TWO rows — `create_waitlist`
(20260719233141) and `create_feedback_table` (20260722043842). Neither corresponds
to a numbered file above. **Never `supabase db push` against this project**: it
would replay every numbered file, including 029's row-writing backfill, against a
database that already has most of their effects.

Some older files and docs say the live DB has "no migration history". That is
imprecise — the table exists with those two rows — but the operational conclusion
is unchanged, so it has been left alone rather than churned.
