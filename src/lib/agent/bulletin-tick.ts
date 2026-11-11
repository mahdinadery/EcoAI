/** Empty bulletins are retryable, but must not starve a due regular slot. */
export function shouldContinueAfterBulletin(reason: string | null | undefined, regularDue: boolean): boolean {
  return regularDue && (reason === "nothing_new" || reason === "no_qualifying_items");
}
