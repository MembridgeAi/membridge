# Account deletion — findings and spec

**Status: investigation and specification. Nothing here has been applied to any
database, and no product code has been changed.** The one migration this spec
proposes (`supabase/migrations/052_account_deletion_fk_actions.sql`) is written
and committed, and is explicitly *not* applied and *not* cleared to be applied.
It waits on a decision that belongs to the product owner, laid out in §6.

Every constraint fact below was read from the **live catalog**, read-only, on
2026-08-05 — not from `supabase/schema.sql`, which describes intent rather than
production. Where a claim could not be established without writing to the live
database, it is marked as such and the safe way to settle it is named.

---

## For the product owner, in plain language

**Nobody can delete a MemBridge account today, and nobody has ever been able
to.** Three separate things are true and they matter in different ways:

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

3. **There is one way to make a real mess, and it is the button the dashboard
   offers next to the other one.** Supabase can "soft delete" an account
   instead. That succeeds — it dodges all seven blocks by leaving the account
   row in place. But nothing in MemBridge looks at the flag it sets, so the
   person still appears as a live teammate, their name still sits on every entry
   they shared, and they simply can no longer sign in. It looks like deletion
   and it is not. **This is the one thing to tell whoever has dashboard access
   not to click.**

There is also a fourth thing, which is the part that no database change can fix
and which the decision in §6 has to account for: **MemBridge copies shared
memory onto every teammate's laptop.** Deleting something from the server does
not reach those copies, and there is no mechanism today that would. So "we
deleted your account" can never honestly mean "your work is gone from your
colleagues' machines" without building something that does not exist yet.

The decision this spec needs from you is in §6. It is a genuine conflict already
present in the codebase — two migrations say a departed member's contributions
are never deleted, a third deliberately lets a member delete their own — and
account deletion sits on top of it. I have laid out what each answer costs. I
have not picked one.

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
operation that correctly refuses.

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
