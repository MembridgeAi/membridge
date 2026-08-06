-- 039_team_audit_created_at.sql — the audit trail stamps its own timestamps.
--
-- THE GAP. team_audit.created_at is `timestamptz not null default now()`
-- (024:49). A DEFAULT only applies when the inserting statement omits the
-- column, and PostgREST lets the caller name any column they have insert rights
-- on. team_audit_insert is `is_team_manager(team_id) and actor_id = auth.uid()`
-- (025:144), so a manager may insert rows — and nothing stops them choosing the
-- timestamp.
--
-- WHY THAT IS WORSE HERE THAN ALMOST ANYWHERE ELSE. team_audit has no UPDATE
-- and no DELETE policy, deliberately (025:139-141): the trail is append-only so
-- it can be trusted. Append-only makes a FALSE row permanent. A manager can
-- file an action at any time they like — before a leak, after an offboarding,
-- interleaved with real events — and neither they nor anyone else can remove it
-- afterwards. The property that makes the log trustworthy is the same property
-- that makes a forged row indelible.
--
-- 025 already closed the "who" half of this by requiring actor_id = auth.uid(),
-- so a manager can no longer name someone else as the actor. This closes the
-- "when" half. They are the same class of defect: a column the client is
-- trusted to fill in truthfully, in a table read back as evidence.
--
-- THE FIX is a BEFORE INSERT trigger rather than a check constraint, because
-- there is no constraint that expresses "equal to the time this statement ran"
-- — `check (created_at = now())` would compare against transaction start and
-- reject legitimate rows in a long transaction, and could not be re-run safely
-- against existing rows. Overwriting in a trigger states the intent exactly:
-- created_at is not an input.
--
-- TRADEOFF, stated because it is real: no caller can set created_at any more,
-- including a future backfill that wants to import historical audit rows with
-- their original timestamps. Nothing does that today (recordAudit in
-- lib/api-access.js is the only writer and always wants "now"). If such a
-- backfill is ever needed it should run as a migration that drops this trigger,
-- inserts, and recreates it — visibly, in one file — rather than the column
-- being left permanently writable on the off-chance.
--
-- EXISTING ROWS ARE NOT TOUCHED. Any row already backdated stays as it is;
-- this cannot detect one after the fact, since a forged timestamp is
-- indistinguishable from a real one. It only guarantees the property going
-- forward.
--
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` in this project, for
-- the reason 031, 032 and 033 all give. Both statements are re-runnable.
--
-- UNAPPLIED AS OF 2026-08-05. Nothing here has been run against any
-- database. State is recorded in supabase/MIGRATION-STATE.md; settle it with:
--   select tgname from pg_trigger where tgrelid = 'public.team_audit'::regclass;
--   -- applied when `team_audit_stamp_created_at` is listed
-- ---------------------------------------------------------------------------

create or replace function public.team_audit_stamp_created_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Unconditional: `coalesce(new.created_at, now())` would still let a caller
  -- who names the column pick the value, which is the whole finding.
  new.created_at := now();
  return new;
end;
$$;

-- `create trigger` has no `if not exists` / `or replace` before PG 14, and this
-- repo targets whatever Supabase runs, so drop-then-create. That is the correct
-- form HERE and only here: 039 introduces this trigger and holds its newest
-- definition, which is exactly the condition under which dropping your own
-- object is safe. See 024's policy-section header for the general rule.
drop trigger if exists team_audit_stamp_created_at on public.team_audit;
create trigger team_audit_stamp_created_at
  before insert on public.team_audit
  for each row execute function public.team_audit_stamp_created_at();
