import type { NewsRow } from "@/db/schema";

/**
 * Renders the Persian/bilingual message shared by every delivery provider.
 *
 * Both Local and Bale receive EXACTLY this text, so Local stays a faithful
 * rehearsal of a real Bale delivery. When an article carries an AI-translated
 * Persian headline (`translatedTitle`), the message renders a clean bilingual
 * header (Persian title on top + original English title below for terminology
 * precision). Single-language articles without `translatedTitle` render once.
 *
 * Kept free of runtime relative imports because this module is imported
 * directly by Node's native test runner (`node --test`).
 */

const MAX_SUMMARY_LENGTH = 1500;

/**
 * Markdown hyperlink helpers (Bale renders `parse_mode: "Markdown"`). The
 * footer label is the hyperlink to the ORIGINAL source URL — no short links.
 */
export function escapeMd(text: string): string {
  return text
    .split(/(#[\p{L}\p{N}_\\\u200c]+)/gu)
    .map((part, index) =>
      index % 2 ? part.replace(/\\_/g, "_").replace(/\\/g, "") : part.replace(/([\\_*\[\]`])/g, "\\$1"),
    )
    .join("");
}

export function mdLink(text: string, url: string): string {
  const safeUrl = url.replace(/[() ]/g, (char) => (char === " " ? "%20" : char === "(" ? "%28" : "%29"));
  return `[${escapeMd(text)}](${safeUrl})`;
}

/**
 * Display-layer noise filter for rows analyzed before the prompt fix (the
 * legacy prompt produced «برای مخاطب هدف اهمیت مشخصی ندارد» as filler).
 */
const WHY_NOISE =
  /اهمیت مشخصی ندارد|اهمیت (خاص|چندان)ی ندارد|مهم نیست|بدون (اهمیت|ربط)|^[-—–]\s*$|^ندارد\s*[.،]?$/;

function usefulWhy(value: string | null | undefined): string {
  const raw = (value ?? "").replace(/\s+/g, " ").trim();
  return raw.length >= 12 && !WHY_NOISE.test(raw) ? raw : "";
}

/**
 * Drops «label:» lines whose value line is empty or «—» — optional AI fields
 * (whyItMatters, mainEvent) would otherwise leave a dangling label in
 * template-rendered messages.
 */
export function stripEmptyLabelBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const isLabel = trimmed.length > 0 && trimmed.length <= 60 && /[:：]$/.test(trimmed);
    const nextLine = lines[i + 1];
    const nextTrimmed = nextLine === undefined ? undefined : nextLine.trim();
    const nextIsEmpty = nextTrimmed === undefined || nextTrimmed === "" || nextTrimmed === "—";
    if (isLabel && nextIsEmpty) {
      if (nextTrimmed === "" || nextTrimmed === "—") i += 1;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function compact(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "—";
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function compactMultiline(value: string | null | undefined, limit: number): string {
  const text = (value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return "—";
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/**
 * An emoji-led section label: `❓ پرسش پژوهش:`, `📈 نتایج:`, `🧭 توصیهٔ سیاستی:` …
 *
 * The colon is part of the signature on purpose. Requiring it means an emoji used
 * *inside* a sentence («… با یک 📊 داخل جمله …») is never treated as a section
 * start, so the normalizer splits real labels only — including custom labels an
 * operator defines in the prompt, which is why no fixed marker list is needed.
 */
const SUMMARY_SECTION_HEAD = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?[^\n]{0,28}?[:：]/gu;

/**
 * Puts exactly one blank line between the labeled sections of an AI summary.
 *
 * The prompt asks for «هر بخش در سطر جدا», but models routinely return the
 * sections glued into one paragraph or stacked on consecutive single lines —
 * which reads as a wall of text while every other block of the message has clean
 * breathing room. Fixing it here (not only in the prompt) means articles analyzed
 * before the prompt change render correctly too, and no delivery depends on the
 * model having obeyed.
 *
 * Deliberately narrow so nothing else changes:
 *   · a cut happens only before a section head that starts the text or follows
 *     whitespace;
 *   · fewer than two sections => text returned as-is, so a plain one-paragraph
 *     summary is never split mid-sentence;
 *   · the separator is always exactly one blank line, so re-running is a no-op;
 *   · no word, link or character of content is added, removed or reordered.
 */
export function separateSummarySections(value: string | null | undefined): string {
  const text = (value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
  if (!text) return "";

  const starts: number[] = [];
  let consumedUntil = -1;
  for (const match of text.matchAll(SUMMARY_SECTION_HEAD)) {
    const index = match.index ?? 0;
    const before = index === 0 ? "\n" : text[index - 1]!;
    // `consumedUntil` skips a head that overlaps the previous match (the lazy
    // label quantifier can end inside it). Several heads on the SAME line are all
    // kept — that glued-paragraph case is exactly what this function exists for.
    if (/\s/.test(before) && index >= consumedUntil) {
      starts.push(index);
      consumedUntil = index + match[0].length;
    }
  }

  const cuts = starts.filter((index) => index > 0);
  if (cuts.length === 0) return text;

  const parts: string[] = [text.slice(0, cuts[0]!).trim()];
  for (let i = 0; i < cuts.length; i += 1) {
    const to = i + 1 < cuts.length ? cuts[i + 1]! : text.length;
    const part = text.slice(cuts[i]!, to).trim();
    if (part) parts.push(part);
  }

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Strips any legacy leading Iran-flag prefix (`\u{1F1EE}\u{1F1F7}`) from
 * pre-existing rendered messages stored in `deliveries` / outbox.
 */
export function stripLegacyTitleFlag(text: string): string {
  return text.replace(/^\u{1F1EE}\u{1F1F7}[ \t]*/gmu, "");
}

/**
 * Renders a bilingual header (Persian translated title + original English
 * title) when `translatedTitle` is present and distinct from `title`. Falls
 * back to the single plain `title` when `translatedTitle` is absent/identical.
 */
export function formatBilingualTitle(
  originalTitle: string | null | undefined,
  translatedTitle?: string | null,
  limit = 300,
): string {
  const origClean = (originalTitle ?? "").replace(/\s+/g, " ").trim();
  const transClean = (translatedTitle ?? "").replace(/\s+/g, " ").trim();

  if (transClean && origClean && transClean.toLowerCase() !== origClean.toLowerCase()) {
    return `${escapeMd(compact(transClean, limit))}\n🌐 ${escapeMd(compact(origClean, limit))}`;
  }

  return escapeMd(compact(transClean || origClean, limit));
}

function formatImportance(score: number | null): string {
  if (score === null || Number.isNaN(score)) return "ثبت نشده";
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const label = clamped >= 70 ? "بالا" : clamped >= 40 ? "متوسط" : "پایین";
  return `${clamped} از ۱۰۰ (${label})`;
}

/**
 * Optional Phase 3 extras (corroboration / entities / related stories) — the
 * caller resolves them from the DB; this function stays pure and testable.
 */
export type MessageExtras = {
  /** Every source carrying this event (multi-source confirmation) — with links. */
  corroborationItems?: Array<{ source: string; url: string }>;
  /** Persian entity names (institutions/banks/countries) from the AI output. */
  entityTags?: string[];
  /** Titles of previously delivered related stories (follow-ups). */
  relatedTitles?: string[];
};

export function buildNewsMessage(
  article: Pick<NewsRow, "title" | "summary" | "category" | "importanceScore" | "url"> &
    Partial<Pick<NewsRow, "translatedTitle" | "whyItMatters" | "entityTags" | "source" | "hashtags">>,
  extras: MessageExtras = {},
): string {
  const why = usefulWhy(article.whyItMatters);
  const entities = (extras.entityTags ?? article.entityTags ?? []).slice(0, 6).join("، ");
  const related = (extras.relatedTitles ?? []).slice(0, 2);

  // Multi-source: ONE chosen story, every outlet listed underneath with its
  // link (the chosen copy first). Single-source keeps the classic one-liner.
  const others = (extras.corroborationItems ?? []).slice(0, 4);
  const mainLink = mdLink("لینک اصلی خبر", article.url);
  const sourcesBlock =
    others.length > 0
      ? [
          "",
          `منابع این خبر (${(others.length + 1).toLocaleString("fa-IR")}):`,
          `• ${mdLink(`${compact(article.source, 60)} (انتخاب‌شده)`, article.url)}`,
          ...others.map((item) => `• ${mdLink(compact(item.source, 60), item.url)}`),
          "",
          mainLink,
        ]
      : ["", mainLink];

  return [
    "📰 عنوان خبر",
    "",
    formatBilingualTitle(article.title, article.translatedTitle, 300),
    "",
    "خلاصه:",
    escapeMd(compactMultiline(separateSummarySections(article.summary), MAX_SUMMARY_LENGTH)),
    ...(why ? ["", "چرا مهم است:", escapeMd(compact(why, 280))] : []),
    ...(entities ? ["", "نهادها:", escapeMd(entities)] : []),
    ...related.flatMap((title) => ["", "مرتبط با:", escapeMd(compact(title, 160))]),
    "",
    "دسته:",
    escapeMd(compact(article.category, 60)),
    "",
    "اهمیت:",
    formatImportance(article.importanceScore),
    ...sourcesBlock,
    ...(article.hashtags ? ["", escapeMd(article.hashtags)] : []),
  ].join("\n");
}
