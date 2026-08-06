-- Rollback for 049_team_audit_actor_set_null.sql.
--
-- OUTSIDE supabase/migrations/ ON PURPOSE so nothing applies it by accident —
-- same placement and reasoning as the other files in this directory.
--
-- 049 changed one foreign key's referential action and nothing else. This
-- restores it to the form 024:44 declared: `references auth.users (id)` with
-- no on-delete action, i.e. NO ACTION. Nothing was read out of the live system
-- to write this — the prior state is fully described by that one line.
--
-- Independent of every other rollback here. 044, 045, 046, 048 and 049 touch
-- five disjoint sets of objects.
--
-- WHAT IT CANNOT UNDO: rows whose actor_id was already set to null by a
-- deletion that happened while 049 was live. The link is gone; restoring the
-- constraint does not restore it, and the account it pointed at no longer
-- exists to point at. Those rows keep rendering as a deleted account, which
-- is accurate.
--
-- WHAT IT WILL DO, so it is not run casually: make the audit trail pin
-- accounts open again. Every member has a member-joined row naming them as
-- actor (046), so after this, deleting any such account fails on
-- team_audit_actor_id_fkey. Note that this is not the whole story in either
-- direction: five other foreign keys block account deletion regardless, and
-- 049's own header maps them. Restoring this one puts back the specific
-- blocker that this session introduced, not the general inability to delete an
-- account — which predates it.

alter table public.team_audit
  drop constraint if exists team_audit_actor_id_fkey;

alter table public.team_audit
  add constraint team_audit_actor_id_fkey
  foreign key (actor_id) references auth.users (id);
