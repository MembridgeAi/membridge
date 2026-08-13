import { useRef, useState, type FormEvent } from 'react'
import { GitHubMark } from '../../assets/GitHubMark'
import { MembridgeMark } from '../../assets/MembridgeMark'
import { useSignIn, useSignUp } from '../../data/queries'
import { MIN_PASSWORD_LENGTH, scorePassword, strengthWord, type PasswordScore, type PasswordStrength } from './passwordStrength'
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
  // ONLY the derived score and hint. The password itself is scored inside the
  // change handler from event.target.value and is never assigned to state --
  // that is the entire reason a live meter is compatible with the credentials
  // rule at the top of this file. Do not "simplify" this into a controlled
  // password input.
  //
  // null is a distinct third state from "scored and weak": it means nothing
  // has been typed (or the field was just reset), and the meter must not
  // render at all in that state. scorePassword('') also answers
  // { score: 0, hint: '' } for an empty string, which is indistinguishable
  // from a *typed* password that happens to have no hint (score 3), so null
  // is the unambiguous signal for "there is nothing to score yet."
  const [strength, setStrength] = useState<PasswordStrength | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
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
      if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
        // Sign-UP only. An account created before this rule, or through GitHub
        // OAuth, must still be able to sign in with whatever it has.
        setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
        return
      }
      if (isSignUp) {
        const result = await signUp.mutateAsync({ displayName, email, password })
        // Exhaustive on SignUpResult['status'] by construction: the default
        // branch assigns to a `never`-typed variable, so a fourth outcome
        // added to SignUpResult (types.ts) fails `tsc --noEmit` here rather
        // than silently falling through with no notice, which is the exact
        // shape of the shipped bug this whole task closes.
        switch (result.status) {
          case 'signed-in':
            // Deliberate no-op: the sign-up mutation's own onSuccess handler
            // refreshes auth state and moves the user on. There is no
            // "account already exists and you're in" sentence to show --
            // the app just proceeds to the signed-in view.
            break
          case 'needs-confirmation':
            setNotice(`Account created. Confirm ${result.email} from the email just sent to it, then sign in below.`)
            setMode('signin')
            break
          case 'email-exists':
            setNotice('That email already has an account. Sign in below to continue.')
            setMode('signin')
            // The email was right; it just meant something else. Land the
            // cursor on the only field they still need to fill.
            passwordRef.current?.focus()
            break
          default: {
            const _exhaustive: never = result
            throw new Error(`Unhandled sign-up outcome: ${JSON.stringify(_exhaustive)}`)
          }
        }
      } else {
        await signIn.mutateAsync({ email, password })
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      // The field goes back to empty on every attempt, success or failure --
      // the meter has to follow it back to empty too, or it goes on
      // describing a password that is no longer there. Left un-reset, a
      // rejected short sign-up shows "Use at least 8 characters." twice: once
      // as the submit error, once as the meter's stale hint for the password
      // that used to be in the field.
      clearPassword(form)
      setStrength(null)
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
              id="auth-password" name="password" type="password" ref={passwordRef}
              autoComplete={isSignUp ? 'new-password' : 'current-password'} required
              onChange={isSignUp ? e => setStrength(e.target.value.length > 0 ? scorePassword(e.target.value) : null) : undefined}
            />
            {isSignUp && strength && <StrengthMeter score={strength.score} hint={strength.hint} />}
          </div>

          {/* The secondary action is a text link and the primary is a filled
              pill, sitting apart. They used to be two adjacent bordered
              buttons of equal weight, which made "I already have an account"
              read as an alternative way to submit the form. */}
          <div className="auth-actions">
            <button
              type="button" className="auth-link"
              onClick={() => {
                setMode(isSignUp ? 'signin' : 'signup')
                setError(null)
                setNotice(null)
                setStrength(null)
              }}
            >
              {isSignUp ? 'Sign in instead' : 'Create account'}
            </button>
            <button type="submit" className="auth-submit" disabled={pending}>
              {isSignUp ? 'Create account' : 'Sign in'}
            </button>
          </div>
        </form>

        <div className="auth-divider" aria-hidden="true"><span>or</span></div>

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
