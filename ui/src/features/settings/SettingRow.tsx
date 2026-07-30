import type { ReactNode } from 'react'

interface SettingRowProps {
  label: string
  description?: string
  children: ReactNode
  testId?: string
}

/** One row inside a Settings group: a label (+ optional description) on the
 *  left, a status/control area on the right -- matches settings-solo-v2.html's
 *  .srow. A hairline separator only, never a card. */
export function SettingRow({ label, description, children, testId }: SettingRowProps) {
  return (
    <div className="setting-row" data-testid={testId}>
      <div className="setting-row-label">
        {label}
        {description && <div className="setting-row-desc">{description}</div>}
      </div>
      {/* .setting-row-ctl (settings.css) is `flex: none`: it never shrinks
       *  or wraps, so a control that renders several chips at once (the MCP
       *  Re-register result, one per tool) grew past the row's width and
       *  pushed the whole page into horizontal scroll. `flex: none` alone
       *  made flex-wrap a no-op -- the item has to be allowed to SHRINK
       *  (flex-shrink + min-width: 0) before wrapping its own children has
       *  anything to wrap against. `0 1 auto` (shrink yes, grow no) rather
       *  than `1 1 auto`: grow:1 was tried and tested live first (Task 5)
       *  -- it made ctl compete for space with .setting-row-label on EVERY
       *  row, narrowing every description's wrap width even when ctl's own
       *  content was short. shrink-only reproduces the original "size to
       *  content, right-aligned" look exactly for short rows, and still
       *  wraps once content is too wide to fit. Inline, not a CSS file
       *  edit -- row-gap matches .setting-row's own. */}
      <div className="setting-row-ctl" style={{ flex: '0 1 auto', minWidth: 0, flexWrap: 'wrap', rowGap: 6 }}>
        {children}
      </div>
    </div>
  )
}
