/**
 * Shared delivery contracts (Milestone 5).
 *
 * Ingestion -> Analysis -> Delivery are deliberately separate stages. Nothing in
 * this layer can be triggered by the AI analysis step.
 */

export const DELIVERY_DESTINATIONS = ["local", "bale"] as const;
export const DELIVERY_STATUSES = ["pending", "sent", "failed"] as const;
export const DELIVERY_TARGETS = [...DELIVERY_DESTINATIONS, "both"] as const;

export type DeliveryDestination = (typeof DELIVERY_DESTINATIONS)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryTarget = (typeof DELIVERY_TARGETS)[number];

/*
 * Milestone 8 — publishing lifecycle, stored in the SAME `deliveries.status`
 * column (no parallel publishing table). "pending"/"sent"/"failed" keep their
 * existing meaning so pre-M8 rows stay valid: a completed attempt is still
 * "sent"/"failed"; the new values only describe an OPEN candidate.
 */
export const PUBLISHING_STATUSES = [
  "pending_approval",
  "approved",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;

export type PublishingStatus = (typeof PUBLISHING_STATUSES)[number];

/** Statuses that count as an OPEN candidate (one per news+destination). */
export const OPEN_CANDIDATE_STATUSES = ["pending_approval", "approved"] as const;

export const PUBLISHING_STATUS_LABELS: Record<PublishingStatus | "pending", string> = {
  pending: "در انتظار ثبت",
  pending_approval: "در انتظار تأیید",
  approved: "تأییدشده",
  sending: "در حال ارسال",
  sent: "ارسال‌شده",
  failed: "ناموفق",
  cancelled: "لغوشده",
};

export const PUBLISHING_STATUS_TONES: Record<PublishingStatus | "pending", "muted" | "warning" | "success" | "danger"> = {
  pending: "muted",
  pending_approval: "warning",
  approved: "warning",
  sending: "warning",
  sent: "success",
  failed: "danger",
  cancelled: "muted",
};

export const DELIVERY_EVENT_LABELS: Record<string, string> = {
  created: "ایجاد نامزد ارسال",
  approved: "تأیید شد",
  rejected: "رد شد",
  edited: "متن پیام ویرایش شد",
  override: "تغییر دستی نظر هوش مصنوعی",
  send_started: "شروع ارسال",
  sent: "ارسال موفق",
  failed: "ارسال ناموفق",
  retry: "تلاش مجدد",
  cancelled: "لغو شد",
};

export function isPublishingStatus(value: unknown): value is PublishingStatus {
  return typeof value === "string" && (PUBLISHING_STATUSES as readonly string[]).includes(value);
}

/** Label lookup tolerant of legacy/unknown values stored before M8. */
export function publishStatusLabel(status: string): string {
  return PUBLISHING_STATUS_LABELS[status as PublishingStatus | "pending"] ?? status;
}

export function publishingStatusTone(status: string): "muted" | "warning" | "success" | "danger" {
  return PUBLISHING_STATUS_TONES[status as PublishingStatus | "pending"] ?? "muted";
}

/** True when a status represents a candidate that can still be acted upon. */
export function isOpenCandidate(status: string): boolean {
  return (OPEN_CANDIDATE_STATUSES as readonly string[]).includes(status);
}

/** Outcome of a single provider call, before persistence. */
export type ProviderOutcome = {
  ok: boolean;
  /** Provider-side id, kept for admin visibility only. */
  providerMessageId: string | null;
  /** Safe, secret-free description of what went wrong. */
  errorMessage: string | null;
};

/** Per-destination result returned to the UI. */
export type DestinationResult = {
  destination: DeliveryDestination;
  status: DeliveryStatus | "already_sent";
  ok: boolean;
  errorMessage: string | null;
};

export type DeliverySendResult =
  | {
      ok: true;
      message: string;
      results: DestinationResult[];
    }
  | {
      ok: false;
      code: string;
      message: string;
      detail?: string | null;
    };

export function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  return typeof value === "string" && (DELIVERY_TARGETS as readonly string[]).includes(value);
}

/** "both" expands into the two concrete destinations. */
export function expandTargets(target: DeliveryTarget): DeliveryDestination[] {
  return target === "both" ? [...DELIVERY_DESTINATIONS] : [target];
}
