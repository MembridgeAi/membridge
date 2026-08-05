-- 030_team_keys_definer_membership.sql — commit the fix that only ever existed
-- in production: team_keys_insert must check the SEALED-TO member's membership
-- through a SECURITY DEFINER helper, not through an inline EXISTS.
--
-- THIS MIGRATION IS A NO-OP IN PRODUCTION (with one flagged exception, below).
-- Production already has `public.is_team_member_uid` and already has
-- team_keys_insert in the form created here — both were applied by hand and
-- never written down. The repo is the thing that is wrong. Everything in §1
-- and §2 exists to make a database rebuilt from supabase/ reproduce the
-- database we actually run.
--
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` IN THIS PROJECT.
-- supabase_migrations.schema_migrations holds only TWO rows, so none of the
-- repo's numbered files is recorded as applied and a push would attempt all
-- thirty-plus of them against a database that already has most of their effects
-- (including 029's row-writing backfill). Paste this file into the Supabase SQL
-- editor, which runs it in one transaction. Every statement below is re-runnable.
--
-- ---------------------------------------------------------------------------
-- WHY THE DEFINER INDIRECTION IS LOAD-BEARING — the whole point of this file.
--
-- 011_backend_hardening.sql §1 correctly identified the hole (a member could
-- seal a team key to a non-member) and closed it with an inline EXISTS:
--
--   and exists (
--     select 1 from public.team_members tm
--     where tm.team_id = team_keys.team_id
--       and tm.user_id = team_keys.member_user_id
--   )
--
-- A policy expression evaluates with the CALLER's privileges, so that EXISTS
-- is itself subject to RLS on public.team_members — whose only select policy is
-- `team_members_select ... using (public.is_team_member(team_id))`
-- (schema.sql:112). The caller therefore sees a team_members row only if RLS
-- lets them, and any row RLS hides reads as ABSENT to the EXISTS. The result is
-- a membership check that returns false for a member who is genuinely there.
--
-- That is the "join-seal RLS blocked" failure: an existing member sealing the
-- team key to a NEWLY JOINED teammate had the insert refused by this WITH
-- CHECK, so the new member never received the sealed key and could not decrypt
-- any team history. Nothing in the app reported a cause — encryption simply
-- stopped working for new arrivals.
--
-- public.is_team_member_uid is SECURITY DEFINER, so its body executes as the
-- function owner and reads public.team_members without RLS applied. It answers
-- "is this uuid a member of this team" truthfully rather than "can the caller
-- SEE that this uuid is a member". Same shape as is_team_member (schema.sql:96)
-- and is_team_manager, which exist for exactly this reason — a membership
-- predicate used inside a policy cannot be gated by the policies it feeds.
--
-- The security property 011 wanted is preserved in full: the caller must still
-- be a member of the team (public.is_team_member(team_id), evaluated as the
-- caller), and the row's member_user_id must still be a real member of that
-- same team. Only the visibility of the second fact changes, and widening it
-- discloses nothing to the caller — the predicate is consumed by the policy,
-- and its boolean is never returned to the client.
--
-- ---------------------------------------------------------------------------
-- THE TRAP THIS FILE EXISTS TO DISARM.
--
-- 011 is `drop policy if exists` + `create policy`, and its header advertises
-- itself as re-runnable ("running this file twice drops and recreates the
-- identical policy both times" — true of 011 in isolation, false of the schema
-- as a whole now). Re-running 011 against production, or rebuilding a database
-- by replaying supabase/migrations/ in order, therefore REVERTS this fix and
-- re-breaks key sealing for new members — silently, with no error, and with
-- the symptom appearing days later as "the new hire can't read team history".
--
-- Two mitigations, both required, neither sufficient alone:
--   * this migration, numbered after 011, restores the correct body on replay;
--   * a note added to 011 §1 pointing here, so a human who reaches for 011
--     alone knows its body is superseded. 011's SQL is deliberately left
--     unchanged — an applied migration is a historical record.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- §1 public.is_team_member_uid(p_team uuid, p_user uuid)
--
-- Body transcribed from production's pg_proc definition verbatim. `create or
-- replace` is correct here: it is how production's own copy would have been
-- written, it is idempotent, and on a database that already has the function it
-- preserves the existing ACL (see 010's header) so it cannot silently re-open
-- grants.
--
-- Distinct from is_team_member(uuid), which is NOT a wrapper of this one and is
-- not being rewritten to become one: is_team_member takes the caller implicitly
-- (auth.uid()) and is granted to anon precisely because signed-out table reads
-- must return zero rows rather than a permission error (010 §4). This function
-- takes the subject EXPLICITLY, which is a different and more sensitive
-- question — see the grants below.
-- ---------------------------------------------------------------------------
create or replace function public.is_team_member_uid(p_team uuid, p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.team_members tm
    where tm.team_id = p_team and tm.user_id = p_user
  );
$$;

-- ---------------------------------------------------------------------------
-- §1a EXECUTE grants — the one part of this file that may NOT be a no-op in
-- production, flagged rather than buried.
--
-- Postgres grants EXECUTE on every newly created function to PUBLIC, and
-- Supabase's default privileges add anon / authenticated / service_role on top
-- (010 §4 spells out both mechanics). The hand-applied production copy was
-- created without any accompanying revoke, so production most likely still
-- carries those defaults; these two lines would then TIGHTEN its ACL rather
-- than leave it untouched. That is intended, it is a hardening and not a
-- behaviour change for any supported caller, and it follows 011 §3(ii)'s own
-- standing policy that a migration which creates a function owns its grants.
--
-- Why anon must NOT keep EXECUTE, unlike is_team_member: this function names
-- its subject explicitly, so a signed-out caller with EXECUTE could ask "is
-- user <uuid> a member of team <uuid>?" for any pair — a membership oracle over
-- other people, disclosing exactly what team_members_select is there to hide.
-- is_team_member can only ever answer about auth.uid() (null for anon, so it
-- returns false and discloses nothing), which is why 010 could safely leave it
-- anon-executable. The two are not comparable on this point.
--
-- Why authenticated DOES need EXECUTE: the function is referenced from
-- team_keys_insert's WITH CHECK, and a policy expression is evaluated with the
-- caller's privileges — revoking it from authenticated would turn every legal
-- key-seal insert into "permission denied for function is_team_member_uid".
-- Nothing is lost for anon: inserting into team_keys already fails for a
-- signed-out caller on is_team_member(team_id), so anon's only observable
-- change is which error it gets for an insert that was never going to succeed.
-- ---------------------------------------------------------------------------
revoke execute on function public.is_team_member_uid(uuid, uuid) from public, anon;
grant execute on function public.is_team_member_uid(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- §2 team_keys_insert — recreate with the definer-backed membership check.
--
-- `create policy` has no `if not exists` / `or replace`, so drop-then-create is
-- the idempotent form, the convention every policy change in this codebase
-- follows (011 §1, 025 §2, 025 §5-6).
--
-- Column references are limited to team_id and member_user_id on purpose: both
-- exist under either candidate 016 (master's DELETE-policy 016 and the
-- feat/multidevice-e2e 016 that adds device_id and rewrites the primary key —
-- see supabase/AUDIT-live-state.sql for why that is still an open question).
-- This migration is therefore safe to apply without first settling which 016 is
-- live, and it must stay that way: do not add a device_id predicate here.
-- ---------------------------------------------------------------------------
drop policy if exists team_keys_insert on public.team_keys;

create policy team_keys_insert on public.team_keys
  for insert with check (
    public.is_team_member(team_id)
    and public.is_team_member_uid(team_id, member_user_id)
  );
