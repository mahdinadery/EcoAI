import { getTelegramConfigStatus, getTelegramDeliveryMode, isTelegramMirrorEnabled, sendTelegramMessageWithChunks } from "@/lib/telegram/client";
import { lastTelegramError, telegramDeliveryStats, telegramMirrorHealth } from "@/lib/delivery/telegram";

export const dynamic = "force-dynamic";

const TEST_MESSAGE =
  "سلام! این یک پیام آزمایشی از «دستیار هوشمند اقتصاد هوش مصنوعی» است. اگر این پیام را می‌بینید، اتصال تلگرام درست کار می‌کند ✓";

/**
 * GET/POST /api/telegram/test
 *
 * Telegram is a mirror of Bale, so this is the one place to check it by hand:
 *   GET  -> configuration status + delivery counters (never sends)
 *   POST -> one real test message through the same Markdown -> HTML path a
 *           news delivery uses
 *
 * The bot token stays on the server; only a safe, redacted result is returned.
 */
export async function GET() {
  const status = getTelegramConfigStatus();
  const stats = await telegramDeliveryStats();
  const lastError = await lastTelegramError();

  return Response.json({
    success: true,
    configured: status.configured,
    missing: status.missing,
    mirrorEnabled: isTelegramMirrorEnabled(),
    deliveryMode: getTelegramDeliveryMode(),
    sent: stats.sent,
    failed: stats.failed,
    lastError,
    // After repeated timeouts/network errors the mirror pauses briefly so a
    // blocked Telegram can never slow the Bale queue down.
    health: telegramMirrorHealth(),
    hint: status.configured
      ? "هر پیامی که به بله می‌رود خودکار به تلگرام هم کپی می‌شود (TELEGRAM_MIRROR_ENABLED=false آن را خاموش می‌کند)."
      : "TELEGRAM_BOT_TOKEN (از @BotFather) و TELEGRAM_CHAT_ID (نام کاربری کانال یا شناسهٔ -100…) را در محیط سرور تنظیم کنید و بات را ادمین کانال کنید.",
  });
}

export async function POST() {
  try {
    if (!isTelegramMirrorEnabled()) {
      const status = getTelegramConfigStatus();
      return Response.json({
        ok: false,
        kind: status.configured ? "disabled" : "not_configured",
        message: status.configured
          ? "آینهٔ تلگرام با TELEGRAM_MIRROR_ENABLED خاموش شده است."
          : `تنظیمات تلگرام کامل نیست: ${status.missing.join(", ")}`,
        missing: status.missing,
      });
    }

    if (getTelegramDeliveryMode() === "dry-run") {
      return Response.json({
        ok: true,
        dryRun: true,
        mode: "dry-run",
        messageId: null,
        message: "حالت آزمایشی است (TELEGRAM_DELIVERY_MODE=dry-run)؛ شبکه فراخوانی نشد.",
      });
    }

    const result = await sendTelegramMessageWithChunks(TEST_MESSAGE);

    if (result.ok) {
      return Response.json({ ok: true, dryRun: false, mode: "live", messageId: result.messageId });
    }

    return Response.json({
      ok: false,
      dryRun: false,
      mode: "live",
      kind: result.kind,
      message: result.message,
      detail: result.detail ?? null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[telegram-test] unexpected error:", detail.slice(0, 200));
    return Response.json(
      { ok: false, kind: "unknown_error", message: "خطای ناشناخته در زمان تست تلگرام.", detail: null },
      { status: 500 },
    );
  }
}
