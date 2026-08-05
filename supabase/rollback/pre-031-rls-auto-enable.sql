-- Rollback for migration 031: restore public.rls_auto_enable() to the
-- log-and-continue exception branch, i.e. the behaviour production had before
-- 031 was applied.
--
-- THIS IS NOT A MIGRATION. It lives outside supabase/migrations/ on purpose so
-- nothing applies it by accident. Run it only to undo 031's function change.
--
-- To roll back: paste this whole file into the Supabase SQL editor and run it.
-- It is a single CREATE OR REPLACE on an unchanged signature, so it restores the
-- previous behaviour without touching data, privileges, or the event trigger
-- itself -- ensure_rls keeps pointing at this same function and picks the
-- replacement up on its next fire.
--
-- ---------------------------------------------------------------------------
-- !! THIS BODY IS A RECONSTRUCTION, NOT A CAPTURE -- UNLIKE
-- !! pre-028-029-snapshot.sql, WHICH WAS READ OUT OF pg_proc.
--
-- 031 could not be captured the same way: it was written without access to the
-- live database, so the "before" text below is 031's own reconstruction of
-- production's function with only the exception branch reverted. If you have
-- access to a copy of the live definition from before 031 was applied, prefer it
-- over this file. If you do not, capture it FIRST and then decide:
--   select pg_get_functiondef('public.rls_auto_enable()'::regprocedure);
-- Running the statement below when it differs from production outside the
-- exception branch would silently revert some other hand-applied change too.
-- ---------------------------------------------------------------------------
--
-- WHAT THIS DOES NOT UNDO: nothing else -- 031 writes no data. But understand
-- what you are restoring. Under the body below, a failure to enable RLS on a new
-- table in `public` is invisible: the CREATE TABLE succeeds, the table has no
-- RLS, and the only trace is one line in the Postgres log. That silent gap is
-- the reason 031 exists. Roll back only to unblock a specific, understood
-- failure, and re-apply 031 once the cause is fixed.

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands()
  loop
    if obj.command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
       and obj.object_type = 'table'
       and obj.schema_name = 'public'
    then
      begin
        execute format('alter table if exists %s enable row level security',
                       obj.object_identity);
      exception when others then
        raise log 'rls_auto_enable: could not enable RLS on %: %',
          obj.object_identity, sqlerrm;
      end;
    end if;
  end loop;
end;
$function$;
