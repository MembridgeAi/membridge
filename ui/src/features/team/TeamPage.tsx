import { useEffect, useState, type FormEvent } from 'react'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useCreateInviteLink, useCreateTeam, useJoinTeam, useSignIn, useSignOut, useSignUp, useTeamAccount,
} from '../../data/queries'
import type { TeamAccount, TeamSummary } from '../../data/types'
import './team.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function memberCountLabel(n: number | null): string {
  if (n === null) return 'member count unknown'
  return n === 1 ? '1 member' : `${n} members`
}

function roleLabel(role: TeamSummary['role']): string {
  return role.charAt(0).toUpperCase() + role.slice(1)
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

/** State 1: no credentials on this machine. Deliberately loud -- a signed-out
 *  machine used to render identically to a signed-in machine with no team,
 *  which is how a silent sign-out went unnoticed: nothing in the app said
 *  anything was wrong. */
function SignInCard({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const signIn = useSignIn()
  const signUp = useSignUp()
  const pending = signIn.isPending || signUp.isPending

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Captured before the first await: React clears currentTarget once the
    // handler yields, and the finally below still needs the form.
    const form = event.currentTarget
    const data = new FormData(form)
    const email = String(data.get('email') || '').trim()
    const password = String(data.get('password') || '')
    const displayName = String(data.get('displayName') || '').trim()
    setError(null)
    setNotice(null)
    try {
      if (mode === 'signup') {
        const result = await signUp.mutateAsync({ displayName, email, password })
        // A confirmation-required sign-up is a SUCCESS with one more step.
        // Saying nothing here is indistinguishable from a rejected sign-up,
        // and the account genuinely cannot sign in until the mail is opened.
        if (result.needsConfirmation) {
          setNotice(`Account created. Confirm ${result.email} from the email just sent to it, then sign in below.`)
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
    <section className="team-card" aria-labelledby="team-auth-heading">
      <p className="team-signed-out" role="status">
        You are signed out. Team sync, shared memory and invites all need an account.
      </p>
      <h2 className="team-card-title" id="team-auth-heading">
        {mode === 'signup' ? 'Create an account' : 'Sign in'}
      </h2>
      {!configured && (
        <p className="team-note">
          This build ships no team backend, so signing in cannot succeed here.
        </p>
      )}
      {notice && <p className="team-notice" role="status">{notice}</p>}
      {error && <p className="team-error" role="alert">{error}</p>}

      {/* GitHub is the ONLY method the hosted onboarding page offers
          (cloudflare/join), so anyone who arrived that way has an account
          with no password and could not sign in here at all while this card
          was email-only. A plain anchor, not a fetch: /team/oauth/github is a
          302 into GitHub's consent screen, and the daemon's callback page
          finishes the exchange and links back here. */}
      <a className="team-btn team-btn-oauth" href="/team/oauth/github">
        Continue with GitHub
      </a>
      <p className="team-note">
        Use this if you set your account up from a MemBridge invite page — that flow is GitHub-only,
        so your account has no password to type below.
      </p>

      {/* Uncontrolled on purpose: the password lives in the DOM field for the
          moment it takes to submit, never in React state. */}
      <form className="team-form" onSubmit={submit}>
        {mode === 'signup' && (
          <div className="team-field">
            <label htmlFor="team-name-field">Your name</label>
            <input id="team-name-field" name="displayName" type="text" autoComplete="name" required />
          </div>
        )}
        <div className="team-field">
          <label htmlFor="team-email-field">Email</label>
          <input id="team-email-field" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="team-field">
          <label htmlFor="team-password-field">Password</label>
          <input
            id="team-password-field" name="password" type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required
          />
        </div>
        <div className="team-actions">
          <button type="submit" className="team-btn team-btn-primary" disabled={pending}>
            {mode === 'signup' ? 'Sign up' : 'Sign in'}
          </button>
          <button
            type="button" className="team-btn"
            onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null) }}
          >
            {mode === 'signup' ? 'I already have an account' : 'Create an account'}
          </button>
        </div>
      </form>
    </section>
  )
}

// What is currently on offer to share, and whether it actually reached the
// clipboard. 'copied' is only ever set by a clipboard write that RESOLVED --
// a browser with no clipboard API, or a denied write, lands on 'manual', so a
// failed copy can never read as a success and leave someone pasting nothing.
type Share = { kind: 'link' | 'code'; value: string; status: 'shown' | 'copied' | 'manual' }

/** State 2a: signed in, on no team, holding an invite somebody sent you.
 *
 *  This is deliberately FIRST on the no-team screen, above "Create a team".
 *  The invited user is the one arriving with no idea what to do, and when
 *  creating was the only thing on offer they created a second team --
 *  precisely what the invite existed to prevent.
 *
 *  One field, and it takes whatever they were actually sent: a short token, a
 *  legacy UUID code, or the whole pasted invite URL. The daemon normalizes
 *  all three (teamsync.parseInviteToken), so nothing is validated or trimmed
 *  to shape here -- a UI that guessed at the format would reject real
 *  invites. */
function JoinCard() {
  const joinTeam = useJoinTeam()
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const code = String(new FormData(form).get('inviteCode') || '').trim()
    if (!code) return
    setError(null)
    try {
      await joinTeam.mutateAsync(code)
      form.reset()
      // Nothing else to do on success: the mutation refreshes the account, and
      // this whole card unmounts as the team card takes its place.
    } catch (err) {
      // The backend's own wording ("this invite link has expired", "…has been
      // revoked") is the only actionable thing here, so it renders verbatim.
      setError(errorMessage(err))
    }
  }

  return (
    <section className="team-card" aria-labelledby="team-join-heading">
      <h2 className="team-card-title" id="team-join-heading">Join a team</h2>
      <p className="team-note">
        Someone sent you an invite? Paste it here — the link or just the code both work.
      </p>
      {error && <p className="team-error" role="alert">{error}</p>}
      <form className="team-form" onSubmit={submit}>
        <div className="team-field">
          <label htmlFor="team-join-input">Invite link or code</label>
          <input id="team-join-input" name="inviteCode" type="text" autoComplete="off" required />
        </div>
        <div className="team-actions">
          <button type="submit" className="team-btn team-btn-primary" disabled={joinTeam.isPending}>
            {joinTeam.isPending ? 'Joining…' : 'Join team'}
          </button>
        </div>
      </form>
    </section>
  )
}

/** The Team page. Three states, chosen by GET /api/team:
 *  1. `authenticated: false` -> the sign-in card above.
 *  2. authenticated, `teams` empty -> join with an invite, or create a team.
 *  3. authenticated, on a team -> the team, plus Copy invite link.
 *
 *  Leaving a team stays in Settings' danger zone, where it already is. */
export function TeamPage() {
  const client = useDataClient()
  const accountQuery = useTeamAccount()
  const createTeam = useCreateTeam()
  const mintInvite = useCreateInviteLink()
  const signOut = useSignOut()

  const [share, setShare] = useState<Share | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Only the "Copied" confirmation fades; the value itself stays on screen so
  // the viewer can always see exactly what was shared.
  useEffect(() => {
    if (share?.status !== 'copied') return
    const id = setTimeout(() => setShare(current => (current ? { ...current, status: 'shown' } : current)), 2000)
    return () => clearTimeout(id)
  }, [share?.status, share?.value])

  const account: TeamAccount | undefined = accountQuery.data
  // The SELECTED team (rail switcher), matched the same way the transport
  // matches it -- an unknown or absent selection falls back to the first.
  // Reading teams[0] here instead would put this page on a different team
  // from the rail, Settings and the members list the moment someone switched.
  const selectedId = client.selectedTeamId()
  const team = (selectedId ? account?.teams.find(t => t.id === selectedId) : undefined) ?? account?.teams[0] ?? null
  const webUrl = account?.webUrl ?? null
  const inviteCode = team ? account?.inviteCode ?? null : null
  // A real link needs both a hosted join page and a team to mint against;
  // without a webUrl the control degrades to the standing code rather than
  // producing a URL nothing can redeem.
  const canMintLink = !!(webUrl && team)

  async function present(kind: 'link' | 'code', value: string, copy: boolean) {
    if (!copy) {
      setShare({ kind, value, status: 'shown' })
      return
    }
    if (!navigator.clipboard) {
      setShare({ kind, value, status: 'manual' })
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      setShare({ kind, value, status: 'copied' })
    } catch {
      setShare({ kind, value, status: 'manual' })
    }
  }

  // One path for both entry points: the button on an existing team (copy) and
  // the moment just after a team is created (show).
  async function shareInvite(teamId: string | null, standingCode: string | null, copy: boolean) {
    setActionError(null)
    if (webUrl && teamId) {
      try {
        const { token } = await mintInvite.mutateAsync(teamId)
        // The hosted join page reads its token from location.hash
        // (cloudflare/join/public/index.html), so the redeemable link is
        // `<webUrl>/#<token>` -- the same shape the Members page mints.
        await present('link', `${webUrl}/#${token}`, copy)
      } catch (err) {
        setActionError(errorMessage(err))
      }
      return
    }
    if (standingCode) await present('code', standingCode, copy)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const name = String(new FormData(form).get('teamName') || '').trim()
    setActionError(null)
    try {
      const created = await createTeam.mutateAsync(name)
      form.reset()
      await shareInvite(created.id, created.inviteCode, false)
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  async function handleSignOut() {
    setActionError(null)
    setShare(null)
    try {
      await signOut.mutateAsync()
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  // Full error page only for a first-load failure; a failed refetch with
  // cached data degrades to the inline banner instead of blanking the screen.
  const daemonError = daemonErrorOf([accountQuery])
  if (daemonError?.blocking) {
    return (
      <div className="team-page">
        <h1 className="team-title">Team</h1>
        <p className="team-error" role="alert">Couldn't reach the daemon. {errorMessage(daemonError.error)}</p>
      </div>
    )
  }

  return (
    <div className="team-page">
      <h1 className="team-title">Team</h1>
      {daemonError && <DaemonErrorBanner className="team-error" error={daemonError.error} />}

      {/* Nothing about the account renders until the daemon has answered --
          flashing "you are signed out" at someone who is signed in would be
          the same lie this page exists to remove, just pointing the other
          way. */}
      {!account && <p className="team-loading">Loading…</p>}

      {account && !account.authenticated && <SignInCard configured={account.configured} />}

      {account && account.authenticated && (
        <>
          <section className="team-card">
            <div className="team-account">
              <span className="team-account-name">{account.user?.displayName || 'Signed in'}</span>
              <span className="mono team-account-email">{account.user?.email ?? ''}</span>
              <button type="button" className="team-btn" onClick={handleSignOut} disabled={signOut.isPending}>
                Sign out
              </button>
            </div>
          </section>

          {/* A listing failure is NOT "you have no team": saying so would
              invite someone to create a second team over the top of one they
              already own. */}
          {account.error && (
            <p className="team-error" role="alert">Couldn't read your teams. {account.error}</p>
          )}

          {!team && !account.error && <JoinCard />}

          {!team && !account.error && (
            <section className="team-card" aria-labelledby="team-create-heading">
              <h2 className="team-card-title" id="team-create-heading">Create a team</h2>
              <p className="team-note">
                Everyone you invite sees what your AI tools did, on the projects you share.
              </p>
              <form className="team-form" onSubmit={handleCreate}>
                <div className="team-field">
                  <label htmlFor="team-name-input">Team name</label>
                  <input id="team-name-input" name="teamName" type="text" required />
                </div>
                <div className="team-actions">
                  <button type="submit" className="team-btn team-btn-primary" disabled={createTeam.isPending}>
                    Create team
                  </button>
                </div>
              </form>
            </section>
          )}

          {/* Says which team everything on screen is about. The switcher in
              the rail is what changes it -- naming that here is the whole
              point, since the invite button, member list and audit trail all
              follow the selection and nothing else on this page says so. */}
          {account.teams.length > 1 && (
            <p className="team-note team-multi" role="status">
              You are on {account.teams.length} teams. Everything here — members, invites, the audit trail —
              is about <b>{team?.name}</b>. Switch teams from the picker at the top of the sidebar.
            </p>
          )}

          {team && (
            <section className="team-card" aria-labelledby="team-current-heading">
              <h2 className="team-card-title" id="team-current-heading">{team.name}</h2>
              <p className="team-note">
                You are the {roleLabel(team.role)} · {memberCountLabel(team.memberCount)}
              </p>
              {(canMintLink || inviteCode) && (
                <div className="team-actions">
                  <button
                    type="button" className="team-btn team-btn-primary"
                    onClick={() => shareInvite(team.id, inviteCode, true)}
                    disabled={mintInvite.isPending}
                  >
                    {share?.status === 'copied'
                      ? 'Copied'
                      : canMintLink ? 'Copy invite link' : 'Copy invite code'}
                  </button>
                </div>
              )}
            </section>
          )}

          {actionError && <p className="team-error" role="alert">{actionError}</p>}

          {share && (
            <section className="team-card team-share">
              <p className="team-note">
                {share.status === 'manual'
                  ? `Couldn't copy automatically. Copy this ${share.kind} by hand:`
                  : `Send this to whoever should join:`}
              </p>
              <p className="mono team-share-value">{share.value}</p>
              {/* The instruction is the in-app paste, for BOTH shapes.
                  Pasting either shape into Join a team goes straight to
                  redeem_invite via the daemon, which is the path the daemon
                  itself uses and the one that cannot be broken by whatever the
                  hosted page happens to redeem against. */}
              <p className="team-note">
                They paste it into MemBridge → Team → Join a team. (Or, from a terminal, <code>membridge join</code>.)
              </p>
              {/* Only the 'code' branch gets this. A minted link is one
                  revocable token; this is team.inviteCode, the single standing
                  per-team secret, and nothing else on this screen distinguished
                  them -- someone pasting it into a group chat had no way to
                  know it stays valid forever and cannot be taken back from one
                  person. */}
              {share.kind === 'code' && (
                <p className="team-note team-share-caveat">
                  Permanent, shared by the whole team. Can't be revoked, only rotated.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
