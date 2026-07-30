import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './app/App'
import { DataClientProvider } from './data/DataClientProvider'
import { LocalDaemonClient } from './data/LocalDaemonClient'
import './styles/tokens.css'
import './styles/base.css'
import './components/components.css'
import './app/app.css'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found')
}

const queryClient = new QueryClient()
const dataClient = new LocalDaemonClient()

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DataClientProvider client={dataClient}>
        <App />
      </DataClientProvider>
    </QueryClientProvider>
  </StrictMode>,
)
