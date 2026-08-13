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
- **Change your own name, and pick an avatar.** Double-click your name in the
  bottom-left rail — or use the new row in Settings, which opens the same
  editor — to rename yourself and choose an avatar glyph and a background
  colour, picked independently. Display names are now unique within each team,
  compared case- and whitespace-insensitively and enforced by a database index
  rather than a client check, so two people can no longer be the same `marco` in
  a feed. Renaming applies across every team you belong to at once, and fails
  whole if the name is taken in any of them. Joining a team under a name someone
  already holds no longer fails — it becomes `marco 2` — because a person
  joining from the CLI has no input box to correct. Old entries keep the name
  they were pushed under; renaming does not rewrite history.

---

## Also in this release

_Each of these was verified to merge clean into `a4754a3` with `git merge-tree`,
not assumed. They are not on master at the time of writing; confirm each is
actually merged before publishing._

- **Migration runbook guard.** `supabase/APPLY-RUNBOOK.md` still listed five
  already-applied migrations as numbered, paste-ready steps for a human to run —
  including `031`, a reconstruction that would have been applied over a live
  object for no gain. Those are struck, and a check now stops a migration marked
  applied in the ledger from reappearing as an apply-step.
- **README and site copy** corrected where they claimed more than the code
  delivers.
- **A research-tooling failure documented** — `site:reddit.com` searches silently
  returned non-Reddit results rather than erroring, so any sweep relying on them
  could be confidently wrong.
- **Day-card area tags** — scannable area tags on day cards, derived from the
  files a day touched, so the Feed can be skimmed for who worked on what.
- **Sign-up no longer reports success for an email that already has an account.**
  It used to tell you to go and confirm a mail that was never sent; it now says
  the address is taken and hands you to sign-in with it kept. The signed-out
  screen is rebuilt as a standalone sign-in page with an 8-character minimum and
  a live strength meter.

_(The Settings danger zone has landed on master and moved up into the body of
these notes; it is no longer conditional.)_

**Held out of 0.4.0 by decision, not by accident** — do not re-add these:

- **Session-area headers.** Its fix-wave re-review has now been run — that was
  the only thing the earlier hold was waiting on — and it came back **keep
  held**, on evidence rather than on schedule. The commit named *"stop the area
  parsers losing a teammate's text"* still loses a teammate's text: any
  bracketed prefix shorter than 21 characters is taken for an area label and
  stripped, so a decision written `[WIP] Rate limit raised to 10s` renders with
  `[WIP]` silently gone, and points prefixed `[#1244]` render as codebase-area
  headings the tag vocabulary can never produce. A second commit, *"say what the
  flat branch actually orders"*, states an ordering bound the code does not
  honour — an eight-point single-area list is reordered away from the
  most-important-first sequence the hook asks for. Neither defect is large and
  both are fixable; the branch is held until they are. Do not confuse it with
  day-card area tags, which is a separate, reviewed change and IS in this
  release.

_(**Member rename and avatars** was held here while it was mid-plan. It is now
finished, reviewed end to end, and merged up to current master — it ships in
this release, described under **Interface**. The *Before you tag* note about the
database running one migration ahead of the code no longer applies to it.)_

---

## Before you tag

- **The database no longer runs ahead of the code.** An earlier draft of these
  notes warned that `057_member_identity` was applied while the code that calls
  it stayed on a branch. That gap is closed: the member rename and avatar work
  ships in this release, so the migration and its callers land together.
- **`057_member_identity` and `058_owner_exit` are both catalog-verified.** 058:
  `transfer_ownership` (2 args) and `delete_team` (1 arg) both present, both
  `security definer`, ACL limited to authenticated/postgres/service_role with no
  PUBLIC and no anon. 057 was verified the same way on 2026-08-13, by read-only
  catalog reads rather than by trusting the apply: the three new
  `team_members` columns, the partial unique index, the dedupe trigger,
  `team_members_list` returning both avatar columns, and
  `set_display_name(text, text, text)` `security definer` with a pinned
  `search_path`. Its ledger entry has been promoted from `applied (unverified)`
  accordingly — that promotion is done, not pending.
- **`059` is NOT applied, and should be applied with this release.** Verifying
  057 at the catalog turned up something the repo could not show: Supabase's
  default privileges grant EXECUTE on every new public-schema function to
  `authenticated`, and 057's revoke named only `public, anon`. So
  `unique_member_name` — `security definer`, taking an unchecked team id — is
  callable today by any signed-in user, letting them probe whether a display
  name is taken on a team they do not belong to. `059` is two `revoke`
  statements that close it. It is independent of every other file and safe on
  its own, but it must go **after** 057, never before.

- **The installer must be stamped from the actual released asset.** There is no
  v0.3.3 release — that asset 404s — and 0.3.4 is the current tag. Any instruction
  to bump the installer to 0.3.3 is wrong and will break installation for every
  user. Stamp from what actually published.
- **Merge `chore/version-0.4.0` last, immediately before tagging**, so the tagged
  commit is the one that says 0.4.0. It carries all **four** version fields:
  `package.json`, `package-lock.json`'s root, `package-lock.json`'s `""` package
  entry, **and `app/package.json`** — the Electron app's own manifest, which is
  easy to miss. Bumping only the first three tags a 0.4.0 release whose desktop
  app still calls itself 0.3.4.
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

_Compiled from `git log v0.3.4..a4754a3`. Claims about encryption, capture and
savings were checked against the shipped code rather than inferred from commit
subjects; where a claim could not be verified it appears under Known issues
instead._

_One provenance note for whoever runs the merge: the branches carrying the
runbook guard and the two documentation fixes are **unowned** — the session that
wrote them has ended. They are pushed and were green when they were written, but
**no one is watching their CI**. If a leg goes red after those merges, nothing
will notice on its own; check them by hand rather than assuming silence means
success._
