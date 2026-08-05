-- Rollback for 033_enforce_project_access_on_write.sql.
--
-- OUTSIDE supabase/migrations/ ON PURPOSE so nothing applies it by accident —
-- same placement and reasoning as the other files in this directory.
--
-- PROVENANCE, AND ITS ONE WEAKNESS. These two bodies are copied from the REPO
-- (schema.sql:124-127 for insert, 012_memory_entries_update.sql:16-25 for
-- update), NOT read out of the live database — this environment has no database
-- access. For every other rollback in this directory that would be a caveat
-- worth worrying about, because a hand-applied fix could have diverged. Here it
-- is narrower than usual but still real: if production's memory_entries_insert
-- or memory_entries_update differs from what these two files say, running this
-- restores the REPO's version and silently discards that divergence.
--
-- Settle it before running this, with:
--   select polname, pg_get_expr(polqual, polrelid)     as using_expr,
--          pg_get_expr(polwithcheck, polrelid)         as check_expr
--     from pg_policy
--    where polrelid = 'public.memory_entries'::regclass
--      and polname in ('memory_entries_insert', 'memory_entries_update');
-- If the output matches the bodies below minus the can_see_project conjunct,
-- this file is an exact revert. If it does not, restore what that query printed
-- instead of what is written here.
--
-- WHAT IT CANNOT UNDO: nothing, in terms of data — 033 writes no rows. But note
-- what running it MEANS rather than what it changes: it reopens write-only
-- access to revoked projects, so any revoked member's daemon resumes uploading
-- into projects they cannot read, on its next sync pass, with no further signal.
-- Do not run it to silence a push error; that error is the feature.
--
-- Safe to run twice; safe to run if 033 was never applied.
drop policy if exists memory_entries_insert on public.memory_entries;
create policy memory_entries_insert on public.memory_entries
  for insert with check (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
  );

drop policy if exists memory_entries_update on public.memory_entries;
create policy memory_entries_update on public.memory_entries
  for update
  using (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
  )
  with check (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
  );
