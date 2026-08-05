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
const CROSSED = ['mapMember', 'mapProjectRow', 'mapSession'] as const

// Mappers the fixture still bypasses, with why. Moving one of these to
// CROSSED means converting the matching FakeDataClient builder to author the
// raw wire shape. Nothing here is safe; it is only known.
const OUTSTANDING: Record<string, string> = {
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

  // mapProjectRow has FOUR derived fields, and the fixture used to state all
  // four as literals. Each assertion below is a value the fixture no longer
  // authors -- break the derivation and these fail, which is the whole point.
  describe('projects really are mapper output, with the derived fields derived', () => {
    it('derives sync state from the row own timestamps, not from an authored literal', async () => {
      const projects = await new FakeDataClient().getProjects()
      const membridge = projects.find(p => p.name === 'membridge')!
      const sublease = projects.find(p => p.name === 'sublease')!

      // lastActivity === lastSync, so zero lag, so inside the grace period.
      expect(membridge.sync).toEqual({ state: 'up-to-date' })
      // ~6 days of lag against a 2-interval grace: behind, and it reports the
      // sync it is behind FROM.
      expect(sublease.sync).toEqual({ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' })
    })

    it('derives shared from the presence of a team link', async () => {
      const team = await new FakeDataClient().getProjects()
      expect(team.find(p => p.name === 'membridge')!.shared).toBe(true)
      expect(team.find(p => p.name === 'sublease')!.shared).toBe(false)
      // Solo has no team link on any row, so nothing is shared -- and this is
      // the flag T-78's whole solo audit keys on.
      const solo = await new FakeDataClient({ solo: true }).getProjects()
      expect(solo.find(p => p.name === 'membridge')!.shared).toBe(false)
    })

    it('derives latestSummary from the feed page rather than stating it', async () => {
      const projects = await new FakeDataClient().getProjects()
      expect(projects.find(p => p.name === 'membridge')!.latestSummary).toEqual({
        text: 'Hook ownership now decided by durability, not who ran last',
        author: 'Andrew',
        at: '2026-07-29T19:00:00Z',
      })
      // A project whose feed rows carry no text gets null FROM the mapper.
      const archived = await new FakeDataClient({ withArchived: true }).getProjects()
      expect(archived.find(p => p.name === 'old-prototype')!.latestSummary).toBeNull()
    })

    it('derives recentAuthorIds from feed rows that actually carry an author id', async () => {
      const projects = await new FakeDataClient().getProjects()
      // The summary row deliberately has authorId null (the realistic case),
      // so Andrew is the summary's author WITHOUT appearing here.
      expect(projects.find(p => p.name === 'membridge')!.recentAuthorIds).toEqual(['me', 'andrew', 'sarah'])
      expect(projects.find(p => p.name === 'sublease')!.recentAuthorIds).toEqual(['me'])
    })

    it('filters one shared feed page per project, the way the real client does', async () => {
      const projects = await new FakeDataClient({ withArchived: true }).getProjects()
      // sublease's summary must not leak onto membridge, and vice versa --
      // both come out of the same array handed to every mapProjectRow call.
      expect(projects.find(p => p.name === 'sublease')!.latestSummary?.text)
        .toBe('Listing flow validates addresses before payment')
      expect(projects.find(p => p.name === 'deleted-folder')!.latestSummary).toBeNull()
    })
  })

  // mapSession is pure normalization: every field is `raw.x || default`. That
  // makes it the easiest mapper for a fixture to drift away from unnoticed --
  // author a Session directly and you silently skip every default the app
  // relies on, so a payload the daemon really sends (sparse, with nulls and
  // absent arrays) is never exercised.
  describe('sessions really are mapper output', () => {
    it('normalizes a sparse payload rather than trusting the fixture to be complete', async () => {
      const s = await new FakeDataClient().getSession('s-f1')
      // Arrays are guaranteed present by the mapper, never undefined -- the
      // session page maps over all four without guarding.
      expect(Array.isArray(s!.files)).toBe(true)
      expect(Array.isArray(s!.changes)).toBe(true)
      expect(Array.isArray(s!.checkpoints)).toBe(true)
      expect(Array.isArray(s!.prompts)).toBe(true)
      // Absent optional text normalizes to null, not undefined.
      expect(s!.decisions).toBeNull()
      expect(s!.gotchas).toBeNull()
    })

    it('still resolves an unknown id to null rather than a blank session', async () => {
      expect(await new FakeDataClient().getSession('nope')).toBeNull()
    })
  })
})
