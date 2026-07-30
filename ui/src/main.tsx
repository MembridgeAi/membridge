import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'

// Placeholder root render. The real app shell, routing, and pages are
// scaffolded in later tasks — this only proves the Vite/React/token
// pipeline builds and boots end to end.
const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Root element #root not found')
}

createRoot(rootEl).render(
  <StrictMode>
    <div className="mono">MemBridge</div>
  </StrictMode>,
)
