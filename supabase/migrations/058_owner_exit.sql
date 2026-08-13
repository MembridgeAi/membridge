-- ---------------------------------------------------------------------------
-- 058: give a team owner a way out. Two new functions, nothing replaced.
--
-- UNAPPLIED AS OF 2026-08-12. Verify:
--   select proname from pg_proc
--    where proname in ('transfer_ownership', 'delete_team')
--      and pronamespace = 'public'::regnamespace;
-- Applied when it returns BOTH rows. State recorded in
-- supabase/MIGRATION-STATE.md and nowhere else.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT, STATED PLAINLY
--
-- The owner of a team can never leave it and can never delete it. Not "the
-- owner of a solo team" -- every owner, of every team, regardless of member
-- count. Three facts compose into that:
--
--   1. leave_team refuses owners outright (045:96, "the owner cannot leave
--      their own team").
--   2. set_role cannot grant 'owner' (002:179, "role must be admin or
--      member"), so ownership cannot be handed to anyone.
--   3. No delete_team exists anywhere in the schema.
--
-- Each is individually defensible. Together they are a trap: creating a team
-- is a one-way door, and the app offered a Leave button that could only ever
-- return a 500. Reported from the app by the owner of a one-person team named
-- "test" who simply wanted it gone.
--
-- ---------------------------------------------------------------------------
-- §1. WHY transfer_ownership IS A NEW FUNCTION AND set_role IS UNTOUCHED
--
-- The obvious fix is to widen set_role's `p_role not in ('admin','member')`
-- check to admit 'owner'. That is wrong, for a reason that only shows up when
-- you write the body:
--
-- A transfer is TWO row changes that must happen together -- promote the
-- target to owner AND demote the caller to admin. set_role updates exactly one
-- row. Widened, `set_role(team, alice, 'owner')` would leave the team with TWO
-- owners, and the second update would be the caller's own responsibility to
-- remember. set_role also explicitly refuses to change the caller's own role
-- (002:186), which a transfer must do. So the widened function would either
-- break its own invariant or quietly become a different function wearing the
-- same name -- one that three call sites and a <select> in the members list
-- already depend on.
--
-- set_role's contract is left exactly as it is, and it stays correct as
-- written: you do not SET someone owner, you TRANSFER ownership to them. The
-- distinction is real -- one is an attribute change, the other is a handover
-- that leaves nobody behind holding the role.
--
-- A previous UI shipped a transfer-ownership control against set_role and it
-- could only ever fail; it was deleted rather than fixed (see the comment at
-- ui/src/features/members/MembersSection.tsx). This is the RPC it needed.
-- ---------------------------------------------------------------------------

create or replace function public.transfer_ownership(p_team uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.team_role(p_team) <> 'owner' then
    raise exception 'only the team owner can transfer ownership';
  end if;
  if p_user = auth.uid() then
    raise exception 'you already own this team';
  end if;
  if not exists (
    select 1 from public.team_members where team_id = p_team and user_id = p_user
  ) then
    raise exception 'that person is not a member of this team';
  end if;
  -- Both updates or neither: a function body is one implicit transaction, so
  -- a failure on the second cannot leave the team with two owners. The
  -- promotion goes first so that the window, if one somehow existed, holds
  -- two owners rather than none -- a team with no owner has no one who can
  -- fix it, which is the same trap this migration exists to remove.
  update public.team_members set role = 'owner'
    where team_id = p_team and user_id = p_user;
  update public.team_members set role = 'admin'
    where team_id = p_team and user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- §2. delete_team, deliberately limited to the LAST MEMBER
--
-- BLAST RADIUS, because this is the only operation in the product that
-- destroys memory rather than revoking access to it:
--
--   teams -> projects (002:72, on delete cascade)
--         -> memory_entries (schema.sql:45, on delete cascade)
--
-- So disbanding erases every entry in every project the team shares, for
-- everyone, permanently. Compare removal and departure, which delete a
-- team_members row and NOTHING else -- entries hang off projects, not off
-- membership, so a departed member's work stays readable by the team until
-- its author deletes it themselves (035's DELETE policy is scoped on
-- author_id alone precisely to keep that possible).
--
-- THE MEMBER-COUNT GATE IS THE WHOLE POINT. Owner's call, 2026-08-12: an
-- owner may not destroy other people's memory in one click. With the gate, a
-- populated team must be emptied first -- remove each person, or let them
-- leave -- which is deliberately a chore, and which leaves a `member-removed`
-- audit row per departure so the dissolution is legible afterwards. Without
-- it, one click by one person erases work that four other people's agents
-- spent months accumulating, with no undo and no trail (the trail cascades
-- too). The chore is the feature.
--
-- WHY THE CASCADE DOES NOT ABORT ON team_audit. 040:23-34 warned that a
-- BEFORE DELETE trigger on memory_entries would break team deletion, because
-- team_audit.team_id references the very teams row being deleted. The live
-- departure trigger (049:163-167) already carries the guard for exactly this:
-- audit_member_left() returns null when its team no longer exists, so the
-- cascade through team_members writes nothing and the FK is never tested.
-- THIS FUNCTION DEPENDS ON THAT GUARD. If 049 is ever reverted or the guard
-- is edited out, disband stops working and the error will point at
-- team_audit's foreign key rather than at the trigger.
-- ---------------------------------------------------------------------------

create or replace function public.delete_team(p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  n_members integer;
begin
  if public.team_role(p_team) <> 'owner' then
    raise exception 'only the team owner can disband a team';
  end if;
  select count(*) into n_members
    from public.team_members where team_id = p_team;
  if n_members > 1 then
    raise exception
      'remove the other % member(s) before disbanding this team', n_members - 1;
  end if;
  -- Everything else goes with it by cascade: projects, memory_entries,
  -- invites, project_access, team_keys, team_audit.
  delete from public.teams where id = p_team;
end;
$$;

-- ---------------------------------------------------------------------------
-- §3. Grants, matching 010:405-406's shape for every other team RPC. `create
-- or replace` preserves an existing ACL, but these two functions are new, so
-- these lines are what actually establishes it -- a new function is
-- executable by PUBLIC by default, which is precisely what 056 spent a whole
-- migration undoing for team_feed.
-- ---------------------------------------------------------------------------
revoke execute on function public.transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated, service_role;
revoke execute on function public.delete_team(uuid) from public, anon;
grant execute on function public.delete_team(uuid) to authenticated, service_role;
