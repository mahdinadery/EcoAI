/**
 * Conservative URL canonicalization (Milestone 6).
 *
 * Used to build a dedupe identity that survives tracking parameters — without
 * ever merging genuinely different articles. Rules (intentionally minimal):
 *
 *   1. Only well-known tracking params are removed (utm_*, ad click ids, ...).
 *      Everything else — including params that ARE the article identity on
 *      some sites — is preserved.
 *   2. Remaining query params are sorted for stable comparison.
 *   3. Fragment removed; default ports removed; trailing slash normalized.
 *   4. Host is lowercased (URL semantics) but NOT stripped of `www` — too
 *     many sites treat those as distinct hosts.
 *   5. Anything unparseable is returned trimmed, unchanged.
 */

const TRACKING_PARAMS =
  /^(utm_[a-z0-9_-]+|gclid|gbraid|wbraid|fbclid|msclkid|twclid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|hsa_acc|hsa_cam|hsa_grp|hsa_ad|ref_src|cmpid|pk_(campaign|medium|source|term|content))$/i;

export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;

    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
      url.port = "";
    }

    const kept: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
      if (!TRACKING_PARAMS.test(key)) kept.push([key, value]);
    });
    kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    url.search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";

    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/{2,}$/, "/").replace(/\/$/, "");
      if (url.pathname === "") url.pathname = "/";
    }

    return url.toString();
  } catch {
    return trimmed;
  }
}
