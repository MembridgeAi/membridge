interface MembridgeMarkProps {
  className?: string
}

/** The MemBridge brand mark, inlined as a React component rather than an
 *  `<img src>` pointing at the .svg file.
 *
 *  Why inline instead of importing the asset: Vite's default handling of a
 *  file this small (~250 bytes) is to base64/URL-encode it straight into
 *  the JS bundle as a `data:` URI and hand that to `<img src>` — which
 *  works today, but ties correct rendering to Vite's asset-inlining
 *  threshold (silently switches to a real emitted file + URL fetch once
 *  the artwork crosses ~4kb) and to `data:` URIs being permitted whatever
 *  the packaged Electron shell's CSP ends up being. Inlining the markup
 *  removes both dependencies: the mark has explicit intrinsic width/height
 *  on the element itself, so it can never collapse to a zero-size broken
 *  image regardless of load order, CSP, or build target.
 *
 *  Stroke is the fixed brand blue (#3E63F0) rather than `currentColor` in
 *  both themes on purpose: that stroke already reads clearly against both
 *  the dark-navy panel (dark theme) and the white panel (light theme) —
 *  the same contrast the active-nav-item text already relies on against
 *  this same background — so there is no theme-conditional color to wire.
 *
 *  Accessibility: `role="img"` + `aria-label` puts the accessible name on
 *  the mark itself (matches `getByRole('img', { name: 'MemBridge' })`).
 *  The adjacent wordmark span in Shell.tsx stays `aria-hidden` so the name
 *  is announced once, not twice. */
export function MembridgeMark({ className }: MembridgeMarkProps) {
  return (
    <svg
      className={className}
      role="img"
      aria-label="MemBridge"
      viewBox="0 0 32 32"
      width="18"
      height="18"
      fill="none"
      stroke="#3E63F0"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 22.5 V11 L16 18 L23 11 V22.5" />
      <path d="M5 16.5 H27" />
    </svg>
  )
}
