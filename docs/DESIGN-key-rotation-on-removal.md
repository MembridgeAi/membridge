# Should removing a member force a team key rotation?

Status: **open — Marco decides.** Nothing in this note is implemented.
Raised by ticket REM-3 (agent-removal lane, 2026-08-05). Related work that
IS implemented on `agent-removal`: migration 041 closes the re-join half of
this problem.

## What is true today

`remove_member` (`supabase/migrations/002_team_v2.sql:179`, restated in
`041_removal_rotates_invite_code.sql` §1) deletes one `team_members` row.
It does not touch `public.team_keys`, and there is no path that does:

* `team_keys` rows are immutable by design — 009 gives the table no UPDATE
  policy, and 016's `team_keys_delete_own` lets a member delete only rows
  addressed to **themselves** (`supabase/migrations/016_multidevice_keys.sql:29`).
  No remaining member can delete a departed member's sealed rows, and no
  manager can either.
* The FK `member_user_id references auth.users (id) on delete cascade`
  (009 §2) fires on deletion of the **auth user**, never on removal from a
  team. Removing someone leaves every row they were ever sealed intact.
* Rotation is lazy and push-driven. `resolveTeamKey`
  (`lib/teamsync.js:534-543`) mints epoch **N+1** the next time a remaining
  member pushes and notices that the current epoch holds a row for someone
  no longer on the roster. Until that push happens, new content keeps going
  out under the epoch the removed member can open.
* Old epochs stay readable on purpose — that comment is at
  `lib/teamsync.js:541`. It is what makes history recoverable for a member
  who changes devices.
* A manager can force it now: `membridge team rekey`
  (`lib/teamsync.js:2179`, `bin/membridge.js:925`) mints a new epoch
  immediately. It is forward-only and manual, and nothing tells an admin to
  run it after a removal.

Net: a removed member keeps decrypting **everything they ever synced**, and
until 041 they could also re-join and be sealed into the new epoch by the
join-seal path. 041 closes the re-join half, and 042 closes it for a
voluntary departure too. This note is about the other half.

Read "removed" below as "departed": everything here applies identically to
someone who leaves of their own accord, and after 041 §2 an admin who
resigns is the role most certain to be holding team credentials. The
resignation case is arguably the more likely one — nobody schedules it, and
it produces no `member-removed` row for anyone to notice.

## The part no design can fix

Whatever we do server-side, the removed member has already decrypted the
history on their own machine. Their local `~/.membridge` cache, their
`state.json` team rows, and anything the injected CLAUDE.md block put in
front of a model are all plaintext on disk they control. **No key rotation
retracts data that has already been read.** Every option below is about
what they can decrypt *from now on*, not about what they already have.

Say this plainly wherever the product says "removed" — otherwise removal
reads as a revocation it is not.

## Options

### A. Leave it (status quo + 041)

Rotation stays lazy; removal only kills the join credential.

* Cost: between the removal and the next push by a remaining member, new
  content is still readable by the person removed. On a quiet team that
  window is days. There is no alarm and no visible state saying "this team
  is still on the epoch your ex-teammate holds".
* Benefit: nothing to build; no new failure mode.
* Honest framing needed: the UI must stop implying removal cuts off access
  to content.

### B. Force rotation at removal time, from the removing manager's client

The daemon calls `rekeyTeam` right after `remove_member` returns.

* Cost: the removal HTTP call now depends on the manager's crypto identity
  and on TOFU trust state. `rekeyTeam` seals only to members whose keys are
  **pinned/trusted** (`lib/teamsync.js:2202`) — so on a team with any
  unverified member, a forced rotation *pauses that member's pushes* until
  someone trusts them. Removal would start breaking bystanders.
* Cost: it can fail (no identity on this device, backend blip) after the
  membership delete has already committed. Two-step, non-atomic, and the
  failure leaves the team in exactly state A while the UI says "removed".
* Benefit: closes the window immediately in the common case.

### C. Rotate server-side (new epoch minted by the backend)

Rejected on inspection, recorded so nobody re-derives it: the backend never
sees the team key. Epochs are minted client-side and sealed per member with
`crypto_box_seal` against member public keys. A server-side rotation would
require the server to hold or mint key material, which is the entire
property E2E exists to avoid.

### D. Make the stale epoch visible, and prompt

Do not rotate automatically. Record the removal, detect at sync time that
the current epoch has a row for a non-member, and surface it: a banner on
the Team page and a line in the audit trail — "this team's content is still
encrypted under a key <name> can open; rotate now".

* Cost: a manual step, and a team that ignores it is in state A.
* Benefit: no bystander is paused as a side effect of someone else's
  removal; the manager chooses the moment; the state stops being invisible,
  which is the actual defect. The detection already exists — it is the same
  predicate `resolveTeamKey` uses at `lib/teamsync.js:538` — it is just not
  surfaced anywhere.

### E. Delete the removed member's `team_keys` rows

Worth naming because it is the intuitive move and it does nothing. Deleting
their sealed rows removes their ability to *fetch* the key from the backend;
it does not remove the key from the machine that already unsealed it. It
also needs a new DELETE policy (016's is self-only), and it would break the
audit property that `team_keys` is append-only.

Only useful in combination with a rotation, as tidying.

## Recommendation to weigh

**D, plus honest copy.** It fixes the property that is actually broken —
the state is invisible — without making one member's removal a cause of
another member's outage, which is what B risks on any team with an
unverified key. B becomes safe only once every member's key is pinned, and
that is not a state the product can assume.

## What would need deciding

1. Does "removed" have to mean "cannot decrypt new content from this
   instant", or is "from the next sync" acceptable?
2. Is it acceptable for a removal to pause an unrelated member's pushes
   (the TOFU cost of B)?
3. Should already-synced history be re-encrypted under the new epoch? That
   is a bulk rewrite of `memory_entries` and a separate, much larger piece
   of work — and it still does not retract what was read.
