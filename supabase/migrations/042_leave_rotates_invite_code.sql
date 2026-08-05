-- 042_leave_rotates_invite_code.sql: a voluntary departure invalidates the
-- team's standing credential, exactly as a removal does (041 §1).
--
-- NUMBERING: 042 was NOT allocated by the lead — this lane took the next free
-- number after 041 on the accounting given (the security lane holds 037-039,
-- 040 is a privilege revoke on memory_entries, 041 is this lane's removal
-- migration). Trivially renumberable: one function body, no dependency on 041
-- beyond sharing its reasoning, and nothing else in the tree references the
-- number. If it collides, renumber the file and the two mentions in
-- test/mock-supabase.js and test/suites/removal-durability.test.js.
--
-- APPLY ORDER: independent of 041. Either order works and either may be
-- applied without the other; they touch different functions and neither reads
-- the other's objects. 041 without 042 leaves the door this file closes.
--
-- ===========================================================================
-- WHY THIS IS THE SAME REMEDY, ARGUED RATHER THAN ASSUMED
--
-- 041 §1's "deliberately not here" block named leave_team (002:252) as the
-- identical hole with a different door and declined to fix it there, on the
-- grounds that a member leaving one of several teams would rotate that team's
-- code for everyone and — unlike a removal — nobody with authority chose it.
-- That objection was weighed and does not survive contact with the function.
--
-- 1. THE NARROWER REMEDY CLOSES NOTHING. The obvious proportionate answer is
--    "revoke only the leaver's own outstanding invites". It does not work.
--    What a leaver holds is teams.invite_code, which is not theirs — it is the
--    team's single standing credential, and revoking invites they created
--    leaves it untouched. Worse, an ordinary member cannot create invites at
--    all (create_invite is is_team_manager-gated, 002:73), so for the common
--    case "their own outstanding invites" is the empty set. It would be a
--    change that reads as a fix and closes nothing.
--
-- 2. LEAVING IS ONE-SHOT, SO IT IS NOT A LEVER. The fear was that rotation on
--    leave hands every member a way to invalidate the team's onboarding
--    credential at will. leave_team deletes the CALLER'S OWN row; to trigger a
--    second rotation they must first re-join, and after 041 that requires a
--    fresh credential from a manager. So each member can force at most one
--    rotation, and the price of forcing it is surrendering their own access.
--    That is an expensive nuisance, not a denial-of-service.
--
-- 3. NOT ROTATING INVERTS THE RISK. After 041 §2 the standing code reaches
--    managers only. So the person most certain to be holding it when they walk
--    is an ADMIN — and an admin cannot be removed by themselves, they resign.
--    Leaving leave_team alone means the single highest-risk departure is the
--    one that leaves the credential live. The door that stays open is also the
--    one that looks least suspicious in the audit trail.
--
-- So: the same two statements, unconditionally. Symmetry is where the argument
-- lands, not where it started.
--
-- CONSEQUENCE, same as 041 and equally unsoftened: every voluntary departure
-- invalidates the standing code and every outstanding invite link FOR
-- EVERYONE. Anyone mid-join is cut off with "invalid invite code" and no
-- explanation. On a team with churn — contractors rotating off, say — the code
-- stales often, and an onboarding doc that pastes it will be wrong most weeks.
-- The mitigation is the one 011 §(i) already recommends and 041 §2 nudges
-- toward: hand out revocable invite LINKS, not the standing code. Do not make
-- this conditional on the leaver's role or on whether they "could have seen"
-- the code — that is unknowable from the database, and a conditional rotation
-- is a rotation that can be reasoned into not happening.
--
-- The owner is unaffected: leave_team already refuses them (002:258), so a
-- leave can never strand a team without a manager able to mint a fresh code.
--
-- Deploy gate, same discipline as 041: apply to the LIVE Supabase before
-- shipping. The offline suite runs against test/mock-supabase.js, which models
-- this, so a missing live migration will NOT be caught by CI — the symptom is
-- silence, which is the whole finding. Re-runnable; `create or replace`
-- preserves the EXECUTE grants 010:405-406 installed.
--
-- Rollback: supabase/rollback/pre-042-leave-rotates-invite.sql.
-- ===========================================================================

-- The body is restated verbatim from 002:252 with ONLY the two rotation
-- statements added, so this file is the whole truth about the function without
-- reaching back to edit 002 — the same convention 029 §2 and 041 §1 follow.
-- The delete comes first so a rotation cannot be credited to a leave the
-- owner-protection check refused; both are in one implicit transaction.
create or replace function public.leave_team(p_team uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.team_role(p_team) = 'owner' then
    raise exception 'the owner cannot leave their own team';
  end if;
  delete from public.team_members where team_id = p_team and user_id = auth.uid();
  -- 042: the departing member may be holding the team's standing invite code
  -- or an invite link (create_invite defaults to no expiry and no use cap, so
  -- the link they joined with redeems again after they go). Both are now dead
  -- -- for everyone. See the CONSEQUENCE block above: unconditional on purpose.
  update public.teams set invite_code = gen_random_uuid() where id = p_team;
  update public.invites set revoked_at = now()
    where team_id = p_team and revoked_at is null;
end;
$$;

-- Grants restated from 010:405-406. `create or replace` preserves the existing
-- ACL, so these are no-ops on a correctly-migrated backend; they are here so a
-- tree where the function was dropped and recreated by hand is repaired by
-- re-running this file.
revoke execute on function public.leave_team(uuid) from public, anon;
grant execute on function public.leave_team(uuid) to authenticated, service_role;

-- DELIBERATELY NOT HERE: no audit row. team_audit's insert policy is
-- `is_team_manager(team_id) and actor_id = auth.uid()` (024:98, tightened by
-- 025:144), and a departing member is not a manager and is no longer a member
-- by the time the row would be written -- so a leave cannot audit itself from
-- the client OR from this function without widening that policy. It is the
-- same structural gap the join-audit lane is working, and this file must not
-- pre-empt their decision about it. A departure that leaves no trace is worth
-- naming even though nothing here fixes it.
