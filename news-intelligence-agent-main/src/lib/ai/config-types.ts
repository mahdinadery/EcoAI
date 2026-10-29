/**
 * AI Configuration Center — shared types (Milestone 5).
 *
 * These types describe *data*, never executable code: an administrator edits
 * these values from `/admin/ai-config`, but the prompt-building, AI call,
 * validation and persistence logic all stay in application code
 * (src/lib/ai/prompt-builder.ts, src/lib/ai/client.ts, src/lib/ai/config-service.ts).
 */

/**
 * One feature = one field the AI is asked to produce. The `name` doubles as the
 * literal JSON key the AI must return and the key already consumed by the
 * existing analyze pipeline (src/lib/news/analyze.ts) — keeping these names
 * unchanged from Milestone 4 is what keeps analysis backward compatible.
 */
export type AiFeatureKey =
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
 * the AI *recommends* — it never sends anything (Milestone 5 scope).
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
   *  - "any": legacy OR behaviour (any one minimum is enough). Kept only for
   *    backward compatibility with configurations saved before the fix; it is
   *    the reason off-topic-but-important articles used to be recommended.
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
  /** Human-readable Persian label, e.g. «بازار خودرو». */
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
   * included topic. This is the "these kinds of news must never be sent" switch
   * (sports, celebrity news, daily prices, ...). Optional/empty => no
   * operator deny-list. NOTE: a small BASELINE_BLOCKED_KEYWORDS list in
   * topic-filter.ts always applies on top of this, even when the filter is
   * disabled entirely.
   */
  blockedKeywords?: string[];
};

/**
 * Agent auto-delivery policy ("conditions for sending to Bale").
 *
 * Kept conceptually separate from AiDecisionRules (which only shapes the AI's
 * shouldSend recommendation). `useCustom: false` (default) preserves the
 * historical behavior exactly: the AUTO_SEND_* environment variables decide.
 * When `useCustom: true`, the values below are authoritative — so the operator
 * can retune delivery from the dashboard without touching code or env files.
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
  /** Audience/relevance anchor. Empty string => built-in credit-rating default. */
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
   * Empty/missing => the built-in credit-rating audience definition (see
   * DEFAULT_AUDIENCE_FOCUS in prompt-builder.ts, which also hard-wires the
   * "unrelated news gets relevance < 30" rules into every prompt).
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
  summary: "خلاصه",
  category: "دسته‌بندی",
  importance: "امتیاز اهمیت",
  relevance: "امتیاز مرتبط بودن",
  novelty: "امتیاز تازگی",
  mainEvent: "رویداد اصلی",
  whyItMatters: "چرا مهم است",
  hashtags: "هشتگ‌ها",
  entities: "نهادها و سازمان‌ها",
  shouldSend: "پیشنهاد ارسال",
  reason: "دلیل ارسال",
};

/**
 * Default configuration — migrates the exact behavior that was previously
 * hard-coded in src/lib/ai/client.ts (Milestone 4) into editable data. Values
 * here must reproduce the same prompt intent so existing AI analysis keeps
 * working unchanged for anyone who has not touched the admin UI yet.
 */
/**
 * The legacy `whyItMatters` instruction told the model to answer the canned
 * phrase «برای مخاطب هدف اهمیت مشخصی ندارد» when unsure — which then shipped
 * to the channel even for highly-rated stories. Kept verbatim so stored
 * configurations that still carry it are detected and upgraded on read.
 */
export const LEGACY_WHY_IT_MATTERS_INSTRUCTION =
  "در یک جمله کوتاه فارسی بگو این خبر چرا برای مخاطب هدف (طبق بخش «تعریف مخاطب و ملاک امتیاز مرتبط بودن») مهم است. اگر خبر برای مخاطب مهم نیست، بنویس «برای مخاطب هدف اهمیت مشخصی ندارد».";

/**
 * Replacement instruction: always demand a CONCRETE reason tied to the
 * audience, never a canned "doesn't matter" filler — including for indirect
 * macro channels.
 */
export const WHY_IT_MATTERS_DEFAULT_INSTRUCTION =
  "در یک جمله کوتاه و مشخص فارسی بگو این خبر چرا برای مخاطب هدف (طبق بخش «تعریف مخاطب و ملاک امتیاز مرتبط بودن») مهم است و به کانال اثرگذاری آن اشاره کن (مثلاً نقدینگی و تأمین مالی بانک‌ها، ریسک اعتباری مشتریان، کیفیت دارایی، هزینهٔ سرمایه، رتبه‌بندی اعتباری یا شاخص‌های کلان اقتصادی). هرگز جمله‌های بی‌محتوا یا منفی مانند «برای مخاطب هدف اهمیت مشخصی ندارد» یا «مهم نیست» ننویس؛ حتی اگر پیوند مستقیم نمی‌بینی، زنجیرهٔ اثر غیرمستقیم (مثلاً اثر شاخص‌های کلان بر ترازنامهٔ بانک‌ها) را در همان یک جمله شرح بده.";

/**
 * Rewrites ONLY an untouched legacy instruction to the fixed default; any
 * operator-customized text is preserved as-is.
 */
export function upgradeLegacyWhyItMattersInstruction(instruction: string): string {
  return instruction.trim() === LEGACY_WHY_IT_MATTERS_INSTRUCTION
    ? WHY_IT_MATTERS_DEFAULT_INSTRUCTION
    : instruction;
}

export const DEFAULT_SYSTEM_PROMPT = `شما یک تحلیلگر خبری حرفه‌ای (News Analyst Agent) هستید. وظیفه شما تحلیل مقاله خبری ارائه‌شده و تولید یک پاسخ ساختاریافته JSON دقیق است.

هرگز واقعیت، عدد یا ادعایی که در عنوان یا توضیحات مقاله نیامده را حدس نزن یا اختراع نکن. اگر اطلاعات ناکافی است، مقادیر را محافظه‌کارانه در نظر بگیر و این کمبود اطلاعات را به‌صراحت در خلاصه و دلیل ذکر کن.

پاسخ باید دقیقاً و فقط یک شیء JSON باشد؛ هیچ متن یا توضیح اضافه‌ای خارج از آن ننویس.`;

export const DEFAULT_FEATURES: AiFeaturesConfig = {
  summary: {
    enabled: true,
    instruction: "یک خلاصه دقیق، باکیفیت و حرفه‌ای به زبان فارسی روان از مقاله بنویس (۳۰ تا ۸۰ کلمه).",
  },
  category: {
    enabled: true,
    instruction:
      "مناسب‌ترین دسته‌بندی فارسی را برای این مقاله انتخاب کن (مثلاً: اقتصاد، سیاست، فناوری، کسب‌وکار، بازار، جامعه، بین‌الملل، سایر).",
  },
  importance: {
    enabled: true,
    instruction: "اهمیت این خبر را برای عموم مردم یا بخش‌های کسب‌وکار ارزیابی کن.",
    scaleMin: 0,
    scaleMax: 100,
  },
  relevance: {
    enabled: true,
    instruction:
      "میزان مرتبط بودن این خبر با مخاطب هدف (طبق بخش «تعریف مخاطب و ملاک امتیاز مرتبط بودن») را ارزیابی کن. اخباری که با آن تعریف پیوند روشنی ندارند یا صرفاً دربارهٔ «تخصیص اعتبار» دولتی/عمرانی (مانند ساخت جاده و پل) و «اعتبار کالابرگ/یارانه» هستند (نه اعتبارسنجی و رتبه‌بندی اعتباری) باید امتیاز زیر ۲۰ بگیرند.",
    scaleMin: 0,
    scaleMax: 100,
  },
  novelty: {
    enabled: true,
    instruction: "میزان تازگی این خبر (رویداد جدید در برابر تکرار خبر قدیمی) را ارزیابی کن.",
    scaleMin: 0,
    scaleMax: 100,
  },
  mainEvent: {
    enabled: true,
    instruction: "رویداد یا تحول اصلی توصیف‌شده در مقاله را در یک جمله کوتاه فارسی مشخص کن.",
  },
  whyItMatters: {
    enabled: true,
    instruction: WHY_IT_MATTERS_DEFAULT_INSTRUCTION,
  },
  hashtags: { enabled: true, instruction: "سه تا پنج هشتگ مرتبط با خبر را در فیلد hashtags به صورت یک رشته با فاصله جدا کن؛ مثال: #بازار_سهام #نقدینگی. هشتگ را داخل خلاصه ننویس و بک‌اسلش اضافه نکن." },
  entities: {
    enabled: true,
    instruction:
      "نام بانک‌ها، شرکت‌ها، نهادها و سازمان‌هایی که خبر دربارهٔ آن‌هاست را به فارسی در آرایهٔ entities بیاور (حداکثر ۱۲ مورد). اگر نام مشخصی در خبر نیست، آرایهٔ خالی بده.",
  },
  shouldSend: {
    enabled: true,
    instruction: "مشخص کن که آیا این خبر باید به کانال هدف ارسال شود یا نه.",
  },
  reason: {
    enabled: true,
    instruction: "توضیح کوتاهی (۱۵ تا ۳۰ کلمه) برای دلیل ارسال یا عدم ارسال ارائه بده.",
  },
};

/** Mirrors the exact threshold baked into the previous hard-coded prompt: importance>=70 OR relevance>=70. */
export const DEFAULT_DECISION_RULES: AiDecisionRules = {
  minImportanceToSend: 70,
  minRelevanceToSend: 70,
  minNoveltyToSend: 0,
  // AND semantics: importance and relevance must BOTH pass. The previous
  // default (OR) recommended important-but-irrelevant articles.
  combine: "all",
  overallSendThreshold: 70,
  enableAutoRecommendation: true,
};

export const DEFAULT_OUTPUT_SCHEMA: AiOutputSchema = [
  { name: "summary", enabled: true, description: "خلاصه فارسی مقاله", required: true, type: "string" },
  { name: "category", enabled: true, description: "دسته‌بندی فارسی", required: true, type: "string" },
  { name: "importance", enabled: true, description: "امتیاز اهمیت", required: true, type: "number", min: 0, max: 100 },
  { name: "relevance", enabled: true, description: "امتیاز مرتبط بودن", required: true, type: "number", min: 0, max: 100 },
  { name: "novelty", enabled: true, description: "امتیاز تازگی", required: true, type: "number", min: 0, max: 100 },
  { name: "mainEvent", enabled: true, description: "رویداد اصلی", required: false, type: "string" },
  { name: "whyItMatters", enabled: true, description: "چرا برای مخاطب مهم است", required: false, type: "string" },
  { name: "hashtags", enabled: true, description: "هشتگ‌های مستقل؛ متن جداشده با فاصله، مانند #بازار_سهام #نقدینگی", required: false, type: "string" },
  { name: "entities", enabled: true, description: "نام بانک‌ها/شرکت‌ها/نهادهای مهم خبر (فارسی، آرایه‌ای)", required: false, type: "string" },
  { name: "shouldSend", enabled: true, description: "پیشنهاد ارسال", required: true, type: "boolean" },
  { name: "reason", enabled: true, description: "دلیل تصمیم ارسال", required: true, type: "string" },
];

/**
 * Default publishing layout. Kept IDENTICAL in spirit to the pre-M8 hard-coded
 * message (see src/lib/delivery/message.ts) so nothing changes visually for
 * existing users; it merely becomes editable from the Configuration Center.
 */
export const DEFAULT_PUBLISHING_TEMPLATE = `📰 {category}

{title}

{summary}

چرا مهم است:
{whyItMatters}

رویداد اصلی:
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

export const DEFAULT_CONFIG_NAME = "پیکربندی پیش‌فرض";
export const DEFAULT_MODEL_PLACEHOLDER = ""; // empty => env AI_API_MODEL / AI_MODEL / built-in fallback

/**
 * Default topic filter — INACTIVE and failing open: existing installations keep
 * ingesting and analyzing everything exactly as before until an admin enables
 * topics from the dashboard.
 */
export const DEFAULT_TOPIC_FILTER: AiTopicFilterConfig = {
  enabled: false,
  mode: "include",
  topics: [],
  blockedKeywords: [],
};

/**
 * Default auto-send policy — `useCustom: false` so the AUTO_SEND_* environment
 * variables keep deciding (zero behavior change for existing deployments).
 */
export const DEFAULT_AUTO_SEND_POLICY: AiAutoSendPolicy = {
  useCustom: false,
  enabled: true,
  destination: "local",
  minImportance: 50,
  minRelevance: 50,
  minNovelty: 0,
  requireAiRecommendation: false,
  categories: null,
  maxItemsPerPass: 20,
};
export const DEFAULT_TEMPERATURE = 0.2;
// Reasoning-style models (e.g. openai/gpt-oss-20b on Groq) spend a large,
// variable number of hidden "thinking" tokens before emitting the final JSON.
// The composed prompt (system prompt + per-feature instructions + decision
// rules + output contract) is longer than the original Milestone 4 prompt, so
// this default must stay generous enough that analysis keeps working exactly
// as before — verified empirically against the configured provider/model.
export const DEFAULT_MAX_TOKENS = 3000;
