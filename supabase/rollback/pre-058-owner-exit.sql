-- Rollback for 058_owner_exit.sql.
--
-- 058 is purely additive: it creates two functions that never existed before
-- and replaces nothing, so the pre-058 state is simply their absence. There is
-- no prior body to restore -- which is why this file drops rather than
-- re-creating, unlike the rollbacks for migrations that used
-- `create or replace` over a live function.
--
-- WHAT THIS DOES NOT UNDO. Nothing, if 058 was applied and never called. But a
-- disband that already ran is IRREVERSIBLE: delete_team cascades through
-- projects into memory_entries, and no rollback file can bring those rows
-- back. A transfer that already ran is also not undone here -- the roles it
-- wrote stay as they are, and reversing one means transferring back, which
-- needs the function this file drops. Drop first, then reassign roles by hand
-- if that is genuinely wanted:
--
--   update public.team_members set role = 'owner'
--    where team_id = '<team>' and user_id = '<original owner>';
--   update public.team_members set role = 'admin'
--    where team_id = '<team>' and user_id = '<new owner>';
--
-- Running this file while the app still ships the Danger Zone leaves Transfer
-- ownership and Disband team calling functions that no longer exist; both will
-- report "could not find the function" rather than misbehaving silently.

drop function if exists public.transfer_ownership(uuid, uuid);
drop function if exists public.delete_team(uuid);
