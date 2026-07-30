import { useEffect, useState } from 'react'

// A lazy route chunk is served from the local daemon's own disk -- on a cold
// window open it lands well under this many ms, so a fallback that appears
// immediately would just be a flash of "Loading…" on the common path. Delay
// showing anything until the load has genuinely taken a moment; if the chunk
// resolves first (the normal case), this component never renders at all.
const FLASH_GUARD_MS = 150

/** Suspense fallback for lazy-loaded routes (see App.tsx). Renders nothing
 *  until FLASH_GUARD_MS has elapsed, so a fast local chunk load never shows a
 *  spinner -- only a genuinely slow one does. */
export function RouteFallback() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setVisible(true), FLASH_GUARD_MS)
    return () => clearTimeout(id)
  }, [])

  if (!visible) return null
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      Loading…
    </div>
  )
}
