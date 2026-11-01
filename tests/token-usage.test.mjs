import assert from "node:assert/strict";
import test from "node:test";

import {
  callAiChatCompletion,
  extractProviderErrorReason,
  extractTokenUsage,
  inferBaseUrlFromApiKey,
  mergeTokenUsage,
  normalizeAiBaseUrl,
  resolveAiApiKey,
  resolveEffectiveBaseUrl,
  resolveEffectiveModel,
} from "../src/lib/ai/completion.ts";
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

test("normalizeAiBaseUrl normalizes Gemini, Groq, OpenRouter shorthands and strips /chat/completions", () => {
  assert.equal(normalizeAiBaseUrl(undefined), "https://api.openai.com/v1");
  assert.equal(
    normalizeAiBaseUrl("https://generativelanguage.googleapis.com/v1beta/"),
    "https://generativelanguage.googleapis.com/v1beta/openai",
  );
  assert.equal(normalizeAiBaseUrl("https://api.groq.com"), "https://api.groq.com/openai/v1");
  assert.equal(normalizeAiBaseUrl("https://openrouter.ai/api"), "https://openrouter.ai/api/v1");
  assert.equal(
    normalizeAiBaseUrl("https://api.groq.com/openai/v1/chat/completions"),
    "https://api.groq.com/openai/v1",
  );
});

test("extractProviderErrorReason parses Gemini array, OpenRouter metadata, and HTML 503 titles", () => {
  const gemini503 = JSON.stringify([
    { error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } },
  ]);
  assert.equal(extractProviderErrorReason(gemini503), "The model is overloaded. Please try again later.");

  const openRouter503 = JSON.stringify({
    error: { message: "Provider returned error", code: 503, metadata: { raw: "No instances available" } },
  });
  assert.equal(extractProviderErrorReason(openRouter503), "Provider returned error (No instances available)");

  const html503 = "<html><head><title>503 Service Temporarily Unavailable</title></head><body></body></html>";
  assert.equal(extractProviderErrorReason(html503), "503 Service Temporarily Unavailable");
});

test("callAiChatCompletion retries transient HTTP 503 errors and succeeds when provider recovers", async () => {
  const prevKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = "test-secret-key";
  let calls = 0;

  try {
    const result = await callAiChatCompletion(
      {
        systemPrompt: "Return JSON.",
        userPrompt: "Analyze article.",
        model: "gemini-2.5-flash",
        temperature: 0.2,
        maxTokens: 500,
      },
      {
        retryBaseDelayMs: 5,
        fetchImpl: async () => {
          calls += 1;
          if (calls < 3) {
            return new Response(
              JSON.stringify([{ error: { code: 503, message: "The model is overloaded. Please try again later." } }]),
              { status: 503 },
            );
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"summary":"ترجمه موفق","shouldSend":true}' } }],
              usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
            }),
            { status: 200 },
          );
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(calls, 3);
    if (result.ok) {
      assert.match(result.rawText, /ترجمه موفق/);
    }
  } finally {
    if (prevKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = prevKey;
  }
});

test("callAiChatCompletion drops json_object response_format when rejected by upstream model", async () => {
  const prevKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = "test-secret-key";
  const bodies = [];

  try {
    const result = await callAiChatCompletion(
      {
        systemPrompt: "Return JSON.",
        userPrompt: "Analyze article.",
        model: "custom/free-model",
        temperature: 0.2,
        maxTokens: 500,
      },
      {
        retryBaseDelayMs: 5,
        fetchImpl: async (_url, init) => {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          bodies.push(parsedBody);
          if (parsedBody.response_format) {
            return new Response(
              JSON.stringify({ error: { message: "No endpoints found that support response_format json_object" } }),
              { status: 503 },
            );
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"summary":"پاسخ بدون json_object","shouldSend":false}' } }],
            }),
            { status: 200 },
          );
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.equal(bodies[1].response_format, undefined);
  } finally {
    if (prevKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = prevKey;
  }
});

test("provider auto-detection resolves Gemini, Groq, and OpenRouter endpoints & default models from API key", () => {
  assert.equal(inferBaseUrlFromApiKey("AIzaSyDummyGeminiKey123"), "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(inferBaseUrlFromApiKey("gsk_DummyGroqKey123"), "https://api.groq.com/openai/v1");
  assert.equal(inferBaseUrlFromApiKey("sk-or-v1-DummyOpenRouterKey"), "https://openrouter.ai/api/v1");

  const geminiEnv = { GEMINI_API_KEY: "AIzaSyDummyGeminiKey123" };
  const key = resolveAiApiKey(geminiEnv);
  const baseUrl = resolveEffectiveBaseUrl(key, geminiEnv);
  const model = resolveEffectiveModel("", { baseUrl, apiKey: key, env: geminiEnv });
  assert.equal(key, "AIzaSyDummyGeminiKey123");
  assert.equal(baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(model, "gemini-2.5-flash");

  assert.equal(
    resolveEffectiveModel("", { baseUrl: "https://api.groq.com/openai/v1", env: {} }),
    "llama-3.3-70b-versatile",
  );
  assert.equal(
    resolveEffectiveModel("", { baseUrl: "https://openrouter.ai/api/v1", env: {} }),
    "openai/gpt-4o-mini",
  );
});

test("callAiChatCompletion shrinks max_tokens automatically on TPM / credit-limit errors", async () => {
  const prevKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = "gsk_test_groq_key";
  const maxTokensSeen = [];

  try {
    const result = await callAiChatCompletion(
      {
        systemPrompt: "Return JSON.",
        userPrompt: "A".repeat(5_000),
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        maxTokens: 3500,
      },
      {
        retryBaseDelayMs: 5,
        fetchImpl: async (_url, init) => {
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          maxTokensSeen.push(parsedBody.max_tokens);
          if (parsedBody.max_tokens > 1500) {
            return new Response(
              JSON.stringify({
                error: { message: "Request too large for model llama-3.3-70b-versatile on tokens per minute (TPM): Limit 6000, Requested 7200" },
              }),
              { status: 429 },
            );
          }
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"summary":"پاسخ با بودجه توکن فشرده","shouldSend":true}' } }],
            }),
            { status: 200 },
          );
        },
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(maxTokensSeen, [3500, 1200]);
  } finally {
    if (prevKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = prevKey;
  }
});

