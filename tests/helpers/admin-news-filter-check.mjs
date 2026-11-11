import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.ts";
import { news } from "../../src/db/schema.ts";
import { buildAdminNewsWhere } from "../../src/lib/news/news-admin.ts";
import { NEWS_STATUSES } from "../../src/lib/news/status.ts";

function queries(filters) {
  const where = buildAdminNewsWhere(filters);
  return [
    db.select({ id: news.id }).from(news).where(where).toSQL(),
    db.select({ total: sql`count(*)::int` }).from(news).where(where).toSQL(),
  ];
}

test("every valid status generates parameterized SQL for list and count", () => {
  for (const status of NEWS_STATUSES) {
    for (const query of queries({ status })) {
      assert.match(query.sql, /"status"\s*=\s*\$1/);
      assert.deepEqual(query.params, [status]);
      assert.doesNotMatch(query.sql, /[{}]/);
    }
  }
});

test("default and invalid status preserve the exclusions", () => {
  for (const status of [undefined, "invalid", "SENT') OR true --"]) {
    for (const query of queries({ status })) {
      assert.match(query.sql, /"status" NOT IN \('DUPLICATE', 'SKIPPED_OFFTOPIC'\)/);
      assert.deepEqual(query.params, []);
      assert.doesNotMatch(query.sql, /[{}]/);
    }
  }
});

test("combined filters remain parameterized and share list/count conditions", () => {
  const filters = {
    status: "READY_FOR_AI", q: "AI' OR 1=1 --", sourceId: "00000000-0000-4000-8000-000000000001",
    category: "analysis", ai: "pending", shouldSend: "no", from: "2026-01-01", to: "2026-01-31",
  };
  const [list, count] = queries(filters);
  assert.equal(list.sql.slice(list.sql.indexOf(" where ")), count.sql.slice(count.sql.indexOf(" where ")));
  assert.deepEqual(list.params, count.params);
  assert.equal(list.params[0], "READY_FOR_AI");
  assert.equal(list.params.filter((p) => p === "%AI' OR 1=1 --%").length, 4);
  assert.ok(list.params.includes(filters.sourceId));
  assert.ok(list.params.includes(filters.category));
  assert.match(list.sql, /"analyzed_at" IS NULL/);
  assert.match(list.sql, /"should_send" IS NULL/);
  assert.doesNotMatch(list.sql, /AI' OR 1=1|[{}]/);
});

test("AI and recommendation filters select the intended predicates", () => {
  const done = queries({ ai: "done", shouldSend: "yes" })[0];
  assert.match(done.sql, /"analyzed_at" IS NOT NULL/);
  assert.match(done.sql, /"should_send"\s*=\s*\$1/);
  assert.deepEqual(done.params, [true]);
});

test("list and count execute against PostgreSQL when a test database is available", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE news (
      id uuid PRIMARY KEY, status text NOT NULL, title text, translated_title text,
      url text, source text, source_id uuid, category text, analyzed_at timestamptz,
      should_send boolean, published_at timestamptz, created_at timestamptz
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO news (id, status, title, source, created_at) VALUES
      ('00000000-0000-4000-8000-000000000001', 'READY_FOR_AI', 'AI economics', 'NBER', now()),
      ('00000000-0000-4000-8000-000000000002', 'DUPLICATE', 'AI economics', 'NBER', now()),
      ('00000000-0000-4000-8000-000000000003', 'SENT', 'Other paper', 'IMF', now())`);
    for (const [filters, expected] of [[{}, 2], [{ status: 'DUPLICATE' }, 1], [{ status: 'READY_FOR_AI', q: 'economics', ai: 'pending' }, 1]]) {
      const [list, count] = queries(filters);
      const rows = await client.query(list.sql, list.params);
      const total = await client.query(count.sql, count.params);
      assert.equal(rows.rowCount, expected);
      assert.equal(total.rows[0].total, expected);
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
