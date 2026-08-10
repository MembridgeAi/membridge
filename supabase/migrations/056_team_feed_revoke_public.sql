-- ---------------------------------------------------------------------------
-- 056: take public.team_feed off the PUBLIC grant, and keep it off.
--
-- UNAPPLIED AS OF 2026-08-08. Verify:
--   select count(*) from pg_proc p, aclexplode(p.proacl) a
--    where p.oid = 'public.team_feed(uuid, timestamptz, bigint, integer, uuid,
--                   uuid, text, timestamptz, timestamptz)'::regprocedure
--      and a.grantee = 0 and a.privilege_type = 'EXECUTE';
-- Applied when that returns 0 (grantee 0 is PUBLIC). State recorded in
-- supabase/MIGRATION-STATE.md and nowhere else.
--
-- SEVERITY, STATED HONESTLY: **no data is exposed today.** An anonymous caller
-- reaching this function still gets nothing, because `is_team_member` denies
-- unconditionally for a null identity — verified by inlining the real bodies
-- under a genuinely null `auth.uid()` across all seven live projects. This is
-- defence in depth on a boundary that currently holds by one boolean. It is
-- not an active leak and must not be described as one.
--
-- ---------------------------------------------------------------------------
-- WHY THIS KEEPS COMING BACK — IT IS A TREADMILL, NOT AN OVERSIGHT
--
-- `create or replace` cannot change a function's RETURNS TABLE column list, and
-- team_feed kept gaining columns, so every change to it has had to be
-- `drop function` + `create`. **A drop resets the ACL to the Postgres default,
-- which is EXECUTE to PUBLIC.** The full sequence, all of it in this repo:
--
--   010  revoke from public, anon   +  grant to authenticated, service_role
--   013  drop + create  -> ACL back to PUBLIC
--   014  drop + create  -> ACL back to PUBLIC
--   017  drop + create  -> ACL back to PUBLIC
--   025  drop + create  -> ACL back to PUBLIC     <- the last one; current state
--   054  revoke ... from anon                     <- NO-OP, see below
--
-- Four resets after the one correct revoke, and nothing since 025 has granted
-- or revoked anything.
--
-- WHY 054:201 DID NOT FIX IT. It says `revoke ... from anon`. `anon` has no
-- DIRECT grant to remove — it reaches the function purely as a member of
-- PUBLIC — so the statement succeeds, changes nothing, and leaves `=X/postgres`
-- standing. Revoking from a role that only ever had access via PUBLIC is a
-- statement that always succeeds and never does anything. That is this
-- codebase's signature defect wearing SQL: the file that most looks like it
-- enforces this is the file that does not.
--
-- ---------------------------------------------------------------------------
-- THE LIVE ACL, AND WHY THIS FILE ALSO GRANTS
--
-- Read out of production with `aclexplode` on 2026-08-08:
--
--   grantee          privilege
--   -  (PUBLIC)      EXECUTE     <- what this migration removes
--   authenticated    EXECUTE     <- a DIRECT grant, present today
--   postgres         EXECUTE
--   service_role     EXECUTE
--
-- So the only change this file makes to current behaviour is dropping PUBLIC.
-- `authenticated` already holds EXECUTE directly, and the grant below is a
-- no-op against production as it stands today.
--
-- **The grant is here for the NEXT drop+create, not for today.** A drop
-- discards every grant on the function, `authenticated`'s included. A migration
-- that revokes PUBLIC without re-issuing the grant therefore leaves a landmine:
-- whoever recreates team_feed next inherits a file whose only ACL statement is
-- a revoke, restores nothing, and the function comes back both PUBLIC-callable
-- and — once someone re-applies the revoke alone — unreachable by the users who
-- need it. Pairing them makes this file complete on its own, which is what 010
-- did and what 042 does for its three functions.
--
-- PROVENANCE, UNRESOLVED AND WORTH ONE SENTENCE: `authenticated`'s direct grant
-- is not explained by this repo. 010:410 is the only `grant execute ... on
-- team_feed` in the tree, and 013, 014, 017 and 025 each dropped the function
-- afterwards, which would have discarded it. Something re-granted it and that
-- something is not committed here. Not guessed at — recorded so the next person
-- knows the tree does not account for the live ACL.
--
-- WHAT WAS WRONG IN THE FIRST DRAFT OF THIS HEADER, since it is the same
-- mistake this migration exists to catch: it asserted that `authenticated` held
-- no direct grant and that a bare revoke would take the feed down for every
-- user. That was reasoned entirely from repo history, which is a claim about
-- the files, not about production — and production disagreed. The repo is not
-- evidence of live state. That is the whole lesson of the 041-053 reconcile,
-- and it applies to headers as readily as to ledgers.
--
-- ---------------------------------------------------------------------------
-- THIS FILE FAILS LOUDLY RATHER THAN NO-OPPING
--
-- The failure above was silent because a revoke against a wrong or absent
-- signature still reports success. Both guards below exist so that cannot
-- happen again here:
--
--   * The PRE guard refuses to run if that exact 9-argument signature does not
--     exist live, instead of revoking from a signature nobody has.
--   * The POST guard re-reads the ACL and raises if PUBLIC still holds EXECUTE,
--     or if `authenticated` lost it. The migration cannot report success
--     without having achieved it.
--
-- Both are `raise exception`, so the editor's transaction rolls the whole file
-- back. Re-runnable: revoke and grant are idempotent, and the guards simply
-- pass on a second run.
--
-- SIGNATURE — CONFIRM BEFORE APPLYING. Every file in this repo spells it the
-- same way and 025 is the live definition, but a signature copied from a file
-- is exactly what made 054's revoke a no-op, so the PRE guard checks it rather
-- than trusting it. To see it yourself first:
--   select pg_get_function_identity_arguments(oid) from pg_proc
--    where proname = 'team_feed';
-- ---------------------------------------------------------------------------

-- PRE: the signature must exist, or this file is revoking from nothing.
do $$
begin
  if to_regprocedure('public.team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)') is null then
    raise exception
      'team_feed does not exist with the 9-argument signature this migration targets. '
      'Run: select pg_get_function_identity_arguments(oid) from pg_proc where proname = ''team_feed''; '
      'then update this file to the live signature. Do NOT edit the guard away — a revoke '
      'against the wrong signature succeeds and does nothing, which is how 054:201 became a no-op.';
  end if;
end $$;

revoke execute on function public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)
  from public, anon;

-- A no-op against production today (`authenticated` already holds this grant
-- directly). It is here so the file stays correct after the NEXT drop+create
-- discards every grant — see the header. Do not delete it as redundant.
grant execute on function public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)
  to authenticated, service_role;

-- POST: prove both halves landed. grantee 0 is PUBLIC in aclexplode.
do $$
declare
  public_execute int;
begin
  select count(*) into public_execute
  from pg_proc p, aclexplode(p.proacl) a
  where p.oid = 'public.team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)'::regprocedure
    and a.grantee = 0
    and a.privilege_type = 'EXECUTE';

  if public_execute > 0 then
    raise exception 'team_feed is STILL EXECUTE-able by PUBLIC after the revoke — do not record this migration as applied';
  end if;

  if not has_function_privilege('authenticated',
       'public.team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)'::regprocedure,
       'EXECUTE') then
    raise exception 'authenticated lost EXECUTE on team_feed — the team feed would be down for every user';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE RULE THIS FILE ESTABLISHES, FOR WHOEVER TOUCHES team_feed NEXT
--
-- **Any migration that drops and recreates a definer function must re-issue
-- that function's revoke and grant in the same file.** The drop discards the
-- ACL; if the file does not put it back, the function ships PUBLIC-callable and
-- nothing in the repo will say so. This has now happened four times to
-- team_feed alone.
--
-- `test/suites/migration-state.test.js` enforces this for migrations numbered
-- 056 and up — see its "recreating a guarded definer function" check. What that
-- gate CANNOT do: it reads the repo, so a statement pasted straight into the
-- SQL editor and never committed escapes it entirely, which is the documented
-- way changes have reached this database before. It narrows the recurrence that
-- actually occurred; it does not make the rule self-enforcing.
-- ---------------------------------------------------------------------------
