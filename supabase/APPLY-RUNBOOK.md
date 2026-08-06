# Runbook — the six pieces of SQL waiting to be applied

**Written for whoever sits down to apply these, without having been in the sessions that wrote them.** You should not need to open a single migration header to follow this. If you want the reasoning behind any one of them, it is in that file's header; this page is the order, the risks and the checks.

Status of every migration lives in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md). Update it as you go — the row is the record that a thing was applied, and a test fails if a file has no row.

---

## Before you start

- **Paste into the Supabase SQL editor. Never `supabase db push` in this project.** `supabase_migrations.schema_migrations` holds only two rows, so a push would try to re-run thirty-plus files against a database that already has most of their effects.
- The editor runs each paste in one transaction. If a statement fails, nothing from that file is applied — you can fix and re-paste.
- **Every file here is safe to re-run.** If you lose your place, re-pasting one you already did is a no-op.
- Nothing here has been run against any database by the sessions that wrote it.

---

## The order

Apply in this order. It is numeric order with **one deliberate exception: `031` goes last.**

| # | File | What it does, in one sentence |
|---|------|-------------------------------|
| 1 | `037_project_access_team_scope.sql` | Stops someone using their own team to grant or revoke access to **another** team's project. |
| 2 | `038_invite_redeem_atomic.sql` | Makes an invite's "max uses" limit actually hold when two people redeem at the same moment. |
| 3 | `039_team_audit_created_at.sql` | Stops an admin from writing audit-log entries with a false timestamp. |
| 4 | `042_definer_function_hardening.sql` | Takes three database functions off the public key, and stops one of them answering questions about teams you are not in. |
| 5 | `043_revoke_blanket_table_grants.sql` | Removes a leftover blanket permission on three internal tables, including the one holding unredeemed invite tokens. |
| 6 | `031_ensure_rls_event_trigger.sql` | Makes it impossible to create a table without row-level security **by refusing the creation** instead of logging and carrying on. |

**Why `031` is last.** It is the only one that changes how the database behaves for *future* work rather than fixing something specific, and it is the only one reconstructed from a live object rather than written from scratch. Do it when the other five are known good, so that if anything odd happens afterwards you know which change to look at.

---

## The one hard dependency

> ### `038` must be applied **before** the app release that carries the new invite defaults — never after.
>
> The app change (in `lib/server.js`) starts giving every new invite a 7-day expiry and a 1-use limit. `038` is what makes that 1-use limit hold under simultaneous redemption.
>
> - `038` applied first, app shipped later → fine. The fix is in place before anything relies on it.
> - App shipped first, `038` later → **there is a window where the app tells people an invite is single-use and it is not.** Two people clicking the same link at the same moment both get in.
>
> If you are applying these and the release has not gone out yet, you are fine — just do `038` now.

There are no other ordering constraints between these six. Each one touches a different thing, and none of them depends on another having run first.

---

## Applying them, with the check for each

### 1. `037_project_access_team_scope.sql`

**Does:** stops a `project_access` row naming a project outside the team that wrote it.

**After applying, check:** open a project you manage and toggle a teammate's access to it. It should work exactly as before.

**If that breaks,** the new rule is stricter than intended — it requires the project to be visible to you under the normal project rules, which for a manager of that team it always is. Report it rather than working around it.

**Optional cleanup, separate and NOT automatic.** The new rule governs *future* writes; any bad row already in the table keeps working. Run this to see whether there are any:

```sql
select a.team_id, a.project_key, a.member_id, a.can_see, a.updated_at, a.updated_by
  from public.project_access a
 where not exists (select 1 from public.projects p
                    where p.id::text = a.project_key and p.team_id = a.team_id)
 order by a.updated_at desc;
```

Most likely it returns nothing. If it returns rows, **read them before deleting anything** — the query also matches harmless leftovers from deleted projects, not just bad grants. The matching `delete` is in `037`'s header when you want it.

---

### 2. `038_invite_redeem_atomic.sql`

**Does:** an invite's use is now claimed atomically, so a 1-use invite can only ever admit one person.

**See the dependency box above — this one has a release-ordering constraint.**

**After applying, check:** create an invite and redeem it once. It should work normally. Redeeming a second time on a 1-use invite should say *"this invite link has already been used."*

**Also check:** redeeming an invite you have already used (i.e. you are already on the team) should still be a harmless no-op and should **not** consume one of its uses.

---

### 3. `039_team_audit_created_at.sql`

**Does:** the database now stamps the time on every audit-log row, so the time cannot be supplied by whoever is writing it.

**After applying, check:** do anything that writes an audit entry — create an invite, change someone's role — then open the audit trail. The new entry should appear with the correct current time.

**Note:** existing rows are untouched. This only guarantees the property from now on.

---

### 4. `042_definer_function_hardening.sql`

**Does:** three database functions were callable by anyone holding the public key; they now are not. Separately, a function that answered *"is person X on team Y?"* now refuses unless you are on team Y yourself.

**After applying, run the smoke test — this is the one with a real regression risk:**

> **Have an existing member share the team with someone new, and confirm the new joiner can read existing team history.**
>
> This is the flow that broke once before (a new member joined but could not decrypt anything). The function this migration changed is the one that check runs through. If a new joiner can see history, you are good.

**Also check:** the ops dashboard still loads (it uses a different credential and should be unaffected), and normal team feed / project pages still load.

**If the new-joiner check fails,** the added condition in `is_team_member_uid` is the only thing that changed — say so and it can be reverted on its own.

---

### 5. `043_revoke_blanket_table_grants.sql`

**Does:** removes a default permission that was never used but was sitting on three internal tables — including the one holding unredeemed invite tokens.

**After applying, check:** the ops dashboard still loads and shows teams. It reaches these tables with a different credential that this change does not touch.

**Also check:** redeeming an onboarding invite still creates a team.

**Deliberately not included:** the feedback form and the waitlist signup on the site also have this kind of permission, and they **need** it — they exist to accept submissions from people who are not logged in. They are left alone on purpose. Do not "finish the job" by adding them.

---

### 6. `031_ensure_rls_event_trigger.sql`

**Does:** there is a safety net that switches on row-level security whenever a table is created. Today, if it fails, it writes a line to a log nobody reads and lets the table be created anyway. After this, it refuses the creation.

**Read this before applying:** this file was reconstructed from the version already running in production, because nobody had the original. The live version has been read and compared, and the differences are accounted for — that is recorded in the file. This is the only migration here in that position.

**After applying, check:** create a throwaway table and confirm it comes out with row-level security already on, then drop it.

```sql
create table public.rls_smoke_test (id int);
select relrowsecurity from pg_class where relname = 'rls_smoke_test';  -- expect: t
drop table public.rls_smoke_test;
```

**If that errors instead of succeeding,** the safety net is now refusing a creation it should have allowed. That is the fail-closed behaviour working too eagerly — it is recoverable, and the error message says what to do. Do not drop the trigger to get past it.

---

## When you are done

1. Update each row in [`MIGRATION-STATE.md`](./MIGRATION-STATE.md) from **NOT applied** to **applied**, with today's date at the top of the file. Each row already carries the query that proves it.
2. If you stopped part way, leave the remaining rows as they are — that is what they are for.

## One thing that is not fixed by any of this

The ops dashboard holds a database key that bypasses **all** of the protections above. Everything in this runbook constrains what ordinary users and the app can do; none of it constrains that key. Narrowing it to a read-only role is a separate, larger piece of work that has not been done. Worth knowing when reading any claim that a table is "protected".
