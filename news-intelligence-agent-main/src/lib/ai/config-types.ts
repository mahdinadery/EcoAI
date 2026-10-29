/**
 * AI Configuration Center — shared types (Milestone 5+).
 *
 * These types describe *data*, never executable code: an administrator edits
 * these values from `/admin/ai-config`, but the prompt-building, AI call,
 * validation and persistence logic all stay in application code
 * (src/lib/ai/prompt-builder.ts, src/lib/ai/client.ts, src/lib/ai/config-service.ts).
 */

/**
 * One feature = one field the AI is asked to produce. The `name` doubles as the
 * literal JSON key the AI must return and the key consumed by the analyze
 * pipeline (src/lib/news/analyze.ts).
 */
export type AiFeatureKey =
  | "translatedTitle"
  | "summary"
  | "category"
  | "importance"
  | "relevance"
  | "novelty"
  | "mainEvent"
  | "whyItMatters"
  | "hashtags"
  | "entities"
  | "shouldSend"
  | "reason";

export type AiFeatureConfig = {
  enabled: boolean;
  instruction: string;
  /** Only meaningful for 0-100 score features (importance/relevance/novelty). */
  scaleMin?: number;
  scaleMax?: number;
};

export type AiFeaturesConfig = Record<AiFeatureKey, AiFeatureConfig>;

/**
 * Guidance handed to the AI for its own `shouldSend` recommendation.
 *
 * This is intentionally separate from the Agent's auto-delivery rule
 * (src/lib/agent/rules.ts, AUTO_SEND_* env vars), which decides whether an
 * ALREADY analyzed article is actually delivered. This section only shapes what
 * the AI *recommends* — it never sends anything.
 */
export type AiDecisionRules = {
  bulletin?: Partial<import("../delivery/bulletin").BulletinSettings>;
  /** Missing preserves the environment fallback; explicit false disables shadow. */
  shadowEvaluationEnabled?: boolean;
  shadowMinImportance?: number;
  freshHours?: number;
  recentHours?: number;
  graderEnabled?: boolean;
  graderMin?: number;
  graderMax?: number;
  minImportanceToSend: number;
  minRelevanceToSend: number;
  minNoveltyToSend: number;
  /**
   * How the score minimums combine when the model decides `shouldSend`:
   *  - "all" (default, recommended): AND — every enabled minimum must be met.
   *    A high importance score can never compensate for low relevance.
   *  - "any": legacy OR behaviour (any one minimum is enough).
   * Missing values read as "all".
   */
  combine?: "all" | "any";
  /**
   * Legacy convenience threshold used only in "any" mode. Unused in "all" mode.
   */
  overallSendThreshold: number;
  /** When false, the AI is instructed to always return shouldSend=false and skip the recommendation. */
  enableAutoRecommendation: boolean;
};

export type AiOutputFieldType = "string" | "number" | "boolean";

export type AiOutputFieldSchema = {
  /** Must match an AiFeatureKey; kept as a plain string so stored JSON stays simple. */
  name: AiFeatureKey;
  enabled: boolean;
  description: string;
  required: boolean;
  type: AiOutputFieldType;
  min?: number;
  max?: number;
};

export type AiOutputSchema = AiOutputFieldSchema[];

export type AiProvider = "openai-compatible";

/**
 * Topic / relevance filter (dashboard-configurable, no code changes needed).
 *
 * Deliberately CHEAP rule-based matching (keywords, not an LLM call): it runs
 * BEFORE the expensive AI analysis stage, so off-topic articles never reach the
 * model. Fails open by design — when disabled (or no effective keywords exist),
 * every article passes, so a misconfigured filter can never lose important news.
 */
export type AiTopicRule = {
  /** Stable client-generated id (UI list keys / edit identity). */
  id: string;
  /** Human-readable Persian label, e.g. «سیاست پولی و بانک‌های مرکزی». */
  label: string;
  enabled: boolean;
  /** Matched against title+description+content (normalized). ANY keyword hits => topic matches. */
  keywords: string[];
};

export type AiTopicFilterMode = "include" | "exclude";

export type AiTopicFilterConfig = {
  /** Missing uses built-in defaults; [] explicitly disables baseline keywords. */
  baselineBlockedKeywords?: string[];
  /** Master switch. false => filter inactive, everything passes. */
  enabled: boolean;
  /**
   * include (focus mode): an article must match at least one enabled topic.
   * exclude (noise mode): an article is dropped when it matches any enabled topic.
   */
  mode: AiTopicFilterMode;
  topics: AiTopicRule[];
  /**
   * Hard deny-list that applies in BOTH modes: an article containing any of
   * these keywords is dropped before the AI stage, even when it also matches an
   * included topic.
   */
  blockedKeywords?: string[];
};

/**
 * Agent auto-delivery policy ("conditions for sending to Bale").
 *
 * Kept conceptually separate from AiDecisionRules (which only shapes the AI's
 * shouldSend recommendation). `useCustom: false` (default) preserves the
 * historical behavior exactly: the AUTO_SEND_* environment variables decide.
 */
export type AiAutoSendPolicy = {
  useCustom: boolean;
  enabled: boolean;
  destination: "local" | "bale" | "both";
  minImportance: number;
  minRelevance: number;
  minNovelty: number;
  requireAiRecommendation: boolean;
  /** Persian categories allow-list; null/empty => all categories. */
  categories: string[] | null;
  maxItemsPerPass: number;
};

/** The fully-resolved configuration used to build a prompt and call the AI service. */
export type ActiveAiConfig = {
  id: string;
  name: string;
  provider: AiProvider;
  /** Empty string => caller must fall back to AI_API_MODEL / AI_MODEL / built-in default. */
  model: string;
  systemPrompt: string;
  /** Audience/relevance anchor. Empty string => built-in analytical-economics default. */
  audienceFocus: string;
  temperature: number;
  maxTokens: number;
  features: AiFeaturesConfig;
  decisionRules: AiDecisionRules;
  outputSchema: AiOutputSchema;
  /**
   * Milestone 8 — publishing format for the delivery artifact. Kept on the
   * configuration so template changes are versioned like prompt changes.
   * Empty string means "use the built-in layout" (backward compatible).
   */
  publishingTemplate: string;
  /** Pre-AI topic/relevance gate (versioned with the rest of the configuration). */
  topicFilter: AiTopicFilterConfig;
  /** Agent auto-delivery policy (dashboard override of the AUTO_SEND_* env rule). */
  autoSendPolicy: AiAutoSendPolicy;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

/** Input shape accepted from the admin UI when saving a new configuration version. */
export type AiConfigInput = {
  name: string;
  provider: AiProvider;
  model: string;
  systemPrompt: string;
  /**
   * Who the audience is + what "relevant" means when the AI scores `relevance`.
   * Empty/missing => the built-in analytical-economics audience definition.
   */
  audienceFocus?: string;
  temperature: number;
  maxTokens: number;
  features: AiFeaturesConfig;
  decisionRules: AiDecisionRules;
  outputSchema: AiOutputSchema;
  /** Milestone 8 — publishing format. Empty string => built-in layout. */
  publishingTemplate: string;
  /** Topic/relevance gate. Omitted => DEFAULT_TOPIC_FILTER (inactive, fails open). */
  topicFilter?: AiTopicFilterConfig;
  /** Auto-delivery policy. Omitted => DEFAULT_AUTO_SEND_POLICY (env-driven). */
  autoSendPolicy?: AiAutoSendPolicy;
};

export const AI_FEATURE_ORDER: AiFeatureKey[] = [
  "translatedTitle",
  "summary",
  "category",
  "importance",
  "relevance",
  "novelty",
  "mainEvent",
  "whyItMatters",
  "hashtags",
  "entities",
  "shouldSend",
  "reason",
];

export const AI_FEATURE_LABELS: Record<AiFeatureKey, string> = {
  translatedTitle: "ترجمه فارسی عنوان",
  summary: "خلاصه و ترجمه تحلیلی",
  category: "دسته‌بندی اقتصادی",
  importance: "امتیاز اهمیت",
  relevance: "امتیاز مرتبط بودن",
  novelty: "امتیاز تازگی",
  mainEvent: "محور اصلی مقاله",
  whyItMatters: "چرا مهم است",
  hashtags: "هشتگ‌ها",
  entities: "نهادها و سازمان‌ها",
  shouldSend: "پیشنهاد ارسال",
  reason: "دلیل تصمیم ارسال",
};

/**
 * The legacy `whyItMatters` instruction told the model to answer the canned
 * phrase «برای مخاطب هدف اهمیت مشخصی ندارد» when unsure — kept verbatim so
 * stored configurations that still carry it are detected and upgraded on read.
 */
export const LEGACY_WHY_IT_MATTERS_INSTRUCTION =
  "در یک جمله کوتاه فارسی بگو این خبر چرا برای مخاطب هدف (طبق بخش «تعریف مخاطب و ملاک امتیاز مرتبط بودن») مهم است. اگر خبر برای مخاطب مهم نیست، بنویس «برای مخاطب هدف اهمیت مشخصی ندارد».";

/**
 * Default `whyItMatters` instruction for analytical economics: always demand a
 * concrete economic transmission channel, never a canned "doesn't matter" filler.
 */
export const WHY_IT_MATTERS_DEFAULT_INSTRUCTION =
  "در یک تا دو جملهٔ کوتاه و مشخص فارسی بگو این مقاله یا تحلیل اقتصادی چرا برای مخاطب هدف (طبق بخش «تعریف مخاطب و ملاک امتیاز مرتبط بودن») مهم است و به کانال اثرگذاری اقتصادی آن اشاره کن (مثلاً سیاست پولی و نرخ بهره، تورم، رشد اقتصادی، تجارت جهانی، بدهی دولت، بازار کار یا ثبات مالی). هرگز جمله‌های بی‌محتوا یا منفی مانند «برای مخاطب هدف اهمیت مشخصی ندارد» یا «مهم نیست» ننویس؛ حتی برای مباحث نظری، زنجیرهٔ اثر سیاستی یا بازاری را روشن شرح بده.";

/**
 * Rewrites ONLY an untouched legacy instruction to the fixed default; any
 * operator-customized text is preserved as-is.
 */
export function upgradeLegacyWhyItMattersInstruction(instruction: string): string {
  return instruction.trim() === LEGACY_WHY_IT_MATTERS_INSTRUCTION
    ? WHY_IT_MATTERS_DEFAULT_INSTRUCTION
    : instruction;
}

export const DEFAULT_SYSTEM_PROMPT = `شما یک تحلیلگر ارشد اقتصادی و مترجم تخصصی مقالات و پژوهش‌های اقتصادی انگلیسی به فارسی هستید. وظیفهٔ شما مطالعهٔ دقیق مقاله یا گزارش اقتصادی ارائه‌شده (به زبان انگلیسی)، استخراج تز اصلی، استدلال اقتصادی، داده‌ها و پیامدهای سیاستی/بازاری آن، و تولید یک پاسخ ساختاریافته JSON دقیق به زبان فارسی روان و علمی است.

اصول الزامی ترجمه و خلاصه‌سازی:
- عنوان انگلیسی مقاله را در فیلد «translatedTitle» به فارسی دقیق، سلیس و حرفه‌ای ترجمه کن و از ترجمهٔ تحت‌اللفظی و ماشینی پرهیز کن.
- در فیلد «summary» خلاصه‌ای عمیق، منسجم و تحلیلی به فارسی روان بنویس که پرسش اصلی مقاله، سازوکار یا استدلال اقتصادی نویسنده، شواهد/آمارهای کلیدی ذکرشده در متن و نتیجه‌گیری نهایی را به‌روشنی منتقل کند.
- اصطلاحات تخصصی اقتصاد را به معادل‌های استاندارد فارسی برگردان و تنها در صورت کمک به دقت علمی، نام اختصاری نهادها یا شاخص‌های شناخته‌شده (مانند IMF، Fed، ECB، GDP) را ذکر کن.
- هرگز واقعیت، عدد، تاریخ یا ادعایی که در متن ورودی نیامده را حدس نزن یا اختراع نکن. اگر متن دریافتی صرفاً یک چکیدهٔ کوتاه است، تحلیل و خلاصه را محافظه‌کارانه و صرفاً بر پایهٔ همان متن بنویس.

پاسخ باید دقیقاً و فقط یک شیء JSON معتبر باشد؛ هیچ متن یا توضیح اضافه‌ای خارج از آن ننویس.`;

export const DEFAULT_FEATURES: AiFeaturesConfig = {
  translatedTitle: {
    enabled: true,
    instruction:
      "عنوان انگلیسی مقاله را به فارسی دقیق، روان و حرفه‌ای ترجمه کن (حداکثر ۲۲ کلمه، بدون علامت نقل‌قول اضافی در ابتدا و انتها).",
  },
  summary: {
    enabled: true,
    instruction:
      "یک خلاصه و ترجمهٔ تحلیلی، دقیق و خوش‌خوان به زبان فارسی روان از مقاله بنویس (۷۰ تا ۱۶۰ کلمه) که مسئلهٔ محوری، استدلال اقتصادی، شواهد کلیدی و جمع‌بندی نویسنده را پوشش دهد.",
  },
  category: {
    enabled: true,
    instruction:
      "مناسب‌ترین دسته‌بندی تخصصی اقتصادی را به فارسی انتخاب کن (مثلاً: سیاست پولی و بانک مرکزی، اقتصاد کلان، تجارت جهانی و ژئواکونومیک، بازارهای مالی، انرژی و کالا، اقتصاد توسعه، فناوری و بازار کار، اقتصاد سیاسی).",
  },
  importance: {
    enabled: true,
    instruction:
      "اهمیت علمی، سیاستی یا بازاری این مقاله و عمق استدلال اقتصادی آن را ارزیابی کن.",
    scaleMin: 0,
    scaleMax: 100,
  },
  relevance: {
    enabled: true,
    instruction:
      "میزان مرتبط بودن این مطلب با حوزهٔ مقالات تحلیلی اقتصادی، اقتصاد کلان، سیاست‌گذاری و بازارهای جهانی (طبق بخش «تعریف مخاطب و ملاک امتیاز مرتبط بودن») را ارزیابی کن. مطالب غیرمرتبط با اقتصاد (ورزشی، سرگرمی، سلبریتی، حوادث یا تبلیغات تجاری) باید امتیاز زیر ۲۰ بگیرند.",
    scaleMin: 0,
    scaleMax: 100,
  },
  novelty: {
    enabled: true,
    instruction:
      "میزان تازگی دیدگاه تحلیلی، یافته‌های پژوهشی یا داده‌های ارائه‌شده در مقاله را نسبت به خبرهای تکراری روزمره ارزیابی کن.",
    scaleMin: 0,
    scaleMax: 100,
  },
  mainEvent: {
    enabled: true,
    instruction:
      "تز اصلی، یافتهٔ کلیدی یا پیام محوری مقاله را در یک جملهٔ کوتاه و دقیق فارسی مشخص کن.",
  },
  whyItMatters: {
    enabled: true,
    instruction: WHY_IT_MATTERS_DEFAULT_INSTRUCTION,
  },
  hashtags: {
    enabled: true,
    instruction:
      "سه تا پنج هشتگ فارسی تخصصی و مرتبط با موضوع اقتصادی مقاله را در فیلد hashtags به صورت یک رشته با فاصله جدا کن؛ مثال: #اقتصاد_کلان #سیاست_پولی #تجارت_جهانی. هشتگ را داخل خلاصه ننویس و بک‌اسلش اضافه نکن.",
  },
  entities: {
    enabled: true,
    instruction:
      "نام بانک‌های مرکزی، نهادهای بین‌المللی (مانند صندوق بین‌المللی پول، فدرال رزرو، بانک جهانی، بانک مرکزی اروپا)، کشورها یا سازمان‌های مهم مطرح در مقاله را به فارسی در آرایهٔ entities بیاور (حداکثر ۱۰ مورد). اگر نام مشخصی نیست، آرایهٔ خالی بده.",
  },
  shouldSend: {
    enabled: true,
    instruction:
      "مشخص کن که آیا ترجمه و خلاصهٔ این مقاله ارزش علمی/تحلیلی کافی برای ارسال به کانال اقتصادی در پیام‌رسان «بله» را دارد یا نه.",
  },
  reason: {
    enabled: true,
    instruction:
      "توضیح کوتاهی به فارسی (۱۵ تا ۳۰ کلمه) برای دلیل پیشنهاد ارسال یا عدم ارسال ارائه بده.",
  },
};

/** Default decision rules: AND semantics (importance >= 65 AND relevance >= 70). */
export const DEFAULT_DECISION_RULES: AiDecisionRules = {
  minImportanceToSend: 65,
  minRelevanceToSend: 70,
  minNoveltyToSend: 0,
  combine: "all",
  overallSendThreshold: 70,
  enableAutoRecommendation: true,
};

export const DEFAULT_OUTPUT_SCHEMA: AiOutputSchema = [
  { name: "translatedTitle", enabled: true, description: "ترجمه فارسی عنوان مقاله", required: true, type: "string" },
  { name: "summary", enabled: true, description: "خلاصه و ترجمه تحلیلی فارسی مقاله", required: true, type: "string" },
  { name: "category", enabled: true, description: "دسته‌بندی تخصصی اقتصادی (فارسی)", required: true, type: "string" },
  { name: "importance", enabled: true, description: "امتیاز اهمیت علمی/اقتصادی", required: true, type: "number", min: 0, max: 100 },
  { name: "relevance", enabled: true, description: "امتیاز مرتبط بودن با اقتصاد تحلیلی", required: true, type: "number", min: 0, max: 100 },
  { name: "novelty", enabled: true, description: "امتیاز تازگی دیدگاه/یافته‌ها", required: true, type: "number", min: 0, max: 100 },
  { name: "mainEvent", enabled: true, description: "تز یا محور اصلی مقاله (فارسی)", required: false, type: "string" },
  { name: "whyItMatters", enabled: true, description: "چرا از نظر اقتصادی مهم است", required: false, type: "string" },
  { name: "hashtags", enabled: true, description: "هشتگ‌های فارسی مستقل؛ جداشده با فاصله، مانند #اقتصاد_کلان #سیاست_پولی", required: false, type: "string" },
  { name: "entities", enabled: true, description: "نهادها، بانک‌های مرکزی و سازمان‌های مهم مقاله (فارسی، آرایه‌ای)", required: false, type: "string" },
  { name: "shouldSend", enabled: true, description: "پیشنهاد ارسال به بله", required: true, type: "boolean" },
  { name: "reason", enabled: true, description: "دلیل تصمیم ارسال", required: true, type: "string" },
];

/**
 * Default publishing layout for Bale: bilingual title (Persian + original
 * English headline) followed by fluent Persian analytical summary, economic
 * significance, core thesis, score, source link, and Persian hashtags.
 */
export const DEFAULT_PUBLISHING_TEMPLATE = `📰 {category}

{bilingualTitle}

{summary}

چرا مهم است:
{whyItMatters}

محور اصلی مقاله:
{mainEvent}

اهمیت: {importanceScore} از ۱۰۰

{originalUrl}

{hashtags}`;

/**
 * Footer migration for stored publishing templates: the old default footer
 * «منبع: {sourceName}» + «{originalUrl}» becomes just «{originalUrl}» — which
 * renders as the hyperlinked «لینک اصلی خبر». Only the exact legacy pair is
 * rewritten; every other operator-authored line is preserved as-is.
 */
const LEGACY_TEMPLATE_FOOTER = /منبع:[ \t]*\{sourceName\}[ \t]*\r?\n[ \t]*\{originalUrl\}/g;

export function upgradeLegacyTemplateFooter(template: string): string {
  return template.replace(LEGACY_TEMPLATE_FOOTER, "{originalUrl}");
}

export const DEFAULT_CONFIG_NAME = "پیکربندی مقالات اقتصادی انگلیسی (پیش‌فرض)";
export const DEFAULT_MODEL_PLACEHOLDER = ""; // empty => env AI_API_MODEL / AI_MODEL / built-in fallback

/**
 * Default topic filter — INACTIVE and failing open: existing installations keep
 * ingesting and analyzing everything until an admin enables topics or applies
 * the English Economics Pack from the dashboard.
 */
export const DEFAULT_TOPIC_FILTER: AiTopicFilterConfig = {
  enabled: false,
  mode: "include",
  topics: [],
  blockedKeywords: [],
};

/**
 * Default auto-send policy — `useCustom: false` so the AUTO_SEND_* environment
 * variables keep deciding unless customized in the dashboard.
 */
export const DEFAULT_AUTO_SEND_POLICY: AiAutoSendPolicy = {
  useCustom: false,
  enabled: true,
  destination: "local",
  minImportance: 60,
  minRelevance: 65,
  minNovelty: 0,
  requireAiRecommendation: false,
  categories: null,
  maxItemsPerPass: 20,
};
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_TOKENS = 3500;
