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
      <div className="setting-row-ctl">{children}</div>
    </div>
  )
}
