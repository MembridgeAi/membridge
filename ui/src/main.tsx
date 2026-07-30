import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './app/App'
import { DataClientProvider } from './data/DataClientProvider'
import { LocalDaemonClient } from './data/LocalDaemonClient'
import { applyTheme, readStoredMode, watchSystemTheme } from './theme/theme'
import './styles/tokens.css'
import './styles/base.css'
import './components/components.css'
import './app/app.css'

// index.html's inline script already set <html data-theme> before this
// module even loaded (the no-flash requirement), so this call is a
// redundant-but-harmless safety net for any environment where that script
// couldn't run (e.g. matchMedia/localStorage becoming available slightly
// later than expected). watchSystemTheme is registered ONCE here, for the
// life of the whole session -- not tied to whichever screen is mounted --
// so System mode keeps following the OS live no matter which route the
// user is looking at.
applyTheme(readStoredMode())
watchSystemTheme()

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
