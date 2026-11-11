import { db } from "@/db";
import { deliveries } from "@/db/schema";
import { deliverToBale } from "@/lib/delivery/bale";
import { and, eq, sql } from "drizzle-orm";
import { accessDenied, resolveId, type RouteContext } from "../../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Explicit operator recovery of a local-only message; never auto-publish history. */
export async function POST(request: Request, context: RouteContext) {
  const denied = accessDenied(request);
  if (denied) return denied;
  const id = await resolveId(context);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ success: false, message: "شناسه ارسال نامعتبر است." }, { status: 400 });
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [original] = await tx.select().from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.destination, "local"), eq(deliveries.status, "sent"))).limit(1);
      if (!original?.message?.trim()) return { success: false, message: "پیام محلی یافت نشد." };
      const message = original.message;
      // Serialize explicit recovery attempts for the same message across app instances.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${message}, 0))`);
      const [sent] = await tx.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.destination, "bale"), eq(deliveries.status, "sent"), eq(deliveries.message, message))).limit(1);
      if (sent) return { success: false, message: "این متن قبلاً به بله ارسال شده است." };
      const rows = await tx.select({ newsId: deliveries.newsId }).from(deliveries).where(and(eq(deliveries.destination, "local"), eq(deliveries.status, "sent"), eq(deliveries.message, message)));
      const outcome = await deliverToBale(message);
      const ids = outcome.ok ? [...new Set(rows.map((row) => row.newsId))] : [original.newsId];
      await tx.insert(deliveries).values(ids.map((newsId) => ({ newsId, destination: "bale", status: outcome.ok ? "sent" : "failed", triggeredBy: "manual", message, errorMessage: outcome.errorMessage, providerMessageId: outcome.providerMessageId, sentAt: outcome.ok ? new Date() : null })));
      return outcome.ok
        ? { success: true, message: "ارسال به بله تأیید شد." }
        : { success: false, message: `ارسال به بله تأیید نشد: ${outcome.errorMessage ?? "خطای ناشناخته"}. پیش از تلاش دوباره کانال بله را بررسی کنید.` };
    });
    return Response.json(result, { status: result.success ? 200 : 400 });
  } catch (error) {
    console.error("[forward-bale]", String(error).slice(0, 200));
    return Response.json({ success: false, message: "ثبت نتیجه قطعی نیست؛ قبل از تلاش دوباره کانال بله را بررسی کنید." }, { status: 500 });
  }
}
