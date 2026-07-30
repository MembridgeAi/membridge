import type { ComponentPropsWithoutRef } from 'react'

type RuledRowProps = ComponentPropsWithoutRef<'div'>

/** A flex row separated from its neighbors by a single hairline — the only
 *  structural device in this system. Never a shadow, never a card. */
export function RuledRow({ className, children, ...rest }: RuledRowProps) {
  const classes = className ? `ruled-row ${className}` : 'ruled-row'
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  )
}
