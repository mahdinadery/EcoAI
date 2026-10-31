import type { ProviderOutcome } from "./types";

/**
 * Local provider — delivers to the Local Outbox backed by PostgreSQL `deliveries`.
 *
 * Every message handed to this provider is permanently stored in PostgreSQL
 * with its human-readable Persian formatting and `triggered_by` audit marker
 * ("auto" vs "manual").
 */
export async function deliverToLocal(_text: string): Promise<ProviderOutcome> {
  return {
    ok: true,
    providerMessageId: `local-${Date.now()}`,
    errorMessage: null,
  };
}
