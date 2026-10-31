/**
 * Outbound feed HTTP client (Milestone 6+) — SERVER-SIDE ONLY.
 *
 * Built for the product's primary audience — Iranian/Persian news sites. Many
 * of them (and Arvan-hosted outlets specifically) silently DROP packets from
 * non-Iran server IPs: TCP completes, then the request/response stalls until
 * timeout. No amount of header tuning fixes that inside a foreign network, so
 * this client adds the three things that actually help:
 *
 *   1. Optional outbound proxy — `NEWS_FETCH_PROXY_URL` (e.g. an Iran-side
 *      proxy) routes every feed request through it via undici ProxyAgent.
 *   2. Resilience — one fast retry on network failures, plus an https→http
 *      downgrade attempt for hosts that serve feeds over plain HTTP.
 *   3. Honest, actionable diagnostics — the failure is classified (dns /
 *      connect / tls / timeout / proxy-config / http) and, when the host looks
 *      Iranian, a Persian hint naming the three concrete ways to fix it is
 *      attached to the message shown in the admin UI.
 *
 * Never logs or returns secrets: the proxy URL (which may contain credentials)
 * is redacted from any error detail.
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

const FEED_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 12_000;
const FAST_RETRY_TIMEOUT_MS = 6_000;
const RETRY_DELAY_MS = 800;
/** Upper bound for a single feed document (5 MB) — see attemptFetch. */
const MAX_FEED_BODY_BYTES = 5_000_000;

export type FeedFetchFailureKind = "dns" | "connect" | "tls" | "timeout" | "http" | "proxy_config" | "unknown";

export type FeedFetchResult =
  | { ok: true; status: number; body: string; usedHttpFallback: boolean; viaProxy: boolean }
  | { ok: false; kind: FeedFetchFailureKind; status?: number; message: string; hint?: string | null };

/** Hostnames (beyond *.ir) that are typically Iran-only or Iran-first CDNs. */
const IRAN_MEDIA_SUFFIXES = [
  "isna.ir",
  "mehrnews.com",
  "entekhab.ir",
  "donya-e-eqtesad.com",
  "farsnews.com",
  "farsnews.ir",
  "tasnimnews.com",
  "shargh.ir",
  "hamshahri.ir",
  "janasan.ir",
  "tejaratnews.com",
  "eghtesadonline.com",
  "khabaronline.ir",
  "alef.ir",
  "irna.ir",
  "iribnews.ir",
  "kaleme.co",
  "rooyesh.io",
];

function looksIranianHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.endsWith(".ir")) return true;
  return IRAN_MEDIA_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function getFeedProxyUrl(): string | null {
  const raw = process.env.NEWS_FETCH_PROXY_URL?.trim();
  return raw ? raw : null;
}

/** Redact credentials embedded in a proxy URL before anything is surfaced. */
function redactProxyCredentials(value: string, proxyUrl: string | null): string {
  if (!proxyUrl) return value;
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.password) {
      return value.split(parsed.password).join("[redacted]");
    }
  } catch {
    // unparseable proxy URL: nothing more to redact
  }
  return value;
}

function classifyFetchError(error: unknown, proxyUrl: string | null): FeedFetchResult {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const raw = `${cause?.code ?? ""} ${cause?.message ?? ""} ${(error as Error)?.message ?? ""}`.toLowerCase();
  const safe = redactProxyCredentials(raw, proxyUrl).slice(0, 240);

  let kind: FeedFetchFailureKind = "unknown";
  if (raw.includes("enotfound") || raw.includes("eai_again") || raw.includes("getaddrinfo")) kind = "dns";
  else if (raw.includes("ssl") || raw.includes("tls") || raw.includes("certificate") || raw.includes("handshake")) kind = "tls";
  else if (raw.includes("timeout") || raw.includes("abort")) kind = "timeout";
  else if (raw.includes("connect") || raw.includes("econn") || raw.includes("epipe") || raw.includes("reset")) kind = "connect";

  return { ok: false, kind, message: `Network fetch failed (${kind}): ${safe}`, hint: null };
}

async function attemptFetch(targetUrl: string, timeoutMs: number, dispatcher: ProxyAgent | undefined, proxyUrl: string | null): Promise<FeedFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(targetUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": FEED_USER_AGENT,
        "Accept-Language": "fa,en;q=0.8",
      },
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });

    const body = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        kind: "http",
        status: response.status,
        message:
          response.status === 403
            ? "News source blocked the request (HTTP 403)."
            : `News source returned HTTP ${response.status}.`,
        hint: null,
      };
    }

    // Memory guard: some feeds (or hostile/misconfigured hosts) return huge
    // payloads. RSS/Atom feeds never need megabytes of XML — refuse early
    // instead of pushing an unbounded string through the parser.
    if (body.length > MAX_FEED_BODY_BYTES) {
      return {
        ok: false,
        kind: "http",
        status: response.status,
        message: `News feed is too large (${Math.round(body.length / 1_000_000)}MB > ${Math.round(MAX_FEED_BODY_BYTES / 1_000_000)}MB limit).`,
        hint: null,
      };
    }

    return { ok: true, status: response.status, body, usedHttpFallback: false, viaProxy: Boolean(dispatcher) };
  } catch (error) {
    return classifyFetchError(error, proxyUrl);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch a feed URL with proxy support, one retry and https→http fallback.
 * Never throws; failures carry a classified, human-readable message.
 */
export async function fetchFeedText(rawUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FeedFetchResult> {
  const proxyUrl = getFeedProxyUrl();

  let dispatcher: ProxyAgent | undefined;
  if (proxyUrl) {
    try {
      dispatcher = new ProxyAgent(proxyUrl);
    } catch {
      return {
        ok: false,
        kind: "proxy_config",
        message: "NEWS_FETCH_PROXY_URL مقدار معتبر یک URL پروکسی نیست (مثلاً http://127.0.0.1:8080).",
        hint: null,
      };
    }
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    if (dispatcher) dispatcher.close();
    return { ok: false, kind: "unknown", message: "Feed URL is not parseable.", hint: null };
  }

  const host = url.hostname;
  let usedHttpFallback = false;

  // Attempt sequence (time-boxed so one geo-blocked host cannot stall a
  // whole fetch sweep): primary -> short retry (network errors only) ->
  // http downgrade for https hosts. Each stage has a bounded timeout.
  const runPlan = async (): Promise<FeedFetchResult> => {
    let last = await attemptFetch(url.toString(), timeoutMs, dispatcher, proxyUrl);

    if (!last.ok && last.kind !== "http" && last.kind !== "proxy_config" && last.kind !== "dns") {
      await sleep(RETRY_DELAY_MS);
      const quick = await attemptFetch(url.toString(), Math.min(timeoutMs, FAST_RETRY_TIMEOUT_MS), dispatcher, proxyUrl);
      if (quick.ok) return { ...quick, usedHttpFallback };
      last = quick;
    }

    if (!last.ok && url.protocol === "https:" && (last.kind === "tls" || last.kind === "connect" || last.kind === "timeout")) {
      url.protocol = "http:";
      usedHttpFallback = true;
      const downgraded = await attemptFetch(url.toString(), FAST_RETRY_TIMEOUT_MS, dispatcher, proxyUrl);
      if (downgraded.ok) last = downgraded;
    }

    return last;
  };

  const result = await runPlan();
  if (dispatcher) {
    try {
      dispatcher.close();
    } catch {
      // best effort
    }
  }

  if (result.ok) {
    return { ...result, usedHttpFallback, body: result.body };
  }

  // Attach the actionable Persian hint when the host looks Iran-hosted — the
  // "connection opens but never answers" pattern is signature geo-blocking.
  if (result.kind !== "http" && (looksIranianHost(url.hostname) || looksIranianHost(host))) {
    result.hint =
      "میزبان احتمالاً درخواست از IP خارج از ایران را پاسخ نمی‌دهد (اتصال TCP باز می‌شود اما پاسخی نمی‌آید). راه‌حل‌ها: ۱) اجرای اپ روی سرور داخل ایران ۲) تنظیم NEWS_FETCH_PROXY_URL با پروکسی قابل‌دسترس ۳) «ورود دستی RSS» در پنل منابع.";
  }

  return result;
}
