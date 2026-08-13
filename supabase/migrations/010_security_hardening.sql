-- 010_security_hardening.sql — invite tokens get a CSPRNG and a fixed length,
-- outstanding tokens are rotated, invite guessing is throttled, and EXECUTE on
-- the SECURITY DEFINER RPC surface is cut back to the roles that need it.
--
-- ⚠ HEADS-UP FOR MARCO: §2 ROTATES EVERY LIVE INVITE TOKEN. Any invite link
-- created before this migration stops working the moment it is applied. That
-- is intentional — tokens minted by the old generator are weak (§1) and cannot
-- be trusted — but it means outstanding links must be re-issued and re-sent
-- (`membridge team invite`, or the web settings screen) after applying.
--
-- Style matches 002–008: additive, re-runnable, written for the Supabase SQL
-- editor (which runs the script in one transaction) or `supabase db push`.
-- §1 and §3 end in DO-block self-checks that raise on failure, so a broken
-- apply rolls back whole rather than half-landing. If you apply with psql,
-- use `psql -1 -f` to keep that single-transaction property.
--
-- Deliberately NOT here, tracked in docs/PRELAUNCH.md instead (Supabase
-- dashboard settings, not SQL): enable leaked-password protection, and review
-- the Auth rate limits for sign-in/OTP — those are the backstop for what a
-- SQL-level throttle cannot see (§3 explains that limit).

-- ---------------------------------------------------------------------------
-- §0 pgcrypto: gen_random_bytes() / digest() below need it. Supabase keeps
-- extensions in the `extensions` schema (its linter flags extensions installed
-- into `public`); `if not exists` makes this a no-op wherever pgcrypto is
-- already enabled, whichever schema it lives in.
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- §1 gen_invite_token: CSPRNG + guaranteed length.
--
-- The old body drew positions with `1 + floor(random() * 58)` over a 54-char
-- alphabet, so ~7% of draws hit substr() past the end and appended '' — about
-- half of all real tokens came out shorter than 10 chars (shortest observed:
-- 6). And random() is a seeded PRNG, not a CSPRNG — the wrong tool for a
-- token that grants team access. New body: pgcrypto's gen_random_bytes with
-- rejection sampling onto the same confusable-free 54-char alphabet, at 16
-- chars instead of 10 (54^16 ≈ 6e27, so online guessing is dead even without
-- §3's throttle).
--
-- search_path is pinned — this was the one function the linter flagged as
-- function_search_path_mutable. The pin lists `extensions` because that is
-- where pgcrypto lives on Supabase; it also lists `public` so a database
-- where pgcrypto was historically installed into `public` keeps working.
-- CREATE OR REPLACE preserves the function's OID, so the `invites.token`
-- column default keeps pointing here and picks up the new implementation.
-- ---------------------------------------------------------------------------
create or replace function public.gen_invite_token()
returns text
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  -- Identical alphabet to the old generator (no 0/O/o, 1/I/i/l/L): 54 chars.
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  token text := '';
  buf bytea;
  i integer;
  b integer;
begin
  while length(token) < 16 loop
    buf := gen_random_bytes(24);
    i := 0;
    while i < 24 and length(token) < 16 loop
      b := get_byte(buf, i);
      -- Rejection sampling: use a byte only when it is below 216 (= 4 × 54,
      -- the largest multiple of 54 ≤ 256), so `b % 54` is exactly uniform.
      -- A bare modulo would favor the first 256 % 54 = 40 alphabet chars.
      if b < 216 then
        token := token || substr(alphabet, (b % 54) + 1, 1);
      end if;
      i := i + 1;
    end loop;
  end loop;
  return token;
end;
$$;

-- Self-check: 500 fresh tokens must all be 16 chars, drawn from the alphabet,
-- and pairwise distinct. Raises — aborting the migration — on any violation.
do $$
declare
  v_tokens text[];
  v_bad bigint;
begin
  select array_agg(t.tok) into v_tokens
  from (select public.gen_invite_token() as tok
        from generate_series(1, 500)) t;

  select count(*) into v_bad from unnest(v_tokens) tok where length(tok) <> 16;
  if v_bad > 0 then
    raise exception 'gen_invite_token self-check: % of 500 tokens are not 16 chars', v_bad;
  end if;

  select count(*) into v_bad from unnest(v_tokens) tok
  where translate(tok,
    '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ', '') <> '';
  if v_bad > 0 then
    raise exception 'gen_invite_token self-check: % tokens contain out-of-alphabet chars', v_bad;
  end if;

  if (select count(distinct tok) from unnest(v_tokens) tok) <> 500 then
    raise exception 'gen_invite_token self-check: duplicate token within 500 draws';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §2 Rotate every still-live invite token. Tokens minted by the old generator
-- are short and PRNG-derived, so they are replaced wholesale; revoked and
-- already-expired rows are left alone (they can never be redeemed anyway).
-- THIS IS THE STEP THAT BREAKS OUTSTANDING INVITE LINKS — see the header.
-- ---------------------------------------------------------------------------
update public.invites
   set token = public.gen_invite_token()
 where revoked_at is null
   and (expires_at is null or expires_at > now());

-- ---------------------------------------------------------------------------
-- §3 Throttle the invite oracle. peek_invite is anon-callable by design (the
-- /join/<token> landing page runs signed-out) and answers "is this token
-- valid", so before this migration an attacker could test guesses at full API
-- speed. peek_invite and redeem_invite now record the caller in
-- invite_attempts and refuse more than 10 calls per minute per caller.
--
-- Keying choice — client IP, not token prefix. The request IP IS reachable
-- from SQL on Supabase: PostgREST publishes the HTTP request headers as the
-- `request.headers` GUC. A token-prefix key was considered and rejected:
-- brute-force guesses each carry a *different* token, so per-prefix buckets
-- would never accumulate and only exact-retry spam would ever be slowed.
-- Header trust order matters — the leftmost x-forwarded-for entry is
-- client-supplied and trivially rotated to escape the bucket, so we prefer
-- cf-connecting-ip (stamped by Cloudflare in front of the Supabase gateway;
-- not client-forgeable), then the LAST x-forwarded-for hop (appended by the
-- trusted edge), then x-real-ip. Calls with no request context (SQL editor,
-- psql, tests) share one 'direct' bucket. Only sha256(ip) is stored and rows
-- are pruned after an hour: this is a throttle, not an access log.
-- ---------------------------------------------------------------------------
create table if not exists public.invite_attempts (
  ip_hash text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists invite_attempts_key_time_idx
  on public.invite_attempts (ip_hash, attempted_at);

-- Clients never touch this table — only the SECURITY DEFINER functions below
-- do, as the table owner, whom RLS does not bind. Enabling RLS with no
-- policies plus revoking the Supabase default-privilege grants closes direct
-- reads/writes that would let a caller inspect or forge attempt history.
alter table public.invite_attempts enable row level security;
revoke all on table public.invite_attempts from public, anon, authenticated;

create or replace function public.check_invite_attempt()
returns void
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  v_headers json;
  v_xff text[];
  v_ip text;
  v_key text;
  v_recent bigint;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null; -- absent/malformed header GUC → the 'direct' bucket
  end;
  if v_headers is not null then
    v_ip := v_headers ->> 'cf-connecting-ip';
    if v_ip is null then
      v_xff := string_to_array(coalesce(v_headers ->> 'x-forwarded-for', ''), ',');
      if coalesce(array_length(v_xff, 1), 0) >= 1 then
        v_ip := nullif(trim(v_xff[array_length(v_xff, 1)]), '');
      end if;
    end if;
    if v_ip is null then
      v_ip := v_headers ->> 'x-real-ip';
    end if;
  end if;
  v_key := encode(digest(coalesce(v_ip, 'direct'), 'sha256'), 'hex');

  -- Opportunistic prune keeps the table at ≤ 1 hour of attempts.
  delete from public.invite_attempts
   where attempted_at < now() - interval '1 hour';

  select count(*) into v_recent
    from public.invite_attempts
   where ip_hash = v_key
     and attempted_at > now() - interval '1 minute';
  if v_recent >= 10 then
    raise exception 'too many attempts, try again shortly';
  end if;

  insert into public.invite_attempts (ip_hash) values (v_key);
end;
$$;

-- peek_invite: same signature and result shape as 002, now throttled. It was
-- `language sql ... stable`; it must become volatile plpgsql because it now
-- writes an attempt row. supabase-js invokes RPCs via POST, so the volatility
-- change is invisible to clients (the join page keeps working unchanged).
create or replace function public.peek_invite(p_token text)
returns table (team_name text, valid boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform public.check_invite_attempt();
  return query
    select t.name,
           (i.revoked_at is null
            and (i.expires_at is null or i.expires_at > now())
            and (i.max_uses is null or i.use_count < i.max_uses))
    from public.invites i
    join public.teams t on t.id = i.team_id
    where i.token = p_token;
end;
$$;

-- redeem_invite: 003's body with the throttle check up front. Behavior is
-- otherwise unchanged — same raises, same messages, same use_count handling.
--
-- Honest limitation, stated plainly: redeem_invite RAISES on an invalid /
-- revoked / expired / used-up token, and a raised exception rolls back the
-- whole request transaction — including the attempt row the throttle just
-- inserted. So failed redeem guesses are *checked against* the window (which
-- peeks and successful redeems fill) but do not themselves persist attempts;
-- a redeem-only brute force is not slowed by SQL alone. In-transaction SQL
-- cannot count its own aborted calls — the fixes that could (an Edge Function
-- wrapper in front of the RPC, or gateway rate limits) live outside SQL, and
-- PRELAUNCH tracks reviewing Supabase's Auth rate limits as the manual
-- backstop. Accepted here because (a) redeem requires an authenticated user,
-- so account signup friction and Auth rate limits gate the caller, and
-- (b) after §1/§2 the token space is 54^16 ≈ 6e27 — online guessing is
-- infeasible with or without a throttle. peek_invite — the anon-reachable
-- oracle, the actual attack surface — never raises except when throttled, so
-- its attempt rows always commit and the throttle there is fully effective.
create or replace function public.redeem_invite(p_token text, p_display_name text)
returns table (team_id uuid, team_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_team public.teams;
begin
  perform public.check_invite_attempt();
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_invite from public.invites where invites.token = p_token;
  if v_invite.token is null then
    raise exception 'invalid invite link';
  end if;
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
  -- Bare `on conflict do nothing`, no target -- same reasoning as
  -- join_team in schema.sql. It is not resting on the composite PK being
  -- this table's only constraint (057 added a second one, a partial unique
  -- index on display_name); the guarantee that the name in this INSERT is
  -- already collision-free -- so this can only ever hit the PK -- rests on
  -- BOTH of 057's writers of display_name taking its per-team advisory
  -- lock (the before-insert trigger and set_display_name), not on either
  -- one alone. See 057's header if this ever needs re-checking.
  insert into public.team_members (team_id, user_id, display_name)
    values (v_team.id, auth.uid(), p_display_name)
    on conflict do nothing;
  if found then
    update public.invites set use_count = use_count + 1
      where invites.token = p_token;
  end if;
  return query select v_team.id, v_team.name;
end;
$$;

-- Self-check: 10 calls in a minute pass, the 11th must be refused. The check
-- runs in the migration session (no request headers → the 'direct' bucket);
-- its rows are cleared afterwards so real callers start with an empty window.
do $$
declare
  i integer;
  v_blocked boolean := false;
begin
  for i in 1..10 loop
    perform * from public.peek_invite('selfcheck-not-a-real-token');
  end loop;
  begin
    perform * from public.peek_invite('selfcheck-not-a-real-token');
  exception when others then
    if sqlerrm like 'too many attempts%' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'invite-throttle self-check: 11th call in a minute was not refused';
  end if;
  delete from public.invite_attempts;
end $$;

-- ---------------------------------------------------------------------------
-- §4 Least-privilege EXECUTE on the RPC surface (silences the ~20 "anon can
-- execute SECURITY DEFINER" linter warnings). None of these were exploitable
-- — every definer function already gates internally on auth.uid() or team
-- membership, verified per-function below (2026-07-17) — so this pass is
-- defense-in-depth: anon keeps EXECUTE only where a signed-out caller is the
-- point, and a future function whose internal gate is forgotten is no longer
-- reachable by anon by default… for these functions; see the note at the end
-- about default privileges for future ones.
--
-- Two grant mechanics that are easy to get wrong, spelled out once:
--   • Postgres grants EXECUTE on every new function to PUBLIC by default, and
--     Supabase's default privileges add explicit anon / authenticated /
--     service_role grants on top. So each revoke below names BOTH public and
--     anon, and app access is re-granted explicitly instead of being
--     inherited from either mechanism.
--   • CREATE OR REPLACE preserves an existing function's ACL (002–008 and §3
--     above all use it), so replacing a function never reset its grants —
--     these revokes are what actually change the ACLs.
--
-- Kept anon-executable, deliberately:
--   • peek_invite — the /join/<token> landing page previews an invite before
--     the visitor has an account (web/app/join/[token]/page.js calls it
--     signed-out). Throttled by §3.
--   • is_team_member — referenced by the RLS policies on teams, team_members,
--     projects, memory_entries, and invites; policy expressions evaluate with
--     the CALLER's privileges, so revoking it from anon would turn every
--     signed-out table read from "0 rows" into "permission denied for
--     function is_team_member". With auth.uid() null it can only return
--     false — it discloses nothing.
--
-- Locked down to the owner only (no client role):
--   • gen_invite_token — runs only inside create_invite, via the invites.token
--     column default, which executes as the definer (the owner).
--   • check_invite_attempt — internal to §3's functions; directly callable it
--     would let anyone burn another caller's attempt budget.
-- ---------------------------------------------------------------------------
revoke execute on function public.gen_invite_token() from public, anon, authenticated, service_role;
revoke execute on function public.check_invite_attempt() from public, anon, authenticated, service_role;

revoke execute on function public.peek_invite(text) from public;
grant execute on function public.peek_invite(text) to anon, authenticated, service_role;

revoke execute on function public.is_team_member(uuid) from public;
grant execute on function public.is_team_member(uuid) to anon, authenticated, service_role;

-- Signed-in-only RPCs. Internal gate per function (why anon loses nothing):
--   create_team        raises 'not authenticated' when auth.uid() is null
--   join_team          raises 'not authenticated'
--   link_project       raises 'not authenticated', then membership check
--   my_teams           filters on auth.uid() → anon always got zero rows
--   team_role          selects the caller's own row → anon always got null
--   is_team_manager    derives from team_role → anon always got false
--   create_invite      raises 'not authenticated', then is_team_manager
--   revoke_invite      is_team_manager gate; revoking anon also closes a
--                      token-existence oracle (anon could distinguish
--                      'unknown invite' from the permission error)
--   redeem_invite      raises 'not authenticated' (+ §3 throttle)
--   remove_member      is_team_manager gate, owner protected
--   set_role           owner-only gate
--   rename_team        is_team_manager gate
--   rotate_invite      is_team_manager gate
--   leave_team         deletes the caller's own row → anon was a no-op
--   team_members_list  WHERE is_team_member → anon always got zero rows
--   team_feed          WHERE is_team_member → anon always got zero rows
--   archive_project    is_team_manager gate
--   unarchive_project  is_team_manager gate
revoke execute on function public.create_team(text, text) from public, anon;
grant execute on function public.create_team(text, text) to authenticated, service_role;
revoke execute on function public.join_team(uuid, text) from public, anon;
grant execute on function public.join_team(uuid, text) to authenticated, service_role;
revoke execute on function public.link_project(uuid, text, text) from public, anon;
grant execute on function public.link_project(uuid, text, text) to authenticated, service_role;
revoke execute on function public.my_teams() from public, anon;
grant execute on function public.my_teams() to authenticated, service_role;
revoke execute on function public.team_role(uuid) from public, anon;
grant execute on function public.team_role(uuid) to authenticated, service_role;
revoke execute on function public.is_team_manager(uuid) from public, anon;
grant execute on function public.is_team_manager(uuid) to authenticated, service_role;
revoke execute on function public.create_invite(uuid, timestamptz, integer) from public, anon;
grant execute on function public.create_invite(uuid, timestamptz, integer) to authenticated, service_role;
revoke execute on function public.revoke_invite(text) from public, anon;
grant execute on function public.revoke_invite(text) to authenticated, service_role;
revoke execute on function public.redeem_invite(text, text) from public, anon;
grant execute on function public.redeem_invite(text, text) to authenticated, service_role;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated, service_role;
revoke execute on function public.set_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_role(uuid, uuid, text) to authenticated, service_role;
revoke execute on function public.rename_team(uuid, text) from public, anon;
grant execute on function public.rename_team(uuid, text) to authenticated, service_role;
revoke execute on function public.rotate_invite(uuid) from public, anon;
grant execute on function public.rotate_invite(uuid) to authenticated, service_role;
revoke execute on function public.leave_team(uuid) from public, anon;
grant execute on function public.leave_team(uuid) to authenticated, service_role;
revoke execute on function public.team_members_list(uuid) from public, anon;
grant execute on function public.team_members_list(uuid) to authenticated, service_role;
revoke execute on function public.team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz) to authenticated, service_role;
revoke execute on function public.archive_project(uuid) from public, anon;
grant execute on function public.archive_project(uuid) to authenticated, service_role;
revoke execute on function public.unarchive_project(uuid) from public, anon;
grant execute on function public.unarchive_project(uuid) to authenticated, service_role;

-- Deliberately NOT done here: `alter default privileges … revoke execute on
-- functions from public/anon`, which would harden FUTURE functions too. With
-- migrations applied by hand and no migration history on the live DB
-- (PRELAUNCH "Migration tracking"), a silent default-privilege change is a
-- foot-gun: the next hand-applied migration's functions would come up broken
-- for the app with no error at create time. Adopt it together with tracked
-- migrations.
