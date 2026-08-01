-- 026_project_access_default.sql — Task 17: "new members join with access"
-- per-project default (the Project page toggle). Additive on top of 023/024
-- — do not edit those files. Apply in the Supabase SQL editor (single
-- transaction) or `supabase db push`; with psql use `psql -1 -f` to keep
-- that single-transaction property, matching 002-024's style. Every
-- statement below is re-runnable.
--
-- This is a project-level flag (ONE value per shared project), not a
-- per-member row: public.project_access (023) already answers "does member
-- X see project Y"; this answers "does a brand-new member see project Y by
-- default, before anyone has written an explicit row for them". It lives on
-- public.projects itself — the same table archived_at/archived_by (005)
-- already extended — rather than a new table for a single boolean.
alter table public.projects
  add column if not exists default_access boolean not null default true;

-- Manager-gated write via a security-definer RPC, mirroring archive_project /
-- unarchive_project (005_project_archive.sql): the RPC, not RLS, is the real
-- authorization boundary here, same as those two. public.projects has no
-- UPDATE policy at all (schema.sql grants only select/insert), so a direct
-- PostgREST PATCH is refused regardless — this RPC is the only write path
-- for this column.
create or replace function public.set_project_access_default(p_project uuid, p_default boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team uuid;
begin
  select team_id into v_team from public.projects where id = p_project;
  if v_team is null then
    raise exception 'unknown project';
  end if;
  if not public.is_team_manager(v_team) then
    raise exception 'only a team owner or admin can change this project''s default access';
  end if;
  update public.projects set default_access = p_default where id = p_project;
end;
$$;
