/**
 * Dossier dashboard statistics — PURE module (no imports; test-importable).
 *
 * The «پروندهٔ ناشران و نهادها» dashboard ranks publishers (ناشران) and
 * entities (نهادها) along three dimensions the operator asked for:
 *   - count (تعداد)              — how many analyzed items
 *   - time (زمان)                — newest/oldest coverage + last-7-days window
 *   - importance (امتیاز اهمیت)  — average/max score + high/mid/low distribution
 *
 * Aggregation runs over a bounded recent scan (the admin entities route scans
 * the newest analyzed rows) so this stays vendor-agnostic and deterministic.
 * Sort tie-breaks ALWAYS fall back to a Persian-locale name compare so lists
 * are stable across runs (never insertion order).
 */

export type DossierRow = {
  /** Publisher name (`news.source`). */
  source: string;
  /** Extracted entity names (`news.entity_tags`). */
  entityTags: readonly string[] | null | undefined;
  /** 0..100 AI importance; null when the row has no score. */
  importanceScore: number | null;
  /** How many DISTINCT sources carry the same event (>=2 = confirmed). */
  corroborationCount: number | null;
  publishedAt: Date | string | null;
  createdAt: Date | string;
};

export type MetricStat = {
  name: string;
  /** Analyzed items mentioning/produced by this name. */
  count: number;
  /** Items that actually carry an importance score. */
  scoredCount: number;
  /** Mean importance over scored items (0 when none). */
  avgImportance: number;
  maxImportance: number;
  /** Distribution buckets over scored items: >=70 / 40..69 / <40. */
  highCount: number;
  midCount: number;
  lowCount: number;
  /** Items with corroborationCount >= 2. */
  corroboratedCount: number;
  lastPublishedAt: string | null;
  firstPublishedAt: string | null;
  /** Items whose effective time falls within the last 7 days of `now`. */
  recent7d: number;
};

export type DossierKpis = {
  scanned: number;
  publisherCount: number;
  entityCount: number;
  scoredCount: number;
  avgImportance: number;
  corroboratedCount: number;
  lastPublishedAt: string | null;
};

export type SortKey = "count" | "time" | "importance" | "name";
export type SortDir = "asc" | "desc";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** Importance buckets mirror the send gates (threshold 70). */
const HIGH_MIN = 70;
const MID_MIN = 40;

function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** `publishedAt` when present, otherwise the ingestion time. */
function effectiveMillis(row: DossierRow): number {
  return toMillis(row.publishedAt) ?? toMillis(row.createdAt) ?? 0;
}

type Acc = {
  name: string;
  count: number;
  scoredCount: number;
  importanceSum: number;
  maxImportance: number;
  highCount: number;
  midCount: number;
  lowCount: number;
  corroboratedCount: number;
  lastMillis: number | null;
  firstMillis: number | null;
  recent7d: number;
};

function emptyAcc(name: string): Acc {
  return {
    name,
    count: 0,
    scoredCount: 0,
    importanceSum: 0,
    maxImportance: 0,
    highCount: 0,
    midCount: 0,
    lowCount: 0,
    corroboratedCount: 0,
    lastMillis: null,
    firstMillis: null,
    recent7d: 0,
  };
}

function absorb(acc: Acc, row: DossierRow, nowMillis: number): void {
  acc.count += 1;
  const score = row.importanceScore;
  if (typeof score === "number" && Number.isFinite(score)) {
    acc.scoredCount += 1;
    acc.importanceSum += score;
    if (score > acc.maxImportance) acc.maxImportance = score;
    if (score >= HIGH_MIN) acc.highCount += 1;
    else if (score >= MID_MIN) acc.midCount += 1;
    else acc.lowCount += 1;
  }
  if ((row.corroborationCount ?? 0) >= 2) acc.corroboratedCount += 1;
  const when = effectiveMillis(row);
  if (acc.lastMillis === null || when > acc.lastMillis) acc.lastMillis = when;
  if (acc.firstMillis === null || when < acc.firstMillis) acc.firstMillis = when;
  if (when >= nowMillis - RECENT_MS) acc.recent7d += 1;
}

function finalize(acc: Acc): MetricStat {
  return {
    name: acc.name,
    count: acc.count,
    scoredCount: acc.scoredCount,
    avgImportance: acc.scoredCount > 0 ? Math.round(acc.importanceSum / acc.scoredCount) : 0,
    maxImportance: acc.maxImportance,
    highCount: acc.highCount,
    midCount: acc.midCount,
    lowCount: acc.lowCount,
    corroboratedCount: acc.corroboratedCount,
    lastPublishedAt: acc.lastMillis === null ? null : new Date(acc.lastMillis).toISOString(),
    firstPublishedAt: acc.firstMillis === null ? null : new Date(acc.firstMillis).toISOString(),
    recent7d: acc.recent7d,
  };
}

export function emptyMetricStat(name: string): MetricStat {
  return finalize(emptyAcc(name));
}

function sortByName(stats: MetricStat[]): MetricStat[] {
  return [...stats].sort((a, b) => a.name.localeCompare(b.name, "fa"));
}

/** Per-publisher stats over the scanned rows (empty publisher names skipped). */
export function buildPublisherStats(rows: readonly DossierRow[], now: Date = new Date()): MetricStat[] {
  const nowMillis = now.getTime();
  const accs = new Map<string, Acc>();
  for (const row of rows) {
    const name = (row.source ?? "").trim();
    if (!name) continue;
    const acc = accs.get(name) ?? emptyAcc(name);
    absorb(acc, row, nowMillis);
    accs.set(name, acc);
  }
  return sortByName([...accs.values()].map(finalize));
}

/** Per-entity stats over the scanned rows (empty tags skipped). */
export function buildEntityStats(rows: readonly DossierRow[], now: Date = new Date()): MetricStat[] {
  const nowMillis = now.getTime();
  const accs = new Map<string, Acc>();
  for (const row of rows) {
    for (const tag of row.entityTags ?? []) {
      const name = tag.trim();
      if (!name) continue;
      const acc = accs.get(name) ?? emptyAcc(name);
      absorb(acc, row, nowMillis);
      accs.set(name, acc);
    }
  }
  return sortByName([...accs.values()].map(finalize));
}

export function buildDossierKpis(
  rows: readonly DossierRow[],
  publishers: readonly MetricStat[],
  entities: readonly MetricStat[],
): DossierKpis {
  let scoredCount = 0;
  let importanceSum = 0;
  let corroboratedCount = 0;
  let lastMillis: number | null = null;
  for (const row of rows) {
    const score = row.importanceScore;
    if (typeof score === "number" && Number.isFinite(score)) {
      scoredCount += 1;
      importanceSum += score;
    }
    if ((row.corroborationCount ?? 0) >= 2) corroboratedCount += 1;
    const when = effectiveMillis(row);
    if (lastMillis === null || when > lastMillis) lastMillis = when;
  }
  return {
    scanned: rows.length,
    publisherCount: publishers.length,
    entityCount: entities.length,
    scoredCount,
    avgImportance: scoredCount > 0 ? Math.round(importanceSum / scoredCount) : 0,
    corroboratedCount,
    lastPublishedAt: lastMillis === null ? null : new Date(lastMillis).toISOString(),
  };
}

export type DossierStats = {
  publishers: MetricStat[];
  entities: MetricStat[];
  kpis: DossierKpis;
};

export function buildDossierStats(rows: readonly DossierRow[], now: Date = new Date()): DossierStats {
  const publishers = buildPublisherStats(rows, now);
  const entities = buildEntityStats(rows, now);
  return { publishers, entities, kpis: buildDossierKpis(rows, publishers, entities) };
}

/**
 * Deterministic comparator: the requested dimension first, then a Persian
 * name tie-break (never insertion order). Time sorting keeps nulls last in
 * both directions; importance ties fall to max, then count.
 */
export function compareStats(a: MetricStat, b: MetricStat, key: SortKey, dir: SortDir): number {
  // Sort direction: desc puts bigger/newer first (negative when a > b).
  const flip = dir === "asc" ? 1 : -1;
  let primary = 0;
  if (key === "name") {
    primary = a.name.localeCompare(b.name, "fa") * flip;
  } else if (key === "count") {
    primary = (a.count - b.count) * flip;
  } else if (key === "importance") {
    primary =
      (a.avgImportance - b.avgImportance) * flip ||
      (a.maxImportance - b.maxImportance) * flip ||
      (a.count - b.count) * flip;
  } else {
    const at = toMillis(a.lastPublishedAt);
    const bt = toMillis(b.lastPublishedAt);
    if (at !== null && bt !== null) primary = (at - bt) * flip;
    else if (at !== null) primary = -1;
    else if (bt !== null) primary = 1;
  }
  return primary !== 0 ? primary : a.name.localeCompare(b.name, "fa");
}

/** Returns a NEW sorted copy (input order untouched). */
export function sortStats(list: readonly MetricStat[], key: SortKey, dir: SortDir): MetricStat[] {
  return [...list].sort((a, b) => compareStats(a, b, key, dir));
}
