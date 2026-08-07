-- 048_ops_audit_via_role.sql — record the one identity-adjacent fact the
-- database can VERIFY, next to the one it can only RECEIVE.
--
-- READ THIS FIRST: THIS IS NOT A FIX FOR THE FORGEABLE ACTOR. It does not make
-- `actor` trustworthy and it does not identify a person. If you are looking for
-- the thing that stops someone lying about who performed an ops write, it does
-- not exist and §1 explains why. This column is a detection aid with a narrow,
-- stated scope, and it is written down here so nobody later mistakes its
-- presence for the problem having been solved.
--
-- ---------------------------------------------------------------------------
-- 0. THE PROBLEM.
--
-- Every ops write RPC takes `p_actor text` and writes it to ops_audit. The
-- Worker fills it from the Cloudflare Access email it verified, which is
-- trustworthy — but only because the Worker is the caller. From Postgres's side
-- p_actor is a function argument the caller composed. Anyone holding the write
-- credential can pass any string, so the audit trail's `actor` column is an
-- assertion, not a fact.
--
-- ---------------------------------------------------------------------------
-- 1. CAN THE ACCESS IDENTITY BE BOUND SO THE DATABASE CHECKS IT? NO — and each
--    route fails for a different reason worth recording, because each one looks
--    plausible until it is followed through.
--
--   (a) PUT THE EMAIL IN THE JWT. PostgREST verifies the request JWT's
--       signature and exposes its claims at `request.jwt.claims`, so a claim IS
--       checked rather than received — this is the right shape. It cannot be
--       used: 047's OPS_READ_KEY and OPS_WRITE_KEY are STATIC, pre-minted
--       tokens held as Worker secrets. A static token cannot carry a
--       per-request email.
--
--       To mint a token per request the Worker would need the project's JWT
--       SIGNING SECRET. That secret signs every role's tokens, including
--       service_role — so a Worker holding it could mint a service_role token,
--       which is exactly the compromise 047 exists to remove. This route is not
--       merely insufficient, it is a net loss.
--
--   (b) PUT THE EMAIL IN A REQUEST HEADER. PostgREST exposes headers at
--       `request.headers`, so the value arrives. But the caller composes
--       headers exactly as freely as arguments, so forgeability is unchanged.
--       It would look like a fix and be none, which is worse than the argument
--       it replaces.
--
--   (c) ONE WRITE ROLE PER OPERATOR, so the verified role claim identifies the
--       person. Sound in principle and useless here: all the credentials live
--       in the same Worker environment, so whoever extracts one extracts all.
--       It defends against a threat model — independently held credentials —
--       that this deployment does not have.
--
--   (d) VERIFY THE CLOUDFLARE ACCESS JWT INSIDE POSTGRES. Pass the raw Access
--       assertion through and check its RS256 signature in the database against
--       Cloudflare's JWKS. This is the only route that actually works, and it
--       is disproportionate: asymmetric verification in plpgsql, the JWKS
--       fetched and cached in-database, and key rotation handled there. A large
--       new mechanism, in the layer least suited to it, to raise the integrity
--       of one text column.
--
-- ---------------------------------------------------------------------------
-- 2. WHAT THE TRAIL IS FOR, WHICH DECIDES WHETHER (d) IS WARRANTED.
--
-- cloudflare/README.md states the purpose: "an admin panel without an audit log
-- is indistinguishable from someone holding the service key." The population is
-- three named operators in ALLOWED_EMAILS. The question it exists to answer is
-- "which of us did this", among people who are already trusted with the panel.
--
-- Against that bar a self-reported actor is adequate: a trusted operator has no
-- incentive to forge, and the trail's job is reconstructing what happened, not
-- resisting an insider. Against the harder bar — surviving a compromised
-- credential — it fails, and §3 is why that failure is much smaller than it
-- first sounds.
--
-- ---------------------------------------------------------------------------
-- 3. FORGING THE ACTOR IS STRICTLY THE LESSER CAPABILITY OF ANYONE WHO CAN DO
--    IT. This reframes it from a hole to a property.
--
-- To forge the actor you must hold the write credential. That same credential
-- can call ops_create_onboarding_invite — which mints a token that
-- redeem_onboarding_invite turns into a NEW TEAM owned by whoever redeems it —
-- and ops_rotate_invite, which invalidates a team's standing code. Someone who
-- can lie about who rotated an invite can also rotate it. The lie is never the
-- most dangerous thing they can do.
--
-- And the lie is bounded in three ways that are worth stating precisely,
-- because they are what is left standing:
--
--   * They cannot FABRICATE an event. ops_log is granted to service_role only;
--     047 deliberately withheld it from both scoped roles. The write roles can
--     only cause audit rows as a side effect of the four real RPCs, so every
--     row corresponds to something that actually happened.
--   * They cannot BACKDATE. ops_audit.at is `timestamptz not null default
--     now()` and ops_log does not name the column, so the value is the
--     database's, not the caller's. (Unlike team_audit before 039, where the
--     column was nameable by the client.)
--   * They cannot SUPPRESS. ops_audit has RLS enabled with zero policies, 043
--     revokes the blanket table grants, and neither scoped role has any table
--     privilege. There is no UPDATE or DELETE path.
--
-- So the precise statement, which should replace any looser one: the ACTOR is
-- mislabelable by someone who already holds the write credential; the EVENT,
-- its TIME, and its OCCURRENCE are not.
--
-- ---------------------------------------------------------------------------
-- 4. WHAT THIS MIGRATION ACTUALLY DOES, AND ITS EXACT SCOPE.
--
-- The role in the request JWT is the one identity-adjacent fact PostgREST has
-- VERIFIED — it checked the signature, so the caller cannot set it without the
-- signing secret. Recording it puts a checked fact beside the asserted one.
--
-- WHAT IT CATCHES: a write that arrives under a credential other than the
-- panel's. After 047's cutover every legitimate ops write carries
-- `ops_panel_write`; a row showing `service_role` means something called the
-- RPC without going through the Worker. That is a real signal and there is
-- currently no other way to see it.
--
-- WHAT IT DOES NOT CATCH, stated as plainly: an attacker using the SAME
-- credential the panel uses. Their rows are indistinguishable from real ones
-- except by the actor string, which is the thing they control. It also does not
-- distinguish operators from each other — all three share one write role.
--
-- Purely additive. ops_audit_recent builds its JSON from named columns
-- (021:...), so a new column changes neither its output nor its return type,
-- and the panel is unaffected. No function signature changes.
--
-- ---------------------------------------------------------------------------
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` in this project, for
-- the reason 031, 032 and 033 all give. Both statements are re-runnable.
--
-- UNAPPLIED AS OF 2026-08-05. Nothing here has been run against any database.
-- State is recorded in supabase/MIGRATION-STATE.md; settle it with:
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'ops_audit'
--      and column_name = 'via_role';
-- ---------------------------------------------------------------------------

alter table public.ops_audit add column if not exists via_role text;

comment on column public.ops_audit.via_role is
  'The role claim from the request JWT, which PostgREST verified. Unlike '
  '"actor" — a caller-supplied argument — this cannot be set without the '
  'project signing secret. It identifies the CREDENTIAL, never the person: all '
  'operators share one write role. NULL means the write did not arrive through '
  'PostgREST at all.';

-- Return type unchanged (void), so create-or-replace is correct here and no
-- drop is needed — see 040's note on why dropping and recreating a function
-- other migrations also define is the dangerous form.
create or replace function public.ops_log(p_actor text, p_action text, p_team uuid, p_detail jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ops_audit (actor, action, target_team, detail, via_role)
  values (
    p_actor, p_action, p_team, coalesce(p_detail, '{}'::jsonb),
    -- `nullif(..., '')` before the cast: current_setting with the missing_ok
    -- flag returns NULL when unset but an EMPTY STRING in some contexts, and
    -- ''::json raises rather than returning null. A logging function must never
    -- be the thing that aborts the write it is recording.
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role'
  );
$$;

-- Restated from 021:292 — `create or replace` preserves the ACL, so this is
-- belt-and-braces for the reason 011:140 gives. ops_log stays service_role-only
-- and is deliberately NOT granted to either scoped role (047 §1): the write
-- roles must be able to cause audit rows through the four real RPCs, and must
-- not be able to write arbitrary ones.
revoke all on function public.ops_log(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ops_log(text, text, uuid, jsonb) to service_role;
