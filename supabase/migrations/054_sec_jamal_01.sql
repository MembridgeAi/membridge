-- 054_sec_jamal_01.sql — three confirmed findings from the jamal audit,
-- landed as ONE migration so Marco can apply or roll back as a unit.
--
-- ===========================================================================
-- UNAPPLIED AS OF 2026-08-06. Verify per finding:
--   1. peek_invite name leak:
--        select prosrc from pg_proc where proname = 'peek_invite';
--      Applied when the body carries a `case when ... then t.name else null end`
--      (or an inline conditional producing NULL) instead of a bare `t.name`.
--   2. can_see_project terminal fallback:
--        select pg_get_functiondef('public.can_see_project(uuid)'::regprocedure);
--      Applied when the third arm of the coalesce is `false`, not `true`.
--   3. projects_materialize_access grants:
--        select has_function_privilege('anon',
--          'public.projects_materialize_access()'::regprocedure, 'EXECUTE');
--      Applied when both `anon` and `public` return `false` (and by extension
--      `authenticated` too).
-- Ledger row in supabase/MIGRATION-STATE.md — this header links there.
-- ===========================================================================
--
-- REGISTRY. Claimed as 054 in supabase/APPLY-RUNBOOK.md — see that table for
-- the next-free number. Nothing here overlaps another lane's numbering: the
-- last claim is 053 on `agent-deletion`, and this is the next.
--
-- LIVE SHAPE VERIFIED 2026-08-06 for the two function replacements. Both
-- `peek_invite` and `can_see_project` bodies were read out of pg_proc BEFORE
-- this file was written, and they are quoted verbatim in
-- `claude/ops/rollback-sec-jamal-01.md` alongside the pre-054 grant matrix. The
-- new bodies below carry the smallest possible diff against those pastes so
-- reviewers can see exactly what changed.
--
-- BLAST RADIUS. Every caller of `peek_invite` and `can_see_project` picks up
-- the new body immediately, because `create or replace` preserves the ACL and
-- dependent-object bindings. `peek_invite` has ONE caller — the invite-preview
-- screen; `can_see_project` is referenced by the `memory_entries_select`
-- policy from 025 and by the write policies added in 033, so RLS on
-- `memory_entries` picks up the change on the next query with no client-side
-- work. The revokes are pure surface reduction: their targets are either
-- constant-false for anon (`is_team_member`), returned-empty for anon
-- (`team_feed`), or unreachable except as a trigger (`projects_materialize_access`).
--
-- HOW TO APPLY: SQL editor only, never `supabase db push` (031, 032, 033 all
-- explain why). Every statement is re-runnable. After applying, run the three
-- verify queries in the UNAPPLIED block above and update MIGRATION-STATE.md
-- and APPLY-RUNBOOK.md in the same change — the drift these files exist to
-- prevent starts when applying is treated as a separate task from recording.


-- ---------------------------------------------------------------------------
-- FINDING 1 (SEC-jamal-01, finding 1) — peek_invite name leak on revoked /
-- expired / exhausted invites.
--
-- The current body returns the team name unconditionally as long as a token
-- row exists. That means a bearer of a token which was revoked, expired, or
-- exhausted still learns the CURRENT team name — including a name change made
-- AFTER their access was cut. Rate-limited by check_invite_attempt(), so it is
-- not enumeration, but it does confuse "you had a valid ticket" with "you have
-- a right to know the current team name."
--
-- The signature is unchanged. Both columns still come back with the same types.
-- What changes is that `team_name` is NULL whenever `valid` is false, so a
-- client presented with `(null, false)` cannot show "your invite to <name> has
-- expired" for a team you no longer belong to.
--
-- The rate-limit call is preserved verbatim so callers see the same failure
-- shape they see today.
-- ---------------------------------------------------------------------------

create or replace function public.peek_invite(p_token text)
returns table(team_name text, valid boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.check_invite_attempt();
  return query
    select
      case
        when (i.revoked_at is null
              and (i.expires_at is null or i.expires_at > now())
              and (i.max_uses is null or i.use_count < i.max_uses))
          then t.name
        else null
      end as team_name,
      (i.revoked_at is null
       and (i.expires_at is null or i.expires_at > now())
       and (i.max_uses is null or i.use_count < i.max_uses)) as valid
    from public.invites i
    join public.teams t on t.id = i.team_id
    where i.token = p_token;
end;
$$;


-- ---------------------------------------------------------------------------
-- FINDING 2 (SEC-jamal-01, finding 2) — can_see_project has a LATENT
-- terminal-`true` fallback.
--
-- The chain `coalesce(bool_and(over empty), projects.default_access, true)`
-- currently never reaches the terminal `true` because `projects.default_access`
-- is `NOT NULL DEFAULT true`, so the second arm always returns a value. If a
-- future migration relaxes that NOT NULL — the column is on the schema surface
-- and could be legitimately widened — a member with no `project_access` row
-- silently reads the feed.
--
-- Fix in the function, not the column. The column's NOT NULL is a separate
-- decision with its own history and its own consumers; changing the function
-- makes the safe default independent of what the column ends up doing.
--
-- No other branch changes. The empty-`project_access` case still resolves to
-- the project's `default_access`; the terminal arm only fires if the project
-- itself has no row (which should not happen for a valid p_project), and in
-- that case `false` — deny — is the safe answer.
-- ---------------------------------------------------------------------------

create or replace function public.can_see_project(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select bool_and(a.can_see) from public.project_access a
       where a.project_key = p_project::text and a.member_id = auth.uid()),
    (select p.default_access from public.projects p where p.id = p_project),
    false
  );
$$;


-- ---------------------------------------------------------------------------
-- FINDING 3 (SEC-jamal-01, finding 3) — projects_materialize_access has the
-- default PUBLIC grant, so any anon or authenticated client can call it.
--
-- CORRECTION to jamal's original writeup. jamal read `information_schema.triggers`
-- and concluded the trigger was NOT wired, and proposed adding one. That was
-- wrong — `information_schema.triggers` is a permission-filtered view and the
-- MCP session running it did not see the row. doubting-thomas re-checked via
-- `pg_trigger` and found the trigger IS wired
-- (`CREATE TRIGGER projects_materialize_access AFTER INSERT ON public.projects`).
-- Adding a SECOND trigger would fire the materializer twice per insert and
-- double the writes to `project_access` — actively harmful. The only correct
-- fix is REVOKE.
--
-- 042 explicitly EXCLUDED this function from its revoke sweep on the reasoning
-- that a trigger function invoked directly raises "trigger functions can only
-- be called as triggers" before executing a single statement of its body, so
-- the PUBLIC grant confers nothing on a caller. That reasoning is correct as a
-- data-safety argument and leaves the fingerprint intact anyway: an anon
-- caller who probes definer surface still sees this function respond, which
-- reduces a two-layer defence to one — the same reduction 042 fixed for its
-- three targets. Removing the anon-callable surface eliminates the fingerprint
-- and closes the audit finding.
--
-- No `grant` follows this revoke. The trigger fires via SYSTEM invocation
-- (the executor, not a caller's ACL), so revoking EXECUTE from every visible
-- principal leaves the trigger flow untouched. Confirmed empirically by the
-- pattern in 042 — `projects_materialize_access` there was left alone SOLELY
-- because it was a trigger function, not because a grant was needed. This
-- turns the existing SEC-5 Invariant B green for this function as well.
-- ---------------------------------------------------------------------------

revoke execute on function public.projects_materialize_access()
  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- CLEANUP (SEC-jamal-01, findings 3 cleanup) — small definer-surface
-- reductions the audit noticed in passing. Neither changes anything a user
-- sees; both shrink what an anon client can even attempt to call.
--
-- `is_team_member(uuid)` — the body checks `auth.uid()` implicitly via
-- team_members, which is null for anon, so anon always gets false. There is no
-- legitimate reason for anon to be able to call it at all. 010:355 revoked
-- from public then re-granted to anon along with authenticated and service_role;
-- the re-grant to anon was speculative and no anon code path depends on it.
--
-- `team_feed(...)` — same reasoning. Its body carries `and public.is_team_member(p_team)`
-- (see 025 §4), so an anon caller gets an empty result set. Nothing meaningful
-- is exposed today; the revoke reduces attack surface without changing behaviour.
--
-- The team_feed signature is pinned via pg_proc: nine args exactly. If a future
-- migration adds an argument, this revoke silently no-ops and the successor
-- becomes anon-callable — that is a live-vs-repo drift risk shared by every
-- overloaded revoke in this repo, and the mitigation is the same: check the
-- signature via pg_proc when writing the next migration that touches team_feed.
-- ---------------------------------------------------------------------------

revoke execute on function public.is_team_member(uuid) from anon;

revoke execute on function public.team_feed(
  uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)
  from anon;
