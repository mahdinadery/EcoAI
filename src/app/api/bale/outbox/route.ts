import { getDeliveryMode } from "@/lib/bale/dispatcher";
import { clearOutboxEntries, listOutboxEntries } from "@/lib/bale/outbox";

export const dynamic = "force-dynamic";

/** GET /api/bale/outbox -> recorded outgoing messages (no secrets). */
export async function GET() {
  const entries = await listOutboxEntries();
  return Response.json({
    mode: getDeliveryMode(),
    entries,
  });
}

/** DELETE /api/bale/outbox -> clear the local, non-persistent list. */
export async function DELETE() {
  clearOutboxEntries();
  return Response.json({ ok: true, entries: [] });
}
