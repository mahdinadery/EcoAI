/**
 * Real-scenario tests for scripts/db-ensure.mjs (review items M1 + M2).
 *
 * These run the ACTUAL `STEPS` array against a real PostgreSQL engine and
 * prove that legacy data problems never abort the sync halfway:
 *
 *   1. FK with orphan rows  → the FK steps warn and are skipped, every later
 *      step (all indexes) still runs, orphan rows are left untouched.
 *   2. Duplicate news URLs  → `news_url_unique` warns and is skipped, every
 *      later index still runs, duplicate rows are left untouched.
 *   3. Clean database       → everything is created (no warnings) and a second
 *      run stays idempotent.
 *   4. FK under another name → the (conrelid, confrelid, contype) check
 *      detects it and does NOT add a duplicate constraint (M1).
 *
 * Engine resolution: @electric-sql/pglite if installed (in-process, real PG
 * semantics), otherwise TEST_DATABASE_URL (isolated throwaway schema), and if
 * neither is available the suite skips with a clear message instead of
 * pretending to pass. Nothing here ever deletes or updates user rows.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { STEPS } from "../scripts/db-ensure.mjs";

const TABLE_COLUMN_STEPS = STEPS.filter((s) => s.name.startsWith("table ") || s.name.startsWith("column "));
const INDEX_STEPS = STEPS.filter((s) => s.name.startsWith("index "));
const FK_STEPS = STEPS.filter((s) => s.name.startsWith("fk "));

/** @returns {Promise<{exec: (sql: string) => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<{rows: any[]}>, warnings: string[], close: () => Promise<void>} | null>} */
async function createHarness() {
  // Preferred: in-process Postgres (WASM) — self-contained and disposable.
  try {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    return {
      exec: (sql) => db.exec(sql),
      query: (sql, params = []) => db.query(sql, params),
      warnings: [],
      /** Run one step statement, collecting WARNING-severity notices only. */
      async step(sql) {
        await db.query(sql, [], {
          onNotice: (notice) => {
            if (String(notice?.severity ?? "WARNING").toUpperCase() === "WARNING") {
              this.warnings.push(String(notice.message ?? notice));
            }
          },
        });
      },
      close: () => db.close(),
    };
  } catch {
    // fall through to a real server if the caller provided one
  }

  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schema = `db_ensure_test_${Math.random().toString(36).slice(2, 10)}`;
  const warnings = [];
  client.on("notice", (notice) => {
    if (String(notice?.severity ?? "WARNING").toUpperCase() === "WARNING") {
      warnings.push(String(notice.message ?? notice));
    }
  });
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  return {
    exec: (sql) => client.query(sql).then(() => undefined),
    query: (sql, params = []) => client.query(sql, params),
    warnings,
    async step(sql) {
      await client.query(sql);
    },
    async close() {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    },
  };
}

/** Runs the full STEPS list the same way the script's runner does. */
async function runAllSteps(harness) {
  for (const s of STEPS) {
    await harness.step(s.sql); // must never throw on legacy data (M1/M2)
  }
}

async function indexExists(harness, name) {
  const { rows } = await harness.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return rows.length > 0;
}

async function fkConstraintNames(harness, table) {
  const { rows } = await harness.query(
    `SELECT c.conname
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.conrelid = $1::regclass`,
    [table],
  );
  return rows.map((r) => r.conname);
}

test("db-ensure: orphan FK rows warn and are skipped; later steps still run; no data touched", async (t) => {
  const harness = await createHarness();
  if (!harness) return t.skip("no engine: install @electric-sql/pglite or set TEST_DATABASE_URL");
  try {
    // Arrange: tables/columns only (no FKs/indexes), then orphan rows.
    for (const s of TABLE_COLUMN_STEPS) await harness.step(s.sql);
    await harness.query(`INSERT INTO ai_analyses (news_id, status) VALUES (gen_random_uuid(), 'success')`);
    await harness.query(`INSERT INTO delivery_events (delivery_id, event) VALUES (gen_random_uuid(), 'created')`);
    // source_id must be a real orphan value — NULL would satisfy the FK.
    await harness.query(`INSERT INTO ingestion_runs (source_id, started_at, status) VALUES (gen_random_uuid(), now(), 'success')`);

    // Act: the real full sync must complete without throwing.
    harness.warnings.length = 0;
    await runAllSteps(harness);
    await runAllSteps(harness); // multi-run safe

    // Assert (1) warnings are explicit about step + constraint + reason.
    for (const needle of [
      'step "fk ai_analyses.news_id"',
      "ai_analyses_news_id_news_id_fk",
      'step "fk delivery_events.delivery_id"',
      "delivery_events_delivery_id_deliveries_id_fk",
      'step "fk ingestion_runs.source_id"',
      "ingestion_runs_source_id_news_sources_id_fk",
    ]) {
      assert.ok(
        harness.warnings.some((w) => w.includes(needle)),
        `expected a warning mentioning ${needle}; got: ${JSON.stringify(harness.warnings)}`,
      );
    }

    // Assert (2) the three FKs with orphans were NOT created, the rest were.
    const aiFks = await fkConstraintNames(harness, "ai_analyses");
    assert.ok(!aiFks.includes("ai_analyses_news_id_news_id_fk"));
    const evFks = await fkConstraintNames(harness, "delivery_events");
    assert.ok(!evFks.includes("delivery_events_delivery_id_deliveries_id_fk"));
    const runFks = await fkConstraintNames(harness, "ingestion_runs");
    assert.ok(!runFks.includes("ingestion_runs_source_id_news_sources_id_fk"));
    assert.ok((await fkConstraintNames(harness, "deliveries")).includes("deliveries_news_id_news_id_fk"));
    assert.ok((await fkConstraintNames(harness, "news")).includes("news_source_id_news_sources_id_fk"));

    // Assert (3) every index step — including those AFTER the FK block — ran.
    for (const s of INDEX_STEPS) {
      const name = s.name.replace("index ", "");
      assert.ok(await indexExists(harness, name), `later step must still run: ${s.name}`);
    }

    // Assert (4) orphan rows are untouched (nothing deleted/updated).
    const { rows } = await harness.query(`SELECT
      (SELECT count(*)::int FROM ai_analyses) AS ai,
      (SELECT count(*)::int FROM delivery_events) AS ev,
      (SELECT count(*)::int FROM ingestion_runs) AS runs`);
    assert.deepEqual(rows[0], { ai: 1, ev: 1, runs: 1 });
  } finally {
    await harness.close();
  }
});

test("db-ensure: duplicate news URLs warn and skip news_url_unique; later indexes still run; rows untouched", async (t) => {
  const harness = await createHarness();
  if (!harness) return t.skip("no engine: install @electric-sql/pglite or set TEST_DATABASE_URL");
  try {
    for (const s of TABLE_COLUMN_STEPS) await harness.step(s.sql);
    await harness.query(`INSERT INTO news (source, title, url) VALUES ('src', 'a', 'https://example.com/x')`);
    await harness.query(`INSERT INTO news (source, title, url) VALUES ('src', 'b', 'https://example.com/x')`);

    harness.warnings.length = 0;
    await runAllSteps(harness);
    await runAllSteps(harness); // multi-run safe

    // Warning names the index step and carries the PG error reason.
    const uniqueWarn = harness.warnings.find((w) => w.includes('step "index news_url_unique"') && w.includes("news_url_unique"));
    assert.ok(uniqueWarn, `expected news_url_unique warning; got: ${JSON.stringify(harness.warnings)}`);

    // The unique index could not be created, but every later step did run.
    assert.equal(await indexExists(harness, "news_url_unique"), false);
    const uniqueStepIdx = INDEX_STEPS.findIndex((s) => s.name === "index news_url_unique");
    assert.ok(uniqueStepIdx >= 0);
    for (const s of INDEX_STEPS.slice(uniqueStepIdx + 1)) {
      const name = s.name.replace("index ", "");
      assert.ok(await indexExists(harness, name), `later step must still run: ${s.name}`);
    }

    // FK steps (before the indexes) were unaffected by the duplicate URL data.
    assert.ok((await fkConstraintNames(harness, "ai_analyses")).includes("ai_analyses_news_id_news_id_fk"));

    // No duplicate row was deleted or rewritten.
    const { rows } = await harness.query(`SELECT count(*)::int AS n FROM news WHERE url = 'https://example.com/x'`);
    assert.equal(rows[0].n, 2);
  } finally {
    await harness.close();
  }
});

test("db-ensure: clean database gets every FK and index, with zero warnings and full idempotency", async (t) => {
  const harness = await createHarness();
  if (!harness) return t.skip("no engine: install @electric-sql/pglite or set TEST_DATABASE_URL");
  try {
    harness.warnings.length = 0;
    await runAllSteps(harness);
    assert.deepEqual(harness.warnings, [], "clean run must not warn");

    for (const s of INDEX_STEPS) {
      const name = s.name.replace("index ", "");
      assert.ok(await indexExists(harness, name), `missing index: ${name}`);
    }
    for (const [table, expected] of [
      ["ai_analyses", "ai_analyses_news_id_news_id_fk"],
      ["deliveries", "deliveries_news_id_news_id_fk"],
      ["delivery_events", "delivery_events_delivery_id_deliveries_id_fk"],
      ["ingestion_runs", "ingestion_runs_source_id_news_sources_id_fk"],
      ["news", "news_source_id_news_sources_id_fk"],
      ["news", "news_duplicate_of_id_news_id_fk"],
    ]) {
      assert.ok((await fkConstraintNames(harness, table)).includes(expected), `missing FK: ${expected}`);
    }

    harness.warnings.length = 0;
    await runAllSteps(harness);
    assert.deepEqual(harness.warnings, [], "second clean run must not warn either");
  } finally {
    await harness.close();
  }
});

test("db-ensure: an equivalent FK under a different name is detected and not duplicated (M1 relation check)", async (t) => {
  const harness = await createHarness();
  if (!harness) return t.skip("no engine: install @electric-sql/pglite or set TEST_DATABASE_URL");
  try {
    for (const s of TABLE_COLUMN_STEPS) await harness.step(s.sql);
    await harness.query(`INSERT INTO news (source, title, url) VALUES ('src', 'a', 'https://example.com/y')`);
    const { rows: newsRows } = await harness.query(`SELECT id FROM news LIMIT 1`);
    await harness.query(`INSERT INTO ai_analyses (news_id, status) VALUES ($1, 'success')`, [newsRows[0].id]);
    // Same FK relationship, custom name — the old conname-only check missed it.
    await harness.exec(
      `ALTER TABLE "ai_analyses" ADD CONSTRAINT "custom_fk_name" FOREIGN KEY ("news_id") REFERENCES "news"("id") ON DELETE cascade`,
    );

    harness.warnings.length = 0;
    await runAllSteps(harness);

    const names = await fkConstraintNames(harness, "ai_analyses");
    assert.deepEqual(
      names,
      ["custom_fk_name"],
      `exactly one ai_analyses→news FK must remain, got ${JSON.stringify(names)}`,
    );
    assert.ok(
      !harness.warnings.some((w) => w.includes("ai_analyses_news_id_news_id_fk")),
      "relation-level existence check must prevent adding a second FK",
    );
  } finally {
    await harness.close();
  }
});

// Sanity: the M1/M2 guards are the only DO/EXCEPTION blocks and every FK step has one.
test("db-ensure: every fk step and news_url_unique carry EXCEPTION-WARN guards", () => {
  assert.equal(FK_STEPS.length, 6);
  for (const s of FK_STEPS) {
    assert.ok(s.sql.includes("EXCEPTION WHEN others THEN"), `missing guard: ${s.name}`);
    assert.ok(s.sql.includes("RAISE WARNING"), `missing warning: ${s.name}`);
    assert.ok(s.sql.includes("contype = 'f'"), `missing relation check: ${s.name}`);
    assert.ok(s.sql.includes("conrelid"), `missing relation check: ${s.name}`);
    assert.ok(s.sql.includes("confrelid"), `missing relation check: ${s.name}`);
    assert.ok(s.sql.includes("conname"), `missing name check: ${s.name}`);
  }
  const uniqueStep = STEPS.find((s) => s.name === "index news_url_unique");
  assert.ok(uniqueStep.sql.includes("EXCEPTION WHEN others THEN"));
  assert.ok(uniqueStep.sql.includes("RAISE WARNING"));
});
