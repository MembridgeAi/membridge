# Account deletion — findings and spec

**Status: investigation and specification. Nothing here has been applied to any
database, and no product code has been changed.** The one migration this spec
proposes (`supabase/migrations/052_account_deletion_fk_actions.sql`) is written
and committed, and is explicitly *not* applied and *not* cleared to be applied.
It waits on a decision that belongs to the product owner, laid out in §6.

**§8 is a second investigation, also build-free**: the soft-delete blind spot,
its surface inventory, the backend change that would close it, and the
operational guidance that costs nothing and should not wait for any of it.

Every constraint fact below was read from the **live catalog**, read-only, on
2026-08-05 — not from `supabase/schema.sql`, which describes intent rather than
production. Where a claim could not be established without writing to the live
database, it is marked as such and the safe way to settle it is named.

---

> ## ⚠ Read this first: do not soft-delete a user
>
> The blocked-constraint story below is the *safe* half of this investigation.
> The unsafe half is that the Supabase dashboard offers a **soft delete** beside
> the delete that correctly refuses — and soft delete **always succeeds**,
> because it leaves the account row in place and so touches none of the seven
> constraints.
>
> **Nothing in `supabase/`, `lib/` or `ui/src/` reads `auth.users.deleted_at`.
> Zero hits.** Not one function, policy, view or client. So the account is
> deleted in the auth system and fully present in the product: still on the
> roster, still named on every entry, still counted as a contributor, still
> nagged about in Insights — and, worst, **still receiving a sealed copy of
> every new team encryption key**.
>
> Someone doing the responsible thing — a departing employee, a person
> exercising a deletion request — gets an operator UI that says *done* and a
> product in which nothing happened. Nothing in our code will ever go red,
> because our code is not the thing making the claim.
>
> **Full specification: §8.** **Operational answer today: use "Remove from
> team" (`remove_member`), never soft delete.** §8.6 explains why the operation
> we already have does what soft delete only appears to do.

---

## For the product owner, in plain language

**Nobody can delete a MemBridge account today, and nobody has ever been able
to.** Four things are true and they matter in very different ways. The third is
the one to act on.

1. **There is no delete-my-account button.** Not in the app, not in the CLI, not
   in the API the app talks to. Deleting an account is something only someone
   with the Supabase dashboard password can attempt. So no customer is hitting
   an error today — the feature simply is not there. That lowers the urgency a
   lot, and it should be said plainly rather than left sounding like a live
   outage.

2. **If you did attempt it from the dashboard, it would refuse.** Seven places
   in the database point at a user account and none of them says what to do when
   that account goes away, so the database blocks the deletion outright. It
   refuses cleanly — it does not half-delete and leave a mess. That is the good
   news, and it is the reason this is a "we owe someone a feature" problem
   rather than a "we have corrupted data" problem. Of our five accounts, three
   are blocked and two (which have never done anything) would delete fine.

3. **The button next to it succeeds, and produces a lie.** Supabase can "soft
   delete" an account instead. That works every time — it sidesteps all seven
   blocks by keeping the account row. But **nothing in MemBridge looks at the
   flag it sets**, so the person stays a visible teammate, their name stays on
   every entry, Insights keeps telling their manager that nothing has arrived
   from them, and the team keeps encrypting every new key to them. The only
   real change is that they can no longer sign in. That is a suspension
   presented as a deletion, and no test or alert anywhere will ever catch it,
   because the false claim is made by Supabase's UI and not by our code.
   **Tell whoever holds the dashboard: never use soft delete — use "Remove from
   team", which actually does the offboarding.** §8 is the full write-up.

4. **No server-side change reaches your colleagues' laptops.** MemBridge copies
   shared memory onto every teammate's machine, and deleting from the server
   does not reach those copies — there is no mechanism today that would. So "we
   deleted your account" can never honestly mean "your work is gone from your
   colleagues' machines" without building something that does not exist yet.

The decision this spec needs from you is in §6, and §8.4 needs that same
decision applied to a second set of screens. It is a genuine conflict already
present in the codebase — two migrations say a departed member's contributions
are never deleted, a third deliberately lets a member delete their own — and
account deletion sits on top of it. I have laid out what each answer costs. I
have not picked one.

**One engineering prerequisite that is not a decision and must not be scheduled
separately: §4.1, the last-owner check.** Deleting an owner's account silently
does the thing the product explicitly forbids everywhere else, and leaves a team
that nobody can administer, permanently. It is masked today and stops being
masked the moment `052` is applied. It ships with `052`, or `052` does not ship.

---

## 1. Every constraint that blocks deleting a user

Read from `pg_constraint` against production. All ten public-schema foreign keys
that reference `auth.users` are listed; nothing is omitted.

### Blocking — `NO ACTION`, not deferrable, so the delete fails immediately

| # | Table.column | Nullable? | What the row means | `on delete` today |
|---|---|---|---|---|
| 1 | `teams.created_by` | **NOT NULL** | founded a team | NO ACTION |
| 2 | `projects.created_by` | **NOT NULL** | first linked a project | NO ACTION |
| 3 | `projects.archived_by` | nullable | archived a project | NO ACTION |
| 4 | `memory_entries.author_id` | **NOT NULL** | ever synced one entry | NO ACTION |
| 5 | `project_access.updated_by` | nullable | changed someone's project access | NO ACTION |
| 6 | `invites.created_by` | **NOT NULL** | minted an invite | NO ACTION |
| 7 | `team_audit.actor_id` | nullable | took an audited team action | NO ACTION |

All seven are `NOT DEFERRABLE` and `VALIDATED`, so each raises `23503
foreign_key_violation` at statement time rather than at commit.

### Already safe — `ON DELETE CASCADE`, and correctly so

| Table.column | What cascading means |
|---|---|
| `team_members.user_id` | their membership disappears — correct, but see §2.3 |
| `member_pubkeys.user_id` | their identity key disappears — correct |
| `team_keys.member_user_id` | their sealed copies of team keys disappear — correct |

These three are the right answer already: all three rows exist *only* to describe
a live account's participation, and none of them is a record about anyone else.
No change is proposed to any of them.

### Not a foreign key, and therefore not a blocker — checked and clean

- `project_access.member_id` is a bare `uuid` with no FK to `auth.users`, which
  looks like an orphan risk. It is not: `project_access` carries
  `(team_id, member_id) → team_members(team_id, user_id) ON DELETE CASCADE`, and
  `team_members.user_id` cascades from `auth.users`. So a member's access rows
  die transitively. Verified with a live orphan count: **0**.
- `ops_audit.actor` and `onboarding_invites.created_by` are `text`, not user
  ids. They are unaffected by account deletion in either direction — which also
  means they permanently retain whatever string was written into them.

### Correction to the audit in `050`'s header

`050_team_audit_actor_set_null.sql` (branch `agent-removal`) says deletion is
"blocked by SIX foreign keys" and then lists seven. The list is right and the
count is off by one. Seven block today; `050` fixes one; **six would remain**.
The live catalog confirms `050` is not applied — `team_audit_actor_id_fkey` is
still `NO ACTION`.

### The blast radius is per-user, and most users are blocked

| Account | teams | projects | archived | entries | access | invites | audit | Deletable today? |
|---|---|---|---|---|---|---|---|---|
| marco@melika.com | 2 | 3 | 0 | 2056 | 0 | 9 | 6 | **no** |
| andrewludwigbrown@gmail.com | 0 | 3 | 0 | 216 | 0 | 1 | 0 | **no** |
| marco@melika.me | 1 | 1 | 0 | 3 | 0 | 1 | 0 | **no** |
| ana@myblueolive.com | 0 | 0 | 0 | 0 | 0 | 0 | 0 | yes |
| fluffylehalo@gmail.com | 0 | 0 | 0 | 0 | 0 | 0 | 0 | yes |

This matters for how the finding is described. "Account deletion is broken" is
true; "no account can be deleted" is not. What is true is that **any account that
has ever done anything is undeletable**, and `memory_entries.author_id` alone
achieves that for every real user, which is why this defect predates today and
predates `046`.

---

## 2. What actually happens today

### 2.1 A hard delete refuses; it does not half-complete

The database side is certain from the catalog: the FKs are `NO ACTION` and
`NOT DEFERRABLE`, so `delete from auth.users where id = …` aborts on the first
violated constraint. The statement is rolled back by definition — a failed
statement in Postgres leaves nothing behind.

The surrounding operation is the part I can reason about but did not execute.
GoTrue's admin delete wraps its work in a single transaction, so the expected
outcome is a clean refusal surfaced as a 500 from
`DELETE /auth/v1/admin/users/{id}`, or "Database error deleting user" in the
dashboard. **This is expectation, not measurement.** I deliberately did not run
a deletion — not even inside a rolled-back transaction — against production.

> **How to settle it without risk:** reproduce on a scratch Supabase project or
> a local `supabase start` stack seeded with one user and one `memory_entries`
> row, and attempt the admin delete there. That is the only honest way to turn
> this from "expected" into "verified", and it takes minutes.

The practical answer for now: **a partial deletion is not a live risk on the
hard-delete path.** A refused deletion is what the schema produces.

### 2.2 A soft delete succeeds and is worse than the refusal

`auth.users.deleted_at` exists on this instance and is currently null for all
five accounts. Supabase's admin API and dashboard both offer a soft delete,
which sets that column instead of removing the row.

A soft delete touches **none** of the seven constraints, because the row never
goes away. So it always "works". And:

> **Nothing in MemBridge reads `auth.users.deleted_at`.** Grepped across
> `supabase/`, `lib/`, `ui/src/` — zero hits. No RPC, no policy, no view, no
> client.

The consequence is the exact failure shape this codebase already has a name for
(*state claiming unearned success*): the operator sees "user deleted", and in
the product nothing changes. The account still appears in `team_members` with
its display name. Every `memory_entries` row still carries its live `author_id`
and its `author_name`. The team hub still counts them as a contributor. The only
real effect is that the person can no longer sign in — which is a suspension,
not a deletion, presented as a deletion.

**This is the highest-value single finding in this investigation**, because it
is reachable today, it succeeds today, and it is one click away from the
operation that correctly refuses. It is specified in full in **§8**, which is
the next ticket; this section states only that it exists.

### 2.3 The cascade on `team_members` walks around a guard the schema states out loud

`leave_team` (live, security definer) refuses outright:

```
if public.team_role(p_team) = 'owner' then
  raise exception 'the owner cannot leave their own team';
end if;
```

`team_members.user_id` is `ON DELETE CASCADE`. So deleting an owner's account
does silently, through a different table, exactly what `leave_team` is written to
forbid: it removes the owner's membership row and leaves a team with **no
owner**. Authorization is `team_members.role`, not `teams.created_by` (confirmed:
no policy and no function reads `created_by` for any authorization decision), so
an ownerless team is one that no one can administer — no invites, no removals, no
access changes, no audit reads, permanently.

Today this is masked, because an owner is also blocked by
`teams.created_by`. **It stops being masked the moment account deletion is made
to work**, which makes it a prerequisite of the feature rather than a separate
bug. This is structurally the same argument `050` makes about `team_audit`: a
cascade must not become a side door around a rule stated elsewhere.

### 2.4 What no database change reaches: the copies on teammates' laptops

Deletion on the backend is not erasure, and the gap is architectural.

- `teamsync.markTeamDataDeleted` writes a deletion watermark, and it writes it
  **only on the deleting user's own machine**, to stop their next sync pass
  re-uploading what was just removed.
- There is no tombstone, no deletion event on the wire, and nothing a teammate's
  daemon pulls that would tell it to drop rows it already has.
- Teammates hold those rows in `state.json` (`teamEntries`, read via
  `util.teamRowsFor`) and in a second, derived copy at
  `<project>/.membridge/teammate-notes.json`. `lib/util.js` documents the second
  copy explicitly, including that it has no expiry.
- Both are read with **no network call** — by `search_memory`, by `why`, by the
  SessionStart injection, by the recall hook. There is no point at which the
  backend gets to say "that is gone now".

So for any option in §6: **backend deletion removes the row from the server and
from future pulls. It does not remove it from anyone who already pulled it.**
Saying otherwise to a user would be false. Closing that gap is a distinct piece
of work — a deletion event that propagates on pull and prunes both caches — and
it is not in scope here, but the decision in §6 should be made knowing it does
not exist.

---

## 3. Is account deletion exposed at all?

**No. There is no path to it from any MemBridge surface.**

- No `auth.admin`, no `/auth/v1/admin`, no `deleteUser`, no service-role key
  anywhere in `lib/`, `bin/`, `ui/src/`, or `app/`. The single service-role
  credential in this codebase belongs to the Cloudflare ops worker and is used
  only for `ops_snapshot()`.
- No CLI subcommand. `membridge team` exposes
  `setup|create|invite|revoke-invite|join|link|unlink|list|repull|share-prompts|fingerprint|trust`
  and nothing that removes an account.
- No UI control. The Settings danger zone offers **Leave team** only.

**The only way to attempt it is the Supabase dashboard**, which means it takes
project-admin access and is not something a user can reach.

### A related gap found on the way, worth its own line

`POST /api/team/delete-my-data` exists in `lib/server.js` (and
`GET /api/team/my-entry-counts` beside it), backed by the `delete_my_entries`
and `my_entry_counts` RPCs, which are **live in production**. It is tested. It
works.

**Nothing calls it.** Grepped `ui/`, `lib/`, `bin/`, `app/` on `master` and on
`agent-removal`, `agent-sec`, `agent-ui2`, `agent-hunt`, `agent-backend2`: the
only hit anywhere is the route definition itself. The self-serve deletion
feature — the one whose migration argues at length about not stranding the
person most likely to want their data gone — is reachable only by hand-crafting
a request to the loopback daemon.

This is directly load-bearing for §6: **the "you can already delete your own
entries" answer is true at the API layer and false at the product layer.** If
the decision leans on it, that UI has to be built.

> **Routed to the UI lane.** Building the surface is theirs, not this lane's.
> What they need from here: the endpoint is `POST /api/team/delete-my-data`,
> it requires `confirm: "DELETE"` verbatim (400 otherwise), the preview to show
> first is `GET /api/team/my-entry-counts`, and both RPCs behind them are
> already live in production. `035`'s header specifies the confirmation
> semantics, including why the preview must count archived projects — a preview
> that under-reports the blast radius is worse than no preview.

---

## 4. Recommended action per constraint

Two rules run through all of these, and they are the same rule `050` states for
`team_audit`:

> **A row that records what someone did *to other people* must survive the actor
> erasing themselves.** Deleting your account must not be a way to unmake
> decisions imposed on colleagues.

> **`CASCADE` is never right on a NOT NULL `created_by`.** Both of them sit at
> the head of a cascade chain into every other member's data.

| # | Constraint | Recommended | Why |
|---|---|---|---|
| 1 | `teams.created_by` | drop NOT NULL → **SET NULL** | Cascading destroys the team, its projects, and **every member's entries** because a founder left. `created_by` is informational — nothing reads it for authorization — so nulling it costs a display detail and nothing else. Blocked on §4.1. |
| 2 | `projects.created_by` | drop NOT NULL → **SET NULL** | Identical shape one level down: cascade destroys every author's entries in that project. Same zero authorization impact. |
| 3 | `projects.archived_by` | **SET NULL** | Already nullable; one line. Keeps `archived_at` (the fact that matters) and forgets who did it. `050`'s header identifies this as the same change and defers it only to respect lane boundaries. |
| 4 | `memory_entries.author_id` | **NO CHANGE — this is the decision, see §5 and §6** | The one constraint whose correct behaviour is a policy question, not an engineering one. Left blocking on purpose: a refused deletion is better than a wrong one. |
| 5 | `project_access.updated_by` | **SET NULL** | Textbook case of the rule above: these rows are *about other people's access*. The grant must survive; the attribution may go. Already nullable. |
| 6 | `invites.created_by` | drop NOT NULL → **SET NULL**, plus revoke live invites in the deletion RPC | `CASCADE` is wrong — it erases who invited whom, and `use_count` records real joins. But a *live, unredeemed* invite with no accountable owner is a standing credential nobody owns, which is the hazard `044`/`045` exist to close for removal and leaving. `invites.revoked_at` already exists, so the deletion path should stamp it on the departing user's unredeemed invites and only then null the attribution. |
| 7 | `team_audit.actor_id` | **SET NULL — already specified as `050`, prerequisite, not duplicated here** | `050` argues this correctly and at length. `052` does not restate it; see §7. |

### 4.1 The prerequisite that is not a constraint: the last owner

> **This is not a follow-up. It ships with `052` or `052` does not ship.**
> `052` removes the constraint that is currently masking it, so applying `052`
> without this check is what converts a latent hazard into a live one.

Per §2.3, before *any* of this makes deletion possible, the deletion path needs a
guard that `leave_team` already has:

> **An account that is the sole `owner` of a team cannot be deleted until
> ownership is transferred.**

This must be a check in the deletion RPC, not a constraint — the FK that would
enforce it (`team_members.user_id` cascade) is the one causing the problem, and
it is correct for every other purpose. Refusing with "transfer ownership of
*Team X* first" is the right user-facing behaviour and matches the message
`leave_team` already produces.

### 4.2 The shape the feature needs, if it is built

The FK changes are necessary and not sufficient. Making deletion *work* means one
security-definer RPC that, in a single transaction:

1. refuses if the caller solely owns any team (§4.1);
2. applies the caller's choice for `memory_entries` (§5);
3. stamps `revoked_at` on their unredeemed invites (§4 row 6);
4. writes the `account-deleted` audit row **before** the account goes, since
   after it there is no `auth.uid()` to satisfy `team_audit_insert`'s
   `actor_id = auth.uid()` check;
5. only then calls the auth admin delete, which the FK changes now allow to
   succeed.

Ordering matters at step 4, and it is easy to get wrong: `team_audit_insert`
requires `is_team_manager(team_id) AND actor_id = auth.uid()`, so the record of
the deletion cannot be written by the deleted account afterwards, and cannot be
written by a plain member at all.

**Do not implement this as a `BEFORE DELETE` trigger on `memory_entries`.**
`040`'s header documents why: `memory_entries → projects → teams` all cascade, so
a trigger inserting into `team_audit` (whose `team_id` references the team being
deleted) fails its own FK and aborts team deletion entirely.

---

## 5. `memory_entries.author_id` — what breaks under each option

2,275 rows, 3 distinct authors. `author_id` is `NOT NULL`, is part of
`unique (project_id, author_id, ts, source)`, and sits beside `author_name`
(`text NOT NULL`) — a plaintext display name that **no foreign key can reach**.

That last point governs everything below: *any* option that changes only
`author_id` leaves the person's name on every row. A constraint change cannot
anonymise anything on its own.

### Option A — `ON DELETE CASCADE`

The entries die with the account.

- **For:** the cleanest erasure story, and it is consistent with `035`'s
  position that a member may remove their own writes.
- **Against, and it is serious:** it contradicts `029:312` and `033:156`, which
  both state that a departed member's contributions are never deleted. It
  destroys team knowledge as a side effect of an identity action. And it writes
  **no audit row** — `delete_my_entries` audits inside its own transaction, a
  cascade does not, and the trigger that would fix that is unsafe per `040`. So
  a 2,056-row deletion would leave no trace of having happened.
- **Also:** `count(distinct author_id)` feeds the contributor metrics in
  `ops_snapshot` (`020`, `022`); those counts drop retroactively.

### Option B — drop NOT NULL, `ON DELETE SET NULL`

Rows survive, the account link is severed.

- **For:** keeps team knowledge, removes the account reference. Mirrors the
  answer chosen for `team_audit` and `ops_audit.target_team`.
- **Against:** `author_name` still names them, so **this is not anonymisation
  unless `author_name` is scrubbed in the same transaction** — and the FK cannot
  do that. Shipping the FK change alone produces a half-anonymisation that
  reports success.
- **Against, mechanically:** the unique key `(project_id, author_id, ts, source)`
  stops deduplicating for nulled rows, because Postgres treats NULLs as
  distinct. Re-pushed history could duplicate against an orphaned row.
- **Against, in the UI:** the feed groups by author; every nulled row needs a
  rendering decision, and per `050`'s note it must not fall back to the stored
  name, or the deletion is cosmetic.

### Option C — leave it blocking; require an explicit prior step

The user chooses, before deletion, either to delete their entries
(`delete_my_entries`, already live and already audited) or to anonymise them
(a new RPC that nulls `author_id` **and** replaces `author_name`). Deletion then
proceeds because there is nothing left to block it.

- **For:** preserves both stated policies without contradiction — account
  deletion never destroys contributions by itself, and the member who wants
  theirs gone has an audited route that already exists. It keeps the destructive
  act deliberate, consented, and logged, rather than a side effect of a cascade.
- **Against:** it is the most work — it needs the anonymise RPC, the choice in
  the UI, and (per §3) the delete-my-data UI that was never built.
- **Against:** a user who simply presses "delete my account" and is then asked a
  question about their data may reasonably feel the product is negotiating with
  them.

### Recommendation

**Option C**, and `052` is written to be consistent with it: it fixes the five
uncontested constraints and deliberately leaves `memory_entries.author_id`
blocking, so that until the decision is made the system continues to *refuse*
rather than to do something irreversible and wrong. If §6 lands on A or B
instead, `052` is still correct and unchanged — only one extra statement is
added.

---

## 6. The GDPR-shaped question — stated, not resolved

**This is a product owner's decision. It is not resolved here and should not be
resolved by an engineer.**

There is a real, already-existing conflict in this codebase, and both sides are
argued rather than accidental:

> `029_materialize_project_access.sql:312` — "a departed member's CONTRIBUTIONS
> are never deleted."
>
> `033_enforce_project_access_on_write.sql:156` — "a departed member's
> contributions are deliberately never deleted. Removing them would be a data
> write with a completely different risk profile."

against:

> `035_delete_own_entries.sql` §1 — the delete policy is scoped on `author_id`
> **alone**, deliberately omitting the membership and project-access checks that
> every other policy on that table carries, because ANDing either one in "would
> strand exactly the person most likely to want their data gone" — someone who
> just left the team, or whose access was revoked.

`029`/`033` protect the team's shared knowledge from evaporating when people
leave — which is the entire product thesis. `035` protects the individual's
ability to withdraw what they wrote — which is the thing a data-subject request
actually asks for. Both are right about the thing they are looking at. Account
deletion sits exactly on the seam.

### What each option means for the erasure question

| | Erasure story | Team knowledge | Consistency with existing policy |
|---|---|---|---|
| **A — cascade** | Strongest on the server. Entries genuinely gone. | Team loses the departed member's history, retroactively, with no audit record of the loss. | Contradicts `029` and `033` head-on. |
| **B — set null** | Weak unless `author_name` is scrubbed too. The FK alone leaves the name in place. | Preserved in full. | Consistent with `029`/`033`; consistent with the `team_audit`/`ops_audit` precedent. |
| **C — explicit choice first** | As strong as the user asks for, and audited either way. | Preserved unless the user chooses otherwise. | Consistent with all three, which is the reason to prefer it. |

### The four facts the decision has to be made against

1. **No database option reaches teammates' laptops** (§2.4). Whatever is chosen,
   a truthful deletion notice cannot currently claim the data is gone from
   colleagues' machines. Either the wording accounts for that, or deletion
   propagation gets built.

2. **`author_name` is outside every option's reach.** Only an `UPDATE` removes
   it, and on `team_audit` that `UPDATE` is on a table `024`/`025` designed to be
   append-only. `050`'s header is blunt about the equivalent case: set-null "is
   not erasure", and "anyone reading this file for GDPR assurance should read
   this paragraph as the answer: it is not sufficient."

3. **Audit logs are commonly retained under a lawful basis separate from the
   account**, which is a defensible reason for `team_audit` rows to outlive the
   account with the actor anonymised. That argument covers `team_audit` and
   `project_access` comfortably. It does **not** obviously extend to 2,000 work
   summaries in `memory_entries`, and stretching it there would be the weak
   point in any position built on it.

4. **Nobody is asking yet.** No customer-facing commitment to deletion exists —
   grepped `README.md`, `CHANGELOG.md`, and `docs/`: no GDPR, erasure, deletion,
   or retention promise anywhere. *(The privacy copy on membridge.app lives in a
   separate repo and was not checked; if it promises deletion, that changes the
   urgency and should be checked before this is scheduled.)*

Point 4 is why this is a "decide it properly" item and not a fire.

---

## 7. The migration

`supabase/migrations/052_account_deletion_fk_actions.sql` — written, committed,
**not applied, and not cleared to apply.**

It implements §4 rows 1, 2, 3, 5 and 6: the five constraints where the correct
behaviour is not in dispute. It deliberately does **not**:

- **touch `memory_entries.author_id`** — that is §6's decision, and until it is
  made, blocking is the safe state;
- **restate `team_audit.actor_id`** — that is `050`, on `agent-removal`, already
  written and already argued. `052` declares it a prerequisite rather than
  reaching into another lane's file. `050`'s own header makes this the rule.
- **add the deletion RPC, the last-owner guard, or any UI** — §4.2 specifies the
  shape; building it is a separate ticket, gated on §6.

### Registry

`052` is the next free number per `supabase/APPLY-RUNBOOK.md` on `agent-sec`
(037–051 claimed; the table reads "Next free number: 052"), read before the file
was written. **The runbook does not exist on `master` and so could not be
amended from this branch.** Whoever merges `agent-sec` must add the row:

```
| 052 | Account-deletion FK actions on five uncontested constraints | `agent-deletion` | no |
```

and move next-free to 053. Until that row exists,
`test/suites/migration-state.test.js` (which also lives only on `agent-sec`)
will fail `052` on the unclaimed-number gate. That is the gate working; it is
not a bug in this file.

### Order

If both are applied, `050` before `052` is tidier but not required — they touch
different constraints and neither depends on the other. `052` is re-runnable, per
the convention every migration in this tree follows.

---

## 8. The soft-delete blind spot — specification

**Investigation and specification only. Nothing was built.** This is the ticket
§2.2 opened. It is separable from the constraint work: none of it depends on
`052`, and `052` does not depend on any of it.

### 8.1 Why soft delete always succeeds

Supabase exposes two deletions. The hard one removes the `auth.users` row and
runs into all seven constraints in §1. The soft one sets
`auth.users.deleted_at` and **leaves the row**, so no foreign key is ever
evaluated. There is nothing for it to fail on. It succeeds for every account in
every state, including the three in §1 that hard delete correctly refuses.

`auth.users.deleted_at` exists on this instance and is currently null for all
five accounts, so **no account has been soft-deleted yet**. This is a hazard to
close, not damage to repair.

### 8.2 Can the backend even tell us? No — and the reason is structural

> **`deleted_at` is unreachable from the app today. Surfacing it requires a
> backend change. There is no client-side fix.**

Three independent confirmations, all from the live catalog:

1. **No role holds any privilege on `auth.users`.** `information_schema.role_table_grants`
   for `auth.users` returns **zero rows** — not `anon`, not `authenticated`, not
   `service_role` by table grant. The table belongs to `supabase_auth_admin`.
2. **PostgREST does not expose the `auth` schema.** Only `public` is exposed, so
   there is no REST path to the column even with a privilege.
3. **Not one function or view in `public` reads `auth.users`.** Every identity
   function was dumped and read: `team_members_list`, `team_role`,
   `is_team_member`, `is_team_member_uid`, `team_feed`, `create_team`,
   `redeem_invite`, `remove_member`, `leave_team`, `my_entry_counts`,
   `delete_my_entries`. All of them read `public.team_members` or
   `public.memory_entries`. `public` has exactly one view (`project_stats`) and
   it does not touch `auth` either.

**Identity in this product is fully denormalised into `public`.** `auth.users`
is referenced by seven foreign keys and read by nothing. That is why the flag
cannot leak through by accident — and equally why it can never arrive without
someone deliberately plumbing it.

### 8.3 Surface inventory — what renders identity, and what a soft-deleted account does at each

| Surface | Where identity comes from | What a soft-deleted account does today |
|---|---|---|
| Team roster (Settings → Team) | `team_members_list` → `public.team_members` | listed as a current member, with role |
| Access matrix | `lib/api-access.js:150` `display_name` | still a grantable/revocable row |
| Insights, silent-teammate cards | `lib/api-insights.js:247` | **"Nothing has arrived from *X*"** — nags a manager about a person who does not exist, and inflates `otherCount`, skewing every other card's severity |
| E2E key sealing | `lib/teamsync.js:720` `fetchMemberPubkeys` → `team_members_list` + `member_pubkeys` | **every new key epoch is sealed to their public key** |
| Key trust pins | `lib/teampins.js:63` | pin retained; no alert, no change |
| Feed / activity cards | `memory_entries.author_name` via `team_feed`, `lib/feed.js:153` | their name on every entry |
| MCP `search_memory`, `get_recent_activity` | `lib/mcp.js:131` `author` | attributed to them |
| MCP `why` / provenance | `lib/provenance.js:110,116` `who` | attributed to them |
| Day digest | `lib/digest.js:664,903,1152` | grouped under their name and id |
| Teammate-notes injection | `lib/teammate-notes.js:69` `author_name` | their decisions injected into every agent session, indefinitely |
| Ops panel | `ops_snapshot` `count(distinct author_id)` | counted as a contributor |

**The inventory splits cleanly in two, and the split is the whole design.**

- **Rows 1–5 are present-tense claims** — "this person is on your team", "this
  person owes you activity", "encrypt the next key to this person". Every one of
  them is *wrong* about a deleted account, and no reasonable reading makes them
  right. **All five derive from `team_members_list`.**
- **Rows 6–11 are historical attribution** — "this person did this work". None
  of them is factually wrong. Whether they *should* change is the §6 question.

### 8.4 What "honouring `deleted_at`" should mean, per surface

**Not one rule. Two, and the boundary between them is the point.**

#### The present-tense set — unambiguous, and one of them is urgent

| Surface | Should be | Why |
|---|---|---|
| **E2E key sealing** | **exclude — urgent** | Not a display question. The re-seal loop iterates `allowed`, derived from `team_members_list`, and seals the team key to every member's pubkey. A soft-deleted account keeps receiving a sealed copy of **every future epoch**. Offboarding someone this way keeps handing them the keys. |
| Team roster | hide | A deleted account is not a teammate. Nothing else is defensible. |
| Access matrix | hide the row | It is a control surface. Granting project access to a deleted account is meaningless, and the row invites an admin to try. |
| Insights silent-teammate | exclude from the population | Today it generates a problem card naming a nonexistent person, with an action of `null` because nothing can fix it. It also counts toward `otherCount`, so it distorts the severity of every other card. |
| Key trust pins | drop the pin, stop alerting | The pin exists to detect key *changes* for a live member. |

The key sealing row is the reason this ticket is worth doing ahead of the rest
of account deletion: it is the one place where the blind spot has a **security**
consequence rather than a cosmetic one.

#### The attribution set — the same decision as §6, and it must be answered once

Rows 6–11 attribute work. Erasing a name from work someone did is **not
obviously better** than leaving it: an entry that suddenly has no author is a
different kind of wrong, and the team loses the ability to ask who to talk to.
This collides head-on with the conflict in §6 — `029`/`033` say a departed
member's contributions are never deleted; `035` says the person may erase their
own.

The options are the same three, and **they should be resolved once for §6 and
§8.4 together, not separately**, or the product will say two different things
about the same person:

- **Leave attribution intact.** Consistent with `029`/`033`. Weakest erasure.
- **Replace the name with a neutral label** (e.g. "a former teammate"). Requires
  an `UPDATE` to `memory_entries.author_name` — no foreign key reaches a text
  column — on tables `024`/`025` designed to be append-only.
- **Remove the rows.** Strongest erasure, destroys team knowledge, and per §5
  writes no audit record of the loss.

**Not resolved here.** Deliberately.

#### One that is neither

**Ops-panel contributor counts** are historical aggregates describing a window
when the person *was* active. Recomputing them to exclude a since-deleted
account would retroactively falsify a past period. Recommend leaving them, and
flagging it rather than deciding it silently.

### 8.5 What surfacing it required — BUILT

> **Status: built on `agent-deletion`.** `supabase/migrations/053_team_members_list_deleted_at.sql`
> (written, **not applied** — hand it to a human) plus the client filter in
> `lib/teamsync.js` (`activeMembers`) wired into all nine present-tense call
> sites. Unlike `052`, `053` needs no decision and should ship with the next
> batch. **Attribution was left untouched, deliberately — §8.4 is still open.**
>
> **One change from the spec below, recorded rather than glossed:** the RPC
> returns the **timestamp**, not a derived boolean. That discloses *when* an
> account was deleted to every team member, which the boolean would not. The
> reasoning for preferring the raw fact, and the two-line change to switch back,
> are in `053`'s header §3.

**The leverage is that all five present-tense surfaces go through one
function.** Roster, access matrix, Insights, key sealing and trust pins every
one of them calls `team_members_list`. Teaching that single RPC about deleted
accounts reaches all five.

```
-- As built. Full header, including the four traps below, is in
-- supabase/migrations/053_team_members_list_deleted_at.sql.
create or replace function public.team_members_list(p_team uuid)
returns table (user_id uuid, display_name text, role text,
               joined_at timestamptz, deleted_at timestamptz)
...
  select m.user_id, m.display_name, m.role, m.joined_at, u.deleted_at
    from public.team_members m
    left join auth.users u on u.id = m.user_id
   where m.team_id = p_team and public.is_team_member(p_team)
```

Four constraints on that change, each of which is a way to get it wrong:

1. **It must be `security definer`.** It already is. That is what lets the body
   read `auth.users` when the caller has no privilege on it (§8.2). The existing
   `is_team_member(p_team)` predicate in the body must stay — definer means RLS
   does not apply automatically, which is the trap `035` §2 documents.
2. **Boolean vs timestamp — built as the timestamp.** A derived
   `account_deleted` answers the only question any caller asks today;
   `deleted_at` additionally discloses *when*, to every member of the team.
   Built as the raw timestamp on the grounds that it is the durable fact and a
   derived flag would have to be re-derived if anything ever needs the date.
   If the disclosure is unwanted the change is two lines — `053` §3 names them.
3. **`left join`, not `join`.** An inner join would silently drop any member
   whose `auth.users` row is genuinely gone once `052` and a real deletion path
   exist — turning a display bug into a member vanishing from the roster.
4. **Adding a column to a function's return type requires `drop function`
   first**, and every client reading the old shape keeps working (extra columns
   are ignored), so the migration is safe to apply before the client ships —
   the opposite of the `038`/`044`/`045`/`046` ordering gate.

The attribution surfaces (rows 6–11) are **not** reachable this way: they read
`author_name` off `memory_entries`, which never joins `auth.users`. They need
whatever §8.4 decides, applied to the data rather than to a lookup.

### 8.6 Should soft delete be used at all? No — and there is a better button

> **Recommendation, plainly: do not soft-delete any account, for any reason,
> until §8.4 and §8.5 are closed. There is no case today where it is the right
> action.**

The argument is short. Hard delete refuses — loudly, safely, recoverably. Soft
delete succeeds and leaves the product asserting five things that are false,
with no error, no log line and no test anywhere that could catch it. Choosing
the one that silently produces a wrong state over the one that safely produces
no state is never the better trade.

**And the operation people actually want already exists.** If someone must be
offboarded now, the supported path is **remove them from the team** —
`remove_member`, exposed in the app — which does what soft delete only appears
to do:

| | Soft delete | `remove_member` |
|---|---|---|
| Roster | still listed | **gone** |
| Access matrix | still a row | **gone** (`project_access` cascades from `team_members`) |
| Insights nags their manager | **yes** | no |
| Receives future team keys | **yes** | **no** — the re-seal loop reads `team_members_list` |
| Invite code rotated behind them | no | yes, once `044` is applied |
| Can sign in | no | yes, to their own account |

The only thing soft delete adds is blocking sign-in, and it buys that by making
five other things wrong. If blocking sign-in is genuinely required as well, do
**both** — remove from the team first, then soft delete — so the product state
is correct regardless of what the auth flag does.

Two caveats on `remove_member`, both pre-existing and neither introduced here:

- **It refuses to remove an owner** (`'the team owner cannot be removed'`).
  Same shape as §4.1, and the same answer: transfer ownership first.
- **It does not delete their `team_keys` rows**, so they retain the ability to
  open *past* epochs they were already sealed into. That is expected and is why
  `044`/`045` rotate the invite code and why `membridge team rekey` exists. The
  property that matters is the forward one: they receive no new epoch.

### 8.7 What this does not fix

Nothing in §8 reaches teammates' local caches — see §2.4. A soft-deleted or
removed member's already-pulled entries stay in every teammate's `state.json`
and `teammate-notes.json`, and keep being injected and searched with no network
call. §8 makes the *backend's* answer honest. The local caches are a separate
and larger piece of work.
