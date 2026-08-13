import type { ReactNode } from 'react'

interface SettingRowProps {
  label: string
  description?: string
  children: ReactNode
  testId?: string
  /** Extra content under the description, in the LABEL column -- a docs link
   *  belonging to this row's subject, a "set in your config file" marker. It
   *  exists because the only slot a row had for such a thing was the control
   *  column, where a link rendered beside a tall control (share-prompts' three
   *  option cards) floated in the leftover space attached to nothing. Anything
   *  that explains the row goes here; anything that ACTS on it stays a child. */
  labelAside?: ReactNode
  /** Cross-axis alignment of label against control. Default 'center' is right
   *  for this page's usual shape -- a one-line label against a chip and a
   *  button. A row whose control is much taller than its label (a radio group)
   *  must pass 'start', or the label is centred against ~300px of control and
   *  reads as floating in mid-air beside the middle option. */
  align?: 'center' | 'start'
  /** What went wrong with THIS row's action, already named ("Couldn't restart
   *  MemBridge."). The group used to share one line reading "Couldn't save the
   *  change." for four unrelated controls, so pressing Restart told you a save
   *  had failed and nothing said which control was broken. Each row now owns
   *  its own message, and the row is the thing that identifies the action. */
  error?: string | null
}

/** One row inside a Settings group: a label (+ optional description) on the
 *  left, a status/control area on the right -- matches settings-solo-v2.html's
 *  .srow. A hairline separator only, never a card. */
export function SettingRow({ label, description, children, testId, error, labelAside, align = 'center' }: SettingRowProps) {
  return (
    <div className={`setting-row${align === 'start' ? ' setting-row-top' : ''}`} data-testid={testId}>
      <div className="setting-row-label">
        {label}
        {description && <div className="setting-row-desc">{description}</div>}
        {labelAside && <div className="setting-row-aside">{labelAside}</div>}
        {error && <div className="setting-row-error" role="alert">{error}</div>}
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
