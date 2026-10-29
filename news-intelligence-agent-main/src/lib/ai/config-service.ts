/**
 * AI Configuration Center — persistence & versioning (Milestone 5).
 *
 * Single source of truth for reading/writing `ai_configurations`. Every save
 * inserts a brand-new row (append-only history); activating a version simply
 * flips `isActive` off on every other row and on for the chosen one, inside a
 * transaction so exactly one configuration is ever active.
 */

import { validateBulletinSettings } from "../delivery/bulletin";
import { db } from "@/db";
import { aiConfigurations, type AiConfigurationRow } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import {
  AI_FEATURE_ORDER,
  DEFAULT_AUTO_SEND_POLICY,
  DEFAULT_CONFIG_NAME,
  DEFAULT_DECISION_RULES,
  DEFAULT_FEATURES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_PLACEHOLDER,
  DEFAULT_OUTPUT_SCHEMA,
  DEFAULT_PUBLISHING_TEMPLATE,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOPIC_FILTER,
  upgradeLegacyTemplateFooter,
  upgradeLegacyWhyItMattersInstruction,
  type ActiveAiConfig,
  type AiAutoSendPolicy,
  type AiConfigInput,
  type AiFeatureKey,
  type AiTopicFilterConfig,
} from "./config-types";

/**
 * Additive normalization for rows written before newer feature keys existed:
 * a missing `whyItMatters` (or any later key) is filled from the defaults, and
 * missing output-schema entries are appended, so older configurations start
 * producing new optional fields without re-saving them. Never overrides an
 * operator's own values — even disabled ones.
 */
function withMissingConfigParts(
  features: ActiveAiConfig["features"],
  outputSchema: ActiveAiConfig["outputSchema"],
): { features: ActiveAiConfig["features"]; outputSchema: ActiveAiConfig["outputSchema"] } {
  const mergedFeatures = { ...features };
  for (const key of AI_FEATURE_ORDER) {
    if (!mergedFeatures[key]) {
      mergedFeatures[key] = { ...DEFAULT_FEATURES[key] };
    } else if (key === "whyItMatters") {
      // One-time prompt upgrade: the legacy instruction told the model to
      // answer the canned «…اهمیت مشخصی ندارد» line — rewrite it in place
      // (exact-match only; operator-customized text is preserved).
      mergedFeatures[key] = {
        ...mergedFeatures[key],
        instruction: upgradeLegacyWhyItMattersInstruction(mergedFeatures[key].instruction),
      };
    }
  }
  const known = new Set(outputSchema.map((field) => field.name));
  const mergedSchema = [...outputSchema];
  for (const field of DEFAULT_OUTPUT_SCHEMA) {
    if (!known.has(field.name)) mergedSchema.push({ ...field });
  }
  return { features: mergedFeatures, outputSchema: mergedSchema };
}

function toActiveConfig(row: AiConfigurationRow): ActiveAiConfig {
  const normalized = withMissingConfigParts(row.features, row.outputSchema);
  return {
    id: row.id,
    name: row.name,
    provider: "openai-compatible",
    model: row.model,
    systemPrompt: row.systemPrompt,
    audienceFocus: row.audienceFocus ?? "",
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    features: normalized.features,
    decisionRules: row.decisionRules,
    outputSchema: normalized.outputSchema,
    publishingTemplate: upgradeLegacyTemplateFooter(row.publishingTemplate ?? ""),
    // Rows written before these columns existed read as null -> safe defaults.
    topicFilter: row.topicFilter ?? DEFAULT_TOPIC_FILTER,
    autoSendPolicy: row.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY,
    isActive: row.isActive,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Builds the seed configuration matching the previous hard-coded AI behavior. */
export function buildDefaultConfigInput(): AiConfigInput {
  return {
    name: DEFAULT_CONFIG_NAME,
    provider: "openai-compatible",
    model: DEFAULT_MODEL_PLACEHOLDER,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    audienceFocus: "",
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
    features: DEFAULT_FEATURES,
    decisionRules: DEFAULT_DECISION_RULES,
    outputSchema: DEFAULT_OUTPUT_SCHEMA,
    publishingTemplate: DEFAULT_PUBLISHING_TEMPLATE,
    topicFilter: DEFAULT_TOPIC_FILTER,
    autoSendPolicy: DEFAULT_AUTO_SEND_POLICY,
  };
}

/**
 * Read-only view of the operational knobs (topic filter + auto-send policy).
 *
 * Unlike getActiveAiConfig() this NEVER seeds or writes: the ingestion pipeline
 * and the auto-delivery pass call it on hot paths, so a missing configuration
 * simply means "use the safe defaults" (filter off / env-driven auto-send).
 * Returns null when no active configuration exists or the read fails.
 */
export async function readActiveOperationalSettings(): Promise<{
  topicFilter: AiTopicFilterConfig;
  autoSendPolicy: AiAutoSendPolicy;
} | null> {
  try {
    const [active] = await db
      .select({
        topicFilter: aiConfigurations.topicFilter,
        autoSendPolicy: aiConfigurations.autoSendPolicy,
      })
      .from(aiConfigurations)
      .where(eq(aiConfigurations.isActive, true))
      .orderBy(desc(aiConfigurations.version))
      .limit(1);

    if (!active) return null;
    return {
      topicFilter: active.topicFilter ?? DEFAULT_TOPIC_FILTER,
      autoSendPolicy: active.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY,
    };
  } catch {
    return null;
  }
}

/**
 * Returns the active configuration, creating the default one automatically the
 * first time this is called (Milestone 5 backward-compatibility requirement:
 * "If no configuration exists, create the default configuration automatically
 * using the current working AI analysis behavior.").
 */
export async function getActiveAiConfig(): Promise<ActiveAiConfig> {
  const [active] = await db
    .select()
    .from(aiConfigurations)
    .where(eq(aiConfigurations.isActive, true))
    .orderBy(desc(aiConfigurations.version))
    .limit(1);

  if (active) {
    return toActiveConfig(active);
  }

  // No active configuration anywhere yet: seed the default and activate it.
  const seeded = await createAiConfigVersion(buildDefaultConfigInput(), { activate: true });
  return seeded;
}

/** Newest-first version history (id, version, name, isActive, timestamps) — no secrets. */
export async function listAiConfigVersions(limit = 50): Promise<ActiveAiConfig[]> {
  const rows = await db
    .select()
    .from(aiConfigurations)
    .orderBy(desc(aiConfigurations.version))
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows.map(toActiveConfig);
}

export async function getAiConfigById(id: string): Promise<ActiveAiConfig | null> {
  const [row] = await db.select().from(aiConfigurations).where(eq(aiConfigurations.id, id)).limit(1);
  return row ? toActiveConfig(row) : null;
}

async function nextVersionNumber(): Promise<number> {
  const [latest] = await db
    .select({ version: aiConfigurations.version })
    .from(aiConfigurations)
    .orderBy(desc(aiConfigurations.version))
    .limit(1);

  return (latest?.version ?? 0) + 1;
}

/**
 * Inserts a new configuration version. When `activate` is true (default),
 * every other row is deactivated first inside the same transaction so exactly
 * one configuration stays active — this is the project's single-active-config
 * policy referenced in the milestone brief.
 */
export async function createAiConfigVersion(
  input: AiConfigInput,
  options: { activate: boolean } = { activate: true },
): Promise<ActiveAiConfig> {
  const version = await nextVersionNumber();

  const created = await db.transaction(async (tx) => {
    if (options.activate) {
      await tx.update(aiConfigurations).set({ isActive: false }).where(eq(aiConfigurations.isActive, true));
    }

    const [row] = await tx
      .insert(aiConfigurations)
      .values({
        name: input.name,
        provider: input.provider,
        model: input.model,
        systemPrompt: input.systemPrompt,
        audienceFocus: input.audienceFocus?.trim() ?? "",
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        features: input.features,
        decisionRules: input.decisionRules,
        outputSchema: input.outputSchema,
        publishingTemplate: input.publishingTemplate?.trim() ?? "",
        topicFilter: input.topicFilter ?? DEFAULT_TOPIC_FILTER,
        autoSendPolicy: input.autoSendPolicy ?? DEFAULT_AUTO_SEND_POLICY,
        isActive: options.activate,
        version,
      })
      .returning();

    return row;
  });

  return toActiveConfig(created);
}

/** Activates a previously saved version without editing its content. */
export async function activateAiConfigVersion(id: string): Promise<ActiveAiConfig | null> {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(aiConfigurations).where(eq(aiConfigurations.id, id)).limit(1);
    if (!target) return null;

    await tx
      .update(aiConfigurations)
      .set({ isActive: false })
      .where(and(eq(aiConfigurations.isActive, true)));

    const [updated] = await tx
      .update(aiConfigurations)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(aiConfigurations.id, id))
      .returning();

    return toActiveConfig(updated);
  });
}

export type ConfigValidationResult = { valid: true } | { valid: false; errors: string[] };

const REQUIRED_FEATURE_KEYS: AiFeatureKey[] = [
  "summary",
  "category",
  "importance",
  "relevance",
  "novelty",
  "mainEvent",
  "shouldSend",
  "reason",
];

/**
 * Validates a configuration before it is ever sent to the AI service or saved.
 * All messages are Persian, surfaced directly in the admin UI.
 */
export function validateAiConfigInput(input: AiConfigInput): ConfigValidationResult {
  const errors: string[] = [];

  if (!input.systemPrompt || !input.systemPrompt.trim()) {
    errors.push("متن System Prompt نمی‌تواند خالی باشد.");
  }

  if (input.audienceFocus && input.audienceFocus.length > 2000) {
    errors.push("متن تمرکز مخاطب نباید بیش از ۲۰۰۰ کاراکتر باشد.");
  }

  if (!input.name || !input.name.trim()) {
    errors.push("نام پیکربندی نمی‌تواند خالی باشد.");
  }

  const featureKeys = REQUIRED_FEATURE_KEYS.filter((key) => input.features?.[key]);
  if (featureKeys.length !== REQUIRED_FEATURE_KEYS.length) {
    errors.push("ساختار ویژگی‌های تحلیل ناقص است.");
  } else {
    const enabledCount = featureKeys.filter((key) => input.features[key].enabled).length;
    if (enabledCount === 0) {
      errors.push("حداقل باید یک ویژگی تحلیل فعال باشد.");
    }

    for (const key of featureKeys) {
      const feature = input.features[key];
      if (feature.enabled && !feature.instruction?.trim()) {
        errors.push(`دستورالعمل ویژگی «${key}» نمی‌تواند خالی باشد.`);
      }
      if (feature.scaleMin !== undefined && feature.scaleMax !== undefined && feature.scaleMin >= feature.scaleMax) {
        errors.push(`بازه امتیاز ویژگی «${key}» نامعتبر است.`);
      }
    }
  }

  if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
    errors.push("مقدار Temperature باید عددی بین ۰ و ۲ باشد.");
  }

  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 50 || input.maxTokens > 8000) {
    errors.push("مقدار Max Tokens باید عددی صحیح بین ۵۰ و ۸۰۰۰ باشد.");
  }

  const rules = input.decisionRules;
  if (!rules) {
    errors.push("قوانین تصمیم‌گیری تعریف نشده است.");
  } else {
    errors.push(...validateBulletinSettings(rules.bulletin));
    if (rules.shadowMinImportance !== undefined && (!Number.isInteger(rules.shadowMinImportance) || rules.shadowMinImportance < 0 || rules.shadowMinImportance > 100)) errors.push("آستانه اهمیت آزمایشی باید عدد صحیح صفر تا صد باشد.");
    for (const key of ["freshHours", "recentHours"] as const) {
      if (rules[key] !== undefined && (!Number.isInteger(rules[key]) || rules[key]! < 1 || rules[key]! > 8760)) errors.push(`تنظیم ${key} باید عدد صحیح یک تا ۸۷۶۰ ساعت باشد.`);
    }
    if ((rules.freshHours ?? 24) > (rules.recentHours ?? 72)) errors.push("بازه تازه نباید از بازه اخیر بیشتر باشد.");
    for (const key of ["graderEnabled", "shadowEvaluationEnabled"] as const) {
      if (rules[key] !== undefined && typeof rules[key] !== "boolean") errors.push(`تنظیم ${key} باید روشن یا خاموش باشد.`);
    }
    for (const key of ["graderMin", "graderMax"] as const) {
      if (rules[key] !== undefined && (!Number.isInteger(rules[key]) || rules[key]! < 0 || rules[key]! > 100)) errors.push(`تنظیم ${key} باید عدد صحیح صفر تا صد باشد.`);
    }
    if ((rules.graderMin ?? 55) > (rules.graderMax ?? 70)) errors.push("حداقل امتیاز داوری نباید بیشتر از حداکثر باشد.");
    if (rules.combine !== undefined && rules.combine !== "all" && rules.combine !== "any") {
      errors.push("حالت ترکیب قوانین تصمیم‌گیری باید «all» (همه شرط‌ها) یا «any» (یکی کافی است) باشد.");
    }
    for (const [label, value] of [
      ["حداقل امتیاز اهمیت", rules.minImportanceToSend],
      ["حداقل امتیاز مرتبط بودن", rules.minRelevanceToSend],
      ["حداقل امتیاز تازگی", rules.minNoveltyToSend],
      ["آستانه کلی ارسال", rules.overallSendThreshold],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        errors.push(`${label} باید عددی بین ۰ و ۱۰۰ باشد.`);
      }
    }
  }

  if (!Array.isArray(input.outputSchema) || input.outputSchema.length === 0) {
    errors.push("ساختار خروجی (Output Schema) نمی‌تواند خالی باشد.");
  } else {
    const enabledRequired = input.outputSchema.filter((field) => field.enabled && field.required);
    if (enabledRequired.length === 0) {
      errors.push("حداقل یک فیلد الزامی در ساختار خروجی باید فعال باشد.");
    }
    for (const field of input.outputSchema) {
      if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min >= field.max) {
        errors.push(`بازه عددی فیلد «${field.name}» نامعتبر است.`);
      }
    }
    for (const field of input.outputSchema) {
      const feature = input.features?.[field.name];
      if (field.enabled && feature?.enabled && field.type === "number" &&
          Math.max(field.min ?? 0, feature.scaleMin ?? 0) >= Math.min(field.max ?? 100, feature.scaleMax ?? 100)) {
        errors.push(`بازه ویژگی و ساختار خروجی «${field.name}» هم‌پوشانی معتبر ندارد.`);
      }
    }
    if (!input.features?.summary?.enabled || !input.features?.shouldSend?.enabled) {
      errors.push("ویژگی‌های summary و shouldSend برای عملکرد سامانه باید فعال بمانند.");
    }
    // Required-but-disabled fields would silently break the existing parser/DB contract.
    const disabledButRequiredByPipeline = input.outputSchema.filter(
      (field) => !field.enabled && (field.name === "summary" || field.name === "shouldSend"),
    );
    if (disabledButRequiredByPipeline.length > 0) {
      errors.push("فیلدهای «summary» و «shouldSend» برای عملکرد صحیح سامانه باید فعال بمانند.");
    }
  }

  // ── Topic filter (optional section; defaults are always valid) ──────────
  const topicFilter = input.topicFilter;
  if (topicFilter) {
    if (topicFilter.mode !== "include" && topicFilter.mode !== "exclude") {
      errors.push("حالت فیلتر موضوعی باید «تمرکز» (include) یا «حذف» (exclude) باشد.");
    }
    if (!Array.isArray(topicFilter.topics)) {
      errors.push("ساختار موضوعات فیلتر نامعتبر است.");
    } else {
      if (topicFilter.topics.length > 30) {
        errors.push("حداکثر ۳۰ موضوع قابل تعریف است.");
      }
      for (const topic of topicFilter.topics) {
        const label = topic.label?.trim() ?? "";
        if (!label) errors.push("عنوان هر موضوع نمی‌تواند خالی باشد.");
        if (label.length > 80) errors.push("عنوان موضوع نباید بیش از ۸۰ کاراکتر باشد.");
        if (!Array.isArray(topic.keywords) || topic.keywords.length > 50) {
          errors.push(`برای موضوع «${label || topic.id || "بدون‌نام"}» حداکثر ۵۰ کلیدواژه قابل تعریف است.`);
        } else if (topic.keywords.some((keyword) => (keyword ?? "").length > 120)) {
          errors.push(`کلیدواژه‌های موضوع «${label || topic.id || "بدون‌نام"}» نباید بیش از ۱۲۰ کاراکتر باشند.`);
        }
      }
    }

    const baseline = topicFilter.baselineBlockedKeywords;
    if (baseline !== undefined && (!Array.isArray(baseline) || baseline.length > 200 || baseline.some(word => typeof word !== "string" || !word.trim() || word.length > 100))) {
      errors.push("فهرست ممنوع پایه باید حداکثر ۲۰۰ عبارت غیرخالی با طول حداکثر ۱۰۰ نویسه باشد.");
    }
    const blocked = topicFilter.blockedKeywords;
    if (blocked !== undefined) {
      if (!Array.isArray(blocked)) {
        errors.push("فهرست کلیدواژه‌های ممنوع نامعتبر است.");
      } else {
        if (blocked.length > 100) errors.push("حداکثر ۱۰۰ کلیدواژهٔ ممنوع قابل تعریف است.");
        if (blocked.some((keyword) => (keyword ?? "").length > 80)) {
          errors.push("هر کلیدواژهٔ ممنوع نباید بیش از ۸۰ کاراکتر باشد.");
        }
      }
    }
  }

  // ── Auto-send policy (optional section; env fallback when not customized) ─
  const policy = input.autoSendPolicy;
  if (policy?.useCustom) {
    if (policy.destination !== "local" && policy.destination !== "bale" && policy.destination !== "both") {
      errors.push("مقصد ارسال خودکار باید local، bale یا both باشد.");
    }
    for (const [label, value] of [
      ["حداقل امتیاز اهمیت (ارسال خودکار)", policy.minImportance],
      ["حداقل امتیاز مرتبط بودن (ارسال خودکار)", policy.minRelevance],
      ["حداقل امتیاز تازگی (ارسال خودکار)", policy.minNovelty],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        errors.push(`${label} باید عددی بین ۰ و ۱۰۰ باشد.`);
      }
    }
    if (!Number.isInteger(policy.maxItemsPerPass) || policy.maxItemsPerPass < 1 || policy.maxItemsPerPass > 100) {
      errors.push("سقف اخبار هر نوبت ارسال خودکار باید عددی صحیح بین ۱ و ۱۰۰ باشد.");
    }
    if (policy.categories !== null && (!Array.isArray(policy.categories) || policy.categories.length > 30)) {
      errors.push("فهرست دسته‌های مجاز ارسال خودکار نامعتبر است (حداکثر ۳۰ دسته).");
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
