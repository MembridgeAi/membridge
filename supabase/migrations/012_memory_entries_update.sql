-- 012_memory_entries_update.sql
--
-- Per-session prompt sharing lets a user retroactively backfill or scrub the
-- verbatim prompt on already-synced rows. reshareSession does this by re-pushing
-- the session's rows with PostgREST `resolution=merge-duplicates`, which compiles
-- to `INSERT ... ON CONFLICT (...) DO UPDATE`. Postgres applies the table's
-- UPDATE RLS policy to that DO-UPDATE branch — and memory_entries had only
-- SELECT and INSERT policies, so the update was silently blocked and the row
-- kept its original (un-scrubbed) prompt. Add an UPDATE policy scoped exactly
-- like the insert policy: an author may update only their own rows, and only
-- within a team they belong to.
--
-- Without this migration on the live backend, "Hide from team" / "Share" toggles
-- appear to work in the UI but never change what teammates already pulled.

-- SUPERSEDED BY 033_enforce_project_access_on_write.sql §2, which added
-- `and public.can_see_project(project_id)` so a member revoked from a project
-- can no longer update rows in it. This file has no `drop policy` and so was
-- never the clobbering kind — but an unguarded `create policy` on a database
-- that already has the tightened version simply ERRORS ("policy already
-- exists"), which is its own way of making a re-run unsafe to paste.
--
-- Guarded rather than restated: writing 033's terminal predicate here would
-- introduce a forward reference to can_see_project, which does not exist until
-- 028 — thirteen migrations after this one — so a from-scratch replay would
-- fail on a function that has not been defined yet. The guard has no such
-- problem and needs no knowledge of the future.
-- Convention from 009:72-77; enforced by
-- test/suites/invite-lifetime-hardening.test.js.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'memory_entries' and policyname = 'memory_entries_update') then
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
  end if;
end $$;
