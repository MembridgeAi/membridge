import type { StateTone } from './StateChip'

/**
 * The three states team-memory encryption can actually be in, derived from the
 * two booleans the daemon reports (`status.encryption`). Extracted because this
 * is now the second place that has to decide it — Settings' Privacy row and the
 * project page's Sync panel — and getting it wrong is not a cosmetic bug: the
 * whole point of the row is telling someone whether the server can read their
 * memory.
 *
 * WHAT IS SHARED, AND WHAT DELIBERATELY IS NOT.
 *
 * Shared: which of the three states you are in, and what tone it deserves.
 * That is semantics, it is identical in both places, and it is the part that
 * caused real defects when each site derived it alone.
 *
 * Not shared: the words. The project page's Sync panel is a fixed 300px column
 * (`.project-side`), and after `.kv`'s 16px padding, an 86px key and an 8px gap
 * the chip has ~174px to work in — while `.chip` is `white-space: nowrap` and
 * cannot shrink, so an over-long chip there forces the whole side column wider
 * and squeezes the stream beside it. Settings' row has room for a full sentence
 * plus an explanatory note; the side panel has room for two or three words. A
 * single shared chip component would have had to either bloat the side panel or
 * let the narrow context dictate Settings' wording, so each caller supplies its
 * own phrasing for a state this module names. No flag, no variant prop.
 *
 * POLARITY. Both inputs are the daemon's own field names and polarity
 * (`status.encryption.enabled` / `.plaintextOff`), not Settings' derived
 * `endToEnd` / `plaintextShared` pair, which inverts one of them. Callers
 * convert into this vocabulary rather than this module guessing which
 * convention it was handed — a silently inverted boolean here would render a
 * green tick over a readable server.
 */
export type EncryptionState =
  /** No encryption at all: everything this machine syncs is readable on the
   *  server. */
  | 'off'
  /** Encrypted, but a readable copy is written beside each encrypted row, so
   *  the server can still read the memory. */
  | 'dual-write'
  /** Encrypted with no readable copy retained. The only safe state. */
  | 'ciphertext-only'

export interface EncryptionReading {
  state: EncryptionState
  tone: StateTone
  glyph: string
}

/**
 * `plaintextOff` is only consulted when encryption is ON, and that is not a
 * shortcut — it is the correction for a real incident. The daemon's plaintext
 * nulling lives inside `encryptRow`, which is skipped entirely when there is no
 * key, so with encryption off the ciphertext-only setting is INERT however it
 * reads. A config with `team.encrypt: false` once shipped a full plaintext
 * history to the server while `plaintextOff` sat there looking like a
 * protection; treating it as one here would put that reassurance back on screen.
 *
 * 'off' is toned `warn`, never `muted`. Muted is this system's neutral/absence
 * tone — it says "nothing to see here" — and using it for the state where the
 * server can read everything is the same defect as tone-muting a registration
 * that did not happen: the colour saying "fine" about something that is not.
 */
export function readEncryption(enabled: boolean, plaintextOff: boolean): EncryptionReading {
  if (!enabled) return { state: 'off', tone: 'warn', glyph: '⚠' }
  if (!plaintextOff) return { state: 'dual-write', tone: 'warn', glyph: '⚠' }
  return { state: 'ciphertext-only', tone: 'ok', glyph: '✓' }
}
