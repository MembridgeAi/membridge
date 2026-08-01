-- ---------------------------------------------------------------------------
-- 020 — ops_snapshot v2: rebuilt around the questions an early-stage founder
-- actually asks, replacing 019's aggregate buckets.
--
-- WHY 019 WAS WRONG. It reported bucketed distributions (solo / 2-3 / 4-9 /
-- 10+) and point-in-time totals. At a dozen teams a distribution is noise —
-- "6 solo, 4 small" tells you nothing you can act on, and hides the only facts
-- that matter: WHICH teams came back, WHICH went quiet, and whether anyone
-- crosses from solo to a real team. Aggregates are what you graduate to when
-- the list gets too long to read. This is not that stage.
--
-- WHAT CHANGED, and the reasoning:
--   * Time series, not snapshots. One number with no trend cannot tell you
--     whether things are working. Eight weekly buckets.
--   * An activation funnel. Signups are vanity; the question is where people
--     stop. Created -> synced once -> came back -> invited someone.
--   * Weekly retention cohorts. The single most honest pre-PMF signal.
--   * A per-team list. At this size the list IS the dashboard: it turns
--     numbers into "email these three people today".
--
-- PRIVACY LINE, unchanged and explicit. This returns METADATA ONLY: team name,
-- member count, timestamps, row counts. It never returns `ask`, `summary`,
-- `files`, `ciphertext` or any content, and it cannot — the server holds only
-- ciphertext for those. E2E is untouched.
--
-- Team NAMES are returned, deliberately. 019 withheld them, which made the
-- output useless for the one job it has at this scale. These are the
-- operator's own customer accounts and this function is service_role-only
-- behind Cloudflare Access; a normal admin console shows account names. If
-- that ever stops being acceptable, pseudonymise HERE rather than in the
-- dashboard, so the guarantee is server-side.
--
-- STILL NEVER JOINED to the anonymous install counters (spec §7). Those live
-- on Cloudflare, in a system with no route to this database.
-- ---------------------------------------------------------------------------

create or replace function public.ops_snapshot(p_exclude_teams uuid[] default '{}')
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with live_teams as (
    select t.id, t.name, t.created_at
    from public.teams t
    where not (t.id = any(p_exclude_teams))
  ),
  members as (
    select tm.team_id, count(*)::int as n
    from public.team_members tm
    where tm.team_id in (select id from live_teams)
    group by tm.team_id
  ),
  -- Every entry, tagged with its team. The base for both the series and the
  -- per-team rollup, so the two can never disagree.
  entries as (
    select p.team_id, e.ts, e.author_id, e.source
    from public.memory_entries e
    join public.projects p on p.id = e.project_id
    where p.team_id in (select id from live_teams)
  ),
  team_activity as (
    select team_id,
           max(ts) as last_ts,
           min(ts) as first_ts,
           count(*)::int as entries_all,
           count(*) filter (where ts > now() - interval '7 days')::int as entries_7d,
           count(*) filter (where ts > now() - interval '14 days'
                              and ts <= now() - interval '7 days')::int as entries_prev_7d,
           count(distinct author_id)::int as contributors
    from entries group by team_id
  ),
  -- Eight weekly buckets, oldest first. generate_series guarantees a row per
  -- week even when nothing happened — a gap in a chart must read as zero, not
  -- as a missing point that the eye interpolates over.
  weeks as (
    select generate_series(
      date_trunc('week', now()) - interval '7 weeks',
      date_trunc('week', now()),
      interval '1 week'
    ) as wk
  ),
  series as (
    select
      w.wk,
      (select count(*) from live_teams lt
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week')::int as new_teams,
      (select count(distinct en.team_id) from entries en
        where en.ts >= w.wk and en.ts < w.wk + interval '1 week')::int as active_teams,
      (select count(distinct en.author_id) from entries en
        where en.ts >= w.wk and en.ts < w.wk + interval '1 week')::int as active_devs,
      (select count(*) from entries en
        where en.ts >= w.wk and en.ts < w.wk + interval '1 week')::int as entries
    from weeks w
  ),
  -- Retention by signup week: of the teams created in week W, how many were
  -- still pushing entries 1, 2 and 4 weeks later. Small numbers, but the shape
  -- is the most honest pre-PMF signal there is.
  cohorts as (
    select
      w.wk,
      (select count(*) from live_teams lt
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week')::int as size,
      (select count(distinct en.team_id) from entries en
        join live_teams lt on lt.id = en.team_id
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week'
          and en.ts >= w.wk + interval '1 week' and en.ts < w.wk + interval '2 weeks')::int as wk1,
      (select count(distinct en.team_id) from entries en
        join live_teams lt on lt.id = en.team_id
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week'
          and en.ts >= w.wk + interval '2 weeks' and en.ts < w.wk + interval '3 weeks')::int as wk2,
      (select count(distinct en.team_id) from entries en
        join live_teams lt on lt.id = en.team_id
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week'
          and en.ts >= w.wk + interval '4 weeks' and en.ts < w.wk + interval '5 weeks')::int as wk4
    from weeks w
  )
  select jsonb_build_object(
    'generated_at', now(),

    -- The funnel. Each step is a strict subset of the one above it, so the
    -- drop-off between two rows is the thing to act on. "Created an account"
    -- is not a step worth celebrating; "came back a second week" is.
    'funnel', jsonb_build_object(
      'created',        (select count(*) from live_teams),
      'synced_once',    (select count(*) from team_activity),
      'active_7d',      (select count(*) from team_activity where last_ts > now() - interval '7 days'),
      'returned',       (select count(*) from team_activity
                          where last_ts - first_ts > interval '1 day'),
      'multi_member',   (select count(*) from members where n > 1),
      -- The thesis check: MemBridge is a TEAM product. A solo user is a
      -- different, weaker product. This ratio is the business model working
      -- or not working.
      'multi_member_active', (select count(*) from members m
                               join team_activity a on a.team_id = m.team_id
                               where m.n > 1 and a.last_ts > now() - interval '7 days')
    ),

    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
        'week', to_char(wk, 'YYYY-MM-DD'),
        'new_teams', new_teams, 'active_teams', active_teams,
        'active_devs', active_devs, 'entries', entries
      ) order by wk)
      from series
    ), '[]'::jsonb),

    'cohorts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'week', to_char(wk, 'YYYY-MM-DD'),
        'size', size, 'wk1', wk1, 'wk2', wk2, 'wk4', wk4
      ) order by wk)
      from cohorts where size > 0
    ), '[]'::jsonb),

    -- The list. Ordered by most recently active so the dashboard can slice it
    -- into "going quiet" and "never started" without a second round trip.
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', lt.name,
        'members', coalesce(m.n, 0),
        'created_at', lt.created_at,
        'last_active', a.last_ts,
        'entries_all', coalesce(a.entries_all, 0),
        'entries_7d', coalesce(a.entries_7d, 0),
        'entries_prev_7d', coalesce(a.entries_prev_7d, 0),
        'contributors', coalesce(a.contributors, 0)
      ) order by a.last_ts desc nulls last)
      from live_teams lt
      left join members m on m.team_id = lt.id
      left join team_activity a on a.team_id = lt.id
    ), '[]'::jsonb),

    'tool_mix', coalesce((
      select jsonb_object_agg(src, n) from (
        select source as src, count(*) as n from entries
        where ts > now() - interval '30 days' group by source
      ) t
    ), '{}'::jsonb)
  );
$$;

revoke all on function public.ops_snapshot(uuid[]) from public;
revoke all on function public.ops_snapshot(uuid[]) from anon;
revoke all on function public.ops_snapshot(uuid[]) from authenticated;
grant execute on function public.ops_snapshot(uuid[]) to service_role;
