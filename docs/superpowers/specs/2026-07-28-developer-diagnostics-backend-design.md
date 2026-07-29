# Developer Diagnostics Backend — Design (early-stage revision)

**Status:** design. Revised 2026-07-28 after the first draft was sized for a company with
hundreds of installs rather than one with its first users.

**Goal:** one private surface where the operator can see whether MemBridge works across installs
and what the product looks like commercially — without asking users, without exposing anything
to them, and without opening a new attack surface on the database that holds all customer data.

**What changed from draft 1:** the public ingest endpoint is deferred. At current install counts
it buys statistically meaningless data in exchange for a real, permanent risk. The business
metrics — the part that is genuinely useful today — need no new collection and no new endpoint.

---

## 1. What exists today

Established by inspection:

- `lib/diagnostics.js` already builds an anonymous payload and POSTs it to
  `${BAKED.url}/functions/v1/diagnostics`.
- **That Edge Function does not exist.** No `supabase/functions/` directory, no diagnostics
  migration. Every report 404s into the fail-open catch.
- The only trigger wired is `checkNetNegative`. The failure actually hit in practice —
  registered, firing, structurally unable to serve — emits nothing.

The client-side privacy posture already shipped and is unchanged here: no code, no file names,
no project names, no account; two kill switches.

---

## 2. Why the ingest endpoint is deferred

`lib/diagnostics.js`'s own header states the justification for pooling: *"a single install never
sees enough held-out reads to prove causation on its own."* That argument requires a population.
With first users it does not yet hold — the pooled sample is as underpowered as the single
install, so the endpoint would be carrying risk for data that cannot yet answer its question.

Against that, the cost is not theoretical (§6). So:

| Phase | Trigger to start | What ships |
|---|---|---|
| **0 — now** | immediately | Business metrics (§4), migration reconciliation (§3), `membridge doctor` (§5) |
| **1 — later** | install base large enough that pooling means something (order hundreds) | Public ingest endpoint (§6), Plane A payload additions |

Phase 0 delivers the questions actually being asked today — how many teams, what size, who is
active, is recall working — with no new attack surface.

---

## 3. Fix Supabase first (blocking)

The live database and the repo disagree. Until that is closed, no new migration can be reasoned
about, including this design's.

1. **Migration numbering is corrupted.** The join-seal RLS fix was applied to the live DB by
   hand, its SQL was never committed, and `015` is now occupied by `015_feedback.sql`. The
   number no longer identifies what is applied. **Fix:** dump the live schema, diff it against
   the repo, and commit one reconciling migration that makes the repo the truth. Then never
   apply by hand again.
2. **`memory_entries.files` is `not null default '[]'::jsonb`** (`supabase/schema.sql:51`) with
   no `drop not null` anywhere in the migration set. The ciphertext-only build nulls that column
   on push, so the live DB rejects it — and the client logs nothing useful. **Fix:** a migration
   relaxing it, or the push nulls a column the schema forbids, forever.
3. **`016` has two competing implementations** — one on master, one on `feat/multidevice-e2e`.
   Reconcile before anything else lands on top.
4. **Confirm `009` and `013` (E2E) are actually applied live.** They are prerequisites for the
   encryption path and their live status is unverified.
5. **`invite_attempts` has RLS enabled and zero policies** — deny-all except `service_role`.
   That is almost certainly deliberate for a rate-limit table only functions touch, but it
   should be confirmed as intentional and commented, not left ambiguous.

Not a problem: the anon key committed in `lib/backend.json`. It is designed to ship in clients;
RLS is what protects the data, and RLS is enabled on all nine tables.

---

## 4. Phase 0 — business metrics

Derived entirely from existing tables (`teams`, `team_members`, `projects`, `memory_entries`) as
read-only aggregate views. **No new collection, no new endpoint, no decryption** — E2E is
untouched and the server continues to hold only ciphertext. `memory_entries.ask` and `.files`
are used for `count(*)` and recency only, never displayed.

Honestly available today:

- teams; team size distribution; solo vs multi-member split
- projects per team; teams with more than one active project
- active developers per period (distinct `author_id` over a window)
- activity volume and last-sync recency per team
- tool mix (`memory_entries.source` — Claude Code vs Codex vs custom)
- retention: teams whose last entry is older than 7 / 30 days

### 4.1 What this must not claim

Two binding constraints, both inherited from work already done:

- **"Avoided", never "saved". Tokens, never dollars.** The project's own wording rule
  (live-teammate-decisions plan, Global Constraints).
- **No aggregate savings percentage.** The live A/B test (30 runs, 2026-07-28) found the effect
  real but *not yet estimable* — the covered-question CI spans zero, and the unit of
  generalization is the question, not the run. A "we save teams X%" headline would be a
  fabricated number on a dashboard used to make decisions. Show measured avoided tokens and the
  install count behind them; add the rate when the corpus supports it.

Team-size curves warrant the same caution — a prior attempt was retracted because developer
identity was not clean enough to trust the shape.

---

## 5. Phase 0 — product health without a backend

At this scale the pooled endpoint is the wrong tool. Two cheaper ones give better data:

- **`membridge doctor`** — a local CLI command printing recall health for that machine: hook
  registered, hot paths, store entries, serves, and the *reason* for zero when zero
  (`no_hot_paths` / `empty_store` / `all_rejected` / `never_fired`). These are not equivalent
  failures and collapsing them loses the diagnosis. Useful for dogfooding today, and it is the
  same logic Phase 1's payload will report — so it is not throwaway work.
- **Ask the users.** With a handful of installs, a direct conversation beats telemetry on both
  richness and speed, and costs nothing to build.

---

## 6. Phase 1 — the ingest endpoint, and what makes it dangerous

Deferred, but specified now so it is built correctly when it lands.

The endpoint must be public and unauthenticated — clients are anonymous by construction, which
is the point. The danger is not the endpoint in isolation; it is what it is attached to.

1. **Shared blast radius (the real risk).** It would live on the *same* Supabase project that
   holds every team's data. An Edge Function using the `service_role` key bypasses RLS entirely;
   any logic flaw in an unauthenticated function holding that key is full read/write over
   `teams`, `memory_entries`, everything. **Mitigation: a dedicated role with `INSERT` on one
   table and nothing else. Never `service_role`.** This single decision is most of the risk.
2. **Cost and quota exhaustion.** Anyone can hammer an unauthenticated write. **Mitigation:**
   per-IP rate limit, request size cap, and a hard row-per-window ceiling.
3. **Data poisoning.** `install_id` is not a secret — the client ships as readable JS inside the
   asar, so anyone can forge reports and skew the numbers. For a dashboard whose entire purpose
   is decision-making, poisoned data is worse than no data. **Mitigation:** treat all figures as
   lower-confidence than Plane B; alert on implausible rates rather than trusting totals.
4. **Retention as liability.** Unbounded telemetry is a liability, not an asset. 180-day drop on
   a schedule.

Storage when it lands: one append-only `diagnostics_reports` table — `install_id` as plain text
with **no FK to `auth.users`**, `version`, `kind`, `payload jsonb`, `received_at`. RLS deny-all;
insert only via the dedicated role.

---

## 7. The identity rule (applies in both phases)

Business metrics and product health want opposite identity models. Joining them yields per-team
behavioural telemetry tied to real accounts — the shape that burns a privacy-first product, and
it is needed for neither question.

**Anonymous install data and account/team data are never joined** — not in a table, a view, a
query, or a dashboard panel. Written down so a later "handy to see which team hit that failure"
is a visible spec change with a stated cost, not a quiet patch.

---

## 8. Dashboard: Cloudflare Pages + Access

- Separate Pages project (not the marketing site), on a subdomain such as `ops.membridge.app`.
- **Cloudflare Access** allowing only the operator's identity. The page never loads for anyone
  else — no login form to attack, no session logic to get wrong.
- The page ships **no secret**. Access issues a signed JWT; the read function validates it
  against Cloudflare's public keys and checks the email claim. A leaked bundle discloses
  nothing.
- `noindex`, excluded from `sitemap.xml` and `llms.txt`.
- Inline SVG charts, no external dependency — matches how the rest of the site is built.

In Phase 0 this page reads only the §4 views, so it needs one authenticated read endpoint and no
write path at all.

---

## 9. Disclosure

Not showing users a "recall is broken" banner is a product decision and is respected: **nothing
here surfaces failure state to end users.**

That is not the same as concealing collection, and Phase 1 must not conceal it:

- the existing "Send anonymous diagnostics" toggle (spec §8.5) must actually ship and work;
- one privacy-policy line stating what anonymous diagnostics contain and how to disable them;
- `MEMBRIDGE_NO_DIAGNOSTICS=1` continues to work.

An anonymous aggregate is exactly as useful disclosed as undisclosed, so this costs nothing and
removes the whole category of risk from being found out later. Phase 0 collects nothing new, so
it needs only the accurate statement that business metrics are derived from data already held
for team sync.

---

## 10. Failure modes

- **Dashboard shows zero.** Must be distinguishable from "nothing reporting" — surface data
  recency prominently, or a dead pipeline reads as a healthy product with no problems.
- **Self-reporting bias (Phase 1).** An install broken enough not to run the daemon reports
  nothing, so the dashboard can never measure total install base. Pair with npm/release download
  counts and say so on the page.
- **Version skew (Phase 1).** `kind` + `version` on every row; the read path tolerates unknown
  fields rather than failing.

---

## 11. Open questions

1. Does Phase 0 exclude the operator's own dogfooding teams, so they do not skew every number?
2. Is pull-based enough, or is an alert wanted when something goes wrong?
3. What install count triggers Phase 1 — a number worth writing down now, while it is still an
   abstract decision.
