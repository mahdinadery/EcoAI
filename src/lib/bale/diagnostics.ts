/**
 * Bale channel diagnostics — SERVER-SIDE ONLY.
 *
 * Answers the only question that matters when "news never reached the channel":
 * is the configured bot actually able to post to the configured chat?
 *
 * The checks are intentionally read-only (`getMe` → `getChat` →
 * `getChatMember`). Nothing is sent here; the "test connection" button remains
 * the final proof. Every value returned to the browser is safe: the token is
 * never included and the chat id is masked.
 */

import { callBaleApi } from "./client";
import { getDeliveryMode } from "./dispatcher";

export type BaleCheckStatus = "ok" | "warning" | "error" | "skipped";

export type BaleCheckId =
  | "token"
  | "chat_id"
  | "delivery_mode"
  | "bot"
  | "chat"
  | "membership"
  | "post_rights";

export type BaleCheck = {
  id: BaleCheckId;
  title: string;
  status: BaleCheckStatus;
  detail?: string;
  hint?: string;
};

export type BaleDiagnostics = {
  checkedAt: string;
  ready: boolean;
  chatIdMasked: string | null;
  deliveryMode: "live" | "dry-run";
  checks: BaleCheck[];
};

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Keeps only the last four characters so the dashboard never prints the full id. */
function maskChatId(value: string): string {
  if (value.length <= 4) return "••••";
  const visible = value.slice(-4);
  const hidden = "•".repeat(Math.min(12, Math.max(4, value.length - 4)));
  return `${hidden}${visible}`;
}

function chatTypeLabel(type: string): string {
  if (type === "channel") return "کانال";
  if (type === "group" || type === "supergroup") return "گروه";
  if (type === "private") return "چت خصوصی";
  return "مقصد";
}

function memberStatusLabel(status: string): string {
  switch (status) {
    case "creator":
      return "سازنده";
    case "administrator":
      return "ادمین";
    case "member":
      return "عضو";
    case "restricted":
      return "محدود";
    case "left":
      return "خارج‌شده";
    case "kicked":
      return "اخراج‌شده";
    default:
      return status;
  }
}

function finish(
  checks: BaleCheck[],
  chatId: string | undefined,
  deliveryMode: "live" | "dry-run",
): BaleDiagnostics {
  return {
    checkedAt: new Date().toISOString(),
    ready: checks.every((check) => check.id === "delivery_mode" || check.status === "ok"),
    chatIdMasked: chatId ? maskChatId(chatId) : null,
    deliveryMode,
    checks,
  };
}

function apiDetail(message: string, detail?: string): string {
  return (detail ? `${message} (${detail})` : message).slice(0, 300);
}

/**
 * Runs the full read-only channel check.
 *
 * Order matters: each step depends on the previous one, so the first failure is
 * returned with a concrete hint instead of a generic "send failed".
 */
export async function diagnoseBaleChannel(): Promise<BaleDiagnostics> {
  const checks: BaleCheck[] = [];
  const token = trimToUndefined(process.env.BALE_BOT_TOKEN);
  const chatId = trimToUndefined(process.env.BALE_CHAT_ID);
  const mode = getDeliveryMode();

  checks.push({
    id: "token",
    title: "توکن ربات (BALE_BOT_TOKEN)",
    status: token ? "ok" : "error",
    detail: token ? "تنظیم شده است." : "تنظیم نشده است.",
    hint: token
      ? undefined
      : "در Environment Variables میزبان مقدار BALE_BOT_TOKEN را ست کنید و سرویس را دوباره deploy کنید.",
  });

  checks.push({
    id: "chat_id",
    title: "شناسهٔ مقصد (BALE_CHAT_ID)",
    status: chatId ? "ok" : "error",
    detail: chatId ? `مقدار تنظیم‌شده: ${maskChatId(chatId)}` : "تنظیم نشده است.",
    hint: chatId
      ? undefined
      : "برای کانال، @username یا آیدی عددی (مثل -100…) و برای چت خصوصی، آیدی عددی کاربر را ست کنید.",
  });

  checks.push({
    id: "delivery_mode",
    title: "حالت پیام آزمایشی",
    status: mode === "dry-run" ? "warning" : "ok",
    detail:
      mode === "dry-run"
        ? "dry-run است: «تست اتصال» فقط در صندوق خروجی محلی ثبت می‌شود و به بله نمی‌رود."
        : "live است: «تست اتصال» واقعاً به بله ارسال می‌شود.",
    hint:
      mode === "dry-run"
        ? "برای تست واقعی، BALE_DELIVERY_MODE را حذف کنید یا روی live بگذارید. ارسال خبرهای زمان‌بندی‌شده همیشه واقعی است."
        : undefined,
  });

  if (!token || !chatId) {
    return finish(checks, chatId, mode);
  }

  // 1) Token validity + the bot's own numeric id (needed by getChatMember).
  const me = await callBaleApi<{ id?: unknown; username?: unknown; first_name?: unknown }>("getMe");
  if (!me.ok) {
    checks.push({
      id: "bot",
      title: "اعتبار توکن ربات",
      status: "error",
      detail: apiDetail(me.message, me.detail),
      hint:
        me.kind === "network_error"
          ? "سرور به tapi.bale.ai دسترسی ندارد؛ اتصال خروجی میزبان را بررسی کنید."
          : "توکن ربات نامعتبر است؛ آن را از BotFather دوباره بگیرید و در میزبان به‌روزرسانی کنید.",
    });
    return finish(checks, chatId, mode);
  }

  const rawBotId = me.result?.id;
  const botId =
    typeof rawBotId === "number"
      ? rawBotId
      : typeof rawBotId === "string" && /^\d+$/.test(rawBotId)
        ? Number(rawBotId)
        : null;

  if (!me.result || botId === null) {
    checks.push({
      id: "bot",
      title: "اعتبار توکن ربات",
      status: "error",
      detail: "پاسخ getMe شناسهٔ ربات را برنگرداند.",
      hint: "پاسخ API بله را بررسی کنید و دوباره تلاش کنید.",
    });
    return finish(checks, chatId, mode);
  }

  const botUsername = typeof me.result.username === "string" ? `@${me.result.username}` : "بدون username";
  checks.push({
    id: "bot",
    title: "اعتبار توکن ربات",
    status: "ok",
    detail: `ربات ${botUsername} شناسایی شد.`,
  });

  // 2) Can this bot see the configured chat at all?
  const chat = await callBaleApi<{
    id?: unknown;
    type?: unknown;
    title?: unknown;
    username?: unknown;
    first_name?: unknown;
  }>("getChat", { chat_id: chatId });

  if (!chat.ok || !chat.result) {
    checks.push({
      id: "chat",
      title: "دسترسی به مقصد",
      status: "error",
      detail: chat.ok ? "پاسخ getChat خالی بود." : apiDetail(chat.message, chat.detail),
      hint:
        !chat.ok && chat.kind === "network_error"
          ? "سرور به tapi.bale.ai دسترسی ندارد؛ اتصال خروجی میزبان را بررسی کنید."
          : "BALE_CHAT_ID درست نیست یا ربات هنوز به کانال/گروه اضافه نشده است. ربات را عضو و در کانال ادمین کنید.",
    });
    return finish(checks, chatId, mode);
  }

  const chatType = typeof chat.result.type === "string" ? chat.result.type : "unknown";
  const chatTitle =
    (typeof chat.result.title === "string" && chat.result.title) ||
    (typeof chat.result.username === "string" && `@${chat.result.username}`) ||
    (typeof chat.result.first_name === "string" && chat.result.first_name) ||
    "بدون عنوان";

  checks.push({
    id: "chat",
    title: "دسترسی به مقصد",
    status: "ok",
    detail: `${chatTypeLabel(chatType)} «${chatTitle}» پیدا شد.`,
  });

  // 3) Bot membership / admin rights in that chat.
  const member = await callBaleApi<{ status?: unknown; can_post_messages?: unknown }>("getChatMember", {
    chat_id: chatId,
    user_id: botId,
  });

  if (!member.ok || !member.result) {
    checks.push({
      id: "membership",
      title: "عضویت/مدیریت ربات در مقصد",
      status: chatType === "channel" ? "error" : "warning",
      detail: member.ok ? "پاسخ getChatMember خالی بود." : apiDetail(member.message, member.detail),
      hint:
        "ربات را به کانال اضافه و به‌عنوان ادمین با دسترسی «ارسال پیام» انتخاب کنید. اگر مقصد گروه است، مطمئن شوید ربات عضو گروه است.",
    });
    return finish(checks, chatId, mode);
  }

  const memberStatus = typeof member.result.status === "string" ? member.result.status : "unknown";
  const isAdmin = memberStatus === "creator" || memberStatus === "administrator";
  const isGone = memberStatus === "left" || memberStatus === "kicked";

  const membershipStatus: BaleCheckStatus =
    chatType === "channel" ? (isAdmin ? "ok" : "error") : isGone ? "error" : memberStatus === "restricted" ? "warning" : "ok";

  checks.push({
    id: "membership",
    title: "عضویت/مدیریت ربات در مقصد",
    status: membershipStatus,
    detail: `وضعیت ربات در مقصد: ${memberStatusLabel(memberStatus)}`,
    hint:
      membershipStatus === "ok"
        ? undefined
        : "ربات را به کانال اضافه و ادمین کنید (با اجازهٔ ارسال پیام). برای گروه، عضویت ربات کافی است.",
  });

  // 4) Channels additionally require the explicit "post messages" admin right.
  if (chatType === "channel" && isAdmin) {
    const canPost = member.result.can_post_messages;
    const canPostKnown = typeof canPost === "boolean";
    checks.push({
      id: "post_rights",
      title: "دسترسی ارسال پیام در کانال",
      status: !canPostKnown ? "warning" : canPost ? "ok" : "error",
      detail: !canPostKnown
        ? "این فیلد در پاسخ بله نیامد؛ با «تست اتصال» تأیید کنید."
        : canPost
          ? "ربات اجازهٔ ارسال پیام دارد."
          : "ربات اجازهٔ ارسال پیام ندارد.",
      hint:
        canPostKnown && canPost === false
          ? "در تنظیمات ادمین کانال، دسترسی «ارسال پیام» را برای ربات فعال کنید."
          : undefined,
    });
  }

  return finish(checks, chatId, mode);
}
