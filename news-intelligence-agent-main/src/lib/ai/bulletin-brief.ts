/**
 * AI-synthesized bulletin intro (Phase 2, roadmap: worldmonitor "brief").
 *
 * One cheap text completion per bulletin: 2–4 Persian sentences that connect
 * the day's items into a story. Never throws and never blocks the bulletin —
 * on any failure the caller just omits the intro paragraph.
 *
 * SERVER-SIDE ONLY (reads AI_API_KEY through completion.ts).
 */

import { callAiChatCompletion } from "./completion";

export type BulletinBriefInput = {
  title: string;
  oneLiner: string | null;
  whyItMatters: string | null;
};

const BRIEF_SYSTEM_PROMPT = `تو سردبیر یک بولتن خبری تخصصی «اعتبارسنجی و رتبه‌بندی اعتباری» برای شرکت‌های اعتبارسنجی هستی.
یک متن جمع‌بندی کوتاه فارسی (۲ تا ۴ جمله) بنویس که خبرهای زیر را به هم پیوند دهد: مهم‌ترین محور مشترک، تأثیرشان بر ریسک اعتباری/بازار بدهی، و یک جمله چشم‌انداز.
فقط همان متن جمع‌بندی را بنویس — بدون عنوان، بدون فهرست، بدون Markdown، بدون نقل‌قول خبرها.`;

/**
 * Returns the intro paragraph, or null when the AI is unconfigured/fails.
 * Items are rendered compactly; the model is told not to repeat them verbatim.
 */
export async function synthesizeBulletinBrief(
  items: BulletinBriefInput[],
  config: { model?: string | null; temperature?: number | null; maxTokens?: number | null; introPrompt?: string; enabled?: boolean },
): Promise<string | null> {
  if (config.enabled === false) return null;
  if (items.length === 0) return null;
  if (!process.env.AI_API_KEY?.trim()) return null;

  const listing = items
    .slice(0, 8)
    .map((item, index) => {
      const parts = [`${index + 1}. ${item.title}`];
      if (item.oneLiner) parts.push(`خلاصه: ${item.oneLiner}`);
      if (item.whyItMatters) parts.push(`اهمیت: ${item.whyItMatters}`);
      return parts.join(" | ");
    })
    .join("\n");

  try {
    const completion = await callAiChatCompletion({
      systemPrompt: config.introPrompt?.trim() || BRIEF_SYSTEM_PROMPT,
      userPrompt: `خبرهای این بولتن:\n${listing}`,
      model: config.model ?? undefined,
      temperature: config.temperature ?? 0.4,
      maxTokens: Math.min(config.maxTokens ?? 400, 500),
    });

    if (!completion.ok) return null;

    const text = completion.rawText.replace(/^["'\s]+|["'\s]+$/g, "").trim();
    return text.length > 0 ? text.slice(0, 800) : null;
  } catch {
    return null;
  }
}
