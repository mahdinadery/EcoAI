/**
 * Two-stage relevance grader (roadmap Phase 3, task #9) — SERVER-SIDE ONLY.
 *
 * One CHEAP second call per borderline article (relevance 55–70): a single
 * yes/no question about true relevance. The verdict never raises scores — a
 * "no" marks the item `grader_rejected` and the strict send rule drops it, so
 * gray-area importance can never smuggle an off-topic item into the channel.
 */

import { callAiChatCompletion, type AiTokenUsage } from "./completion";
import { isBorderlineRelevance, parseGradeVerdict, type GradeVerdict } from "./grade-rules";

const GRADER_SYSTEM_PROMPT =
  "تو یک ارزیاب سخت‌گیر مرتبط بودن مقالات و اخبار اقتصادی هستی. مطالب تحلیلی و پژوهشی دربارهٔ اقتصاد کلان، سیاست پولی و مالی، بانک‌های مرکزی، تجارت جهانی، بازارهای مالی، انرژی و اقتصاد توسعه «مرتبط» هستند؛ اما مطالب غیرمرتبط با اقتصاد (ورزش، سرگرمی، سلبریتی، حوادث، تبلیغات تجاری یا هیاهوی زرد غیرتحلیلی) قطعاً «خیر» می‌گیرند. با توجه به تمرکز مخاطب، فقط و فقط با یک کلمه پاسخ بده: «بله» یا «خیر». هیچ توضیحی ننویس.";

export { isBorderlineRelevance };

export type GradeRelevanceOutcome = {
  verdict: GradeVerdict | null;
  usage: AiTokenUsage | null;
};

/**
 * Asks the yes/no relevance question and returns both the parsed verdict and
 * token usage for the call.
 */
export async function gradeRelevanceWithUsage(input: {
  title: string;
  summary: string | null;
  audienceFocus?: string | null;
}): Promise<GradeRelevanceOutcome> {
  if (!process.env.AI_API_KEY?.trim()) return { verdict: null, usage: null };

  const focus =
    input.audienceFocus?.trim() ||
    "مخاطب، اقتصاددانان، پژوهشگران و تحلیلگران بازار هستند؛ فقط مقالات تحلیلی اقتصادی، سیاست‌گذاری کلان، بانک‌های مرکزی، تجارت جهانی و بازارهای مالی مرتبط‌اند.";

  const userPrompt = [
    `تمرکز مخاطب: ${focus}`,
    "",
    `عنوان خبر: ${input.title}`,
    input.summary ? `خلاصه: ${input.summary}` : "",
    "",
    "آیا این خبر واقعاً برای این مخاطب مرتبط است؟ فقط «بله» یا «خیر».",
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const completion = await callAiChatCompletion({
      systemPrompt: GRADER_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0,
      maxTokens: 16,
    });

    if (!completion.ok) return { verdict: null, usage: null };
    return {
      verdict: parseGradeVerdict(completion.rawText),
      usage: completion.usage,
    };
  } catch {
    return { verdict: null, usage: null };
  }
}

/**
 * Asks the yes/no relevance question. Returns null when the AI is not
 * configured, fails, or answers unparseably — null means "keep the original
 * scores" (the grader can only veto, never silently invent a grade).
 */
export async function gradeRelevance(input: {
  title: string;
  summary: string | null;
  audienceFocus?: string | null;
}): Promise<GradeVerdict | null> {
  const outcome = await gradeRelevanceWithUsage(input);
  return outcome.verdict;
}
