/**
 * Normalization helpers (Milestone 6).
 *
 * Normalized values are stored NEXT TO the raw ones (`normalizedTitle` /
 * `normalizedContent`); the raw feed values are never modified, so the original
 * source data can always be inspected or re-processed.
 */

const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

export function normalizeText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;

  let text = value.replace(INVISIBLE_CHARS, "");
  // Collapse horizontal whitespace/new runs but keep paragraph breaks in content.
  text = text.replace(/[ \t\u00A0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}…`;
}

export function normalizeTitle(title: string): string {
  // Titles never keep newlines: a single clean line.
  const flat = title.replace(INVISIBLE_CHARS, "").replace(/\s+/g, " ").trim();
  const safe = flat || "بدون عنوان";
  return safe.length <= 500 ? safe : `${safe.slice(0, 499)}…`;
}

export function normalizeContent(content: string | null | undefined, description: string | null | undefined): string | null {
  return normalizeText(content ?? description, 20_000);
}
