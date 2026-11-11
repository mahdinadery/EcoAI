import { checkAdminAccess } from "@/lib/admin/access";
import { drainArticleQueue } from "@/lib/news/article-queue";
import { runDueSources } from "@/lib/news/source-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_DRAIN_PER_DUE_TICK = 12;

/**
 * POST /api/admin/news-sources/run-due
 *
 * Fetches every ACTIVE rss source whose `fetchIntervalMinutes` has elapsed,
 * then drains a bounded FIFO batch of articles, stopping on a failed older
 * article so newer articles do not overtake it.
 */
export async function POST(request: Request) {
  const access = checkAdminAccess(request);
  if (!access.authorized) {
    return Response.json({ success: false, message: access.reason }, { status: 401 });
  }

  try {
    const result = await runDueSources();

    const queue = await drainArticleQueue({ limit: MAX_DRAIN_PER_DUE_TICK, maxDurationMs: 28_000 });

    return Response.json({
      success: true,
      ...result,
      drained: {
        selected: queue.selected,
        analyzed: queue.analyzed.filter((item) => item.ok).length,
        topicSkipped: queue.skipped.length,
        autoSent: queue.send.sent,
        busy: queue.busy,
        blocked: queue.blocked,
      },
    });
  } catch (error) {
    console.error("[news-sources] run-due failed:", (error instanceof Error ? error.message : String(error)).slice(0, 200));
    return Response.json({ success: false, message: "اجرای دریافت زمان‌بندی‌شده ناموفق بود." }, { status: 500 });
  }
}
