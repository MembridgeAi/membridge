-- 038_invite_redeem_atomic.sql — claim an invite use atomically instead of
-- checking the cap and then taking it.
--
-- THE RACE (029:157-183, and the same shape at 023:36-53).
--
--   select * into v_invite from public.invites where token = p_token;  -- no lock
--   if v_invite.max_uses is not null
--      and v_invite.use_count >= v_invite.max_uses then raise; end if; -- check
--   insert into public.team_members ...;                               -- act
--   update public.invites set use_count = use_count + 1 ...;           -- then take
--
-- The read takes no row lock, so under READ COMMITTED — Supabase's default —
-- two sessions redeeming a max_uses = 1 invite at the same time both read
-- use_count = 0, both pass the check, both insert a different user, and both
-- increment. The invite ends at use_count = 2 with two members admitted on a
-- cap of one. Nothing about this needs a fast attacker: two people clicking the
-- same link within the same few milliseconds is enough, and a script makes it
-- reliable.
--
-- WHY IT MATTERS NOW RATHER THAN BEFORE. Until this release the cap was
-- unreachable: nothing ever set max_uses, so every invite was unlimited and an
-- unsound cap had nothing to be unsound about. The same change that gives the
-- app a way to set a cap (INV-1, lib/server.js INVITE_DEFAULT_MAX_USES = 1)
-- turns this from dormant into load-bearing — a cap users are told to rely on.
-- The two must land together, which is why this file exists in the same batch.
--
-- THE FIX: a conditional UPDATE whose WHERE carries the cap, branching on the
-- affected row count. Chosen over `select ... for update` deliberately. Both
-- work, but FOR UPDATE is a lock a future edit can silently drop — move the
-- select, add an early return, split the function, and the guarantee is gone
-- with nothing to show for it. Here the guard lives inside the statement that
-- does the work, so it cannot be separated from it: any path that increments
-- use_count is, by construction, a path that re-checked the cap.
--
-- WHY IT IS ACTUALLY ATOMIC. The second session's UPDATE blocks on the row lock
-- the first holds. When the first commits, the second re-evaluates its WHERE
-- against the NEW version of the row (EvalPlanQual), so `use_count < max_uses`
-- is re-tested against the committed value, not the stale one. It matches zero
-- rows, and the branch below raises.
--
-- WHY THE LOSER DOES NOT HALF-JOIN. The membership insert happens before the
-- claim, so a losing session has already inserted a team_members row when it
-- discovers the cap is gone. `raise exception` aborts the whole function — one
-- transaction — so that insert is rolled back with everything else. The loser
-- joins nothing and sees "this invite link has already been used".
--
-- WHAT IS DELIBERATELY PRESERVED:
--
--   * "Joining twice is a no-op, not a burn" (029). The claim is still guarded
--     by v_joined, so a member redeeming a link they already used consumes no
--     use. v_joined is captured the instant the insert returns, before any
--     other DML can clobber FOUND — the trap 029's own comment documents.
--   * The distinct, readable rejections for revoked and expired invites. The
--     pre-checks stay exactly as they were; collapsing them into the claim
--     would have replaced two clear messages with one vague one.
--
-- The claim's WHERE also re-tests revoked_at and expires_at, which closes the
-- smaller races in the same shape: an invite revoked or expiring between the
-- pre-check and the claim can no longer be redeemed on the strength of a read
-- taken before either happened.
--
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` in this project, for
-- the reason 031, 032 and 033 all give. Both statements are re-runnable.
--
-- UNAPPLIED AS OF THIS COMMIT. Nothing here has been run against any database.
-- ---------------------------------------------------------------------------

create or replace function public.redeem_invite(p_token text, p_display_name text)
returns table (team_id uuid, team_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_team public.teams;
  -- 029: FOUND is set by the most recent INSERT/UPDATE/DELETE, so it has to be
  -- captured the instant the membership insert produces it. 038 keeps that and
  -- adds the claim immediately after, so nothing runs between them.
  v_joined boolean;
  -- 038: rows actually claimed by the conditional update. 0 means another
  -- session took the last use while this one was working.
  v_claimed int;
begin
  perform public.check_invite_attempt();
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_invite from public.invites where invites.token = p_token;
  if v_invite.token is null then
    raise exception 'invalid invite link';
  end if;
  -- These three stay as cheap pre-checks purely for their error messages. They
  -- are NOT the enforcement any more; the claim below is. A pre-check that
  -- passes here can still lose the claim, and that is the correct outcome.
  if v_invite.revoked_at is not null then
    raise exception 'this invite link has been revoked';
  end if;
  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    raise exception 'this invite link has expired';
  end if;
  if v_invite.max_uses is not null and v_invite.use_count >= v_invite.max_uses then
    raise exception 'this invite link has already been used';
  end if;
  select * into v_team from public.teams where id = v_invite.team_id;
  -- Never grants more than member; joining twice is a no-op, not a burn.
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  v_joined := found;
  -- 038: THE CLAIM. Only a genuinely new membership consumes a use, and it
  -- consumes it under the cap re-tested inside this statement.
  if v_joined then
    update public.invites
       set use_count = use_count + 1
     where invites.token = p_token
       and invites.revoked_at is null
       and (invites.expires_at is null or invites.expires_at > now())
       and (invites.max_uses is null or invites.use_count < invites.max_uses);
    get diagnostics v_claimed = row_count;
    if v_claimed = 0 then
      -- Another session took the last use, or the invite was revoked or expired
      -- between the pre-check and here. The membership insert above rolls back
      -- with this exception.
      raise exception 'this invite link has already been used';
    end if;
  end if;
  -- 029: materialize this member's project access. Runs after the claim so a
  -- refused redeem writes nothing (the rollback would cover it either way).
  insert into public.project_access (team_id, project_key, member_id, can_see)
    select p.team_id, p.id::text, auth.uid(), p.default_access
      from public.projects p
      where p.team_id = v_team.id
    on conflict do nothing;
  return query select v_team.id, v_team.name;
end;
$$;

-- Restated from 010:395-396. `create or replace` preserves an existing
-- function's ACL, so this is belt-and-braces rather than required — but
-- 011:140 warns that a newly CREATEd function gets EXECUTE for PUBLIC by
-- default, and restating removes any doubt about which of the two happened.
revoke execute on function public.redeem_invite(text, text) from public, anon;
grant execute on function public.redeem_invite(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The same shape in the onboarding path, where the prize is larger: the token
-- is single-use and calls create_team, so two concurrent redeems of one token
-- produce TWO teams, both owned by the redeemer, one of which nothing in the
-- product ever points at again.
--
-- Claimed the same way: stamp redeemed_at conditionally FIRST, and only build
-- the team once the stamp is ours. create_team runs in the same transaction, so
-- if it fails the claim rolls back with it and the token is reusable — which is
-- the behaviour you want from a token whose team was never created.
-- redeemed_team is filled in afterwards because it is not known until then.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_onboarding_invite(p_token text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  inv public.onboarding_invites;
  v_team uuid;
  v_code uuid;
  v_name text;
  v_claimed int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  select * into inv from public.onboarding_invites where token = p_token;
  if inv.token is null then
    raise exception 'That invite link is not recognised.';
  elsif inv.redeemed_at is not null then
    raise exception 'That invite has already been used.';
  elsif inv.expires_at <= now() then
    raise exception 'That invite expired on %.', to_char(inv.expires_at, 'Mon DD, YYYY');
  end if;

  -- 038: THE CLAIM, before create_team rather than after it.
  update public.onboarding_invites
     set redeemed_at = now()
   where onboarding_invites.token = p_token
     and onboarding_invites.redeemed_at is null
     and onboarding_invites.expires_at > now();
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    raise exception 'That invite has already been used.';
  end if;

  -- Trust the token, not the browser, for anything that hits a constraint.
  v_name := nullif(btrim(coalesce(p_display_name, '')), '');
  v_name := left(coalesce(v_name, 'Member'), 80);

  select t.team_id, t.invite_code into v_team, v_code
    from public.create_team(inv.team_name, v_name) t;

  update public.onboarding_invites
    set redeemed_team = v_team
    where onboarding_invites.token = p_token;

  perform public.ops_log('system:redeem', 'redeem_onboarding_invite', v_team,
    jsonb_build_object('team_name', inv.team_name));

  return jsonb_build_object(
    'ok', true,
    'team_id', v_team,
    'team_name', inv.team_name,
    'invite_code', v_code
  );
end $$;

-- Unchanged from 021 and 023 and restated deliberately: this is the ONE ops
-- function granted to `authenticated` rather than `service_role`, because it
-- must run as the NEW USER for create_team to record them as owner.
revoke all on function public.redeem_onboarding_invite(text, text) from public, anon;
grant execute on function public.redeem_onboarding_invite(text, text) to authenticated;
