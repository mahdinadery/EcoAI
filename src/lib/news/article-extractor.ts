/**
 * Server-side article full-text fetcher — SERVER-SIDE ONLY.
 *
 * Fetches the HTML page of an article URL when the RSS feed only provided a
 * brief teaser, extracts clean prose paragraphs via `extractArticleTextFromHtml`,
 * and returns `null` safely on paywalls, bot blocks, or network timeouts so
 * AI analysis always degrades gracefully to the RSS summary.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { getFeedProxyUrl } from "./feed-client";
import {
  composeArticleTextForAi,
  extractArticleTextFromHtml,
  shouldFetchFullArticleText,
} from "./article-extractor-core";

export { composeArticleTextForAi, extractArticleTextFromHtml, shouldFetchFullArticleText };

const ARTICLE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEFAULT_ARTICLE_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 2_500_000;

/**
 * Fetches and extracts readable article text from an HTTP(S) URL.
 * Never throws; returns null on any error, non-HTML response, or thin body.
 */
export async function fetchArticleBody(
  rawUrl: string,
  timeoutMs = DEFAULT_ARTICLE_TIMEOUT_MS,
): Promise<string | null> {
  if (process.env.NEWS_EXTRACT_FULL_TEXT === "false") return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return null;
  } catch {
    return null;
  }

  const proxyUrl = getFeedProxyUrl();
  let dispatcher: ProxyAgent | undefined;
  if (proxyUrl) {
    try {
      dispatcher = new ProxyAgent(proxyUrl);
    } catch {
      dispatcher = undefined;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(parsedUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": ARTICLE_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9,fa;q=0.6",
      },
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!response.ok) return null;

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("html") && !contentType.includes("xml") && !contentType.includes("text/plain")) {
      return null;
    }

    const html = await response.text();
    if (!html || html.length > MAX_HTML_BYTES) return null;

    return extractArticleTextFromHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (dispatcher) {
      try {
        dispatcher.close();
      } catch {
        // best effort
      }
    }
  }
}
