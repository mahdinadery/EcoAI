/**
 * News processing lifecycle (Milestone 6).
 *
 * The lifecycle is the single `status` column on `news` (the spec's
 * "processingStatus" concept was merged into it deliberately — two parallel
 * state machines would drift apart). Values flow:
 *
 *   FETCHED -> NORMALIZED -> READY_FOR_AI -> AI_ANALYZED -> READY_TO_SEND -> SENT
 *                      \-> DUPLICATE (marked, references the original)
 *                      \-> SKIPPED_OFFTOPIC (stored, filtered before AI; re-queueable)
 *   any stage failure  -> FAILED (retryable)
 *
 * The current pipeline stores directly at READY_FOR_AI (fetch+normalize happen
 * in one pass) and FETCHED/NORMALIZED are reserved for future split stages.
 */

export type NewsStatus =
  | "FETCHED"
  | "NORMALIZED"
  | "DUPLICATE"
  | "SKIPPED_OFFTOPIC"
  | "READY_FOR_AI"
  | "AI_PROCESSING"
  | "AI_ANALYZED"
  | "READY_TO_SEND"
  | "SENT"
  | "FAILED";

export const NEWS_STATUSES: NewsStatus[] = [
  "FETCHED",
  "NORMALIZED",
  "DUPLICATE",
  "SKIPPED_OFFTOPIC",
  "READY_FOR_AI",
  "AI_PROCESSING",
  "AI_ANALYZED",
  "READY_TO_SEND",
  "SENT",
  "FAILED",
];

export const NEWS_STATUS_LABELS: Record<NewsStatus, string> = {
  FETCHED: "دریافت‌شده",
  NORMALIZED: "نجارسازی‌شده",
  DUPLICATE: "تکراری",
  SKIPPED_OFFTOPIC: "خارج از موضوع",
  READY_FOR_AI: "آماده تحلیل AI",
  AI_PROCESSING: "در حال تحلیل AI",
  AI_ANALYZED: "تحلیل‌شده",
  READY_TO_SEND: "آماده ارسال",
  SENT: "ارسال‌شده",
  FAILED: "خطا",
};

export type StatusTone = "success" | "warning" | "danger" | "muted";

export const NEWS_STATUS_TONES: Record<NewsStatus, StatusTone> = {
  FETCHED: "muted",
  NORMALIZED: "muted",
  DUPLICATE: "muted",
  SKIPPED_OFFTOPIC: "muted",
  READY_FOR_AI: "warning",
  AI_PROCESSING: "warning",
  AI_ANALYZED: "success",
  READY_TO_SEND: "success",
  SENT: "success",
  FAILED: "danger",
};

export type SourceHealth = "healthy" | "warning" | "failed" | "paused";

export const SOURCE_HEALTH_LABELS: Record<SourceHealth, string> = {
  healthy: "سالم",
  warning: "هشدار",
  failed: "متوقف/خطا",
  paused: "غیرفعال",
};

export const SOURCE_HEALTH_TONES: Record<SourceHealth, StatusTone> = {
  healthy: "success",
  warning: "warning",
  failed: "danger",
  paused: "muted",
};
