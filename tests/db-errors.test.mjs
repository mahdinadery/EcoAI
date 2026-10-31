import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseDbError, errorCodes, isSchemaMismatchError } from "../src/lib/admin/db-errors.ts";

function withDatabaseUrl(value, fn) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

/** Mimics drizzle-orm's wrapper: outer message is only "Failed query: ...". */
function drizzleError(query, cause) {
  const error = new Error(`Failed query: ${query}`);
  error.cause = cause;
  return error;
}

function pgError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.severity = "ERROR";
  return error;
}

const SELECT = 'select "id", "name", "system_prompt" from "ai_configurations" where "is_active" = $1';

test("missing table in error.cause is detected as a schema mismatch", () => {
  const error = drizzleError(SELECT, pgError('relation "ai_configurations" does not exist', "42P01"));

  assert.equal(isSchemaMismatchError(error), true);

  const diagnosis = withDatabaseUrl("postgresql://u:p@h:5432/db", () => diagnoseDbError(error));
  assert.equal(diagnosis.schemaMismatch, true);
  assert.equal(diagnosis.status, 500);
  assert.equal(diagnosis.code, "42P01");
  // Root cause must be visible, not just the opaque drizzle wrapper message.
  assert.match(diagnosis.detail, /relation "ai_configurations" does not exist/);
  assert.match(diagnosis.hint, /db:ensure/);
});

test("missing column (42703) is also a schema mismatch", () => {
  const error = drizzleError(
    'select "topic_filter" from "ai_configurations"',
    pgError('column "topic_filter" of relation "ai_configurations" does not exist', "42703"),
  );

  assert.equal(isSchemaMismatchError(error), true);
  const diagnosis = withDatabaseUrl("postgresql://u:p@h:5432/db", () => diagnoseDbError(error));
  assert.equal(diagnosis.schemaMismatch, true);
  assert.equal(diagnosis.code, "42703");
});

test("DNS failures (ENOTFOUND) get the hostaddr workaround hint", () => {
  const error = drizzleError(
    'select "category" from "news" group by "category"',
    pgError("getaddrinfo ENOTFOUND postgres.entfrvcttibstalvtvi.example", "ENOTFOUND"),
  );

  const diagnosis = withDatabaseUrl("postgresql://u:p@h:5432/db", () => diagnoseDbError(error));
  assert.equal(diagnosis.status, 503);
  assert.equal(diagnosis.code, "ENOTFOUND");
  assert.match(diagnosis.hint, /hostaddr/, "hint must mention the hostaddr workaround");
  assert.match(diagnosis.hint, /DNS/);
});

test("connection failures are diagnosed as 503 and are not schema mismatches", () => {
  const error = drizzleError("select 1", pgError("connect ECONNREFUSED 127.0.0.1:5432", "ECONNREFUSED"));

  assert.equal(isSchemaMismatchError(error), false);
  const diagnosis = withDatabaseUrl("postgresql://u:p@h:5432/db", () => diagnoseDbError(error));
  assert.equal(diagnosis.status, 503);
  assert.equal(diagnosis.schemaMismatch, false);
  assert.match(diagnosis.hint, /DATABASE_URL/);
});

test("unrelated errors stay generic (no repair suggestion)", () => {
  const error = drizzleError("insert into news ...", pgError("duplicate key value violates unique constraint", "23505"));
  const diagnosis = withDatabaseUrl("postgresql://u:p@h:5432/db", () => diagnoseDbError(error));

  assert.equal(diagnosis.schemaMismatch, false);
  assert.equal(diagnosis.status, 500);
  assert.match(diagnosis.detail, /duplicate key/);
});

test("connection strings in messages are redacted", () => {
  const error = new Error("could not connect to postgresql://user:secret@db.example.com:5432/app");
  const diagnosis = withDatabaseUrl("postgresql://u:p@h:5432/db", () => diagnoseDbError(error));

  assert.doesNotMatch(diagnosis.detail, /secret/);
  assert.match(diagnosis.detail, /\[REDACTED\]/);
});

test("errorCodes walks the whole cause chain", () => {
  const inner = pgError("boom", "42P01");
  const middle = new Error("wrapped");
  middle.cause = inner;
  const outer = new Error("outer");
  outer.cause = middle;

  assert.deepEqual(errorCodes(outer).slice(0, 1), ["42P01"]);
});

test("missing DATABASE_URL always wins over other classification", () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const diagnosis = diagnoseDbError(pgError('relation "news" does not exist', "42P01"));
    assert.equal(diagnosis.status, 503);
    assert.equal(diagnosis.schemaMismatch, false);
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});
