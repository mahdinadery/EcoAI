/**
 * RSS ingestion service — SERVER-SIDE ONLY.
 *
 * Reads the feed URL from `NEWS_SOURCE_RSS_URL`, fetches it with a hard timeout,
 * parses RSS 2.0 (with Atom-ish tolerance) and normalizes items for the `news`
 * table. Dependency-free on purpose: a hand-written, defensive parser that skips
 * individual malformed items instead of failing the whole batch.
 */

import { fetchFeedText } from "./feed-client";

export type NormalizedNews = {
  title: string;
  url: string;
  source: string;
  publishedAt: Date | null;
  description: string | null;
  imageUrl: string | null;
  /** Stable upstream id (RSS `guid` / Atom `id`) when it differs from the link. */
  externalId: string | null;
  /** dc:creator / Atom author name when the feed provides one. */
  author: string | null;
  /** content:encoded full text when provided, otherwise null (description used). */
  content: string | null;
};

export type NewsFailureCode =
  | "missing_url"
  | "invalid_url"
  | "timeout"
  | "network_error"
  | "http_error"
  | "invalid_feed"
  | "no_items"
  | "unknown_error";

export type NewsFetchResult =
  | { ok: true; source: string; items: NormalizedNews[]; skipped: number }
  | { ok: false; code: NewsFailureCode; message: string; detail?: string };

// All outbound network behavior (UA, retry, https->http fallback, optional
// proxy via NEWS_FETCH_PROXY_URL, geo-block hints) lives in feed-client.ts.
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_URL_LENGTH = 2_048;

export const NEWS_RSS_ENV = "NEWS_SOURCE_RSS_URL";

function clean(value: string | undefined): string {
  if (!value) return "";
  let output = value;

  // CDATA wrappers are common in BBC/Reuters style feeds for title + description.
  output = output.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Feed descriptions contain inline HTML (<a>, <img>, entities).
  output = output.replace(/<[^>]*>/g, " ");
  output = decodeEntities(output);
  output = decodeEntities(output); // feeds sometimes double-encode (`&amp;#8238;`)
  return output.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201C",
  rdquo: "\u201D",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? safeFromCodePoint(code) : match;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? safeFromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function field(block: string, name: string): string | undefined {
  const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, "i");
  return pattern.exec(block)?.[1];
}

function attribute(block: string, tag: string, attr: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*\\b${attr}\\s*=\\s*"([^"]*)"`, "i");
  const value = pattern.exec(block)?.[1];
  return value ? value.replace(/&amp;/g, "&") : undefined;
}

function isHttpUrl(value: string): boolean {
  if (!value || value.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parsePublishedAt(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parses a feed body into normalized items.
 * Malformed items (missing title or a non-HTTP link) are skipped and counted.
 */
export function parseFeed(xml: string, fallbackSource: string): {
  source: string;
  items: NormalizedNews[];
  skipped: number;
} {
  const channelBlock = /<channel[\s>][\s\S]*?<\/channel>/i.exec(xml)?.[0] ?? xml;
  const channelTitle = clean(field(channelBlock, "title")).slice(0, 120);
  const source = channelTitle || fallbackSource || "unknown";

  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];

  const items: NormalizedNews[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const block of blocks) {
    const title = clean(field(block, "title")).slice(0, MAX_TITLE_LENGTH);
    const link =
      clean(field(block, "link")) ||
      attribute(block, "link", "href") ||
      clean(field(block, "guid")) ||
      "";

    // One malformed article must never abort ingestion.
    if (!title || !isHttpUrl(link) || seen.has(link)) {
      skipped += 1;
      continue;
    }

    seen.add(link);

    const description = clean(field(block, "description"))
      .slice(0, MAX_DESCRIPTION_LENGTH)
        .trim();

    const imageUrl =
      attribute(block, "media:thumbnail", "url") ??
      attribute(block, "media:content", "url") ??
      attribute(block, "enclosure", "url") ??
      null;

    // guid/id are only useful as an external id when they are NOT just the link
    // again (many feeds set guid to the URL).
    const guidRaw = clean(field(block, "guid")) || clean(field(block, "id"));
    const externalId = guidRaw && guidRaw !== link ? guidRaw.slice(0, 300) : null;

    const authorRaw =
      clean(field(block, "dc:creator")) ||
      clean(/<author[^>]*>([\s\S]*?)<\/author>/i.exec(block)?.[1]) ||
      "";

    const fullContent = clean(field(block, "content:encoded")).slice(0, 20_000);

    items.push({
      title,
      url: link,
      source,
      publishedAt: parsePublishedAt(field(block, "pubDate") ?? field(block, "updated")),
      description: description || null,
      imageUrl: imageUrl && isHttpUrl(imageUrl) ? imageUrl : null,
      externalId,
      author: authorRaw ? authorRaw.slice(0, 200) : null,
      content: fullContent || null,
    });
  }

  return { source, items, skipped };
}

/** Reads and validates the configured feed URL without ever logging credentials. */
export function getNewsFeedUrl(): { ok: true; url: URL } | { ok: false; code: NewsFailureCode; message: string } {
  const raw = process.env[NEWS_RSS_ENV]?.trim();

  if (!raw) {
    return {
      ok: false,
      code: "missing_url",
      message: `${NEWS_RSS_ENV} is not configured.`,
    };
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return { ok: true, url };
  } catch {
    return {
      ok: false,
      code: "invalid_url",
      message: `${NEWS_RSS_ENV} is not a valid http(s) URL.`,
    };
  }
}

/** Env-based feed URL for the legacy dashboard fetch (kept for backward compatibility). */
export async function fetchNews(): Promise<NewsFetchResult> {
  const configured = getNewsFeedUrl();
  if (!configured.ok) {
    return { ok: false, code: configured.code, message: configured.message };
  }
  return fetchFeed(configured.url.toString());
}

/**
 * Fetches + parses an explicit feed URL. Never throws; one shared
 * implementation for the legacy env source and every registered source.
 */
export async function fetchFeed(feedUrl: string): Promise<NewsFetchResult> {
  let url: URL;
  try {
    url = new URL(feedUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, code: "invalid_url", message: "Feed URL must be http(s)." };
    }
  } catch {
    return { ok: false, code: "invalid_url", message: "Feed URL is not a valid http(s) URL." };
  }

  let currentUrl = url.toString();

  // First pass uses the given URL; if it turns out to be an HTML page that
  // advertises a feed, a second pass follows the discovered feed link.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await fetchFeedOnce(currentUrl);

    if (result.ok) {
      return result;
    }

    if (result.code === "html_page" && attempt === 0 && result.detail) {
      currentUrl = result.detail; // discovered feed URL
      continue;
    }

    if (result.code === "html_page") {
      return {
        ok: false,
        code: "invalid_feed",
        message:
          "This URL returns an HTML page, not an RSS feed, and no feed link was advertised by the page. Enter the feed file URL directly (usually ending with /feed, /rss or .xml).",
      };
    }

    return result;
  }

  return { ok: false, code: "unknown_error", message: "Feed fetch failed." };
}

/**
 * One HTTP round-trip through the hardened feed client: browser UA (some CDNs
 * 403 headerless fetches), one retry, https->http downgrade when TLS/connect
 * stalls, optional NEWS_FETCH_PROXY_URL, and geo-block detection for Iranian
 * hosts appended to the error message as a Persian hint.
 */
async function fetchFeedOnce(feedUrl: string): Promise<NewsFetchResult | { ok: false; code: "html_page"; message: string; detail: string | null }> {
  const fetched = await fetchFeedText(feedUrl, REQUEST_TIMEOUT_MS);

  if (!fetched.ok) {
    const code: NewsFailureCode =
      fetched.kind === "http" ? "http_error" : fetched.kind === "timeout" ? "timeout" : "network_error";
    const suffix = (fetched as { hint?: string | null }).hint ? ` — ${(fetched as { hint?: string }).hint}` : "";
    return {
      ok: false,
      code,
      message: `${fetched.message}${fetched.status ? ` [HTTP ${fetched.status}]` : ""}${suffix}`,
    };
  }

  const body = fetched.body;

  if (!body.trim()) {
    return {
      ok: false,
      code: "invalid_feed",
      message:
        "The feed server returned an EMPTY response (HTTP 202/204 is usually rate-limiting or bot-throttling of this server's IP). Try again after a few minutes, or use a CDN-friendlier feed URL.",
    };
  }

  // RSS 2.0 (<rss>), Atom (<feed>) and RSS 1.0/RDF (<rdf:RDF>) are all accepted.
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 4000))) {
    const discovered = discoverFeedLink(body, feedUrl);
    if (discovered) {
      return { ok: false, code: "html_page", message: "HTML page with a discoverable feed link.", detail: discovered };
    }
    return { ok: false, code: "invalid_feed", message: "Response is not an RSS/Atom feed." };
  }

  const parsed = parseFeed(body, new URL(feedUrl).hostname);

  if (parsed.items.length === 0) {
    return {
      ok: false,
      code: "no_items",
      message: "No usable articles found in the feed.",
      detail: parsed.skipped ? `${parsed.skipped} item(s) skipped as malformed` : undefined,
    };
  }

  return { ok: true, source: parsed.source, items: parsed.items, skipped: parsed.skipped };
}

/**
 * Auto-discovery: a page can advertise its feed with
 * <link rel="alternate" type="application/rss+xml|atom+xml" href="...">
 * so pasting a site/page URL still resolves to the real feed (one retry).
 */
function discoverFeedLink(html: string, baseUrl: string): string | null {
  const patterns = [
    /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/(?:rss|atom)\+xml["']/i,
  ];

  for (const pattern of patterns) {
    const href = pattern.exec(html)?.[1];
    if (!href) continue;
    try {
      const resolved = new URL(href.replace(/&amp;/g, "&"), baseUrl);
      if (resolved.protocol === "https:" || resolved.protocol === "http:") {
        return resolved.toString();
      }
    } catch {
      // ignore malformed link and try the next candidate
    }
  }

  return null;
}
