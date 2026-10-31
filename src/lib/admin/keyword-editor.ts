/** Preserve the user's raw separators while committing usable values immediately. */
export function parseKeywordText(text: string): string[] {
  return text.split(/[,،\n]/).map(word => word.trim()).filter(Boolean);
}

export function reconcileKeywordText(text: string, values: string[]): string {
  return JSON.stringify(parseKeywordText(text)) === JSON.stringify(values) ? text : values.join("، ");
}
