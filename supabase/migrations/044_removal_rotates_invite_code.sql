-- 044_removal_rotates_invite_code.sql: make removing a member actually remove
-- them, and stop handing every member a permanent join credential.
--
-- NUMBERING: written as 039, renumbered to 041, and renumbered again to 044.
-- Both moves were collisions with lanes running in parallel — 039 had been
-- allocated twice, and 041 turned out to belong to the backend lane's
-- project_stats change, which landed on the same number. Number allocation is
-- now owned by the security lane's migration runbook rather than by hand.
--
-- The map this file was renumbered against:
--   037/038/039  security lane (project access scope, invite atomicity,
--                audit timestamp)
--   040          reserved — memory_entries delete privilege revoke
--   041          backend lane — project_stats carrying archived_at
--   042/043      security lane (definer grants + is_team_member_uid,
--                blanket table revokes)
--   044          THIS FILE
--   045          045_leave_rotates_invite_code.sql, same lane
--
-- Every internal self-reference below (§1/§2/§3) and every mention in lib/,
-- test/ and docs/ moved with it, on word boundaries so the other migration
-- numbers these files cite (002, 006, 009, 010, 011, 013, 024, 025, 029, 035)
-- were left alone. A comment anywhere pointing at "039" or "041" for
-- invite-code rotation is stale and means THIS file. Nothing was ever applied
-- under any of the three numbers, so there is no live state to reconcile; if
-- an earlier cut was applied somewhere regardless, it is byte-identical apart
-- from these comments and re-applying this file is a no-op.
--
-- THE FINDING (pinned as failing checks in test/suites/invite-lifetime.test.js
-- on branch agent-hunt, commit fcab31a). teams.invite_code never expires, has
-- no use cap, and cannot be revoked on its own. my_teams() (006:14,27) returns
-- it to EVERY member regardless of role, and GET /api/team spreads the whole
-- row into its payload (lib/server.js:2352), so an ordinary member can read
-- the code, keep it, and use it later. remove_member (002:179) deletes one
-- team_members row and does nothing else, so that code still works the second
-- after the removal. join_team (029:109) accepts it forever and is granted to
-- `authenticated` on the live backend, and 029's materialization re-grants the
-- returning member every project whose default_access is true. Net effect: a
-- removed member walks back in unaided, with member role and access to
-- everything open by default.
--
-- Two changes, both needed. §1 kills the credential at the moment of removal.
-- §2 stops the credential reaching people who have no use for it in the first
-- place. Either alone leaves the hole open: §1 without §2 still lets a member
-- stockpile codes and rejoin between removals, and §2 without §1 does nothing
-- about the code the person already copied, or about a code a manager pasted
-- into a chat channel the departing member can still read.
--
-- ===========================================================================
-- CONSEQUENCE, STATED PLAINLY. §1 rotates unconditionally, so EVERY removal
-- invalidates the team's standing invite code and every outstanding invite
-- link FOR EVERYONE, not just for the person being removed:
--
--   * anyone who is mid-join with the old code or an old link is cut off and
--     gets "invalid invite code" / "this invite link has been revoked". They
--     need a fresh one from a manager. Nothing tells them why.
--   * a code pasted into an onboarding doc, a README, a chat pin, or a
--     password manager goes stale silently. The next new hire hits a dead
--     code and reports it as a bug.
--   * a team that removes members regularly rotates its code just as often.
--
-- This is deliberate and is NOT to be softened into a conditional rotation
-- ("only rotate if the removed member could have seen the code"). Whether a
-- departing member holds a copy is not knowable from the database: they may
-- have read it through the dashboard, been sent it, or screenshotted it
-- months ago. A conditional rotation is a rotation that can be reasoned into
-- not happening, which is exactly how the current hole came to exist. The
-- cost is an inconvenienced joiner; the alternative cost is a removed member
-- with a live key.
-- ===========================================================================
--
-- Deploy gate, same discipline as 009, 013 and 035: apply this to the LIVE
-- Supabase before shipping the client. The offline suite runs against
-- test/mock-supabase.js, which models both changes, so a missing live
-- migration will NOT be caught by CI. What a user would see instead is
-- nothing at all -- the removal still succeeds, the code still works, and the
-- only symptom is the one this file exists to stop. Migrate first, ship
-- second. The live DB has no migration history (migrations are applied by
-- hand), so every statement here is re-runnable.
--
-- ⚠ DO NOT RE-APPLY 002_team_v2.sql AFTER THIS FILE. This file redefines
-- public.remove_member, whose original body lives in 002:179. Both files are
-- individually re-runnable, which is what makes this easy to get wrong: paste
-- 002 again after this one and remove_member silently reverts to the version
-- that deletes a membership row and nothing else -- no error, no failing test,
-- and the hole this file closes is open again. The same applies to
-- public.my_teams (006). If you are re-pasting anything from earlier in the
-- sequence, finish by re-pasting this file. Same rule for 045 and
-- public.leave_team.
--
-- Rollback: supabase/rollback/pre-044-removal-rotates-invite.sql restores both
-- functions to their pre-044 bodies verbatim.

-- ---------------------------------------------------------------------------
-- §1. remove_member rotates the team's standing invite code.
--
-- The body is restated verbatim from 002:179 with ONLY the two rotation
-- statements added, so this file remains the whole truth about the function
-- without reaching back to edit 002 -- the same convention 029 §2 follows.
--
-- The two added statements are lifted from rotate_invite (002:231) rather than
-- reinvented, and BOTH are needed. In this schema "rotate" has always meant
-- both halves: teams.invite_code is one credential and invites.token is
-- another, and a departing member can be holding either. They joined through
-- an invite link, and create_invite defaults max_uses to null (unlimited) and
-- expires_at to null (never) -- so the link they redeemed on their first day
-- redeems again on the day after they are removed. Rotating only the standing
-- code would leave that path wide open and look fixed.
--
-- NOT a call to public.rotate_invite(p_team): that function re-checks
-- is_team_manager, which is redundant here (already checked above) but, more
-- importantly, it would make removal's behaviour depend on a second function's
-- gate. The three statements are inlined so this function's effect is readable
-- in one place.
--
-- ORDER MATTERS. The delete comes first, so a rotation cannot be credited to a
-- removal that the owner-protection check refused. Both are in the same
-- implicit transaction, so a failure anywhere leaves neither applied.
--
-- `create or replace`, never drop-then-create: 010 grants EXECUTE on this
-- function to authenticated and service_role (010:397-398), and DROP discards
-- the ACL. The signature is unchanged, so replace is legal and the grants
-- survive. The grants are restated at the bottom of this file anyway, so a
-- tree that somehow lost them is repaired by re-running this.
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(p_team uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team_manager(p_team) then
    raise exception 'only a team owner or admin can remove members';
  end if;
  if (select role from public.team_members where team_id = p_team and user_id = p_user) = 'owner' then
    raise exception 'the team owner cannot be removed';
  end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
  -- 044: the removed member may be holding the team's standing invite code or
  -- an invite link. Both are now dead -- for everyone. See the CONSEQUENCE
  -- block at the top of this file: this rotation is unconditional on purpose.
  update public.teams set invite_code = gen_random_uuid() where id = p_team;
  update public.invites set revoked_at = now()
    where team_id = p_team and revoked_at is null;
end;
$$;

-- ---------------------------------------------------------------------------
-- §2. my_teams() stops handing the standing invite code to ordinary members.
--
-- 006 added invite_code to this function's result so the dashboard could show
-- "Copy invite link" without a second round-trip. It returns the column to
-- every row, whatever the caller's role in that team. A plain member cannot
-- mint an invite link (create_invite is is_team_manager-gated, 002:73) and
-- cannot revoke one (revoke_invite, same gate) -- so the standing code is a
-- credential they can spend but not manage, which is the worst combination.
-- Anything a member legitimately does with it, a manager can do for them.
--
-- NULL rather than an omitted column: the RETURNS TABLE signature is fixed and
-- every existing client selects the column positionally. A member's row keeps
-- its shape and simply has nothing in that slot, which lib/server.js turns
-- into `inviteCode: null` and the UI already renders as "no code to copy"
-- (ui/src/features/team/TeamPage.tsx:423 gates its control on the value).
--
-- This is a product/blast-radius narrowing, NOT the security boundary. The
-- boundary for JOINING is join_team, and for MINTING is create_invite; both
-- stay exactly as they are. What this removes is the standing distribution of
-- a permanent credential to people who have no operation that needs it.
--
-- `create or replace`, never `drop function ... ; create ...`. 006 used
-- drop-then-create because it CHANGED the RETURNS TABLE, which
-- create-or-replace refuses; this file does not touch the signature, so the
-- drop is both unnecessary and harmful -- it would discard the EXECUTE grants
-- 010:385-386 installed and leave every signed-in user with "permission denied
-- for function my_teams", i.e. a dashboard that reports the user is in no
-- teams at all.
-- ---------------------------------------------------------------------------
create or replace function public.my_teams()
returns table (
  team_id uuid,
  team_name text,
  role text,
  invite_code uuid,
  member_count bigint,
  created_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.id,
    t.name,
    m.role,
    -- 044: managers only. A member row carries null here.
    case when m.role in ('owner', 'admin') then t.invite_code else null end,
    (select count(*) from public.team_members mc where mc.team_id = t.id),
    t.created_at
  from public.team_members m
  join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by m.joined_at;
$$;

-- ---------------------------------------------------------------------------
-- §3. Grants, restated from 010:385-386 and 010:397-398. `create or replace`
-- above preserves the existing ACL, so on a correctly-migrated backend these
-- four statements are no-ops. They are here so that a backend where the
-- functions were at some point dropped and recreated by hand is repaired by
-- re-running this file, rather than silently left with a function nobody can
-- execute.
-- ---------------------------------------------------------------------------
revoke execute on function public.my_teams() from public, anon;
grant execute on function public.my_teams() to authenticated, service_role;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT HERE
--
-- * leave_team (002:252) is not changed HERE. It is the identical hole with a
--   different door and it is closed by 045_leave_rotates_invite_code.sql, in
--   its own file so it can be applied, held or reverted on its own. 045's
--   header carries the argument for why the same remedy fits a voluntary
--   departure, including why the narrower "revoke only their own invites"
--   closes nothing. Applying 044 without 045 leaves that door open.
--
-- * team_keys is NOT touched and the team key is NOT rotated. A removed member
--   keeps every sealed key they were ever given and can still decrypt every
--   epoch they synced. That is a design question with a real cost to the
--   remaining members, written up separately; nothing server-side can retract
--   what they already decrypted onto their own disk in any case.
--
-- * no audit row is written here. team_audit's insert policy is
--   `is_team_manager(team_id) and actor_id = auth.uid()` (024:98, tightened by
--   025:144) and the removal's audit row is already written by the daemon
--   route (lib/server.js, `member-removed`). Adding a second, RPC-side row
--   would double-count every removal.
-- ---------------------------------------------------------------------------
