-- ---------------------------------------------------------------------------
-- 018 — raise the summary cap to match the wire, and reconcile repo/live drift.
--
-- LIVE SHAPE UNVERIFIED AS OF 2026-08-05. §3 reconstructs public.waitlist from
-- an audit run before this ledger existed; the reading has not been repeated
-- since. Settle it with:
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'waitlist' order by ordinal_position;
-- then replace this marker with LIVE SHAPE VERIFIED <date>. Note the file's own
-- caveat: the audit captured types and nullability but NOT defaults, so the
-- defaults asserted here are convention rather than observation.
--
-- Written after a live-state audit (supabase/AUDIT-live-state.sql) found the
-- repo and the production database disagreeing in three places. Two of those
-- are harmless bookkeeping. The first is a live bug that has been silently
-- breaking team sync.
--
-- Re-runnable and guarded throughout, matching 009/013/016: every statement is
-- a no-op when its effect is already present, so this is safe on production
-- (where parts are already true) and correct on a fresh database.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. THE LIVE BUG — summary cap 400 vs a client that sends 4000.
--
-- lib/teamsync.js:43 sets WIRE_SUMMARY_MAX = 4000 and line 627 pushes
-- `scrub(summaryFull || summary, WIRE_SUMMARY_MAX)`. The database still
-- carries the original `char_length(summary) <= 400` from schema.sql:63, which
-- predates the full-summary-parity work (b297527).
--
-- Why this is worse than one rejected row: lib/teamsync.js's upsertEntries
-- POSTs the whole batch in one request and only knows how to recover from a
-- MISSING COLUMN error (PGRST204 — it drops that column and retries). A CHECK
-- violation does not match that pattern, so it rethrows and the ENTIRE BATCH
-- fails. One session with a summary over 400 characters therefore blocks every
-- other entry in the same push.
--
-- Distilled summaries routinely exceed 400 characters — that is what
-- distillation produces — so in practice substantive sessions have been
-- failing to reach teammates while short ones got through. This is the most
-- likely cause of teammate summaries rendering as "no summaries shared".
--
-- 4000 is chosen to match WIRE_SUMMARY_MAX exactly, keeping the constraint as
-- the safety net against pathological payloads that lib/teamsync.js's own
-- comment describes, rather than dropping the bound entirely.
--
-- NOTE the deliberate asymmetry: `ask` stays at 400. The verbatim prompt is
-- clipped by policy and its unclipped twin is machine-local — a pinned
-- invariant (lib/teamsync.js:621). Do not "fix" ask to match.
-- ---------------------------------------------------------------------------
do $$
declare
  current_def text;
begin
  select pg_get_constraintdef(oid) into current_def
  from pg_constraint
  where conrelid = 'public.memory_entries'::regclass
    and conname = 'memory_entries_summary_check';

  -- Only act when the constraint exists AND still carries the old bound.
  -- Absent (fresh DB before schema.sql's inline check) or already 4000 -> skip.
  if current_def is not null and current_def like '%400)%' and current_def not like '%4000)%' then
    alter table public.memory_entries drop constraint memory_entries_summary_check;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.memory_entries'::regclass
      and conname = 'memory_entries_summary_check'
  ) then
    alter table public.memory_entries
      add constraint memory_entries_summary_check check (char_length(summary) <= 4000);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. DRIFT: memory_entries.files is nullable in production, NOT NULL in the
-- repo (schema.sql:51).
--
-- Production is the correct one here — a ciphertext-only push (plaintextOff)
-- nulls this column by design, so a NOT NULL rebuild would reject every
-- encrypted push. The repo has simply never recorded the fix that was applied
-- by hand. This makes it reproducible.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memory_entries'
      and column_name = 'files' and is_nullable = 'NO'
  ) then
    alter table public.memory_entries alter column files drop not null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. DRIFT: the `waitlist` table exists in production and nowhere in the repo.
--
-- Recorded here so a fresh environment (new region, disaster recovery, a
-- second developer) builds the same database. Shape taken verbatim from the
-- live audit; the anon INSERT policy validates the address and bounds both
-- fields, and there is deliberately NO select policy — anonymous callers may
-- submit but never read the list back. Same shape as `feedback`.
--
-- Defaults are asserted to match the convention used by every other table in
-- this schema (gen_random_uuid() / now()); the audit captured column types and
-- nullability but not defaults. On production this block is skipped entirely,
-- so a mismatch here can only ever affect a freshly built database.
-- ---------------------------------------------------------------------------
create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  source text not null,
  created_at timestamptz not null default now()
);

alter table public.waitlist enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'waitlist'
      and policyname = 'anon can join waitlist'
  ) then
    create policy "anon can join waitlist" on public.waitlist
      for insert to anon
      with check (
        email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
        and length(email) <= 254
        and length(source) <= 64
      );
  end if;
end $$;

-- The policy alone is not enough: without the table grant, anon inserts fail
-- before RLS is ever consulted. 015_feedback.sql pairs its policy with the
-- same grant. Idempotent — re-granting is a no-op.
grant insert on public.waitlist to anon;

-- ---------------------------------------------------------------------------
-- 4. PROVENANCE — what was applied by hand and never committed.
--
-- Recorded as a comment rather than a table so it travels with the migration
-- history it explains:
--
--   * The join-seal RLS fix was applied directly to production. Its SQL was
--     never committed, and the number it would have taken (015) was later
--     reused by 015_feedback.sql. Live policy inventory now shows
--     team_keys_delete_own, team_keys_insert, team_keys_select_members — all
--     present and accounted for.
--   * memory_entries.files was made nullable by hand (reconciled in §2).
--   * The waitlist table was created by hand (reconciled in §3).
--
-- Production carries master's 016 (the team_keys DELETE policy). The competing
-- 016 on feat/multidevice-e2e — which adds device_id, rewrites both primary
-- keys, and DELETEs every member_pubkeys row — has NEVER been applied. Live
-- primary keys are still (user_id) and (team_id, epoch, member_user_id), and
-- the 3 published-key rows are intact. That branch must be renumbered before
-- it can ever be merged; its current number reads as already-applied.
-- ---------------------------------------------------------------------------
