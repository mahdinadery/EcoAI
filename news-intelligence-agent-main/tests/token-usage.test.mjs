import assert from "node:assert/strict";
import test from "node:test";

import { extractTokenUsage, mergeTokenUsage } from "../src/lib/ai/completion.ts";
import { STEPS } from "../scripts/db-ensure.mjs";

test("extractTokenUsage: parses OpenAI-compatible usage payload", () => {
  const usage = extractTokenUsage({
    prompt_tokens: 412,
    completion_tokens: 188,
    total_tokens: 600,
  });

  assert.deepEqual(usage, {
    promptTokens: 412,
    completionTokens: 188,
    totalTokens: 600,
  });
});

test("extractTokenUsage: computes totalTokens when total_tokens is omitted", () => {
  const usage = extractTokenUsage({
    prompt_tokens: 300,
    completion_tokens: 120,
  });

  assert.deepEqual(usage, {
    promptTokens: 300,
    completionTokens: 120,
    totalTokens: 420,
  });
});

test("extractTokenUsage: returns null for missing or invalid payloads", () => {
  assert.equal(extractTokenUsage(null), null);
  assert.equal(extractTokenUsage(undefined), null);
  assert.equal(extractTokenUsage({}), null);
  assert.equal(extractTokenUsage({ prompt_tokens: -5 }), null);
});

test("mergeTokenUsage: sums primary analysis and grader token usage", () => {
  const primary = { promptTokens: 500, completionTokens: 200, totalTokens: 700 };
  const grader = { promptTokens: 110, completionTokens: 5, totalTokens: 115 };

  assert.deepEqual(mergeTokenUsage(primary, grader), {
    promptTokens: 610,
    completionTokens: 205,
    totalTokens: 815,
  });
  assert.deepEqual(mergeTokenUsage(primary, null), primary);
  assert.deepEqual(mergeTokenUsage(null, grader), grader);
  assert.equal(mergeTokenUsage(null, null), null);
});

test("db-ensure: includes ai_analyses token columns", () => {
  const stepNames = STEPS.map((step) => step.name);
  assert.ok(stepNames.includes("column ai_analyses.prompt_tokens"));
  assert.ok(stepNames.includes("column ai_analyses.completion_tokens"));
  assert.ok(stepNames.includes("column ai_analyses.total_tokens"));
});

test('db ensure adds independent hashtag columns without replacing existing data', () => {
  for (const name of ['column news.hashtags', 'column ai_analyses.hashtags']) {
    assert.ok(STEPS.some(step => step.name === name && step.sql.includes('IF NOT EXISTS')));
  }
});
