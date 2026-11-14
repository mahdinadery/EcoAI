import { explainAutoSendSkip, runAutoDeliveryPass, type AutoSendSkip } from "./index";
import { describeRejectionReasons } from "./rejection-reasons";
import { resolveAutoSendRule } from "./resolve-rule";

/**
 * Shared, failure-proof hook so the auto-delivery pass can run after an event
 * (papers fetched, or a paper analyzed) without ever breaking that flow.
 *
 * Unlike a breaking-news ticker, every relevant & important research paper is
 * delivered individually (never held back behind a 5-item bulletin cap).
 */

export type AutoSendSummary = {
  attempted: boolean;
  enabled: boolean;
  destination: string;
  considered: number;
  matched: number;
  sent: number;
  skippedDuplicates: number;
  skippedReview: number;
  failed: number;
  heldForBulletin?: boolean;
  firstError?: string | null;
  firstRejectionReason?: string | null;
  /**
   * Precise, article-scoped answer to "why was nothing sent?" — only computed
   * when the caller names the article it cares about (`explainFor`).
   */
  explanation?: AutoSendSkip | null;
};

function disabled(destination = "", enabled = true): AutoSendSummary {
  return {
    attempted: false,
    enabled,
    destination,
    considered: 0,
    matched: 0,
    sent: 0,
    skippedDuplicates: 0,
    skippedReview: 0,
    failed: 0,
    heldForBulletin: false,
    firstError: null,
    firstRejectionReason: null,
    explanation: null,
  };
}

export async function maybeRunAutoSend(
  newsIds?: string[],
  options: { queueLockHeld?: boolean; /** explain why THIS article was not delivered */ explainFor?: string } = {},
): Promise<AutoSendSummary> {
  try {
    const rule = await resolveAutoSendRule();
    const result = await runAutoDeliveryPass({ newsIds, rule, queueLockHeld: options.queueLockHeld });
    if (result.busy)
      return {
        ...disabled(rule.destination, rule.enabled),
        firstError: "صف در حال پردازش است؛ نوبت بعد دوباره تلاش می‌شود.",
      };
    const firstFailed = result.items.find((item) => item.outcome === "failed" && item.errors?.length);
    const firstRejected = result.items.find(
      (item) => (item.outcome === "not_matched" || item.outcome === "skipped_review") && item.reasons?.length,
    );
    // Nothing moved and the caller cares about one concrete article: ask the
    // engine why, so the UI never has to guess with a catch-all sentence.
    const explanation =
      options.explainFor && result.matched === 0 && result.enabled && result.failed === 0
        ? await explainAutoSendSkip(options.explainFor)
        : null;

    return {
      attempted: true,
      enabled: result.enabled,
      destination: result.destination,
      considered: result.considered,
      matched: result.matched,
      sent: result.sent,
      skippedDuplicates: result.skippedDuplicates,
      skippedReview: result.skippedReview,
      failed: result.failed,
      heldForBulletin: false,
      firstError: firstFailed?.errors?.[0] ?? null,
      firstRejectionReason: firstRejected ? describeRejectionReasons(firstRejected.reasons) : null,
      explanation,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[agent] auto-send pass failed:", detail.slice(0, 160));
    return disabled();
  }
}
