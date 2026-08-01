// Fix 10: removing a member or changing their role alters what the access
// surfaces show -- ['accessMatrix'] (the projects grid's member columns) and
// ['projectAccess', *] (the project page's access panel) both list members.
// Invalidating only ['members'] left a removed member ghosting in those
// grids until an unrelated refetch happened to clear them.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from './DataClientProvider'
import { FakeDataClient } from './FakeDataClient'
import { useArchiveProject, useRemoveMember, useSetMemberRole, useUnarchiveProject } from './queries'

function mountHook<T>(useHook: () => T, client: FakeDataClient = new FakeDataClient()): { qc: QueryClient; hook: () => T } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let current: T | undefined
  function Probe() {
    current = useHook()
    return null
  }
  render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>
        <Probe />
      </DataClientProvider>
    </QueryClientProvider>,
  )
  return { qc, hook: () => current as T }
}

afterEach(cleanup)

describe('member mutations invalidate every member-listing surface (Fix 10)', () => {
  it('useRemoveMember invalidates members, accessMatrix, and projectAccess', async () => {
    const { qc, hook } = mountHook(() => useRemoveMember())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('andrew')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['members'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['accessMatrix'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projectAccess'] })
  })

  it('useSetMemberRole invalidates members, accessMatrix, and projectAccess', async () => {
    const { qc, hook } = mountHook(() => useSetMemberRole())
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync({ memberId: 'andrew', role: 'member' })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['members'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['accessMatrix'] })
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projectAccess'] })
  })
})

// Task 3 (projects tab scale and archive): archiving changes what the
// projects list shows, so both mutations must reach the client method and
// refresh the ['projects'] query.
describe('archive mutations', () => {
  it('useArchiveProject calls the client with the path and invalidates projects', async () => {
    const client = new FakeDataClient()
    const clientSpy = vi.spyOn(client, 'archiveProject')
    const { qc, hook } = mountHook(() => useArchiveProject(), client)
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('/Users/x/sublease')
    expect(clientSpy).toHaveBeenCalledWith('/Users/x/sublease')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('useUnarchiveProject calls the client with the path and invalidates projects', async () => {
    const client = new FakeDataClient()
    const clientSpy = vi.spyOn(client, 'unarchiveProject')
    const { qc, hook } = mountHook(() => useUnarchiveProject(), client)
    const spy = vi.spyOn(qc, 'invalidateQueries')
    await hook().mutateAsync('/Users/x/sublease')
    expect(clientSpy).toHaveBeenCalledWith('/Users/x/sublease')
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })
})
