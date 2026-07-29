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
| `ops-api/` | Read side. Verifies the Cloudflare Access JWT, fans out to Analytics Engine + Supabase. | no, Access only |
| `ops-dashboard/` | Static page. Ships no secret. | no, Access only |
| `../lib/counters.js` | Client emission, on the daemon tick. | — |
| `../supabase/migrations/020_ops_snapshot_v2.sql` | Funnel, weekly series, cohorts and the per-team list. `service_role` only. Supersedes 019. | — |

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

Apply `supabase/migrations/019_ops_snapshot.sql` then `020_ops_snapshot_v2.sql` in the
Supabase SQL editor. 020 replaces 019's function body — 019 is kept rather than
rewritten because rewriting an already-committed migration is exactly the habit
that produced the repo/live drift fixed in 018.
It creates one security-definer function granted to `service_role` only —
`anon` is the public internet and `authenticated` is every signed-in customer,
so neither can read aggregate business data.

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

## The one credential worth watching

`SUPABASE_SERVICE_KEY` is the single high-privilege secret here. It is required
because `ops_snapshot()` is granted to `service_role` only.

Mitigations: it exists only as a Worker secret, the `ops-api` Worker is its sole
holder, it is used for exactly one RPC that returns aggregates, and that Worker
has no route reachable without Access.

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
