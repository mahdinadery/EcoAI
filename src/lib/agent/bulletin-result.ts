import type { ScheduleBulletinSummary } from "./schedule.ts";

export type BulletinDestinationOutcome = {
  destination: "local" | "bale";
  summary: ScheduleBulletinSummary;
};

/** A local success cannot hide a failed Bale send. Empty destinations do not
 * make an otherwise successful run fail, but are explicitly reported. */
export function summarizeBulletinOutcomes(outcomes: BulletinDestinationOutcome[]): ScheduleBulletinSummary {
  const attempted = outcomes.filter(({ summary }) => summary.itemCount > 0);
  const failed = outcomes.find(({ summary }) => summary.reason === "delivery_failed");
  const sent = attempted.length > 0 && !failed;
  return {
    attempted: true,
    sent,
    itemCount: Math.max(0, ...outcomes.map(({ summary }) => summary.itemCount)),
    reason: failed ? "delivery_failed" : sent ? null : outcomes[0]?.summary.reason ?? "nothing_new",
    destinations: outcomes.map(({ destination, summary }) => ({
      destination,
      sent: summary.sent,
      reason: summary.reason,
      ...(summary.destinations?.[0]?.detail ? { detail: summary.destinations[0].detail } : {}),
    })),
  };
}
