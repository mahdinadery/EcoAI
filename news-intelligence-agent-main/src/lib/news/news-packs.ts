/**
 * Ready-made news packs (pure data + pure helpers — safe on client and server).
 *
 * A pack bundles the two things an operator needs to start monitoring a domain:
 *
 *   1. topics — keyword groups understood by the pre-AI topic filter
 *      (src/lib/news/topic-filter.ts) and injected into the AI prompt;
 *   2. domestic sources — RSS feeds that the apply action probes before adding.
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
 * «اعتبارسنجی» domain pack for a credit rating company.
 *
 * Keywords are intentionally specific (no bare «بورس»/«دلار») so the cheap
 * pre-AI gate does not flood the queue with daily price/index reports, while
 * the eight topics still cover the different kinds of domestic news a rating
 * analyst watches: rating actions, credit risk, banking, capital market,
 * regulation, macro, corporate financials and credit insurance.
 */
export const CREDIT_RATING_PACK: NewsPack = {
  id: "credit-rating",
  title: "اعتبارسنجی و رتبه‌بندی اعتباری (اخبار داخلی)",
  description:
    "هشت موضوع تخصصی اعتبارسنجی به‌همراه شش منبع خبری اقتصادی داخلی. هر منبع پیش از افزودن تست می‌شود و موضوعات به‌صورت «تمرکز» روی پیکربندی فعال اعمال می‌شوند.",
  audienceNote:
    "مخاطب هدف این سامانه یک شرکت اعتبارسنجی است؛ اهمیت، مرتبط بودن و توصیه ارسال هر خبر را از منظر ریسک اعتباری ناشران، رتبه‌بندی اعتباری، سلامت مالی بانک‌ها و شرکت‌ها و وضعیت بازار بدهی ایران ارزیابی کن. هرگز «تخصیص اعتبار» دولتی/عمرانی (مانند ساخت جاده و پل یا اعتبارات استانی) و «اعتبار کالابرگ/یارانه» را با «اعتبارسنجی» معادل نگیر.",
  audienceMarker: "مخاطب هدف این سامانه یک شرکت اعتبارسنجی است",
  blockedKeywords: [
    "ورزش",
    "فوتبال",
    "لیگ برتر",
    "سرگرمی",
    "هنرمندان",
    "سینما",
    "حوادث",
    "تصادف",
    "تخصیص اعتبار",
    "اعتبارات عمرانی",
    "اعتبارات استانی",
    "کالابرگ",
    "اعتبار کالابرگ",
  ],
  topics: [
    {
      id: "rating-core",
      label: "اعتبارسنجی و رتبه‌بندی اعتباری",
      enabled: true,
      keywords: [
        "اعتبارسنجی",
        "اعتبار سنجی",
        "رتبه‌بندی اعتباری",
        "رتبه بندی اعتباری",
        "رتبه اعتباری",
        "مؤسسه اعتبارسنجی",
        "موسسه اعتبارسنجی",
        "شرکت اعتبارسنجی",
        "نهاد اعتبارسنجی",
        "رتبه‌بندی ناشران",
        "رتبه‌بندی اوراق",
        "credit rating",
        "rating agency",
      ],
    },
    {
      id: "credit-risk",
      label: "ریسک اعتباری و نکول",
      enabled: true,
      keywords: [
        "ریسک اعتباری",
        "نکول",
        "نرخ نکول",
        "ریسک نکول",
        "مطالبات معوق",
        "مطالبات غیرجاری",
        "چک برگشتی",
        "ورشکستگی",
        "تسویه بدهی",
        "default risk",
      ],
    },
    {
      id: "banking",
      label: "بانک و بازار پول",
      enabled: true,
      keywords: [
        "بانک مرکزی",
        "بانکداری",
        "شبکه بانکی",
        "تسهیلات بانکی",
        "نرخ سود",
        "سپرده",
        "کفایت سرمایه",
        "مؤسسه اعتباری",
        "موسسه اعتباری",
        "نقدینگی",
        "پایه پولی",
      ],
    },
    {
      id: "capital-market",
      label: "بازار سرمایه و تأمین مالی",
      enabled: true,
      keywords: [
        "بازار سرمایه",
        "فرابورس",
        "سازمان بورس",
        "اوراق بدهی",
        "اوراق قرضه",
        "تأمین مالی",
        "تامین مالی",
        "پذیره‌نویسی",
        "پذیره نویسی",
        "عرضه اولیه",
        "صندوق سرمایه‌گذاری",
        "صندوق سرمایه گذاری",
        "بازار بدهی",
      ],
    },
    {
      id: "regulation",
      label: "مقررات و نهادهای ناظر",
      enabled: true,
      keywords: [
        "سازمان بورس",
        "شورای عالی بورس",
        "بیمه مرکزی",
        "وزارت امور اقتصادی و دارایی",
        "مجوز فعالیت",
        "نظارت بانکی",
        "کمیته ریسک",
      ],
    },
    {
      id: "macro",
      label: "اقتصاد کلان ایران",
      enabled: true,
      keywords: [
        "تولید ناخالص داخلی",
        "رشد اقتصادی",
        "کسری بودجه",
        "نرخ بهره",
        "سیاست پولی",
        "سیاست مالی",
        "بدهی دولت",
      ],
    },
    {
      id: "financials",
      label: "گزارش‌های مالی شرکت‌ها",
      enabled: true,
      keywords: [
        "صورت‌های مالی",
        "صورت های مالی",
        "گزارش مالی",
        "گزارش حسابرسی",
        "حسابرسی",
        "سود و زیان",
        "ترازنامه",
        "مجمع عمومی",
        "افزایش سرمایه",
        "شفافیت اطلاعات",
        "افشای اطلاعات",
      ],
    },
    {
      id: "insurance",
      label: "بیمه، ضمانت و لیزینگ",
      enabled: true,
      keywords: [
        "بیمه اعتبار",
        "ضمانت‌نامه",
        "ضمانت نامه",
        "لیزینگ",
        "شرکت لیزینگ",
        "صندوق ضمانت",
      ],
    },
  ],
  sources: [
    {
      name: "سنا — بازار سرمایه",
      url: "https://www.sena.ir/rss",
      type: "rss",
      category: "بازار سرمایه",
      description:
        "پایگاه اطلاع‌رسانی بازار سرمایه ایران (سنا)، خبرگزاری رسمی سازمان بورس و اوراق بهادار.",
      priority: 5,
      fetchIntervalMinutes: 30,
      maxItemsPerFetch: 60,
    },
    {
      name: "سنا — بانک مرکزی و بازار پول",
      url: "https://www.sena.ir/rss/tp/60",
      type: "rss",
      category: "بانک و بازار پول",
      description: "فید تخصصی سیاست‌گذاری پولی، بانک مرکزی و بازار پول در سنا.",
      priority: 5,
      fetchIntervalMinutes: 30,
      maxItemsPerFetch: 50,
    },
    {
      name: "دنیای اقتصاد",
      url: "https://donya-e-eqtesad.com/feeds",
      type: "rss",
      category: "اقتصاد",
      description: "روزنامه اقتصادی دنیای اقتصاد — اخبار و تحلیل‌های اقتصادی و مالی ایران.",
      priority: 4,
      fetchIntervalMinutes: 30,
      maxItemsPerFetch: 60,
    },
    {
      name: "ایرنا",
      url: "https://www.irna.ir/rss",
      type: "rss",
      category: "خبرگزاری",
      description: "خبرگزاری جمهوری اسلامی (ایرنا) — پوشش سراسری اخبار ایران و جهان.",
      priority: 3,
      fetchIntervalMinutes: 30,
      maxItemsPerFetch: 40,
    },
    {
      name: "ایسنا",
      url: "https://www.isna.ir/rss",
      type: "rss",
      category: "خبرگزاری",
      description: "خبرگزاری دانشجویان ایران (ایسنا) — اخبار اقتصادی، اجتماعی و علمی.",
      priority: 3,
      fetchIntervalMinutes: 30,
      maxItemsPerFetch: 40,
    },
    {
      name: "مهر",
      url: "https://www.mehrnews.com/rss",
      type: "rss",
      category: "خبرگزاری",
      description: "خبرگزاری مهر — اخبار ایران و جهان.",
      priority: 3,
      fetchIntervalMinutes: 30,
      maxItemsPerFetch: 40,
    },
  ],
};

export const NEWS_PACKS: NewsPack[] = [CREDIT_RATING_PACK];

export function getNewsPack(id: string): NewsPack | undefined {
  return NEWS_PACKS.find((pack) => pack.id === id);
}

/** Persian-friendly label comparison (ZWNJ, Arabic letters, whitespace). */
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
