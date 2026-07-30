import type { ReactNode } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient, type FakeOptions } from '../data/FakeDataClient'
import { App } from '../app/App'

/** Shared render helper for app-level tests: a fresh QueryClient (retries
 *  off, so error states surface immediately) wired to a FakeDataClient, with
 *  either the full <App /> or a caller-supplied node underneath. */
export function renderApp(opts: FakeOptions = {}, ui?: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={new FakeDataClient(opts)}>{ui ?? <App />}</DataClientProvider>
    </QueryClientProvider>,
  )
}
