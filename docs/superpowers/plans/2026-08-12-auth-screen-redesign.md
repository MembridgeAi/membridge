# Auth Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a sign-up against an already-registered email say so and hand the user to sign-in, and rebuild the signed-out Team screen as a centered, single-purpose auth screen with a password minimum and a live strength meter.

**Architecture:** `teamsync.signup()` gains a third outcome (`emailExists`) distinguished by two GoTrue signals; the daemon surfaces it as a 200 field; `DataClient.signUp` becomes a discriminated union so an unhandled outcome is a compile error; the signed-out UI moves out of `TeamPage.tsx` into a standalone `AuthScreen` with its own stylesheet.

**Tech Stack:** Node 22 daemon (CommonJS, `lib/`), React 18 + TypeScript + Vite (`ui/`), vitest + Testing Library, custom Node test harness (`test/suites/*.test.js`).

**Spec:** [docs/superpowers/specs/2026-08-12-auth-screen-redesign-design.md](../specs/2026-08-12-auth-screen-redesign-design.md)

## Global Constraints

- **Never commit to `master`, never push, never merge.** Work happens on `feat/auth-screen-redesign` in the worktree `.claude/worktrees/auth-screen`. A human lands it.
- **Never run the full test suite.** No bare `node test/run.js`, no bare `cd ui && npx vitest run`. Both are blocked by a hook. Run only the named suites and files in each task.
- **A UI test failure is not a bug until verified.** Re-run any failure with `node scripts/verify-finding.js --ui <file> --runs 3` before believing it. Exit 3 = PHANTOM, drop it and move on; never change code to satisfy one.
- **CREDENTIALS RULE (whole plan):** the password is read from the DOM at submit time or from `event.target.value` in a change handler, and is never assigned to React state, never put in a query key, never interpolated into a URL, and never added to an error message. A scorer may receive it as an argument; only the returned integer and hint may be stored.
- **Minimum password length is exactly `8`**, defined once as `MIN_PASSWORD_LENGTH` in `ui/src/features/team/passwordStrength.ts` and imported everywhere else. Never retyped as a literal.
- **Copy is fixed, verbatim:** the existing-email notice is `That email already has an account.` followed by `Sign in below to continue.` The short-password message is `Use at least 8 characters.` The strength words are exactly `Weak`, `Fair`, `Good`, `Strong`.
- **Design tokens:** every colour, spacing, radius and motion value comes from `ui/src/styles/tokens.css`. The only new hard values allowed are the auth-local heading/subhead font sizes and the `999px` pill radius, and they live only in `ui/src/features/team/auth.css`.
- **New Node tests go in `test/suites/`**, never in the `test/run-tests.js` monolith.

---

### Task 1: The password strength scorer

A pure, dependency-free function. It exists on its own because it is the one piece of this feature that can be tested as a table, and because keeping it out of the component is what lets the component score a password without ever holding one.

**Files:**
- Create: `ui/src/features/team/passwordStrength.ts`
- Test: `ui/src/features/team/passwordStrength.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const MIN_PASSWORD_LENGTH = 8`
  - `export type PasswordScore = 0 | 1 | 2 | 3`
  - `export interface PasswordStrength { score: PasswordScore; hint: string }`
  - `export function scorePassword(pw: string): PasswordStrength`
  - `export function strengthWord(score: PasswordScore): string`

- [ ] **Step 1: Write the failing test**

Create `ui/src/features/team/passwordStrength.test.ts`:

```ts
// The scorer is a table, so it is tested as one. Length is the dominant term
// on purpose: length is what actually resists offline guessing, and a scorer
// that rewards `P@ssw0rd` over `correct horse battery` teaches the wrong move.
import { describe, it, expect } from 'vitest'
import { MIN_PASSWORD_LENGTH, scorePassword, strengthWord } from './passwordStrength'

describe('scorePassword', () => {
  it('says nothing at all about an empty field', () => {
    // No score, no hint: a meter that scolds before a single keystroke is noise.
    expect(scorePassword('')).toEqual({ score: 0, hint: '' })
  })

  it.each([
    ['abc'],
    ['abcdefg'],
  ])('names the minimum for %s, which is too short to score', pw => {
    expect(scorePassword(pw)).toEqual({ score: 0, hint: 'Use at least 8 characters.' })
  })

  it.each([
    // password,             score, hint
    ['abcdefgh',                 0, 'Add another word — length matters most.'],
    ['Abcdef1!',                 1, 'Add another word — length matters most.'],
    ['abcdefghijkl',             1, 'Mix in a number or symbol.'],
    ['Abcdefghijk1',             2, 'Add another word — length matters most.'],
    ['abcdefghijklmnop',         2, 'Mix in a number or symbol.'],
    ['Abcdefghijklmno1',         3, ''],
  ])('scores %s as %i', (pw, score, hint) => {
    expect(scorePassword(pw as string)).toEqual({ score, hint })
  })

  it('never exceeds the top of the scale, however long the input', () => {
    expect(scorePassword(`Aa1!${'x'.repeat(500)}`).score).toBe(3)
  })

  it('exports the minimum as a number other modules can import', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8)
  })
})

describe('strengthWord', () => {
  it('maps every score to its word', () => {
    expect([0, 1, 2, 3].map(s => strengthWord(s as 0 | 1 | 2 | 3)))
      .toEqual(['Weak', 'Fair', 'Good', 'Strong'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ui && npx vitest run src/features/team/passwordStrength.test.ts
```

Expected: FAIL — `Failed to resolve import "./passwordStrength"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/features/team/passwordStrength.ts`:

```ts
/** Password strength, scored locally and deterministically.
 *
 *  Deliberately NOT zxcvbn: ~400kb of dictionary shipped into an Electron
 *  bundle to render one word and one hint. This is advisory feedback, not a
 *  gate — the only thing that blocks a sign-up is MIN_PASSWORD_LENGTH.
 *
 *  Length is the dominant term and character variety is secondary, because
 *  length is what actually costs an offline attacker and variety is what
 *  users satisfy with a trailing `1!`. A scorer that inverted those weights
 *  would score `P@ssw0rd` above `correct horse battery staple`.
 *
 *  CREDENTIALS: this function RECEIVES a password as an argument and returns
 *  a number and a string. It stores nothing, closes over nothing, and must
 *  stay that way — it is what allows the meter to exist without the password
 *  ever entering React state. */

export const MIN_PASSWORD_LENGTH = 8

export type PasswordScore = 0 | 1 | 2 | 3

export interface PasswordStrength {
  score: PasswordScore
  /** The single highest-value next move, or '' when there is nothing useful
   *  left to say. Never a list of rules. */
  hint: string
}

const WORDS: readonly string[] = ['Weak', 'Fair', 'Good', 'Strong']

const LENGTHEN = 'Add another word — length matters most.'
const VARY = 'Mix in a number or symbol.'

/** How many of the four character classes appear at least once. */
function classCount(pw: string): number {
  let n = 0
  if (/[a-z]/.test(pw)) n += 1
  if (/[A-Z]/.test(pw)) n += 1
  if (/[0-9]/.test(pw)) n += 1
  if (/[^a-zA-Z0-9]/.test(pw)) n += 1
  return n
}

export function scorePassword(pw: string): PasswordStrength {
  // An untouched field is not "weak", it is unanswered.
  if (pw.length === 0) return { score: 0, hint: '' }
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return { score: 0, hint: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }
  }

  const classes = classCount(pw)
  let points = 0
  if (pw.length >= 12) points += 1
  if (pw.length >= 16) points += 1
  if (classes >= 3) points += 1

  const score = Math.min(3, points) as PasswordScore
  if (score === 3) return { score, hint: '' }
  if (pw.length < 12) return { score, hint: LENGTHEN }
  if (classes < 3) return { score, hint: VARY }
  return { score, hint: LENGTHEN }
}

export function strengthWord(score: PasswordScore): string {
  return WORDS[score]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ui && npx vitest run src/features/team/passwordStrength.test.ts
```

Expected: PASS, 6 tests.

If a row disagrees, trace it by hand before changing anything — `points` is `(len>=12) + (len>=16) + (classes>=3)`, capped at 3, and the hint falls through `score===3 → ''`, `len<12 → LENGTHEN`, `classes<3 → VARY`, else `LENGTHEN`. Change whichever of the two is actually wrong, not whichever is easier to edit.

- [ ] **Step 5: Typecheck**

```bash
cd ui && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add ui/src/features/team/passwordStrength.ts ui/src/features/team/passwordStrength.test.ts
git commit -m "feat(ui): length-dominant password scorer for the sign-up meter"
```

---

### Task 2: The daemon tells three sign-up outcomes apart

The defect itself. `signup()` reads an absent `access_token` as "confirmation pending", which is what GoTrue returns for an address that already has an account.

**Files:**
- Modify: `lib/teamsync.js` (the `signup` function at :217)
- Modify: `lib/server.js` (the `/api/team/signup` handler at :3201)
- Modify: `bin/membridge.js` (`cmdSignup` at :988, and the signup fallback inside `cmdJoin` at :1051)
- Test: `test/suites/signup-email-exists.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `teamsync.signup()` resolves one of three shapes —
  `{ emailExists: true, email }`, `{ needsConfirmation: true, email }`, or a
  credentials object (`{ userId, email, displayName, accessToken, … }`) as
  before. `POST /api/team/signup` answers
  `200 { emailExists: boolean, needsConfirmation: boolean, email: string }`.

- [ ] **Step 1: Write the failing test**

Create `test/suites/signup-email-exists.test.js`:

```js
'use strict';
// A sign-up against an address that already has an account used to report
// SUCCESS. teamsync.signup read the response like this:
//
//     const data = await authRequest(be, 'signup', { email, password });
//     if (!data.access_token) return { needsConfirmation: true, email };
//
// With email confirmation enabled, GoTrue answers a sign-up for a registered
// address with 200, a user object, and NO session — its deliberate
// anti-enumeration behaviour. The absent access_token was read as "account
// created, one step left", and the UI told the user to go and confirm an email
// that was never sent. This is the repo's characteristic bug: a flag recording
// a success the code never achieved.
//
// Two different signals mean the same thing, and WHICH one arrives depends on
// a Supabase project setting this repo does not control:
//   confirmation ON  -> 200, no session, user.identities === []
//   confirmation OFF -> 400/422, msg 'User already registered'
// Handling one and not the other leaves the bug live under the other setting,
// so both are pinned here.
//
// The fourth case is the regression guard: a response with NO identities field
// at all is not evidence of anything and must still mean needs-confirmation,
// which is the behaviour that shipped.
//
// Run directly, or via `node test/run.js signup-email-exists`.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, P, startJsonMock } = h;
const assert = require('assert');
const util = require('../../lib/util');
const teamsync = require('../../lib/teamsync');

const MOCK_PORT = P(71);

// One stub auth endpoint whose /auth/v1/signup answer is swapped per case.
// A hand-rolled mock rather than test/mock-supabase.js on purpose: that mock
// models only the confirmation-OFF rejection, and teaching it a second mode
// would change behaviour under every suite that shares it.
let respond = () => [200, {}];

async function main() {
  const srv = await startJsonMock(MOCK_PORT, (req, body, send) => {
    const [code, payload] = respond(body);
    send(code, payload);
  });
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  util.ensureConfig();

  // --- confirmation ON, address already registered -------------------------
  respond = body => [200, {
    id: '00000000-0000-0000-0000-000000000001',
    email: body.email,
    // The whole signal: a real new user carries at least one identity.
    identities: [],
  }];
  let r = await teamsync.signup(util.getConfig(), 'taken@test.dev', 'pw-taken', 'Taken');
  check('obfuscated 200 with empty identities reports the address is taken',
    r.emailExists === true && r.email === 'taken@test.dev' && !r.needsConfirmation);

  // --- confirmation OFF, address already registered ------------------------
  respond = () => [400, { msg: 'User already registered' }];
  r = await teamsync.signup(util.getConfig(), 'taken2@test.dev', 'pw-taken2', 'Taken2');
  check('a 400 "User already registered" reports the address is taken',
    r.emailExists === true && r.email === 'taken2@test.dev');

  // --- genuinely awaiting confirmation -------------------------------------
  respond = body => [200, {
    id: '00000000-0000-0000-0000-000000000002',
    email: body.email,
    identities: [{ id: 'ident-1', provider: 'email' }],
  }];
  r = await teamsync.signup(util.getConfig(), 'fresh@test.dev', 'pw-fresh', 'Fresh');
  check('a new account with one identity and no session still needs confirmation',
    r.needsConfirmation === true && !r.emailExists);

  // --- REGRESSION GUARD: no identities field at all ------------------------
  // Absent is not empty. A backend that simply does not send the field must
  // not be read as "this address is taken" -- that would turn every
  // confirmation-pending sign-up into a dead end.
  respond = body => [200, { id: '00000000-0000-0000-0000-000000000003', email: body.email }];
  r = await teamsync.signup(util.getConfig(), 'nofield@test.dev', 'pw-nf', 'NoField');
  check('a response with no identities field still means needs-confirmation',
    r.needsConfirmation === true && !r.emailExists);

  // --- an unrelated failure is still an error ------------------------------
  respond = () => [500, { msg: 'upstream exploded' }];
  let threw = null;
  try {
    await teamsync.signup(util.getConfig(), 'boom@test.dev', 'pw-b', 'Boom');
  } catch (err) {
    threw = err;
  }
  check('a backend fault is not quietly reported as a taken address',
    threw !== null && /upstream exploded/.test(threw.message));

  srv.close();
  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node test/run.js signup-email-exists
```

Expected: FAIL — the first check fails, because today's `signup()` returns `{ needsConfirmation: true }` for the empty-`identities` response.

- [ ] **Step 3: Implement the three-outcome signup**

In `lib/teamsync.js`, directly above the existing `async function signup` (:217), add:

```js
// GoTrue reports "this address already has an account" in one of two ways, and
// which one arrives depends on the project's email-confirmation setting:
//
//   confirmation ON  -> 200, no session, and a user whose `identities` is an
//                       EMPTY ARRAY. This is deliberate anti-enumeration
//                       behaviour: the response is shaped like a fresh sign-up
//                       so a stranger cannot probe for registered addresses.
//   confirmation OFF -> 400/422 with 'User already registered'.
//
// Both are handled because this repo does not own that setting, and handling
// only one leaves a false "check your email" live under the other.
//
// ABSENT is not EMPTY. A response with no `identities` field is not evidence
// of anything and falls through to the confirmation path, which is what
// shipped before this function knew about any of it.
const ALREADY_REGISTERED = /already registered|user_already_exists/i;

function looksAlreadyRegistered(data) {
  const user = data && data.user ? data.user : data;
  const identities = user && user.identities;
  return Array.isArray(identities) && identities.length === 0;
}
```

Then replace the body of `signup` with:

```js
async function signup(config, email, password, displayName) {
  const be = backend(config);
  if (!be) throw new Error('team sync is not available in this build (no backend baked in)');
  let data;
  try {
    data = await authRequest(be, 'signup', { email, password });
  } catch (err) {
    // Only these two statuses, and only with a matching message: a 500 or a
    // network fault must stay an error rather than becoming a confident
    // (and wrong) statement about who holds this address.
    if ((err.status === 400 || err.status === 422) && ALREADY_REGISTERED.test(err.message || '')) {
      return { emailExists: true, email };
    }
    throw err;
  }
  // With email confirmation enabled Supabase returns a user but no session --
  // for a NEW account and for an existing one alike, which is why the
  // identities check sits inside this branch and not before it. A response
  // that DID issue a session is unambiguously a new account of ours.
  if (!data.access_token) {
    if (looksAlreadyRegistered(data)) return { emailExists: true, email };
    return { needsConfirmation: true, email };
  }
  const creds = sessionToCredentials(data, displayName);
  saveCredentials(creds);
  return creds;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node test/run.js signup-email-exists
```

Expected: PASS, 5 checks.

- [ ] **Step 5: Surface the outcome over HTTP**

In `lib/server.js`, in the `/api/team/signup` handler (:3201), replace the response line:

```js
      json(res, 200, { needsConfirmation: !!result.needsConfirmation, email: result.email });
```

with:

```js
      // 200 rather than 409: this is an ordinary outcome of submitting the
      // form, structurally identical to needsConfirmation, which is already a
      // 200. It extends a union the UI contract models rather than adding an
      // error path that has to carry a machine-readable code. The two flags
      // are mutually exclusive -- teamsync.signup never sets both.
      json(res, 200, {
        emailExists: !!result.emailExists,
        needsConfirmation: !!result.needsConfirmation,
        email: result.email,
      });
```

- [ ] **Step 6: Fix the two CLI callers that would now report false success**

Both predate this change and carry the same defect. In `bin/membridge.js` `cmdSignup` (:988), insert before the `needsConfirmation` branch:

```js
  if (r.emailExists) {
    die(`${email} already has an account. Run: membridge login --email ${email} --password ...`);
  }
```

And in `cmdJoin` (:1051), inside the `catch`, after the `signup` call and before the `needsConfirmation` branch:

```js
      if (r.emailExists) {
        die(`${email} already has an account, but that password was rejected. Check the password, or sign in from the MemBridge app.`);
      }
```

- [ ] **Step 7: Syntax-check the two files not covered by the suite**

```bash
node -c lib/server.js && node -c bin/membridge.js && node -c lib/teamsync.js
```

Expected: no output.

- [ ] **Step 8: Re-run the suite and one neighbour that exercises signup**

```bash
node test/run.js signup-email-exists && node test/run.js team-access-fallthrough
```

Expected: both PASS. The neighbour proves the happy path (`teamsync.signup` returning credentials against the shared mock) is untouched.

- [ ] **Step 9: Commit**

```bash
git add lib/teamsync.js lib/server.js bin/membridge.js test/suites/signup-email-exists.test.js
git commit -m "fix(auth): stop reporting a taken email as a created account

GoTrue answers a sign-up for a registered address with 200 and no
session when email confirmation is on, and signup() read the absent
access_token as 'confirmation pending'. The user was told to open a
mail that was never sent. Both of GoTrue's signals now map to an
explicit emailExists outcome, and the two CLI callers that would have
printed success for it are fixed alongside."
```

---

### Task 3: `signUp` becomes a discriminated union

The bug survived because "no session" and "no account" were both spelled as an absent boolean. A union makes an unhandled outcome a compile error.

**Files:**
- Modify: `ui/src/data/types.ts` (add `SignUpResult` beside `SignOutResult`)
- Modify: `ui/src/data/DataClient.ts:89-93`
- Modify: `ui/src/data/LocalDaemonClient.ts:333-341`
- Modify: `ui/src/data/FakeDataClient.ts:691-693`
- Modify: `ui/src/features/team/TeamPage.tsx:62-70` (call site, minimally — Task 6 rewrites it)
- Test: `ui/src/data/LocalDaemonClient.contract.test.ts:69` (extend)

**Interfaces:**
- Consumes: the daemon response shape from Task 2 — `{ emailExists, needsConfirmation, email }`.
- Produces:
  - `export type SignUpResult = { status: 'signed-in' } | { status: 'needs-confirmation'; email: string } | { status: 'email-exists'; email: string }`
  - `DataClient.signUp(...): Promise<SignUpResult>`
  - `FakeDataClient.REGISTERED_EMAIL` — a static string constant holding the one fixture address that reports `email-exists`.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/data/FakeDataClient.ts` nothing yet — first write the test that demands it. Create a new file `ui/src/data/signUpOutcomes.test.ts`:

```ts
// The three outcomes of a sign-up, as the UI contract models them. This exists
// because the shipped bug was a MISSING outcome: "no session" and "no account"
// were both spelled as an absent boolean, so the UI could not tell them apart
// and told users to confirm an email that was never sent.
import { describe, it, expect } from 'vitest'
import { FakeDataClient } from './FakeDataClient'

describe('DataClient.signUp outcomes', () => {
  it('reports a fresh address as awaiting confirmation', async () => {
    const c = new FakeDataClient({ authenticated: false })
    await expect(c.signUp({ displayName: 'A', email: 'fresh@acme.dev', password: 'long-enough-pw' }))
      .resolves.toEqual({ status: 'needs-confirmation', email: 'fresh@acme.dev' })
  })

  it('reports the fixture address that already has an account', async () => {
    const c = new FakeDataClient({ authenticated: false })
    await expect(c.signUp({ displayName: 'A', email: FakeDataClient.REGISTERED_EMAIL, password: 'long-enough-pw' }))
      .resolves.toEqual({ status: 'email-exists', email: FakeDataClient.REGISTERED_EMAIL })
  })

  it('exposes the registered fixture address as a constant, not a literal to copy', () => {
    expect(typeof FakeDataClient.REGISTERED_EMAIL).toBe('string')
    expect(FakeDataClient.REGISTERED_EMAIL).toContain('@')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ui && npx vitest run src/data/signUpOutcomes.test.ts
```

Expected: FAIL — `REGISTERED_EMAIL` does not exist on `FakeDataClient`.

- [ ] **Step 3: Add the type**

In `ui/src/data/types.ts`, beside the existing `SignOutResult`:

```ts
/** What a sign-up actually achieved. THREE outcomes, not two.
 *
 *  It was two, and that is exactly how the shipped bug happened: an absent
 *  session was read as "confirmation pending" when GoTrue also returns an
 *  absent session for an address that ALREADY has an account. A union means
 *  a caller that forgets one gets a compile error instead of showing the
 *  wrong sentence. */
export type SignUpResult =
  | { status: 'signed-in' }
  | { status: 'needs-confirmation'; email: string }
  | { status: 'email-exists'; email: string }
```

- [ ] **Step 4: Change the interface**

In `ui/src/data/DataClient.ts`, replace the `signUp` declaration and its comment (:89-93) with:

```ts
  // POST /api/team/signup. Three outcomes, and callers MUST handle all three:
  // 'needs-confirmation' is a real state rather than a failure (silence there
  // reads as a rejected sign-up), and 'email-exists' is what the daemon says
  // when the address already has an account -- which used to be reported as
  // 'needs-confirmation' and sent people to wait for mail that never came.
  signUp(credentials: { displayName: string; email: string; password: string }): Promise<SignUpResult>
```

Add `SignUpResult` to the existing `import type { … } from './types'` list at the top of the file.

- [ ] **Step 5: Map the daemon response**

In `ui/src/data/LocalDaemonClient.ts`, replace the `signUp` method (:333-341):

```ts
  async signUp(credentials: { displayName: string; email: string; password: string }): Promise<SignUpResult> {
    const r = await postReadingError<{ emailExists?: boolean; needsConfirmation?: boolean; email: string }>('/api/team/signup', {
      email: credentials.email, password: credentials.password, displayName: credentials.displayName,
    })
    this.requestCache.clear()
    // emailExists is checked FIRST. The two are mutually exclusive coming out
    // of the daemon, and if a future one ever sent both, "this address is
    // taken" is the answer that leaves the user able to act.
    if (r.emailExists) return { status: 'email-exists', email: r.email }
    if (r.needsConfirmation) return { status: 'needs-confirmation', email: r.email }
    return { status: 'signed-in' }
  }
```

Add `SignUpResult` to this file's `import type … from './types'` list.

- [ ] **Step 6: Teach the fixture the third outcome**

In `ui/src/data/FakeDataClient.ts`, replace the `signUp` method (:691-693):

```ts
  /** The one fixture address that already has an account. A constant rather
   *  than a literal repeated per test, so a test cannot silently drift onto a
   *  different address and start exercising the fresh-signup path instead. */
  static readonly REGISTERED_EMAIL = 'taken@acme.dev'

  // needs-confirmation is the DEFAULT fixture answer on purpose -- it is what
  // a real Supabase project with email confirmation on returns, and the state
  // a UI is most likely to forget to render.
  signUp(credentials: { displayName: string; email: string; password: string }) {
    if (credentials.email.toLowerCase() === FakeDataClient.REGISTERED_EMAIL) {
      return this.guard<SignUpResult>({ status: 'email-exists', email: credentials.email })
    }
    return this.guard<SignUpResult>({ status: 'needs-confirmation', email: credentials.email })
  }
```

Add `SignUpResult` to this file's type imports.

- [ ] **Step 7: Keep the existing call site compiling**

In `ui/src/features/team/TeamPage.tsx`, replace the sign-up branch inside `submit` (:62-70):

```ts
      if (mode === 'signup') {
        const result = await signUp.mutateAsync({ displayName, email, password })
        if (result.status === 'needs-confirmation') {
          setNotice(`Account created. Confirm ${result.email} from the email just sent to it, then sign in below.`)
          setMode('signin')
        } else if (result.status === 'email-exists') {
          setNotice('That email already has an account. Sign in below to continue.')
          setMode('signin')
        }
      } else {
```

This is deliberately minimal — Task 6 rebuilds this handler in `AuthScreen.tsx`. It exists so this task lands green on its own.

- [ ] **Step 8: Extend the contract test**

In `ui/src/data/LocalDaemonClient.contract.test.ts`, the `signUp` entry (:69) already reads `c => c.signUp({ displayName: 'A', email: 'a@b.dev', password: 'fixture-only' })` and needs no change — it exercises the request, not the outcome. Verify by running it; if the file asserts on the resolved shape anywhere, update that assertion to the union.

- [ ] **Step 9: Run the tests and the typechecker**

```bash
cd ui && npx tsc --noEmit
cd ui && npx vitest run src/data/signUpOutcomes.test.ts src/data/LocalDaemonClient.contract.test.ts src/features/team/
```

Expected: `tsc` silent; all three test files PASS. If `tsc` reports another `signUp` consumer this plan did not name, handle it the same way as Step 7 and note it in the commit body.

- [ ] **Step 10: Commit**

```bash
git add ui/src/data ui/src/features/team/TeamPage.tsx
git commit -m "refactor(ui): signUp resolves a three-outcome union

An absent boolean could not distinguish 'awaiting confirmation' from
'this address is taken', which is how the wrong sentence reached the
screen. A union makes an unhandled outcome a type error."
```

---

### Task 4: Extract `AuthScreen` and rebuild the layout

Structure and presentation only. No behaviour change beyond what moves.

**Files:**
- Create: `ui/src/features/team/AuthScreen.tsx`
- Create: `ui/src/features/team/auth.css`
- Create: `ui/src/assets/GitHubMark.tsx`
- Create: `ui/src/features/team/AuthScreen.test.tsx`
- Modify: `ui/src/features/team/TeamPage.tsx` (delete `SignInCard`, render `<AuthScreen>`)
- Modify: `ui/src/features/team/TeamPage.test.tsx` (the signed-out assertions)

**Interfaces:**
- Consumes: `SignUpResult` (Task 3), `useSignIn` / `useSignUp` from `../../data/queries`.
- Produces: `export function AuthScreen({ configured }: { configured: boolean })`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/features/team/AuthScreen.test.tsx`:

```tsx
// The signed-out screen. It is a whole screen rather than a card on the Team
// page because its job -- being trusted with a password -- is not served by
// sitting under a dashboard title with an amber warning above it.
import { describe, it, expect, afterEach } from 'vitest'
import { screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { AuthScreen } from './AuthScreen'

afterEach(cleanup)

describe('AuthScreen', () => {
  it('leads with the product, the action, and what the action is for', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText('to continue to MemBridge')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'MemBridge' })).toBeInTheDocument()
  })

  it('offers GitHub as a real navigation, not a fetch', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    const link = await screen.findByRole('link', { name: /continue with github/i })
    expect(link).toHaveAttribute('href', '/team/oauth/github')
  })

  it('switches to sign-up and back, and the switch is a link, not a second button', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    // The name field only exists on the sign-up side.
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /sign in instead/i }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/your name/i)).toBeNull()
  })

  it('still says the build has no backend when it has none', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured={false} />)
    expect(await screen.findByText(/no team service to sign in to/i)).toBeInTheDocument()
  })

  it('keeps the solo promise on screen, below the form rather than above it', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    expect(await screen.findByText(/works solo too/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ui && npx vitest run src/features/team/AuthScreen.test.tsx
```

Expected: FAIL — `Failed to resolve import "./AuthScreen"`.

- [ ] **Step 3: Create the GitHub mark**

Create `ui/src/assets/GitHubMark.tsx`:

```tsx
interface GitHubMarkProps {
  className?: string
}

/** The GitHub Octocat mark, inlined for the same reasons MembridgeMark is
 *  (see that file): no dependency on Vite's asset-inlining threshold and no
 *  dependency on `data:` URIs surviving the packaged shell's CSP.
 *
 *  `fill="currentColor"` rather than a fixed brand black, because this one
 *  sits INSIDE a button whose text colour flips between themes -- a fixed
 *  black mark would vanish against the dark theme's panel.
 *
 *  aria-hidden: the button it sits in already reads "Continue with GitHub",
 *  and a second accessible name here would announce the word twice. */
export function GitHubMark({ className }: GitHubMarkProps) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}
```

- [ ] **Step 4: Create `AuthScreen.tsx`**

Create `ui/src/features/team/AuthScreen.tsx`. Move the body of `SignInCard` from `TeamPage.tsx` (:42-164) and restructure it:

```tsx
import { useState, type FormEvent } from 'react'
import { GitHubMark } from '../../assets/GitHubMark'
import { MembridgeMark } from '../../assets/MembridgeMark'
import { useSignIn, useSignUp } from '../../data/queries'
import './auth.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// CREDENTIALS RULE for this whole file: a password is read from the submitted
// form at submit time, handed to the mutation, and the field is emptied in the
// same handler's finally. It is never held in component state (which would
// outlive the submit and land in every subsequent render), never put in a
// query key, never interpolated into a URL, and never added to an error
// message -- daemon errors render exactly as the daemon worded them.
function clearPassword(form: HTMLFormElement): void {
  const field = form.elements.namedItem('password')
  if (field instanceof HTMLInputElement) field.value = ''
}

/** The signed-out state, as a whole screen.
 *
 *  It used to be a card inside the Team page, under the page title and an
 *  amber "you are signed out" banner. That banner existed because a signed-out
 *  machine rendered IDENTICALLY to a signed-in machine with no team, which is
 *  how a silent sign-out went unnoticed. This screen cannot be confused with
 *  the team screen -- it replaces the page entirely -- so the banner's reason
 *  to exist is gone and it is not carried over.
 *
 *  The solo/local-first promise survives as a footer line: an invitee arriving
 *  with a link should not have to read past a pitch to find the form. */
export function AuthScreen({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const signIn = useSignIn()
  const signUp = useSignUp()
  const pending = signIn.isPending || signUp.isPending
  const isSignUp = mode === 'signup'

  async function submit(event: FormEvent<HTMLFormElement>) {
    // Captured before the first await: React clears currentTarget once the
    // handler yields, and the finally below still needs the form.
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const email = String(data.get('email') || '').trim()
    const password = String(data.get('password') || '')
    const displayName = String(data.get('displayName') || '').trim()
    setError(null)
    setNotice(null)
    try {
      if (isSignUp) {
        const result = await signUp.mutateAsync({ displayName, email, password })
        if (result.status === 'needs-confirmation') {
          setNotice(`Account created. Confirm ${result.email} from the email just sent to it, then sign in below.`)
          setMode('signin')
        } else if (result.status === 'email-exists') {
          setNotice('That email already has an account. Sign in below to continue.')
          setMode('signin')
        }
      } else {
        await signIn.mutateAsync({ email, password })
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      clearPassword(form)
    }
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <MembridgeMark className="auth-brand-mark" />
          <span className="auth-brand-name" aria-hidden="true">MemBridge</span>
        </div>

        <h1 className="auth-heading">{isSignUp ? 'Create your account' : 'Sign in'}</h1>
        <p className="auth-subhead">
          {isSignUp ? 'to share memory with your team' : 'to continue to MemBridge'}
        </p>

        {!configured && (
          <p className="auth-note">
            This copy of MemBridge has no team service to sign in to, so sign-in won't work here.
          </p>
        )}
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}

        {/* Uncontrolled on purpose: the password lives in the DOM field for
            the moment it takes to submit, never in React state. */}
        <form className="auth-form" onSubmit={submit}>
          {isSignUp && (
            <div className="auth-field">
              <label htmlFor="auth-name">Your name</label>
              <input id="auth-name" name="displayName" type="text" autoComplete="name" required />
            </div>
          )}
          <div className="auth-field">
            <label htmlFor="auth-email">Email</label>
            <input id="auth-email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="auth-field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password" name="password" type="password"
              autoComplete={isSignUp ? 'new-password' : 'current-password'} required
            />
          </div>

          {/* The secondary action is a text link and the primary is a filled
              pill, sitting apart. They used to be two adjacent bordered
              buttons of equal weight, which made "I already have an account"
              read as an alternative way to submit the form. */}
          <div className="auth-actions">
            <button
              type="button" className="auth-link"
              onClick={() => { setMode(isSignUp ? 'signin' : 'signup'); setError(null); setNotice(null) }}
            >
              {isSignUp ? 'Sign in instead' : 'Create account'}
            </button>
            <button type="submit" className="auth-submit" disabled={pending}>
              {isSignUp ? 'Create account' : 'Sign in'}
            </button>
          </div>
        </form>

        <div className="auth-divider"><span>or</span></div>

        {/* GitHub is the ONLY method the hosted onboarding page offers
            (cloudflare/join), so anyone who arrived that way has an account
            with no password and could not sign in here at all while this card
            was email-only. A plain anchor, not a fetch: /team/oauth/github is
            a 302 into GitHub's consent screen, and the daemon's callback page
            finishes the exchange and links back here. */}
        <a className="auth-oauth" href="/team/oauth/github">
          <GitHubMark className="auth-oauth-mark" />
          Continue with GitHub
        </a>
      </div>

      <p className="auth-footnote">
        MemBridge works solo too — your memory stays on this machine either way.
        Sign in only if you want to share it with a team.
      </p>
    </main>
  )
}
```

- [ ] **Step 5: Create `auth.css`**

Create `ui/src/features/team/auth.css`:

```css
/* The signed-out screen. Same house rules as every other stylesheet here:
 * tokens from styles/tokens.css, no shadows on resting content, no gradients,
 * hover changes background/border only.
 *
 * TWO deliberate local exceptions, both confined to this file because this
 * screen exists nowhere else in the app:
 *   1. Type steps up. The global scale tops out at --fs-xl (19px), which is
 *      right for a dense dashboard and too small for a sign-in heading.
 *   2. Pill radius on the buttons. --r stays 7px everywhere else. */

.auth-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: var(--sp-6) var(--sp-4);
  gap: var(--sp-5);
}

.auth-card {
  width: 100%;
  max-width: 400px;
  padding: var(--sp-6) var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--panel);
  text-align: center;
}
@media (prefers-reduced-motion: no-preference) {
  .auth-card { animation: settle-in var(--dur-base) var(--ease-out) both; }
}

.auth-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-5);
}
.auth-brand-mark { width: 22px; height: 22px; }
.auth-brand-name {
  font-size: var(--fs-lg);
  font-weight: var(--fw-medium);
  letter-spacing: -0.01em;
}

.auth-heading {
  margin: 0 0 var(--sp-1);
  font-size: 24px;
  font-weight: var(--fw-normal);
  line-height: var(--lh-tight);
  letter-spacing: -0.02em;
}
.auth-subhead {
  margin: 0 0 var(--sp-5);
  color: var(--text2);
  font-size: 14px;
  line-height: var(--lh-snug);
}

.auth-note,
.auth-notice,
.auth-error {
  margin: 0 0 var(--sp-4);
  text-align: left;
  font-size: var(--fs-base);
  line-height: var(--lh-snug);
}
.auth-note { color: var(--text2); }
.auth-notice {
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--accent);
  border-radius: var(--r);
  background: var(--accent-dim);
  color: var(--text);
}
.auth-error { color: var(--red); }

.auth-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  text-align: left;
}
.auth-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* Labels ABOVE the inputs, not Google's floating labels. Those need per-field
   JS state tracking focus and filled-ness, and password managers routinely
   autofill without firing the events that state depends on -- leaving the
   label sitting on top of the value. Autofill is the one thing on this screen
   that must not break. */
.auth-field label {
  color: var(--text2);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
}
.auth-field input {
  padding: 9px 12px;
  border: 1px solid var(--line2);
  border-radius: var(--r);
  background: var(--panel2);
  color: var(--text);
  font-family: var(--ui);
  font-size: 13px;
}
.auth-field input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.auth-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}
.auth-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-family: var(--ui);
  font-size: var(--fs-base);
  font-weight: var(--fw-medium);
}
.auth-link:hover { text-decoration: underline; }

.auth-submit {
  padding: 8px 22px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-family: var(--ui);
  font-size: var(--fs-base);
  font-weight: var(--fw-medium);
}
.auth-submit:hover {
  border-color: var(--accent2);
  background: var(--accent2);
}
.auth-submit:disabled { opacity: 0.5; }

.auth-divider {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: var(--sp-5) 0;
  color: var(--text3);
  font-size: var(--fs-sm);
}
.auth-divider::before,
.auth-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}

.auth-oauth {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 9px 16px;
  border: 1px solid var(--line2);
  border-radius: 999px;
  color: var(--text);
  font-size: var(--fs-base);
  font-weight: var(--fw-medium);
  text-decoration: none;
}
.auth-oauth:hover { background: var(--panel2); }
.auth-oauth-mark { flex: none; }

.auth-footnote {
  max-width: 400px;
  margin: 0;
  color: var(--text3);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
  text-align: center;
}
```

- [ ] **Step 6: Wire it into `TeamPage.tsx`**

Delete the entire `SignInCard` function (:38-164) and its now-unused imports (`useSignIn`, `useSignUp`, and `clearPassword` if nothing else in the file uses it — check `handleCreate` first). Add `import { AuthScreen } from './AuthScreen'`. Replace the render at :394:

```tsx
      {account && !account.authenticated && <AuthScreen configured={account.configured} />}
```

Leave every other state of the page untouched.

- [ ] **Step 7: Update the signed-out assertions in `TeamPage.test.tsx`**

The existing test at :23 asserts `screen.getByText(/signed out/i)` — the amber banner this task removes. Replace that test's body with:

```tsx
    renderWith(new FakeDataClient({ authenticated: false }), <TeamPage />)
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    // The point the old amber banner carried: signed out must not read like
    // "you just have no team". A whole dedicated screen now carries it --
    // there is no team UI on screen at all.
    expect(screen.getByText('to continue to MemBridge')).toBeInTheDocument()
    expect(screen.queryByLabelText(/team name/i)).toBeNull()
```

Then run the whole file and fix any other assertion that referenced the removed banner or the old `team-btn` labels (`I already have an account`, `Sign up`) — the sign-up toggle is now `Create account` and the reverse is `Sign in instead`.

- [ ] **Step 8: Run the tests and the typechecker**

```bash
cd ui && npx tsc --noEmit
cd ui && npx vitest run src/features/team/
```

Expected: `tsc` silent; all team test files PASS. Any failure gets `node scripts/verify-finding.js --ui src/features/team/<file> --runs 3` before you treat it as real.

- [ ] **Step 9: Commit**

```bash
git add ui/src/features/team ui/src/assets/GitHubMark.tsx
git commit -m "feat(ui): the signed-out state becomes a real auth screen

Centered single-purpose screen with the product mark, one heading, a
filled pill primary against a text-link secondary, and GitHub's own mark
on the OAuth button. The amber signed-out banner goes: it existed
because signed-out looked identical to signed-in-with-no-team, and a
screen that replaces the page cannot be confused with it."
```

---

### Task 5: Password minimum and the strength meter

**Files:**
- Modify: `ui/src/features/team/AuthScreen.tsx`
- Modify: `ui/src/features/team/auth.css`
- Modify: `ui/src/features/team/AuthScreen.test.tsx`

**Interfaces:**
- Consumes: `MIN_PASSWORD_LENGTH`, `scorePassword`, `strengthWord`, `PasswordScore` from Task 1; `AuthScreen` from Task 4.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/team/AuthScreen.test.tsx`:

```tsx
describe('AuthScreen password rules', () => {
  it('shows no meter on the sign-in side, where an old short password must still work', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signIn = vi.spyOn(client, 'signIn')
    renderWith(client, <AuthScreen configured />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'andrew@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'short')
    expect(screen.queryByTestId('auth-strength')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    // Not blocked: a client-side minimum on sign-in locks out real accounts
    // created before the rule, and every GitHub account, for no benefit.
    expect(signIn).toHaveBeenCalledWith({ email: 'andrew@acme.dev', password: 'short' })
  })

  it('refuses a short sign-up without calling the daemon, and says the minimum', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signUp = vi.spyOn(client, 'signUp')
    renderWith(client, <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(signUp).not.toHaveBeenCalled()
  })

  it('rates a typed sign-up password, and never renders the password itself', async () => {
    const { container } = renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    const secret = 'Abcdefghijklmno1'
    await userEvent.type(screen.getByLabelText(/password/i), secret)

    expect(await screen.findByTestId('auth-strength')).toHaveTextContent('Strong')
    // The password may live in the DOM field's value; it must appear nowhere
    // in rendered TEXT, which is what a state-held password would leak into.
    expect(container.textContent).not.toContain(secret)
  })

  it('submits a weak-but-long-enough password: the meter advises, it does not gate', async () => {
    const client = new FakeDataClient({ authenticated: false })
    const signUp = vi.spyOn(client, 'signUp')
    renderWith(client, <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'abcdefgh')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(signUp).toHaveBeenCalledWith({ displayName: 'Andrew', email: 'new@acme.dev', password: 'abcdefgh' })
  })
})
```

Add `vi` to this file's `vitest` import.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ui && npx vitest run src/features/team/AuthScreen.test.tsx
```

Expected: FAIL — no `auth-strength` element, and the short sign-up reaches `signUp`.

- [ ] **Step 3: Add the meter and the guard**

In `ui/src/features/team/AuthScreen.tsx`, add to the imports:

```tsx
import { MIN_PASSWORD_LENGTH, scorePassword, strengthWord, type PasswordScore } from './passwordStrength'
```

Add state beside the existing `notice`/`error`:

```tsx
  // ONLY the derived score and hint. The password itself is scored inside the
  // change handler from event.target.value and is never assigned to state --
  // that is the entire reason a live meter is compatible with the credentials
  // rule at the top of this file. Do not "simplify" this into a controlled
  // password input.
  const [strength, setStrength] = useState<{ score: PasswordScore; hint: string }>({ score: 0, hint: '' })
```

Add the submit guard as the first thing inside `try` in `submit`, before the `isSignUp` branch:

```tsx
      if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
        // Sign-UP only. An account created before this rule, or through GitHub
        // OAuth, must still be able to sign in with whatever it has.
        setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
        return
      }
```

The existing `finally` still runs and clears the field, which is correct — a rejected attempt should not leave the password sitting in the DOM.

**No `minLength` attribute on the input.** Native constraint validation would block the submit in a real browser with the browser's own tooltip, while jsdom does not enforce it at all — so the wording users see would differ from the wording the test asserts, and the JS guard above would be dead code in production. One rule, one message, enforced in one place.

Add `onChange` to the password input, sign-up only, and reset the meter when the mode flips:

```tsx
          <div className="auth-field">
            <label htmlFor="auth-password">Password</label>
            <input
              id="auth-password" name="password" type="password"
              autoComplete={isSignUp ? 'new-password' : 'current-password'} required
              onChange={isSignUp ? e => setStrength(scorePassword(e.target.value)) : undefined}
            />
            {isSignUp && <StrengthMeter score={strength.score} hint={strength.hint} />}
          </div>
```

In the mode-toggle button's `onClick`, add `setStrength({ score: 0, hint: '' })` alongside the existing resets.

Add the meter component above `AuthScreen` in the same file:

```tsx
/** Four segments, a word, and one actionable hint.
 *
 *  Advisory, never a gate: only MIN_PASSWORD_LENGTH blocks a submit. A meter
 *  that blocks becomes a puzzle, and users solve puzzles with `Password1!`.
 *
 *  The segments are aria-hidden and the word/hint carry the meaning, so a
 *  screen reader hears "Good, mix in a number or symbol" rather than counting
 *  four decorative divs. role="status" rather than "alert": this updates on
 *  every keystroke and must not interrupt. */
function StrengthMeter({ score, hint }: { score: PasswordScore; hint: string }) {
  return (
    <div className="auth-strength" data-testid="auth-strength" role="status">
      <div className="auth-strength-bar" aria-hidden="true">
        {[0, 1, 2, 3].map(i => (
          <span key={i} className={i <= score ? `auth-strength-seg is-${score}` : 'auth-strength-seg'} />
        ))}
      </div>
      <span className="auth-strength-word">{strengthWord(score)}</span>
      {hint && <span className="auth-strength-hint">{hint}</span>}
    </div>
  )
}
```

- [ ] **Step 4: Style the meter**

Append to `ui/src/features/team/auth.css`:

```css
/* Colour is NOT the only signal: the filled-segment count carries the same
   information, so the meter still reads with no colour perception at all. */
.auth-strength {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
  font-size: var(--fs-sm);
  line-height: var(--lh-snug);
}
.auth-strength-bar {
  display: flex;
  gap: 3px;
  flex: none;
}
.auth-strength-seg {
  width: 22px;
  height: 3px;
  border-radius: 999px;
  background: var(--line2);
}
.auth-strength-seg.is-0 { background: var(--red); }
.auth-strength-seg.is-1 { background: var(--amber); }
.auth-strength-seg.is-2 { background: var(--accent); }
.auth-strength-seg.is-3 { background: var(--green); }
.auth-strength-word {
  color: var(--text2);
  font-weight: var(--fw-medium);
}
.auth-strength-hint {
  color: var(--text3);
  flex: 1 1 100%;
}
```

- [ ] **Step 5: Run the tests and the typechecker**

```bash
cd ui && npx tsc --noEmit
cd ui && npx vitest run src/features/team/
```

Expected: `tsc` silent; all PASS. Verify any failure with `node scripts/verify-finding.js --ui src/features/team/AuthScreen.test.tsx --runs 3` before acting on it.

- [ ] **Step 6: Commit**

```bash
git add ui/src/features/team
git commit -m "feat(ui): 8-character minimum and a live strength meter on sign-up

The meter scores event.target.value and stores only the resulting
integer and hint, so the password still never enters React state. The
minimum applies to sign-up only -- an existing short password, or a
GitHub account with none, must still be able to sign in."
```

---

### Task 6: The existing-email path, end to end

The three preceding tasks make this possible; this one proves it works from the screen.

**Files:**
- Modify: `ui/src/features/team/AuthScreen.tsx` (focus handling on the switch)
- Modify: `ui/src/features/team/AuthScreen.test.tsx`

**Interfaces:**
- Consumes: `FakeDataClient.REGISTERED_EMAIL` (Task 3), `AuthScreen` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/features/team/AuthScreen.test.tsx`:

```tsx
describe('AuthScreen, signing up with an address that already has an account', () => {
  it('says so, switches to sign-in, keeps the email, and puts the cursor in the password', async () => {
    // The shipped bug: this path told the user "Account created. Confirm
    // <email> from the email just sent to it" -- no account was created and
    // no mail was sent, so they waited for something that never arrived.
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), FakeDataClient.REGISTERED_EMAIL)
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText(/That email already has an account\./)).toBeInTheDocument()
    expect(screen.getByText(/Sign in below to continue\./)).toBeInTheDocument()
    // Never the old sentence, on this path or any other.
    expect(screen.queryByText(/Account created/)).toBeNull()

    // The form is now sign-in, the email survived, and the password is where
    // the cursor is -- the email was correct, it just meant something else.
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toHaveValue(FakeDataClient.REGISTERED_EMAIL)
    expect(screen.getByLabelText(/password/i)).toHaveFocus()
    expect(screen.getByLabelText(/password/i)).toHaveValue('')
  })

  it('still tells a genuinely new account to go and confirm its email', async () => {
    renderWith(new FakeDataClient({ authenticated: false }), <AuthScreen configured />)
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/your name/i), 'Andrew')
    await userEvent.type(screen.getByLabelText(/email/i), 'brand-new@acme.dev')
    await userEvent.type(screen.getByLabelText(/password/i), 'long-enough-password')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText(/Account created\. Confirm brand-new@acme\.dev/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ui && npx vitest run src/features/team/AuthScreen.test.tsx
```

Expected: FAIL on the focus assertion (`password` does not have focus) — the notice and mode switch already work from Task 4, the email retention and focus do not.

- [ ] **Step 3: Keep the email and move the cursor**

In `ui/src/features/team/AuthScreen.tsx`, the email survives already because the form is uncontrolled and only the password field is cleared — confirm that by reading `clearPassword`, which touches `password` alone. If the test shows the email cleared, the cause is a `form.reset()` somewhere; remove it rather than re-populating the field.

For focus, add a ref:

```tsx
import { useRef, useState, type FormEvent } from 'react'
```

```tsx
  const passwordRef = useRef<HTMLInputElement>(null)
```

Put `ref={passwordRef}` on the password input, and in the `email-exists` branch, after `setMode('signin')`:

```tsx
          // The email was right; it just meant something else. Land the cursor
          // on the only field they still need to fill.
          passwordRef.current?.focus()
```

- [ ] **Step 4: Run the tests and the typechecker**

```bash
cd ui && npx tsc --noEmit
cd ui && npx vitest run src/features/team/ src/data/signUpOutcomes.test.ts
```

Expected: all PASS. Verify any failure in isolation before believing it.

- [ ] **Step 5: Re-run the daemon suite one last time**

```bash
node test/run.js signup-email-exists
```

Expected: PASS, 5 checks.

- [ ] **Step 6: Commit**

```bash
git add ui/src/features/team
git commit -m "feat(ui): a taken email switches to sign-in with the email kept

Closes the loop opened in the daemon: the screen names the outcome,
flips to sign-in, keeps the address that was already correct, and puts
the cursor in the password field."
```

---

## Done criteria

All of the following, run from the worktree root:

```bash
cd ui && npx tsc --noEmit
cd ui && npx vitest run src/features/team/ src/data/signUpOutcomes.test.ts src/data/LocalDaemonClient.contract.test.ts
node test/run.js signup-email-exists
node test/run.js team-access-fallthrough
node -c lib/teamsync.js && node -c lib/server.js && node -c bin/membridge.js
```

Then stop. A human lands the branch — do not push, merge, or open a PR.

## What this plan deliberately does not do

- **No two-step email-then-password flow.** It needs an endpoint that reports whether an address is registered before any password is offered, which is a standing enumeration surface rather than a one-per-attempt disclosure.
- **No zxcvbn.** ~400kb of bundle for one word and one hint.
- **No password reset, and no change to the OAuth round trip.** Both are real gaps; both are separate tickets.
- **No new global design tokens.** The larger type and pill radius stay local to `auth.css` until the design system grows real tokens for them.
