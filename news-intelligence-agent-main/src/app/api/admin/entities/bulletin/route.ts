/**
 * POST /api/admin/entities/bulletin — «ارسال بولتن این موجودیت».
 *
 * Builds ONE digest of an entity's recent news (last 14 days, top 5 that pass
 * the operator's strict send rule) and sends it to the configured destination.
 * Manual only — the operator explicitly asks for it from the dossier page.
 */

import { getActiveAiConfig } from "@/lib/ai/config-service";
import { checkAdminAccess } from "@/lib/admin/access";
import { dbErrorResponse } from "@/lib/admin/db-error-response";
import { runWithSchemaRepair } from "@/lib/admin/schema-sync";
import { db } from "@/db";
import { news } from "@/db/schema";
import { synthesizeBulletinBrief } from "@/lib/ai/bulletin-brief";
import { sendBulletinDelivery } from "@/lib/delivery";
import { buildBulletinMessage, resolveBulletinSettings, pickBulletinItems } from "@/lib/delivery/bulletin";
import { coerceScheduleConfig } from "@/lib/agent/schedule";
import { evaluateArticle } from "@/lib/agent/rules";
import { collapseEventGroups } from "@/lib/news/corroboration";
import { scheduleToRule } from "@/lib/agent/scheduled-run";
import { readScheduleRecord } from "@/lib/agent/schedule-store";
import { and, desc, gte, isNotNull } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  let name = "";
  try {
    const body = (await request.json()) as { name?: string };
    name = body?.name?.trim() ?? "";
  } catch {
    // fall through
  }
  if (!name) {
    return Response.json({ success: false, message: "نام موجودیت لازم است." }, { status: 400 });
  }

  const outcome = await runWithSchemaRepair(async () => {
    const rows = await db
      .select()
      .from(news)
      .where(and(isNotNull(news.analyzedAt), gte(news.createdAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))))
      .orderBy(desc(news.createdAt))
      .limit(300);

    const matched = rows.filter((row) => (row.entityTags ?? []).some((entity) => entity.trim() === name));

    const record = await readScheduleRecord();
    const rule = scheduleToRule(coerceScheduleConfig(record));
    // Same-event copies collapse to one digest entry («یک خبر، چند منبع»).
    const collapsed = collapseEventGroups(matched);
    const qualifying = collapsed.filter((row) => evaluateArticle(row, rule).matches);
    const aiConfig = await getActiveAiConfig();
    const bulletin = resolveBulletinSettings(aiConfig.decisionRules.bulletin);
    const items = pickBulletinItems(qualifying, bulletin.maxItems);

    if (items.length === 0) {
      return { sent: false, itemCount: 0, reason: "no_qualifying_items" as const };
    }

    const intro = await synthesizeBulletinBrief(
      items.map((item) => ({ title: item.title, oneLiner: item.summary, whyItMatters: item.whyItMatters })),
      { model: aiConfig.model, enabled: bulletin.aiIntro, introPrompt: bulletin.introPrompt, maxTokens: bulletin.introMaxTokens },
    );

    const text = buildBulletinMessage({
      settings: bulletin,
      intro,
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        oneLiner: item.summary,
        whyItMatters: item.whyItMatters,
      hashtags: item.hashtags,
        url: item.url,
        importanceScore: item.importanceScore,
        publishedAt: item.publishedAt,
        corroborated: (item.corroborationCount ?? 0) >= 2,
        entityTags: item.entityTags ?? [],
      })),
      generatedAt: new Date(),
      timezone: record.timezone,
    });

    const result = await sendBulletinDelivery({
      text,
      newsIds: items.map((item) => item.id),
      target: record.destination,
      trigger: "manual",
      recordRows: true,
    });

    return {
      sent: result.ok,
      itemCount: items.length,
      reason: result.ok ? null : ("delivery_failed" as const),
    };
  });

  if (!outcome.ok) {
    return dbErrorResponse(outcome.error, "ارسال بولتن موجودیت ناموفق بود.", outcome.repair);
  }

  return Response.json({ success: true, ...outcome.value });
}
