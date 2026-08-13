# Sign-in screen: honest sign-up, Google-grade presentation

**Date:** 2026-08-12
**Branch:** `feat/auth-screen-redesign`
**Status:** approved

## Problem

Two problems, one screen.

**The defect.** Signing up with an email that already has an account reports
success. `teamsync.signup()` posts to Supabase and then reads the response like
this:

```js
const data = await authRequest(be, 'signup', { email, password });
if (!data.access_token) {
  return { needsConfirmation: true, email };
}
```

With email confirmation enabled, GoTrue answers a sign-up for an
already-registered address with `200`, a user object, and **no session** — its
deliberate anti-enumeration behaviour. The absent `access_token` is read as
"account created, one step left", and the screen tells the user
`Account created. Confirm <email> from the email just sent to it, then sign in
below.` No account was created and no mail was sent. The user waits for an email
that will never arrive.

This is the failure mode `.claude/rules/agent-team.md` names as this codebase's
characteristic bug: a flag that records a success the code never achieved.

**The presentation.** The signed-out Team page reads as a form bolted to a
dashboard: an amber warning banner, two paragraphs of explanation, and a
heading, all above the fields. It carries no product mark, the type is the
dashboard's dense 12px scale, and the primary and secondary actions sit side by
side as equals. On a screen whose entire job is to be trusted with a password,
it looks provisional.

## Goals

1. A sign-up against a registered email says so, and puts the user one keystroke
   from signing in.
2. The signed-out state is a designed, centered, single-purpose screen.
3. A minimum password length, and live feedback on password strength.
4. No password ever reaches React state, a query key, a URL, or an error string.

## Non-goals

- A two-step email-then-password flow. It requires an endpoint that reports
  whether an address is registered *before* any password is offered, which is a
  standing enumeration surface rather than a one-per-sign-up disclosure.
- Replacing the password heuristic with zxcvbn. ~400kb of bundle for a hint.
- Password reset, or any change to the OAuth round trip.

---

## Part 1 — The daemon tells three outcomes apart

### `lib/teamsync.js`

`signup()` currently distinguishes two outcomes. It learns a third.

| Backend response | Meaning | Returns |
|---|---|---|
| `200`, `access_token` present | Account created and signed in | credentials (unchanged) |
| `200`, no session, `identities` is an empty array | **Address already registered** | `{ emailExists: true, email }` |
| `200`, no session, `identities` non-empty or absent | Genuinely awaiting confirmation | `{ needsConfirmation: true, email }` (unchanged) |
| `400`/`422`, message matches `user_already_exists` or `already registered` | **Address already registered** | `{ emailExists: true, email }` |

Two distinct signals reach the same outcome because which one the backend sends
depends on a project setting this repo does not control: with email confirmation
**on** GoTrue obfuscates and returns the empty-`identities` 200; with it **off**
it rejects outright. Handling only one leaves the bug live under the other
setting.

The empty-`identities` check must be `Array.isArray(identities) && length === 0`.
A missing field is not evidence of anything and must fall through to
`needsConfirmation`, which is the behaviour that exists today.

The `400`/`422` branch requires `authRequest` to keep throwing as it does; the
existing `Object.assign(new Error(msg), { status })` already carries what the
matcher needs.

### `lib/server.js`

`POST /api/team/signup` answers `200 { emailExists: true, email }`.

**Why 200 and not 409.** This is an ordinary outcome of submitting the form,
structurally identical to `needsConfirmation`, which is already a 200. It
extends a union the client contract already models rather than introducing an
error path that has to carry a machine-readable code through
`postReadingError`. The response never includes `needsConfirmation: true`
alongside it — the two are mutually exclusive.

### Disclosure note

This endpoint now confirms to its caller that an address is registered. The
endpoint is loopback-only and reachable only with a password attempt attached,
and any local process can already put the same question to the backend directly
using the anon key baked into the build. The disclosure is therefore to the
person at the keyboard, which is the entire point of the change.

---

## Part 2 — `DataClient` contract

`signUp` returns a discriminated union rather than a bag of booleans, so an
unhandled outcome is a type error rather than a silent fall-through:

```ts
type SignUpResult =
  | { status: 'signed-in' }
  | { status: 'needs-confirmation'; email: string }
  | { status: 'email-exists'; email: string }

signUp(credentials: { displayName: string; email: string; password: string }): Promise<SignUpResult>
```

`LocalDaemonClient.signUp` maps the daemon's booleans to the union, checking
`emailExists` **first** so a daemon that ever sent both cannot report the wrong
one. `FakeDataClient` gains one already-registered address so the third outcome
is reachable in tests and in fixture mode; that address is exported as a named
constant, not duplicated as a string literal in each test.

The credentials rule stands: `password` travels from the submit handler through
`mutationFn` into the client and no further. It is not in the resolved value.

---

## Part 3 — The screen

### Structure

`SignInCard` is lifted out of `TeamPage.tsx` into
`ui/src/features/team/AuthScreen.tsx`. `TeamPage.tsx` is 587 lines and the auth
block is about to roughly double; it is also the one part of that file with no
dependency on team state. When `authenticated: false`, `TeamPage` renders
`<AuthScreen>` **alone** — no page title, no `.team-card` chrome, no rail
context beyond what the shell already draws.

### Layout

Centered in the viewport, one column at `max-width: 400px`:

```
              ⋈  MemBridge

                Sign in
        to continue to MemBridge

   Email
   [                              ]
   Password
   [                              ]
   ▰▰▰▱  Good · add a symbol

   Create account       ( Sign in )

   ──────────  or  ──────────

     [ ] Continue with GitHub

   MemBridge works solo too — your memory
   stays on this machine either way.
```

- `MembridgeMark` at ~22px with the product name beside it, as a lockup rather
  than a large standalone logo — the mark's artwork is drawn for small sizes.
- Heading `Sign in` / `Create your account`; subhead `to continue to MemBridge`
  / `to share memory with your team`.
- Inputs ~38px tall, labels above.
- Primary action right-aligned and filled; secondary is a text link on the left.
  They are no longer two equal-weight buttons.
- Pill radius (`999px`) on both buttons, local to this screen. The app's `--r`
  is 7px and stays 7px everywhere else.

### Type scale

Auth-local sizes in `auth.css`, not new global tokens. The global scale tops out
at `--fs-xl: 19px`, which is correct for a dense dashboard and too small for a
sign-in heading. Only the heading, subhead and inputs step up; every colour,
radius token, spacing token and motion token comes from `tokens.css` unchanged.

### Labels above inputs, not floating

Floating labels are the visual detail most associated with Google's form, and
they are rejected here. They require per-field JS state tracking focus and
filled-ness, and browser password managers routinely autofill without firing the
events that state depends on, leaving the label overlapping the value. The one
thing that must not break on this screen is autofill.

### The amber banner is removed

The `You are signed out. Team sync, shared memory and invites all need an
account.` banner exists because a signed-out machine used to render identically
to a signed-in machine with no team, which is how a silent sign-out went
unnoticed. A full-screen, single-purpose auth screen cannot be confused with the
team screen, so the banner's reason to exist is gone. The solo/local-first
sentence survives, demoted to a footer line under the card, where an actual
invitee is not made to read past it.

### GitHub

Below the form under an `or` divider, matching the approved layout: the email
form is the primary path and alternatives sit beneath it. A new
`ui/src/assets/GitHubMark.tsx` alongside `MembridgeMark.tsx` — inlined SVG,
16px, `fill="currentColor"` so it inverts with the theme, `aria-hidden` since
the button already carries the text. It stays an `<a>` to
`/team/oauth/github`, since that is a real navigation into a 302.

---

## Part 4 — Password rules

### Minimum length

**8 characters, on sign-up only**, as a submit-time guard that shows
`Use at least 8 characters.` and does not call the mutation.

Deliberately *not* the `minLength` attribute. Native constraint validation
blocks the submit in a browser with the browser's own tooltip while jsdom does
not enforce it at all, so the wording users see would differ from the wording
the tests assert and the JS guard would be dead code in production. One rule,
one message, one place.

Sign-in never length-checks. An account created before this rule, or through
GitHub OAuth, must still be able to sign in with whatever it has. A client-side
minimum on the sign-in field would lock out real users to no benefit.

The backend remains the authority — if the Supabase project ever requires more
than 8, its rejection renders verbatim like every other daemon error.

### Strength meter

Under the password field, **sign-up only**: four segments, a one-word verdict,
and one actionable hint.

| Score | Word | Segments filled |
|---|---|---|
| 0 | Weak | 1 |
| 1 | Fair | 2 |
| 2 | Good | 3 |
| 3 | Strong | 4 |

Advisory, not blocking. Only the 8-character minimum prevents submission; a
`Weak` password of 8 characters submits. A meter that blocks becomes a puzzle,
and users solve puzzles with `Password1!`.

### The constraint that dictates the implementation

`TeamPage.tsx` carries a file-level rule: the password is read from the DOM at
submit time and is never held in component state. A live meter appears to
require exactly that.

It does not. The `onChange` handler reads `event.target.value`, passes it to a
pure scorer, and stores **only the returned integer and hint** in state. The
string is never assigned to state, never closed over beyond the synchronous
call, and never rendered. The rule is copied verbatim into `AuthScreen.tsx` with
this consequence spelled out, because the next person to touch the meter is the
one most likely to break it.

### Scoring

`ui/src/features/team/passwordStrength.ts`, one exported pure function:

```ts
export function scorePassword(pw: string): { score: 0 | 1 | 2 | 3; hint: string }
```

Length-dominant, with character-class variety as a secondary term — length is
the term that actually correlates with resistance to offline guessing. It stays
deterministic and dependency-free so it can be unit-tested as a table.

The hint names the single highest-value next move (`Add another word`,
`Mix in a number or symbol`), never a list of rules.

---

## Part 5 — Existing-email behaviour

On `{ status: 'email-exists' }`:

1. Notice: **`That email already has an account.`** followed by
   `Sign in below to continue.`
2. The form switches to sign-in mode.
3. The email stays in its field — it was correct, it just meant something else.
4. Focus moves to the password field.

Styled as a notice, not an error: red is for something the user did wrong or the
system failed at, and this is neither.

The password field is cleared by the existing `finally` on submit, which already
runs on every path.

---

## Part 6 — Testing

Per `.claude/rules/testing.md`, verify only what this touches.

| Area | Test |
|---|---|
| `passwordStrength.ts` | `passwordStrength.test.ts` — table over lengths and class mixes, boundaries at each score step, empty string, very long string |
| `AuthScreen.tsx` | `AuthScreen.test.tsx` — existing-email path end to end through `FakeDataClient`: message shown, mode is sign-in, email retained, password field focused. Plus: sub-8 sign-up blocked without calling the mutation, sign-in of a short password not blocked, meter moves on typing, and the typed password appears in no rendered output |
| `DataClient` contract | `LocalDaemonClient.contract.test.ts` extended for the third `signUp` outcome |
| `teamsync.signup` | New suite `test/suites/signup-email-exists.test.js` (new tests go in `test/suites/`, never the monolith) covering all four rows of the Part 1 table, including that absent `identities` still yields `needs-confirmation` |

Commands:

```
cd ui && npx tsc --noEmit
cd ui && npx vitest run src/features/team/ src/data/LocalDaemonClient.contract.test.ts
node test/run.js signup-email-exists
```

Any UI failure goes through `node scripts/verify-finding.js` before it is
believed, per the repo's phantom-failure rule.

## Risks

- **The `identities` signal is a GoTrue implementation detail.** If it changes,
  the bug silently returns in its original form. The daemon test asserts the
  mapping directly, so the assumption is written down and executable rather
  than implicit.
- **The pill radius and larger type are local overrides.** They are confined to
  `auth.css` on a screen that exists nowhere else in the app; if the design
  system later grows real tokens for them, this is one file to reconcile.
