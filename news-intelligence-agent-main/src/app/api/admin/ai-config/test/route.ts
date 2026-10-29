import { SHADOW_INSTRUCTION, evaluateShadow } from "@/lib/ai/shadow-evaluation";
import { isBorderlineRelevance } from "@/lib/ai/grade-rules";
import { effectiveOutputSchema } from "@/lib/ai/effective-schema";
import { checkAdminAccess } from "@/lib/admin/access";
import { callAiChatCompletion } from "@/lib/ai/completion";
import { getActiveAiConfig, validateAiConfigInput } from "@/lib/ai/config-service";
import type { AiConfigInput } from "@/lib/ai/config-types";
import { baselineKeywords, evaluateTopicFilter } from "@/lib/news/topic-filter";
import { buildAIAnalysisPrompt } from "@/lib/ai/prompt-builder";
import { validateAiOutputAgainstSchema } from "@/lib/ai/output-parser";
import { db } from "@/db";
import { news, type NewsRow } from "@/db/schema";
import { renderPublishingMessage } from "@/lib/delivery/template";
import { desc, eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/ai-config/test
 *
 * Lightweight article list (id/title/source/analyzed flag) for the "Test
 * Configuration" article selector dropdown. Read-only.
 */
export async function GET(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  const rows = await db
    .select({
      id: news.id,
      title: news.title,
      source: news.source,
      analyzedAt: news.analyzedAt,
    })
    .from(news)
    .orderBy(desc(sql`coalesce(${news.publishedAt}, ${news.createdAt})`))
    .limit(50);

  return Response.json({
    success: true,
    articles: rows.map((row) => ({
      id: row.id,
      title: row.title,
      source: row.source,
      analyzed: Boolean(row.analyzedAt),
    })),
  });
}

type ManualArticle = {
  title: string;
  description: string | null;
  source: string;
  publishedAt: string | null;
};

type TestBody = {
  /** Optional unsaved draft configuration to test before saving it. */
  draftConfig?: AiConfigInput;
  /** Pick an existing stored article by ID (read-only — never modified). */
  articleId?: string;
  /** Or paste/describe an article manually. */
  manualArticle?: ManualArticle;
};

/**
 * POST /api/admin/ai-config/test
 *
 * Runs the (draft or active) configuration against one article WITHOUT ever
 * sending anything to Bale/Local and WITHOUT writing to the `news` table
 * (article rows are only ever read here, never updated).
 *
 * Returns: the exact prompt used, the raw AI response text, the schema
 * validation result, and — when valid — the parsed structured result.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let body: TestBody;
  try {
    body = (await request.json()) as TestBody;
  } catch {
    return Response.json({ success: false, message: "بدنه درخواست JSON معتبر نیست." }, { status: 400 });
  }

  // Resolve the configuration to test: an unsaved draft, or the active one.
  let configForPrompt: AiConfigInput;

  if (body.draftConfig) {
    const validation = validateAiConfigInput(body.draftConfig);
    if (!validation.valid) {
      return Response.json(
        { success: false, message: "پیکربندی آزمایشی نامعتبر است.", errors: validation.errors },
        { status: 400 },
      );
    }
    configForPrompt = body.draftConfig;
  } else {
    const active = await getActiveAiConfig();
    configForPrompt = active;
  }

  // Resolve the article: an existing stored row (read-only) or a manual/pasted one.
  let article: ManualArticle;

  if (body.articleId) {
    const [row] = await db
      .select({
        title: news.title,
        description: news.description,
        source: news.source,
        publishedAt: news.publishedAt,
      })
      .from(news)
      .where(eq(news.id, body.articleId))
      .limit(1);

    if (!row) {
      return Response.json({ success: false, message: "خبر انتخاب‌شده پیدا نشد." }, { status: 404 });
    }

    article = {
      title: row.title,
      description: row.description,
      source: row.source,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  } else if (body.manualArticle?.title?.trim()) {
    article = {
      title: body.manualArticle.title.trim(),
      description: body.manualArticle.description?.trim() || null,
      source: body.manualArticle.source?.trim() || "تست دستی",
      publishedAt: body.manualArticle.publishedAt?.trim() || null,
    };
  } else {
    return Response.json(
      { success: false, message: "یک خبر موجود را انتخاب کنید یا متن خبر آزمایشی را وارد کنید." },
      { status: 400 },
    );
  }

  const { systemPrompt, userPrompt } = buildAIAnalysisPrompt(configForPrompt, article, {
    baselineBlockedKeywords: baselineKeywords(configForPrompt.topicFilter),
  });

  const shadowEnabled = configForPrompt.decisionRules.shadowEvaluationEnabled ?? (process.env.AI_SHADOW_EVALUATION === "true");
  const effectiveSystemPrompt = shadowEnabled ? systemPrompt.replace("هیچ کلید یا متن اضافه‌ای اضافه نکن.", "") + "\n" + SHADOW_INSTRUCTION : systemPrompt;
  const completion = await callAiChatCompletion({
    systemPrompt: effectiveSystemPrompt,
    userPrompt,
    model: configForPrompt.model,
    temperature: configForPrompt.temperature,
    maxTokens: configForPrompt.maxTokens,
  });

  if (!completion.ok) {
    return Response.json({
      success: false,
      message: completion.message,
      detail: completion.detail ?? null,
      promptUsed: { systemPrompt: effectiveSystemPrompt, userPrompt },
    });
  }

  const validation = validateAiOutputAgainstSchema(completion.rawText, effectiveOutputSchema(configForPrompt.outputSchema, configForPrompt.features));

  if (validation.ok && !configForPrompt.decisionRules.enableAutoRecommendation) validation.value.shouldSend = false;

  let shadowEvaluation = null;
  if (shadowEnabled) {
    let rawShadow: unknown = null;
    try { rawShadow = JSON.parse(completion.rawText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")).shadow; } catch { /* invalid shadow becomes review */ }
    shadowEvaluation = evaluateShadow(rawShadow, [article.title, article.description].filter(Boolean).join("\n"), article.publishedAt, Date.now(), configForPrompt.decisionRules);
  }
  return Response.json({
    success: true,
    operationalPreview: {
      topicGate: evaluateTopicFilter(article, configForPrompt.topicFilter),
      graderWouldRun: validation.ok && isBorderlineRelevance(validation.value.relevance, configForPrompt.decisionRules),
      shadowEvaluation,
    },
    model: completion.model,
    usage: completion.usage,
    promptUsed: { systemPrompt: effectiveSystemPrompt, userPrompt },
    rawResponse: completion.rawText,
    publishingPreview: validation.ok ? renderPublishingMessage(configForPrompt.publishingTemplate, {
      title: article.title,
      source: article.source,
      url: "https://example.com/preview",
      publishedAt: article.publishedAt && Number.isFinite(Date.parse(article.publishedAt)) ? new Date(article.publishedAt) : null,
      hashtags: validation.value.hashtags,
      summary: validation.value.summary,
      category: validation.value.category,
      importanceScore: validation.value.importance,
      relevanceScore: validation.value.relevance,
      noveltyScore: validation.value.novelty,
      mainEvent: validation.value.mainEvent,
      whyItMatters: validation.value.whyItMatters,
    } as NewsRow) : null,
    validation:
      validation.ok
        ? { valid: true, issues: validation.issues, parsed: validation.value }
        : { valid: false, issues: validation.issues, parsed: null },
  });
}
