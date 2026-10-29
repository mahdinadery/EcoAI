/**
 * Bulletin (digest) message builder — Phase 2 roadmap task #4.
 *
 * PURE MODULE (no runtime imports; type-only is fine) so the Node test runner
 * can import it. Sending/DB live in `delivery/index.ts`; the AI intro is
 * synthesized in `ai/bulletin-brief.ts`.
 *
 * Layout (the operator picked "AI brief + minimal columns"):
 *
 *   🗞️ بولتن خبری — <date>
 *   <AI intro paragraph, 2–4 sentences>
 *
 *   1️⃣ <title>
 *   <one-liner>
 *   چرا مهم است: <why>
 *   🔗 <url>
 *   ...
 */

/** Upper bound of items packed into one digest (roadmap: 3–5). */
export const MAX_BULLETIN_ITEMS = 5;

export const BULLETIN_TEMPLATE_VARS = ["title", "date", "intro", "items", "count"] as const;
export const BULLETIN_ITEM_TEMPLATE_VARS = ["number", "title", "summary", "whyItMatters", "whyBlock", "entities", "entitiesBlock", "sources", "originalUrl", "importanceScore", "hashtags"] as const;
export const DEFAULT_BULLETIN_TEMPLATE = "🗞️ {title} — {date}\n\n{intro}\n\n{items}";
export const DEFAULT_BULLETIN_ITEM_TEMPLATE = "{number} {title}\n{summary}\n{whyBlock}\n{entitiesBlock}\n{sources}\n{originalUrl}\n{hashtags}";

export function unknownBulletinVariables(template: string, allowed: readonly string[]): string[] {
  return [...new Set([...template.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).filter(key => !allowed.includes(key)))];
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
  template: "", itemTemplate: "",
  title: "بولتن خبری", maxItems: 5, showSummary: true, showWhy: true,
  showEntities: true, showSources: true, aiIntro: true,
  introPrompt: "تو سردبیر یک بولتن خبری تخصصی اعتبارسنجی و رتبه‌بندی اعتباری هستی. یک جمع‌بندی فارسی ۲ تا ۴ جمله‌ای از خبرهای داده‌شده و اثر مستندشان بر ریسک اعتباری بنویس. ارتباط حدسی نساز. فقط متن جمع‌بندی، بدون عنوان یا فهرست یا Markdown.",
  introMaxTokens: 400,
};
export function resolveBulletinSettings(value?: Partial<BulletinSettings>): BulletinSettings {
  return { ...DEFAULT_BULLETIN_SETTINGS, ...value };
}

export function validateBulletinSettings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["تنظیمات بولتن نامعتبر است."];
  const settings = value as Partial<BulletinSettings>;
  const errors: string[] = [];
  for (const [key, allowed] of [["template", BULLETIN_TEMPLATE_VARS], ["itemTemplate", BULLETIN_ITEM_TEMPLATE_VARS]] as const) {
    const template = settings[key];
    if (template === undefined) continue;
    if (typeof template !== "string" || template.length > 8000) { errors.push(`قالب بولتن ${key} باید متن با حداکثر ۸۰۰۰ نویسه باشد.`); continue; }
    const unknown = unknownBulletinVariables(template, allowed);
    if (unknown.length) errors.push(`متغیر ناشناخته در قالب بولتن ${key}: ${unknown.join("، ")}`);
    if (key === "template" && template.trim() && !template.includes("{items}")) errors.push("قالب کل بولتن باید متغیر {items} را داشته باشد.");
  }

  if (settings.title !== undefined && (typeof settings.title !== "string" || !settings.title.trim() || settings.title.length > 100)) errors.push("عنوان بولتن باید یک تا ۱۰۰ نویسه باشد.");
  if (settings.maxItems !== undefined && (!Number.isInteger(settings.maxItems) || settings.maxItems < 1 || settings.maxItems > 5)) errors.push("تعداد خبر بولتن باید یک تا پنج باشد.");
  if (settings.introMaxTokens !== undefined && (!Number.isInteger(settings.introMaxTokens) || settings.introMaxTokens < 50 || settings.introMaxTokens > 500)) errors.push("سقف توکن مقدمه باید ۵۰ تا ۵۰۰ باشد.");
  if (settings.introPrompt !== undefined && (typeof settings.introPrompt !== "string" || !settings.introPrompt.trim() || settings.introPrompt.length > 4000)) errors.push("دستور مقدمه باید یک تا ۴۰۰۰ نویسه باشد.");
  for (const key of ["showSummary", "showWhy", "showEntities", "showSources", "aiIntro"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") errors.push(`گزینه بولتن ${key} باید روشن یا خاموش باشد.`);
  }
  return errors;
}

export type BulletinItem = {
  hashtags?: string | null;
  id: string;
  title: string;
  /** Compact one-liner (usually the stored summary). */
  oneLiner: string | null;
  whyItMatters: string | null;
  url: string;
  importanceScore: number | null;
  publishedAt: Date | null;
  /** Phase 3: multi-source confirmation — shows the «تأییدشده» badge. */
  corroborated?: boolean;
  /** Other outlets carrying the same event (names) — listed under the item. */
  corroborationSources?: string[];
  /** Phase 3: Persian entity names (banks/companies/institutions). */
  entityTags?: string[];
};

const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

/**
 * Markdown hyperlink helpers (title = link to the ORIGINAL source URL; no
 * short links). Duplicated from message.ts on purpose: this module is
 * imported by the node test runner and may not take runtime relative imports.
 */
function escapeMd(text: string): string {
  return text.split(/(#[\p{L}\p{N}_\\\u200c]+)/gu).map((part, index) =>
    index % 2 ? part.replace(/\\_/g, "_").replace(/\\/g, "") : part.replace(/([\\_*\[\]`])/g, "\\$1")
  ).join("");
}

function mdLink(text: string, url: string): string {
  const safeUrl = url.replace(/[() ]/g, (char) => (char === " " ? "%20" : char === "(" ? "%28" : "%29"));
  return `[${escapeMd(text)}](${safeUrl})`;
}

function compact(text: string | null | undefined, max: number): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Ranks candidates and takes the top `max`: highest importance first, newest
 * first on ties. Pure — the caller supplies already rule-approved items.
 */
export function pickBulletinItems<T extends { importanceScore: number | null; relevanceScore?: number | null; publishedAt: Date | null }>(
  items: T[],
  max: number = MAX_BULLETIN_ITEMS,
): T[] {
  return [...items]
    .sort((a, b) => {
      // Prioritize balance: neither importance nor relevance can compensate
      // for a weak score in the other dimension.
      const balanced = Math.min(b.importanceScore ?? 0, b.relevanceScore ?? b.importanceScore ?? 0) - Math.min(a.importanceScore ?? 0, a.relevanceScore ?? a.importanceScore ?? 0);
      if (balanced !== 0) return balanced;
      const importance = ((b.importanceScore ?? 0) + (b.relevanceScore ?? 0)) - ((a.importanceScore ?? 0) + (a.relevanceScore ?? 0));
      if (importance !== 0) return importance;
      return (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0);
    })
    .slice(0, Math.max(0, Math.min(max, MAX_BULLETIN_ITEMS)));
}

export function buildBulletinMessage(args: {
  /** AI-synthesized intro (null/empty => no intro block). */
  intro: string | null;
  items: BulletinItem[];
  generatedAt: Date;
  /** IANA timezone for the header date (e.g. "Asia/Tehran"). */
  timezone: string;
  settings?: Partial<BulletinSettings>;
}): string {
  const { intro, generatedAt, timezone } = args;
  const settings = resolveBulletinSettings(args.settings);
  const items = args.items.slice(0, settings.maxItems);

  let dateLabel = generatedAt.toISOString().slice(0, 10);
  try {
    dateLabel = generatedAt.toLocaleDateString("fa-IR", {
      timeZone: timezone,
      dateStyle: "medium",
    });
  } catch {
    // Invalid timezone => keep the ISO date.
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
    lines.push("", `${marker} ${escapeMd(compact(item.title, 160))}`);
    const oneLiner = compact(item.oneLiner, 220);
    if (settings.showSummary && oneLiner) lines.push(escapeMd(oneLiner));
    const why = compact(item.whyItMatters, 220);
    if (settings.showWhy && why) lines.push(`چرا مهم است: ${escapeMd(why)}`);
    const entities = (item.entityTags ?? []).slice(0, 4).join("، ");
    if (settings.showEntities && entities) lines.push(`نهادها: ${escapeMd(entities)}`);
    const otherSources = (item.corroborationSources ?? []).slice(0, 3).map((name) => escapeMd(name));
    if (settings.showSources && otherSources.length > 0) {
      lines.push(
        `تأییدشده توسط ${Math.max(2, otherSources.length + 1).toLocaleString("fa-IR")} منبع: ${otherSources.join("، ")}`,
      );
    } else if (settings.showSources && item.corroborated) {
      lines.push("تأییدشده توسط چند منبع ✓");
    }
    // Per-item link: the label «لینک اصلی خبر» IS the hyperlink (user spec).
    lines.push(mdLink("لینک اصلی خبر", item.url));
    if (item.hashtags) lines.push(escapeMd(item.hashtags));
    const defaultItem = lines.slice(start).join("\n").trim();
    let customItem = settings.itemTemplate.trim() ? renderTemplate(settings.itemTemplate, {
      number: marker, title: escapeMd(compact(item.title, 160)),
      summary: settings.showSummary ? escapeMd(oneLiner) : "",
      whyItMatters: settings.showWhy ? escapeMd(why) : "",
      whyBlock: settings.showWhy && why ? `چرا مهم است: ${escapeMd(why)}` : "",
      entities: settings.showEntities ? escapeMd(entities) : "",
      entitiesBlock: settings.showEntities && entities ? `نهادها: ${escapeMd(entities)}` : "",
      sources: settings.showSources ? (otherSources.length ? `تأییدشده توسط ${Math.max(2, otherSources.length + 1).toLocaleString("fa-IR")} منبع: ${otherSources.join("، ")}` : item.corroborated ? "تأییدشده توسط چند منبع ✓" : "") : "",
      originalUrl: mdLink("لینک اصلی خبر", item.url),
      hashtags: escapeMd(item.hashtags ?? ""),
      importanceScore: item.importanceScore == null ? "—" : String(item.importanceScore),
    }) : defaultItem;
    // Keep the source link even when a custom item layout omits its placeholder.
    if (settings.itemTemplate.trim() && !settings.itemTemplate.includes("{originalUrl}")) customItem += `\n${mdLink("لینک اصلی خبر", item.url)}`;
    renderedItems.push(customItem);

  });

  if (!settings.template.trim() && !settings.itemTemplate.trim()) return lines.join("\n");
  return renderTemplate(settings.template.trim() || DEFAULT_BULLETIN_TEMPLATE, {
    title: escapeMd(settings.title), date: dateLabel,
    intro: settings.aiIntro ? escapeMd(introText) : "",
    items: renderedItems.join("\n\n"), count: String(items.length),
  });
}
