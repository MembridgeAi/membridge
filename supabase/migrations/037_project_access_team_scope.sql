-- 037_project_access_team_scope.sql — a project_access row may only name a
-- project belonging to the team the row was written under.
--
-- THE HOLE, as the two halves that never met.
--
--   WRITE SIDE (024:77-83). project_access_insert and project_access_update are
--   `with check (public.is_team_manager(team_id))` and nothing else.
--   project_key is a bare `text` column (024:32) with no foreign key, no check
--   constraint and no trigger. The composite FK (024:38) is
--   `foreign key (team_id, member_id) references public.team_members` — it
--   constrains MEMBER_ID to a member of team_id and says nothing whatsoever
--   about project_key. So an owner or admin of ANY team could write a row
--   naming ANY project's uuid.
--
--   READ SIDE (028:113-121). can_see_project resolves the row on
--   `a.project_key = p_project::text and a.member_id = auth.uid()` and never
--   mentions team_id. Tier 1 — an existing row — is decisive by design, which
--   is what makes a deliberate revoke authoritative.
--
-- Together: a row written under team A settles access to a project in team B.
-- Both directions were reachable, and neither needed the app — 033's own header
-- names "anyone using the project's anon key with their own valid bearer token
-- directly (the anon key is public by design)" as a first-class caller.
--
--   GRANT.  Any authenticated user may create_team, becoming owner of their own
--           team A, then POST { team_id: A, project_key: <team B's project>,
--           member_id: self, can_see: true }. The write passed
--           is_team_manager(A); can_see_project then returned tier 1 = true and
--           memory_entries_select, project_stats, team_feed and team_feed_counts
--           all opened.
--
--   REVOKE. An owner of team A who shares any team with Bob wrote
--           { team_id: A, project_key: <team B's project>, member_id: Bob,
--           can_see: false }. bool_and lets a single false win. On Bob's machine
--           the access-lost branch (lib/teamsync.js:2237-2256) then stamped
--           teamAccessLost, emptied the cached rows, pruned the durable archive
--           and erased the notes index — cross-tenant destruction of local data,
--           not merely a denied read.
--
-- THE WRITE SIDE IS FIXED HERE, and the read side is deliberately left alone.
-- Scoping can_see_project by team would force matching changes to 034's index
-- columns and to test/suites/schema-indexes.test.js, which currently pins the
-- ('member_id', 'project_key') shape as correct. That is a second change with
-- its own risk and belongs to its own ticket if it is ever wanted.
--
-- ---------------------------------------------------------------------------
-- TWO THINGS THAT ARE EASY TO GET WRONG HERE. Both were live traps.
--
-- (a) THE CAST DIRECTION DECIDES DENY-VS-ERROR, and they are not the same
--     failure. The obvious spelling is `p.id = project_access.project_key::uuid`
--     — text to uuid. That RAISES (22P02, invalid input syntax for type uuid) on
--     any row whose project_key is not a well-formed uuid; it does not evaluate
--     to false. A WITH CHECK that raises is a different and worse failure than
--     one that denies: it aborts the statement with a type error instead of a
--     policy violation, and the difference between "malformed" and "absent" is
--     itself an oracle a prober can read.
--
--     This file casts the OTHER way — `p.id::text = project_access.project_key`
--     — which can never raise, because every uuid has a text form. A malformed
--     or non-uuid project_key simply matches no project row and the write is
--     DENIED. That is also the direction can_see_project already uses
--     (028:117, `a.project_key = p_project::text`), so the read and write sides
--     now agree on how the text column relates to the uuid one.
--
--     This matters beyond tidiness: 024:29-31 keeps project_key as text on
--     purpose, "so this table never has to change shape if a future project
--     identifier isn't a uuid". A predicate that raises on a non-uuid would
--     silently make that documented future impossible.
--
-- (b) THE CORRELATION MUST BE QUALIFIED OR IT IS VACUOUS. public.projects has
--     its own `team_id` column (schema.sql:28). Inside the subquery, a bare
--     `team_id` therefore resolves to the INNER table — `p.team_id = p.team_id`
--     — which is true for every row, and the policy would pass everything while
--     looking correct. Both sides are written out as
--     `project_access.team_id` / `project_access.project_key` for exactly this
--     reason. Do not "simplify" them back to bare column names.
--     (project_key is not a column of public.projects today, so only team_id is
--     actually ambiguous — but both are qualified so the next edit cannot
--     reintroduce the trap by adding a column.)
-- ---------------------------------------------------------------------------
-- WHY THIS CANNOT BREAK PROJECT LINKING OR JOINING. Every path that
-- materializes project_access rows is `security definer` and so does not run
-- under these policies at all: join_team (029:109-112), redeem_invite
-- (029:139-142), link_project (029:223-226) and the projects_materialize_access
-- trigger (032:98-104). 032:73-77 spells out that definer rights are REQUIRED
-- there rather than stylistic, because project_access_insert already raises for
-- an ordinary member. This migration adds no new dependency on that mechanism.
--
-- And belt-and-braces: even if those paths DID run under RLS, every one of them
-- inserts `p.team_id, p.id::text` selected from the same public.projects row
-- (029:130-134, 029:182-186, 029:253-258, 032:105), so the predicate below is
-- satisfied by construction. There is no legitimate writer this can refuse.
-- ---------------------------------------------------------------------------

-- `create policy` has no `if not exists` / `or replace`, so drop then create.
drop policy if exists project_access_insert on public.project_access;
create policy project_access_insert on public.project_access
  for insert with check (
    public.is_team_manager(project_access.team_id)
    and exists (
      select 1 from public.projects p
       where p.id::text = project_access.project_key
         and p.team_id = project_access.team_id
    )
  );

-- The same predicate goes on BOTH the USING and the WITH CHECK halves of
-- UPDATE, matching how 024 applied is_team_manager to both. WITH CHECK alone
-- would stop a manager creating a NEW cross-team row by update, but USING is
-- what stops them targeting one that already exists — including flipping an
-- inherited bad row's can_see, which is the destructive direction. A row that
-- is already mismatched therefore becomes frozen: not updatable, still
-- deletable by a manager of its team (project_access_delete, 024:87-88), which
-- is what the sweep at the bottom of this file uses.
drop policy if exists project_access_update on public.project_access;
create policy project_access_update on public.project_access
  for update using (
    public.is_team_manager(project_access.team_id)
    and exists (
      select 1 from public.projects p
       where p.id::text = project_access.project_key
         and p.team_id = project_access.team_id
    )
  ) with check (
    public.is_team_manager(project_access.team_id)
    and exists (
      select 1 from public.projects p
       where p.id::text = project_access.project_key
         and p.team_id = project_access.team_id
    )
  );

-- ---------------------------------------------------------------------------
-- THE SWEEP — NOT RUN BY THIS MIGRATION, ON PURPOSE.
--
-- A policy change governs FUTURE writes only. Any mismatched row already in the
-- table keeps working exactly as before, because can_see_project still resolves
-- tier 1 on (project_key, member_id) without regard to team. So the hole stays
-- open for existing rows until they are removed, and removing rows is a data
-- write with a different risk profile from a policy change — it is deliberately
-- left as a separate, manual, reviewed step rather than executed on apply.
--
-- RUN THE SELECT FIRST AND READ WHAT IT RETURNS. It matches three different
-- things, and only the first is a security finding:
--
--   1. genuinely cross-team rows — the vulnerability, written under team A
--      naming a project of team B;
--   2. orphans — the project row was hard-deleted, so nothing matches any more.
--      (Archived projects are NOT orphans: 005's archive is a soft delete,
--      archived_at is set but the row remains, so they match and are untouched.)
--   3. rows whose project_key is not a well-formed uuid at all.
--
-- Deleting 2 and 3 is cleanup rather than a fix, and it is still a deletion.
-- Look at the count before running the DELETE.
--
--   select a.team_id, a.project_key, a.member_id, a.can_see,
--          a.updated_at, a.updated_by
--     from public.project_access a
--    where not exists (
--            select 1 from public.projects p
--             where p.id::text = a.project_key
--               and p.team_id = a.team_id
--          )
--    order by a.updated_at desc;
--
-- Then, only once that list has been read:
--
--   delete from public.project_access a
--    where not exists (
--            select 1 from public.projects p
--             where p.id::text = a.project_key
--               and p.team_id = a.team_id
--          );
-- ---------------------------------------------------------------------------
