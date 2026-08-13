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
