# MemBridge 0.4.0

_Previous release: 0.3.4. Master at time of writing: `a4754a3`. 69 commits._

This release is mostly about **making the product's claims true**. Several things
MemBridge said it did — refuse plaintext, honour a declined consent, forget what
you deleted, count tokens — it did not reliably do. Most of what follows is
closing those gaps rather than adding surface.

---

## Read this first: the savings comparison restarts

**If you have been running MemBridge for weeks and watching a savings figure, that
comparison resets to zero when you upgrade. Nothing is wrong. The old number was
measured with a method we no longer trust.**

Two things were wrong with how savings were measured before 0.4.0:

1. **The control group was contaminated by construction.** The holdout — the
   sample where MemBridge deliberately withholds context so it can measure the
   difference — was assigned **per read** rather than per session. The same
   session could land in both arms, so the two arms were not independent and the
   difference between them did not mean what it claimed to mean.
2. **Tokens were estimated as `chars / 4`.** Measured against a real tokenizer on
   this codebase, that assumption is off by **−6.26% in aggregate**, and the error
   **tracks file type** — CSS −25.0%, JSON −18.4%, Markdown −12.3%, TS −8.5%,
   JS −6.8%, TSX −5.4%. An error that varies by content does not cancel out when
   you subtract two arms that contain different content.

Both are fixed in 0.4.0: the holdout is assigned **per session**, and token counts
come from a **real BPE tokenizer** over Anthropic's published vocabulary.

Because the old evidence cannot be corrected after the fact, it is **discarded
rather than carried forward**. The ledger's comparison block is stamped with an
epoch; a block from the old scheme is zeroed, not migrated, and the pooling path
refuses wrong-epoch blocks a second time and reports how many it dropped. Mixing
old and new evidence is made structurally impossible, because a large
contaminated sample sitting beside a small clean one is worse than no number at
all — it looks more authoritative and is more wrong.

**What is not reset:** your cumulative `avoided` and `holdout` totals survive. It
is the *comparison* — the thing that produces an effect size — that starts again.

**What we are not going to tell you:** whether the new number will read higher or
lower than the old one. We do not know, and predicting it would be the same
overconfidence that produced the first number. The two arms price different
content (skeletons versus whole files), so residual tokenizer bias does not fully
cancel between them, and its magnitude is currently unmeasured. The confidence
interval shown alongside the effect is a **sampling** interval — it describes
noise, not bias.

One measured behavioural note, since it is easy to assume worse than the truth:
the honest tokenizer prices skeleton bodies higher than `chars/4` did, so a file
whose skeleton is nearly the whole file can now fall below the compression floor
and be refused. Across 21 real `lib/` files, **no genuine file changed sides**,
and mean compression moved 2.31× → 2.40×. The only thing that lost its place was
a synthetic test fixture that had been clearing the floor solely because `chars/4`
undercounted it by about half.

---

## Security and privacy

- **A team row arriving without ciphertext is treated as a downgrade, not as
  content.** The read path previously asked only whether a row *had* ciphertext,
  so a row served in plaintext was rendered as authentic teammate content. It no
  longer is. This needed no attacker: one teammate setting `team.encrypt: false`
  was enough.
- **Removing a member rotates the team key.** Removal is now cryptographic rather
  than advisory — a removed member's copy of the key stops being useful instead of
  merely losing database access.
- **Home directories and usernames are scrubbed at the team boundary.** Your
  local block still carries real paths, because it needs them; what leaves the
  machine does not.
- **Five credential shapes that were one character off a pattern no longer leak
  through redaction:** `https://user:pass@host`, lowercase `bearer`, AWS `ASIA`
  STS keys, Slack `xoxc-`, and the JSON `{"password": "..."}` form that every
  agent tool argument uses.
- **The environment deny-list now applies to the injected context block**, not
  only to stored entries.
- **`search_memory` is gated on project visibility.** It was serving deleted,
  paused, excluded and archived projects out of a stale index. Deleting a project
  now purges its rows from the search index.
- **Date filters reject malformed input** instead of comparing dates as text,
  which silently returned wrong answers for near-miss dates.
- **A sync pass in flight can no longer erase a deletion watermark**, which
  previously let data you had just deleted be re-uploaded on the next tick.

## Consent and hooks

- **Declining the first-run consent dialog now does something.** Previously the
  hooks were written to disk *before* the dialog appeared, no hook body read the
  answer, and declining disabled nothing. Consent is now recorded in its own
  config record, every hook body checks it, and a decline also turns the capture
  switch off.
- **`membridge remove-hooks` and the Settings toggle are durable.** They used to
  strip the entries, report success, and be silently undone by the next launch.
  The opt-out is recorded before the strip, so a crash between the two leaves the
  safe state.
- **Capture failures are visible.** A failed capture used to be indistinguishable
  from a quiet session. Not-due, no-edits and daemon-down are now separate
  recorded outcomes, and a start line written before any work makes an unlogged
  timeout visible.
- **Reconcile can no longer downgrade a newer registration** or strip its
  observability wrapper — a dev-checkout launch used to quietly replace the
  installed hook with older code. Version comparison is numeric, not string-order.
- **The git filter is enabled at every launch, independent of capture consent.**
  It keeps MemBridge's own block out of your commits; it carries its own opt-out
  (`membridge git-filter off`), and it is protective rather than acquisitive, so
  declining capture does not switch it off.

## Data integrity

- **A duplicated marker pair no longer eats your `CLAUDE.md`.** Two MemBridge
  marker pairs in one file made sync delete everything between them, and
  `membridge remove` deleted the whole file.
- **One block-span implementation, four callers.** Four places independently
  worked out "where is the managed block"; three were wrong in different ways.
- **Session start no longer re-injects the entire block** on every launch.
- **Codex prompts are captured once**, not twice.

## Reliability and platform

- Windows: six test suites and the daemon guard made Windows-correct without
  weakening what they assert.
- `membridge stop` clears a stale pid file; `start` sees through a zombie daemon.
- `node:sqlite` is loaded lazily, so ordinary commands stop printing an
  experimental-feature warning.
- One unwritable context file no longer aborts an entire sync pass.

## Interface

- **Self-serve data deletion**, with a typed confirmation.
- **A Codex capture disclosure** — Codex sessions produce materially weaker
  memories than Claude Code, and the product now says so rather than presenting
  them as equivalent.
- Insights counts team breakdowns in the database rather than a capped local
  fold, and the coverage banner explains what it means instead of describing how
  the fetch works.
- **A team owner has a way out.** Owning a team used to mean being unable to
  leave it: the Settings control was offered and always failed. Ownership can now
  be transferred, or the team disbanded, and the Privacy rows are ordered by the
  stages your data actually moves through rather than by where the settings
  happened to live.
- **Hover-to-edit team name**, with a danger zone at the foot of the Team tab.

---

<!-- CONDITIONAL: everything from here to the closing marker depends on what else
     Andrew lands before tagging. Cut the whole block in one edit if none of it
     ships. Each item is independently removable. -->

## Also in this release, if landed

_These were in flight when these notes were drafted and are not on master yet.
Verify each is actually merged before publishing; delete the ones that are not._

- **PR #41 — migration runbook guard.** Strikes five already-applied migrations
  from `supabase/APPLY-RUNBOOK.md`, which still listed them as paste-ready steps
  for a human to run, and adds a check so a migration marked applied in the
  ledger can never reappear as an apply-step.
- **`docs/readme-honesty-and-voice`** — README and site copy corrected where they
  claimed more than the code delivers.
- **`docs/reddit-research-route`** — documents a research-tooling failure where
  `site:reddit.com` searches silently returned non-Reddit results.
- **Day-card area tags** — scannable area tags on day cards, and session bullets
  grouped under area headers.
_(The Settings danger zone has landed on master and moved up into the body of
these notes; it is no longer conditional.)_

<!-- END CONDITIONAL -->

---

## Before you tag

- **The database is currently one migration ahead of the code.**
  `057_member_identity` is applied to production, but the code that calls it — the
  member rename and avatar work — is not on master and may not ship in 0.4.0.
  This is additive and safe in that direction: a build without the code simply
  never calls those functions. Worth stating rather than leaving implicit, because
  the reverse gap is the dangerous one and someone reading a migration list should
  not have to guess which way this one points.
- **`058_owner_exit` is catalog-verified; `057_member_identity` is not.** 058 was
  checked at the catalog, not the ledger: `transfer_ownership` (2 args) and
  `delete_team` (1 arg) both present, both `security definer`, ACL limited to
  authenticated/postgres/service_role with no PUBLIC and no anon — so its revoke
  landed too. 057's only evidence is the apply plus a migration-table row, and its
  ledger entry says `applied (unverified)` for exactly that reason. **Do not
  promote that wording without running the Verify block at the foot of
  `057_member_identity.sql`.**

- **The installer must be stamped from the actual released asset.** There is no
  v0.3.3 release — that asset 404s — and 0.3.4 is the current tag. Any instruction
  to bump the installer to 0.3.3 is wrong and will break installation for every
  user. Stamp from what actually published.
- **`package-lock.json` says 0.3.3 while `package.json` says 0.3.4.** Reconcile
  both to 0.4.0 in the same commit.
- **`supabase/MIGRATION-STATE.md` is wrong in 13 of 17 rows**, and four migrations
  carrying an apply-before-shipping deploy gate are already applied. Do not use it
  as the apply checklist for this release without reconciling it first. It also
  does not yet record `057_member_identity` and `058_owner_exit`, both applied
  2026-08-13 — add them as part of the reconciliation rather than separately, so
  the file is right once instead of freshly wrong.

## Known issues

- **The end-to-end-encryption badge still renders from configuration**, not from
  what was actually observed on the wire. The read path underneath it is fixed
  (see above); the badge's own provenance is not. Tracked as #43.
- **Project-level revocation has no cryptographic component.** One team key spans
  every project, so a revoked member is still re-sealed into future key epochs and
  revocation rests on database rules alone. Fixing it needs project-scoped keys
  and a schema change. Tracked as #17.
- **Recall fires on roughly 0.6% of eligible reads.** The mid-session injection
  path works — it was verified by live canary, not assumed — but it almost never
  triggers. Tracked as #45.
- **`summaries.jsonl` stores raw model text unredacted at rest**, and the
  prompt-sharing setting withholds less than its wording implies. Tracked as #38.
- **A test fixture in the `core` suite fails on slow runners** and reads like an
  attribution regression. It is a fixture bug, it is on master, and the local
  verify gate returns the wrong verdict for it. Tracked as #63.

---

_Compiled from `git log v0.3.4..bde3d97`. Claims about encryption, capture and
savings were checked against the shipped code rather than inferred from commit
subjects; where a claim could not be verified it appears under Known issues
instead._
