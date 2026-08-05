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
| 031 `ensure_rls_event_trigger` | **NOT applied** | `ensure_rls` trigger exists but predates the repo; live `rls_auto_enable` lacks 031's fail-closed body. The file is a RECONSTRUCTION — and diffing it against the live body (done 2026-08-05) found a real defect: it drops `partitioned table` from the guardrail's filter. **Fix that line before applying.** Full diff and safety analysis in 031's header; pinned by `test/suites/rls-guardrail.test.js` |
| 032 `materialize_project_access_on_insert` | applied | `projects_materialize_access` trigger on `projects` |
| 033 `enforce_project_access_on_write` | applied | `memory_entries_insert`/`_update` both contain `can_see_project` |
| 034 `project_access_lookup_index` | applied | index `project_access_project_member_idx` exists |
| 035 `delete_own_entries` | applied | `memory_entries_delete` policy + `delete_my_entries()` + `my_entry_counts()` exist |

## Live RLS survey — 2026-08-05, read-only

Prompted by `031` being unapplied: production has a version of the RLS net that
notices a failure and continues, so the guarantee "no table in `public` without
row-level security" is not actually enforced. What that has cost so far:

**Nothing yet. No table in `public` has RLS disabled — all 15 have it enabled.**
Reported as the headline because it is the useful answer, and because the
permissive branch never having fired is also the evidence that applying `031`
is safe (see its header).

Four `public` tables have **RLS enabled with zero policies**, which denies
everything. That is safe, and in all four cases it is also correct rather than a
broken feature — each one's real access path bypasses RLS legitimately:

| Table | Reached by | PostgREST-reachable? |
|---|---|---|
| `invite_attempts` | `check_invite_attempt()`, `security definer` | **No** — `010:153` revoked anon/authenticated |
| `onboarding_invites` | `redeem_onboarding_invite()`, `security definer` | Yes, but denied (no policy) |
| `ops_audit` | `ops_log()` / `ops_audit_recent()`, `security definer`, `service_role` only | Yes, but denied |
| `ops_team_meta` | ops RPCs, `service_role` only | Yes, but denied |

The ops dashboard reads these through `cloudflare/ops-api`, which authenticates
with `SUPABASE_SERVICE_KEY` — `service_role` bypasses RLS outright — so the
zero-policy state breaks no feature. Checked rather than assumed.

**The one thing worth fixing (latent, not live).** `invite_attempts` was
explicitly revoked from `anon, authenticated` in `010:153`. The other three
never were, so they still carry Supabase's default blanket `arwdDxtm` grant to
both roles, and their *only* protection is the single property "RLS on with zero
policies". `onboarding_invites` holds unredeemed invite tokens. One
`alter table ... disable row level security`, or one later `for all` policy
scoped more loosely than intended, turns it into an anon-readable token dump —
and `031`'s net does not help, because it only fires on CREATE. The house pattern
for this already exists; it is one `revoke all on table ... from anon,
authenticated` per table, matching `010:153`. Product change, so not made here.

Also checked and clean: `public.project_stats` is the only view in `public` and
has `security_invoker = on`, so it respects the caller's RLS rather than running
as its owner. Tables in `auth`, `storage`, `realtime` and `vault` are
Supabase-managed and out of scope.

## Migration history table

`supabase_migrations.schema_migrations` holds exactly TWO rows — `create_waitlist`
(20260719233141) and `create_feedback_table` (20260722043842). Neither corresponds
to a numbered file above. **Never `supabase db push` against this project**: it
would replay every numbered file, including 029's row-writing backfill, against a
database that already has most of their effects.

Some older files and docs say the live DB has "no migration history". That is
imprecise — the table exists with those two rows — but the operational conclusion
is unchanged, so it has been left alone rather than churned.
