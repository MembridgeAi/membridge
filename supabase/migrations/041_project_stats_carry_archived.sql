-- 041_project_stats_carry_archived.sql: stop project_stats from collapsing two
-- independent facts — "archived" and "you may not see this" — into one signal.
--
-- NUMBERING: 037-039 are taken by lanes in flight and 040 is the security
-- lane's revoke of the direct DELETE grant on memory_entries. This is 041. If
-- it lands out of order that is harmless (this file touches nothing those do),
-- but do not renumber it downwards into a used slot.
--
-- WHAT IS WRONG TODAY. The view's WHERE is
--
--   where p.archived_at is null and can_see_project(p.id)
--
-- so a project is ABSENT from a member's result for either reason, and the
-- client cannot tell which. Absence is the signal the revocation path acts on
-- (lib/teamsync.js visibleProjectIds, which drops cached rows, prunes the
-- durable archive and stops MCP search answering), so the ambiguity is not
-- cosmetic: the corroborating probe that lane added has to treat "the team's
-- projects are all archived" as inconclusive, which means a member who really
-- was revoked, from a team whose projects are archived, is never detected.
-- Archiving something must not be able to hide a revocation.
--
-- The conjunction is also why the probe needs a SECOND query at all: it reads
-- the base `projects` table (membership-scoped, archived rows included) to
-- decide whether an empty result meant revoked or merely archived.
--
-- THE FIX IS TO CARRY BOTH BITS. `archived_at` moves out of the WHERE and into
-- the SELECT. After this, for a project of a team you belong to:
--
--   present  -> can_see_project is TRUE   (archived or not — read the column)
--   absent   -> can_see_project is FALSE  (the only remaining reason)
--
-- can_see_project STAYS in the WHERE. That predicate is the security lane's
-- (025 §3) and is what keeps a revoked member from reading a project's
-- activity; this migration does not touch it, and must not.
--
-- WHAT THIS EXPOSES THAT WAS HIDDEN, examined rather than assumed: aggregate
-- stats (last_activity, contributors, entries) for ARCHIVED projects the
-- caller can see. That is not new disclosure. A member can already list every
-- project of their team, archived included, straight from the base table —
-- projects_select is `is_team_member(team_id)` and nothing else, verified
-- against the live catalog — and can already read the ENTRIES those
-- aggregates summarize, because memory_entries_select is
-- `is_team_member(...) and can_see_project(project_id)` with no archived term
-- in it, also verified live. Archiving has never been an access control on
-- this data; it is a "hide it from the hub" flag. This migration stops the
-- view from pretending otherwise.
--
-- CALLER-VISIBLE BEHAVIOUR CHANGE, called out rather than slipped in.
-- 005_project_archive.sql put `archived_at is null` here specifically so the
-- team hub (lib/server.js teamProjectsPayload, GET /api/team/projects) would
-- not list archived projects. That product decision is correct and is NOT
-- being reversed — it is being moved to the layer that owns it. The JS filter
-- that preserves it ships in the same commit as this file and does not depend
-- on this migration being applied: it drops archived rows if it sees them and
-- is a no-op against a backend that still filters them out. So the order is
-- the SAFE one for a widening view — tolerant client first, migration second —
-- and not the "migrate first" gate that 035 and 009 needed, because nothing
-- here is a new object a client could call and miss.
--
-- Re-runnable. `create or replace view` may APPEND columns but never reorder,
-- rename or drop them, so the seven existing columns are repeated verbatim, in
-- order, and archived_at is added at the end. Run in the Supabase SQL editor,
-- or `supabase db push`; with psql, `psql -1 -f`.
--
-- security_invoker STAYS ON (002/005/025 all set it). It is what makes the
-- view read with the CALLER's RLS — projects_select for membership and,
-- through can_see_project, their access. A definer view here would answer
-- every member's question with the view owner's visibility, which is the whole
-- of the access control on this endpoint.
create or replace view public.project_stats
with (security_invoker = on) as
  select p.id as project_id, p.team_id, p.name, p.repo_url,
         max(e.ts) as last_activity,
         count(distinct e.author_id) as contributors,
         count(e.id) as entries,
         p.archived_at
  from public.projects p
  left join public.memory_entries e on e.project_id = p.id
  where can_see_project(p.id)
  group by p.id;
