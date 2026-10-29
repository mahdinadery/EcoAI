import assert from "node:assert/strict";
import test from "node:test";

import {
  GRADE_BORDERLINE_MAX,
  GRADE_BORDERLINE_MIN,
  isBorderlineRelevance,
  parseGradeVerdict,
} from "../src/lib/ai/grade-rules.ts";

test("isBorderlineRelevance: only the gray band triggers the grader", () => {
  assert.equal(isBorderlineRelevance(GRADE_BORDERLINE_MIN), true);
  assert.equal(isBorderlineRelevance(GRADE_BORDERLINE_MAX), true);
  assert.equal(isBorderlineRelevance(60), true);
  assert.equal(isBorderlineRelevance(GRADE_BORDERLINE_MIN - 1), false);
  assert.equal(isBorderlineRelevance(GRADE_BORDERLINE_MAX + 1), false);
  assert.equal(isBorderlineRelevance(null), false);
  assert.equal(isBorderlineRelevance(undefined), false);
});

test("parseGradeVerdict: decisive tokens in Persian and English", () => {
  assert.equal(parseGradeVerdict("بله"), "yes");
  assert.equal(parseGradeVerdict("خیر"), "no");
  assert.equal(parseGradeVerdict("yes"), "yes");
  assert.equal(parseGradeVerdict("No."), "no");
  assert.equal(parseGradeVerdict("بله، مرتبط است"), "yes");
});

test("parseGradeVerdict: first decisive token wins when both appear", () => {
  assert.equal(parseGradeVerdict("خیر، این خبر مرتبط نیست. البته بله قابل درک است"), "no");
  assert.equal(parseGradeVerdict("بله اما خیر قطعی نیست"), "yes");
});

test("parseGradeVerdict: unparseable replies yield null (keep original scores)", () => {
  assert.equal(parseGradeVerdict(""), null);
  assert.equal(parseGradeVerdict("شاید مرتبط باشد"), null);
  assert.equal(parseGradeVerdict("مرتبط"), null);
});

test('dashboard grader toggle and range control when the second opinion runs', () => {
  assert.equal(isBorderlineRelevance(60, {graderEnabled:false}), false);
  assert.equal(isBorderlineRelevance(80, {graderMin:75, graderMax:85}), true);
  assert.equal(isBorderlineRelevance(60, {graderMin:75, graderMax:85}), false);
});
