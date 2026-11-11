/** One ordered automatic article queue shared by cron and manual batch actions. */
import { db } from "@/db";
import { news } from "@/db/schema";
import { runAutoDeliveryPass, type AutoPassResult } from "@/lib/agent";
import { resolveAutoSendRule } from "@/lib/agent/resolve-rule";
import type { AutoSendRule } from "@/lib/agent/rules";
import { asc, sql } from "drizzle-orm";
import { analyzeSequentially, applyTopicGate, recoverStaleProcessing, type QueuedAnalysisResult } from "./analysis-queue";
import { withArticleQueueLock } from "./queue-lock";

export type ArticleQueueResult = {
  busy: boolean;
  selected: number;
  skipped: string[];
  analyzed: QueuedAnalysisResult[];
  send: AutoPassResult;
  blocked: string | null;
};

/**
 * Serialize automatic workers across app instances. An older failed or in-flight
 * article blocks newer ones, so retry never silently changes the arrival order.
 * Limits bound each request, not the persistent queue. Manual individual actions
 * remain explicit operator overrides.
 */
export async function drainArticleQueue(options: {
  limit: number;
  maxDurationMs: number;
  rule?: AutoSendRule;
}): Promise<ArticleQueueResult> {
  const emptySend: AutoPassResult = {
    enabled: false, destination: "", considered: 0, matched: 0, sent: 0,
    skippedDuplicates: 0, skippedReview: 0, failed: 0, items: [],
  };
  const empty: ArticleQueueResult = { busy: false, selected: 0, skipped: [], analyzed: [], send: emptySend, blocked: null };
  const locked = await withArticleQueueLock(async () => {
    const result: ArticleQueueResult = { ...empty, send: { ...emptySend, items: [] } };
    const rule = options.rule ?? await resolveAutoSendRule();
    const started = Date.now();
    await recoverStaleProcessing();

    while (Date.now() - started < options.maxDurationMs) {
      // Flush older analyzed papers before selecting the next arrival. The
      // delivery selector stops at the earliest unresolved analysis.
      const pass = await runAutoDeliveryPass({ rule, queueLockHeld: true });
      result.send.enabled = pass.enabled;
      result.send.destination = pass.destination;
      result.send.considered += pass.considered;
      result.send.matched += pass.matched;
      result.send.sent += pass.sent;
      result.send.skippedDuplicates += pass.skippedDuplicates;
      result.send.skippedReview += pass.skippedReview;
      result.send.failed += pass.failed;
      result.send.items.push(...pass.items);
      if (pass.failed > 0) {
        result.blocked = pass.items.find((item) => item.errors?.length)?.errors?.join(" | ") ?? "ارسال مقاله ناموفق بود";
        break;
      }
      if (pass.sent > 0) continue;
      if (result.selected >= options.limit || Date.now() - started >= options.maxDurationMs) break;

      const [next] = await db.select({ id: news.id, status: news.status }).from(news)
        .where(sql`${news.analyzedAt} IS NULL AND ${news.status} IN ('FETCHED', 'READY_FOR_AI', 'AI_PROCESSING', 'FAILED')`)
        .orderBy(asc(news.createdAt), asc(news.id)).limit(1);
      if (!next) break;
      if (next.status === "AI_PROCESSING") {
        result.blocked = "مقالهٔ قدیمی‌تر در حال تحلیل است؛ صف منتظر پایان آن می‌ماند.";
        break;
      }
      result.selected += 1;
      const gated = await applyTopicGate([next.id]);
      if (gated.skipped.length) {
        result.skipped.push(next.id);
        continue;
      }
      if (!gated.pass.length) {
        result.blocked = "مقالهٔ ابتدای صف در دسترس نیست؛ تلاش بعدی آن را بررسی می‌کند.";
        break;
      }
      const [analysis] = await analyzeSequentially([next.id], { concurrency: 1, maxDurationMs: options.maxDurationMs });
      if (!analysis) break;
      result.analyzed.push(analysis);
      if (!analysis.ok) {
        result.blocked = `${analysis.message ?? analysis.code ?? "تحلیل ناموفق بود"}${analysis.detail ? ` (${analysis.detail.slice(0, 160)})` : ""}`;
        break;
      }
    }
    return result;
  });
  return locked.acquired ? locked.value : { ...empty, busy: true, blocked: "پردازش صف دیگری در حال اجرا است." };
}
