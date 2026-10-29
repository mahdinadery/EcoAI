import { dispatchBaleMessage, getDeliveryMode } from "@/lib/bale/dispatcher";

export const dynamic = "force-dynamic";

const TEST_MESSAGE =
  "سلام! این یک پیام آزمایشی از دستیار هوشمند اخبار است. اتصال به بله با موفقیت برقرار شد.";

/**
 * POST /api/bale/test
 *
 * Dashboard -> this route -> dispatcher -> (Bale Bot API | local outbox).
 * The bot token stays on the server; only a safe result is returned.
 */
export async function POST() {
  try {
    const result = await dispatchBaleMessage(TEST_MESSAGE);

    if (result.ok) {
      return Response.json({
        ok: true,
        dryRun: result.dryRun,
        mode: getDeliveryMode(),
        messageId: result.messageId,
      });
    }

    // Handled failure: 200 + ok:false keeps client error handling predictable.
    return Response.json({
      ok: false,
      dryRun: false,
      mode: getDeliveryMode(),
      kind: result.kind,
      message: result.message,
      detail: result.detail ?? null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[bale-test] unexpected error:", detail);

    return Response.json(
      {
        ok: false,
        dryRun: false,
        mode: getDeliveryMode(),
        kind: "unknown_error",
        message: "Unexpected error while sending the Bale test message.",
        detail: null,
      },
      { status: 500 },
    );
  }
}
