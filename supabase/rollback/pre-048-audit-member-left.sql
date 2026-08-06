-- Rollback for 048_audit_member_left.sql.
--
-- OUTSIDE supabase/migrations/ ON PURPOSE so nothing applies it by accident —
-- same placement and reasoning as the other files in this directory.
--
-- 048 created ONE function and ONE trigger and nothing else. Neither existed
-- before it, so this is a plain drop rather than a restore, and nothing had to
-- be read out of the live system to write it. It does NOT touch 046's
-- team_members_audit_join trigger, the daemon's member-removed write, or
-- leave_team itself — 048 changed none of them.
--
-- Independent of every other rollback in this directory. 044, 045, 046 and 048
-- touch four disjoint sets of objects; any subset can be reverted alone.
--
-- WHAT IT CANNOT UNDO: the member-left rows already written stay written.
-- team_audit has no delete policy and this file adds none — the trail is
-- append-only end to end (024 §5, restated by 025 §5). Removing rows from it
-- is not a rollback step, it is tampering.
--
-- WHAT IT WILL DO, so it is not run casually: return the trail to showing
-- people arriving and never leaving. That is a worse state than showing
-- neither, because it reads as complete: an admin auditing who has access
-- would see the joins, no departures, and conclude everyone who ever joined is
-- still there. Removals would still be recorded (the daemon writes those and
-- 048 never touched that path), so the gap is specifically and only voluntary
-- departures — the ones nobody else witnessed.

drop trigger if exists team_members_audit_leave on public.team_members;
drop function if exists public.audit_member_left();
