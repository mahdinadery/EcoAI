/**
 * AI Configuration Center — prompt construction (Milestone 5).
 *
 * Single reusable place where a stored/draft configuration is turned into the
 * text actually sent to the AI provider:
 *
 *   System Prompt + Enabled Analysis Features + Decision Rules + Output Schema
 *   + Article Content
 *
 * Both the production analysis pipeline (src/lib/news/analyze.ts) and the admin
 * "Test Configuration" panel call this same function, so there is exactly one
 * place that knows how a configuration becomes a prompt.
 */

import type {
  AiDecisionRules,
  AiFeaturesConfig,
  AiOutputSchema,
  AiTopicFilterConfig,
} from "./config-types";

/**
 * Who this product is for, and therefore what "relevant" means when the model
 * scores `relevance`. Used whenever the operator left `audienceFocus` empty.
 *
 * Deliberately self-contained in this module (see the note below) — the admin
 * console imports this constant for its placeholder text.
 */
export const DEFAULT_AUDIENCE_FOCUS =
  "مخاطب هدف این سامانه یک شرکت اعتبارسنجی است. «مرتبط بودن» فقط یعنی ارتباط مستقیم و روشن خبر با یکی از این حوزه‌ها: " +
  "اعتبارسنجی و رتبه‌بندی اعتباری، ریسک اعتباری و نکول، سلامت مالی و اعتباری بانک‌ها و شرکت‌ها، بازار بدهی و تأمین مالی، " +
  "و مقررات ناظر بر اعتبار و رتبه‌بندی در ایران.";

/** Hard relevance rules appended to every prompt after the audience focus. */
const AUDIENCE_RELEVANCE_RULES = [
  "قوانین قطعی امتیاز مرتبط بودن (relevance):",
  "- «مرتبط بودن» فقط ارتباط واقعی خبر با مخاطب و حوزه‌های بالا است؛ «مهم بودن» یا «اقتصادی بودن» خبر به‌تنهایی مرتبط بودن نیست.",
  "- تفکیک مفهومی واژهٔ «اعتبار»: هرگز «تخصیص اعتبار» از طرف دولت یا بودجه (مانند تخصیص اعتبار کالابرگ و یارانه، تخصیص اعتبار ساخت جاده و پل، پروژه‌های عمرانی، اعتبارات استانی و بودجهٔ دستگاه‌های اجرایی) را با «اعتبارسنجی و رتبه‌بندی اعتباری» معادل نگیر؛ واژهٔ «اعتبار» در این خبرها به معنی بودجه و ردیف مالی دولت است نه ارزیابی توان بازپرداخت یا رتبهٔ اعتباری، و این اخبار باید relevance زیر ۲۰ و shouldSend=false بگیرند.",
  "- هر خبری که پیوند روشنی با این حوزه‌ها ندارد (پروژه‌های شهری و عمرانی، مالیات‌ها و عوارض عمومی، قیمت و تورم روزمره، ورزش، سرگرمی، حوادث، و اخبار عمومی بین‌المللی بدون پیوند با اعتبارسنجی ایران) باید relevance زیر ۳۰ و shouldSend=false بگیرد، حتی اگر importance بالای ۸۰ باشد.",
];

/**
 * Prompt-side description of the operator's topic focus and deny-list.
 *
 * Deliberately self-contained (no imports besides the type above): the Node
 * test runner imports this module directly, so it must stay dependency-free at
 * runtime. Matching itself lives in src/lib/news/topic-filter.ts — callers pass
 * its BASELINE_BLOCKED_KEYWORDS in as `baselineBlocked` so the prompt copy and
 * the matching copy never drift.
 */
export function describeTopicFocus(
  filter: AiTopicFilterConfig | null | undefined,
  baselineBlocked: readonly string[] = [],
): string | null {
  const baseline = baselineBlocked.map((keyword) => keyword.trim()).filter(Boolean);
  const filterActive = Boolean(filter && filter.enabled);

  const topics = filterActive
    ? (filter!.topics ?? []).filter((topic) => topic.enabled && topic.keywords.some((keyword) => (keyword ?? "").trim()))
    : [];
  const blocked = filterActive ? (filter!.blockedKeywords ?? []).map((keyword) => (keyword ?? "").trim()).filter(Boolean) : [];

  if (topics.length === 0 && blocked.length === 0 && baseline.length === 0) return null;

  const lines: string[] = [];

  if (baseline.length > 0) {
    lines.push(
      "کلیدواژه‌های ممنوع همیشگی (هر خبری که این‌ها را داشته باشد نامرتبط است و باید relevance پایین و shouldSend=false بگیرد):",
      `- ${baseline.join("، ")}`,
    );
  }

  if (topics.length > 0) {
    lines.push(
      filter?.mode === "exclude"
        ? "موضوعاتی که باید نامرتبط تلقی شوند و امتیاز مرتبط بودن پایین بگیرند:"
        : "تمرکز موضوعی فعلی سامانه (فقط اخبار مرتبط با این موضوعات):",
    );
    for (const topic of topics) {
      const keywords = topic.keywords.map((keyword) => keyword.trim()).filter(Boolean).join("، ");
      lines.push(keywords ? `- ${topic.label.trim() || topic.id}: ${keywords}` : `- ${topic.label.trim() || topic.id}`);
    }
  }

  if (blocked.length > 0) {
    lines.push(
      "کلیدواژه‌های ممنوع (هر خبری که این‌ها را داشته باشد نامرتبط است و باید relevance پایین و shouldSend=false بگیرد):",
      `- ${blocked.join("، ")}`,
    );
  }

  return lines.join("\n");
}

export type PromptableConfig = {
  systemPrompt: string;
  /** Who the audience is + what "relevant" means. Empty/missing => DEFAULT_AUDIENCE_FOCUS. */
  audienceFocus?: string;
  features: AiFeaturesConfig;
  decisionRules: AiDecisionRules;
  outputSchema: AiOutputSchema;
  /** Optional topic focus — injected as context so relevance judgments align with it. */
  topicFilter?: AiTopicFilterConfig | null;
};

export type ArticleInput = {
  title: string;
  description: string | null;
  source: string;
  publishedAt: string | null;
};

function describeType(type: "string" | "number" | "boolean", min?: number, max?: number): string {
  if (type === "boolean") return "boolean (true|false)";
  if (type === "number") return `number${min !== undefined && max !== undefined ? ` (${min}-${max})` : ""}`;
  return "string";
}

/**
 * Builds the JSON-shape instructions the model must follow, from only the
 * fields that are simultaneously enabled as a feature AND enabled in the
 * output schema. Disabled fields are omitted entirely from the contract.
 */
function buildOutputContract(config: PromptableConfig): { template: string; enabledFields: string[] } {
  const lines: string[] = [];
  const enabledFields: string[] = [];

  // Iterating the schema (instead of a hard-coded key order) keeps the contract
  // in the order the administrator sees and avoids a runtime import here.
  for (const schemaField of config.outputSchema) {
    const feature = config.features[schemaField.name];
    if (!feature?.enabled || !schemaField.enabled) continue;

    enabledFields.push(schemaField.name);
    const typeHint = describeType(schemaField.type,
      Math.max(schemaField.min ?? 0, feature.scaleMin ?? 0),
      Math.min(schemaField.max ?? 100, feature.scaleMax ?? 100));
    const requiredHint = schemaField.required ? "الزامی" : "اختیاری";
    lines.push(`  "${schemaField.name}": ${typeHint} — ${requiredHint} — ${schemaField.description} — ${feature.instruction}`);
  }

  return { template: lines.join("\n"), enabledFields };
}

function buildDecisionRulesSection(config: PromptableConfig): string {
  const shouldSendEnabled = config.features.shouldSend?.enabled && config.decisionRules.enableAutoRecommendation;

  if (!shouldSendEnabled) {
    return "«shouldSend» را همیشه false و «reason» را با ذکر اینکه توصیه ارسال غیرفعال است، برگردان.";
  }

  const rules = config.decisionRules;
  const thresholds = [
    `- امتیاز اهمیت (importance) >= ${rules.minImportanceToSend}`,
    `- امتیاز مرتبط بودن (relevance) >= ${rules.minRelevanceToSend}`,
    rules.minNoveltyToSend > 0 ? `- امتیاز تازگی (novelty) >= ${rules.minNoveltyToSend}` : null,
  ].filter(Boolean) as string[];

  // "any" is the legacy OR behaviour (kept only for old saved configurations).
  // The default is "all": every threshold must pass, so a high importance score
  // can never make an off-topic article recommendable.
  if (rules.combine === "any") {
    return [
      "«shouldSend» را true قرار بده تنها اگر حداقل یکی از این شرایط برقرار باشد (منطق OR — سازگاری با تنظیمات قدیمی):",
      ...thresholds,
      `به‌عنوان راهنمای کلی، آستانه ترکیبی ارسال حدود ${rules.overallSendThreshold} از ۱۰۰ در نظر گرفته شود.`,
      "در غیر این صورت «shouldSend» را false بگذار و در «reason» توضیح کوتاه بده.",
    ].join("\n");
  }

  return [
    "«shouldSend» را true قرار بده تنها اگر همهٔ شرایط زیر هم‌زمان برقرار باشند (منطق AND):",
    ...thresholds,
    "مهم: اهمیت بالا هرگز جای مرتبط بودن پایین را نمی‌گیرد. خبری که به مخاطب هدف مربوط نیست، حتی اگر بسیار مهم باشد، باید relevance پایین و shouldSend=false بگیرد.",
    "اگر هر یک از شرایط بالا برقرار نباشد، «shouldSend» را false بگذار و در «reason» مشخص کن کدام شرط برقرار نشده است.",
  ].join("\n");
}

/**
 * Composes the final { systemPrompt, userPrompt } sent to the AI service.
 * This is the only function in the codebase that turns configuration data into
 * prompt text — keep all future prompt changes here.
 */
export function buildAIAnalysisPrompt(
  config: PromptableConfig,
  article: ArticleInput,
  options?: { baselineBlockedKeywords?: readonly string[] },
): { systemPrompt: string; userPrompt: string; enabledFields: string[] } {
  const { template, enabledFields } = buildOutputContract(config);
  const decisionSection = buildDecisionRulesSection(config);
  const topicSection = describeTopicFocus(config.topicFilter, options?.baselineBlockedKeywords);

  const audienceFocus = config.audienceFocus?.trim() || DEFAULT_AUDIENCE_FOCUS;
  const audienceSection = [`تعریف مخاطب و ملاک امتیاز مرتبط بودن (relevance):`, audienceFocus, ...AUDIENCE_RELEVANCE_RULES].join("\n");

  const systemPrompt = [
    config.systemPrompt.trim(),
    "",
    audienceSection,
    "",
    "دستورالعمل‌های تحلیل (فقط فیلدهای زیر را در خروجی بگنجان):",
    template,
    "",
    "قوانین راهنما برای تصمیم ارسال:",
    decisionSection,
    topicSection ? "" : null,
    topicSection,
    "",
    "پاسخ باید دقیقاً یک شیء JSON معتبر با همان کلیدهای بالا باشد؛ هیچ کلید یا متن اضافه‌ای اضافه نکن.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const userPrompt = [
    "لطفاً این مقاله را تحلیل کن:",
    `عنوان: ${article.title}`,
    `منبع: ${article.source}`,
    `تاریخ انتشار: ${article.publishedAt ?? "نامشخص"}`,
    `توضیحات/محتوا: ${article.description ?? "نامشخص"}`,
  ].join("\n");

  return { systemPrompt, userPrompt, enabledFields };
}
