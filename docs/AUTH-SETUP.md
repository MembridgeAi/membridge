# Auth setup: GitHub sign-in + MemBridge-branded emails

One-time operator configuration on the Supabase project
(`mefgbiecvoszjorwzkfz` — the one baked into `lib/backend.json`). The code in
`web/` already handles everything else; nothing here touches the repo.

Estimated time: ~10 minutes for GitHub sign-in and the email templates.
Custom SMTP (the true "from MemBridge" sender address) needs an email
provider account and a DNS record, so budget a little longer for that part.

## 1. GitHub sign-in

1. **Create the GitHub OAuth app** — github.com → Settings → Developer
   settings → OAuth Apps → *New OAuth App*:
   - Application name: `MemBridge`
   - Homepage URL: `https://membridge.me`
   - Authorization callback URL (exactly):
     `https://mefgbiecvoszjorwzkfz.supabase.co/auth/v1/callback`

   Register it, then *Generate a new client secret* and keep the Client ID +
   secret handy. (Create it under the MembridgeAi org if you want it owned by
   the org rather than your personal account.)

2. **Enable the provider in Supabase** — supabase.com dashboard → project →
   *Authentication* → *Sign In / Providers* → *GitHub*: toggle on, paste the
   Client ID and Client Secret, save.

3. **Allow the redirect back to the web app** — *Authentication* → *URL
   Configuration*:
   - **Site URL**: the deployed web workspace's URL (the Vercel deployment of
     `web/`).
   - **Redirect URLs**: add `https://<that-domain>/**` and, for local dev,
     `http://localhost:3000/**`.

   The GitHub button sends people back to the exact page they started from
   (`/login` or `/join/<token>`), and Supabase only honors destinations on
   this allowlist — skip this step and everyone lands on the Site URL
   instead, which breaks the invite auto-join.

4. **Good to know**
   - If someone signs in with GitHub using the same **verified** email as an
     existing email/password account, Supabase links it to that account — no
     duplicate identity.
   - The CLI (`membridge login`) stays email/password. Someone who signed up
     via GitHub can use *Reset password* on the web login page to set a
     password for the CLI; same account either way.

## 2. Verification email branded as MemBridge

Two independent layers — do the first now, the second when you have SMTP.

### 2a. Branded templates (free, works immediately)

Dashboard → *Authentication* → *Email Templates* (called *Emails →
Templates* on newer dashboards):

| Template | Subject | Paste body from |
|---|---|---|
| Confirm sign up | `Confirm your MemBridge account` | `supabase/templates/confirm-signup.html` |
| Reset password | `Reset your MemBridge password` | `supabase/templates/reset-password.html` |

Paste the file contents into the *Message body* (source/HTML view) and save.
Keep `{{ .ConfirmationURL }}` exactly as written — Supabase substitutes the
real link at send time.

### 2b. Sender address (needs custom SMTP)

Until custom SMTP is configured, the mail still arrives from
`noreply@mail.app.supabase.io` no matter what the template says. To make it
genuinely come *from MemBridge*:

1. Sign up with a transactional email provider (Resend and Postmark both have
   free tiers that cover this) and verify the `membridge.me` domain there
   (they'll give you a couple of DNS records to add).
2. Dashboard → *Authentication* → *Emails* → *SMTP Settings*: enable custom
   SMTP with the provider's host/port/username/password, sender address
   `noreply@membridge.me`, sender name `MemBridge`.

Bonus: Supabase's built-in mailer is rate-limited to a handful of emails per
hour — custom SMTP also removes that cap, which matters the day a whole team
signs up at once.
