# Rollback snapshot — SEC-jamal-01

Read from live project `mefgbiecvoszjorwzkfz` at **2026-08-06** via the
`mcp__supabase__execute_sql` MCP tool. Read-only. No DDL was issued.

This is the state-of-record captured BEFORE the 054 migration was written, so
whoever lands the migration has a verbatim record of what to restore if it goes
sideways. The active rollback SQL is `supabase/rollback/054_sec_jamal_01.rollback.sql`
— this file is the human-readable evidence that the SQL matches live.

The three findings the migration addresses were audited by `jamal` and judged
CONFIRMED_REAL by `doubting-thomas`. See the ticket for the full write-up. This
file only records the current state, not the reasoning.

---

## 1. `peek_invite(text)` — current body

Query: `select pg_get_functiondef('public.peek_invite(text)'::regprocedure);`

```sql
CREATE OR REPLACE FUNCTION public.peek_invite(p_token text)
 RETURNS TABLE(team_name text, valid boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.check_invite_attempt();
  return query
    select t.name,
           (i.revoked_at is null
            and (i.expires_at is null or i.expires_at > now())
            and (i.max_uses is null or i.use_count < i.max_uses))
    from public.invites i
    join public.teams t on t.id = i.team_id
    where i.token = p_token;
end;
$function$
```

Behaviour today: for a token that exists but is revoked / expired / exhausted,
this returns the CURRENT team name alongside `valid = false`. A former holder
of a revoked token learns the team's present-day name. Rate-limited by
`check_invite_attempt()`, so this is not enumeration; it requires token
possession.

## 2. `can_see_project(uuid)` — current body

Query: `select pg_get_functiondef('public.can_see_project(uuid)'::regprocedure);`

```sql
CREATE OR REPLACE FUNCTION public.can_see_project(p_project uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select bool_and(a.can_see) from public.project_access a
       where a.project_key = p_project::text and a.member_id = auth.uid()),
    (select p.default_access from public.projects p where p.id = p_project),
    true
  );
$function$
```

Behaviour today: latent. The terminal `true` is never reached because
`projects.default_access` is `NOT NULL DEFAULT true`, so the second branch of
`coalesce` always returns a value. If a future migration relaxes that NOT NULL
(the column is on the schema surface and could be widened for legitimate
reasons), a member with no `project_access` row silently reads the feed. The
fix belongs in the function, not the column.

## 3. Grant matrix for the three revoke targets — current state

Query:
```sql
select p.oid::regprocedure::text as sig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('public', p.oid, 'EXECUTE') as public,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
       p.proacl::text as raw_acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('projects_materialize_access','is_team_member','team_feed');
```

Raw output:

| Signature | anon | authenticated | PUBLIC | service_role | Raw ACL |
|---|---|---|---|---|---|
| `projects_materialize_access()` | true | true | **true** | true | `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| `is_team_member(uuid)` | **true** | true | false | true | `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| `team_feed(uuid, timestamptz, bigint, integer, uuid, uuid, text, timestamptz, timestamptz)` | **true** | true | **true** | true | `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |

Notes on the state above, since two rows disagree with what the migration
history in the repo predicts:

- `team_feed` shows PUBLIC and anon executable, but `010_security_hardening.sql`
  at line 409 revokes both. Either 010 was not fully applied, a later action
  re-granted, or a hand-applied step drifted from the file. The MEMORY note
  `live-backend-versus-repo gap` warns about exactly this. The revoke in 054 is
  a no-op for anyone unaffected and a real fix if the drift is what it looks
  like — either way, correct.
- `is_team_member` — 010:355 revokes from public and grants back to anon,
  authenticated, service_role. The ticket asks us to strip anon: is_team_member
  is constant-false for anon (it checks `auth.uid()`), so nothing legitimate is
  callable through it as anon.
- `projects_materialize_access` — no revoke has ever been written for this
  function. `042_definer_function_hardening.sql` explicitly excluded it on the
  reasoning that a trigger function called directly raises "trigger functions
  can only be called as triggers" before any body statement runs. That reasoning
  is correct as a data-safety argument but leaves anon-callable definer surface,
  which is the audit finding.

## 4. `public.projects` trigger listing — proves the trigger IS wired

Query:
```sql
select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
from pg_trigger t
where t.tgrelid = 'public.projects'::regclass and not t.tgisinternal
order by t.tgname;
```

Result:

| Name | Enabled | Definition |
|---|---|---|
| `projects_materialize_access` | `O` (enabled) | `CREATE TRIGGER projects_materialize_access AFTER INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION projects_materialize_access()` |

This refutes jamal's original writeup, which read `information_schema.triggers`
(a permission-filtered view) and concluded the trigger was missing.
`doubting-thomas` re-checked via `pg_trigger` and found it wired. The migration
must NOT add a second `AFTER INSERT` trigger — that would fire the materializer
twice per project insert and double the writes to `project_access`.

## 5. `peek_invite` — grant matrix (for completeness, unchanged by 054)

The migration does not touch `peek_invite`'s ACL. Its anon-callability is
intentional: the caller identifies themselves by presenting the token, and
`check_invite_attempt()` throttles attempts. Recorded here so a future audit
does not re-litigate it.

| Signature | anon | authenticated | PUBLIC | service_role |
|---|---|---|---|---|
| `peek_invite(text)` | true | true | false | true |

---

## What restoring looks like

If 054 lands and something breaks, apply
`supabase/rollback/054_sec_jamal_01.rollback.sql` in the SQL editor. It restores
the two function bodies verbatim from the pastes above, re-GRANTs the ACLs to
their pre-054 state (from the pastes above), and carries its own header
explaining what it reverts and what it deliberately does not undo.

**Rollback is complete for the function-body half.** The grant-matrix half is
reversible in principle — the rollback re-GRANTs — but any caller who
discovered a broken flow after 054 landed will have already been logged. The
rollback restores capability, not history.
