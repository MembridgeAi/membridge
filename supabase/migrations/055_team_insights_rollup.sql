-- ---------------------------------------------------------------------------
-- 055: team_insights_rollup — the Insights BREAKDOWNS, counted in the database.
--
-- UNAPPLIED AS OF 2026-08-08. Verify:
--   select proname, pronargs from pg_proc where proname = 'team_insights_rollup';
-- Applied when exactly one row comes back with pronargs = 3. The state of this
-- file is recorded in supabase/MIGRATION-STATE.md and nowhere else; do not
-- restate it in a handoff, in claude/ops/, or in another migration's header.
--
-- Nothing in the session that wrote this has touched any database. It creates a
-- NEW function and writes no data, so it is re-runnable and its rollback is a
-- drop (supabase/rollback/pre-055-team-insights-rollup.sql).
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
--
-- 027 fixed half of this problem and the half it left is now the whole problem.
--
-- Insights (lib/api-insights.js) shows two headline counts and six breakdowns.
-- 027_team_feed_counts.sql moved the two COUNTS into the database, so
-- `sessions` and `entriesShared` have been exact ever since. The six
-- BREAKDOWNS — per-person totals, top projects, by-tool, single-person project
-- concentration, members-syncing, and the silent-teammate check — were left
-- being folded in JavaScript over rows pulled down by paging `team_feed`, which
-- clamps every page to 200 rows server-side (013:64, carried through 025) and
-- which the client caps at 10 pages. 2,000 rows, and then it stops.
--
-- Measured against production on 2026-08-08: 2,641 rows in the window, oldest
-- 2026-07-13. So ~641 rows — about a quarter — never reached those six, and
-- paging walks BACKWARDS from newest, so what it drops is the OLDEST rows
-- rather than an even quarter of each.
--
-- Three of those six name a real person to a manager:
--
--   * per-person totals understate how much a teammate has shared,
--   * `concentration` says "only <name> has worked on this project", which can
--     be false purely because the second contributor's rows fell off the tail,
--   * the silent-teammate card says "nothing has arrived from <name>", which
--     can be false for exactly the same reason.
--
-- A wrong number that looks plausible is worse than a crash, and these are
-- wrong numbers about people.
--
-- WHY NOT JUST RAISE THE PAGE CAP. It is not the cheaper option in any
-- dimension. The cap is 10 SEQUENTIAL round trips today, paid on every poll,
-- before the screen can render; raising it buys correctness by making that
-- worse, and only until the team grows into the new cap. This function replaces
-- all 10 with ONE request that stays one request at any team size or window.
--
-- ---------------------------------------------------------------------------
-- ACCESS — READ THIS BEFORE EDITING THE PREDICATE
--
-- `security definer`, exactly like team_feed and team_feed_counts, which means
-- RLS does NOT apply automatically and every predicate must be written into the
-- body. The `visible` CTE below is team_feed's WHERE clause as last modified by
-- 025_enforce_project_access.sql — `p.team_id`, `archived_at is null`,
-- `is_team_member`, `can_see_project` — verbatim, minus only the keyset paging
-- and the row limit. This is the same rule 027 carries, and it now binds three
-- functions instead of two: **if team_feed's predicate changes, change it in
-- team_feed, team_feed_counts and here, in the same migration.**
--
-- An aggregate is a disclosure. A rollup that outlives its feed's access rules
-- reports "4,812 entries, one contributor, project Foo" over rows the caller
-- may no longer read, and that is a leak with no row content attached.
--
-- The MANAGER gate is deliberately NOT here. Insights is owner/admin-only, and
-- that check lives in lib/api-insights.js ahead of every fetch, alongside the
-- same gate api-access.js applies. This function is scoped to what the CALLER
-- may read, which is the right boundary for a definer function; the role
-- boundary is a separate, higher one. Adding a role check here would duplicate
-- a rule that already has one home.
--
-- ---------------------------------------------------------------------------
-- TWO SPANS IN ONE FUNCTION, ON PURPOSE
--
--   * `win` is the requested window and feeds the three breakdowns, which are
--     all present-tense statements about that window.
--   * `visible` is UNBOUNDED and feeds `last_shared` and `earliest_ts`.
--
-- That asymmetry is the point, not an oversight. `last_shared` answers "when
-- did we last hear from this person", and bounding it to the window is what
-- made the client phrase a teammate quiet for five weeks as the weaker "0
-- entries shared in the last Nd" — a sentence about the FETCH wearing the
-- clothes of a sentence about the PERSON. Unbounded, the honest answer is
-- available. `earliest_ts` is the team's genuinely oldest visible entry, so a
-- caller can assert it reached past the bottom of history rather than assume it.
--
-- ---------------------------------------------------------------------------
-- COST, SO NOBODY HAS TO GUESS
--
-- `visible` is referenced three times (win, last_shared, earliest_ts), so
-- Postgres materialises it rather than inlining it — which is the behaviour we
-- want here: ONE pass over memory_entries feeds all five aggregates, instead of
-- five passes. It is deliberately narrow, eight columns and no row content, so
-- what is held is small.
--
-- It is unbounded in one dimension by necessity: `last_shared` and
-- `earliest_ts` are all-time questions and cannot be windowed without
-- reintroducing the bug this file exists to fix. The scan is per TEAM, and the
-- bound that matters is one team's entry count. If that ever becomes the
-- problem, the fix is an index on (project_id, ts) — not a row limit, which
-- would put the cap straight back.
-- ---------------------------------------------------------------------------

create or replace function public.team_insights_rollup(
  p_team uuid,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with visible as (
    -- team_feed's predicate (025:121-127), minus paging and the row limit.
    select e.id, e.project_id, p.name as project_name,
           e.author_id, e.author_name, e.ts, e.source, e.session
    from public.memory_entries e
    join public.projects p on p.id = e.project_id
    where p.team_id = p_team
      and p.archived_at is null
      and public.is_team_member(p_team)
      and public.can_see_project(e.project_id)
  ),
  win as (
    select * from visible
    where (p_since is null or visible.ts >= p_since)
      and (p_until is null or visible.ts <= p_until)
  ),
  -- Distinct sessions, spelled exactly as 027 spells it, in all three
  -- breakdowns. count(distinct session) ignores NULLs, so the session-less rows
  -- are added back one unit each — matching lib/api-insights.js's sessionKeyOf
  -- (`r.session || 'entry:' + r.id`), which gives a row with no session id its
  -- own one-off unit instead of merging every such row into one. If this and
  -- 027 ever disagree, the page shows a headline session count that contradicts
  -- the per-person numbers printed underneath it.
  by_author as (
    select win.author_id,
           count(*)::bigint as entries,
           (count(distinct win.session)
            + count(*) filter (where win.session is null))::bigint as sessions
    from win
    where win.author_id is not null
    group by win.author_id
  ),
  by_project as (
    -- project_name and author_name are DISPLAY SNAPSHOTS stored on the row, so
    -- a rename leaves several spellings inside one window. Taking the most
    -- recent by ts is deterministic and is the freshest of them; the JS fold
    -- this replaces took whichever happened to be last in fetch order.
    --
    -- `people` counts distinct author_id and therefore ignores rows with no
    -- author. The JS Map keyed those under a single null key, so a project with
    -- only author-less rows came out as ONE person and could be published as
    -- "only Unknown has worked on this project". Here it comes out as zero
    -- contributors and is filtered out of concentration instead of naming a
    -- person who does not exist.
    select win.project_id,
           (array_agg(win.project_name order by win.ts desc))[1] as project_name,
           (count(distinct win.session)
            + count(*) filter (where win.session is null))::bigint as sessions,
           count(distinct win.author_id)::bigint as people,
           (array_agg(win.author_name order by win.ts desc))[1] as recent_author_name
    from win
    group by win.project_id
  ),
  by_source as (
    -- The `Distilled -> Codex` fold MUST happen inside the group-by, and this
    -- is the one rule in this file that is deliberately duplicated from
    -- JavaScript (`publicSource` in lib/api-insights.js). Two source values
    -- folding to one tool cannot have their distinct-session counts added
    -- afterwards: a session that emitted rows under both would be counted
    -- twice, and the only way to fold correctly on the client is to ship it the
    -- session ids, which is exactly what this whole module refuses to do.
    -- test/suites/insights-rollup.test.js pins the two spellings against each
    -- other so an edit to one side goes red instead of silently drifting.
    select case when win.source = 'Distilled' then 'Codex' else coalesce(win.source, '') end as tool,
           (count(distinct win.session)
            + count(*) filter (where win.session is null))::bigint as sessions
    from win
    group by 1
  ),
  last_shared as (
    -- UNBOUNDED by design — see the header. This is the supported signal for a
    -- teammate's absence, never a diagnosis of why they are absent.
    select visible.author_id, max(visible.ts) as ts
    from visible
    where visible.author_id is not null
    group by visible.author_id
  )
  -- coalesce on every array: jsonb_agg over no rows returns NULL, and a null
  -- where the caller expects a list turns an honest empty team into a crash.
  select jsonb_build_object(
    'by_author', coalesce((
      select jsonb_agg(jsonb_build_object(
        'author_id', author_id, 'entries', entries, 'sessions', sessions))
      from by_author), '[]'::jsonb),
    'by_project', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', project_id, 'project_name', project_name,
        'sessions', sessions, 'people', people,
        'recent_author_name', recent_author_name))
      from by_project), '[]'::jsonb),
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tool', tool, 'sessions', sessions))
      from by_source), '[]'::jsonb),
    'last_shared', coalesce((
      select jsonb_agg(jsonb_build_object(
        'author_id', author_id, 'ts', ts))
      from last_shared), '[]'::jsonb),
    'earliest_ts', (select min(visible.ts) from visible)
  );
$$;

-- ---------------------------------------------------------------------------
-- GRANTS. `create function` grants EXECUTE to PUBLIC by default, which is how
-- this project accumulated its standing advisor warning about anon-callable
-- security-definer functions in the first place. Revoked here in the same file
-- that creates the function, so 055 is born hardened and does not depend on 042
-- (still unapplied) landing first to become safe.
--
-- Callable by: `authenticated` and `service_role` only. A caller still sees
-- nothing unless is_team_member and can_see_project say so.
-- ---------------------------------------------------------------------------

revoke execute on function public.team_insights_rollup(
  uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.team_insights_rollup(
  uuid, timestamptz, timestamptz) to authenticated, service_role;
