import { checkAdminAccess } from "@/lib/admin/access";
import { maybeRunAutoSend } from "@/lib/agent/auto-hook";
import {
  analyzeSequentially,
  applyTopicGate,
  recoverStaleProcessing,
  selectAnalysisBacklog,
} from "@/lib/news/analysis-queue";
import { runDueSources } from "@/lib/news/source-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_DRAIN_PER_DUE_TICK = 12;

/**
 * POST /api/admin/news-sources/run-due
 *
 * Fetches every ACTIVE rss source whose `fetchIntervalMinutes` has elapsed,
 * then drains a bounded parallel batch (`MAX_DRAIN_PER_DUE_TICK = 12`, max 46s,
 * 4 concurrent workers) of pending `READY_FOR_AI` papers so the 15-minute
 * `scheduled-ingest` cron drains ~48 papers/hour automatically.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  try {
    const result = await runDueSources();

    await recoverStaleProcessing();
    const backlogIds = await selectAnalysisBacklog(MAX_DRAIN_PER_DUE_TICK);
    const gated = await applyTopicGate(backlogIds);
    const analyzedResults =
      gated.pass.length > 0
        ? await analyzeSequentially(gated.pass, { concurrency: 4, maxDurationMs: 46_000 })
        : [];
    const analyzedIds = analyzedResults.filter((item) => item.ok).map((item) => item.id);
    const autoSend = analyzedIds.length > 0 ? await maybeRunAutoSend(analyzedIds) : null;

    return Response.json({
      success: true,
      ...result,
      drained: {
        selected: backlogIds.length,
        analyzed: analyzedIds.length,
        topicSkipped: gated.skipped.length,
        autoSent: autoSend?.sent ?? 0,
      },
    });
  } catch (error) {
    console.error("[news-sources] run-due failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "اجرای دریافت زمان‌بندی‌شده ناموفق بود." }, { status: 500 });
  }
}
