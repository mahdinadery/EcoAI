/**
 * Curated domain news packs — pure data + pure merge helpers (no DB, no network).
 *
 * A pack bundles the three things an operator otherwise has to stitch together
 * by hand across two admin pages:
 *   1. Focused topic definitions (labels + English/Persian keywords) for the pre-AI topic gate
 *   2. Curated RSS/Atom feeds with sensible priorities and fetch intervals
 *   3. An optional audience note that can be appended to the AI system prompt
 *
 * Applying a pack is strictly ADDITIVE and idempotent: existing topics and
 * sources are never overwritten or deleted, and re-applying the same pack is a
 * no-op on items that already exist.
 */

import type { AiTopicFilterConfig, AiTopicRule } from "../ai/config-types";

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

export type PackSourceSeed = NewsPackSource;

export type NewsPack = {
  id: string;
  title: string;
  description: string;
  /** Short marker used to avoid appending `audienceNote` twice. */
  audienceMarker?: string;
  /** Optional Persian guidance appended once to the active system prompt. */
  audienceNote?: string;
  topics: AiTopicRule[];
  /** Off-topic keywords merged into the always-on deny-list when topics apply. */
  blockedKeywords?: string[];
  sources: NewsPackSource[];
};

const TOPIC_LIMIT = 30;

/**
 * Primary pack: **The Economics of AI (`اقتصاد هوش مصنوعی`)** — authoritative
 * English research & analytical feeds at the intersection of Artificial
 * Intelligence and Economics, curated for Persian translation & Bale publishing.
 */
export const AI_ECONOMICS_PACK: NewsPack = {
  id: "ai-economics",
  title: "بسته تخصصی اقتصاد هوش مصنوعی (The Economics of AI)",
  description:
    "موضوعات کلیدی و منابع تراز اول انگلیسی در حوزهٔ اقتصاد هوش مصنوعی (بهره‌وری و رشد اقتصادی، بازار کار و اتوماسیون، اقتصاد محاسبات/تراشه/انرژی، سرمایه‌گذاری و مدل‌های کسب‌وکار AI، رقابت و انحصار، و سیاست‌گذاری و ژئواکونومیک هوش مصنوعی) از NBER، Brookings، MIT Tech Review، Project Syndicate، VoxEU، IMF، OpenAI و غیره برای ترجمه و انتشار در کانال بله.",
  audienceMarker: "حوزهٔ تخصصی این کانال در پیام‌رسان بله، «اقتصاد هوش مصنوعی»",
  audienceNote:
    "حوزهٔ تخصصی این کانال در پیام‌رسان بله، «اقتصاد هوش مصنوعی» (The Economics of AI) است و مخاطب هدف آن اقتصاددانان، پژوهشگران اقتصاد فناوری، سرمایه‌گذاران و سیاست‌گذاران هستند: مقالاتی در اولویت بالایند که پیوند میان هوش مصنوعی و اقتصاد را کاوش می‌کنند (بهره‌وری کل عوامل و رشد اقتصادی، اتوماسیون و بازار کار، زنجیرهٔ تأمین تراشه/GPU، هزینهٔ محاسبات و انرژی دیتاسنترها، مخارج سرمایه‌ای هایپراسکیلرها و بازده سرمایه، ساختار بازار و ضدانحصار، اقتصاد داده و کپی‌رایت، و مقررات‌گذاری و ژئواکونومیک AI). مطالب کاملاً غیراقتصادی (آموزش برنامه‌نویسی محض، ترفندهای روزمرهٔ کاربری بدون بعد اقتصادی) و نیز اخبار عمومی غیرمرتبط با هوش مصنوعی/فناوری دیجیتال باید امتیاز مرتبط بودن پایین بگیرند.",
  blockedKeywords: [
    "nfl",
    "nba",
    "mlb",
    "nhl",
    "premier league",
    "champions league",
    "world cup",
    "touchdown",
    "celebrity gossip",
    "red carpet",
    "kardashian",
    "horoscope",
    "astrology",
    "movie review",
    "box office",
    "recipe",
    "video game walkthrough",
    "ورزش",
    "فوتبال",
    "لیگ برتر",
    "جام جهانی",
    "سرگرمی",
    "سلبریتی",
    "سینما",
    "طالع‌بینی",
    "حوادث",
    "تصادف",
    "قتل",
  ],
  topics: [
    {
      id: "pack-aiecon-productivity-growth",
      label: "بهره‌وری، رشد اقتصادی و کلان اقتصاد هوش مصنوعی",
      enabled: true,
      keywords: [
        "ai",
        "artificial intelligence",
        "generative ai",
        "genai",
        "economics of ai",
        "ai productivity",
        "macroeconomics of ai",
        "ai adoption",
        "ai-driven growth",
        "machine learning",
        "neural network",
        "large language model",
        "llm",
        "chatgpt",
        "chatbot",
        "solow paradox",
        "هوش مصنوعی",
        "اقتصاد هوش مصنوعی",
        "بهره‌وری هوش مصنوعی",
      ],
    },
    {
      id: "pack-aiecon-labor-workforce",
      label: "بازار کار، مشاغل، دستمزد و سرمایه انسانی",
      enabled: true,
      keywords: [
        "ai and jobs",
        "ai labor",
        "ai workforce",
        "task automation",
        "job displacement",
        "automation and wages",
        "algorithmic management",
        "robot",
        "robotics",
        "copilot",
        "agentic ai",
        "ai agents",
        "اتوماسیون مشاغل",
        "بازار کار و هوش مصنوعی",
      ],
    },
    {
      id: "pack-aiecon-compute-chips-energy",
      label: "اقتصاد محاسبات، تراشه، دیتاسنتر و انرژی",
      enabled: true,
      keywords: [
        "semiconductor",
        "gpu",
        "tpu",
        "nvidia",
        "tsmc",
        "asml",
        "data center",
        "datacenter",
        "compute cost",
        "inference cost",
        "training cost",
        "hyperscaler",
        "ai capex",
        "ai infrastructure",
        "تراشه",
        "دیتاسنتر",
      ],
    },
    {
      id: "pack-aiecon-investment-business",
      label: "سرمایه‌گذاری، ارزش‌گذاری، مدل کسب‌وکار و ROI هوش مصنوعی",
      enabled: true,
      keywords: [
        "ai investment",
        "ai valuation",
        "ai bubble",
        "ai startup",
        "enterprise ai",
        "ai monetization",
        "ai pricing",
        "token economics",
        "ai roi",
        "open source ai",
        "open-weights",
        "foundation model",
        "openai",
        "anthropic",
        "claude",
        "deepmind",
        "gemini",
        "deepseek",
        "mistral",
        "grok",
        "سرمایه‌گذاری هوش مصنوعی",
        "مدل کسب‌وکار هوش مصنوعی",
      ],
    },
    {
      id: "pack-aiecon-competition-data",
      label: "ساختار بازار، رقابت، انحصار، داده و کپی‌رایت",
      enabled: true,
      keywords: [
        "ai antitrust",
        "ai monopoly",
        "ai competition",
        "data economics",
        "training data",
        "ai copyright",
        "synthetic data",
        "model weights",
        "ضدانحصار هوش مصنوعی",
        "اقتصاد داده",
      ],
    },
    {
      id: "pack-aiecon-geoeconomics-trade",
      label: "ژئواکونومیک هوش مصنوعی، کنترل صادرات و سیاست صنعتی",
      enabled: true,
      keywords: [
        "chip export",
        "ai export controls",
        "chips act",
        "sovereign ai",
        "ai race",
        "ai supply chain",
        "chip war",
        "ژئواکونومیک هوش مصنوعی",
        "حاکمیت هوش مصنوعی",
      ],
    },
    {
      id: "pack-aiecon-regulation-policy",
      label: "مقررات‌گذاری، مالیات ربات و سیاست‌گذاری عمومی AI",
      enabled: true,
      keywords: [
        "ai regulation",
        "ai act",
        "ai governance",
        "ai policy",
        "robot tax",
        "ai safety",
        "public sector ai",
        "algorithmic bias",
        "مقررات هوش مصنوعی",
        "سیاست‌گذاری هوش مصنوعی",
      ],
    },
    {
      id: "pack-aiecon-finance-sectors",
      label: "کاربرد اقتصادی AI در مالی، بانکداری، سلامت و صنایع",
      enabled: true,
      keywords: [
        "ai in finance",
        "central bank ai",
        "ai in banking",
        "algorithmic trading",
        "ai drug discovery",
        "ai in healthcare",
        "industrial ai",
        "هوش مصنوعی در مالی",
        "هوش مصنوعی در بانکداری",
      ],
    },
  ],
  sources: [
    {
      name: "MIT Technology Review — Artificial Intelligence",
      url: "https://www.technologyreview.com/topic/artificial-intelligence/feed",
      type: "rss",
      category: "اقتصاد و فناوری هوش مصنوعی",
      description: "گزارش‌های عمیق دربارهٔ هزینهٔ محاسبات، پذیرش سازمانی، سیاست‌گذاری و اقتصاد هوش مصنوعی",
      priority: 1,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 25,
    },
    {
      name: "Brookings — Artificial Intelligence",
      url: "https://www.brookings.edu/topic/artificial-intelligence/feed/",
      type: "rss",
      category: "پژوهش سیاست‌گذاری و اقتصاد AI",
      description: "پژوهش‌های اندیشکده بروکینگز دربارهٔ اثر هوش مصنوعی بر بازار کار، بهره‌وری، رقابت و مقررات",
      priority: 1,
      fetchIntervalMinutes: 90,
      maxItemsPerFetch: 25,
    },
    {
      name: "NBER — New Working Papers",
      url: "https://back.nber.org/rss/new.xml",
      type: "rss",
      category: "مقالات پژوهشی اقتصاد (NBER)",
      description: "جدیدترین مقالات کاری اقتصاددانان برجسته (از جمله پژوهش‌های اقتصاد هوش مصنوعی، اتوماسیون و رشد)",
      priority: 1,
      fetchIntervalMinutes: 180,
      maxItemsPerFetch: 20,
    },
    {
      name: "Project Syndicate — Economics",
      url: "https://www.project-syndicate.org/rss/section/economics",
      type: "rss",
      category: "دیدگاه اقتصاددانان برجسته",
      description: "یادداشت‌های دارون عجم‌اوغلو، اریک برینجولفسون، مایکل اسپنس و برندگان نوبل دربارهٔ اقتصاد AI",
      priority: 1,
      fetchIntervalMinutes: 90,
      maxItemsPerFetch: 25,
    },
    {
      name: "VoxEU / CEPR — Economic Research",
      url: "https://cepr.org/rss/voxeu",
      type: "rss",
      category: "پژوهش تجربی اقتصاد",
      description: "مقالات تحلیلی اقتصاددانان دربارهٔ بهره‌وری، هوش مصنوعی، بازار کار و نوآوری",
      priority: 1,
      fetchIntervalMinutes: 90,
      maxItemsPerFetch: 30,
    },
    {
      name: "IMF Blog — International Monetary Fund",
      url: "https://www.imf.org/en/Blogs/rss",
      type: "rss",
      category: "نهادهای بین‌المللی",
      description: "تحلیل‌های صندوق بین‌المللی پول دربارهٔ هوش مصنوعی، بهره‌وری جهانی، بازار کار و سیاست مالی",
      priority: 2,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 25,
    },
    {
      name: "Ars Technica — AI",
      url: "https://feeds.arstechnica.com/arstechnica/ai",
      type: "rss",
      category: "صنعت، زیرساخت و بازار AI",
      description: "گزارش‌های تحلیلی دربارهٔ آزمایشگاه‌های AI، اقتصاد GPU و دیتاسنتر، انرژی، کپی‌رایت و ضدانحصار",
      priority: 2,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 25,
    },
    {
      name: "The Verge — AI",
      url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
      type: "rss",
      category: "کسب‌وکار و رقابت در AI",
      description: "پوشش سرمایه‌گذاری غول‌های فناوری، مدل‌های درآمدی، قراردادها و رقابت در صنعت هوش مصنوعی",
      priority: 2,
      fetchIntervalMinutes: 60,
      maxItemsPerFetch: 25,
    },
    {
      name: "OpenAI News",
      url: "https://openai.com/news/rss.xml",
      type: "rss",
      category: "گزارش‌های آزمایشگاه‌های پیشرو AI",
      description: "گزارش‌های اقتصادی، پذیرش سازمانی، قیمت‌گذاری API و معرفی مدل‌های جدید OpenAI",
      priority: 2,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 20,
    },
    {
      name: "Google Blog — AI",
      url: "https://blog.google/technology/ai/rss/",
      type: "rss",
      category: "زیرساخت و اکوسیستم AI",
      description: "گزارش‌های گوگل و دیپ‌مایند دربارهٔ زیرساخت ابری، TPU، مدل‌های هوش مصنوعی و کاربردهای صنعتی",
      priority: 3,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 20,
    },
    {
      name: "Peterson Institute for International Economics (PIIE)",
      url: "https://www.piie.com/rss.xml",
      type: "rss",
      category: "ژئواکونومیک و تجارت فناوری",
      description: "پژوهش‌های کنترل صادرات تراشه، سیاست صنعتی، رقابت فناوری آمریکا و چین و تجارت دیجیتال",
      priority: 2,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 25,
    },
    {
      name: "Bruegel — European Economic Think Tank",
      url: "https://www.bruegel.org/rss.xml",
      type: "rss",
      category: "رقابت دیجیتال و مقررات AI",
      description: "تحلیل‌های اقتصاد دیجیتال، قانون هوش مصنوعی اتحادیه اروپا (AI Act)، ضدانحصار و سیاست صنعتی",
      priority: 3,
      fetchIntervalMinutes: 120,
      maxItemsPerFetch: 25,
    },
  ],
};

/** Backward-compatible aliases pointing to the Economics of AI pack. */
export const ENGLISH_ECONOMICS_PACK: NewsPack = AI_ECONOMICS_PACK;
export const DEFAULT_NEWS_PACK = AI_ECONOMICS_PACK;

export const NEWS_PACKS: readonly NewsPack[] = [AI_ECONOMICS_PACK];

export function getNewsPack(id: string): NewsPack | undefined {
  if (id === "english-economics") return AI_ECONOMICS_PACK;
  return NEWS_PACKS.find((pack) => pack.id === id);
}

/** Canonical comparison key for topic labels (case + Persian letter variants). */
export function normalizeTopicLabel(label: string): string {
  return label
    .replace(/\u064A/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(/[\u200C\u200F\u200E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Canonical comparison key for feed URLs (ignores trailing slash & fragment). */
export function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

export type TopicMergeResult = {
  topics: AiTopicRule[];
  added: string[];
  skipped: string[];
  truncated: number;
};

/**
 * Upgrades pack-managed topic rows (`pack-econ-*` from the retired general
 * economics pack or older `pack-aiecon-*` keyword lists) to the current
 * AI-anchored `AI_ECONOMICS_PACK.topics`, while leaving custom operator-added
 * topics completely untouched.
 */
export function upgradeLegacyPackTopicFilter(filter: AiTopicFilterConfig): AiTopicFilterConfig {
  if (!filter?.topics?.length) return filter;
  const hasPackTopics = filter.topics.some(
    (topic) => topic.id.startsWith("pack-econ-") || topic.id.startsWith("pack-aiecon-"),
  );
  if (!hasPackTopics) return filter;

  const disabledPackIds = new Set(
    filter.topics
      .filter((topic) => topic.id.startsWith("pack-aiecon-") && !topic.enabled)
      .map((topic) => topic.id),
  );
  const customTopics = filter.topics.filter(
    (topic) => !topic.id.startsWith("pack-econ-") && !topic.id.startsWith("pack-aiecon-"),
  );
  const upgradedPackTopics: AiTopicRule[] = AI_ECONOMICS_PACK.topics.map((seed) => ({
    id: seed.id,
    label: seed.label,
    enabled: !disabledPackIds.has(seed.id),
    keywords: [...seed.keywords],
  }));

  return {
    ...filter,
    topics: [...customTopics, ...upgradedPackTopics].slice(0, TOPIC_LIMIT),
  };
}

/**
 * Merges a pack's topics into an existing list without duplicating labels or
 * ids, respecting the 30-topic validation limit of `ai-config/config-service`.
 * When applying `ai-economics`, retired `pack-econ-*` general-economics pack
 * topics are removed and stale `pack-aiecon-*` pack topics refresh their keywords.
 */
export function mergePackTopics(existing: readonly AiTopicRule[], pack: NewsPack): TopicMergeResult {
  const cleanedExisting =
    pack.id === "ai-economics"
      ? existing.filter((topic) => !topic.id.startsWith("pack-econ-"))
      : existing;

  const result: AiTopicRule[] = cleanedExisting.map((topic) => ({
    ...topic,
    keywords: [...topic.keywords],
  }));
  const byLabel = new Map<string, number>();
  const seenIds = new Set<string>();
  result.forEach((topic, idx) => {
    byLabel.set(normalizeTopicLabel(topic.label), idx);
    seenIds.add(topic.id);
  });

  const added: string[] = [];
  const skipped: string[] = [];
  let truncated = 0;

  for (const seed of pack.topics) {
    const key = normalizeTopicLabel(seed.label);
    const existingIdx = byLabel.get(key);
    if (existingIdx !== undefined) {
      const current = result[existingIdx];
      // Refresh pack-owned topic keywords if the pack definition evolved; custom topics stay untouched.
      if (current.id === seed.id && JSON.stringify(current.keywords) !== JSON.stringify(seed.keywords)) {
        result[existingIdx] = { ...current, keywords: [...seed.keywords] };
        added.push(seed.label);
      } else {
        skipped.push(seed.label);
      }
      continue;
    }
    if (result.length >= TOPIC_LIMIT) {
      truncated += 1;
      continue;
    }

    let id = seed.id;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${seed.id}-${suffix++}`;
    }

    result.push({
      id,
      label: seed.label,
      enabled: true,
      keywords: [...seed.keywords],
    });
    byLabel.set(key, result.length - 1);
    seenIds.add(id);
    added.push(seed.label);
  }

  return { topics: result, added, skipped, truncated };
}

/**
 * Merges a pack's deny-list keywords into an existing `blockedKeywords` array
 * (additive, case/Persian-normalized dedupe, respects the 100-item cap).
 */
export function mergeBlockedKeywords(
  existing: readonly string[] | undefined,
  pack: NewsPack,
  limit = 100,
): { blockedKeywords: string[]; added: string[]; skipped: string[] } {
  const result = [...(existing ?? [])];
  const seen = new Set(result.map(normalizeTopicLabel));
  const added: string[] = [];
  const skipped: string[] = [];

  for (const kw of pack.blockedKeywords ?? []) {
    const key = normalizeTopicLabel(kw);
    if (!key) continue;
    if (seen.has(key)) {
      skipped.push(kw);
      continue;
    }
    if (result.length >= limit) break;
    result.push(kw);
    seen.add(key);
    added.push(kw);
  }

  return { blockedKeywords: result, added, skipped };
}

/**
 * Appends the pack's audience note to `systemPrompt` once. If the marker (or
 * the exact note) is already present, returns the prompt untouched.
 */
export function appendAudienceNote(
  systemPrompt: string,
  pack: NewsPack,
): { prompt: string; alreadyPresent: boolean } {
  if (!pack.audienceNote) return { prompt: systemPrompt, alreadyPresent: true };
  const marker = pack.audienceMarker ?? pack.audienceNote;
  if (systemPrompt.includes(marker)) {
    return { prompt: systemPrompt, alreadyPresent: true };
  }
  const base = systemPrompt.trimEnd();
  return {
    prompt: `${base}\n\n${pack.audienceNote}`,
    alreadyPresent: false,
  };
}
