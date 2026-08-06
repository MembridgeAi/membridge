-- 035_delete_own_entries.sql: self-serve deletion of a member's OWN synced
-- memory entries. Two new objects and one removal: a preview RPC
-- (my_entry_counts), the deletion RPC itself (delete_my_entries, which also
-- writes the audit row), and NO DELETE policy on memory_entries — §1 drops it,
-- so the audited RPC is the only door. An earlier cut of this file created
-- that policy; §1 records why creating it was wrong and why its absence is
-- what makes a future restored grant harmless.
--
-- NUMBERING: an earlier cut of this file was written as 028 while 028 was
-- still free. It is not: 028_enforce_project_access_default.sql took that
-- number and the tree now runs to 034. This file is 035, and every internal
-- self-reference below (§1/§2/§3) is renumbered with it. If you find a comment
-- anywhere in lib/ or test/ pointing at "028" for the delete policy, it is
-- stale and means this file, not project-access defaults.
--
-- WHY THIS EXISTS. public.memory_entries has SELECT (schema.sql:121, narrowed
-- by 025 §2), INSERT (schema.sql:126, narrowed by 033 §1) and UPDATE (012,
-- narrowed by 033 §2) policies and NO DELETE policy. RLS defaults closed, so a
-- DELETE through a user JWT affects zero rows and reports success. There has
-- never been a way for a person to remove what they pushed, from any surface.
--
-- This file supplies that way as an RPC rather than as a policy, and §1
-- explains at length why the difference matters: a policy would let a caller
-- delete rows while skipping the audit row the RPC writes, and — the part that
-- inverts the obvious reasoning — the policy's ABSENCE is what makes a
-- carelessly restored table grant (040 revokes the current one) fail closed
-- instead of silently working again.
--
-- Deploy gate, same discipline as 009 and 013: apply this to the LIVE Supabase
-- BEFORE shipping the client that calls it, and in that order. The offline
-- suite runs against test/mock-supabase.js, which implements both RPCs, so a
-- missing live migration will NOT be caught by CI. What a user
-- would see instead is the worst possible failure for this particular feature:
-- `delete_my_entries` 404s (PGRST202, "Could not find the function"), the
-- daemon surfaces an error, and the person who just asked for their data to be
-- gone is told something went wrong with no idea whether any of it was
-- removed. Migrate first, ship second. The live DB has no migration history
-- (migrations are applied by hand), so every statement here is re-runnable:
-- `create or replace` for the functions and `drop policy if exists` for the
-- policy §1 removes. Run in the Supabase
-- SQL editor (one transaction) or `supabase db push`; with psql, use
-- `psql -1 -f`.
--
-- If an EARLIER cut of this file was already applied anywhere (under any
-- number), re-apply it: delete_my_entries returned a bare integer then and
-- returns one row per project now (§3 explains why), and a client reading the
-- new shape from the old function watermarks the wrong set of projects on the
-- machine it runs on.
--
-- WHAT IS DELIBERATELY NOT HERE: nothing drops rows from public.projects.
-- Deleting a member's last entry in a project leaves an empty project row
-- behind, and tidying that away is tempting and catastrophic:
-- memory_entries.project_id is `references public.projects (id) on delete
-- cascade` (schema.sql:45), so removing one project row would destroy EVERY
-- OTHER MEMBER's entries in it. A member deleting their own data must never be
-- able to touch a teammate's. Empty project rows are harmless.
--
-- NO KEY ROTATION IS NEEDED, and none is done here. team_keys is keyed
-- (team_id, epoch, member_user_id) (009 §2): the key is per team and per
-- epoch, sealed once per member. It is not derived from any row and no row is
-- part of it, so removing rows cannot weaken it. Rotation answers a different
-- question (who may still unseal the key), which is a membership event, not a
-- deletion event.
--
-- NOTHING REFERENCES memory_entries.id. It is `bigint generated always as
-- identity primary key` (schema.sql:44) and no foreign key anywhere in
-- schema.sql or migrations/ points at it, so this delete produces no cascade
-- and can strand no orphan. Verified by grepping the whole supabase/ tree for
-- `references public.memory_entries` before writing this file; if that ever
-- stops being true, this comment is wrong and the delete needs re-examining.

-- ---------------------------------------------------------------------------
-- 1. NO memory_entries DELETE policy. Dropped, not created.
--
-- THIS SECTION USED TO CREATE ONE, scoped on author_id alone, so that a member
-- could erase their own rows through PostgREST. That was the wrong shape and
-- the audit that found it is worth recording, because the reasoning inverts
-- what "defence in depth" would suggest.
--
-- The problem: a direct `DELETE /rest/v1/memory_entries?author_id=eq.<self>`
-- satisfied that policy and removed rows while writing NOTHING to team_audit —
-- the audit row is written INSIDE delete_my_entries (§3), so any caller who
-- skipped the RPC skipped the record. Self-serve deletion is deliberate and
-- has a GDPR-shaped rationale; an irreversible removal from a team's shared
-- memory leaving no trace that it happened is not.
--
-- 040 closes that by revoking the DELETE grant from `authenticated` and
-- `anon`. So why drop the policy too, when the grant is already gone?
--
-- Because a DELETE needs BOTH a grant and a permissive policy, and RLS is
-- enabled on this table (verified against the live catalog: relrowsecurity
-- true, relforcerowsecurity false). Under RLS, a table with no policy for a
-- command denies that command outright. Now consider the one realistic
-- regression — someone running `grant all on all tables in schema public to
-- authenticated`, which is exactly how the privilege 040 revokes came to exist
-- in the first place:
--
--   policy kept,    grant restored -> deletes work again, unaudited, silently
--   policy dropped, grant restored -> RLS still denies
--
-- Keeping the policy is therefore not a second layer of defence. It is the
-- thing that would let a restored grant through. Its ABSENCE is what makes
-- that accident harmless.
--
-- delete_my_entries (§3) is unaffected, and this is the load-bearing fact
-- rather than an assumption: it is `security definer` and owned by `postgres`,
-- which also owns this table, and the table does not carry FORCE ROW LEVEL
-- SECURITY. A table owner is not subject to their own table's RLS, so the
-- function's DELETE consults neither this policy nor the `authenticated`
-- grant. Checked in the live catalog rather than inferred (prosecdef true,
-- proowner = relowner = postgres, relforcerowsecurity false), and nothing else
-- in the tree references `memory_entries_delete` — no lib/, bin/, test/ or ui/
-- path, and the offline mock has no direct-DELETE route on this table at all.
--
-- Order-independent, deliberately: dropping this does not wait on 040. With
-- the policy gone and the grant still in place, RLS denies every direct
-- delete anyway, so applying this file before, after, or without 040 only ever
-- narrows what is reachable. The live backend HAS this policy today, so
-- re-applying this file is what removes it.
--
-- IF A DIRECT DELETE PATH IS EVER WANTED AGAIN, the original argument still
-- holds and is kept here for whoever writes it: it must be scoped on author_id
-- ALONE, never ANDed with is_team_member(...) or can_see_project() the way
-- SELECT (025 §2), INSERT and UPDATE (033 §1, §2) are. Both of those
-- predicates are about PARTICIPATING in a project, and either one would strand
-- exactly the person most likely to want their data gone: someone who just
-- LEFT the team (is_team_member false forever), or someone whose project
-- access was REVOKED (can_see_project false) — each told, correctly, that
-- their entries are still on the backend and, incorrectly, that nothing can be
-- done about it. Authorship is the only thing that matters for erasing your
-- own writes. And it would need the audit gap answered at the same time, or it
-- reopens the hole this section closes.
-- ---------------------------------------------------------------------------
drop policy if exists memory_entries_delete on public.memory_entries;

-- ---------------------------------------------------------------------------
-- 2. my_entry_counts(p_team): the preview the confirmation screen shows.
--
-- `security definer` for one specific reason: the plain SELECT path on
-- memory_entries is ANDed with can_see_project (025 §2), so a member whose
-- access to a project was revoked would be shown a count SHORT of what the
-- delete in §3 actually removes. A confirmation dialog that under-reports the
-- blast radius is worse than no dialog. Definer means RLS does not apply
-- automatically and every predicate has to be written into the body, which is
-- done below and is the whole predicate: rows this caller authored, in this
-- team. That discloses nothing (you cannot learn anything about anyone else
-- from a count of your own rows), which is why is_team_member is not ANDed in
-- here either. It must not be: §1 lets an ex-member delete, and a preview that
-- disagrees with the delete it precedes is the same lie in the other
-- direction.
--
-- Archived projects are INCLUDED, unlike team_feed and team_feed_counts, which
-- both filter `p.archived_at is null`. Archiving is a soft delete for the
-- team's view; the rows are still on the backend, and §3 removes them, so this
-- has to count them or the preview under-reports again. Same rule as always
-- here: the preview's predicate is the delete's predicate.
-- ---------------------------------------------------------------------------
create or replace function public.my_entry_counts(p_team uuid)
returns table (
  project_id uuid,
  project_name text,
  entries bigint,
  first_ts timestamptz,
  last_ts timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select e.project_id, p.name, count(*)::bigint, min(e.ts), max(e.ts)
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and e.author_id = auth.uid()
  group by e.project_id, p.name
  order by p.name;
$$;

-- ---------------------------------------------------------------------------
-- 3. delete_my_entries(p_team, p_project): the deletion, and its audit row,
-- in ONE transaction.
--
-- p_project null means every project in the team; a uuid narrows it to one.
-- The predicate is my_entry_counts's, verbatim, plus the optional project
-- filter. If one ever changes, change both in the same migration.
--
-- RETURNS ONE ROW PER PROJECT, not a scalar total, and that shape is
-- load-bearing rather than cosmetic. The caller writes a deletion WATERMARK on
-- this machine (lib/teamsync.js markTeamDataDeleted) so the next sync pass
-- cannot re-upload what was just erased, and a watermark is per project. With
-- only a total to go on, the caller could not tell which projects were
-- affected and watermarked EVERY locally linked project of the team, including
-- ones this deletion never touched. Three silent, unrecoverable consequences,
-- all measured: a project linked but never synced was given a watermark of
-- `now` and could never push its local history again; the encryption-hold path
-- (teamsync.js pushProject leaves a batch behind the cursor on purpose) had
-- that batch buried permanently; and a session made shareable after a deletion
-- surfaced entries below the watermark that were suppressed forever. The shape
-- is my_entry_counts's, one column shorter, deliberately: the preview and the
-- deletion answer the same question about the same rows.
--
-- THE AUDIT INSERT BELONGS IN HERE, not in the Node caller, and this is the
-- load-bearing reason this function is plpgsql rather than a one-line sql
-- delete:
--
--   * team_audit's INSERT policy requires is_team_manager(team_id) AND
--     actor_id = auth.uid() (024 §5, tightened by 025 §5). A plain member
--     POSTing their own audit row is refused by RLS, always.
--   * lib/api-access.js recordAudit swallows its own failures by design (a
--     failed log must not turn a completed action into a 500). So the Node
--     path would log NOTHING for a plain member and report success.
--
-- The result would be a deletion that owners and admins can never see, which
-- is precisely the property this feature must have. Inside a `security
-- definer` function the insert runs as the function owner, which is the table
-- owner, and a table owner is not subject to that table's RLS unless the table
-- carries FORCE ROW LEVEL SECURITY (it does not), so the row lands for a
-- member, an admin and an owner alike. Same transaction as the delete: there
-- is no window in which the rows are gone and the record of it is not.
--
-- detail carries memberId so lib/api-access.js readAudit resolves a NAME
-- rather than rendering a bare uuid (its targetName branch keys on
-- detail.memberId). object_key holds the same id, matching the
-- member-removed / role-changed rows the trail already has.
--
-- Only logged when rows were actually removed: a confirmed deletion that found
-- nothing is not an event, and filing one would train readers of the trail to
-- ignore this action.
-- ---------------------------------------------------------------------------
-- `create or replace` cannot change a function's return type, and an earlier
-- cut of this returned integer, so the old signature is dropped first.
-- Re-runnable either way (`if exists`), same discipline as the drop-then-create
-- policy in §1. Dropping takes its grants with it; they are re-issued at the
-- foot of this file.
drop function if exists public.delete_my_entries(uuid, uuid);

create or replace function public.delete_my_entries(p_team uuid, p_project uuid default null)
returns table (project_id uuid, deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Which project each removed row belonged to, captured by the DELETE itself
  -- rather than by a SELECT before it. A count read separately could disagree
  -- with what was actually removed, and this value decides which projects get
  -- a watermark that can never be lifted.
  v_projects uuid[];
  v_deleted integer;
begin
  with removed as (
    delete from public.memory_entries e
    using public.projects p
    where p.id = e.project_id
      and p.team_id = p_team
      and e.author_id = auth.uid()
      and (p_project is null or e.project_id = p_project)
    returning e.project_id as pid
  )
  select coalesce(array_agg(pid), '{}'::uuid[]) into v_projects from removed;
  v_deleted := coalesce(array_length(v_projects, 1), 0);

  if v_deleted > 0 then
    insert into public.team_audit (team_id, actor_id, action, object_type, object_key, detail)
    values (
      p_team,
      auth.uid(),
      'own-data-deleted',
      'member',
      auth.uid()::text,
      jsonb_build_object(
        'memberId', auth.uid()::text,
        'deleted', v_deleted,
        'projectKey', case when p_project is null then null else p_project::text end
      )
    );
  end if;

  return query
    select u.pid, count(*)::bigint
    from unnest(v_projects) as u(pid)
    group by u.pid;
end;
$$;

-- Both are `security definer`, so who may CALL them is the whole gate: the
-- body runs as the owner either way. Postgres grants execute to PUBLIC by
-- default, which on Supabase includes the `anon` role every unauthenticated
-- request arrives as, so the default is revoked first and the grant issued
-- explicitly. Same shape, same order, as 010_security_hardening.sql's own
-- lockdown of every team RPC. auth.uid() is null for anon, so neither function
-- could have matched a row -- but "the predicate saves us" is not a gate, and
-- the next edit to either body would inherit an audience nobody chose.
revoke execute on function public.my_entry_counts(uuid) from public, anon;
grant execute on function public.my_entry_counts(uuid) to authenticated, service_role;
revoke execute on function public.delete_my_entries(uuid, uuid) from public, anon;
grant execute on function public.delete_my_entries(uuid, uuid) to authenticated, service_role;
