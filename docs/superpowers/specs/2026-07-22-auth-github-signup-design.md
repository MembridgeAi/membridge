# Auth polish: GitHub sign-in, clearer signup form, MemBridge-branded emails

Date: 2026-07-22 · Scope: `web/` (hosted team workspace) + Supabase auth config

## Goals

1. **Sign in with GitHub** on the web workspace's login and invite-join screens.
2. **Clearer signup form** — the email and password fields should be obvious at
   a glance (today the labels are tiny uppercase gray text and the mode toggle
   is easy to miss).
3. **Verification email branded as MemBridge**, not Supabase — template files
   in-repo plus a one-time operator runbook, since sender identity lives in
   Supabase project settings, not code.

## Design

### GitHub sign-in (code)

- `AuthForm` gets a **"Continue with GitHub"** button above the email fields
  (both modes), then an "or use email" divider. It calls
  `supabase().auth.signInWithOAuth({ provider: 'github', options: { redirectTo: window.location.href } })`
  so GitHub returns the user to the exact page they left — `/login` or
  `/join/<token>`.
- supabase-js (implicit flow, `detectSessionInUrl` on by default) picks the
  session out of the redirect URL. The pages must react to a session that
  appears *outside* the form submit path:
  - `/login` subscribes to `onAuthStateChange` (and checks the current
    session on mount) → redirects to `/feed`. This also fixes the existing
    dead-end where an already-signed-in visitor to `/login` saw the form again.
  - `/join/<token>` subscribes to `onAuthStateChange` → auto-redeems the
    invite once both a session and a valid invite exist. `redeem_invite` is
    idempotent server-side ("joining twice is a no-op"), a ref guards against
    double-firing client-side.
- `displayNameOf` falls back `display_name → full_name → user_name → email
  prefix`, so GitHub users get their real name on the team instead of an
  email fragment (GitHub sets `full_name`/`user_name` in user metadata).

### Clearer signup form (code)

- Mode switch becomes a real full-width **segmented control** ("Log in" /
  "Create account") instead of two loose text buttons.
- Field labels become normal-case, `text-sm font-medium text-slate-700` —
  readable labels sitting directly above each input, instead of 10px uppercase
  tracking-wide gray.
- Signup mode adds one line of helper text under the password field
  ("This is a new password for MemBridge — at least 6 characters."), which
  also preempts the "is this my GitHub/Google password?" confusion.

### MemBridge-branded emails (config + templates)

Supabase's default confirmation mail comes from `noreply@mail.app.supabase.io`
with Supabase's plain template. Two independent fixes, both one-time operator
actions in the Supabase dashboard (no admin API token exists on this machine,
so they cannot be applied from here):

- **Templates** (works immediately, no SMTP needed): branded HTML for
  *Confirm signup* and *Reset password* checked into
  `supabase/templates/`, using Supabase's `{{ .ConfirmationURL }}` variables,
  table-based layout with the MemBridge gradient-tile + wordmark lockup in
  inline CSS (no remote images, so it renders even with images blocked).
- **Sender** ("from MemBridge, not Supabase"): requires custom SMTP in
  Supabase Auth settings — sender name `MemBridge`, address on a domain Marco
  controls (e.g. `noreply@membridge.me` via Resend/Postmark).
- Runbook `docs/AUTH-SETUP.md` covers: creating the GitHub OAuth app
  (callback `https://mefgbiecvoszjorwzkfz.supabase.co/auth/v1/callback`),
  enabling the provider, redirect-URL allowlist for the deployed web app,
  custom SMTP, and pasting the templates + subjects.

## Non-goals

- No GitHub OAuth in the CLI/Electron app (`membridge login` stays
  email/password; same Supabase account works in both, so a GitHub-created
  account can set a password via reset if needed — noted in the runbook).
- No other providers (Google etc.).
- No change to auth flow type (implicit stays; PKCE is a separate decision).

## Testing

- `next build` in `web/` must pass (the repo's CLI test suite doesn't cover
  `web/`, which has no test harness of its own).
- Manual: login via GitHub round-trip, invite-join via GitHub round-trip,
  email/password signup unchanged — requires the Supabase provider config, so
  this lands as the operator checklist in the runbook.
