/** Cross-process lock for automatic article processing and delivery.
 * A transaction-scoped advisory lock works with transaction-pooling proxies;
 * a checked-out connection holds it until the pass completes or disconnects.
 */
import { pool } from "@/db";

const QUEUE_LOCK_KEY = 73201841;

export async function withArticleQueueLock<T>(work: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS acquired", [QUEUE_LOCK_KEY]);
    if (!result.rows[0]?.acquired) return { acquired: false };
    return { acquired: true, value: await work() };
  } finally {
    if (began) {
      try { await client.query("ROLLBACK"); } catch { /* connection is discarded below */ }
    }
    client.release();
  }
}
