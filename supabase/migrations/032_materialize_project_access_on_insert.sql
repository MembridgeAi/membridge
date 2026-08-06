-- 032_materialize_project_access_on_insert.sql — make 029's central invariant
-- ("every (member, project) pair has an explicit project_access row") a
-- property of the SCHEMA instead of a convention the client happens to follow.
--
-- WHY THIS EXISTS. 029_materialize_project_access.sql §3 states the gap in its
-- own words and deliberately leaves it open:
--
--   "THE INVARIANT THIS BUYS IS A CLIENT CONVENTION, NOT A SCHEMA CONSTRAINT.
--    Nothing forces a project to be created through this RPC: the live
--    `projects_insert` policy lets an ordinary team member POST straight to
--    /rest/v1/projects, creating a projects row without ever calling
--    link_project and therefore without materializing a single access row.
--    Every member is then row-less on that project and governed by tier 2 —
--    the retroactive behaviour this migration exists to remove."
--
-- This is that ticket. A row-less project is not a cosmetic problem: tier 2 is
-- the project's own `default_access`, so a project created off the RPC path is
-- retroactively governed by a flag 028/029 exist specifically to stop applying
-- to existing members, and flipping that flag later silently moves everybody.
--
-- WHAT IT DOES NOT DO, AND WHY — `projects_insert` IS LEFT ALONE.
-- The obvious alternative was to revoke the direct-POST capability instead of
-- covering it. Two findings, in order:
--
--   1. NOTHING LEGITIMATELY POSTS TO public.projects. The only writer in the
--      whole tree is link_project, called once, at lib/teamsync.js:1206. The
--      complete set of PostgREST writes the client performs is project_access,
--      rpc/set_project_access_default, team_audit (lib/api-access.js:132,174,375),
--      team_keys, memory_entries, member_pubkeys and rpc/<fn>
--      (lib/teamsync.js:725,861,1698,351) — `projects` appears in none of them.
--      Corroborated independently by the offline stand-in: test/mock-supabase.js
--      routes /rest/v1/projects for GET only and never needed a POST branch.
--      So the policy grants a capability no client uses.
--
--   2. REVOKING IT ANYWAY WOULD REST ON A FACT THAT CANNOT BE READ FROM THIS
--      REPO. link_project is `security definer`; whether its own INSERT into
--      public.projects survives the loss of `projects_insert` depends on
--      whether the function's OWNER bypasses RLS, which is a property of the
--      live database, not of any file here. Today link_project satisfies
--      `projects_insert` on its own terms (it inserts with created_by =
--      auth.uid() after an is_team_member check), so it works whether or not
--      the owner bypasses RLS. Dropping the policy would convert that
--      don't-care into a hard dependency on an unverified fact, and if the
--      assumption were wrong the failure is total: no member could create a
--      project at all.
--
-- The trigger below closes the actual harm — a row-less project — on EVERY
-- insert path, including the direct POST, without taking that bet. Whether to
-- additionally revoke the unused capability is a separate, smaller decision for
-- a human with a psql prompt; the query that settles it is in §3.
--
-- RISK CLASS: DDL ONLY. This migration replaces a function and creates a
-- trigger. It writes no rows and deletes none, so it is reversible by dropping
-- the trigger (see supabase/rollback/pre-032-project-insert-trigger.sql).
-- NO BACKFILL IS INCLUDED and none is needed: 029 §4 already backfilled every
-- (existing member, existing project) pair, and every project created since is
-- either from link_project (which materializes) or from a direct POST that no
-- client makes. If a human wants belt and braces anyway, 029 §4's backfill is
-- idempotent (`on conflict do nothing`, no `do update`) and can simply be re-run.
--
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` IN THIS PROJECT.
-- Same reason 031 gives: supabase_migrations.schema_migrations holds only two
-- rows, so a push would attempt every numbered file against a database that
-- already has most of their effects, including 029's row-writing backfill.
-- Paste this file into the SQL editor, which runs it in one transaction. Every
-- statement below is re-runnable.
--
-- APPLIED — live on project mefgbiecvoszjorwzkfz, verified read-only 2026-08-05.
-- This line said "UNAPPLIED AS OF THIS COMMIT" for four releases after the
-- statements below had already been run, which is worse than saying nothing:
-- it invites someone to re-apply a live migration, and it under-reports what
-- the backend already enforces. Re-check it, do not trust it:
--
--   select pg_get_triggerdef(t.oid) from pg_trigger t
--    where t.tgname = 'projects_materialize_access' and not t.tgisinternal;
--
-- Returned, at the time of writing: CREATE TRIGGER projects_materialize_access
-- AFTER INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION
-- projects_materialize_access() — matching §2 below exactly.

-- ---------------------------------------------------------------------------
-- 1. The trigger function.
--
-- `security definer` is REQUIRED, not stylistic: project_access_insert
-- (024:78) is `with check (public.is_team_manager(team_id))`, and an INSERT
-- that fails a WITH CHECK policy RAISES rather than skipping. Without definer
-- rights an ordinary member creating a project would abort on this trigger and
-- project creation would break for everyone who is not an owner or admin.
--
-- This is the SAME mechanism 029 §3 already relies on: link_project's own
-- materialization inserts rows for OTHER members, which no ordinary member
-- could do under project_access_insert either. So this adds no new dependency
-- and no new risk class — it reuses one that is already live.
--
-- Body deliberately mirrors 029 §3's insert statement rather than improving on
-- it, so the two paths cannot drift into disagreeing about what a materialized
-- row looks like:
--   * team_id and can_see are read from the PROJECT ROW (NEW), never from a
--     literal, so they cannot disagree with the project they describe.
--   * can_see takes default_access AS AT INSERT TIME, which is what makes the
--     flag govern arrivals rather than rewriting history.
--   * `on conflict do nothing` on the (team_id, project_key, member_id) primary
--     key (024:37): an existing row is NEVER rewritten, so a deliberate
--     can_see = false can never be undone by this trigger. There is no
--     `do update` here and there is none in 029 either.
--
-- Returns NULL, which is correct and intentional for an AFTER trigger: the
-- return value of an AFTER ... FOR EACH ROW trigger is ignored by Postgres.
create or replace function public.projects_materialize_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_access (team_id, project_key, member_id, can_see)
    select new.team_id, new.id::text, m.user_id, new.default_access
      from public.team_members m
      where m.team_id = new.team_id
    on conflict (team_id, project_key, member_id) do nothing;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The trigger.
--
-- AFTER INSERT, FOR EACH ROW. AFTER rather than BEFORE so the project row is
-- already durable when its access rows are written, and per-row rather than
-- per-statement because the rows are derived from NEW.
--
-- `create trigger` has no `if not exists` / `or replace` in the Postgres
-- versions this project targets, so it is dropped first — same convention
-- 024's policies use (see 011_backend_hardening.sql §1's note) and the reason
-- this file is safe to re-run.
--
-- SCOPE IS INSERT ONLY. Nothing fires on UPDATE: a project does not change
-- teams, and re-deriving access rows on an unrelated column change (a rename,
-- an archive) would be a second writer to rows a manager may have deliberately
-- set. `default_access` changes are already handled where they belong, by
-- set_project_access_default, and 029's whole point is that flipping that flag
-- must NOT move existing members.
drop trigger if exists projects_materialize_access on public.projects;
create trigger projects_materialize_access
  after insert on public.projects
  for each row
  execute function public.projects_materialize_access();

-- ---------------------------------------------------------------------------
-- 3. THE QUESTION THIS FILE DELIBERATELY DOES NOT ANSWER.
--
-- Whether `projects_insert` should exist at all. Finding 1 above says no client
-- needs it; finding 2 says revoking it safely depends on whether link_project's
-- owner bypasses RLS, which is not readable from this repo. These two queries
-- settle it, run as a superuser against the live database:
--
--   -- Does link_project's owner bypass RLS? If rolbypassrls is true, dropping
--   -- projects_insert cannot break link_project.
--   select p.proname, r.rolname, r.rolbypassrls, r.rolsuper
--     from pg_proc p
--     join pg_roles r on r.oid = p.proowner
--    where p.proname = 'link_project'
--      and p.pronamespace = 'public'::regnamespace;
--
--   -- And is public.projects itself force-RLS? (FORCE applies policies to the
--   -- owner too, which would change the answer above.)
--   select relname, relrowsecurity, relforcerowsecurity
--     from pg_class where oid = 'public.projects'::regclass;
--
-- If rolbypassrls is true and relforcerowsecurity is false, then
--   drop policy if exists projects_insert on public.projects;
-- is safe, and reduces the surface this trigger currently only covers. That is
-- a one-line follow-up ticket, not a widening of this one.
