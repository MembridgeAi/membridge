# Ops stack — anonymous counters + private dashboard

Everything the operator needs to answer two questions without asking a single
user: **is the product actually working on real machines**, and **who is using
it**.

Design and reasoning: `docs/superpowers/specs/2026-07-28-developer-diagnostics-backend-design.md`.

---

## Why this lives on Cloudflare and not Supabase

The counter endpoint is public and unauthenticated by construction — clients are
anonymous, so there is nobody to authenticate. Hosting that on the Supabase
project would put an unauthenticated write path on the database holding every
customer's data, no matter how small the payload is.

A Cloudflare Worker holds no Supabase credential and has no route to it. The
worst case for a full compromise of the counter endpoint is **wrong numbers on
an internal page**.

It also makes the never-join rule structural: anonymous install data and account
data now live in systems that cannot query each other, so the rule cannot be
broken by accident later.

---

## Pieces

| Path | What it is | Public? |
|---|---|---|
| `counters-worker/` | Ingest. Validates against a fixed allowlist, writes to Analytics Engine. | yes, unauthenticated |
| `ops-api/` | Read **and write**. Verifies the Cloudflare Access JWT, fans out to Analytics Engine + Supabase, and runs the action allowlist. | no, Access only |
| `ops-dashboard/` | The panel. Static, ships no secret. | no, Access only |
| `../lib/counters.js` | Client emission, on the daemon tick. | — |
| `../supabase/migrations/021_ops_panel.sql` | The write half: audit log, team notes/flags, onboarding invites. | — |
| `../supabase/migrations/022_ops_snapshot_v3.sql` | Funnel, weekly series, cohorts, per-team list. Supersedes 020. | — |

---

## Review it locally first

No Cloudflare account needed. Serves the real page against a stubbed API, so
the page exercises its actual fetch path rather than a demo branch:

```bash
node cloudflare/ops-dashboard/dev-server.js 8788
```

Then open <http://127.0.0.1:8788>. The stub data is deliberately unflattering —
most installs not serving, some registration failures, a dormant team — because
a demo where everything is green proves nothing about whether the page
communicates a problem.

---

## Deploy

### 1. Counter ingest

```bash
cd cloudflare/counters-worker
npx wrangler deploy
```

Then, in the Cloudflare dashboard:

- point a hostname at it — **see the hostname note in `counters-worker/wrangler.toml` before choosing.** `membridge.app` is not on Cloudflare, and this URL is baked into shipped clients that never update it, so the choice is close to permanent;
- add a **rate limiting rule** on that hostname, ~10 requests/minute per IP.
  A healthy install sends one request per state change plus one per day, so
  anything above that is a bug or an attack. This is the only DoS control —
  `wrangler.toml` cannot express it.

### 2. Point clients at it

Create `lib/counters-backend.json`:

```json
{ "url": "https://counters.membridge.me" }
```

Deliberately a **separate file** from `lib/backend.json`. Nothing should be able
to fall back from the counter endpoint to the customer database.

Absent or empty → clients never send. That is the correct default for
self-hosted and open-source builds, and it means forgetting this step fails
closed rather than leaking somewhere unexpected.

### 3. Business metrics

Apply `019`, `020`, `021` then `022` in order, in the Supabase SQL editor. Each
later snapshot replaces the previous function body; the earlier ones are kept
rather than rewritten, because editing an already-committed migration is exactly
the habit that produced the repo/live drift fixed in 018.

Everything is granted to `service_role` only — `anon` is the public internet and
`authenticated` is every signed-in customer, so neither may read business data or
invoke an admin action. The single exception is `redeem_onboarding_invite`, which
is granted to `authenticated` **by design**: it must run as the new user so
`create_team` records them as owner.

### 4. Read API

```bash
cd cloudflare/ops-api
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN          # scope: Account Analytics -> Read, nothing else
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler deploy
```

Edit `[vars]` in `wrangler.toml` first: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the
Access application's AUD tag), `ALLOWED_EMAILS`.

`workers_dev = false` is deliberate — it removes the `*.workers.dev` URL so the
Access check at the edge cannot be sidestepped.

### 5. Dashboard + Access

- Deploy **`ops-dashboard/public/`** — not the whole folder. `dev-server.js`
  sits deliberately outside `public/` because it carries invented team names and
  a directory-wide deploy would publish it alongside the panel.

  ```bash
  cd cloudflare/ops-dashboard
  npx wrangler pages project create membridge-ops --production-branch main
  npx wrangler pages deploy public --project-name membridge-ops --branch main
  ```

- **Close the `*.pages.dev` back door.** Every Pages project gets a public
  `<project>.pages.dev` hostname. It **cannot be deleted** — changing it means
  deleting and recreating the project — and an Access policy scoped to
  `ops.membridge.me` does not cover it. Two supported ways to close it:

  1. **A second Access application** (recommended, same mechanism as the custom
     domain): Zero Trust → Access → Applications → Create → Self-hosted, public
     hostname `membridge-ops.pages.dev`. **Delete the wildcard `*` from the
     Subdomain field** before saving, or it will not match. Reuse the same email
     policy.
  2. **An account-level Bulk Redirect** from `membridge-ops.pages.dev` to
     `ops.membridge.me`.

  **Do not rely on the "Access policy" toggle in the Pages project settings.**
  It protects *preview* deployments only — the randomly-named ones — and not the
  production `*.pages.dev` hostname. It looks like it closes this and does not.

- Add `ops.membridge.me` as a custom domain **in the Cloudflare dashboard** —
  Pages → the project → Custom domains. Wrangler has no `pages domain`
  subcommand, so this step cannot be scripted with it.
- Route `ops.membridge.me/api` to the `ops-api` Worker.

> **Why `.me` and not `.app`.** `membridge.app` is on name.com nameservers, not
> Cloudflare, so Access cannot protect any hostname under it — that is why only
> `membridge.me` appears in the domain dropdown. `membridge.me` is already a
> Cloudflare zone and works today. Keeping the admin panel off the
> customer-facing brand domain is also the better end state, not a compromise.
>
> **Check the redirect first.** `membridge.me` currently returns `301` to
> `https://membridge.app/`. If that rule matches subdomains, it will bounce
> `ops.membridge.me` to the marketing site before Access ever runs, and the
> symptom looks like a broken deploy rather than a redirect. Confirm the rule is
> scoped to the apex (and `www`), or add an explicit exception for `ops.`.
- Confirm the page is excluded from `sitemap.xml` and `llms.txt`. It already
  carries `noindex`.

> **Do step 5 before 5a.** Access *protects* a hostname; it does not create
> one. Until the Pages project exists and `ops.membridge.me` is added to it as a
> custom domain, that hostname has no DNS record and Access has nothing to sit
> in front of.
>
> The failure is genuinely confusing: with no DNS record the browser gets
> NXDOMAIN, and many consumer gateways (AT&T Internet Air among them) hijack
> that and serve their own router login page. It looks like a misconfigured
> redirect rather than a missing hostname. **Test DNS with `dig ops.membridge.me`,
> not a browser** — an empty answer means the record does not exist, whatever
> the browser shows you.

### 5a. How you actually sign in

There is no login form, no password and no session code in the panel. That is
deliberate: authentication bugs cannot exist in code nobody wrote. Cloudflare
Access challenges the request at the edge, before the page is served, and the
panel only ever sees an already-verified identity.

Set it up once. **Order matters** — the login method has to exist before an
application can use it.

1. **Add a login method.** **Zero Trust → Integrations → Identity providers** →
   *Add new*. (Not Settings → Authentication; Cloudflare moved it, and most
   older guides still point at the old path.)

   **One-time PIN is no longer added automatically.** It used to be, which is
   why so many walkthroughs skip this step. Miss it and you end up with a
   correctly configured application and no way to sign into it — and the
   failure reads as a broken app, not a missing identity provider.

   - **One-time PIN** — nothing to configure beyond adding it. Cloudflare emails
     a code on each sign-in. Start here.
   - **GitHub or Google** — nicer day to day, needs an OAuth app registered with
     Cloudflare once. Worth doing if you use the panel daily.

   **If you pick GitHub**, register the OAuth app at GitHub → *Settings →
   Developer settings → OAuth Apps → New OAuth app*, under the **MembridgeAi
   org**, not a personal account — an OAuth app tied to a founder's own GitHub
   becomes a problem exactly when you can least afford one.

   | Field | Value |
   |---|---|
   | Homepage URL | `https://weathered-sky-8f4e.cloudflareaccess.com` |
   | Authorization callback URL | `https://weathered-sky-8f4e.cloudflareaccess.com/cdn-cgi/access/callback` |

   Three things GitHub rejects silently-ish: the `https://` scheme is required,
   there is **no `www.`** on a Cloudflare team domain, and the callback must end
   in `/callback` — `/cdn-cgi/access` alone is not enough.

   Do **not** reuse the OAuth app behind the product's own GitHub sign-in. A
   GitHub OAuth App has exactly one callback URL and that one points at
   Supabase, so repointing it would break customer sign-in — and it would couple
   operator auth to customer auth, which is the separation this whole design
   rests on.

   The Client Secret is shown once. Copy it straight into Cloudflare.

   This is entirely separate from the GitHub sign-in inside the product. That
   one is Supabase auth for customers; this is Cloudflare auth for the operator.
   They share nothing, which is correct — a bug in customer auth must not be
   able to open the admin panel.

2. **Add an application.** **Zero Trust → Access → Applications** → *Add an
   application* → subdomain `ops`, domain `membridge.me`, no path.

   Cloudflare removed the explicit "Self-hosted" tile from this flow; the
   Destinations screen you land on already *is* the self-hosted path (its own
   help text says "per self-hosted application").

3. **Session duration** — 24 hours is a reasonable default. Shorter means
   re-authenticating more often; longer widens the window on a stolen laptop.

4. **Add a policy** → Action: *Allow* → Include: *Emails* → your address.

   This list, and `ALLOWED_EMAILS` in `ops-api/wrangler.toml`, must BOTH contain
   anyone who should get in. Two lists is not redundancy for its own sake: the
   Access policy is what stops the request at the edge, the Worker check is what
   stops a request that reached the Worker another way.

5. **Copy the application's AUD tag** into `ACCESS_AUD` in
   `ops-api/wrangler.toml` and redeploy the Worker.

   Do not skip this. `aud` pins a token to *this* application; without it, a
   valid Access token for any other app on the same team would be accepted here.

**Adding a second person later** means adding their email in two places: the
Access policy and `ALLOWED_EMAILS`. There is no user table to manage, no
invitations, and nothing to revoke beyond removing the address.

**Cost:** Cloudflare Access is free up to 50 users.

**Check it worked:** open `ops.membridge.me` in a private window — you should be
challenged before seeing any page content. Then request the Worker directly
without an Access session; it must return 401.

---

## Verify it end to end

1. `curl -X POST https://counters.membridge.me -d '{"bad":true}'` → **204**.
   Always 204, even on garbage: an error status teaches a broken client to
   retry, and a retry storm across every install is the failure mode a silent
   diagnostic is least able to notice. Rejections are counted internally and
   show up on the dashboard instead.
2. Start a daemon with `counters-backend.json` in place. Within one sync pass a
   `heartbeat` should appear.
3. Open `ops.membridge.me` in a private window → Access should challenge.
4. Hit the `ops-api` Worker directly without Access → **401**.

---

## What the panel can and cannot do

Writes go through a fixed allowlist in `ops-api/src/index.js`, each mapping to one
narrow RPC. An action not in that table cannot be reached, whatever the request
body says.

**Distinguish what the PANEL can do from what the KEY can do — the two are not
the same, and this section used to conflate them.** It previously concluded that
"the blast radius of a compromised Worker is the union of those four functions
and nothing else". That is wrong: a compromised Worker means a leaked
`SUPABASE_SERVICE_KEY`, and that key bypasses RLS and holds full CRUD on every
table (see *The one credential worth watching* for the verification). The
allowlist below constrains the panel's *code*, which is what stops an operator
or a CSRF'd browser from doing something destructive. It does not constrain an
attacker who has extracted the secret.

**Can:** set an internal note on a team, flag a team as internal (drops it from
every metric), rotate a team's invite code, issue a named onboarding invite.

**Cannot:** delete a team, remove a member, delete entries, or read any session
content. The destructive operations exist as product RPCs that run as the
affected user, which is the correct place for them — an admin panel that can
irreversibly destroy a customer account is a bad trade for the convenience. Do
those deliberately in the Supabase console.

**What the read routes DO return**, since "cannot read session content" is easy
to over-read as "returns only aggregates". Audited 2026-08-05 against the live
function bodies:

- `GET /api/team/<uuid>` → `ops_team_detail`: team name, ops note, internal flag,
  **every member's display name, role and join date**, and per-project *entry
  counts* and last-activity timestamps. Real people's names, no emails, no user
  ids, and no entry content.
- `GET /api/*` (overview) → `ops_snapshot` aggregates, `ops_audit_recent` (last 50
  ops actions), Analytics Engine counters, and `ops_onboarding_invites`, which
  returns **raw onboarding invite tokens** for every invite including live
  unredeemed ones. Those are credentials rendered in a browser page. Redeeming
  one makes the redeemer the OWNER of a brand-new team rather than granting
  access to an existing one, so the direct harm is bounded — but
  `onboarding_invites` has no revocation path at all (only expiry and
  single-use), so a token seen over a shoulder or left in a screenshot cannot be
  killed, only waited out.

No route returns `memory_entries` content or ciphertext.

**Every write is audited**, and the actor is **self-reported** — read that
carefully, because an earlier wording here ("audited with the verified Access
email") claimed more than the design delivers.

The Worker fills `p_actor` from the Cloudflare Access email it has verified, so
in normal operation the name in the trail is correct. But `p_actor` is an
*argument*, so from the database's side it is composed by whoever holds the
credential. Anyone with the panel's write key can pass any string. The trail
answers "which of us did this" among the operators in `ALLOWED_EMAILS`; it does
not survive a stolen credential, and it was never able to.

What the trail *does* guarantee, even against someone holding that credential:

- **The event is real.** `ops_log` is granted to `service_role` alone, so the
  panel's write role cannot write arbitrary rows — only cause them as a side
  effect of the four real actions.
- **The time is the database's**, not the caller's (`ops_audit.at` defaults to
  `now()` and `ops_log` never names the column).
- **Nothing can be erased.** `ops_audit` has RLS on with zero policies and no
  table grants, so there is no UPDATE or DELETE path at all.

So: the *actor* is mislabelable by someone who already holds the write key; the
*event*, its *time* and its *occurrence* are not. And mislabelling is the least
of what that key buys — see the note on `SUPABASE_SERVICE_KEY` in
`ops-api/wrangler.toml`. Migration `048` records `via_role`, the one
identity-adjacent value PostgREST verifies rather than accepts, and its header
sets out why the actor itself cannot be made verifiable in the database.

An admin panel without an audit log is indistinguishable from someone holding
the service key — that reasoning stands, and is why the trail exists.

### Onboarding, and why the panel cannot just create a team

`teams.created_by` is NOT NULL against a real auth user, so a service-key insert
would have to invent an owner — a phantom account, or the operator, leaving the
customer not owning their own team. Instead the panel pre-issues a named invite
and the team is created when the first real user redeems it, as them. Ownership
and E2E key material are established exactly as in an organic signup; only the
name and the fact that we were expecting them are pre-set.

The invite link is `https://join.membridge.me/#<token>` — a Pages project of its
own (`membridge-join`, source in `join/`), not a route on the marketing site.
An earlier version of this section said the page did not exist and put it at
`membridge.app/join`; both were wrong, and the second sent anyone looking for it
to a host that has never served it.

That page redeems **both** invite kinds, and the order matters. It calls
`redeem_invite` first — the app's own links, minted by `create_invite` into
`public.invites`, which JOIN AN EXISTING TEAM — and falls back to
`redeem_onboarding_invite` only when the token is not found there. The ops
panel's pre-issued tokens are the fallback case, not the main one, because the
product sends far more app invites than the panel issues. Note that the
onboarding RPC *creates* a team rather than joining one, so the success screen
reads differently on each path; see `join/public/index.html`.

**Deploying it.** From `join/`:

```bash
npx wrangler pages deploy --branch main
```

`wrangler.toml` there carries the project name and output directory, so the
command takes no arguments — a mistyped `--project-name` silently creates a new
Pages project instead of failing. The project has **no Git connection**: nothing
ships on push, and a change on master is live only once someone runs that
command.

### CSRF

Access authenticates with a cookie, so a cross-site form POST would carry it, be
validated at the edge, and arrive here as a genuine authenticated request. Access
does not cover this. Every write therefore also requires
`Content-Type: application/json` (a cross-origin form cannot set it without a
preflight the Worker never answers) and a same-origin `Origin` header. Reads are
exempt — they are side-effect free.

---

## The one credential worth watching

`SUPABASE_SERVICE_KEY` is the single high-privilege secret here. It is required
because `ops_snapshot()` is granted to `service_role` only.

**Corrected 2026-08-05 — this section previously said the key "can only reach
the `ops_*` functions the panel actually calls". That is false, and it
understated the blast radius of the one credential this section exists to warn
about.** Verified read-only against the live database:

- `service_role` has `rolbypassrls = true` (`select rolbypassrls from pg_roles
  where rolname = 'service_role'`). Row-level security is not evaluated for it
  at all — every membership predicate, `can_see_project` gate and project-access
  scoping in this product is simply not in the path.
- It holds `SELECT`, `INSERT` and `DELETE` on **all 15** tables in `public`
  (`has_table_privilege('service_role', …)`), so it reaches them directly at
  `/rest/v1/<table>`. The `ops_*` grants are what the *panel* uses, not a limit
  on what the *key* can do.

So the honest statement of blast radius: **anyone holding this key can read and
write every row in the database, including every team's memory entries and the
sealed team keys.** Content encrypted end-to-end stays ciphertext — the key does
not unseal `team_keys`, since those are sealed to member public keys — but
everything not encrypted, and all metadata, is fully exposed.

What is genuinely mitigating, each checked rather than assumed:

- It exists only as a Worker secret. No `service_role` key appears anywhere in
  this repo or in build output — scanned by decoding every JWT-shaped string's
  `role` claim; the only key committed is the `anon` one, which is public by
  design, and the `service_role` token in `test/suites/redaction.test.js` is
  synthetic (no `ref`, `iat` or `exp` claim, which every real Supabase key has).
- Nothing else in the codebase uses `service_role`. The daemon, CLI, Electron app
  and UI contain no reference to it; the only hits are that redaction test.
- The Worker is not reachable without Access. Verified by an unauthenticated
  request to `https://ops.membridge.me/api`, which returns `302` to
  `weathered-sky-8f4e.cloudflareaccess.com/cdn-cgi/access/login/...` with an
  `aud` matching `ACCESS_AUD` in `wrangler.toml`.

**Would we know if it leaked? Almost certainly not.** `ops_log()` records writes
made *through the ops RPCs* into `ops_audit`, but a stolen key used directly
against `/rest/v1/<table>` calls no RPC and writes no audit row. Nothing in any
table the team controls would change. The only trace would be Supabase's own API
request logs, which are retained for a limited window and which nobody is
currently watching or alerting on. Treat "no sign of misuse" as no evidence
either way.

**If `ops-api` is ever compromised, rotate this key first.** A dedicated
read-only Postgres role would be strictly better and is the natural next
hardening step — and on the evidence above it is worth more than its "nice to
have" framing suggests, because it is the only change that would actually shrink
the blast radius rather than defend the perimeter around it.

---

## Kill switches

Users can turn counters off, and that must keep working:

- `config.diagnostics.enabled = false` — the same switch that governs the
  existing diagnostics, reused rather than duplicated.
- `MEMBRIDGE_NO_DIAGNOSTICS=1` — one-session override.

Shipping this also requires one line in the privacy policy stating what
anonymous diagnostics contain and how to disable them. Not showing users a
"recall is broken" banner is a product decision; collecting without disclosure
is a different thing and is not what this does.
