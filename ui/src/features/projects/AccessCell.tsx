interface AccessCellProps {
  memberName: string
  checked: boolean
  disabled: boolean
  isSelf: boolean
  onToggle: (checked: boolean) => void
}

/**
 * One member x project cell in the grid. A plain checkbox (not the Toggle
 * switch — this is a dense table, not a settings panel), disabled+dashed
 * (`.access-cell-na`) for a private project since nobody else can be given
 * access until it's shared. `data-self` marks the viewer's own column so
 * tests (and the disabled-row check below) can single it out.
 */
export function AccessCell({ memberName, checked, disabled, isSelf, onToggle }: AccessCellProps) {
  return (
    <input
      type="checkbox"
      className={`access-cell${disabled ? ' access-cell-na' : ''}`}
      checked={checked}
      disabled={disabled}
      data-self={isSelf ? 'true' : 'false'}
      aria-label={`${memberName} can see this project`}
      onChange={e => onToggle(e.target.checked)}
    />
  )
}
