/**
 * Ready-made news packs (pure data + pure helpers — safe on client and server).
 *
 * A pack bundles the two things an operator needs to start monitoring a domain:
 *
 *   1. topics — keyword groups understood by the pre-AI topic filter
 *      (src/lib/news/topic-filter.ts) and injected into the AI prompt;
 *   2. sources — curated RSS/Atom feeds that the apply action probes before adding.
 *
 * Packs are deliberately additive and idempotent: applying the same pack twice
 * never duplicates a topic or a source. Nothing here touches the database.
 */

export type NewsPackTopic = {
  /** Stable id inside the pack (prefixed on merge to avoid collisions). */
  id: string;
  label: string;
  enabled: boolean;
  keywords: string[];
};

export type NewsPackSource = {
  name: string;
  url: string;
  type: "rss";
  category: string;
  description: string;
  priority: number;
  fetchIntervalMinutes: number;
  maxItemsPerFetch: number;
};

export type NewsPack = {
  id: string;
  title: string;
  description: string;
  /** Appended to the active system prompt once (see appendAudienceNote). */
  audienceNote?: string;
  /** Substring used to detect that audienceNote is already applied. */
  audienceMarker?: string;
  /** Merged additively into the config deny-list when topics are applied. */
  blockedKeywords?: string[];
  topics: NewsPackTopic[];
  sources: NewsPackSource[];
};

/**
 * Primary pack: English Analytical Economic Articles & Global Research.
 *
 * Focused on deep analytical columns, policy papers, central bank research notes,
 * and institutional commentary (Project Syndicate, VoxEU/CEPR, IMF Blog,
 * Brookings, PIIE, The Economist, Federal Reserve, NY Fed, Bruegel, World Bank).
 */
export const ENGLISH_ECONOMICS_PACK: NewsPack = {
  id: "english-economics",
  title: "مقالات و تحلیل‌های اقتصادی انگلیسی (جهانی)",
  description:
    "هشت محور تخصصی اقتصاد کلان، سیاست پولی، تجارت جهانی، بازارهای مالی، اقتصاد توسعه و فناوری به‌همراه ده منبع معتبر مقالات تحلیلی و پژوهشی انگلیسی. هر منبع پیش از افزودن تست می‌شود و موضوعات به‌صورت «تمرکز» روی پیکربندی فعال اعمال می‌شوند.",
  audienceNote:
    "مخاطب هدف این سامانه اقتصاددانان، پژوهشگران اقتصادی، سیاست‌گذاران و تحلیلگران بازارهای مالی هستند؛ مقالات و یادداشت‌های تحلیلی انگلیسی را با دقت علمی مطالعه کن، عنوان را به فارسی دقیق ترجمه کن، خلاصهٔ تحلیلی جامع و روان فارسی بنویس و اهمیت، مرتبط بودن و توصیه ارسال هر مقاله را بر پایهٔ عمق استدلال اقتصادی، شواهد تجربی و اثر سیاستی یا بازاری بسنج.",
  audienceMarker: "مخاطب هدف این سامانه اقتصاددانان، پژوهشگران اقتصادی، سیاست‌گذاران",
  blockedKeywords: [
    "nfl",
    "nba",
    "mlb",
    "nhl",
    "premier league",
    "champions league",
    "celebrity gossip",
    "hollywood",
    "horoscope",
    "movie review",
    "fashion week",
    "ورزش",
    "فوتبال",
    "سرگرمی",
    "سینما",
    "حوادث",
    "تصادف",
  ],
  topics: [
    {
      id: "monetary-policy",
      label: "سیاست پولی، تورم و بانک‌های مرکزی",
      enabled: true,
      keywords: [
        "monetary policy",
        "central bank",
        "federal reserve",
        "fed",
        "ecb",
        "bank of england",
        "bank of japan",
        "interest rate",
        "inflation",
        "disinflation",
        "deflation",
        "quantitative easing",
        "quantitative tightening",
        "yield curve",
        "price stability",
      ],
    },
    {
      id: "macro-fiscal",
      label: "اقتصاد کلان، رشد و سیاست مالی",
      enabled: true,
      keywords: [
        "macroeconomics",
        "macroeconomic",
        "economic growth",
        "gdp",
        "recession",
        "stagflation",
        "fiscal policy",
        "public debt",
        "sovereign debt",
        "budget deficit",
        "debt sustainability",
        "business cycle",
        "aggregate demand",
      ],
    },
    {
      id: "trade-geoeconomics",
      label: "تجارت جهانی، تعرفه‌ها و ژئواکونومیک",
      enabled: true,
      keywords: [
        "international trade",
        "global trade",
        "tariff",
        "tariffs",
        "protectionism",
        "supply chain",
        "geoeconomics",
        "sanctions",
        "industrial policy",
        "wto",
        "globalization",
        "deglobalization",
        "export controls",
        "current account",
      ],
    },
    {
      id: "finance-markets",
      label: "بازارهای مالی، بانکداری و ثبات مالی",
      enabled: true,
      keywords: [
        "financial stability",
        "financial markets",
        "capital markets",
        "bond market",
        "treasury yields",
        "banking crisis",
        "banking sector",
        "systemic risk",
        "credit crunch",
        "liquidity",
        "private credit",
        "prudential regulation",
      ],
    },
    {
      id: "development-institutions",
      label: "اقتصاد توسعه، بازارهای نوظهور و نهادهای بین‌المللی",
      enabled: true,
      keywords: [
        "emerging markets",
        "developing economies",
        "global south",
        "imf",
        "world bank",
        "oecd",
        "capital flows",
        "exchange rate",
        "currency crisis",
        "balance of payments",
        "foreign direct investment",
        "economic development",
      ],
    },
    {
      id: "energy-climate",
      label: "انرژی، کالاهای اساسی و اقتصاد گذار اقلیمی",
      enabled: true,
      keywords: [
        "energy transition",
        "oil market",
        "crude oil",
        "natural gas",
        "opec",
        "commodities",
        "commodity prices",
        "carbon tax",
        "carbon pricing",
        "green transition",
        "climate finance",
        "critical minerals",
      ],
    },
    {
      id: "tech-labor-productivity",
      label: "بهره‌وری، هوش مصنوعی و اقتصاد بازار کار",
      enabled: true,
      keywords: [
        "productivity",
        "labor market",
        "labour market",
        "employment",
        "unemployment",
        "wage growth",
        "artificial intelligence",
        "automation",
        "digital economy",
        "cbdc",
        "fintech",
        "human capital",
      ],
    },
    {
      id: "inequality-political-economy",
      label: "نابرابری، تغییرات جمعیتی و اقتصاد سیاسی",
      enabled: true,
      keywords: [
        "inequality",
        "income distribution",
        "demographics",
        "aging population",
        "political economy",
        "tax policy",
        "taxation",
        "housing market",
        "welfare state",
        "economic policy",
        "structural reform",
      ],
    },
  ],
  sources: [
    {
      name: "Project Syndicate — Economics",
      url: "https://www.project-syndicate.org/rss/section/economics",
      type: "rss",
      category: "مقالات تحلیلی اقتصاد",
      description:
        "یادداشت‌ها و مقالات تحلیلی اقتصاددانان برجسته جهان و برندگان نوبل اقتصاد در Project Syndicate.",
      priority: 1,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 40,
    },
    {
      name: "VoxEU / CEPR — Economic Policy Research",
      url: "https://cepr.org/rss/voxeu",
      type: "rss",
      category: "پژوهش اقتصادی",
      description:
        "پرتال تحلیلی مرکز پژوهش‌های سیاست اقتصادی اروپا (CEPR) — مقالات مبتنی بر پژوهش‌های روز اقتصاددانان.",
      priority: 1,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 40,
    },
    {
      name: "IMF Blog — صندوق بین‌المللی پول",
      url: "https://www.imf.org/en/Blogs/rss",
      type: "rss",
      category: "نهادهای بین‌المللی",
      description:
        "وبلاگ رسمی صندوق بین‌المللی پول (IMF) — تحلیل‌های اقتصاد کلان جهانی، ثبات مالی و سیاست‌گذاری.",
      priority: 1,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 35,
    },
    {
      name: "Brookings Institution — Economy",
      url: "https://www.brookings.edu/topic/economy/feed/",
      type: "rss",
      category: "اندیشکده اقتصادی",
      description:
        "مقالات و گزارش‌های تحلیلی اندیشکده بروکینگز درباره سیاست پولی، مالی، بازار کار و اقتصاد جهانی.",
      priority: 2,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 40,
    },
    {
      name: "Peterson Institute (PIIE)",
      url: "https://www.piie.com/rss.xml",
      type: "rss",
      category: "تجارت و اقتصاد بین‌الملل",
      description:
        "مؤسسه پترسون برای اقتصاد بین‌الملل — تحلیل‌های عمیق تجارت جهانی، تعرفه‌ها، ارز و اقتصاد کلان.",
      priority: 1,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 40,
    },
    {
      name: "The Economist — Finance & Economics",
      url: "https://www.economist.com/finance-and-economics/rss.xml",
      type: "rss",
      category: "تحلیل مالی و اقتصادی",
      description:
        "بخش مالی و اقتصاد نشریه اکونومیست — گزارش‌ها و تحلیل‌های روندهای کلیدی اقتصاد جهان.",
      priority: 2,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 40,
    },
    {
      name: "Federal Reserve — FEDS Notes",
      url: "https://www.federalreserve.gov/feeds/feds_notes.xml",
      type: "rss",
      category: "بانک مرکزی و سیاست پولی",
      description:
        "یادداشت‌های تحلیلی و پژوهشی اقتصاددانان فدرال رزرو آمریکا درباره سیاست پولی، تورم و ثبات مالی.",
      priority: 2,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 30,
    },
    {
      name: "Liberty Street Economics — NY Fed",
      url: "https://libertystreeteconomics.newyorkfed.org/feed/",
      type: "rss",
      category: "پژوهش بانک مرکزی",
      description:
        "وبلاگ پژوهشی فدرال رزرو نیویورک — مقالات تحلیلی بازارهای مالی، تورم، اعتبارات و تجارت.",
      priority: 2,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 30,
    },
    {
      name: "Bruegel — European Economic Think Tank",
      url: "https://www.bruegel.org/rss.xml",
      type: "rss",
      category: "اندیشکده اقتصادی",
      description:
        "اندیشکده اقتصادی بروگل (بروکسل) — مقالات سیاست‌گذاری اقتصادی، انرژی، رقابت و ژئواکونومیک.",
      priority: 2,
      fetchIntervalMinutes: 90,
      maxItemsPerFetch: 35,
    },
    {
      name: "World Bank Blogs — بانک جهانی",
      url: "https://blogs.worldbank.org/en/rss.xml",
      type: "rss",
      category: "اقتصاد توسعه",
      description:
        "تحلیل‌ها و یافته‌های پژوهشی کارشناسان بانک جهانی درباره اقتصاد توسعه، تجارت و بازارهای نوظهور.",
      priority: 3,
      fetchIntervalMinutes: 90,
      maxItemsPerFetch: 40,
    },
  ],
};

export const DEFAULT_NEWS_PACK: NewsPack = ENGLISH_ECONOMICS_PACK;

export const NEWS_PACKS: NewsPack[] = [ENGLISH_ECONOMICS_PACK];

export function getNewsPack(id: string): NewsPack | undefined {
  return NEWS_PACKS.find((pack) => pack.id === id);
}

/** Persian/Latin-friendly label comparison (case, ZWNJ, Arabic letters, whitespace). */
export function normalizeTopicLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[أإآ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compares source URLs ignoring case, a trailing slash and the hash. */
export function normalizeSourceUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export type TopicMergeResult = {
  topics: NewsPackTopic[];
  /** Labels that were actually appended. */
  added: string[];
  /** Labels already present (same normalized label). */
  skipped: string[];
  /** Pack topics dropped because the 30-topic configuration limit was reached. */
  truncated: number;
};

/**
 * Adds the pack's topics to an existing list without mutating the input.
 * Existing labels win; the 30-topic limit enforced by the AI config validator
 * is respected here so the result is always saveable.
 */
export function mergePackTopics(
  existing: readonly NewsPackTopic[],
  pack: NewsPack,
  options: { maxTopics?: number } = {},
): TopicMergeResult {
  const maxTopics = options.maxTopics ?? 30;
  const topics = existing.map((topic) => ({ ...topic, keywords: [...topic.keywords] }));
  const seenLabels = new Set(topics.map((topic) => normalizeTopicLabel(topic.label)));
  const usedIds = new Set(topics.map((topic) => topic.id));

  const added: string[] = [];
  const skipped: string[] = [];
  let truncated = 0;

  for (const topic of pack.topics) {
    const labelKey = normalizeTopicLabel(topic.label);
    if (seenLabels.has(labelKey)) {
      skipped.push(topic.label);
      continue;
    }
    if (topics.length >= maxTopics) {
      truncated += 1;
      continue;
    }

    const baseId = `pack-${pack.id}-${topic.id}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }

    topics.push({ id, label: topic.label, enabled: true, keywords: [...topic.keywords] });
    usedIds.add(id);
    seenLabels.add(labelKey);
    added.push(topic.label);
  }

  return { topics, added, skipped, truncated };
}

/**
 * Appends the pack's audience note to the system prompt exactly once.
 * Returns `alreadyPresent: true` when the marker already exists.
 */
export function appendAudienceNote(
  systemPrompt: string,
  pack: NewsPack,
): { prompt: string; alreadyPresent: boolean } {
  if (!pack.audienceNote) return { prompt: systemPrompt, alreadyPresent: true };
  if (pack.audienceMarker && systemPrompt.includes(pack.audienceMarker)) {
    return { prompt: systemPrompt, alreadyPresent: true };
  }
  return {
    prompt: `${systemPrompt.trimEnd()}\n\n${pack.audienceNote}`.trim(),
    alreadyPresent: false,
  };
}

export type BlockedKeywordsMergeResult = {
  blockedKeywords: string[];
  /** Keywords that were actually appended. */
  added: string[];
  /** Keywords already present (same normalized form). */
  skipped: string[];
};

/**
 * Adds the pack's deny-list keywords to the configuration's `blockedKeywords`
 * without mutating the input. Comparison ignores case, ZWNJ and letter variants.
 */
export function mergeBlockedKeywords(
  existing: readonly string[],
  pack: NewsPack,
): BlockedKeywordsMergeResult {
  const blockedKeywords = existing.map((keyword) => keyword.trim()).filter(Boolean);
  const seen = new Set(blockedKeywords.map(normalizeTopicLabel));
  const added: string[] = [];
  const skipped: string[] = [];

  for (const raw of pack.blockedKeywords ?? []) {
    const keyword = raw.trim();
    if (!keyword) continue;
    const key = normalizeTopicLabel(keyword);
    if (seen.has(key)) {
      skipped.push(keyword);
      continue;
    }
    seen.add(key);
    blockedKeywords.push(keyword);
    added.push(keyword);
  }

  return { blockedKeywords, added, skipped };
}
