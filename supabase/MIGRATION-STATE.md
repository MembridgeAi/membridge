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
| 031 `ensure_rls_event_trigger` | **NOT applied** | `ensure_rls` trigger exists but predates the repo; live `rls_auto_enable` lacks 031's fail-closed body. The file is a RECONSTRUCTION — diff before applying, `create or replace` would overwrite production's copy |
| 032 `materialize_project_access_on_insert` | applied | `projects_materialize_access` trigger on `projects` |
| 033 `enforce_project_access_on_write` | applied | `memory_entries_insert`/`_update` both contain `can_see_project` |
| 034 `project_access_lookup_index` | applied | index `project_access_project_member_idx` exists |
| 035 `delete_own_entries` | applied (other branch) | `memory_entries_delete` policy + `delete_my_entries()` + `my_entry_counts()` exist. The FILE is not on this branch — it lives on `agent-backend2` and the policy is live regardless, which is SEC-2's finding: the repo does not describe production until that branch merges |
| 037 `project_access_team_scope` | **NOT applied** | `select polname, pg_get_expr(polwithcheck, polrelid) from pg_policy where polname = 'project_access_insert';` — applied when the expression contains `exists` against `public.projects` |
| 038 `invite_redeem_atomic` | **NOT applied** | `select prosrc from pg_proc where proname = 'redeem_invite';` — applied when the body contains `get diagnostics` and a WHERE carrying `max_uses`. **Must land with the INV-1 client change, not after it** |
| 039 `team_audit_created_at` | **NOT applied** | `select tgname from pg_trigger where tgrelid = 'public.team_audit'::regclass;` — applied when `team_audit_stamp_created_at` is listed |
| 040 `revoke_memory_entries_delete` | **NOT applied** | `select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'memory_entries' and privilege_type = 'DELETE';` — applied when neither `anon` nor `authenticated` appears. The privilege is a Supabase PLATFORM DEFAULT that appears nowhere in `supabase/`, so the repo cannot tell you its state — only this query can |
| 042 `definer_function_hardening` | **NOT applied** | `select proname, proacl from pg_proc where proname in ('can_see_project','team_feed_counts','set_project_access_default');` — applied when no acl entry grants EXECUTE to `anon` or to PUBLIC. Carries a smoke test: seal a team key to a NEW joiner |
| 047 `ops_panel_roles` | **NOT applied** | `select rolname, rolbypassrls, rolcanlogin from pg_roles where rolname in ('ops_panel_read','ops_panel_write');` — applied when both exist with `rolbypassrls = f`. **Inert on its own**: it only ADDS roles and does not touch `service_role`, so the panel is unaffected until the Worker is redeployed with the new secrets. Full verification and rollback in the file |
| 043 `revoke_blanket_table_grants` | **NOT applied** | `select relname, relacl from pg_class where relname in ('onboarding_invites','ops_audit','ops_team_meta');` — applied when no acl entry names `anon` or `authenticated` |

## Migration history table

`supabase_migrations.schema_migrations` holds exactly TWO rows — `create_waitlist`
(20260719233141) and `create_feedback_table` (20260722043842). Neither corresponds
to a numbered file above. **Never `supabase db push` against this project**: it
would replay every numbered file, including 029's row-writing backfill, against a
database that already has most of their effects.

Some older files and docs say the live DB has "no migration history". That is
imprecise — the table exists with those two rows — but the operational conclusion
is unchanged, so it has been left alone rather than churned.
