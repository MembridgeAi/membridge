import { useEffect, useState, type FormEvent } from 'react'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { LoadingRows } from '../../components/LoadingBlock'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useCreateInviteLink, useCreateTeam, useJoinTeam, useRenameTeam, useSignIn, useSignOut, useSignUp, useTeamAccount,
} from '../../data/queries'
import type { TeamAccount, TeamSummary } from '../../data/types'
import { EditablePill } from '../../components/EditablePill'
import { DangerZone } from './DangerZone'
import { MembersSection } from './MembersSection'
import './team.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// Null count -> null, not a "count unknown" clause: the caller drops the
// separator entirely rather than announcing the gap mid-sentence.
function memberCountLabel(n: number | null): string | null {
  if (n === null) return null
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
    <section className="team-card" aria-labelledby="team-auth-heading">
      <p className="team-signed-out" role="status">
        You are signed out. Team sync, shared memory and invites all need an account.
      </p>
      {/* T-78 item 9: name that solo works, on the surface the rail's Team
          link lands on. Without this, a fresh install reaches this screen and
          reads "you are signed out" as a defect state rather than as the
          onboarding step it is -- there was no "solo mode is fine" pitch
          anywhere in the app. Deliberately a short sentence, not a splash
          screen, so an actual invitee is not made to scroll past a marketing
          block. */}
      <p className="team-note">
        MemBridge works solo too — your memory stays on this machine either way. Sign in only if you
        want to share it with a team.
      </p>
      <h2 className="team-card-title" id="team-auth-heading">
        {mode === 'signup' ? 'Create an account' : 'Sign in'}
      </h2>
      {!configured && (
        <p className="team-note">
          This copy of MemBridge has no team service to sign in to, so sign-in won't work here.
        </p>
      )}
      {notice && <p className="team-notice" role="status">{notice}</p>}
      {error && <p className="team-error" role="alert">{error}</p>}

      {/* GitHub is the ONLY method the hosted onboarding page offers
          (cloudflare/join), so anyone who arrived that way has an account
          with no password and could not sign in here at all while this card
          was email-only. A plain anchor, not a fetch: /team/oauth/github is a
          302 into GitHub's consent screen, and the daemon's callback page
          finishes the exchange and links back here.

          T-78 item 11: the note used to read "Use this if you set your
          account up from a MemBridge invite page — that flow is GitHub-only,
          so your account has no password to type below." A first-time user
          who never saw an invite page could not decode any part of that
          sentence, and it also failed to name what "Continue with GitHub" IS
          for them (the fastest path in). Restated as what the button does,
          with the invitee-specific fact moved behind a "why?" hint that the
          reader does not need to understand in order to click. */}
      <a className="team-btn team-btn-oauth" href="/team/oauth/github">
        Continue with GitHub
      </a>
      <p className="team-note">
        The fastest way in. Uses your GitHub account, no password to set or remember.
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
  // Backs the inline rename on the team-name pill below. Same mutation the
  // Settings Rename dialog uses, so both routes to a rename share one cache
  // invalidation and cannot disagree about the current name.
  const renameTeam = useRenameTeam()

  const [share, setShare] = useState<Share | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The backend's wording for a revocation that did NOT happen, held here
  // rather than in the mutation, because it has to survive the re-render into
  // the signed-out view -- that is the only screen the user sees afterwards.
  const [revokeFailure, setRevokeFailure] = useState<string | null>(null)
  // Mirrors lib/server.js's INVITE_DEFAULT_EXPIRES_DAYS / INVITE_DEFAULT_MAX_USES.
  // The screen states them and SENDS them rather than letting the daemon fill in
  // an omitted field: an invite the user cannot see the terms of is how every
  // invite this app minted ended up permanent (agent-sec cff17e3).
  const [expiresDays, setExpiresDays] = useState(7)
  const [maxUses, setMaxUses] = useState(1)

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
  // create_invite is manager-gated on the daemon, so an ordinary member who
  // clicked this got a 403 -- an affordance whose only possible outcome is an
  // error, which reads as the app being broken rather than as a permission
  // they do not have. The "copy the standing code instead" fallback is NOT the
  // consolation prize: handing that code to ordinary members is the hole the
  // security lane closed, so the whole affordance goes rather than degrading.
  const canInvite = team ? team.role === 'owner' || team.role === 'admin' : false
  // A real link also needs a hosted join page to mint against; without a
  // webUrl there is no URL anything could redeem.
  const canMintLink = !!(webUrl && team && canInvite)

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
        const { token } = await mintInvite.mutateAsync({ teamId, expiresDays, maxUses })
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
    setRevokeFailure(null)
    try {
      const out = await signOut.mutateAsync()
      // Only when the backend did NOT confirm. `revoked` is never inferred
      // from the absence of an error, so this is the one honest trigger.
      if (!out.revoked) setRevokeFailure(out.revokeError || 'the server did not confirm it')
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
        <p className="team-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="team-note">{errorMessage(daemonError.error)}</p>
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
      {/* The gate itself was already right, and its comment states the rule
          this whole sweep is about. Only the rendering changes: a bare
          "Loading…" line where the account card will be, replaced with
          placeholder rows that hold that card's shape. */}
      {!account && <LoadingRows rows={2} label="Loading your account" testId="team-loading" />}

      {/* Sign-out is two outcomes and this is the one the screen used to hide.
          The local credential file is always deleted -- that is why the user is
          looking at the sign-in card -- but the SESSION may still be alive on
          the backend, and any copy of the credentials taken before now keeps
          working until it expires.

          Deliberately no "try again": the credentials are gone from this
          machine, so there is nothing left to revoke WITH, and offering a retry
          would name a remedy that cannot work. Matches the CLI's wording for
          the same outcome (bin/membridge.js cmdLogout), so the two surfaces
          cannot tell the user different things about the same event. */}
      {revokeFailure && (
        <p className="team-revoke-warning" role="alert" data-testid="signout-not-revoked">
          ⚠ Signed out on this machine only. The session could not be ended on the server:
          {' '}{revokeFailure}. A copy of this machine’s credentials taken before now can still
          use that session until it expires. Changing your account password is the way to end
          it for certain.
        </p>
      )}

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
              {/* .wrap-anywhere here and NOT on .team-card-title itself: every
                  other use of that class is a fixed heading ("People", "Join a
                  team"), and this is the only one holding user data. The team
                  name is uncapped -- the rename dialog validates nothing -- and
                  measured at the 900px floor a 78-character single-token name
                  produced horizontal scroll inside the content column, a
                  150-character one 648px of it. */}
              {/* The pill replaces a plain heading, not the heading element:
                  #team-current-heading is referenced elsewhere and the h2 is
                  what makes this a landmark. The pill caps and ellipsises the
                  name with the full value on `title`, which also settles the
                  uncapped-name overflow the comment above describes. Renaming
                  is admin/owner only, matching the Rename control in Settings;
                  a member sees plain text with no affordance at all. */}
              <h2 className="team-card-title wrap-anywhere" id="team-current-heading">
                <EditablePill
                  value={team.name}
                  canEdit={team.role === 'owner' || team.role === 'admin'}
                  label="Team name"
                  testId="team-name-pill"
                  onSave={next => renameTeam.mutateAsync({ teamId: team.id, name: next })}
                />
              </h2>
              <p className="team-note">
                You are the {roleLabel(team.role)}
                {memberCountLabel(team.memberCount) && ` · ${memberCountLabel(team.memberCount)}`}
              </p>
              {/* The terms of the link BEFORE it is minted, because the token
                  goes straight to the clipboard -- there is no confirmation
                  step where a user could otherwise discover what they just
                  handed out. Every invite this app minted before agent-sec
                  cff17e3 was permanent and unlimited, and nothing on screen
                  ever said so or offered a way to change it.

                  Only for the LINK path: `inviteCode` is the standing team
                  code, long-lived and unlimited-use by design, and these
                  bounds do not apply to it. */}
              {/* Not silence. A member who finds no control cannot tell whether
                  inviting is missing, broken, or simply not theirs, so the page
                  says which. It does NOT name the owner and admins here: the
                  People list immediately below already names every member with
                  their role, and a second copy of that answer is one that can
                  disagree with the first. Pointing at it is the version that
                  cannot drift. */}
              {team && !canInvite && (
                <p className="team-note" data-testid="invite-manager-only">
                  Only the team’s owner and admins can invite people. You can see who they are in
                  the People list below.
                </p>
              )}
              {canMintLink && (
                <div className="team-invite-bounds">
                  <label htmlFor="invite-expires">Expires</label>
                  <select
                    id="invite-expires" value={String(expiresDays)}
                    onChange={e => setExpiresDays(Number(e.target.value))}
                  >
                    <option value="1">in 1 day</option>
                    <option value="7">in 7 days</option>
                    <option value="30">in 30 days</option>
                    {/* 0 is the daemon's explicit opt-out, not an omission. */}
                    <option value="0">never</option>
                  </select>
                  <label htmlFor="invite-uses">Uses</label>
                  <select
                    id="invite-uses" value={String(maxUses)}
                    onChange={e => setMaxUses(Number(e.target.value))}
                  >
                    <option value="1">once</option>
                    <option value="5">up to 5 times</option>
                    <option value="0">unlimited</option>
                  </select>
                </div>
              )}
              {canInvite && (canMintLink || inviteCode) && (
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
                  {/* Carried over in the Members merge rather than dropped.
                      shareInvite() mints a link whenever a webUrl exists, so
                      without this the standing code became unreachable from
                      the UI the moment a hosted join page was configured --
                      and it is the only shape that works with `membridge
                      join <code>` when nobody has a browser handy.

                      Labelled "standing code", never "code instead": the two
                      controls hand out structurally different secrets. The
                      primary mints a fresh, individually revocable token per
                      invite; this copies the single permanent per-team code
                      that no one can revoke for one person -- rotating it is
                      the only undo and it cuts off every outstanding copy at
                      once. "Instead" framed that as a mere format choice. */}
                  {canMintLink && inviteCode && (
                    <button
                      type="button" className="team-btn"
                      onClick={() => present('code', inviteCode, true)}
                    >
                      {share?.status === 'copied' && share.kind === 'code' ? 'Copied' : 'Copy standing code'}
                    </button>
                  )}
                </div>
              )}
            </section>
          )}

          {/* The roster lives here rather than behind its own nav item: the
              two screens split one team across two places, and each shipped
              its own invite control wired to a different code path. */}
          {team && <MembersSection />}

          {/* Last on the tab, after the roster: leave, transfer, disband. */}
          {team && <DangerZone team={team} />}

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
