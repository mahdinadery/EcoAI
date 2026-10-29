/**
 * Persian labels for the machine-readable rejection codes produced by
 * `evaluateArticle` (src/lib/agent/rules.ts) and the topic gate.
 *
 * Dependency-free so it can be imported by client components and unit tests.
 */

export const REJECTION_REASON_LABELS: Record<string, string> = {
  not_analyzed: "تحلیل نشده است",
  importance_below_threshold: "اهمیت کمتر از حد نصاب",
  relevance_below_threshold: "مرتبط بودن کمتر از حد نصاب",
  novelty_below_threshold: "تازگی کمتر از حد نصاب",
  ai_no_recommendation: "هوش مصنوعی ارسال را توصیه نکرده است",
  grader_rejected: "ارزیاب دوم: واقعاً مرتبط نیست (گریدر دومرحله‌ای)",
  category_excluded: "دستهٔ خبر در فهرست مجاز نیست",
  pending_manual_review: "در انتظار تأیید دستی است",
};

/** Unknown codes stay visible (never silently swallowed) — useful for debugging. */
export function rejectionReasonLabel(code: string): string {
  return REJECTION_REASON_LABELS[code] ?? code;
}

export function describeRejectionReasons(reasons: string[] | null | undefined): string {
  if (!reasons || reasons.length === 0) return "دلیل ثبت نشده";
  return reasons.map(rejectionReasonLabel).join(" · ");
}
