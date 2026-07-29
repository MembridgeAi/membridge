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

- point a hostname at it (`counters.membridge.app`);
- add a **rate limiting rule** on that hostname, ~10 requests/minute per IP.
  A healthy install sends one request per state change plus one per day, so
  anything above that is a bug or an attack. This is the only DoS control —
  `wrangler.toml` cannot express it.

### 2. Point clients at it

Create `lib/counters-backend.json`:

```json
{ "url": "https://counters.membridge.app" }
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

- Deploy `ops-dashboard/` as a Cloudflare Pages project on `ops.membridge.app`.
- Route `ops.membridge.app/api` to the `ops-api` Worker.
- Put a **Cloudflare Access** application in front of `ops.membridge.app`,
  allowing only the operator's identity. Copy its AUD tag into `ACCESS_AUD`.
- Confirm the page is excluded from `sitemap.xml` and `llms.txt`. It already
  carries `noindex`.

---

## Verify it end to end

1. `curl -X POST https://counters.membridge.app -d '{"bad":true}'` → **204**.
   Always 204, even on garbage: an error status teaches a broken client to
   retry, and a retry storm across every install is the failure mode a silent
   diagnostic is least able to notice. Rejections are counted internally and
   show up on the dashboard instead.
2. Start a daemon with `counters-backend.json` in place. Within one sync pass a
   `heartbeat` should appear.
3. Open `ops.membridge.app` in a private window → Access should challenge.
4. Hit the `ops-api` Worker directly without Access → **401**.

---

## What the panel can and cannot do

Writes go through a fixed allowlist in `ops-api/src/index.js`, each mapping to one
narrow RPC. The ops API never gets generic INSERT/UPDATE on `teams`,
`team_members`, `projects` or `memory_entries`, so the blast radius of a
compromised Worker is the union of those four functions and nothing else.

**Can:** set an internal note on a team, flag a team as internal (drops it from
every metric), rotate a team's invite code, issue a named onboarding invite.

**Cannot:** delete a team, remove a member, delete entries, or read any session
content. The destructive operations exist as product RPCs that run as the
affected user, which is the correct place for them — an admin panel that can
irreversibly destroy a customer account is a bad trade for the convenience. Do
those deliberately in the Supabase console.

**Every write is audited** with the verified Access email. `p_actor` is a required
argument on each write RPC, so the trail cannot be skipped by omitting it. An
admin panel without an audit log is indistinguishable from someone holding the
service key.

### Onboarding, and why the panel cannot just create a team

`teams.created_by` is NOT NULL against a real auth user, so a service-key insert
would have to invent an owner — a phantom account, or the operator, leaving the
customer not owning their own team. Instead the panel pre-issues a named invite
and the team is created when the first real user redeems it, as them. Ownership
and E2E key material are established exactly as in an organic signup; only the
name and the fact that we were expecting them are pre-set.

The invite link is `https://membridge.app/join#<token>`. **That route does not
exist on the marketing site yet** — it needs a page that takes the fragment,
signs the user in, and calls `redeem_onboarding_invite`. Until it exists, issued
invites cannot be redeemed.

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

Mitigations: it exists only as a Worker secret, the `ops-api` Worker is its sole
holder, it can only reach the `ops_*` functions the panel actually calls, and that
Worker has no route reachable without Access. Note this got more valuable to an
attacker the moment writes were added — it is no longer read-only.

**If `ops-api` is ever compromised, rotate this key first.** A dedicated
read-only Postgres role would be strictly better and is the natural next
hardening step.

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
