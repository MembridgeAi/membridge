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
    expect((await byDefault.getSettings()).team).toEqual({ id: 'team-1', name: 'MemBridge HQ', role: 'owner', memberCount: 3, inviteCode: 'INV-7F3K9Q' })
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

  it('getSkeletonStats matches getInsights().skeleton for the same option, both available and unavailable', async () => {
    const available = new FakeDataClient()
    expect(await available.getSkeletonStats()).toEqual({ available: true, repeatOpens: 1204, answeredFirst: 818 })
    expect(await available.getSkeletonStats()).toEqual((await available.getInsights(30)).skeleton)

    const unavailable = new FakeDataClient({ skeletonAvailable: false })
    expect(await unavailable.getSkeletonStats()).toEqual({ available: false })
  })

  it('defaults teamLastSync in team mode but allows overriding it to null for the "never synced" case', async () => {
    expect((await new FakeDataClient().getStatus()).teamLastSync).toBe('2026-07-29T21:00:00Z')
    expect((await new FakeDataClient({ teamLastSync: null }).getStatus()).teamLastSync).toBeNull()
    // solo always wins regardless of teamLastSync
    expect((await new FakeDataClient({ solo: true, teamLastSync: '2026-07-29T21:00:00Z' }).getStatus()).teamLastSync).toBeNull()
  })

  it('rejects every call when configured to fail', async () => {
    await expect(new FakeDataClient({ failWith: 'boom' }).getStatus()).rejects.toThrow('boom')
  })

  // Task 3 (projects tab scale and archive): fixtures the constant-width
  // Access cell, the popover, and the Archived section are tested against.
  it('scales the team fixture to 10 and 30 members consistently across members, matrix and settings', async () => {
    for (const size of [10, 30]) {
      const c = new FakeDataClient({ teamSize: size })
      const members = await c.getMembers()
      expect(members).toHaveLength(size)
      expect(new Set(members.map(m => m.id)).size).toBe(size)
      const matrix = await c.getAccessMatrix()
      expect(matrix.members).toHaveLength(size)
      expect((await c.getSettings()).team?.memberCount).toBe(size)
      // The shared project's roster is a strict subset (6 of N), so the
      // Access cell has a real "+N chip and count label" case to render.
      const shared = (await c.getProjects()).find(p => p.shared)
      expect(shared).toBeTruthy()
      expect(shared!.recentAuthorIds).toHaveLength(6)
    }
  })

  it('default fixtures carry archived: false and missing: false', async () => {
    const projects = await new FakeDataClient().getProjects()
    expect(projects.length).toBeGreaterThan(0)
    for (const p of projects) {
      expect(p.archived).toBe(false)
      expect(p.missing).toBe(false)
    }
  })

  it('withArchived adds an archived project and an archived project whose folder is missing', async () => {
    const projects = await new FakeDataClient({ withArchived: true }).getProjects()
    const archived = projects.filter(p => p.archived)
    expect(archived.length).toBe(2)
    expect(archived.some(p => p.missing)).toBe(true)
    expect(archived.some(p => !p.missing)).toBe(true)
    // The unarchived rows are untouched by the option.
    expect(projects.some(p => !p.archived)).toBe(true)
  })

  it('models a member-role viewer end to end (settings role and self member row agree)', async () => {
    const c = new FakeDataClient({ role: 'member' })
    expect((await c.getSettings()).team?.role).toBe('member')
    const self = (await c.getMembers()).find(m => m.id === 'me')
    expect(self?.role).toBe('member')
  })
})
