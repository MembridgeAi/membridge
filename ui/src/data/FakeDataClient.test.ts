import { describe, it, expect } from 'vitest'
import { FakeDataClient } from './FakeDataClient'

describe('FakeDataClient', () => {
  // Capabilities describe transport support only, never the viewer's
  // authorization — they must stay true regardless of solo/role.
  it('reports teamAdminSupported unconditionally, independent of solo or role', () => {
    expect(new FakeDataClient({ solo: true }).capabilities.teamAdminSupported).toBe(true)
    expect(new FakeDataClient({ role: 'member' }).capabilities.teamAdminSupported).toBe(true)
    expect(new FakeDataClient().capabilities.teamAdminSupported).toBe(true)
    expect(new FakeDataClient({ role: 'admin' }).capabilities.teamAdminSupported).toBe(true)
  })

  it('has no team in solo mode', async () => {
    const c = new FakeDataClient({ solo: true })
    expect((await c.getSettings()).team).toBeNull()
  })

  it('drives the viewer role in getSettings().team.role from opts.role', async () => {
    const byDefault = new FakeDataClient()
    expect((await byDefault.getSettings()).team).toEqual({ name: 'MemBridge HQ', role: 'owner', memberCount: 3 })
    expect((await new FakeDataClient({ role: 'admin' }).getSettings()).team?.role).toBe('admin')
    expect((await new FakeDataClient({ role: 'member' }).getSettings()).team?.role).toBe('member')
  })

  it('gives the self member a role matching the constructed role', async () => {
    const members = await new FakeDataClient({ role: 'member' }).getMembers()
    expect(members.find(m => m.id === 'me')?.role).toBe('member')
    expect((await new FakeDataClient().getMembers()).find(m => m.id === 'me')?.role).toBe('owner')
  })

  it('exposes a behind project with its last sync date', async () => {
    const behind = (await new FakeDataClient().getProjects()).find(p => p.sync.state === 'behind')
    expect(behind?.sync).toEqual({ state: 'behind', lastSyncedAt: '2026-07-23T10:00:00Z' })
  })

  it('gives every project exactly seven daily counts', async () => {
    for (const p of await new FakeDataClient().getProjects()) expect(p.dailyCounts).toHaveLength(7)
  })

  // dailyCounts partitions the week's distinct sessions (lib/server.js
  // dailySessionBuckets) -- the sparkline and the count beside it must never
  // be able to contradict each other, including in fixture data.
  it('sums dailyCounts to sessionsThisWeek for every project fixture', async () => {
    for (const p of await new FakeDataClient().getProjects()) {
      const sum = p.dailyCounts.reduce((a, b) => a + b, 0)
      expect(sum).toBe(p.sessionsThisWeek)
    }
  })

  it('can report skeleton stats as unavailable', async () => {
    const i = await new FakeDataClient({ skeletonAvailable: false }).getInsights(30)
    expect(i.skeleton).toEqual({ available: false })
  })

  it('rejects every call when configured to fail', async () => {
    await expect(new FakeDataClient({ failWith: 'boom' }).getStatus()).rejects.toThrow('boom')
  })
})
