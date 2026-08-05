import { describe, it, expect } from 'vitest'
import * as mappers from './mappers'
import { FakeDataClient } from './FakeDataClient'

/**
 * THE FIXTURE/MAPPER BOUNDARY.
 *
 * Every screen in this app reads domain objects that the real client builds by
 * putting a raw daemon payload through a mapper in mappers.ts. FakeDataClient
 * — which is what every component test reads — originally skipped that step
 * and authored the domain objects itself.
 *
 * That is a whole layer the tests route around, and it fails silently in both
 * directions:
 *
 *   - A field the mapper DROPS stays visible in the fixture, so every test
 *     passes while the app renders nothing. This is how #59's `preFixLocal`
 *     would have disappeared; it was caught only because a dedicated mapper
 *     unit test happened to be written for it.
 *   - A field the mapper CANNOT FILL looks populated in the fixture, so the
 *     UI gets built around data that does not exist. This one was real:
 *     `Member.email` was authored as 'andrew@acme.dev' here while mapMember
 *     hardcoded '', and MemberRow shipped a permanently blank address line
 *     that no test could see.
 *
 * The rule: if a mapper exists for a type, the fixture authors the RAW wire
 * shape and runs it through that mapper. Then a dropped field fails a
 * component test the same way it fails in the app.
 *
 * This file is the ledger of how far that has been applied. It is not
 * decoration: the inventory test below fails when a mapper is added to
 * mappers.ts without being classified, so the boundary cannot quietly grow a
 * new hole. An entry in OUTSTANDING is a known gap with a stated reason — a
 * TODO with a test behind it, not an exemption.
 */

// Mappers whose fixture path goes through the real mapper.
const CROSSED = ['mapMember'] as const

// Mappers the fixture still bypasses, with why. Moving one of these to
// CROSSED means converting the matching FakeDataClient builder to author the
// raw wire shape. Nothing here is safe; it is only known.
const OUTSTANDING: Record<string, string> = {
  mapProjectRow:
    'FakeDataClient.getProjects() authors Project literals. The heaviest conversion of the ' +
    'set: mapProjectRow takes (row, feedEntries, intervalSec) and derives sync state from a ' +
    'clock-sensitive comparison, so the fixture would have to author raw feed entries with ' +
    'timestamps positioned relative to the grace period. Highest remaining exposure, since ' +
    'Project drives Today, Projects and the project page.',
  mapFeedEntry:
    'FakeDataClient.getFeed() authors FeedEntry literals. Medium: one raw shape (RawFeedEntry) ' +
    'and no derived clock state, but the fixture builds paged results and day grouping on top ' +
    'of the mapped objects.',
  mapLiveSession:
    'FakeDataClient.getLiveSessions() authors LiveSession literals. Shares RawFeedEntry with ' +
    'mapFeedEntry, so it should be converted in the same pass.',
  mapStreamEntry:
    'FakeDataClient.getProjectStream() authors StreamEntry literals. Also RawFeedEntry-based; ' +
    'same pass as the two above.',
  mapSession:
    'FakeDataClient.getSession() authors a Session literal. Self-contained ' +
    '(RawSessionPayload -> Session, no second argument), so this is the cheapest one left ' +
    'and the natural next conversion.',
}

describe('the FakeDataClient/mapper boundary', () => {
  // The guard that makes the hole non-extensible. A new mapper lands in
  // neither list and this fails, forcing whoever adds it to say which it is.
  it('classifies every mapper as either crossed or explicitly outstanding', () => {
    const exported = Object.keys(mappers)
      .filter(k => k.startsWith('map') && typeof (mappers as Record<string, unknown>)[k] === 'function')
      .sort()

    const classified = [...CROSSED, ...Object.keys(OUTSTANDING)].sort()

    // Named rather than counted, so the failure says WHICH mapper is
    // unclassified instead of only that the totals disagree.
    expect(exported).toEqual(classified)
  })

  it('gives every outstanding gap a stated reason rather than a bare name', () => {
    for (const [name, reason] of Object.entries(OUTSTANDING)) {
      expect(reason.length, `${name} is listed as outstanding with no reason`).toBeGreaterThan(40)
    }
  })

  // The behavioural half: proves the Member path really does cross the
  // mapper, rather than merely being listed as if it does. If teamMembers()
  // ever goes back to authoring Member literals, this fails.
  describe('members really are mapper output, not hand-authored objects', () => {
    it('carries no field the mapper cannot produce', async () => {
      const members = await new FakeDataClient().getMembers()
      const reference = mappers.mapMember(
        { user_id: 'x', display_name: 'X', role: 'member', joined_at: null },
        { projectCount: 0, lastSharedAt: null },
      )
      // Key-for-key identical to what the mapper emits. An `email` invented by
      // the fixture — the actual bug this closed — shows up here as an extra
      // key, whatever plausible value it was given.
      for (const m of members) {
        expect(Object.keys(m).sort()).toEqual(Object.keys(reference).sort())
      }
    })

    it('carries the fields the mapper does produce, including ones added late', async () => {
      const members = await new FakeDataClient().getMembers()
      // preFixLocal is the #59 field, and the one that would have been
      // dropped at the mapper's object literal without anything noticing.
      for (const m of members) {
        expect(m.preFixLocal).toBeDefined()
        expect(typeof m.preFixLocal.entries).toBe('number')
      }
      // The fixture still has to be USEFUL after crossing the mapper: the two
      // #59 cases must survive the round trip, or component tests lose the
      // ability to tell a real zero from an unreachable one.
      expect(members.find(m => m.name === 'Andrew')?.preFixLocal).toEqual({ entries: 7, projects: 2 })
      expect(members.find(m => m.name === 'Sarah')?.preFixLocal).toEqual({ entries: 0, projects: 0 })
    })
  })
})
