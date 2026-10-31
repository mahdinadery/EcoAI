import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseRunSummary } from "../src/lib/agent/run-diagnosis.ts";

const summary = (overrides = {}) => ({
  ingest: { created: 2, failed: 0 },
  analysis: { selected: 2, analyzed: 2, failed: 0, skippedOfftopic: 0 },
  send: {
    considered: 2,
    matched: 2,
    sent: 0,
    failed: 0,
    skippedDuplicates: 0,
    skippedReview: 0,
  },
  errors: [],
  ...overrides,
});

test("no summary -> no diagnosis", () => {
  assert.equal(diagnoseRunSummary(null), null);
  assert.equal(diagnoseRunSummary(undefined), null);
});

test("a successful send is reported as success", () => {
  const result = diagnoseRunSummary(summary({ send: { ...summary().send, sent: 2 } }));
  assert.equal(result?.level, "success");
  assert.match(result?.title ?? "", /۲ خبر|2 خبر/);
});

test("a failed send wins over an earlier success", () => {
  const result = diagnoseRunSummary(
    summary({ send: { ...summary().send, sent: 1, failed: 1 } }),
  );
  assert.equal(result?.level, "error");
  assert.match(result?.title ?? "", /ناموفق/);
});

test("a local-only send explains why Bale stayed empty", () => {
  const result = diagnoseRunSummary(
    summary({ send: { ...summary().send, destination: "local", sent: 2 } }),
  );
  assert.equal(result?.level, "warning");
  assert.match(result?.title ?? "", /صندوق محلی/);
});

test("no active news sources is called out", () => {
  const result = diagnoseRunSummary(
    summary({
      ingest: { created: 0, failed: 0, sources: 0 },
      analysis: { selected: 0, analyzed: 0, failed: 0, skippedOfftopic: 0 },
      send: { considered: 0, matched: 0, sent: 0, failed: 0 },
    }),
  );
  assert.equal(result?.level, "warning");
  assert.match(result?.title ?? "", /منبع خبری فعال/);
});

test("a fully failed ingest is explained", () => {
  const result = diagnoseRunSummary(
    summary({
      ingest: { created: 0, failed: 3 },
      analysis: null,
      send: { considered: 0, matched: 0, sent: 0, failed: 0 },
    }),
  );
  assert.equal(result?.level, "error");
  assert.match(result?.title ?? "", /دریافت خبر/);
});

test("a fully failed analysis points at the AI configuration", () => {
  const result = diagnoseRunSummary(
    summary({
      analysis: { selected: 3, analyzed: 0, failed: 3, skippedOfftopic: 0 },
      send: { considered: 0, matched: 0, sent: 0, failed: 0 },
    }),
  );
  assert.equal(result?.level, "error");
  assert.match(result?.title ?? "", /تحلیل هوش مصنوعی/);
});

test("nothing considered -> informative empty-run message", () => {
  const result = diagnoseRunSummary(
    summary({ send: { considered: 0, matched: 0, sent: 0, failed: 0 } }),
  );
  assert.equal(result?.level, "info");
  assert.match(result?.title ?? "", /خبر آمادهٔ ارسالی وجود نداشت/);
});

test("considered but not matched -> threshold hint", () => {
  const result = diagnoseRunSummary(
    summary({ send: { considered: 4, matched: 0, sent: 0, failed: 0 } }),
  );
  assert.equal(result?.level, "warning");
  assert.match(result?.title ?? "", /حد نصاب/);
});

test("deferred manual review is surfaced", () => {
  const result = diagnoseRunSummary(
    summary({
      send: { considered: 3, matched: 2, sent: 0, failed: 0, skippedReview: 2 },
    }),
  );
  assert.equal(result?.level, "warning");
  assert.match(result?.title ?? "", /تأیید دستی/);
});

test("a quiet run with no send keeps a neutral message", () => {
  const result = diagnoseRunSummary(
    summary({ send: { considered: 2, matched: 2, sent: 0, failed: 0 } }),
  );
  assert.equal(result?.level, "info");
  assert.match(result?.title ?? "", /خبر واجد شرایطی برای ارسال نبود/);
});
