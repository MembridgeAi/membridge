# Security Remediation: Implementation Plan

> **For agentic workers:** single implementer per task, with **TWO review points**: one after Task 1 (the live authentication hole) and one whole-branch review at the end. Use `superpowers:executing-plans` (single agent, TDD). Steps use checkbox (`- [ ]`) syntax.
>
> **TDD is not optional here.** For every fix, write the test that demonstrates the vulnerability first, run it, watch it fail against unmodified code, then fix. A security fix with no failing-first test is a claim, not a change. This is the single most important instruction in this plan.

**Goal:** Close the findings in [the audit](../specs/2026-08-01-security-audit-and-remediation-design.md), each with a regression test, without disturbing the defenses that are already correct.

**Architecture:** Four surfaces, largely independent. The daemon (`lib/server.js`, `lib/teamsync.js`), the Supabase schema (new forward-only migrations), the Cloudflare Workers (`cloudflare/ops-api`, `cloudflare/counters-worker`), and the Electron shell (`app/main.js`).

**Tech stack:** Daemon is plain Node, harness `test/run-tests.js` (`node test/run-tests.js`). UI is React 19 with TS under `ui/` (`cd ui && npm test`). **First: run BOTH suites on a fresh branch and record the real baselines. Do not assume any number.**

**Conventions:** commit `<type>: <description>`, no footer. Failing test first, always. Never edit a published migration; add a new one. No em dashes in prose, code comments, or UI copy.

**Task order is risk order, not audit order.** It is deliberately not F1 through F11. Tasks are sequenced by what is exploitable today against a two-person team, then by what becomes exploitable at scale.

---

## Locked decisions (do not relitigate)

These were decided rather than left open. Each was a real tradeoff; the reasoning is given so you can implement it faithfully, not so you can reopen it.

1. **`state` is mandatory. PKCE is the default, and skipping it requires a written justification in the branch.** `state` alone closes the injection attack. PKCE additionally keeps tokens out of the URL and browser history, which is strictly better. If Supabase's flow genuinely makes the code exchange impractical from a bare loopback daemon, say so in a comment at the call site, with what you tried. Do not silently leave implicit in place.
2. **`default_access` is enforced with no grandfathering.** Turning enforcement on changes what people can see the moment it ships. That is the correct direction: the UI has been claiming a restriction the database ignored, and the honest fix is to make the claim true, not to preserve the leak for existing rows. Deny by default on a project whose flag is off.
3. **The permanent `invite_code` path is retired.** It never expires, has no use cap, no throttle, and every plain member can read it. Remove `join_team`'s reachability and move anyone relying on it to the throttled, expiring `redeem_invite` path. Breaking a saved join link is an acceptable cost.
4. **Refresh token goes to the OS keychain where one exists, with a visible warning where one does not.** macOS Keychain and Windows DPAPI are already wired in `lib/keychain.js`. On Linux, try libsecret; if unavailable, fall back to the existing 0600 file **and surface a persistent warning in `membridge status`**. Do not fail closed and lock Linux users out of sign-in entirely. A warned fallback beats pushing people to worse workarounds, and a silent fallback is exactly what we are fixing.
5. **Google sign-in ships. Apple does not, yet.** Google has none of Apple's problems: stable email, standard metadata, and Supabase's link-by-verified-email works. Apple's Hide My Email produces users with no linkable email, which silently creates a *second* account for the same human, with a separate box keypair and no team history, and no amount of care in `sessionToCredentials` fixes that. Shipping Apple before the account-linking story exists manufactures split identities we would then have to merge by hand. Task 9 delivers Google plus a short written decision doc for Apple. Apple implementation is separate work.

---

## Task 0: baselines, and one production config check

**Files:** none in code.

- [ ] Branch from master. Run `node test/run-tests.js` and `cd ui && npm test`; record both real baselines in the first commit message.
- [ ] **Check production config before writing any code.** Confirm `ACCESS_AUD` and `ALLOWED_EMAILS` are actually populated on the deployed `ops-api` Worker (`wrangler secret list`, or the Worker settings). Per audit F7, if either is empty the admin panel currently accepts any Cloudflare Access token issued anywhere on the team domain. **If either is blank, populate it immediately and report that separately.** This is a live exposure fixable by configuration, not by this branch.

## Task 1: bind the OAuth callback to the request that started it (audit F1)

**Files:** `lib/teamsync.js`, `lib/server.js`, `test/run-tests.js`.

- [ ] **Failing tests:** the authorize URL contains a `state` parameter; `/api/team/oauth-complete` rejects tokens whose `state` is absent, unknown, expired, or already consumed (assert each of the four separately); `state` is single-use; the callback page clears `window.location.hash` after reading it; a POST to `/api/team/oauth-complete` with no `Origin` header is rejected for this endpoint.
- [ ] Run, expect FAIL.
- [ ] Implement: generate a CSPRNG `state` per authorize request, hold it in daemon memory with a 5 minute TTL, carry it through `redirect_to`, and verify and consume it **before** `loginWithTokens` is ever called. Clear the fragment in `oauthCallbackPage()` (`lib/server.js:128-156`).
- [ ] Attempt PKCE per locked decision 1. If you skip it, the justification goes in a comment at `oauthAuthorizeUrl` (`lib/teamsync.js:163`).
- [ ] Run, green plus full suite. Commit: `fix(auth): bind the OAuth callback to the request that started it`.
- [ ] **STOP. Review point.** This closes a live hole and merges on its own, ahead of the queued UI work. Human verification: start a sign-in, complete it, then replay the same callback URL a second time and confirm it is rejected. Do not continue to Task 2 until a person confirms that.

## Task 2: enforce `default_access` server-side (audit F2)

**Files:** new migration `027_enforce_default_access.sql`, tests.

- [ ] **Failing test:** a team member with no `project_access` row cannot read `memory_entries` for a project whose `default_access` is off. Assert zero rows, not an error.
- [ ] Run, expect FAIL.
- [ ] Implement: `can_see_project()` (`025:30-38`) consults `projects.default_access` when no explicit row exists, instead of defaulting to allow. Consulting the column is preferred over materializing rows on join, since it avoids a backfill.
- [ ] Record the column's observed default in the migration comment, so a reader knows what existing teams inherit.
- [ ] Run, green. Commit: `fix(rls): can_see_project honors the project default`.

## Task 3: ops-api fails closed on missing configuration (audit F7)

**Files:** `cloudflare/ops-api/src/index.js`, tests.

- [ ] **Failing tests:** the Worker returns 401 when `ACCESS_AUD` is unset; 401 when `ALLOWED_EMAILS` is empty; a valid token minted for a different Access application is rejected.
- [ ] Run, expect FAIL.
- [ ] Implement: change `if (aud && ...)` at `:95` and `if (allowed.length && ...)` at `:107` to hard failures on missing configuration. Give `cachedKeys` (`:52-59`) a TTL and a refresh on `kid` miss, so a Cloudflare key rotation degrades instead of causing a hard outage.
- [ ] Stop returning plaintext tokens from `ops_onboarding_invites` (`021:221-235`); return a prefix or a redeem link.
- [ ] Run, green. Commit: `fix(ops): fail closed on missing Access config`.

## Task 4: restore the Supabase grants and pin the rule in CI (audit F4, F5)

**Files:** new migration, a CI check, tests.

- [ ] **Failing tests:** `team_feed` is not executable by anon; anon reads of `project_access` and `team_audit` return zero rows rather than a function permission error; `invites` is readable only by managers; `my_teams` does not return `invite_code` to a non-manager.
- [ ] Run, expect FAIL.
- [ ] Implement: re-apply the `team_feed` revoke and grant lost across `013:21`, `014:32`, `017:32`, `025:87`. Narrow `invites_select` (`002:68`) to `is_team_manager`. Remove `invite_code` from `my_teams` (`006:23-29`) and from what `teams_select` exposes to non-managers. Grant `is_team_manager` to anon for the same documented reason `is_team_member` is granted (`010:337-341`), so an anon read returns empty rather than an error. Revoke `set_project_access_default` (`026:23`) from public and anon.
- [ ] **Add a CI check that fails when a migration contains `drop function` without a matching `grant` for that function in the same file.** Migration `011:130-147` already wrote this as a policy and it has been violated four times since. A comment is not sufficient; make it mechanical.
- [ ] Run, green. Commit: `fix(grants): restore team_feed ACL, narrow invite visibility, enforce in CI`.

## Task 5: make rate limiting real, and retire the unthrottled path (audit F3, F10)

**Files:** new migration, `cloudflare/counters-worker/`, tests.

- [ ] **Failing tests:** a client supplying its own `cf-connecting-ip` header does **not** get a fresh throttle bucket per request; the last XFF hop is used instead; `redeem_onboarding_invite` is throttled; a duplicate `waitlist` email is rejected; `join_team` is no longer reachable as an unthrottled join path.
- [ ] Run, expect FAIL.
- [ ] Implement: remove the `cf-connecting-ip` branch at `010:175`, or gate it behind a shared secret header only a Worker could know. Clients hit Supabase directly, so that header is client-supplied today and the limit never trips. Add `check_invite_attempt()` to `redeem_onboarding_invite` (`021:183`). Add a unique constraint on `waitlist.email` (`018:101-106`) and a per-window insert cap on `feedback` (`015:21`).
- [ ] Retire `join_team` per locked decision 3.
- [ ] Codify the counters Worker rate limit, or state plainly in `cloudflare/README.md` that metric inflation via a client-chosen `install_id` is an accepted risk. Do not leave it as a dashboard recommendation nobody can verify from the repo.
- [ ] Run, green. Commit: `fix(ratelimit): the throttle key is no longer client-supplied`.

## Task 6: the advisor base-URL guard applies on persist (audit F8)

**Files:** `lib/server.js`, tests.

- [ ] **Failing tests:** `POST /api/settings` with a custom `advisor.baseUrl` and no accompanying key is rejected, matching the existing guard at `:1702-1720`; a non-http(s) scheme is rejected; a stored key is never paired with a newly supplied base URL.
- [ ] Run, expect FAIL.
- [ ] Implement by extracting the guard at `:1702-1720` into one function used by both the test route and the persist path at `:1464`. Do not duplicate the logic.
- [ ] Run, green. Commit: `fix(advisor): same base-URL guard on persist as on test`.

## Task 7: credentials at rest, and refresh robustness (audit F9)

**Files:** `lib/teamsync.js`, `lib/keychain.js`, `bin/membridge.js`, tests.

- [ ] **Failing tests:** the refresh token is stored via the keychain on a platform that has one, and the plaintext file no longer contains it; on a platform without one, the fallback is used **and** `membridge status` reports the warning; concurrent `getAccessToken` calls perform exactly one refresh; a refresh that throws leaves the previous credentials recoverable rather than dead.
- [ ] Run, expect FAIL.
- [ ] Implement per locked decision 4. Add an in-flight promise guard around refresh (`lib/teamsync.js:197-208`). Persist the new token before invalidating the old.
- [ ] Run, green. Commit: `fix(auth): refresh token to the keychain, single-flight refresh`.

## Task 8: remaining hardening (audit F11)

Commit each item separately.

- [ ] Fix `search_path` in `ops_create_onboarding_invite` (`021:163`) so `gen_random_bytes` resolves. **Assert an onboarding invite can actually be created**, since this is currently broken outright, not merely insecure.
- [ ] Append `, pg_temp` to every `SECURITY DEFINER` search_path pin.
- [ ] `esc()` escapes `'` (`cloudflare/ops-dashboard/public/index.html:206`).
- [ ] `sandbox: true` explicit in `app/main.js:158`.
- [ ] Default config written with `{ mode: 0o600 }` (`lib/util.js:128`).
- [ ] Bind `memory_entries.author_name` to the caller in the insert policy (`schema.sql:126-130`), or render a name resolved from `author_id` instead.
- [ ] Read `EXCLUDE_TEAMS` in `ops-api` (`:203`) or delete the binding.

## Task 9: Google sign-in, and a written decision on Apple

**Do not start until Task 1 has merged.**

**Files:** `lib/teamsync.js:163`, `lib/server.js:1622` and `:128-156`, `lib/teamsync.js:124-135` and `:184-187`, `cloudflare/join/public/index.html:61-64` and `:172-180`, `ui/src/features/settings/TeamGroup.tsx`, `docs/AUTH-SETUP.md`, `test/run-tests.js:2671-2680`.

- [ ] **Failing tests:** the authorize URL is built from a **server-side provider allowlist** and an unknown provider string is rejected rather than interpolated; display-name derivation handles a Google profile (`name`, `given_name`, no `user_name`); `state` verification from Task 1 holds for both providers.
- [ ] Run, expect FAIL.
- [ ] Implement: parameterize the provider instead of encoding it in a route path (`lib/server.js:1622`). Thread it through the callback page copy (`:132`, `:144`) and the join page (`join/public/index.html:63`, `:179`).
- [ ] Build the provider picker in `ui/src/features/settings/TeamGroup.tsx`. The GitHub button does not currently exist anywhere in `ui/src/`; the route is live but unlinked, so this is new UI rather than an edit.
- [ ] **Do not reuse the product's OAuth apps for Cloudflare Access.** `cloudflare/README.md` §5a warns about this for GitHub, and Google is also offered as an Access IdP, so the hazard grows: two Google OAuth apps with near-identical settings, one for customers and one for the operator. A bug in customer auth must not be able to open the admin panel.
- [ ] **Apple: write `docs/superpowers/specs/apple-signin-decision.md` and stop there.** It answers one question: what happens when Hide My Email produces a user with no linkable email, so Supabase's link-by-verified-email silently creates a second account for the same human, with a separate box keypair and no team history. Cost out two options: refuse Apple sign-ins without a shareable email, or build an explicit account-linking flow. Do not implement Apple until that decision exists.
- [ ] Run, green plus both suites. Commit: `feat(auth): Google sign-in`.

## Final review

- [ ] Every audit finding is either fixed with a failing-first test, or explicitly marked verified-not-a-problem with the reasoning written down in the branch. No finding is silently dropped.
- [ ] Nothing in the audit's "What is already correct" section was changed.
- [ ] Re-run two checks by hand: grep the repo for `Access-Control` (expect zero), and confirm the new CI guard catches a `drop function` with no sibling grant.
- [ ] Human pass: sign in with both providers on a clean machine; confirm a replayed callback is rejected; confirm a project with `default_access` off is genuinely unreadable from a second account; confirm `membridge status` shows the keychain warning on a platform without one.

## Out of scope

- The three queued UI work streams (`session-detail-page`, `projects-tab-scale-and-archive`, `measured-savings`).
- The E2E encryption rollout. Scaffolding is present and the plaintext-versus-claim issue is tracked in `claude/security/backend-readiness-2026-07-21.md`.
- Apple sign-in implementation, per locked decision 5 and Task 9's decision doc.
- Marco's seven security findings, unanswered since 7/25. Reconcile against them before starting, in case of overlap.

## Self-review

- Audit F1 maps to Task 1. F2 to Task 2. F7 to Tasks 0 and 3. F4 and F5 to Task 4. F3 and F10 to Task 5. F8 to Task 6. F9 to Task 7. F11 to Task 8. Provider expansion to Task 9.
- Every finding has exactly one owning task. Nothing in the audit is unassigned.
- Ordering is by exploitability against the current two-person team, not by audit numbering. F5 (invite tokens visible to all members) and F10 (rate limiting) rank lower than their raw severity because both need team scale to matter. Both are still in scope, just later.
- Delegated and flagged: whether PKCE is practical from the daemon (Task 1), and the Apple linking decision (Task 9). Both require a written answer in the branch, not a silent choice.
