-- ---------------------------------------------------------------------------
-- LIVE STATE AUDIT — strictly read-only.
--
-- Purpose: the repo's migration files and the live database have drifted, and
-- nobody can currently say what is actually applied in production. This script
-- answers that. It reads system catalogs only: no INSERT, UPDATE, DELETE,
-- ALTER, CREATE or DROP appears anywhere below. It is safe to run against
-- production and safe to run repeatedly.
--
-- HOW TO RUN
--   Supabase dashboard -> SQL Editor -> paste this whole file -> Run.
--   Copy the entire result grid back.
--
-- THE CRITICAL QUESTION this answers first: two DIFFERENT migrations both
-- numbered 016 exist in the repo, on master and on feat/multidevice-e2e. They
-- solve the same problem in incompatible ways:
--
--   master 016  -> adds a DELETE policy on team_keys (no schema change)
--   branch 016  -> adds device_id to member_pubkeys and team_keys, REWRITES
--                  both primary keys, and DELETES every row in member_pubkeys
--
-- Until we know which one production has, applying either is a coin flip, and
-- one of them is destructive. Section 1 settles it.
-- ---------------------------------------------------------------------------

-- 1. WHICH 016 IS LIVE?  (the blocking question)
select
  '1. which 016 is live' as section,
  check_name,
  result
from (
  select 'branch 016 applied? (member_pubkeys.device_id exists)' as check_name,
         case when exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'member_pubkeys' and column_name = 'device_id'
         ) then 'YES - per-device key model is live' else 'no' end as result
  union all
  select 'branch 016 applied? (team_keys.device_id exists)',
         case when exists (
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'team_keys' and column_name = 'device_id'
         ) then 'YES' else 'no' end
  union all
  select 'master 016 applied? (team_keys_delete_own policy exists)',
         case when exists (
           select 1 from pg_policies
           where schemaname = 'public' and tablename = 'team_keys' and policyname = 'team_keys_delete_own'
         ) then 'YES' else 'no' end
  union all
  select 'team_keys primary key columns',
         coalesce((
           select string_agg(a.attname, ', ' order by k.ord)
           from pg_constraint c
           join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
           where c.conrelid = 'public.team_keys'::regclass and c.contype = 'p'
         ), 'NONE')
  union all
  select 'member_pubkeys primary key columns',
         coalesce((
           select string_agg(a.attname, ', ' order by k.ord)
           from pg_constraint c
           join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
           where c.conrelid = 'public.member_pubkeys'::regclass and c.contype = 'p'
         ), 'NONE')
  union all
  select 'member_pubkeys row count (branch 016 wipes this table)',
         (select count(*)::text from public.member_pubkeys)
) t

union all

-- 2. THE KNOWN LIVE BUG: can a ciphertext-only push actually be stored?
select
  '2. known live bug' as section,
  check_name,
  result
from (
  select 'memory_entries.files nullable?' as check_name,
         coalesce((
           select case when is_nullable = 'YES' then 'YES - push works'
                       else 'NO - ciphertext-only push is REJECTED by the DB' end
           from information_schema.columns
           where table_schema = 'public' and table_name = 'memory_entries' and column_name = 'files'
         ), 'column missing') as result
  union all
  select 'memory_entries.ask nullable? (migration 007)',
         coalesce((
           select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'memory_entries' and column_name = 'ask'
         ), 'column missing')
  union all
  select 'check constraints on memory_entries (any not in repo = drift)',
         coalesce((
           select string_agg(conname, ', ' order by conname)
           from pg_constraint
           where conrelid = 'public.memory_entries'::regclass and contype = 'c'
         ), 'none')
) t

union all

-- 3. WHICH MIGRATIONS' EFFECTS ARE PRESENT
--    Each row infers one migration from a column/table it should have created.
select
  '3. migration effects present' as section,
  check_name,
  result
from (
  select '015_feedback (feedback table)' as check_name,
         case when to_regclass('public.feedback') is not null then 'present' else 'MISSING' end as result
  union all
  select '014_distilled_flag (memory_entries.distilled)',
         case when exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='memory_entries' and column_name='distilled')
           then 'present' else 'MISSING' end
  union all
  select '017_headline_parity (memory_entries.headline)',
         case when exists (select 1 from information_schema.columns
           where table_schema='public' and table_name='memory_entries' and column_name='headline')
           then 'present' else 'MISSING' end
  union all
  select '009/013 e2e (team_keys table)',
         case when to_regclass('public.team_keys') is not null then 'present' else 'MISSING' end
  union all
  select '009/013 e2e (member_pubkeys table)',
         case when to_regclass('public.member_pubkeys') is not null then 'present' else 'MISSING' end
  union all
  select 'join-seal fix (the migration applied by hand, never committed)',
         coalesce((
           select string_agg(policyname, ', ' order by policyname)
           from pg_policies where schemaname='public' and tablename='team_keys'
         ), 'no team_keys policies')
) t

union all

-- 4. FULL POLICY INVENTORY — compare against the repo by eye
select
  '4. all policies' as section,
  tablename || ' :: ' || policyname as check_name,
  cmd as result
from pg_policies
where schemaname = 'public'

union all

-- 5. RLS ENABLED? (a table with RLS off is world-readable through the anon key)
select
  '5. rls enabled' as section,
  c.relname as check_name,
  case when c.relrowsecurity then 'enabled' else 'DISABLED - EXPOSED' end as result
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'

union all

-- 6. TABLES THAT EXIST LIVE (anything not in the repo schema is drift)
select
  '6. tables live' as section,
  table_name as check_name,
  '' as result
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'

order by section, check_name;
