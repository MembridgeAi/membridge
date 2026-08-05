-- 031_ensure_rls_event_trigger.sql — commit production's `ensure_rls` event
-- trigger, the safety net that makes it impossible to ship a table in `public`
-- without row-level security by accident.
--
-- WHAT PRODUCTION HAS AND THIS REPO DID NOT: an event trigger `ensure_rls` on
-- ddl_command_end executing public.rls_auto_enable(), which on every
-- CREATE TABLE / CREATE TABLE AS / SELECT INTO in the `public` schema runs
-- `alter table if exists <table> enable row level security`. Neither the trigger
-- nor the function appears anywhere in supabase/, so a database rebuilt from
-- these migrations has no such net, and the next table added to `public` — by a
-- migration, by the dashboard, or by a `create table as` in a one-off script —
-- ships readable by anyone with the anon key until somebody notices.
--
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` IN THIS PROJECT.
-- supabase_migrations.schema_migrations holds only TWO rows, so none of the
-- repo's numbered files is recorded as applied and a push would attempt all
-- thirty-plus of them against a database that already has most of their effects
-- (including 029's row-writing backfill). Paste this file into the Supabase SQL
-- editor, which runs it in one transaction — and note §2's elevated-rights
-- requirement, which a push would hit as a hard failure anyway. Every statement
-- below is re-runnable.
--
-- ---------------------------------------------------------------------------
-- !! A FAILED RLS ENABLE IS DELIBERATELY FATAL — THIS IS THE DECISION !!
--
-- §1's exception branch raises instead of swallowing. If RLS cannot be enabled
-- on a new table in `public`, the CREATE TABLE that triggered the net is
-- ABORTED — the trigger fires inside that statement's own transaction. That is the
-- intended trade, chosen explicitly and with its cost understood: a table that
-- cannot be protected should not exist.
--
-- What it replaces: production's branch only does `raise log`. Under that
-- version a failure to enable RLS is invisible — the CREATE TABLE succeeds, the
-- table has no RLS, and the only trace is one line in a Postgres log nobody
-- reads. That is this codebase's signature defect (a success path that swallows
-- its own failure) landing on a security control, which is the worst place for
-- it. A silent gap is strictly worse than a loud refusal here, because the gap
-- is *readable by anyone holding the project's anon key* and nothing else in the
-- stack will notice.
--
-- The cost, stated plainly so nobody is surprised by it: a caller who cannot fix
-- the cause can no longer create a table in `public` at all, and a multi-statement
-- migration or a dashboard action can now abort mid-flight where it previously
-- carried on. `raise log` is kept alongside the raise on purpose — log output
-- is not rolled back with the transaction, so the cause is still recorded even
-- when the caller only ever sees the abort.
--
-- BLAST RADIUS, read out of this schema rather than assumed:
--   * The filter is unchanged, so scope is unchanged: only `CREATE TABLE` /
--     `CREATE TABLE AS` / `SELECT INTO`, only object_type `table`, only schema
--     `public`. `CREATE TEMP TABLE` lands in a pg_temp_N schema and so is
--     already out of scope; `CREATE FOREIGN TABLE`, views and matviews report
--     other object types and are already out of scope.
--   * NO PARTITIONED TABLES AND NO PARTITIONS EXIST IN THIS SCHEMA —
--     `grep -in partition supabase/` returns nothing across all 31 migrations.
--     Partition children were the case worth checking, since they arrive as
--     ordinary `CREATE TABLE ... PARTITION OF` and would each have to take RLS
--     of their own. They do accept it (nothing in ALTER TABLE restricts RLS by
--     partition status), and in any case none occur here, so no exemption is
--     warranted and none is added.
--   * `create extension` appears once in the whole repo, and it targets the
--     `extensions` schema, not `public` (010). So no extension in this project
--     installs a table into `public`, and no `CREATE EXTENSION` here can be
--     aborted by this trigger. UNVERIFIED AND OUT OF THIS FILE'S REACH: whether
--     Postgres fires ddl_command_end for DDL inside an extension script at all
--     (the documentation does not say, and the shared-object exclusions it does
--     list do not cover extensions). If a future extension is ever installed
--     into `public`, settle it first — install it on a scratch database with
--     this trigger present and see whether it completes.
--   * The `select ... into` hits in 002/005/010/018/021 are plpgsql variable
--     assignment, NOT the SQL `SELECT INTO` that creates a table. They emit no
--     such command tag and are not in scope.
--   * All 11 tables this repo creates in `public` are plain tables and each one
--     already runs its own `enable row level security` in the same migration
--     (13 occurrences). For every one of them the trigger's ALTER is redundant
--     and cannot fail on an ownership ground the migration itself would not have
--     hit one statement later.
--   * The one remaining way to reach the new fatal path is the ALTER being
--     refused — in practice the new table not being owned by the owner of
--     `public.rls_auto_enable()`, so the definer ALTER is not permitted. That is
--     exactly the case that must be loud: under the old branch it produced a
--     table in `public` with RLS off.
-- ---------------------------------------------------------------------------
--
-- ---------------------------------------------------------------------------
-- !! READ BEFORE APPLYING THIS TO PRODUCTION — §1 IS A RECONSTRUCTION !!
--
-- 030 could state that it was a no-op in production because its function body
-- was transcribed from pg_proc verbatim. THIS FILE CANNOT. §1's body was
-- written to match the BEHAVIOUR described above (definer, search_path
-- pg_catalog, the three command tags, the public-schema filter, the
-- alter-if-exists), not copied from the live definition — and its exception
-- branch now differs from production's ON PURPOSE, per the decision above.
-- `create or replace` therefore OVERWRITES production's copy with this file,
-- which is a change, not a no-op. It is a function replacement, not a data
-- write, so it is reversible by replacing the function back:
-- supabase/rollback/pre-031-rls-auto-enable.sql holds the text that does that,
-- and sits outside supabase/migrations/ so nothing applies it by accident.
--
-- Before applying to production, diff it against the live definition:
--   select pg_get_functiondef('public.rls_auto_enable()'::regprocedure);
-- If they differ OUTSIDE the exception branch — a different command-tag list, a
-- different schema filter, a missing `if exists` — production is doing something
-- this reconstruction does not, so port that difference into §1 and keep this
-- header. Do NOT copy the live exception branch back: replacing it is the entire
-- point of this file's current form. On a FRESH database (the case this file
-- originally existed for) there is nothing to overwrite and it applies as-is.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- §1 public.rls_auto_enable() — the event-trigger function.
--
-- `security definer` is required, not stylistic: the trigger fires as whoever
-- ran the CREATE TABLE, and that role may not own the new table, so the ALTER
-- has to execute as the function owner to be permitted at all.
--
-- `set search_path to 'pg_catalog'` matches production and is the correct
-- hardening for a definer function: it fires implicitly on DDL run by other
-- roles, so a schema-resolution hijack here would execute as the owner.
-- Everything the body needs (pg_event_trigger_ddl_commands, format) lives in
-- pg_catalog; nothing is looked up in public.
--
-- obj.object_identity is used for the ALTER rather than assembling
-- schema_name/table name by hand — it is already schema-qualified and correctly
-- quoted by Postgres, so a table named e.g. "my table" cannot break the EXECUTE.
--
-- `alter table if exists` is what makes the ALTER safe against a table dropped
-- between the CREATE and this trigger firing in the same transaction. It
-- matters more now that the exception branch is fatal: a vanished table is a
-- no-op with a notice, NOT an error, so that case still does not abort anything.
--
-- The filter is deliberately narrow. Only `public` is covered: enabling RLS on
-- tables created in auth / storage / realtime / extensions schemas would fight
-- Supabase's own platform migrations. And only table creations are covered —
-- ALTER TABLE is not a create, and views/matviews take no RLS.
--
-- The exception branch REFUSES THE CREATE. See the decision block in this
-- file's header for why, and for the blast radius that made it safe to take.
-- The message is written for a human reading it in the Supabase SQL editor with
-- no context: it names the table, quotes the underlying error and SQLSTATE, says
-- that the CREATE was rolled back and why that is the safe outcome, and points
-- at the actual fix. A bare re-raise (`raise;`) would have surfaced only
-- "must be owner of table x", which does not tell that operator that an event
-- trigger they have never heard of is the thing refusing them.
-- ---------------------------------------------------------------------------
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands()
  loop
    if obj.command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       and obj.object_type = 'table'
       and obj.schema_name = 'public'
    then
      begin
        execute format('alter table if exists %s enable row level security',
                       obj.object_identity);
      exception when others then
        -- Logged FIRST and separately: log output is not rolled back with the
        -- transaction, so the cause is recorded even for a caller who only ever
        -- sees the abort (a psql script, a migration runner, a CI step).
        raise log 'rls_auto_enable: could not enable RLS on %: % (SQLSTATE %)',
          obj.object_identity, sqlerrm, sqlstate;
        -- Then refuse the CREATE. Not `raise;` — see §1's header note on why the
        -- bare Postgres error is not enough for the operator who hits this.
        raise exception
          'rls_auto_enable: refusing to create % without row-level security',
          obj.object_identity
          using
            detail = format(
              'The ensure_rls event trigger ran "alter table if exists %s enable row level security" and it failed: %s (SQLSTATE %s). The statement that created the table has been rolled back on purpose: a table in the public schema with RLS off is readable by every client holding this project''s anon key, and nothing else in the stack would have reported it.',
              obj.object_identity, sqlerrm, sqlstate),
            hint = 'Most often the new table is not owned by the owner of public.rls_auto_enable(), so its SECURITY DEFINER alter is not permitted. Create the table as that role, or reassign ownership, then retry. Fix the cause -- do not drop the ensure_rls event trigger, and do not restore the log-and-continue exception branch this replaced.';
      end;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- §2 the event trigger itself.
--
-- `create event trigger` has no `if not exists` and no `or replace`, and unlike
-- a policy it must NOT be dropped and recreated blindly: between the drop and
-- the create the net is down, and if the transaction is rolled back at that
-- point on a database that had the trigger, the rollback restores it — but a
-- `psql` run WITHOUT -1 would leave production with no trigger at all. A guarded
-- create is the idempotent form that never removes a working trigger.
--
-- CREATING AN EVENT TRIGGER NEEDS ELEVATED RIGHTS. Postgres requires superuser;
-- on Supabase that means running this as a role permitted to do it
-- (supabase_admin), not necessarily the role a normal `db push` uses. If this
-- block raises "permission denied to create event trigger", that is the correct
-- and visible outcome — the net genuinely is not installed and someone has to
-- install it with the right role. Do not wrap this in an exception handler to
-- make the migration pass; that would reproduce, in this file, the exact defect
-- its header complains about.
--
-- The guard reads pg_catalog.pg_event_trigger explicitly rather than relying on
-- search_path, since the surrounding session's search_path is not this file's to
-- assume.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_event_trigger where evtname = 'ensure_rls'
  ) then
    create event trigger ensure_rls
      on ddl_command_end
      execute function public.rls_auto_enable();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §3 What this trigger does NOT do — so nobody mistakes it for coverage.
--
-- Enabling RLS on a table with no policies denies all access to non-owner
-- roles, which is fail-closed and therefore safe, but it is not the same as
-- being protected: the table is unusable rather than correct, and the fix is
-- still to write the policies. The trigger buys time, not correctness. Every
-- migration that creates a table must still create its policies in the same
-- file, exactly as 002-024 do; nothing here relaxes that.
-- ---------------------------------------------------------------------------
