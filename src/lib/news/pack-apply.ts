/**
 * Applies the sources of a news pack — pure orchestration with injected
 * dependencies, so it is unit-testable without database or network access.
 *
 * The rule is deliberately conservative: an existing URL is never touched, a
 * candidate is only registered after its feed actually parses, and one failing
 * source never blocks the others.
 */

import type { NewsPack, NewsPackSource } from "./news-packs";

export type PackSourceOutcome = {
  name: string;
  url: string;
  status: "added" | "skipped" | "failed";
  message?: string;
};

export type PackSourceProbe =
  | { ok: true; itemCount: number }
  | { ok: false; message: string; detail?: string | null };

export type PackSourceDeps = {
  /** URLs already registered in the installation (any order). */
  listExistingUrls: () => Promise<string[]>;
  /** Read-only feed probe (no stored rows). */
  probe: (url: string) => Promise<PackSourceProbe>;
  /** Registers one source; may throw (validation/DB). */
  create: (source: NewsPackSource) => Promise<void>;
  /** Parallel probes; default 3. */
  concurrency?: number;
};

/**
 * URL identity for duplicate detection. Mirrors `normalizeSourceUrl` in
 * news-packs.ts; kept local so this module stays import-free at runtime (the
 * Node test runner strips types but cannot resolve extensionless value imports).
 */
function compareUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export type PackSourcesResult = {
  results: PackSourceOutcome[];
  added: number;
  skipped: number;
  failed: number;
};

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 240);
}

export async function applyPackSources(pack: NewsPack, deps: PackSourceDeps): Promise<PackSourcesResult> {
  const existing = new Set((await deps.listExistingUrls()).map(compareUrl));

  const results = await mapWithConcurrency(pack.sources, deps.concurrency ?? 3, async (candidate) => {
    if (existing.has(compareUrl(candidate.url))) {
      return {
        name: candidate.name,
        url: candidate.url,
        status: "skipped",
        message: "این منبع از قبل ثبت شده است.",
      } satisfies PackSourceOutcome;
    }

    let probe: PackSourceProbe;
    try {
      probe = await deps.probe(candidate.url);
    } catch (error) {
      return {
        name: candidate.name,
        url: candidate.url,
        status: "failed",
        message: `تست فید ناموفق بود: ${errorMessage(error)}`,
      } satisfies PackSourceOutcome;
    }

    if (!probe.ok) {
      return {
        name: candidate.name,
        url: candidate.url,
        status: "failed",
        message: probe.detail ? `${probe.message} — ${probe.detail}`.slice(0, 240) : probe.message,
      } satisfies PackSourceOutcome;
    }

    try {
      await deps.create(candidate);
      return {
        name: candidate.name,
        url: candidate.url,
        status: "added",
        message: `${probe.itemCount} آیتم در فید`,
      } satisfies PackSourceOutcome;
    } catch (error) {
      return {
        name: candidate.name,
        url: candidate.url,
        status: "failed",
        message: errorMessage(error),
      } satisfies PackSourceOutcome;
    }
  });

  return {
    results,
    added: results.filter((item) => item.status === "added").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: results.filter((item) => item.status === "failed").length,
  };
}
