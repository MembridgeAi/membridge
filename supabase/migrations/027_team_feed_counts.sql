-- ---------------------------------------------------------------------------
-- 027: team_feed_counts — exact windowed totals, computed server-side.
--
-- WHY THIS EXISTS. Insights counted rows by PAGING team_feed and measuring the
-- result (lib/api-insights.js). team_feed clamps every page to 200 rows
-- (013_e2e_feed.sql:64, `limit least(..., 200)` — a server-side ceiling the
-- client cannot raise), so the client capped itself at 10 pages and published
-- 2000 as if it were a total. On a real team a 30d window is several thousand
-- entries, so the headline stat was simply wrong, and its delta was worse:
-- paging walks BACKWARDS from newest, so the cap eats the OLDEST rows, which
-- is exactly the prior window every delta is measured against. Observed live:
-- 2000 entries, prior window empty, "+2000" published as growth.
--
-- Paging to exhaustion instead would be exact but costs one round trip per 200
-- rows — roughly 47 requests for a 30d window and 140 for 90d, on a page load.
-- Counting in the database is one request and stays one request forever.
--
-- ACCESS. `security definer`, exactly like team_feed, which means RLS does NOT
-- apply automatically and every predicate must be written into the body. The
-- WHERE clause below is team_feed's, verbatim, minus only the keyset paging
-- and the row limit. If team_feed's predicate ever changes, change it here in
-- the same migration: a counts function that outlives its feed's access rules
-- reports totals over rows the caller may no longer read, and a count is a
-- disclosure — "your team wrote 4,812 entries about a project you were
-- removed from" is a leak even with no row content attached.
-- ---------------------------------------------------------------------------

create or replace function public.team_feed_counts(
  p_team uuid,
  p_author uuid default null,
  p_project uuid default null,
  p_source text default null,
  p_since timestamptz default null,
  p_until timestamptz default null
)
returns table (
  entries bigint,
  sessions bigint
)
language sql
security definer
set search_path = public
stable
as $$
  -- count(distinct e.session) ignores NULLs, which is why the sessions figure
  -- adds the session-less rows back as one unit each: lib/api-insights.js's
  -- sessionKeyOf treats a row with no session id as its own one-off unit
  -- rather than merging every such row together, and the two must agree or
  -- the page shows a different session count than the list beneath it.
  select
    count(*)::bigint as entries,
    (count(distinct e.session) + count(*) filter (where e.session is null))::bigint as sessions
  from public.memory_entries e
  join public.projects p on p.id = e.project_id
  where p.team_id = p_team
    and p.archived_at is null
    and public.is_team_member(p_team)
    and public.can_see_project(e.project_id)
    and (p_author is null or e.author_id = p_author)
    and (p_project is null or e.project_id = p_project)
    and (p_source is null or e.source = p_source)
    and (p_since is null or e.ts >= p_since)
    and (p_until is null or e.ts <= p_until);
$$;

grant execute on function public.team_feed_counts(
  uuid, uuid, uuid, text, timestamptz, timestamptz) to authenticated;
