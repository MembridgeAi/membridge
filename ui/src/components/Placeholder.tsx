interface PlaceholderProps {
  title: string
}

/** Stand-in for a route whose feature task has not landed yet. */
export function Placeholder({ title }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <div className="placeholder-title">{title}</div>
      <div className="placeholder-note">Not built yet.</div>
    </div>
  )
}
