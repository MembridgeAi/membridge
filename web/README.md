# MemBridge web — the hosted team workspace

Next.js App Router + `supabase-js` + Tailwind, nothing else. No custom API
server: the browser talks straight to Supabase and **row-level security is the
authorization layer**, exactly like the CLI. One Supabase account works in
both.

Screens:

- `/` — thin marketing landing
- `/login` — GitHub or email/password (same account as `membridge login`;
  the GitHub provider needs one-time setup, see `docs/AUTH-SETUP.md`)
- `/join/<token>` — invite landing: shows the team name (`peek_invite`),
  inline signup/login (GitHub or email), auto-joins (`redeem_invite`), then
  nudges the CLI install
- `/feed` — the team timeline, grouped by day, filter by person / project /
  tool, keyset "load older" pagination (`team_feed` RPC — one query per page)
- `/projects` — cards from the `project_stats` view; click pre-filters the feed
- `/settings` — members (remove / change role), invite links (create / revoke),
  rename team, leave team

## Develop

```bash
cd web
npm install
cp .env.example .env.local   # fill with the Supabase project URL + anon key
npm run dev
```

The Supabase project must have `supabase/schema.sql` (v1) and
`supabase/migrations/002_team_v2.sql` applied.

## Deploy (Vercel)

Import the repo, set the root directory to `web/`, add the two
`NEXT_PUBLIC_*` env vars, deploy. Then point the CLI's invite links at it by
adding `"webUrl": "https://<your-app>.vercel.app"` to `lib/backend.json`
(bakes into builds) or `team.webUrl` in `~/.membridge/config.json`.

The core npm package (`membridge`) does not ship this folder and stays
zero-dependency.
