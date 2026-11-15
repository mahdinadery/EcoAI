/**
 * Bulletin (digest) message builder — Phase 2 roadmap task #4.
 *
 * PURE MODULE (no runtime imports; type-only is fine) so the Node test runner
 * can import it. Sending/DB live in `delivery/index.ts`; the AI intro is
 * synthesized in `ai/bulletin-brief.ts`.
 */

/** Default number of items in one digest (roadmap: 3–5). */
export const MAX_BULLETIN_ITEMS = 5;

/**
 * Hard ceiling for `maxItems`. Daily digests stay at the 5-item default, but a
 * weekly digest legitimately has more to say — one entry per day plus a lead —
 * so the setting is allowed to go up to ten before the message length limit
 * (see BALE_MESSAGE_LIMIT) becomes the binding constraint.
 */
export const BULLETIN_ITEM_CEILING = 10;

/**
 * Bale Bot API rejects a single message longer than 4096 characters
 * (`Bad Request: message is too long`). Keep a safety margin for emoji and
 * Markdown link overhead.
 */
export const BALE_MESSAGE_LIMIT = 4000;

export const BULLETIN_TEMPLATE_VARS = ["title", "date", "intro", "items", "count"] as const;
export const BULLETIN_ITEM_TEMPLATE_VARS = [
  "number",
  "bilingualTitle",
  "translatedTitle",
  "originalTitle",
  "title",
  "summary",
  "whyItMatters",
  "whyBlock",
  "entities",
  "entitiesBlock",
  "sources",
  "originalUrl",
  "importanceScore",
  "hashtags",
] as const;
export const DEFAULT_BULLETIN_TEMPLATE = "🗞️ {title} — {date}\n\n{intro}\n\n{items}";
export const DEFAULT_BULLETIN_ITEM_TEMPLATE =
  "{number} {bilingualTitle}\n{summary}\n{whyBlock}\n{entitiesBlock}\n{sources}\n{originalUrl}\n{hashtags}";

export function unknownBulletinVariables(template: string, allowed: readonly string[]): string[] {
  return [...new Set([...template.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).filter((key) => !allowed.includes(key)))];
}
function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => values[key] ?? match).replace(/\n{3,}/g, "\n\n").trim();
}

export type BulletinSettings = {
  template: string;
  itemTemplate: string;
  title: string;
  maxItems: number;
  showSummary: boolean;
  showWhy: boolean;
  showEntities: boolean;
  showSources: boolean;
  aiIntro: boolean;
  introPrompt: string;
  introMaxTokens: number;
};

export const DEFAULT_BULLETIN_SETTINGS: BulletinSettings = {
  template: "",
  itemTemplate: "",
  title: "بولتن خبری",
  maxItems: 5,
  showSummary: true,
  showWhy: true,
  showEntities: true,
  showSources: true,
  aiIntro: true,
  introPrompt:
    "تو سردبیر یک بولتن تخصصی در حوزهٔ «اقتصاد هوش مصنوعی» (The Economics of AI) هستی. یک جمع‌بندی فارسی روان ۲ تا ۴ جمله‌ای از مقالات داده‌شده و پیامد مستندشان برای بهره‌وری، بازار کار، سرمایه‌گذاری زیرساختی و اقتصاد هوش مصنوعی بنویس. ارتباط حدسی نساز. فقط متن جمع‌بندی فارسی، بدون عنوان یا فهرست یا Markdown.",
  introMaxTokens: 400,
};
export function resolveBulletinSettings(value?: Partial<BulletinSettings>): BulletinSettings {
  const merged = { ...DEFAULT_BULLETIN_SETTINGS, ...value };
  // A stored value outside 1..10 (hand-edited config, older UI) must not be
  // able to produce an empty or 100-item digest.
  const maxItems = Number.isFinite(merged.maxItems) ? Math.trunc(merged.maxItems) : DEFAULT_BULLETIN_SETTINGS.maxItems;
  return { ...merged, maxItems: Math.max(1, Math.min(BULLETIN_ITEM_CEILING, maxItems)) };
}

export function validateBulletinSettings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["تنظیمات بولتن نامعتبر است."];
  const settings = value as Partial<BulletinSettings>;
  const errors: string[] = [];
  for (const [key, allowed] of [
    ["template", BULLETIN_TEMPLATE_VARS],
    ["itemTemplate", BULLETIN_ITEM_TEMPLATE_VARS],
  ] as const) {
    const template = settings[key];
    if (template === undefined) continue;
    if (typeof template !== "string" || template.length > 8000) {
      errors.push(`قالب بولتن ${key} باید متن با حداکثر ۸۰۰۰ نویسه باشد.`);
      continue;
    }
    const unknown = unknownBulletinVariables(template, allowed);
    if (unknown.length) errors.push(`متغیر ناشناخته در قالب بولتن ${key}: ${unknown.join("، ")}`);
    if (key === "template" && template.trim() && !template.includes("{items}"))
      errors.push("قالب کل بولتن باید متغیر {items} را داشته باشد.");
  }

  if (settings.title !== undefined && (typeof settings.title !== "string" || !settings.title.trim() || settings.title.length > 100))
    errors.push("عنوان بولتن باید یک تا ۱۰۰ نویسه باشد.");
  if (
    settings.maxItems !== undefined &&
    (!Number.isInteger(settings.maxItems) || settings.maxItems < 1 || settings.maxItems > BULLETIN_ITEM_CEILING)
  )
    errors.push(`تعداد خبر بولتن باید ۱ تا ${BULLETIN_ITEM_CEILING} باشد (برای بولتن هفتگی ۸ تا ۱۰ مناسب است).`);
  if (settings.introMaxTokens !== undefined && (!Number.isInteger(settings.introMaxTokens) || settings.introMaxTokens < 50 || settings.introMaxTokens > 500))
    errors.push("سقف توکن مقدمه باید ۵۰ تا ۵۰۰ باشد.");
  if (settings.introPrompt !== undefined && (typeof settings.introPrompt !== "string" || !settings.introPrompt.trim() || settings.introPrompt.length > 4000))
    errors.push("دستور مقدمه باید یک تا ۴۰۰۰ نویسه باشد.");
  for (const key of ["showSummary", "showWhy", "showEntities", "showSources", "aiIntro"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean")
      errors.push(`گزینه بولتن ${key} باید روشن یا خاموش باشد.`);
  }
  return errors;
}

export type BulletinItem = {
  hashtags?: string | null;
  id: string;
  title: string;
  /** Optional Persian translated headline (renders bilingual header when distinct from `title`). */
  translatedTitle?: string | null;
  /** Compact one-liner (usually the stored Persian summary). */
  oneLiner: string | null;
  whyItMatters: string | null;
  url: string;
  importanceScore: number | null;
  publishedAt: Date | null;
  /** Phase 3: multi-source confirmation — shows the «تأییدشده» badge. */
  corroborated?: boolean;
  /** Other outlets carrying the same event (names) — listed under the item. */
  corroborationSources?: string[];
  /** Phase 3: Persian entity names (institutions/banks/countries). */
  entityTags?: string[];
};

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

function escapeMd(text: string): string {
  return text
    .split(/(#[\p{L}\p{N}_\\\u200c]+)/gu)
    .map((part, index) =>
      index % 2 ? part.replace(/\\_/g, "_").replace(/\\/g, "") : part.replace(/([\\_*\[\]`])/g, "\\$1"),
    )
    .join("");
}

function mdLink(text: string, url: string): string {
  const safeUrl = url.replace(/[() ]/g, (char) => (char === " " ? "%20" : char === "(" ? "%28" : "%29"));
  return `[${escapeMd(text)}](${safeUrl})`;
}

function compact(text: string | null | undefined, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function compactSummaryForBulletin(text: string | null | undefined, max: number): string {
  const clean = (text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function formatBulletinTitles(item: BulletinItem): {
  primaryTitle: string;
  originalTitle: string;
  bilingualInline: string;
  hasDistinctTranslation: boolean;
} {
  const orig = compact(item.title, 160);
  const trans = compact(item.translatedTitle, 160);
  const hasDistinct = Boolean(trans && orig && trans.toLowerCase() !== orig.toLowerCase());
  const escapedOrig = escapeMd(orig);
  const escapedPrimary = escapeMd(hasDistinct ? trans : orig);
  return {
    primaryTitle: escapedPrimary,
    originalTitle: escapedOrig,
    bilingualInline: hasDistinct ? `${escapedPrimary}\n🌐 ${escapedOrig}` : escapedOrig,
    hasDistinctTranslation: hasDistinct,
  };
}

/**
 * Ranks candidates and takes the top `max`: highest balanced importance+relevance
 * first, newest first on ties.
 */
export function pickBulletinItems<
  T extends { importanceScore: number | null; relevanceScore?: number | null; publishedAt: Date | null },
>(items: T[], max: number = MAX_BULLETIN_ITEMS): T[] {
  return [...items]
    .sort((a, b) => {
      const balanced =
        Math.min(b.importanceScore ?? 0, b.relevanceScore ?? b.importanceScore ?? 0) -
        Math.min(a.importanceScore ?? 0, a.relevanceScore ?? a.importanceScore ?? 0);
      if (balanced !== 0) return balanced;
      const importance =
        (b.importanceScore ?? 0) + (b.relevanceScore ?? 0) - ((a.importanceScore ?? 0) + (a.relevanceScore ?? 0));
      if (importance !== 0) return importance;
      return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
    })
    .slice(0, Math.max(0, Math.min(max, BULLETIN_ITEM_CEILING)));
}

/**
 * Splits a long Bale message into chunks that each fit `BALE_MESSAGE_LIMIT`.
 * Splits on blank-line boundaries so Markdown links (one per line) are never
 * cut in half. A single overlong line is hard-split as a last resort.
 */
export function splitBaleMessage(text: string, limit = BALE_MESSAGE_LIMIT): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of clean.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;
    // Hard-split a single paragraph that alone exceeds the limit.
    if (block.length > limit) {
      pushCurrent();
      for (let i = 0; i < block.length; i += limit) {
        chunks.push(block.slice(i, i + limit));
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      pushCurrent();
      current = block;
    }
  }
  pushCurrent();
  return chunks.length > 0 ? chunks : [clean.slice(0, limit)];
}

export function buildBulletinMessage(args: {
  /** AI-synthesized intro (null/empty => no intro block). */
  intro: string | null;
  items: BulletinItem[];
  generatedAt: Date;
  /** IANA timezone for the header date (e.g. "Asia/Tehran"). */
  timezone: string;
  settings?: Partial<BulletinSettings>;
  /**
   * Start of the covered period (weekly digests pass «seven days ago»). When the
   * gap to `generatedAt` is more than a day, the header shows a range
   * («۸ آبان تا ۱۴ آبان») instead of a single date, so a weekly issue cannot be
   * mistaken for a daily one. Omitted/short windows keep today's date.
   */
  windowStart?: Date | null;
}): string {
  const { intro, generatedAt, timezone } = args;
  const settings = resolveBulletinSettings(args.settings);
  const items = args.items.slice(0, settings.maxItems);

  const formatDay = (date: Date): string => {
    try {
      return date.toLocaleDateString("fa-IR", { timeZone: timezone, dateStyle: "medium" });
    } catch {
      // Invalid timezone => keep the ISO date.
      return date.toISOString().slice(0, 10);
    }
  };

  let dateLabel = formatDay(generatedAt);
  // A "weekly" header only makes sense when the window really spans days.
  const windowStart = args.windowStart ?? null;
  if (windowStart && generatedAt.getTime() - windowStart.getTime() >= 36 * 60 * 60 * 1000) {
    dateLabel = `${formatDay(windowStart)} تا ${dateLabel}`;
  }

  const lines: string[] = [`🗞️ ${escapeMd(settings.title)} — ${dateLabel}`];

  const introText = compact(intro, 600);
  if (settings.aiIntro && introText) {
    lines.push("", escapeMd(introText));
  }

  const renderedItems: string[] = [];
  items.forEach((item, index) => {
    const start = lines.length;
    const marker = NUMBER_EMOJI[index] ?? `${index + 1}.`;
    const titles = formatBulletinTitles(item);
    lines.push("", `${marker} ${titles.primaryTitle}`);
    if (titles.hasDistinctTranslation) {
      lines.push(`🌐 ${titles.originalTitle}`);
    }
    const oneLiner = compactSummaryForBulletin(item.oneLiner, 520);
    if (settings.showSummary && oneLiner) lines.push(escapeMd(oneLiner));
    const why = compact(item.whyItMatters, 240);
    if (settings.showWhy && why) lines.push(`چرا مهم است: ${escapeMd(why)}`);
    const entities = compact((item.entityTags ?? []).slice(0, 4).join("، "), 160);
    if (settings.showEntities && entities) lines.push(`نهادها: ${escapeMd(entities)}`);
    const otherSources = (item.corroborationSources ?? []).slice(0, 3).map((name) => escapeMd(name));
    if (settings.showSources && otherSources.length > 0) {
      lines.push(
        `تأییدشده توسط ${Math.max(2, otherSources.length + 1).toLocaleString("fa-IR")} منبع: ${otherSources.join("، ")}`,
      );
    } else if (settings.showSources && item.corroborated) {
      lines.push("تأییدشده توسط چند منبع ✓");
    }
    lines.push(mdLink("لینک اصلی خبر", item.url));
    const hashtags = compact(item.hashtags, 160);
    if (hashtags) lines.push(escapeMd(hashtags));
    const defaultItem = lines.slice(start).join("\n").trim();
    let customItem = settings.itemTemplate.trim()
      ? renderTemplate(settings.itemTemplate, {
          number: marker,
          bilingualTitle: titles.bilingualInline,
          translatedTitle: titles.primaryTitle,
          originalTitle: titles.originalTitle,
          title: titles.primaryTitle,
          summary: settings.showSummary ? escapeMd(oneLiner) : "",
          whyItMatters: settings.showWhy ? escapeMd(why) : "",
          whyBlock: settings.showWhy && why ? `چرا مهم است: ${escapeMd(why)}` : "",
          entities: settings.showEntities ? escapeMd(entities) : "",
          entitiesBlock: settings.showEntities && entities ? `نهادها: ${escapeMd(entities)}` : "",
          sources: settings.showSources
            ? otherSources.length
              ? `تأییدشده توسط ${Math.max(2, otherSources.length + 1).toLocaleString("fa-IR")} منبع: ${otherSources.join("، ")}`
              : item.corroborated
                ? "تأییدشده توسط چند منبع ✓"
                : ""
            : "",
          originalUrl: mdLink("لینک اصلی خبر", item.url),
          hashtags: escapeMd(hashtags),
          importanceScore: item.importanceScore == null ? "—" : String(item.importanceScore),
        })
      : defaultItem;
    if (settings.itemTemplate.trim() && !settings.itemTemplate.includes("{originalUrl}"))
      customItem += `\n${mdLink("لینک اصلی خبر", item.url)}`;
    renderedItems.push(customItem);
  });

  if (!settings.template.trim() && !settings.itemTemplate.trim()) return lines.join("\n");
  return renderTemplate(settings.template.trim() || DEFAULT_BULLETIN_TEMPLATE, {
    title: escapeMd(settings.title),
    date: dateLabel,
    intro: settings.aiIntro ? escapeMd(introText) : "",
    items: renderedItems.join("\n\n"),
    count: String(items.length),
  });
}
