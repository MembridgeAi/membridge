-- ---------------------------------------------------------------------------
-- 021 — ops panel: the write half.
--
-- Everything before this was read-only. That mattered: a compromise of the ops
-- API could only ever produce wrong numbers on an internal page. Once the panel
-- can WRITE, the same compromise can mutate customer data, so the security
-- model has to carry more weight than "it is behind Access".
--
-- FOUR RULES, enforced here rather than in the Worker:
--
-- 1. NO GENERIC TABLE WRITES. The ops API never gets INSERT/UPDATE on
--    `teams`, `team_members`, `projects` or `memory_entries`. Every mutation
--    goes through one narrow function below with a fixed signature. The blast
--    radius of a compromised Worker is the union of these functions, and
--    nothing else.
--
-- 2. NOTHING DESTRUCTIVE. There is no delete-team, no remove-member, no
--    delete-entries. Those exist as product RPCs that run as the affected
--    user, which is the correct place for them. An admin panel that can
--    irreversibly destroy a customer's account is a bad trade for the
--    convenience — do it deliberately in the Supabase console.
--
-- 3. EVERY WRITE IS AUDITED, with the acting human's email. An admin panel
--    without an audit trail is indistinguishable from an attacker with the
--    service key. The actor is passed in from the verified Cloudflare Access
--    JWT — the Worker cannot omit it, because it is a required argument.
--
-- 4. OPS STATE LIVES IN OPS TABLES. Notes and flags go in ops_team_meta, not
--    as new columns on `teams`. Product schema stays product schema, and
--    nothing here can affect what a client sees or syncs.
--
-- PRIVACY LINE unchanged: metadata only. Nothing here reads or writes `ask`,
-- `summary`, `files` or `ciphertext`, and it could not — the server holds only
-- ciphertext for those.
-- ---------------------------------------------------------------------------

-- --- audit -----------------------------------------------------------------
create table if not exists public.ops_audit (
  id bigint generated always as identity primary key,
  -- The Access email the CALLER claims. This comment used to read "verified
  -- Access email, never client-supplied", which is true of the Worker and false
  -- of the column: `actor` arrives as the `p_actor` argument to ops_log, so at
  -- the database layer it is composed by whoever holds the credential. It is
  -- trustworthy exactly insofar as the caller is the Worker. See 048 for the
  -- full analysis of why it cannot be made verifiable here, and `via_role`
  -- below for the identity-adjacent fact that IS checked rather than received.
  actor text not null,
  action text not null,
  target_team uuid references public.teams (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
alter table public.ops_audit enable row level security;
-- No policies: deny-all to anon and authenticated. Only service_role reaches
-- it, and only through the functions below. Same posture as invite_attempts.

-- --- ops-only metadata about a team ----------------------------------------
create table if not exists public.ops_team_meta (
  team_id uuid primary key references public.teams (id) on delete cascade,
  note text check (note is null or char_length(note) <= 2000),
  internal boolean not null default false,   -- dogfooding: excluded from metrics
  updated_at timestamptz not null default now()
);
alter table public.ops_team_meta enable row level security;

-- --- onboarding invites ----------------------------------------------------
-- The panel CANNOT create a team directly, by design. `teams.created_by` is
-- NOT NULL and references a real auth user, so a service-key insert would have
-- to invent an owner — either a phantom account or the operator, and then the
-- customer never owns their own team.
--
-- Instead the panel pre-issues a named invite. When the first real user
-- redeems it, the team is created by THEM, as owner, through the existing
-- create_team path. Ownership and E2E key material are established exactly as
-- they are for an organic signup; the only thing pre-set is the name and the
-- fact that we were expecting them.
create table if not exists public.onboarding_invites (
  token text primary key,
  team_name text not null check (char_length(team_name) between 1 and 80),
  note text check (note is null or char_length(note) <= 2000),
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_team uuid references public.teams (id) on delete set null
);
alter table public.onboarding_invites enable row level security;

-- --- internal helper -------------------------------------------------------
create or replace function public.ops_log(p_actor text, p_action text, p_team uuid, p_detail jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ops_audit (actor, action, target_team, detail)
  values (p_actor, p_action, p_team, coalesce(p_detail, '{}'::jsonb));
$$;
revoke all on function public.ops_log(text, text, uuid, jsonb) from public, anon, authenticated;

-- --- writes ----------------------------------------------------------------

-- CRM note against an account. The single most useful field in an early admin
-- panel and the one most likely to be kept in someone's head otherwise.
create or replace function public.ops_set_team_note(p_actor text, p_team uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actor is null or char_length(p_actor) = 0 then
    raise exception 'actor required';
  end if;
  insert into public.ops_team_meta (team_id, note, updated_at)
  values (p_team, p_note, now())
  on conflict (team_id) do update set note = excluded.note, updated_at = now();
  perform public.ops_log(p_actor, 'set_note', p_team, jsonb_build_object('length', coalesce(char_length(p_note), 0)));
  return jsonb_build_object('ok', true);
end $$;

-- Marks a team as internal so it drops out of every metric. Replaces the
-- hardcoded EXCLUDE_TEAMS list in the Worker's config, which meant editing and
-- redeploying to exclude a dogfooding account — the kind of friction that ends
-- with nobody excluding anything and every number quietly wrong.
create or replace function public.ops_set_team_internal(p_actor text, p_team uuid, p_internal boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actor is null or char_length(p_actor) = 0 then
    raise exception 'actor required';
  end if;
  insert into public.ops_team_meta (team_id, internal, updated_at)
  values (p_team, coalesce(p_internal, false), now())
  on conflict (team_id) do update set internal = excluded.internal, updated_at = now();
  perform public.ops_log(p_actor, 'set_internal', p_team, jsonb_build_object('internal', p_internal));
  return jsonb_build_object('ok', true);
end $$;

-- Rotates a team's join code. Support action for "our invite link leaked".
-- Deliberately does NOT return the old code anywhere.
create or replace function public.ops_rotate_invite(p_actor text, p_team uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_code uuid;
begin
  if p_actor is null or char_length(p_actor) = 0 then
    raise exception 'actor required';
  end if;
  update public.teams set invite_code = gen_random_uuid()
  where id = p_team returning invite_code into v_code;
  if v_code is null then raise exception 'no such team'; end if;
  perform public.ops_log(p_actor, 'rotate_invite', p_team, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'invite_code', v_code);
end $$;

-- Pre-issue a named onboarding invite. See onboarding_invites' comment for why
-- the panel cannot simply create the team itself.
create or replace function public.ops_create_onboarding_invite(
  p_actor text, p_team_name text, p_note text, p_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_token text;
begin
  if p_actor is null or char_length(p_actor) = 0 then
    raise exception 'actor required';
  end if;
  -- 32 hex chars of CSPRNG. Long enough that guessing is not a strategy, and
  -- it expires regardless.
  v_token := encode(gen_random_bytes(16), 'hex');
  insert into public.onboarding_invites (token, team_name, note, created_by, expires_at)
  values (v_token, p_team_name, p_note, p_actor, now() + make_interval(days => greatest(1, least(90, p_days))));
  perform public.ops_log(p_actor, 'create_onboarding_invite', null,
    jsonb_build_object('team_name', p_team_name, 'days', p_days));
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;

-- Redeemed by the NEW USER, running as themselves — this one is granted to
-- `authenticated`, not service_role. create_team therefore records them as
-- created_by and owner, exactly as an organic signup would.
create or replace function public.redeem_onboarding_invite(p_token text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare inv public.onboarding_invites; v_team uuid; v_code uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into inv from public.onboarding_invites
    where token = p_token and redeemed_at is null and expires_at > now();
  if inv.token is null then raise exception 'invalid or expired invite'; end if;

  select t.team_id, t.invite_code into v_team, v_code
    from public.create_team(inv.team_name, p_display_name) t;

  update public.onboarding_invites
    set redeemed_at = now(), redeemed_team = v_team
    where token = p_token;
  perform public.ops_log('system:redeem', 'redeem_onboarding_invite', v_team, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'team_id', v_team, 'invite_code', v_code);
end $$;

-- --- reads for the panel ---------------------------------------------------
create or replace function public.ops_audit_recent(p_limit int default 50)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'actor', a.actor, 'action', a.action, 'team', t.name, 'detail', a.detail, 'at', a.at
  ) order by a.at desc), '[]'::jsonb)
  from (select * from public.ops_audit order by at desc limit greatest(1, least(200, p_limit))) a
  left join public.teams t on t.id = a.target_team;
$$;

create or replace function public.ops_onboarding_invites()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'token', o.token, 'team_name', o.team_name, 'note', o.note,
    'created_by', o.created_by, 'created_at', o.created_at, 'expires_at', o.expires_at,
    'redeemed_at', o.redeemed_at, 'redeemed_team', t.name
  ) order by o.created_at desc), '[]'::jsonb)
  from public.onboarding_invites o
  left join public.teams t on t.id = o.redeemed_team;
$$;

-- Single-team drill-down: members and projects as metadata, plus a 12-week
-- activity sparkline. No content, and no author identity beyond the display
-- name the user themselves published to their team.
create or replace function public.ops_team_detail(p_team uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'name', (select name from public.teams where id = p_team),
    'created_at', (select created_at from public.teams where id = p_team),
    'note', (select note from public.ops_team_meta where team_id = p_team),
    'internal', coalesce((select internal from public.ops_team_meta where team_id = p_team), false),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('name', tm.display_name, 'role', tm.role, 'joined_at', tm.joined_at)
             order by tm.joined_at)
      from public.team_members tm where tm.team_id = p_team), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', p.name,
        'entries', (select count(*) from public.memory_entries e where e.project_id = p.id),
        'last_ts', (select max(e.ts) from public.memory_entries e where e.project_id = p.id))
      order by p.created_at)
      from public.projects p where p.team_id = p_team), '[]'::jsonb),
    'weeks', coalesce((
      select jsonb_agg(jsonb_build_object('week', to_char(w.wk, 'YYYY-MM-DD'), 'entries', (
        select count(*) from public.memory_entries e
        join public.projects p on p.id = e.project_id
        where p.team_id = p_team and e.ts >= w.wk and e.ts < w.wk + interval '1 week'
      )) order by w.wk)
      from generate_series(date_trunc('week', now()) - interval '11 weeks',
                           date_trunc('week', now()), interval '1 week') w(wk)), '[]'::jsonb)
  );
$$;

-- --- grants ----------------------------------------------------------------
-- Ops functions: service_role only. `anon` is the public internet and
-- `authenticated` is every signed-in customer.
revoke all on function public.ops_set_team_note(text, uuid, text) from public, anon, authenticated;
revoke all on function public.ops_set_team_internal(text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.ops_rotate_invite(text, uuid) from public, anon, authenticated;
revoke all on function public.ops_create_onboarding_invite(text, text, text, int) from public, anon, authenticated;
revoke all on function public.ops_audit_recent(int) from public, anon, authenticated;
revoke all on function public.ops_onboarding_invites() from public, anon, authenticated;
revoke all on function public.ops_team_detail(uuid) from public, anon, authenticated;

grant execute on function public.ops_set_team_note(text, uuid, text) to service_role;
grant execute on function public.ops_set_team_internal(text, uuid, boolean) to service_role;
grant execute on function public.ops_rotate_invite(text, uuid) to service_role;
grant execute on function public.ops_create_onboarding_invite(text, text, text, int) to service_role;
grant execute on function public.ops_audit_recent(int) to service_role;
grant execute on function public.ops_onboarding_invites() to service_role;
grant execute on function public.ops_team_detail(uuid) to service_role;
grant execute on function public.ops_log(text, text, uuid, jsonb) to service_role;

-- The redeem path is the exception, and deliberately so: it must run as the
-- NEW USER for create_team to record them as owner.
revoke all on function public.redeem_onboarding_invite(text, text) from public, anon;
grant execute on function public.redeem_onboarding_invite(text, text) to authenticated;
