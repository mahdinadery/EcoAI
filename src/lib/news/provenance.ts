/**
 * Article provenance lookups — SERVER-SIDE ONLY.
 *
 * One OpenAlex request per digest item, to recover the authors' institutions that
 * RSS never carries. Parsing and transport share this one file; see the note below.
 *
 * Rules this module exists to enforce:
 *  - it NEVER throws and NEVER blocks a send: every failure mode (offline host,
 *    DNS, 404, slow API, malformed JSON) yields "no line in the bulletin";
 *  - total work is bounded by a wall-clock budget, not by item count, so a
 *    digest can't lose its publishing window to a third-party API;
 *  - no database writes. OpenAlex indexes daily, so a cached miss would age
 *    worse than refetching eight ids once a week.
 *
 * Env:
 *  - `NEWS_ARTICLE_PROVENANCE=false`            — kill switch (default: on).
 *  - `NEWS_ARTICLE_PROVENANCE_BASE_URL`         — override the API host (tests/proxies).
 *  - `NEWS_ARTICLE_PROVENANCE_MAILTO`           — contact address for the polite pool.
 *  - `NEWS_ARTICLE_PROVENANCE_TIMEOUT_MS`       — per request (250–10000, default 2500).
 *  - `NEWS_ARTICLE_PROVENANCE_BUDGET_MS`        — whole lookup pass (500–20000, default 6000).
 *  - `NEWS_FETCH_PROXY_URL`                     — shared outbound proxy, same as the feed client.
 *
 * The pure helpers live in this same file (not a `-core` sibling) on purpose:
 * `node --test` can only import a module whose own imports resolve at runtime,
 * and the parsing here is worthless to test without the fetch behaviour around it.
 * Bounded-concurrency is three lines of batching rather than an import of
 * `./concurrent-pool` for the same reason — ten items is the whole workload.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

const OPENALEX_DEFAULT_BASE = "https://api.openalex.org";
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_BUDGET_MS = 6_000;
const DEFAULT_CONCURRENCY = 4;
/** Trimmed response: only the fields `normalizeOpenAlexWork` reads. */
const SELECT_FIELDS = "id,doi,authorships,authorships_count,primary_location";

/**
 * arXiv registers a DataCite DOI per submission and OpenAlex indexes works by it.
 * Canonical casing is used for the outgoing lookup (the path form of an external-id
 * lookup is not documented as case-insensitive), while everything we *match* on is
 * compared case-insensitively.
 */
export const ARXIV_DOI_PREFIX = "10.48550/arXiv.";

/**
 * Institutions that show up on arXiv records without meaning "where the authors
 * work": arXiv's own repository, and the placeholder OpenAlex assigns when it
 * could not resolve an affiliation string. Listed explicitly and kept short —
 * an aggressive deny-list would silently hide real universities.
 */
const NOISE_INSTITUTIONS = new Set(["arxiv", "arxivorg", "concordiacollider", "unknowninstitute"]);

export type ProvenanceInstitution = {
  name: string;
  /** ISO country code from OpenAlex (`null` when the record has none). */
  country: string | null;
  /** OpenAlex institution type, e.g. "education" | "company" | "government". */
  type: string | null;
  /** Why this one ranks first: corresponding author, then first author. */
  rank: "corresponding" | "first" | "other";
};

export type ProvenanceInfo = {
  arxivId: string;
  institutions: ProvenanceInstitution[];
  /**
   * Journal or conference the work is published in, when OpenAlex knows a real
   * one — `null` for a preprint whose only location is arXiv itself (the
   * self-archived copy would otherwise be reported as the publisher).
   */
  venue: string | null;
  /** Author count as OpenAlex saw it (may exceed the number of institutions). */
  authorCount: number;
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * arXiv has two id shapes: modern `2511.01234` (optionally `v2`) and legacy
 * `cs/0201001` / `math.GT/0309136`. Both are matched as *strings*, so a pattern
 * that finds a non-id returns no match instead of returning garbage.
 */
const ARXIV_ID = "(?:\\d{4}\\.\\d{4,5}|[a-z][a-z-]*(?:\\.[a-z-]+)?/\\d{7})";
const ARXIV_VERSION = "(?:v\\d+)?";

/** Where an arXiv id can hide, in the order we trust them. Group 1 is the id. */
const ARXIV_ID_PATTERNS: RegExp[] = [
  new RegExp(`arxiv\\.org/(?:abs|pdf|epdf|html|src)/(${ARXIV_ID})${ARXIV_VERSION}`, "i"),
  // arXiv's DataCite DOI prefix — the form OpenAlex indexes preprints by.
  new RegExp(`10\\.48550/arxiv\\.(${ARXIV_ID})${ARXIV_VERSION}`, "i"),
  // export.arxiv.org/api/query?id_list=2511.01234v2,2511.01235
  new RegExp(`[?&]id_list=(${ARXIV_ID})${ARXIV_VERSION}`, "i"),
  new RegExp(`^oai:arxiv\\.org:(${ARXIV_ID})${ARXIV_VERSION}$`, "i"),
  new RegExp(`^(?:arxiv:)?(${ARXIV_ID})${ARXIV_VERSION}$`, "i"),
];

/**
 * Finds the arXiv id in an abs/pdf/epdf URL, a DOI URL, an `id_list=` query, or
 * the `id` field of an arXiv RSS entry. Version suffixes are dropped: the DOI is
 * versionless. `null` for everything else, including arXiv listing pages.
 */
export function extractArxivId(...candidates: (string | null | undefined)[]): string | null {
  for (const raw of candidates) {
    const value = raw?.trim();
    if (!value) continue;
    for (const pattern of ARXIV_ID_PATTERNS) {
      const id = pattern.exec(value)?.[1];
      if (id) return id;
    }
  }
  return null;
}

/**
 * Path segment for the single-work endpoint:
 * `works/doi:10.48550/arXiv.2511.01234`. The `doi:` selector is what turns this
 * into an external-id lookup — without it OpenAlex reads the whole thing as an
 * OpenAlex id and answers 404 for every paper.
 */
export function openAlexWorkPath(arxivId: string): string {
  return `works/doi:${ARXIV_DOI_PREFIX}${arxivId}`;
}

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * `primary_location.source` is where the published copy lives. arXiv appears there
 * for most preprints — a "source" in OpenAlex, not a publisher — and would just
 * repeat the feed line, so repository-shaped names are dropped.
 */
function extractVenue(work: LooseRecord): string | null {
  const source = asRecord(asRecord(work.primary_location)?.source);
  const name = source ? asString(source.display_name) : null;
  if (!name) return null;
  const key = normalizeName(name);
  if (!key || key.includes("arxiv") || NOISE_INSTITUTIONS.has(key)) return null;
  return name;
}

/**
 * Reads the institution list off an OpenAlex work.
 *
 * `authorships[].institutions` is the ONLY place they live — the top-level
 * `institutions` field on a work is reserved and empty in the API, which is the
 * kind of detail that silently produces "no affiliations" forever.
 */
export function normalizeOpenAlexWork(raw: unknown, options: { maxInstitutions?: number } = {}): ProvenanceInfo | null {
  const work = asRecord(raw);
  if (!work) return null;
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  if (authorships.length === 0) return null;
  const max = Math.max(1, Math.min(10, Math.trunc(options.maxInstitutions ?? 3)));

  const picked: ProvenanceInstitution[] = [];
  const seen = new Set<string>();
  const push = (name: string, institution: LooseRecord, rank: ProvenanceInstitution["rank"]) => {
    const key = normalizeName(name);
    if (!key || seen.has(key) || NOISE_INSTITUTIONS.has(key)) return;
    seen.add(key);
    picked.push({
      name,
      country: asString(institution.country_code)?.toUpperCase() ?? null,
      type: asString(institution.type),
      rank,
    });
  };

  // Rank order, one pass per tier: a corporate lab named by the corresponding
  // author outranks the first author's university, which outranks the rest.
  for (const tier of ["corresponding", "first", "other"] as const) {
    for (const entry of authorships) {
      const authorship = asRecord(entry);
      if (!authorship) continue;
      const isCorresponding = authorship.is_corresponding === true;
      const position = asString(authorship.author_position);
      const matches =
        tier === "corresponding" ? isCorresponding : tier === "first" ? !isCorresponding && position === "first" : !isCorresponding && position !== "first";
      if (!matches) continue;
      const institutions = Array.isArray(authorship.institutions) ? authorship.institutions : [];
      for (const institutionEntry of institutions) {
        const institution = asRecord(institutionEntry);
        const name = institution ? asString(institution.display_name) : null;
        if (name && institution) push(name, institution, tier);
      }
      // Two institutions on one authorship is already enough for that tier.
      if (picked.length >= max) break;
    }
  }

  const arxivId = extractArxivId(asString(work.doi) ?? undefined) ?? extractArxivId(asString(work.id) ?? undefined);
  return {
    arxivId: arxivId ?? "",
    institutions: picked.slice(0, max),
    venue: extractVenue(work),
    authorCount: typeof work.authorships_count === "number" ? work.authorships_count : authorships.length,
  };
}

/**
 * The bulletin line: «🎓 University of Oxford · Google DeepMind». Empty string when
 * nothing survived normalization, so the caller skips the line instead of printing
 * a label with nothing behind it.
 */
export function formatAffiliationLine(institutions: readonly ProvenanceInstitution[], max = 3): string {
  return institutions
    .slice(0, Math.max(1, max))
    .map((entry) => entry.name)
    .join(" · ");
}

export type ProvenanceConfig = {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  budgetMs: number;
  mailto: string | null;
  userAgent: string;
};

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

export function provenanceConfig(): ProvenanceConfig {
  const mailto = process.env.NEWS_ARTICLE_PROVENANCE_MAILTO?.trim() || null;
  return {
    enabled: process.env.NEWS_ARTICLE_PROVENANCE?.trim() !== "false",
    baseUrl: (process.env.NEWS_ARTICLE_PROVENANCE_BASE_URL?.trim() || OPENALEX_DEFAULT_BASE).replace(/\/+$/, ""),
    timeoutMs: intEnv("NEWS_ARTICLE_PROVENANCE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 250, 10_000),
    budgetMs: intEnv("NEWS_ARTICLE_PROVENANCE_BUDGET_MS", DEFAULT_BUDGET_MS, 500, 20_000),
    mailto,
    userAgent: mailto ? `EcoAI bulletin provenance (mailto:${mailto})` : "EcoAI bulletin provenance",
  };
}

type LookupTarget = {
  /** Article key to report the result under (the news row id). */
  key: string;
  url: string | null;
  externalId?: string | null;
};

async function fetchWorkJson(endpoint: string, config: ProvenanceConfig): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const proxyUrl = process.env.NEWS_FETCH_PROXY_URL?.trim();
  let dispatcher: ProxyAgent | undefined;
  if (proxyUrl) {
    try {
      dispatcher = new ProxyAgent(proxyUrl);
    } catch {
      dispatcher = undefined;
    }
  }
  const query = config.mailto
    ? `select=${SELECT_FIELDS}&mailto=${encodeURIComponent(config.mailto)}`
    : `select=${SELECT_FIELDS}`;
  try {
    const response = await undiciFetch(`${endpoint}?${query}`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": config.userAgent },
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    // A host that rejects `select` (proxy, older mirror) still answers the plain URL.
    if (response.status === 400) {
      const plain = await undiciFetch(endpoint, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": config.userAgent },
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      return plain.ok ? await plain.json().catch(() => null) : null;
    }
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the given articles to OpenAlex works, best-effort. Returns a map keyed
 * by `LookupTarget.key`; entries that could not be identified (not an arXiv URL,
 * not indexed yet, network unhappy) are simply absent.
 */
export async function fetchProvenance(
  articles: readonly LookupTarget[],
  overrides: Partial<Pick<ProvenanceConfig, "timeoutMs" | "budgetMs" | "baseUrl" | "mailto">> = {},
): Promise<Map<string, ProvenanceInfo>> {
  const results = new Map<string, ProvenanceInfo>();
  const config: ProvenanceConfig = { ...provenanceConfig(), ...overrides };
  if (!config.enabled || articles.length === 0) return results;

  const targets = articles
    .map((article) => ({
      key: article.key,
      arxivId: extractArxivId(article.url, article.externalId),
    }))
    .filter((entry): entry is { key: string; arxivId: string } => Boolean(entry.arxivId));
  if (targets.length === 0) return results;

  const startedAt = Date.now();
  for (let offset = 0; offset < targets.length; offset += DEFAULT_CONCURRENCY) {
    // Stop starting work once the digest's own budget is spent: a slow API costs a
    // missing line, never the publishing window.
    if (offset > 0 && Date.now() - startedAt >= config.budgetMs) break;
    const batch = targets.slice(offset, offset + DEFAULT_CONCURRENCY);
    await Promise.all(
      batch.map(async (target) => {
        const json = await fetchWorkJson(`${config.baseUrl}/${openAlexWorkPath(target.arxivId)}`, config);
        const info = normalizeOpenAlexWork(json);
        if (info) results.set(target.key, info);
      }),
    );
  }

  return results;
}

/** What a digest entry needs from a provenance lookup, already flattened. */
export type BulletinProvenance = {
  institutions: string[];
  venue: string | null;
};

/**
 * Convenience for the digest builders: institution names + venue per article,
 * empty when the operator turned the option off. Never rejects — a bulletin must
 * not fail because a metadata API is down.
 */
export async function bulletinProvenance(
  articles: readonly { id: string; url: string; externalId?: string | null }[],
  enabled: boolean,
): Promise<Map<string, BulletinProvenance>> {
  const found = new Map<string, BulletinProvenance>();
  if (!enabled) return found;
  try {
    const provenance = await fetchProvenance(
      articles.map((article) => ({ key: article.id, url: article.url, externalId: article.externalId })),
    );
    for (const [key, info] of provenance) {
      const institutions = info.institutions.map((entry) => entry.name).filter(Boolean);
      if (institutions.length || info.venue) found.set(key, { institutions, venue: info.venue });
    }
  } catch (error) {
    console.error("[provenance] lookup failed:", String(error).slice(0, 160));
  }
  return found;
}
