import { useEffect, useRef } from 'react'

// What counts as focusable inside a dialog panel for the Tab trap below.
// Deliberately small: these dialogs only ever contain buttons, inputs,
// selects, textareas and checkboxes -- no iframes/audio/contenteditable.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * The modal half of the contract `aria-modal="true"` promises (Fix 11) --
 * both dialogs claimed it while implementing none of it. One shared hook so
 * ConfirmDialog and FormDialog can't drift:
 *
 *   - on mount, focus moves into the panel (first focusable, else the panel
 *     itself -- give the panel tabIndex={-1} so that fallback works);
 *   - Tab / Shift+Tab wrap inside the panel instead of escaping to the page
 *     behind the overlay;
 *   - Escape calls `onClose` (pass undefined to disable, e.g. while a
 *     destructive action is pending and Cancel is disabled too);
 *   - on unmount, focus returns to whatever had it when the dialog opened.
 *
 * Attach the returned ref to the dialog panel element.
 */
export function useDialogFocus(onClose?: () => void) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Read through a ref so the mount effect below never re-runs (and never
  // re-steals focus) just because the caller re-rendered with a new closure.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
    ;(focusables()[0] ?? panel).focus()

    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      // Wrap at the edges; also catch focus that is outside the panel
      // entirely (or parked on the panel itself) and pull it back in.
      if (e.shiftKey && (active === first || !panel!.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel!.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeydown)
    return () => {
      document.removeEventListener('keydown', handleKeydown)
      opener?.focus()
    }
  }, [])

  return panelRef
}
