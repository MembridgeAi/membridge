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
