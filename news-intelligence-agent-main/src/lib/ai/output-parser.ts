/**
 * AI Configuration Center — structured output parsing & validation (Milestone 5).
 *
 * Single place that turns raw AI text into the shape the rest of the app
 * consumes, validated against the *active configuration's* output schema
 * instead of a hard-coded field list. Field semantics (which keys exist, what
 * they mean) are unchanged from Milestone 4 — only *which of them are required*
 * is now configurable.
 */

import type { AiOutputSchema } from "./config-types";
import { sanitizeWhyItMatters } from "./why-guard";

export type ParsedAiOutput = {
  hashtags: string | null;
  summary: string;
  category: string;
  importance: number;
  relevance: number;
  novelty: number;
  mainEvent: string | null;
  /** One-line "why it matters for the audience" — null when the model omitted it. */
  whyItMatters: string | null;
  /** Persian names of banks/companies/institutions mentioned — null when omitted. */
  entities: string[] | null;
  shouldSend: boolean;
  reason: string;
};

/** Canonical, bounded hashtags; remove legacy Markdown escaping and discard prose. */
export function normalizeHashtags(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tags = value.replace(/\\_/g, "_").match(/#[\p{L}\p{N}_\u200c]+/gu) ?? [];
  const clean = [...new Set(tags.filter(tag => tag.length > 1 && tag.length <= 80 && /[\p{L}\p{N}]/u.test(tag)))].slice(0, 6);
  return clean.length ? clean.join(" ") : null;
}

/** Normalizes an AI "entities" field (string[] or comma-separated string). */
export function coerceEntities(value: unknown): string[] | null {
  const raw: string[] = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/[,،\n]/)
      : [];
  const cleaned = raw
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2 && entry.length <= 80)
    .slice(0, 12);
  return cleaned.length > 0 ? [...new Set(cleaned)] : null;
}

function clampScore(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function extractJsonText(rawText: string): string {
  let jsonText = rawText.trim();
  const match = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(jsonText);
  if (match) jsonText = match[1].trim();
  return jsonText;
}

/**
 * Throwing parser used by the production analysis pipeline — preserves the
 * exact error-handling contract Milestone 4 already relied on
 * (src/lib/news/analyze.ts catches this and maps it to `kind: "invalid_json"`).
 */
export function parseAiOutput(rawText: string, outputSchema: AiOutputSchema): ParsedAiOutput {
  const result = validateAiOutputAgainstSchema(rawText, outputSchema);
  if (!result.ok) throw new Error(result.issues.map(issue => `${issue.field}: ${issue.message}`).join("; "));
  return result.value;
}

export type OutputValidationIssue = { field: string; message: string };

export type OutputValidationResult =
  | { ok: true; value: ParsedAiOutput; issues: OutputValidationIssue[] }
  | { ok: false; issues: OutputValidationIssue[]; rawText: string };

/**
 * Non-throwing validator used by the admin "Test Configuration" panel: reports
 * every schema mismatch (missing required field, wrong type, out-of-range
 * score) instead of stopping at the first error, so the administrator can fix
 * everything in one pass.
 */
export function validateAiOutputAgainstSchema(
  rawText: string,
  outputSchema: AiOutputSchema,
): OutputValidationResult {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(extractJsonText(rawText));
  } catch (error) {
    return {
      ok: false,
      issues: [{ field: "(root)", message: `پاسخ JSON معتبر نیست: ${error instanceof Error ? error.message : String(error)}` }],
      rawText,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, issues: [{ field: "(root)", message: "پاسخ باید یک شیء JSON باشد." }], rawText };
  }

  const issues: OutputValidationIssue[] = [];

  for (const field of outputSchema) {
    if (!field.enabled) continue;
    const value = parsed[field.name];
    const present = value !== undefined && value !== null;

    if (!present) {
      if (field.required) {
        issues.push({ field: field.name, message: "فیلد الزامی در پاسخ وجود ندارد." });
      }
      continue;
    }

    if (field.type === "string" && typeof value !== "string" && !(field.name === "entities" && Array.isArray(value) && value.every(v => typeof v === "string"))) {
      issues.push({ field: field.name, message: `نوع مقدار باید متن (string) باشد، دریافت شد: ${typeof value}.` });
    }

    if (field.type === "boolean" && typeof value !== "boolean") {
      issues.push({ field: field.name, message: `نوع مقدار باید بولین (boolean) باشد، دریافت شد: ${typeof value}.` });
    }

    if (field.type === "number") {
      const num = Number(value);
      if (typeof value !== "number" || !Number.isFinite(num)) {
        issues.push({ field: field.name, message: "نوع مقدار باید عدد باشد." });
      } else if (field.min !== undefined && num < field.min) {
        issues.push({ field: field.name, message: `مقدار (${num}) کمتر از حداقل مجاز (${field.min}) است.` });
      } else if (field.max !== undefined && num > field.max) {
        issues.push({ field: field.name, message: `مقدار (${num}) بیشتر از حداکثر مجاز (${field.max}) است.` });
      }
    }

    if (field.required && field.type === "string" && typeof value === "string" && !value.trim()) {
      issues.push({ field: field.name, message: "فیلد الزامی است اما مقدار خالی برگردانده شد." });
    }

    if (field.name === "whyItMatters" && typeof value === "string" && value.trim() && !sanitizeWhyItMatters(value)) {
      issues.push({
        field: "whyItMatters",
        message: "جملهٔ کلیشه‌ای یا بی‌محتواست و در پیام نمایش داده نمی‌شود (دلیل مشخص برای مخاطب بنویس).",
      });
    }
  }

  // Invalid present values are errors even for optional fields; quality-guard
  // warnings on optional prose remain non-blocking.
  const blocking = issues.filter(issue => !issue.message.startsWith("جملهٔ کلیشه‌ای") || outputSchema.find(f => f.name === issue.field)?.required);

  if (blocking.length > 0) {
    return { ok: false, issues, rawText };
  }

  // Ignore unsolicited/disabled fields instead of persisting the model's extras.
  const enabled = new Set<string>(outputSchema.filter(field => field.enabled).map(field => field.name));
  parsed = Object.fromEntries(Object.entries(parsed).filter(([name]) => enabled.has(name)));
  return {
    ok: true,
    issues,
    value: {
      hashtags: normalizeHashtags(parsed.hashtags),
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      category: typeof parsed.category === "string" && parsed.category.trim() ? parsed.category.trim() : "سایر",
      importance: clampScore(parsed.importance),
      relevance: clampScore(parsed.relevance),
      novelty: clampScore(parsed.novelty),
      mainEvent: typeof parsed.mainEvent === "string" && parsed.mainEvent.trim() ? parsed.mainEvent.trim() : null,
      whyItMatters: sanitizeWhyItMatters(parsed.whyItMatters),
      entities: coerceEntities(parsed.entities),
      shouldSend: parsed.shouldSend === true,
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    },
  };
}
