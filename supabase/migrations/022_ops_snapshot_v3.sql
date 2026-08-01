-- ---------------------------------------------------------------------------
-- 022 — ops_snapshot v3. Same metrics as 020, three changes for the panel:
--
-- 1. Returns each team's `id`, so the panel can target an action at a row.
--    Ids are uuids behind Cloudflare Access; they are not secrets, and without
--    them every action would need a name lookup that breaks on rename.
--
-- 2. Returns `note` and `internal` from ops_team_meta (021), so the list shows
--    what we know about an account, not just what it did.
--
-- 3. Internal teams are excluded automatically. Previously this was
--    EXCLUDE_TEAMS, a JSON array in the Worker's config — excluding a
--    dogfooding account meant editing config and redeploying, which in practice
--    means nobody does it and every number is quietly wrong. Now it is a
--    checkbox in the panel that writes to the database. p_exclude_teams is kept
--    for one-off analysis and is additive to the flag.
-- ---------------------------------------------------------------------------

create or replace function public.ops_snapshot(p_exclude_teams uuid[] default '{}')
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with live_teams as (
    select t.id, t.name, t.created_at,
           m.note, coalesce(m.internal, false) as internal
    from public.teams t
    left join public.ops_team_meta m on m.team_id = t.id
    where not (t.id = any(p_exclude_teams))
      and coalesce(m.internal, false) = false
  ),
  members as (
    select tm.team_id, count(*)::int as n
    from public.team_members tm
    where tm.team_id in (select id from live_teams)
    group by tm.team_id
  ),
  entries as (
    select p.team_id, e.ts, e.author_id, e.source
    from public.memory_entries e
    join public.projects p on p.id = e.project_id
    where p.team_id in (select id from live_teams)
  ),
  team_activity as (
    select team_id,
           max(ts) as last_ts, min(ts) as first_ts,
           count(*)::int as entries_all,
           count(*) filter (where ts > now() - interval '7 days')::int as entries_7d,
           count(*) filter (where ts > now() - interval '14 days'
                              and ts <= now() - interval '7 days')::int as entries_prev_7d,
           count(distinct author_id)::int as contributors
    from entries group by team_id
  ),
  weeks as (
    select generate_series(
      date_trunc('week', now()) - interval '7 weeks',
      date_trunc('week', now()), interval '1 week') as wk
  ),
  series as (
    select w.wk,
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
  cohorts as (
    select w.wk,
      (select count(*) from live_teams lt
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week')::int as size,
      (select count(distinct en.team_id) from entries en join live_teams lt on lt.id = en.team_id
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week'
          and en.ts >= w.wk + interval '1 week' and en.ts < w.wk + interval '2 weeks')::int as wk1,
      (select count(distinct en.team_id) from entries en join live_teams lt on lt.id = en.team_id
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week'
          and en.ts >= w.wk + interval '2 weeks' and en.ts < w.wk + interval '3 weeks')::int as wk2,
      (select count(distinct en.team_id) from entries en join live_teams lt on lt.id = en.team_id
        where lt.created_at >= w.wk and lt.created_at < w.wk + interval '1 week'
          and en.ts >= w.wk + interval '4 weeks' and en.ts < w.wk + interval '5 weeks')::int as wk4
    from weeks w
  )
  select jsonb_build_object(
    'generated_at', now(),
    'funnel', jsonb_build_object(
      'created', (select count(*) from live_teams),
      'synced_once', (select count(*) from team_activity),
      'active_7d', (select count(*) from team_activity where last_ts > now() - interval '7 days'),
      'returned', (select count(*) from team_activity where last_ts - first_ts > interval '1 day'),
      'multi_member', (select count(*) from members where n > 1),
      'multi_member_active', (select count(*) from members m
                               join team_activity a on a.team_id = m.team_id
                               where m.n > 1 and a.last_ts > now() - interval '7 days')
    ),
    'series', coalesce((select jsonb_agg(jsonb_build_object(
        'week', to_char(wk, 'YYYY-MM-DD'), 'new_teams', new_teams,
        'active_teams', active_teams, 'active_devs', active_devs, 'entries', entries
      ) order by wk) from series), '[]'::jsonb),
    'cohorts', coalesce((select jsonb_agg(jsonb_build_object(
        'week', to_char(wk, 'YYYY-MM-DD'), 'size', size, 'wk1', wk1, 'wk2', wk2, 'wk4', wk4
      ) order by wk) from cohorts where size > 0), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', lt.id, 'name', lt.name, 'note', lt.note, 'internal', lt.internal,
        'members', coalesce(m.n, 0), 'created_at', lt.created_at,
        'last_active', a.last_ts, 'entries_all', coalesce(a.entries_all, 0),
        'entries_7d', coalesce(a.entries_7d, 0), 'entries_prev_7d', coalesce(a.entries_prev_7d, 0),
        'contributors', coalesce(a.contributors, 0)
      ) order by a.last_ts desc nulls last)
      from live_teams lt
      left join members m on m.team_id = lt.id
      left join team_activity a on a.team_id = lt.id), '[]'::jsonb),
    -- Surfaced so the panel can say how many accounts are hidden. A silent
    -- exclusion is how you end up trusting a number that quietly omits half
    -- the customers.
    'excluded_internal', (select count(*) from public.ops_team_meta where internal),
    'tool_mix', coalesce((select jsonb_object_agg(src, n) from (
        select source as src, count(*) as n from entries
        where ts > now() - interval '30 days' group by source) t), '{}'::jsonb)
  );
$$;

revoke all on function public.ops_snapshot(uuid[]) from public, anon, authenticated;
grant execute on function public.ops_snapshot(uuid[]) to service_role;
