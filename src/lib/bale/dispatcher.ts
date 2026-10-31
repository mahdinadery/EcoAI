/**
 * Delivery dispatcher — SERVER-SIDE ONLY.
 *
 * Decides where an outgoing message goes:
 *   - `live`    (default): send through the real Bale Bot API
 *   - `dry-run`: skip the network entirely, only record it locally
 *
 * Every attempt is recorded in the local outbox with its true outcome, so a
 * failed real send is never presented as a successful delivery.
 */

import { sendBaleMessage } from "./client";
import { recordOutboxEntry } from "./outbox";

export type DeliveryMode = "live" | "dry-run";

const LIVE_CHANNEL = "بله (Bale Bot API)";
const DRY_RUN_CHANNEL = "صندوق خروجی محلی (آزمایشی)";

export type DispatchResult =
  | { ok: true; dryRun: boolean; messageId: string | null }
  | { ok: false; dryRun: false; kind: string; message: string; detail?: string | null };

export function getDeliveryMode(): DeliveryMode {
  const raw = (process.env.BALE_DELIVERY_MODE ?? "").trim().toLowerCase();
  return raw === "dry-run" || raw === "dryrun" ? "dry-run" : "live";
}

export async function dispatchBaleMessage(text: string): Promise<DispatchResult> {
  const body = text.trim();

  if (getDeliveryMode() === "dry-run") {
    const messageId = `dry-${Date.now()}`;
    recordOutboxEntry({
      text: body,
      status: "dry-run",
      channel: DRY_RUN_CHANNEL,
      messageId,
    });
    return { ok: true, dryRun: true, messageId };
  }

  const result = await sendBaleMessage(body);

  if (result.ok) {
    recordOutboxEntry({
      text: body,
      status: "sent",
      channel: LIVE_CHANNEL,
      messageId: result.messageId,
    });
    return { ok: true, dryRun: false, messageId: result.messageId };
  }

  // Record the attempt so it stays visible for later resending from a host
  // that can actually reach Bale.
  recordOutboxEntry({
    text: body,
    status: "failed",
    channel: LIVE_CHANNEL,
    error: result.detail ? `${result.message} (${result.detail})` : result.message,
  });

  return {
    ok: false,
    dryRun: false,
    kind: result.kind,
    message: result.message,
    detail: result.detail ?? null,
  };
}
