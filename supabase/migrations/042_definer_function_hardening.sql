-- 042_definer_function_hardening.sql — close the two gaps the SEC-5 audit of
-- the `security definer` surface actually found, out of 37 functions.
--
-- WHY THIS SURFACE GETS ITS OWN AUDIT. A `security definer` function runs with
-- the DEFINER's rights and bypasses row level security completely. That is the
-- right tool in this schema — 030 exists precisely because a membership check
-- evaluated as the CALLER reads false for a member RLS is hiding — but it means
-- each such function must re-implement, in its own body, the check RLS would
-- otherwise have made. 025 §4 states it for team_feed: "the predicate must be
-- written into the function body itself, or a revoked member keeps reading the
-- project's feed forever through this one function".
--
-- WHAT THE AUDIT FOUND, so the negative result is on the record too. All 37
-- definer functions pin `set search_path` — that class is clean. Every function
-- taking a caller-supplied team or project id resolves it correctly:
-- archive_project, unarchive_project and set_project_access_default all read
-- the project's OWN team out of public.projects and then check
-- is_team_manager(that team) rather than trusting a team argument;
-- revoke_invite does the same via the invite's team; team_members_list,
-- team_feed, team_feed_counts and link_project all carry an is_team_member
-- check; set_role is owner-only and refuses self-edits; remove_member refuses
-- to remove an owner. The ops_* family is revoked from public, anon AND
-- authenticated and granted to service_role alone. peek_invite answers to a
-- bearer of the token, which is the credential, behind check_invite_attempt's
-- rate limit — deliberate, and left alone.
--
-- Two things were wrong. Neither is a data breach today; both are a two-layer
-- defence reduced to one, and the remaining layer is the one nobody re-reads.
--
-- ---------------------------------------------------------------------------
-- 1. THE DEFAULT PUBLIC GRANT.
--
-- PostgreSQL grants EXECUTE on a NEWLY CREATED function to PUBLIC by default.
-- 011:140 says so in as many words. A definer function with no revoke is
-- therefore callable with the anon key, which is public by design — 033's
-- header already names direct PostgREST callers as first-class.
--
-- 010:409 revoked team_feed from public, anon for exactly this reason. Its
-- sibling team_feed_counts arrived seventeen migrations later (027) with a
-- grant to authenticated and no revoke, so it kept the default PUBLIC grant.
-- can_see_project (028) and set_project_access_default (026) have no grant or
-- revoke statement at all.
--
-- None of the three leaks data today, and that is worth stating precisely
-- rather than hand-waving:
--   * team_feed_counts has `and public.is_team_member(p_team)` in its WHERE, so
--     an anon caller (auth.uid() is null) gets a row of zeros, not rows.
--   * set_project_access_default raises 'only a team owner or admin can change
--     this project's default access' for anon, because is_team_manager is false.
--   * can_see_project returns the project's default_access to an anon caller —
--     a project-existence-and-default oracle, and the only one of the three
--     that answers with anything at all.
-- The fix is not that any of these is currently exploitable. It is that all
-- three currently depend on a single internal check with nothing behind it.
--
-- NOT CHANGED, deliberately: projects_materialize_access (032) and
-- rls_auto_enable (031) are TRIGGER functions and keep the default grant. A
-- trigger function invoked directly raises "trigger functions can only be
-- called as triggers" before a single statement of its body runs, so the PUBLIC
-- grant confers nothing on a caller. Altering grants on a live trigger, by
-- contrast, risks the flow it serves — projects_materialize_access fires on
-- every project insert, and 032:73-77 already explains that project creation
-- breaks for non-managers without it. Documented and accepted rather than
-- half-fixed, in the manner 025 accepted its existence leak.
-- ---------------------------------------------------------------------------

revoke execute on function public.team_feed_counts(
  uuid, uuid, uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.team_feed_counts(
  uuid, uuid, uuid, text, timestamptz, timestamptz) to authenticated, service_role;

-- can_see_project is referenced by policies (memory_entries_select 025:47, and
-- the write policies 033 added). A policy expression is evaluated as the
-- CALLER, so `authenticated` genuinely needs EXECUTE here — revoking without
-- this grant would break every read it guards.
revoke execute on function public.can_see_project(uuid) from public, anon;
grant execute on function public.can_see_project(uuid) to authenticated, service_role;

revoke execute on function public.set_project_access_default(uuid, boolean) from public, anon;
grant execute on function public.set_project_access_default(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. is_team_member_uid TRUSTED BOTH ARGUMENTS.
--
-- The same bug shape 037 fixed at the policy layer, wearing a function-layer
-- costume: an argument that names a row, resolved without checking the caller
-- is entitled to an answer about that row.
--
--   is_team_member_uid(p_team, p_user) -> exists(team_members where
--                                                team_id = p_team
--                                                and user_id = p_user)
--
-- It is `security definer` (correctly — 030's whole point is that the inline
-- EXISTS it replaced was subject to RLS and so read false for a member RLS was
-- hiding), and 030:134-135 grants EXECUTE to `authenticated` because a policy
-- expression evaluates as the caller and therefore needs it. BOTH of those are
-- right and neither is the bug.
--
-- The bug is that the body answers for any pair. Any authenticated user can ask
-- "is user X a member of team Y" about a team they have never belonged to, or
-- one they were REMOVED from — and keep asking. Removal takes away their
-- team_members row and their RLS-mediated reads; it does not take away two uuids
-- they already wrote down. A departed member can therefore keep watching a
-- former teammate's membership indefinitely.
--
-- WHY ADDING THE CALLER CHECK CANNOT BREAK ANYTHING. The only call site in the
-- entire repo is team_keys_insert (030), which reads:
--
--   with check (public.is_team_member(team_id)
--               and public.is_team_member_uid(team_id, member_user_id))
--
-- The first conjunct ALREADY requires the caller to be a member of that team.
-- The new conjunct below is therefore redundant at that call site — it can only
-- be reached when it is already true — and load-bearing for a direct call,
-- which is the only place the oracle existed. Verified by grep: no other
-- reference in supabase/ or lib/.
--
-- The caller check is written as its own EXISTS on team_members rather than as
-- `public.is_team_member(p_team)` on purpose: is_team_member is itself definer
-- and would work, but nesting one definer helper inside another to answer a
-- question this function can answer directly adds a dependency for nothing.
-- ---------------------------------------------------------------------------

create or replace function public.is_team_member_uid(p_team uuid, p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (
      select 1 from public.team_members tm
      where tm.team_id = p_team and tm.user_id = p_user
    )
    and exists (
      select 1 from public.team_members caller
      where caller.team_id = p_team and caller.user_id = auth.uid()
    );
$$;

-- Restated from 030:134-135 unchanged. `create or replace` preserves the ACL,
-- so this is belt-and-braces for the same reason 038 restated its grants.
revoke execute on function public.is_team_member_uid(uuid, uuid) from public, anon;
grant execute on function public.is_team_member_uid(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` in this project, for
-- the reason 031, 032 and 033 all give. Every statement is re-runnable.
--
-- AFTER APPLYING, smoke-test that encryption still works for a NEW joiner: the
-- one behaviour that touches is_team_member_uid is an existing member sealing
-- the team key to someone who has just joined (the "join-seal RLS blocked"
-- failure 030 was written to fix). It should still succeed. If it does not, the
-- caller conjunct is the only thing that changed.
--
-- UNAPPLIED AS OF 2026-08-05. Nothing here has been run against any
-- database. State is recorded in supabase/MIGRATION-STATE.md; settle it with:
--   select proname, proacl from pg_proc
--    where proname in ('can_see_project','team_feed_counts','set_project_access_default');
--   -- applied when no acl entry grants EXECUTE to anon or to PUBLIC (an empty grantee)
-- ---------------------------------------------------------------------------
