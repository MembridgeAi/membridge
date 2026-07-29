-- ---------------------------------------------------------------------------
-- 019 — ops_snapshot(): aggregate business metrics for the private operator
-- dashboard (spec §4).
--
-- DESIGN CONSTRAINTS, all deliberate:
--
-- 1. NO NEW COLLECTION. Every figure is derived from rows the backend already
--    holds to make team sync work. Nothing is added to any client, and E2E is
--    untouched: this reads row metadata and counts only. `ask`, `files`,
--    `summary` and `ciphertext` are never selected, only counted.
--
-- 2. ONE FUNCTION, NOT VIEWS. A view has to be granted to a role, and the
--    roles available (anon, authenticated) are both wrong — anon is the public
--    internet and authenticated is every signed-in customer. A security-definer
--    function revoked from both, granted only to service_role, means the only
--    caller is something holding the service key.
--
-- 3. AGGREGATES ONLY. The return carries no team names, no user ids, no email
--    addresses, no project names. If the service key ever leaked, this function
--    would disclose counts — the customer data behind it is a separate problem
--    with separate protection (RLS), which this does not weaken.
--
-- 4. NEVER JOINED TO ANONYMOUS INSTALL DATA (spec §7). The counters live on
--    Cloudflare, in a system with no route to this database. That separation is
--    structural and must stay that way: do not add an install_id column here.
--
-- p_exclude_teams lets the operator's own dogfooding teams be left out of every
-- figure without a schema change — pass the team ids to exclude, or '{}' for
-- everything. Answers open question §11.1.
-- ---------------------------------------------------------------------------

create or replace function public.ops_snapshot(p_exclude_teams uuid[] default '{}')
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with live_teams as (
    select t.id, t.created_at
    from public.teams t
    where not (t.id = any(p_exclude_teams))
  ),
  sizes as (
    select lt.id, count(tm.user_id) as members
    from live_teams lt
    left join public.team_members tm on tm.team_id = lt.id
    group by lt.id
  ),
  -- Last activity per team, used for both retention and "active" counts.
  activity as (
    select p.team_id, max(e.ts) as last_ts, count(*) as entries
    from public.projects p
    join public.memory_entries e on e.project_id = p.id
    where p.team_id in (select id from live_teams)
    group by p.team_id
  )
  select jsonb_build_object(
    'generated_at', now(),

    'teams', jsonb_build_object(
      'total', (select count(*) from live_teams),
      'created_7d', (select count(*) from live_teams where created_at > now() - interval '7 days'),
      'created_30d', (select count(*) from live_teams where created_at > now() - interval '30 days'),
      -- "Active" means a team someone actually pushed into, not one that exists.
      'active_7d', (select count(*) from activity where last_ts > now() - interval '7 days'),
      'active_30d', (select count(*) from activity where last_ts > now() - interval '30 days'),
      -- Retention's inverse: alive once, quiet since.
      'dormant_7d', (select count(*) from activity where last_ts <= now() - interval '7 days'),
      'never_active', (select count(*) from live_teams lt
                       where not exists (select 1 from activity a where a.team_id = lt.id))
    ),

    -- Bucketed rather than a raw distribution: with few teams, exact sizes plus
    -- a creation date is close to identifying, and the shape is what matters.
    'team_sizes', jsonb_build_object(
      'solo', (select count(*) from sizes where members <= 1),
      'two_to_three', (select count(*) from sizes where members between 2 and 3),
      'four_to_nine', (select count(*) from sizes where members between 4 and 9),
      'ten_plus', (select count(*) from sizes where members >= 10),
      'largest', coalesce((select max(members) from sizes), 0)
    ),

    'projects', jsonb_build_object(
      'total', (select count(*) from public.projects p where p.team_id in (select id from live_teams)),
      'teams_with_multiple', (select count(*) from (
        select p.team_id from public.projects p
        where p.team_id in (select id from live_teams)
        group by p.team_id having count(*) > 1
      ) x)
    ),

    'developers', jsonb_build_object(
      'active_7d', (select count(distinct e.author_id)
                    from public.memory_entries e
                    join public.projects p on p.id = e.project_id
                    where p.team_id in (select id from live_teams)
                      and e.ts > now() - interval '7 days'),
      'active_30d', (select count(distinct e.author_id)
                     from public.memory_entries e
                     join public.projects p on p.id = e.project_id
                     where p.team_id in (select id from live_teams)
                       and e.ts > now() - interval '30 days')
    ),

    'entries', jsonb_build_object(
      'total', coalesce((select sum(entries) from activity), 0),
      'last_7d', (select count(*)
                  from public.memory_entries e
                  join public.projects p on p.id = e.project_id
                  where p.team_id in (select id from live_teams)
                    and e.ts > now() - interval '7 days')
    ),

    -- Which coding tools are actually in use. `source` is a short adapter id
    -- (claude-code, codex, a custom adapter's id) — metadata, never content.
    'tool_mix', coalesce((
      select jsonb_object_agg(src, n) from (
        select e.source as src, count(*) as n
        from public.memory_entries e
        join public.projects p on p.id = e.project_id
        where p.team_id in (select id from live_teams)
          and e.ts > now() - interval '30 days'
        group by e.source
      ) t
    ), '{}'::jsonb)
  );
$$;

-- The whole point of a security-definer function here: lock it to the service
-- role. `anon` is the public internet and `authenticated` is every signed-in
-- customer — neither should be able to read aggregate business metrics.
revoke all on function public.ops_snapshot(uuid[]) from public;
revoke all on function public.ops_snapshot(uuid[]) from anon;
revoke all on function public.ops_snapshot(uuid[]) from authenticated;
grant execute on function public.ops_snapshot(uuid[]) to service_role;
