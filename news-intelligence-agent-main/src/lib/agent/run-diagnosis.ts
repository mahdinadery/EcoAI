/**
 * Plain-language explanation of a scheduled run — shared by the dashboard.
 *
 * This module is intentionally dependency-free so it can be imported by a
 * client component and unit-tested with the Node test runner.
 */

export type RunDiagnosisLevel = "success" | "warning" | "error" | "info";

export type RunDiagnosis = {
  level: RunDiagnosisLevel;
  title: string;
  hints: string[];
};

export type RunSummaryLike = {
  ingest?: { created?: number; failed?: number; sources?: number; detail?: string } | null;
  analysis?: { selected?: number; analyzed?: number; failed?: number; skippedOfftopic?: number } | null;
  send?: {
    destination?: string;
    considered?: number;
    matched?: number;
    sent?: number;
    failed?: number;
    skippedDuplicates?: number;
    skippedReview?: number;
  } | null;
  errors?: string[] | null;
};

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Turns the persisted run summary into one clear line plus actionable hints.
 *
 * Returns `null` when nothing has run yet (the card already says so), and
 * deliberately avoids claiming success for a run that sent nothing.
 */
export function diagnoseRunSummary(summary: RunSummaryLike | null | undefined): RunDiagnosis | null {
  if (!summary) return null;

  const ingest = summary.ingest ?? null;
  const analysis = summary.analysis ?? null;
  const send = summary.send ?? null;

  if (count(send?.failed) > 0) {
    return {
      level: "error",
      title: `ارسال ${count(send?.failed)} خبر به مقصد ناموفق بود.`,
      hints: [
        "کارت «اتصال به بله» را باز کنید و «بررسی کانال» را بزنید.",
        "متن دقیق خطا در بخش «خطاهای آخرین اجرا» آمده است.",
      ],
    };
  }

  if (send && send.destination === "local" && count(send.sent) > 0) {
    return {
      level: "warning",
      title: `${count(send.sent)} خبر فقط در صندوق محلی ثبت شد و به بله نرفت.`,
      hints: [
        "در کارت زمان‌بندی، «مقصد ارسال خودکار» را روی «بله (کانال/چت)» بگذارید و ذخیره کنید.",
      ],
    };
  }

  if (count(send?.sent) > 0) {
    return {
      level: "success",
      title: `${count(send?.sent)} خبر با موفقیت به مقصد ارسال شد.`,
      hints: [],
    };
  }

  if (ingest && count(ingest.failed) > 0 && count(ingest.created) === 0) {
    return {
      level: "error",
      title: "دریافت خبر از منابع ناموفق بود.",
      hints: [
        "اگر سرور خارج از ایران است، NEWS_FETCH_PROXY_URL را تنظیم کنید.",
        "یا از «ورود دستی RSS» برای افزودن فیدها استفاده کنید.",
      ],
    };
  }

  if (ingest && typeof ingest.sources === "number" && ingest.sources === 0) {
    return {
      level: "warning",
      title: "هیچ منبع خبری فعالی وجود ندارد.",
      hints: [
        "از صفحه «منابع خبری» بستهٔ اعتبارسنجی را اعمال کنید یا یک فید RSS اضافه کنید.",
      ],
    };
  }

  if (analysis && count(analysis.failed) > 0 && count(analysis.analyzed) === 0) {
    return {
      level: "error",
      title: "تحلیل هوش مصنوعی انجام نشد؛ خبری برای ارسال آماده نشد.",
      hints: [
        "AI_API_KEY و در صورت نیاز AI_API_BASE_URL / AI_API_MODEL را در میزبان بررسی کنید.",
        "از صفحه «پیکربندی AI» یک خبر را دستی تحلیل کنید تا متن خطا را ببینید.",
      ],
    };
  }

  if (send && count(send.considered) === 0) {
    return {
      level: "info",
      title: "خبر آمادهٔ ارسالی وجود نداشت.",
      hints: [
        "یا خبر تازه‌ای دریافت نشده، یا هنوز تحلیل نشده، یا قبلاً به همین مقصد ارسال شده است.",
        "برای بررسی فوری، «اجرای فوری چرخه کامل» را بزنید و خروجی همین کارت را ببینید.",
      ],
    };
  }

  if (send && count(send.matched) === 0) {
    return {
      level: "warning",
      title: "هیچ خبری از حد نصاب‌های ارسال عبور نکرد.",
      hints: [
        "در «تنظیمات پیشرفته» حداقل اهمیت یا مرتبط بودن را کمی کاهش دهید.",
        "بررسی کنید خبرهای تحلیل‌شده به موضوعات بستهٔ اعتبارسنجی مربوط باشند.",
      ],
    };
  }

  if (send && count(send.skippedReview) > 0) {
    return {
      level: "warning",
      title: "خبر واجد شرایط در انتظار تأیید دستی است؛ ارسال خودکار منتظر ماند.",
      hints: ["خبرهای در انتظار تأیید را از بخش ارسال‌ها بررسی و تأیید کنید."],
    };
  }

  if (count(send?.sent) === 0) {
    return {
      level: "info",
      title: "اجرا کامل شد، اما خبر واجد شرایطی برای ارسال نبود.",
      hints: ["نوبت بعدی طبق زمان‌بندی دوباره بررسی می‌شود."],
    };
  }

  return null;
}
