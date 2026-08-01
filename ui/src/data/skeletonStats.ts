// Task 7 Finding 3: Today's "repeat opens answered by memory" solo stat must
// come from the real /api/savings ledger, never a session-count proxy. Kept
// out of mappers.ts (not merged in) purely to keep that file under the
// project's 300-line cap -- it is the same "pure fold of a raw daemon
// payload" pattern as everything in mappers.ts, just in its own module.
import type { SkeletonStats } from './types'

// /api/savings totals (server.js savingsPayload:337) -- only the two fields
// this stat needs. `reads`/`avoided` are optional because a ledger that
// predates Task 6, or any other malformed response, must degrade to "no
// data" rather than throw or silently read as zero.
export interface RawSavingsPayload {
  totals?: {
    reads?: { first: number; sameSession: number; crossSession: number }
    avoided?: { tokens: number; serves: number; tierA: number; tierB: number; partialWins: number; netNegatives: number }
  }
}

export function skeletonStatsFrom(raw: RawSavingsPayload): SkeletonStats {
  const reads = raw.totals?.reads
  const avoided = raw.totals?.avoided
  if (!reads || !avoided) return { available: false }
  return { available: true, repeatOpens: reads.sameSession + reads.crossSession, answeredFirst: avoided.serves }
}
