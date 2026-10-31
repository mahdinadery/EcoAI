import { sendBaleMessage } from "@/lib/bale/client";
import type { ProviderOutcome } from "./types";

/**
 * Bale provider — thin adapter over the EXISTING Bale service.
 *
 * No second Bale client is created and no dry-run short-circuit is used here:
 * `sendBaleMessage` always performs a real request, so a "sent" status can only
 * come from an actual Bale API confirmation. The bot token stays inside
 * src/lib/bale/client.ts and never reaches this layer's callers.
 */

export async function deliverToBale(text: string): Promise<ProviderOutcome> {
  // Markdown parse mode renders the title hyperlinks; sendBaleMessage falls
  // back to plain text automatically if Bale rejects the markup.
  const result = await sendBaleMessage(text, { parseMode: "Markdown" });

  if (result.ok) {
    return { ok: true, providerMessageId: result.messageId, errorMessage: null };
  }

  // client.ts already redacts secrets from message/detail.
  return {
    ok: false,
    providerMessageId: null,
    errorMessage: result.detail ? `${result.message} (${result.detail})` : result.message,
  };
}
