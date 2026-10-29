/**
 * «چرا مهم است» quality guard — PURE module (no imports; test-importable).
 *
 * The legacy prompt told the model to answer «برای مخاطب هدف اهمیت مشخصی
 * ندارد» whenever it was unsure — and that canned filler shipped to the
 * channel even for stories rated 80+. This module rejects such filler at
 * parse time (stored as null → the message simply omits the section) and
 * keeps only concrete, meaningful one-liners.
 */

/** Canned/negation/garbage answers we never store or show. */
const WHY_NOISE_PATTERNS: RegExp[] = [
  /اهمیت مشخصی ندارد/,
  /اهمیت (خاص|چندان|روشن|واقعی)ی ندارد/,
  /مهم نیست/,
  /بدون (اهمیت|ربط|ارتباط)/,
  /^(ندارد|نیست|هیچ|—|-|–|\.)\s*[.،]?\s*$/,
  /^(n\/a|na|none|null)\s*$/i,
];

/** Below this many characters a "why" cannot carry real meaning. */
const MIN_WHY_LENGTH = 12;

/**
 * Returns the cleaned one-liner, or null when the value is missing, too
 * short to mean anything, or boilerplate filler. Null means: omit the
 * «چرا مهم است» section entirely — a blank is better than nonsense.
 */
export function sanitizeWhyItMatters(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length < MIN_WHY_LENGTH) return null;
  for (const pattern of WHY_NOISE_PATTERNS) {
    if (pattern.test(text)) return null;
  }
  return text;
}
