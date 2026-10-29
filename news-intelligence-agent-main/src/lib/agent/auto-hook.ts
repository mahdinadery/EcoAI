import { expandTargets, type DeliveryTarget } from "@/lib/delivery/types";
import { runAutoDeliveryPass } from "./index";
import { resolveAutoSendRule } from "./resolve-rule";
import { readScheduleRecord } from "./schedule-store";

/**
 * Shared, failure-proof hook so the auto-delivery pass can run after an event
 * (news fetched, or an article analyzed) without ever breaking that flow.
 *
 * The delivery pass is fire-and-report: it returns a compact summary for the UI,
 * and any error is swallowed into `attempted: false` rather than thrown, so an
 * unreachable provider can never fail the analysis/ingestion response.
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
  };
}

/**
 * «فقط بولتن» (hold_all): while the schedule is enabled in bulletin mode, a
 * per-item auto send to an overlapping destination must wait for the digest —
 * otherwise this post-analysis hook leaks singles and the digest later finds
 * nothing left to pack (the "bulletin doesn't work" symptom).
 */
async function holdsForBulletin(destination: DeliveryTarget): Promise<boolean> {
  try {
    const record = await readScheduleRecord();
    if (!record.enabled || record.publishMode !== "bulletin") return false;
    const held = new Set(expandTargets(record.destination));
    return expandTargets(destination).some((target) => held.has(target));
  } catch {
    return false;
  }
}

export async function maybeRunAutoSend(newsIds?: string[]): Promise<AutoSendSummary> {
  try {
    const rule = await resolveAutoSendRule();
    if (rule.enabled && (await holdsForBulletin(rule.destination))) {
      return disabled(rule.destination, false);
    }
    const result = await runAutoDeliveryPass({ newsIds, rule });

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
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[agent] auto-send pass failed:", detail.slice(0, 160));
    return disabled();
  }
}
