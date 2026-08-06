# Needs Marco — deletion lane's two items

**These belong in `claude/ops/NEEDS-MARCO.md`, which lives on `agent-hunt` and
does not exist on this branch.** Writing it here would create a merge collision
with the canonical file rather than adding to it, so the items are staged in
their own file instead.

**Whoever merges: append both as items 8 and 9** (the canonical file runs 1–7,
then a "What is NOT on this list" section — these go before that section), and
delete this file. They are written in that file's format and voice so they can
be moved without editing.

Full reasoning for both: `docs/ACCOUNT-DELETION.md`, §8 and §4.1.

---

## 8. Do not soft-delete a user — and one decision that unblocks the fix *(deletion)*

**What it is.** Deleting a user account has never worked: seven foreign keys
point at `auth.users` and none says what to do when the account goes. The
dashboard's normal delete hits them and **refuses**, which is safe. The
dashboard's **soft delete** succeeds every time, because it leaves the account
row in place and so touches nothing.

**And nothing in MemBridge reads the flag it sets.** `auth.users.deleted_at`,
grepped across `supabase/`, `lib/` and `ui/src/`: zero hits. Not one function,
policy, view or client. The account is deleted in the auth system and entirely
present in the product.

**What it protects.** Five things stay wrong after a soft delete, and one of
them is not cosmetic:

- they stay on the team roster and in the access matrix;
- Insights keeps telling their manager "nothing has arrived from *X*";
- **every new team encryption key keeps being sealed to their public key** —
  offboarding someone this way keeps handing them the keys forward.

The only thing that actually changes is that they cannot sign in.

**If never done.** Nothing breaks today — `deleted_at` is null on all five
accounts, so this has not happened yet. It is a hazard to close, not damage to
repair. But it is one click from the button that correctly refuses, and if it is
ever clicked **nothing in our code will go red**, because the false claim is
made by Supabase's UI and not by ours. Somebody doing the responsible thing gets
a screen that says done and a product where nothing happened.

**The operational half costs nothing and should be done now: tell whoever holds
the dashboard to use "Remove from team", never soft delete.** `remove_member`
already does what soft delete only appears to do — off the roster, out of the
access matrix, no Insights nag, and no future keys. It does not block sign-in;
if that is also needed, do both, in that order.

**Your call, not ours.** The engineering fix is specified (`docs/ACCOUNT-DELETION.md`
§8.5 — one `security definer` function change reaches all five surfaces, because
they all go through `team_members_list`). What is **not** ours to decide is what
should happen to a deleted person's *name on work they did* — the feed, the MCP
answers, the digests, the notes injected into every agent session. Erasing it is
not obviously better than keeping it, and it is the same conflict already in the
tree: two migrations say a departed member's contributions are never deleted
(`029`, `033`), a third deliberately lets a member delete their own (`035`). It
should be answered **once**, for that and for account deletion together, or the
product will say two different things about the same person.

**Time: 2 minutes for the operational half** (one message to whoever has
dashboard access). The decision is a sit-down; §8.4 and §6 lay out the three
options and what each costs, and neither picks one.

---

## 9. `052` must not ship without the last-owner check *(deletion)*

**What it is.** Not a decision — a sequencing fact that needs to be visible
before someone applies a migration in isolation.

`team_members.user_id` is `on delete cascade`, so deleting an owner's account
removes their membership row. That is precisely what `leave_team` refuses to do
in so many words: *"the owner cannot leave their own team"*. Because
authorization runs off `team_members.role` and not `teams.created_by`, the
result is a team with **no owner** — no invites, no removals, no access changes,
no audit reads, for anybody, permanently.

**What it protects.** Today this cannot happen, because `teams.created_by`
blocks the deletion first. **`052` removes exactly that block.** So applying
`052` without a last-owner guard in the deletion path is what converts a latent
hazard into a live one.

**If never done.** A team can be orphaned with no way back short of direct
database surgery. Note this is only reachable once a deletion path exists at all
— there is none today (no auth-admin call, no CLI command, no UI anywhere), so
this is a prerequisite to schedule, not a live exposure.

**Likely outcome: fine, if it is read.** The guard is a check in the deletion
RPC — refuse while the account solely owns any team, and say which one, matching
the message `leave_team` already produces. It is written up in
`docs/ACCOUNT-DELETION.md` §4.1 and §4.2, and stated again in `052`'s own header
so it cannot be missed by someone applying the file without the doc.

**Time: nothing to do now.** This exists so that `052` is not applied as a
standalone tidy-up. It ships with the deletion feature, or it does not ship.
