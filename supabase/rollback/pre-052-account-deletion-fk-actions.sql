-- pre-052-account-deletion-fk-actions.sql — restore the five foreign keys
-- 052_account_deletion_fk_actions.sql changes, back to the state read from the
-- live catalog on 2026-08-05: NO ACTION on delete, and NOT NULL on the three
-- columns 052 loosens.
--
-- This is the rollback for a migration that is NOT APPLIED. It exists so the
-- change is reversible before anyone runs it, not because it is needed.
--
-- ===========================================================================
-- THIS ROLLBACK CAN FAIL, AND THE FAILURE IS THE POINT.
--
-- Re-adding NOT NULL to teams.created_by, projects.created_by and
-- invites.created_by only succeeds if NO ROW HAS A NULL THERE. A null appears
-- exactly when an account has been deleted while 052 was live — which is the
-- whole reason 052 exists. So:
--
--   * rolled back before any account was deleted -> clean, no-op-ish, fine.
--   * rolled back after an account was deleted   -> the NOT NULL statements
--     FAIL, and the file aborts (the SQL editor runs it in one transaction, so
--     nothing is applied).
--
-- That is correct behaviour, not a bug in this file. You cannot un-know that a
-- founder's account is gone. If you hit it, decide deliberately: either stay on
-- 052's shape, or backfill the nulls with a real surviving account id first —
-- which is a factual claim about who created something and must not be
-- invented. Run the check below BEFORE pasting this file.
--
--   select 'teams' as t, count(*) from public.teams where created_by is null
--   union all
--   select 'projects', count(*) from public.projects where created_by is null
--   union all
--   select 'invites', count(*) from public.invites where created_by is null;
--
-- All three zero -> this file applies cleanly. Anything else -> stop and read
-- the paragraph above.
--
-- projects.archived_by and project_access.updated_by are NOT in that trap:
-- both were already nullable before 052 (schema.sql:41 and 024:36), so their
-- constraints are simply put back and any nulls 052 produced stay as they are.
-- ===========================================================================
--
-- Re-runnable, same convention as the migration it reverses.


-- 1. teams.created_by — back to NO ACTION, NOT NULL.
alter table public.teams
  drop constraint if exists teams_created_by_fkey;

alter table public.teams
  add constraint teams_created_by_fkey
  foreign key (created_by) references auth.users (id);

alter table public.teams
  alter column created_by set not null;


-- 2. projects.created_by — back to NO ACTION, NOT NULL.
alter table public.projects
  drop constraint if exists projects_created_by_fkey;

alter table public.projects
  add constraint projects_created_by_fkey
  foreign key (created_by) references auth.users (id);

alter table public.projects
  alter column created_by set not null;


-- 3. projects.archived_by — back to NO ACTION. Stays nullable, as it always was.
alter table public.projects
  drop constraint if exists projects_archived_by_fkey;

alter table public.projects
  add constraint projects_archived_by_fkey
  foreign key (archived_by) references auth.users (id);


-- 4. project_access.updated_by — back to NO ACTION. Stays nullable (024:36).
alter table public.project_access
  drop constraint if exists project_access_updated_by_fkey;

alter table public.project_access
  add constraint project_access_updated_by_fkey
  foreign key (updated_by) references auth.users (id);


-- 5. invites.created_by — back to NO ACTION, NOT NULL.
--
-- Note this does NOT un-revoke anything. If the deletion RPC stamped
-- revoked_at on a departing account's live invites (052 §5), those invites
-- stay revoked, correctly: the credential was withdrawn, and reversing a
-- constraint is not a reason to hand it back.
alter table public.invites
  drop constraint if exists invites_created_by_fkey;

alter table public.invites
  add constraint invites_created_by_fkey
  foreign key (created_by) references auth.users (id);

alter table public.invites
  alter column created_by set not null;
