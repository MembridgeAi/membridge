import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DataClient } from '../data/DataClient'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient, type FakeOptions } from '../data/FakeDataClient'
import { App } from '../app/App'

/** Shared render helper for app-level tests: a fresh QueryClient (retries
 *  off, so error states surface immediately) wired to a FakeDataClient, with
 *  either the full <App /> or a caller-supplied node underneath. */
export function renderApp(opts: FakeOptions = {}, ui?: ReactNode) {
  return renderWith(new FakeDataClient(opts), ui ?? <App />)
}

/** Same wiring as renderApp, but against a caller-supplied DataClient
 *  instance instead of options -- for tests that need a handle on the
 *  client itself (e.g. `vi.spyOn(client, 'getAccessMatrix')`) before
 *  rendering, which renderApp's opts-only signature can't provide. */
export function renderWith(client: DataClient, ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>{ui}</DataClientProvider>
    </QueryClientProvider>,
  )
}
