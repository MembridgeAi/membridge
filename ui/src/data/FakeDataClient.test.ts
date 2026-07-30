import { describe, it, expect } from 'vitest'
import { FakeDataClient } from './FakeDataClient'

describe('FakeDataClient', () => {
  it('reports no team admin capability in solo mode', async () => {
    const c = new FakeDataClient({ solo: true })
    expect(c.capabilities.teamAdmin).toBe(false)
    expect((await c.getSettings()).team).toBeNull()
  })

  it('reports no team admin capability for a member role', () => {
    expect(new FakeDataClient({ role: 'member' }).capabilities.teamAdmin).toBe(false)
  })

  it('reports team admin capability by default and for an admin role', async () => {
    const byDefault = new FakeDataClient()
    expect(byDefault.capabilities.teamAdmin).toBe(true)
    expect(new FakeDataClient({ role: 'admin' }).capabilities.teamAdmin).toBe(true)
    expect((await byDefault.getSettings()).team).toEqual({ name: 'MemBridge HQ', role: 'owner', memberCount: 3 })
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

  it('can report skeleton stats as unavailable', async () => {
    const i = await new FakeDataClient({ skeletonAvailable: false }).getInsights(30)
    expect(i.skeleton).toEqual({ available: false })
  })

  it('rejects every call when configured to fail', async () => {
    await expect(new FakeDataClient({ failWith: 'boom' }).getStatus()).rejects.toThrow('boom')
  })
})
