# Needs Marco

Everything from 2026-08-05 that no agent can do, in one place, ranked by what
happens if it is never done. Written for deciding **what to spend an hour on**,
not for executing — the runbooks cover execution and are linked, not repeated.

Some of these will come back clean. Where that is likely, it says so. A list
where every item is a problem trains you to stop reading it.

**Where an item came from another lane, it says so.** Items marked *(hunt)* are
from the security audit; others are that lane's finding, consolidated here.

---

## 1. Confirm the ops Worker has no `*.workers.dev` route *(hunt)*

**What it is.** The ops panel's Worker holds the one credential that bypasses
every database protection in the product. Its first line of defence is that the
only way to reach it is a hostname sitting behind Cloudflare Access. That
depends on `workers_dev = false` actually being true on the deployed Worker,
which I could not check — the Cloudflare tooling needs an interactive login this
session cannot do.

**What it protects.** If a `*.workers.dev` URL exists alongside the protected
hostname, anyone who finds it reaches the Worker without passing Access at all,
and the first layer is decoration. The Worker's own JWT check still stands —
that one is real and I tested it — so this is a defence-in-depth question, not
an open door.

**If never done.** You keep a security property you believe you have and have
never confirmed. That is the same shape as the migration headers that said
UNAPPLIED for four releases: not wrong on purpose, just never checked.

**Likely outcome: fine.** `workers_dev = false` is in the config and has been
since it was written. This is confirming, not investigating.

**Time: 5 minutes.** Cloudflare dashboard → Workers → `membridge-ops-api` →
Settings → Domains & Routes. You want to see the `ops.membridge.me/api*` route
and **no** `workers.dev` entry.

While you are there, two more from the same audit, same 5 minutes:
- **Is `SUPABASE_SERVICE_KEY` stored as a Secret, not a plaintext Variable?**
  Secrets are write-only in the dashboard; a Variable shows its value to anyone
  with dashboard access. Same screen, Settings → Variables.
- **What does the Access policy actually admit?** The Worker has its own email
  allowlist as a second gate, but that allowlist has a bug (item 4), so right
  now the Access policy is doing more work than intended.

---

## 2. Lock down the site repo — it is the trust anchor for every install *(hunt)*

**What it is.** `membridge.app/install.sh` is what the documented install command
runs and what the desktop app runs when someone clicks "Install and restart". It
carries a pinned checksum for the app download, so tampering with the GitHub
release alone does not work — the installer refuses. But the checksum is served
by the same host as the script naming it. **Whoever can change what
`membridge.app` serves can install anything on every user's machine.**

That content deploys from `mmelika/membridge-site`, branch `main` — a personal
repo, separate from the org that holds the code. I could not check its branch
protection or who has write access.

**What it protects.** Every install and every update, for every user. This is
the widest blast radius in the product. An attacker on the network cannot touch
it (TLS), and a GitHub compromise alone cannot either (the checksum refuses) —
but site control is total and immediate.

**If never done.** A single compromised account — the personal GitHub account,
or a Cloudflare Pages token — ships arbitrary code to everyone, and nothing in
the product would notice.

**Worth knowing:** the split between the site repo and the code repo is
currently *accidental* defence in depth. It works because an attacker needs both.
Making that deliberate — writing down that the two must stay separately
controlled — is most of the value here.

**Time: 20 minutes.** Turn on branch protection and 2FA-required on the site
repo, check its collaborator list, and check who holds Cloudflare Pages deploy
access. Consider moving it into the `MembridgeAi` org so it inherits the same
controls as the code.

---

## 3. Apply the pending SQL

**What it is.** Eleven migrations are written, reviewed and waiting. They close
real gaps found today: project access scoped to the right team, invite
redemption that cannot be raced, an audit timestamp the writer cannot forge,
removal that actually revokes the standing invite code.

**The runbook is [`supabase/APPLY-RUNBOOK.md`](../../supabase/APPLY-RUNBOOK.md)
(on `agent-sec`). Follow it, not this page.** It has the order, the risks and
the checks, and it is written for someone who was not in the sessions.

I am deliberately not repeating the apply order here. Two copies of an order
is how two orders come to disagree, and this repo has already had one version
number wrong in four places at once for four releases.

**One thing worth knowing before you sit down:** these must be pasted into the
Supabase SQL editor, never `supabase db push`. Only 2 of 30-odd migrations are
recorded as applied, so a push would try to re-run everything.

**If never done.** The fixes exist only as files. Every finding they close stays
open in production, and the gap between "the repo says this is fixed" and "the
database does this" keeps widening — which is the exact confusion that took a
chunk of today to clean up.

**Time: 45–60 minutes** for all eleven, in one sitting, following the runbook.

---

## 4. Two one-line code fixes that are yours to approve, not ours to guess

Both are found-and-pinned, not fixed, because they are product code.

**The ops Worker's email allowlist fails open** *(hunt)*. If the
`ALLOWED_EMAILS` variable is ever empty or unset, the check does not refuse —
it stops running, and anyone Access admits gets in. The fix is deleting two
words. It matters because that allowlist is the layer meant to survive an
over-broad Access policy, so it and item 1 are the same question from two sides.

**The RLS guardrail has a hole in its own filter** *(hunt)*. Migration `031`
makes it impossible to create a database table without row-level security — and
as written it skips one kind of table entirely, silently, with no error. That is
worse than the permissive version it replaces, because it reads as protection.
One line, and it must be fixed **before** `031` is applied. It is flagged in the
runbook and in the file's own header, so this should not surprise you — but it
is the one item in the SQL batch that is not just "paste it".

**Time: 10 minutes** for someone to make both changes; the decision is yours.

---

## 5. One real sync against a live backend *(backend lane)*

**What it is.** The team pull now pages through history using a query shape that
has only ever run against the test mock — a nested filter of the form
`or=(created_at.gt.X, and(created_at.eq.X, id.gt.Y))`. The mock was written by
us and answers what we expect; real PostgREST may parse that nesting or its URL
encoding differently.

**What it unblocks.** Confidence in the fix for a real bug: pulls were paging on
timestamp alone, so entries sharing a timestamp could be skipped or repeated.

**If never done.** It probably works — this is a normal PostgREST idiom. But
"probably" is doing the work, and the failure mode is silent: a pull that quietly
drops rows looks exactly like a teammate who was not busy that day.

**Time: 15 minutes.** One machine, linked to a real project, one sync pass, then
confirm the entries pulled match what the backend holds. Staging if there is one;
otherwise a throwaway project on the live backend is fine, since this is a read.

---

## 6. Product decisions that are yours, not ours

None of these are bugs. They are choices we should not make on your behalf, and
each is currently sitting at a default nobody chose deliberately.

**Should the injected memory block move out of the tracked file?** *(revoke
lane)* Today it is rewritten inside `CLAUDE.md`. Moving it out would stop it
churning a tracked file — but non-Claude tools read only that file, so they would
get a worse experience. The trade is: cleaner git history for Claude users,
degraded context for Codex and the rest. **You have to decide who eats it.**

**Should the block show what it costs?** *(revoke lane)* The injected context has
a measurable token price on every session. Showing it is honest and might make
someone turn it off; not showing it means the cost is invisible. There is also a
"when" question — always, or only when it crosses some threshold.

**Should invite links default to single-use?** *(hunt + removal lane)* Right now
every invite the app creates never expires and has no use limit, because the UI
offers no way to set either. That is not a bug — it is a default nobody picked.
Single-use-and-expiring is safer; unlimited is friendlier for a team that wants
one link in a Slack channel. **Genuinely your call**, and the UI needs a small
change either way.

---

## 7. Lower priority, real, nobody's yet

- **`onboarding_invites`, `ops_audit` and `ops_team_meta` still carry the
  default wide-open table grants** *(hunt)*. They are protected today only by
  having zero access rules, which denies everything. That is a single property
  standing between unredeemed invite tokens and anyone with the public API key.
  The fix is one line per table, matching what was already done for a fourth
  table. **Covered by migration `043` in the runbook**, so item 3 closes this.

- **The installer's first line says it installs "the signed, notarized app"**
  *(hunt)*. Nothing in it checks a signature, and because the download comes via
  `curl`, macOS never evaluates the notarization either. The checksum is the only
  integrity check that actually runs. Not a hole — but the sentence describes a
  verification that does not happen, and someone reasoning from it would
  over-trust the path. **Worth a wording fix, not an engineering one.**

- **`EXCLUDE_TEAMS` in the ops Worker config does nothing** *(hunt)*. It is
  documented, has a comment explaining its purpose, and is never read — the code
  passes an empty list. So your own dogfooding teams are in every business
  figure on the ops panel. Cosmetic, but it means the numbers you look at are
  not the numbers you think you are looking at.

- **The ops panel lives on `ops.membridge.me`** *(hunt)*, the domain the product
  otherwise moved off. It works today. If anyone ever widens the
  `membridge.me → membridge.app` redirect to cover subdomains, the panel breaks.
  Worth knowing before that redirect is touched, not worth acting on now.

---

## What is NOT on this list, and why

The database's access rules were audited end to end today and **no table is
missing row-level security**. The daemon's local web surface was audited and **no
vulnerability was found** — it is the best-defended part of the product. Both
results are recorded as passing tests so they stay true. Neither needs anything
from you.

---

*Compiled 2026-08-05 from six lanes. Items marked (hunt) are from the security
audit on `agent-hunt`; the rest are consolidated from other lanes' branches and
committed docs. Three Cloudflare items could not be verified from an agent
session because that dashboard needs an interactive login — they are listed as
questions to answer, not as known problems.*
