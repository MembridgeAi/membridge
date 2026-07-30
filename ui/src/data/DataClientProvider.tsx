import { createContext, useContext, type ReactNode } from 'react'
import type { DataClient } from './DataClient'

const Ctx = createContext<DataClient | null>(null)

export function DataClientProvider({ client, children }: { client: DataClient; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>
}

export function useDataClient(): DataClient {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDataClient must be used inside DataClientProvider')
  return c
}
