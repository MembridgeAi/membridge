-- ---------------------------------------------------------------------------
-- 023 — redeem_onboarding_invite also returns the team name.
--
-- The join page (cloudflare/join) confirms "Team <name> is ready" after redeem.
-- 021 returned only ok/team_id/invite_code, so the page had nothing to show but
-- a uuid — and a uuid is exactly the kind of thing that makes a customer think
-- something went wrong at the one moment they need to feel it went right.
--
-- Also tightens two things worth fixing while this function is being rewritten:
--
--   * The display name is validated here rather than trusted from the browser.
--     team_members.display_name has a 1..80 length check, so an empty or
--     oversized name raised a constraint violation the page could only report
--     as raw SQL. Now it is trimmed, defaulted and clipped server-side.
--
--   * The error for an unusable token distinguishes the three cases (unknown,
--     expired, already redeemed). All three previously produced "invalid or
--     expired invite", which tells the person holding the link nothing about
--     whether to ask for a new one or check they used the right one.
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

  -- Trust the token, not the browser, for anything that hits a constraint.
  v_name := nullif(btrim(coalesce(p_display_name, '')), '');
  v_name := left(coalesce(v_name, 'Member'), 80);

  select t.team_id, t.invite_code into v_team, v_code
    from public.create_team(inv.team_name, v_name) t;

  update public.onboarding_invites
    set redeemed_at = now(), redeemed_team = v_team
    where token = p_token;

  perform public.ops_log('system:redeem', 'redeem_onboarding_invite', v_team,
    jsonb_build_object('team_name', inv.team_name));

  return jsonb_build_object(
    'ok', true,
    'team_id', v_team,
    'team_name', inv.team_name,
    'invite_code', v_code
  );
end $$;

-- Unchanged from 021 and restated deliberately: this is the ONE ops function
-- granted to `authenticated` rather than `service_role`, because it must run as
-- the NEW USER for create_team to record them as owner of their own team.
revoke all on function public.redeem_onboarding_invite(text, text) from public, anon;
grant execute on function public.redeem_onboarding_invite(text, text) to authenticated;
