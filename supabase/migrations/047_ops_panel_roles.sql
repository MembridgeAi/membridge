-- 047_ops_panel_roles.sql — two scoped Postgres roles for the ops panel, so it
-- stops authenticating as `service_role`.
--
-- THE PROBLEM. cloudflare/ops-api holds SUPABASE_SERVICE_KEY. `service_role`
-- has rolbypassrls and read+write on all fifteen public tables. Every
-- protection built into this schema — the access scoping in 037, the membership
-- predicates, the definer-function gates in 042, the blanket-grant revokes in
-- 043 — is downstream of a credential that ignores all of it. The Worker's RPC
-- allowlist constrains the panel's CODE; it constrains nothing about anyone
-- holding the extracted secret. And a stolen key used directly against
-- /rest/v1/ calls no RPC and writes no ops_audit row, so nothing would tell us.
--
-- wrangler.toml already names this: "A dedicated read-only Postgres role would
-- be strictly better and is the natural next hardening step."
--
-- ---------------------------------------------------------------------------
-- 1. WHAT THE PANEL ACTUALLY NEEDS — enumerated from the code, not the docs.
--
-- Every Supabase call in cloudflare/ops-api/src/index.js goes through one
-- helper, `rpc()`, which POSTs to /rest/v1/rpc/<fn>. There is NOT ONE direct
-- table read in the Worker — no /rest/v1/<table> anywhere. That single fact is
-- what makes this worth doing properly rather than just minting a smaller key.
--
--   READS   (GET paths)
--     ops_snapshot(uuid[])            index.js:238  the overview aggregates
--     ops_audit_recent(int)           index.js:239  last 50 audit rows
--     ops_onboarding_invites()        index.js:240  outstanding invites
--     ops_team_detail(uuid)           index.js:229  one team drill-down
--
--   WRITES  (POST /api/action, the ACTIONS table at index.js:39-44)
--     ops_set_team_note(text,uuid,text)
--     ops_set_team_internal(text,uuid,boolean)
--     ops_rotate_invite(text,uuid)
--     ops_create_onboarding_invite(text,text,text,int)
--
-- EIGHT, not the nine ops_* functions that exist. `ops_log` is granted to
-- service_role (021:292) and the Worker NEVER calls it — grep returns zero.
-- It is only invoked from INSIDE the other definer functions, where execution
-- is already the owner's and the caller's EXECUTE grant is irrelevant. So the
-- current credential carries a grant the panel has never used, and the scoped
-- roles drop it. That is not tidiness: ops_log is the function that WRITES the
-- audit row, so a leaked read credential that cannot execute it cannot forge
-- audit entries to cover a read.
--
-- ---------------------------------------------------------------------------
-- 2. CAN rolbypassrls BE DROPPED ENTIRELY? YES — and no table grants are
--    needed either, which is a stronger result than expected.
--
-- The worry was that a role belonging to no team would be denied everything by
-- RLS and would therefore need explicit table grants — a smaller master key
-- rather than a scoped one. That does not apply here, because the panel never
-- touches a table. All nine ops_* functions are SECURITY DEFINER, so their
-- bodies execute as the function OWNER, and it is the owner's privileges that
-- read ops_team_meta, teams, memory_entries and the rest. The caller supplies
-- nothing but the right to call.
--
-- So each role below gets exactly:
--     usage on schema public   (to resolve the function name)
--     execute on its own subset of the eight
-- and NOTHING else. No rolbypassrls. No table privileges at all. A leaked
-- ops_panel_read credential pointed at /rest/v1/teams gets a permission error,
-- not a table.
--
-- HONEST RESIDUAL: a new role still inherits whatever PUBLIC holds. In this
-- database that is not table access (Supabase grants tables to anon /
-- authenticated / service_role, not PUBLIC), and the definer functions worth
-- having were revoked from PUBLIC by 021 and 042. The two that remain
-- PUBLIC-executable are trigger functions, which raise "can only be called as
-- triggers" before running. So the practical answer is "the eight", but the
-- precise answer is "the eight plus PUBLIC", and PUBLIC is near-empty by
-- deliberate maintenance rather than by nature.
--
-- ---------------------------------------------------------------------------
-- 3. CAN THE WRITES BE SEPARATED FROM THE READS? YES, and cheaply.
--
-- The Worker already has a hard structural split: writes happen ONLY in the
-- `POST /api/action` branch, dispatched through the ACTIONS table. Every other
-- path is GET and read-only. So the split does not need the Worker to parse
-- function names or maintain a list that can drift — the two call sites already
-- exist and simply pass a different credential.
--
-- Worth it because the two dangerous actions are writes:
--   * ops_rotate_invite invalidates a team's standing invite code.
--   * ops_create_onboarding_invite mints a token that redeem_onboarding_invite
--     turns into a NEW TEAM owned by whoever redeems it.
-- A leaked read credential can see aggregates and an audit list. A leaked write
-- credential can mint team-creation tokens. Collapsing those into one secret
-- prices them the same.
--
-- NOT SOLVED HERE, stated so it is not mistaken for solved: both roles can pass
-- any string as p_actor, so a holder of the WRITE credential can still forge the
-- actor in the audit trail. The Worker sets p_actor from the verified Access
-- email, but the database cannot tell a direct caller from the Worker. That is
-- true of service_role today and is not made worse; fixing it needs the actor to
-- come from something the caller cannot choose, which is a different design.
--
-- ---------------------------------------------------------------------------
-- 4. WHAT BREAKS, HOW IT FAILS, AND THE ROLLBACK.
--
-- THIS MIGRATION ALONE CHANGES NOTHING ABOUT THE RUNNING PANEL. It creates two
-- roles and grants them EXECUTE. It does not touch service_role, does not
-- revoke anything, and nothing uses the new roles until the Worker is
-- redeployed with new secrets. Applying it is inert by construction; that is
-- deliberate, so the risky step is a Worker deploy with a one-command rollback
-- rather than a database change with a fiddly one.
--
-- service_role's existing grants are LEFT IN PLACE on purpose. They are the
-- rollback. Revoking the ops_* grants from service_role should be its own
-- migration, once the scoped roles have been running long enough to trust —
-- doing both at once would remove the fallback in the same change that needs it.
--
-- FAILURE MODES, in the order they are likely:
--
--   a) The role does not exist / the JWT names a role PostgREST cannot assume.
--      Every RPC fails. The panel's GET path catches each read separately, so
--      the overview renders with the business block showing an error and the
--      audit and invite lists EMPTY — see (b), which is the dangerous half.
--      Fix: check the role exists and `authenticator` can assume it (query at
--      the bottom of this file). Rollback: redeploy the previous Worker.
--
--   b) ONE grant is missing — the silent-downgrade case, and the one to watch.
--      index.js:239-240 catch failures as `.catch(() => [])`, so a permission
--      error on ops_audit_recent or ops_onboarding_invites renders an EMPTY
--      LIST, which is indistinguishable from "nothing has happened recently".
--      The panel looks healthy and is lying. This is why the runbook's check
--      after this change is "the audit list is NOT empty" rather than "the page
--      loads", and why the Worker change that accompanies this migration adds a
--      `degraded` field naming any read that failed.
--
--   c) Writes fail while reads work. Loud: the action returns a 500 with the
--      Postgres permission error, which the panel surfaces.
--
-- ROLLBACK, executable without the author:
--   Worker:   `wrangler rollback` (or redeploy the previous version) — it uses
--             SUPABASE_SERVICE_KEY, which is untouched and still works.
--   Database: the statements at the bottom of this file, commented out. Roles
--             own no objects, so dropping them cannot cascade to data.
--
-- ---------------------------------------------------------------------------
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` in this project, for
-- the reason 031, 032 and 033 all give. Every statement is re-runnable.
--
-- UNAPPLIED AS OF 2026-08-05. Nothing here has been run against any database.
-- State is recorded in supabase/MIGRATION-STATE.md; settle it with the
-- verification query at the foot of this file.
-- ---------------------------------------------------------------------------

-- `create role` has no `if not exists`, so both are guarded — the convention
-- 009:72-77 established and 024 was converted to. NOLOGIN is correct and is not
-- a limitation: PostgREST assumes a request role with SET ROLE from the JWT's
-- `role` claim, it never logs in as it. A role that cannot log in cannot be used
-- against the database directly even if someone reaches the port.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ops_panel_read') then
    create role ops_panel_read nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ops_panel_write') then
    create role ops_panel_write nologin noinherit;
  end if;
end $$;

-- PostgREST switches into the request role with SET ROLE, which requires that
-- `authenticator` be a member of it. Without these two lines the JWT is valid
-- and every request still fails — failure mode (a) above.
grant ops_panel_read  to authenticator;
grant ops_panel_write to authenticator;

-- Resolve names in public. NOT a data privilege: usage on a schema permits
-- looking objects up, nothing more.
grant usage on schema public to ops_panel_read, ops_panel_write;

-- --- reads -----------------------------------------------------------------
grant execute on function public.ops_snapshot(uuid[])          to ops_panel_read;
grant execute on function public.ops_audit_recent(int)         to ops_panel_read;
grant execute on function public.ops_onboarding_invites()      to ops_panel_read;
grant execute on function public.ops_team_detail(uuid)         to ops_panel_read;

-- --- writes ----------------------------------------------------------------
-- Deliberately disjoint from the reads: the write credential is used only on
-- the POST /api/action path, which never reads. Giving it the reads too would
-- make it a superset for no caller that exists.
grant execute on function public.ops_set_team_note(text, uuid, text)                to ops_panel_write;
grant execute on function public.ops_set_team_internal(text, uuid, boolean)         to ops_panel_write;
grant execute on function public.ops_rotate_invite(text, uuid)                      to ops_panel_write;
grant execute on function public.ops_create_onboarding_invite(text, text, text, int) to ops_panel_write;

-- ops_log is deliberately granted to NEITHER. See §1: the Worker never calls
-- it, and the four write RPCs invoke it internally as the definer's owner.

-- ---------------------------------------------------------------------------
-- VERIFY — run this after applying. Expect exactly eight rows, four per role,
-- and `can_assume` true for both.
--
--   select r.rolname, p.proname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     cross join lateral (values ('ops_panel_read'), ('ops_panel_write')) as r(rolname)
--    where n.nspname = 'public'
--      and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
--      and p.proname like 'ops_%'
--    order by r.rolname, p.proname;
--
--   select rolname, rolbypassrls, rolcanlogin from pg_roles
--    where rolname in ('ops_panel_read','ops_panel_write');
--   -- expect rolbypassrls = f and rolcanlogin = f for both
--
--   select pg_has_role('authenticator', 'ops_panel_read',  'MEMBER') as can_assume_read,
--          pg_has_role('authenticator', 'ops_panel_write', 'MEMBER') as can_assume_write;
--
-- And the negative check that proves the point — neither role can read a table:
--
--   select has_table_privilege('ops_panel_read', 'public.teams', 'SELECT') as should_be_false,
--          has_table_privilege('ops_panel_read', 'public.memory_entries', 'SELECT') as also_false;
--
-- ---------------------------------------------------------------------------
-- ROLLBACK — commented out on purpose. Roles own no objects, so this cannot
-- cascade to data. Run it only after the Worker is back on SUPABASE_SERVICE_KEY,
-- or the panel loses its credential mid-flight.
--
--   revoke all on schema public from ops_panel_read, ops_panel_write;
--   revoke all on all functions in schema public from ops_panel_read, ops_panel_write;
--   revoke ops_panel_read  from authenticator;
--   revoke ops_panel_write from authenticator;
--   drop role if exists ops_panel_read;
--   drop role if exists ops_panel_write;
-- ---------------------------------------------------------------------------
