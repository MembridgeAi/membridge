-- 048_audit_member_left.sql: record a voluntary departure. The mirror of 046,
-- and the reason 046 alone is not enough: a trail that shows people arriving
-- and never leaving is WORSE than one that shows neither, because it reads as
-- complete. An admin auditing "who has access" would see five joins, no
-- departures, and conclude five people are on the team.
--
-- THE FINDING. leave_team (002:252) deletes the caller's own team_members row
-- and writes nothing. The daemon cannot write it either, for the same reason a
-- join could not (046) and then one worse: team_audit's insert policy is
-- `is_team_manager(team_id) and actor_id = auth.uid()` (024 §5, tightened by
-- 025 §5), the leaver is not a manager, and by the time the row would be
-- written they are not a member either -- so even widening the policy to
-- members would not reach this case.
--
-- Same instrument as 046, for the same reasons: an AFTER DELETE trigger has
-- zero argument surface (team, actor and subject are read off the row Postgres
-- just deleted -- no parameter can name a different team or a different
-- person), and it cannot drift from the fact it records, because a row exists
-- if and only if a membership row was deleted.
--
-- ===========================================================================
-- THE DECISION: WHAT ABOUT REMOVALS?
--
-- A DELETE trigger fires on removals as well as departures, and the daemon
-- already writes `member-removed` for a removal (lib/server.js). Without care
-- every removal produces two rows saying different things about one event.
-- Three shapes were considered:
--
--   (a) One action, distinguished on the row -- actor <> subject means
--       removed, actor = subject means left. Does not stand alone: the daemon
--       keeps writing its row regardless, so a removal still yields two.
--       It only works as part of (c).
--
--   (c) The daemon stops writing; the trigger becomes the single source for
--       both. Genuinely the cleanest SHAPE, and one objection to it is wrong:
--       an AFTER DELETE trigger has OLD, so `old.display_name` is right there
--       -- the trigger has MORE information than the daemon route, whose
--       memberDisplayName() lookup is a separate request that returns null on
--       any failure. The disqualifier is ordering, not information. Moving a
--       WORKING event onto a migration makes its correctness depend on deploy
--       sequence: ship the client first and removals stop being audited
--       entirely; apply the migration first and every removal is double-
--       written until the client catches up. There is no order that is safe
--       in both directions, and the event being risked is one that works
--       today.
--
--   (b) CHOSEN. The trigger writes only what it can positively identify as
--       voluntary: `auth.uid() = old.user_id`, i.e. the person who ended the
--       membership IS the person whose membership ended. Purely additive.
--       `member-removed` is untouched and keeps working whether or not this
--       migration is applied, and no removal can produce a second row on any
--       normal path. The distinction is made by the WRITER, at the moment it
--       has the facts, rather than left to every future reader to re-derive
--       from actor vs subject.
--
-- WHAT (b) COSTS, stated rather than discovered later:
--
--   * TWO ACTION NAMES. The trail carries `member-removed` and `member-left`,
--     and a reader must know they are different. That is the intent -- being
--     removed and choosing to go are different events -- but any consumer
--     counting departures must count both.
--
--   * ONE OVERLAP REMAINS. An ADMIN can remove THEMSELVES: remove_member
--     (002:179) only refuses the owner, and the daemon route applies no
--     self-removal guard (lib/server.js). That single path produces both a
--     daemon `member-removed` and a trigger `member-left` -- two true
--     statements about one event, noise rather than a lie. It is NOT closed by
--     suppressing the daemon's row when actor = subject, because that is
--     option (c) in miniature: it would make an existing event's correctness
--     depend on this migration being applied. Left open deliberately, and
--     cheap to close later in the same change that would move removals onto
--     the trigger.
-- ===========================================================================
--
-- ===========================================================================
-- CASCADES, WHICH ARE NOT HYPOTHETICAL HERE
--
-- team_members has TWO cascading parents (schema.sql:18-19):
--   team_id uuid not null references public.teams (id)      on delete cascade
--   user_id uuid not null references auth.users (id)        on delete cascade
--
-- 1. DELETING A TEAM cascades into team_members, so an unguarded trigger fires
--    once per member. That is not merely noise. team_audit.team_id is itself
--    `references public.teams (id) on delete cascade` (024:43), so the row the
--    trigger tries to insert points at a team row that is being deleted in the
--    same statement -- a foreign key violation, which aborts the whole delete.
--    An unguarded trigger here does not make team deletion chatty, IT MAKES
--    TEAM DELETION FAIL. Hence the `teams` existence check in the function
--    body: it is a correctness guard, not a tidiness one, and it is in the
--    BODY rather than the WHEN clause because a WHEN clause may not contain a
--    subquery.
--
--    The WHEN clause already excludes every member except one during such a
--    cascade (their user_id is not the deleter's), so the body guard exists
--    for the residue: the deleting manager's OWN membership row, where
--    auth.uid() = old.user_id and the trigger would otherwise fire.
--
-- 2. DELETING AN AUTH USER cascades into team_members with auth.uid() =
--    old.user_id, which the WHEN clause does NOT exclude. It is unreachable
--    for a different reason, and one worth reporting on its own:
--    team_audit.actor_id is `references auth.users (id)` with NO on-delete
--    action (024:44), so deleting a user who has ANY audit row already fails
--    on that constraint. Since 046 every member has a join row naming them as
--    actor, which means ACCOUNT DELETION IS NOW BLOCKED FOR ANYONE WHO HAS
--    EVER JOINED A TEAM. That is a consequence of 046, not of this file, and
--    this file cannot make it worse -- the delete never reaches this trigger.
--    It is flagged rather than fixed here: the remedy is `on delete set null`
--    on team_audit.actor_id, which is a change to a table another lane is
--    already touching.
-- ===========================================================================
--
-- Deploy gate, same discipline as 044/045/046: apply to the LIVE Supabase
-- before shipping. The offline suite runs against test/mock-supabase.js, which
-- models both the trigger and the team-deletion cascade, so a missing live
-- migration will NOT be caught by CI -- and the symptom is silence.
-- Re-runnable: `create or replace` for the function, drop-then-create for the
-- trigger.
--
-- Rollback: supabase/rollback/pre-048-audit-member-left.sql.

-- ---------------------------------------------------------------------------
-- 1. The trigger function.
--
-- `security definer` so the insert is not filtered by team_audit's
-- manager-only insert policy; `set search_path = public` pinned, as every
-- definer function in this schema does.
--
-- detail mirrors the shape member-removed and member-joined already write, so
-- lib/api-access.js readAudit resolves all three through one code path.
-- targetName is `old.display_name` -- read off the row that was just deleted,
-- which is the ONLY place it still exists. This is the row's one chance to
-- capture it: the moment the trigger returns, nothing in the database knows
-- what that person was called, and readAudit's roster lookup will miss
-- forever. It is also strictly better than the daemon's equivalent, which has
-- to fetch the name in a separate request beforehand and records null when
-- that request fails.
-- ---------------------------------------------------------------------------
create or replace function public.audit_member_left()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Cascade guard. See the CASCADES block above: without this, deleting a team
  -- aborts on team_audit's own team_id foreign key.
  if not exists (select 1 from public.teams where id = old.team_id) then
    return null;
  end if;
  insert into public.team_audit (team_id, actor_id, action, object_type, object_key, detail)
  values (
    old.team_id,
    old.user_id,
    'member-left',
    'member',
    old.user_id::text,
    jsonb_build_object('memberId', old.user_id::text, 'targetName', old.display_name)
  );
  return null; -- AFTER trigger: the return value is ignored
end;
$$;

revoke all on function public.audit_member_left() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The trigger.
--
-- `when (auth.uid() is not null and auth.uid() = old.user_id)` is the whole
-- removal-vs-departure decision, made where the facts are:
--
--   * leave_team deletes `where user_id = auth.uid()` -> fires.
--   * remove_member deletes some OTHER user's row -> auth.uid() is the
--     manager, not the subject -> does not fire, so the daemon's
--     `member-removed` stays the only row for a removal.
--   * anything running as service_role or as a migration has auth.uid() null
--     -> does not fire. (`null = old.user_id` is NULL, which a WHEN clause
--     already treats as false; the explicit null check is for the reader.)
--
-- auth.uid() reads the request's JWT claim, which SECURITY DEFINER does not
-- change -- it swaps the executing role, not the request settings -- so it
-- still names the human inside leave_team's definer body.
-- ---------------------------------------------------------------------------
drop trigger if exists team_members_audit_leave on public.team_members;
create trigger team_members_audit_leave
  after delete on public.team_members
  for each row
  when (auth.uid() is not null and auth.uid() = old.user_id)
  execute function public.audit_member_left();

-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT HERE
--
-- * the daemon's `member-removed` write is untouched. Moving it here is
--   option (c) above; the ordering hazard is why it is not this change.
--
-- * no audit row for the owner. leave_team refuses the owner outright
--   (002:258), so there is no delete and therefore no trigger. A team's owner
--   leaving is not a departure the schema permits.
--
-- * team deletion emits nothing at all -- not a departure per member, and not
--   a 'team-deleted' event either. It cannot: team_audit.team_id cascades from
--   teams, so any row describing a team's deletion is deleted by that same
--   deletion. Recording that anywhere means a table that outlives the team,
--   which is the ops_log's job (021), not this trail's.
-- ---------------------------------------------------------------------------
