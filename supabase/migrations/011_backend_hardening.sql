-- 011_backend_hardening.sql — pre-launch audit follow-up on 009's E2E-encryption
-- tables: (a) team_keys_insert's WITH CHECK is tightened so a key can only be
-- sealed to an actual team member, and sealed_team_key gets a length cap; (b)
-- two audit decisions are recorded as comments for Andrew, no DDL attached.
--
-- Style matches 002–010: additive, re-runnable, written for the Supabase SQL
-- editor (which runs the script in one transaction) or `supabase db push`;
-- with psql, use `psql -1 -f` to keep that single-transaction property. No
-- extension/table create here — 009 already created team_keys and enabled RLS
-- on it, so this migration only alters what 009 established.

-- ---------------------------------------------------------------------------
-- §1 team_keys_insert: close the non-member sealing gap.
--
-- Current definition (009_e2e_encryption.sql):
--   create policy team_keys_insert on public.team_keys
--     for insert with check (public.is_team_member(team_id));
--
-- That only checks that the CALLER is a team member — it never checks that
-- the row's own member_user_id is a member of the same team. So any team
-- member could insert a row addressed to an arbitrary auth.users id (a
-- non-member, or a member of a different team), sealing a real team key to
-- someone who was never granted access to it. The fix ANDs in an EXISTS
-- against team_members for (team_id, member_user_id) — the same table/shape
-- 002's schema.sql defines (team_members primary key is (team_id, user_id)).
-- Everything the old WITH CHECK enforced (public.is_team_member(team_id)) is
-- preserved unchanged; the membership check is additive.
--
-- `create policy` has no `if not exists`/`or replace`, and 009 avoided
-- drop+create specifically because a policy body is meant to be settled at
-- first apply (see 009's comment: "edits would be a new migration, so the
-- guard never hides a change"). This IS that new migration, so drop-if-exists
-- then create is the correct, re-runnable way to change the body — running
-- this file twice drops and recreates the identical policy both times.
--
-- !! SUPERSEDED — READ BEFORE RE-RUNNING THIS FILE !!
-- The team_keys_insert body below is superseded by
-- 030_team_keys_definer_membership.sql. The inline EXISTS is evaluated with the
-- CALLER's privileges, so it is subject to RLS on public.team_members
-- (team_members_select, schema.sql:112) and reads any row RLS hides from the
-- caller as ABSENT — reporting a genuine member as a non-member. That made
-- sealing the encryption key to a NEWLY JOINED teammate fail with no error, so
-- new members could not decrypt any team history. 030 replaces the EXISTS with
-- public.is_team_member_uid(team_id, member_user_id), a SECURITY DEFINER helper
-- that reads team_members without RLS; the security property this section added
-- is preserved, only the visibility of the membership fact changes. Production
-- has run 030's form since it was applied by hand.
--
-- So: re-running 011 on its own, or replaying supabase/migrations/ in order,
-- REVERTS that fix and silently re-breaks key sealing for new members. Apply
-- 030 after any replay that reaches this file. The SQL below is left exactly as
-- applied — an applied migration is a historical record, not a live source of
-- truth. Do not edit it; change the policy in a new migration.
-- ---------------------------------------------------------------------------
-- SUPERSEDED BY 030_team_keys_definer_membership.sql, which replaced this
-- predicate with one built on public.is_team_member_uid(...). The drop-then-
-- create that used to stand here was correct while 011 held the newest
-- definition of team_keys_insert — §1 above argues that case, and it was right
-- at the time. It stopped being right when 030 landed: from that moment,
-- re-running this file reverted 030 silently.
--
-- Converted to a guarded create. This does NOT edit the policy body, so it does
-- not breach §1's "an applied migration is a historical record, do not edit it"
-- — the predicate below is byte-for-byte what 011 applied. What changes is only
-- whether it runs at all: on a database that already has the policy (every
-- database this file has ever touched) it is now a no-op instead of a
-- regression. Convention from 009:72-77; enforced by
-- test/suites/invite-lifetime-hardening.test.js.
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename = 'team_keys' and policyname = 'team_keys_insert') then
    create policy team_keys_insert on public.team_keys
      for insert with check (
        public.is_team_member(team_id)
        and exists (
          select 1 from public.team_members tm
          where tm.team_id = team_keys.team_id
            and tm.user_id = team_keys.member_user_id
        )
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- §2 sealed_team_key length cap.
--
-- Derivation (lib/teamcrypto.js): the team key is a libsodium secretbox key,
-- crypto_secretbox_KEYBYTES = 32 bytes, sealed with crypto_box_seal, which
-- adds crypto_box_SEALBYTES = 48 bytes (an ephemeral 32-byte public key plus
-- a 16-byte MAC). Raw sealed output is therefore 32 + 48 = 80 bytes, base64
-- (sodium's ORIGINAL variant, i.e. standard base64 with padding) encodes that
-- as ceil(80/3)*4 = 108 characters. A real row is always exactly 108 chars.
-- The cap below (2048) is ~19x that — generous headroom against any future
-- change to the sealed payload while still refusing pathological/oversized
-- blobs (storage abuse, malformed input). Additive only: no column-type
-- change, existing 108-char rows are unaffected.
--
-- `add constraint` has no `if not exists`, so drop-if-exists then add is the
-- idempotent guard, mirroring 002_team_v2.sql's team_members_role_check.
-- ---------------------------------------------------------------------------
alter table public.team_keys drop constraint if exists team_keys_sealed_len_check;
alter table public.team_keys
  add constraint team_keys_sealed_len_check check (char_length(sealed_team_key) <= 2048);

-- ---------------------------------------------------------------------------
-- §3 Decisions for Andrew — comments only, no DDL in this section.
-- ---------------------------------------------------------------------------

-- (i) Retire the legacy unthrottled invite_code join path.
--
-- What it is: teams.invite_code (schema.sql) is a permanent, non-expiring,
-- non-revocable-by-itself UUID per team, redeemed via public.join_team(p_code
-- uuid, p_display_name text) (schema.sql, re-defined in
-- 003_fix_join_ambiguity.sql). It has existed alongside the newer
-- public.invites / create_invite / redeem_invite path (002_team_v2.sql) since
-- v2 — 002's header says so explicitly ("the legacy teams.invite_code keeps
-- working alongside the new invite links"). rotate_invite() (002) rotates
-- invite_code as a side effect, but that is opt-in and per-team; nothing
-- forces migration off the old path.
--
-- Why it's dangerous next to the throttled path: 010_security_hardening.sql
-- §3 added a 10-attempts/minute throttle in front of peek_invite/redeem_invite
-- (the public.invites path) specifically because that is the anon-reachable
-- oracle. join_team(p_code, ...) has NO equivalent throttle — it is gated
-- only by "authenticated user", not by a rate limit — and unlike invites.token
-- (rotatable, revocable, expirable, use-capped), a team's invite_code is
-- static until someone explicitly calls rotate_invite. §3's throttle covers
-- guessing traffic against invites.token; it does nothing for invite_code.
-- The redeeming factor today is that invite_code is a full UUID (122 bits of
-- randomness from gen_random_uuid()), so online guessing is infeasible either
-- way — but it is an inconsistent, undocumented second surface with a
-- materially weaker security posture (no throttle, no expiry, no per-use
-- cap) than the path 010 just hardened, and every new reader of this schema
-- has to notice it exists.
--
-- What removing it would involve (NOT done here — comments only): confirm no
-- live client still calls join_team / reads teams.invite_code (grep the web
-- app and CLI for both); migrate any remaining callers to create_invite +
-- redeem_invite; drop the join_team RPC and its anon/authenticated grants;
-- drop the teams.invite_code column (or leave it nullable/unused for one
-- release as a safety net before a follow-up migration drops it); update
-- rotate_invite to stop touching invite_code. That is schema-and-client-
-- coordinated work spanning multiple repos/deploys, out of scope for a single
-- backend migration — flagging it here for a scoped follow-up task.

-- (ii) The DROP+CREATE ACL-reset hazard, and the policy going forward.
--
-- What happened: 010 §4 revoked EXECUTE on the RPC surface from public/anon
-- and re-granted it only to the roles that need it (authenticated,
-- service_role, or neither). Every one of those functions is defined with
-- `create or replace function`, which preserves the function's existing ACL
-- across a replace (010's own header says this: "CREATE OR REPLACE preserves
-- an existing function's ACL ... these revokes are what actually change the
-- ACLs"). That is correct for 010 itself, but it creates a standing hazard:
-- 002–009 each contain their own `create or replace function` for several of
-- these same functions (e.g. join_team, create_invite, revoke_invite,
-- redeem_invite, team_feed). Postgres grants EXECUTE on every newly CREATEd
-- function to PUBLIC by default, and Supabase's default privileges add
-- explicit anon/authenticated grants on top of that. If any earlier migration
-- file (002–009) is ever re-run by hand against a database that already has
-- 010 applied — e.g. someone re-applying 003_fix_join_ambiguity.sql to fix an
-- unrelated ambiguity bug without realizing 010 came after it — the
-- `create or replace` in that older file does NOT reset the ACL that 010 set
-- (CREATE OR REPLACE preserves the existing ACL, it does not restore a
-- PREVIOUS one), so today's ordering is not actually at risk from that
-- specific replay. The real hazard is the reverse and more subtle case: a
-- future migration that needs to `drop function ... ; create function ...`
-- (as 005_project_archive.sql did for team_feed, because Postgres refuses to
-- change RETURNS TABLE via create-or-replace) DROPS the function outright —
-- which destroys its ACL — and the fresh CREATE that follows gets Postgres's
-- and Supabase's default grants again, silently re-opening anon/public
-- EXECUTE on a function 010 had locked down. That migration would pass review
-- if the author only diffs the function body and doesn't think to re-check
-- the grants.
--
-- Policy going forward: any migration that DROPs and recreates a function
-- (rather than CREATE OR REPLACE) MUST fold that function's revoke/grant
-- lines into the SAME migration, immediately after the create — do not rely
-- on a prior migration's grants to still be in effect once a drop has
-- happened. 005_project_archive.sql's team_feed drop+recreate predates this
-- policy and is not being retrofitted here (out of scope — no DDL for this
-- item); a future migration touching team_feed's signature again should
-- carry both the drop+create AND the revoke/grant pair from 010 §4 together.
