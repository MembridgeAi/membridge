import { describe, it, expect } from 'vitest'
import { skeletonStatsFrom, type RawSavingsPayload } from './skeletonStats'

describe('skeletonStatsFrom', () => {
  type SavingsTotals = NonNullable<RawSavingsPayload['totals']>
  const totals: SavingsTotals = {
    reads: { first: 900, sameSession: 700, crossSession: 504 },
    avoided: { tokens: 50000, serves: 818, tierA: 400, tierB: 418, partialWins: 0, netNegatives: 0 },
  }

  it('sums same-session and cross-session reads into repeatOpens, and reads avoided.serves as answeredFirst', () => {
    expect(skeletonStatsFrom({ totals })).toEqual({ available: true, repeatOpens: 1204, answeredFirst: 818 })
  })
  it('is unavailable, never a fabricated zero, when reads is missing (a ledger that predates Task 6)', () => {
    expect(skeletonStatsFrom({ totals: { avoided: totals.avoided } })).toEqual({ available: false })
  })
  it('is unavailable when avoided is missing', () => {
    expect(skeletonStatsFrom({ totals: { reads: totals.reads } })).toEqual({ available: false })
  })
  it('is unavailable when totals itself is missing', () => {
    expect(skeletonStatsFrom({})).toEqual({ available: false })
  })
})
