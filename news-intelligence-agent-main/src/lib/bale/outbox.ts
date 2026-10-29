/**
 * Local outbox — SERVER-SIDE ONLY.
 *
 * Backed by BOTH PostgreSQL `deliveries` table (persistent across restarts)
 * AND in-memory dry-run / test entries so that every automatic or manual delivery
 * attempt is permanently inspectable in the Dashboard Outbox.
 */

import { db } from "@/db";
import { deliveries } from "@/db/schema";
import { desc } from "drizzle-orm";

export type OutboxStatus = "sent" | "failed" | "dry-run";

export type OutboxEntry = {
  id: string;
  text: string;
  status: OutboxStatus;
  channel: string;
  trigger?: "auto" | "manual" | "test";
  createdAt: string;
  messageId: string | null;
  error: string | null;
};

type RecordInput = {
  text: string;
  status: OutboxStatus;
  channel: string;
  trigger?: "auto" | "manual" | "test";
  messageId?: string | null;
  error?: string | null;
};

const MAX_ENTRIES = 50;

// Stored on globalThis for non-persistent dry-run / test probe messages.
const globalForOutbox = globalThis as typeof globalThis & {
  __newsAgentBaleOutbox?: OutboxEntry[];
};

function memoryStore(): OutboxEntry[] {
  globalForOutbox.__newsAgentBaleOutbox ??= [];
  return globalForOutbox.__newsAgentBaleOutbox;
}

export function recordOutboxEntry(input: RecordInput): OutboxEntry {
  const entry: OutboxEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: input.text,
    status: input.status,
    channel: input.channel,
    trigger: input.trigger ?? "test",
    createdAt: new Date().toISOString(),
    messageId: input.messageId ?? null,
    error: input.error ?? null,
  };

  const entries = memoryStore();
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;

  return entry;
}

/**
 * Returns newest-first entries combining persistent PostgreSQL `deliveries`
 * records and in-memory dry-run/test entries.
 */
export async function listOutboxEntries(): Promise<OutboxEntry[]> {
  const memoryEntries = [...memoryStore()];

  let dbRows: Array<typeof deliveries.$inferSelect> = [];
  try {
    dbRows = await db
      .select()
      .from(deliveries)
      .orderBy(desc(deliveries.createdAt))
      .limit(MAX_ENTRIES);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[outbox] failed to read deliveries table:", detail.slice(0, 160));
  }

  const dbEntries: OutboxEntry[] = dbRows.map((row) => {
    const destLabel = row.destination === "bale" ? "بله (Bale)" : "صندوق محلی (Local)";
    const triggerLabel =
      row.triggeredBy === "auto" ? "ارسال خودکار 🤖" : "ارسال دستی 👤";
    const channel = `${destLabel} · ${triggerLabel}`;

    return {
      id: row.id,
      text: row.message ?? "(بدون متن پیام)",
      status: row.status === "sent" ? "sent" : "failed",
      channel,
      trigger: (row.triggeredBy === "auto" ? "auto" : "manual") as "auto" | "manual",
      createdAt: row.createdAt.toISOString(),
      messageId: row.id,
      error: row.errorMessage ?? null,
    };
  });

  // Combine and sort newest-first by createdAt
  const combined = [...dbEntries, ...memoryEntries].sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Deduplicate by ID just in case
  const seen = new Set<string>();
  const unique: OutboxEntry[] = [];
  for (const entry of combined) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      unique.push(entry);
      if (unique.length >= MAX_ENTRIES) break;
    }
  }

  return unique;
}

export function clearOutboxEntries(): void {
  memoryStore().length = 0;
}
