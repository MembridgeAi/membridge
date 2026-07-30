// Shared textarea<->string[] conversion for the "one entry per line" editors
// (redaction patterns, excluded folders, context-file targets). Kept as pure
// functions so ContextFilesDialog and EditListDialog agree on the exact same
// parsing rule instead of drifting into two slightly different ones.
export function linesToList(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(Boolean)
}

export function listToLines(list: string[]): string {
  return list.join('\n')
}

// Appends paths picked from a native Finder/Explorer dialog onto the current
// textarea text, skipping any path already present as a line -- picking the
// same folder twice must not duplicate it in the excluded-folders or
// context-files list.
export function mergeLines(existingText: string, additions: string[]): string {
  const existing = linesToList(existingText)
  const seen = new Set(existing)
  const merged = existing.slice()
  for (const addition of additions) {
    if (seen.has(addition)) continue
    seen.add(addition)
    merged.push(addition)
  }
  return listToLines(merged)
}
