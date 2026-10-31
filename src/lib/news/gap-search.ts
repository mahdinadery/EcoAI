/**
 * Coverage-gap search (roadmap Phase 1, task #2) — PURE LOGIC ONLY.
 *
 * When a scheduled pass finds nothing to send, the agent searches news feeds
 * for the configured coverage topics (instead of going silent) and feeds the
 * results through the SAME topic gate + analysis + strict send rule.
 *
 * This module is imported by the Node test runner (node --test) and therefore
 * must not import anything at runtime from other TS modules (type-only is
 * fine). Fetching, topic gating, and storing live in `source-ingest.ts` /
 * `scheduled-run.ts`.
 */

/** Default provider: Bing News RSS — plain RSS, no API key, query in the URL. */
export const DEFAULT_NEWS_SEARCH_URL_TEMPLATE =
  "https://www.bing.com/news/search?q={query}&format=rss";

/** Upper bound of queries used per gap-search run. */
export const MAX_GAP_QUERIES = 5;

/**
 * Flattens topic keywords (AiTopicRule[]) down to a query list for gap search.
 * Longer multi-word keywords come first — they are the most specific to the
 * coverage domain and produce the least noise.
 */
export function deriveGapQueries(
  coverageKeywords: string[],
  manualQueries: string[] | null | undefined,
  max: number = MAX_GAP_QUERIES,
): string[] {
  const cap = Math.max(1, Math.min(max, 10));

  // Manual override: when the operator typed explicit queries, they replace
  // the derived ones entirely (the operator knows better than the heuristic).
  const manual = (manualQueries ?? [])
    .map((query) => query.trim())
    .filter((query) => query.length > 0 && query.length <= 200);
  if (manual.length > 0) {
    return dedupeStrings(manual).slice(0, cap);
  }

  const derived = coverageKeywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length >= 2 && keyword.length <= 120)
    // Longest first (most specific), stable within equal lengths.
    .sort((a, b) => b.length - a.length);

  return dedupeStrings(derived).slice(0, cap);
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Builds a feed URL for one query. `{query}` in the template is replaced with
 * the URL-encoded query. Providers without RSS (plain API endpoints) are out
 * of scope — the runner parses the response with the regular feed parser.
 */
export function buildSearchUrl(query: string, template?: string | null): string {
  const trimmedQuery = query.trim();
  const chosen =
    template && template.includes("{query}")
      ? template.trim()
      : DEFAULT_NEWS_SEARCH_URL_TEMPLATE;
  return chosen.replace("{query}", encodeURIComponent(trimmedQuery));
}

/**
 * Drops items whose canonical URL is already known (stored news or an earlier
 * result in the same batch). Returns both partitions so the caller can log or
 * count duplicates without re-scanning.
 */
export function dedupeByCanonical<T>(
  items: T[],
  canonicalOf: (item: T) => string,
  existing: Set<string>,
): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(existing);
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const item of items) {
    const canonical = canonicalOf(item);
    if (!canonical || seen.has(canonical)) {
      duplicates.push(item);
      continue;
    }
    seen.add(canonical);
    fresh.push(item);
  }
  return { fresh, duplicates };
}
