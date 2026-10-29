import { runAutoDeliveryPass } from "@/lib/agent";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/auto-send
 *
 * Runs one auto-delivery pass over already-analyzed news and sends every article
 * matching the configured rule. Optional body: { "force": true } to evaluate the
 * rule as passed for the selected candidates (manual catch-up override).
 */
export async function POST(request: Request) {
  try {
    let force = false;
    try {
      const body = (await request.json()) as { force?: unknown };
      force = body?.force === true;
    } catch {
      // Empty body is fine: run the standard rule.
    }

    const result = await runAutoDeliveryPass({ force });

    return Response.json({ success: true, ...result });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[agent-auto-send] unexpected error:", detail.slice(0, 200));

    return Response.json(
      {
        success: false,
        code: "unknown_error",
        message: "اجرای ارسال خودکار ناموفق بود.",
        detail: null,
      },
      { status: 500 },
    );
  }
}
