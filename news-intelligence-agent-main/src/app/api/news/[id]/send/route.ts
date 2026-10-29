import { sendNewsDelivery } from "@/lib/delivery";
import type { DeliveryTarget } from "@/lib/delivery/types";
import { isDeliveryTarget } from "@/lib/delivery/types";

export const dynamic = "force-dynamic";

type RouteParams = {
  params: Promise<{ id: string }> | { id: string };
};

const STATUS_LABEL: Record<string, string> = {
  sent: "موفق",
  failed: "ناموفق",
  already_sent: "قبلاً ارسال شده",
};

/**
 * POST /api/news/[id]/send
 * body: { destination: "local" | "bale" | "both" }   (default: "local")
 *
 * Dashboard -> this route -> delivery service -> Local | Bale.
 * The client never calls Bale directly, and no secret is ever returned.
 */
export async function POST(request: Request, routeContext: RouteParams) {
  try {
    const resolved =
      "then" in routeContext.params ? await routeContext.params : routeContext.params;
    const id = resolved.id;

    if (!id || typeof id !== "string") {
      return Response.json(
        { success: false, code: "invalid_id", message: "شناسه خبر معتبر نیست." },
        { status: 400 },
      );
    }

    let destination: DeliveryTarget = "local";
    try {
      const body = (await request.json()) as { destination?: unknown };
      if (body?.destination !== undefined) {
        if (!isDeliveryTarget(body.destination)) {
          return Response.json(
            { success: false, code: "invalid_destination", message: "مقصد ارسال معتبر نیست." },
            { status: 400 },
          );
        }
        destination = body.destination;
      }
    } catch {
      // Empty/absent body falls back to the safe default (local).
    }

    const result = await sendNewsDelivery(id, destination);

    if (!result.ok) {
      return Response.json({
        success: false,
        code: result.code,
        message: result.message,
        detail: result.detail ?? null,
      });
    }

    return Response.json({
      success: true,
      message: result.message,
      results: result.results.map((entry) => ({
        destination: entry.destination,
        status: entry.status,
        ok: entry.ok,
        label: STATUS_LABEL[entry.status] ?? entry.status,
        errorMessage: entry.errorMessage,
      })),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[news-send] unexpected route error:", detail.slice(0, 200));

    return Response.json(
      {
        success: false,
        code: "unknown_error",
        message: "خطای ناشناخته در زمان ارسال خبر.",
        detail: null,
      },
      { status: 500 },
    );
  }
}
