import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  callAiChatCompletion,
  extractSuggestedModel,
  normalizeGoogleModelId,
} from "../src/lib/ai/completion.ts";

/**
 * Regression cover for the failure that cost an operator a whole bulk pass: every
 * model in the rotation ladder answered, the run stopped, and the *last* hop — a
 * retired `gemini-2.0-flash` 404 — was reported as the cause, while the real one was
 * a key-wide quota wall on a model the operator had configured years earlier.
 *
 * Contract under test: (1) a retired id in config is mapped forward, (2) the
 * provider's own recommended replacement becomes the next hop and is named in the
 * report, (3) a hard quota gets exactly one rotation hop and then says so, (4) when
 * the ladder is exhausted the headline is the configured model, not the tail.
 */

const withKey = async (key, run) => {
  const prevKey = process.env.AI_API_KEY;
  const prevBase = process.env.AI_API_BASE_URL;
  process.env.AI_API_KEY = key;
  delete process.env.AI_API_BASE_URL;
  try {
    return await run();
  } finally {
    if (prevKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.AI_API_BASE_URL;
    else process.env.AI_API_BASE_URL = prevBase;
  }
};

const okResponse = (content) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

const RETIREMENT_BODY = JSON.stringify({
  error: {
    code: 404,
    status: "NOT_FOUND",
    message:
      "This model models/gemini-3-flash-preview is no longer available. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.",
  },
});

const HARD_QUOTA_BODY = JSON.stringify([
  {
    error: {
      code: 429,
      message:
        "You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0",
    },
  },
]);

test("extractSuggestedModel: reads the replacement the provider names in its own 404", () => {
  assert.equal(extractSuggestedModel(RETIREMENT_BODY), "gemini-3.8-flash");
  assert.equal(
    extractSuggestedModel("Model retired. We recommend migrating to gemini-2.5-pro-preview."),
    "gemini-2.5-pro-preview",
  );
  // Prose that is not model-shaped must never become a model id we then send out.
  assert.equal(extractSuggestedModel("Please use your project dashboard."), null);
  assert.equal(extractSuggestedModel("The model `x` does not exist."), null);
  assert.equal(extractSuggestedModel(null), null);
});

test("normalizeGoogleModelId: the retired 2.0 line is mapped forward, live ids untouched", () => {
  assert.equal(normalizeGoogleModelId("gemini-2.0-flash"), "gemini-3.8-flash");
  assert.equal(normalizeGoogleModelId("models/gemini-2.0-flash-latest"), "gemini-3.8-flash");
  assert.equal(normalizeGoogleModelId("GEMINI-2.0-FLASH-001"), "gemini-3.8-flash");
  // A model that still works must not be rewritten — that is what broke trust here.
  assert.equal(normalizeGoogleModelId("gemini-3-flash-preview"), "gemini-3-flash-preview");
  assert.equal(normalizeGoogleModelId("gemini-2.5-flash"), "gemini-2.5-flash");
});

test("a retired model id: the provider's suggested model is tried before the ladder runs out", async () => {
  await withKey("AIzaSyRetirementRotationKey", async () => {
    const seen = [];
    const result = await callAiChatCompletion(
      {
        systemPrompt: "Answer yes or no.",
        userPrompt: "Is this about Economics of AI?",
        model: "gemini-3-flash-preview",
        temperature: 0,
        maxTokens: 16,
        jsonMode: false,
      },
      {
        maxRetries: 0,
        retryBaseDelayMs: 5,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          seen.push(body.model);
          if (body.model === "gemini-3.8-flash") return okResponse("بله");
          return new Response(RETIREMENT_BODY, { status: 404 });
        },
      },
    );

    assert.equal(seen[0], "gemini-3-flash-preview", "the configured model is tried first");
    assert.equal(
      seen.find((model) => model !== seen[0]),
      "gemini-3.8-flash",
      "the replacement the provider named must be the next hop, not a ladder entry",
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.model, "gemini-3.8-flash");
  });
});

test("hard quota: one rotation hop, then stop — and the headline is the configured model", async () => {
  await withKey("AIzaSyHardQuotaStopKey", async () => {
    const seen = [];
    const started = Date.now();
    const result = await callAiChatCompletion(
      {
        systemPrompt: "Return JSON.",
        userPrompt: "Analyze this.",
        model: "gemini-3-flash-preview",
        temperature: 0,
        maxTokens: 64,
      },
      {
        maxRetries: 2,
        retryBaseDelayMs: 5,
        fetchImpl: async (_url, init) => {
          seen.push(JSON.parse(String(init?.body ?? "{}")).model);
          return new Response(HARD_QUOTA_BODY, { status: 429 });
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(seen.length, 2, `expected the configured model plus one hop, saw ${seen.join(", ")}`);
    assert.equal(seen[1], "gemini-2.5-flash");
    if (!result.ok) {
      assert.equal(result.kind, "quota_exhausted");
      assert.match(result.message, /«gemini-3-flash-preview»/, "names the model the operator set");
      assert.match(result.message, /سقف|سهمیه/);
      assert.match(result.message, /جایگزین/, "says a replacement was tried, so the stop is explainable");
      assert.doesNotMatch(result.message, /gemini-2\.0-flash/, "a retired id must not resurface as the cause");
    }
    assert.ok(Date.now() - started < 1_500, "quota exhaustion must not sleep through the retry ladder");
  });
});

test("exhausted ladder: every model tried is listed and the first failure leads", async () => {
  await withKey("AIzaSyExhaustedLadderKey", async () => {
    const seen = [];
    const result = await callAiChatCompletion(
      {
        systemPrompt: "Return JSON.",
        userPrompt: "Analyze this.",
        model: "gemini-3-flash-preview",
        temperature: 0,
        maxTokens: 64,
      },
      {
        maxRetries: 0,
        retryBaseDelayMs: 5,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? "{}"));
          seen.push(body.model);
          return new Response(
            JSON.stringify({
              error: { code: 404, message: `The model \`${body.model}\` does not exist or you do not have access to it.` },
            }),
            { status: 404 },
          );
        },
      },
    );

    assert.equal(result.ok, false);
    assert.equal(seen.length, 4, `ladder should walk all four ids, saw ${seen.join(", ")}`);
    assert.ok(!seen.includes("gemini-2.0-flash"), "the retired id must be gone from the ladder");
    if (!result.ok) {
      assert.equal(result.kind, "http_error");
      assert.match(result.message, /«gemini-3-flash-preview»/);
      assert.match(result.message, /هیچ‌کدام از مدل‌های جایگزین هم پاسخ ندادند/);
      assert.match(result.message, /gemini-3\.8-flash/);
      // Order matters for triage: the configured model is the headline, the hops that
      // merely inherited its failure are the parenthetical.
      assert.ok(
        result.message.indexOf("«gemini-3-flash-preview»") < result.message.indexOf("gemini-2.5-flash"),
        result.message,
      );
    }
  });
});

test("a quota stop is fatal for the pool, so a bulk pass does not burn the rest of the queue", () => {
  const queue = readFileSync("src/lib/news/analysis-queue.ts", "utf8");
  assert.match(queue, /code === "quota_exhausted"/);
  assert.match(queue, /shouldAbort/);
});

test("the fallback ladder holds no retired model ids", () => {
  const source = readFileSync("src/lib/ai/completion.ts", "utf8");
  const ladder = /const GEMINI_FALLBACK_MODELS = \[([\s\S]*?)\] as const;/.exec(source);
  assert.ok(ladder, "GEMINI_FALLBACK_MODELS literal not found");
  assert.ok(!ladder[1].includes("gemini-2.0-flash"), "a retired id in the ladder masks the real error");
  const fast = /const FAST_FALLBACK_GEMINI_MODEL = "([^"]+)";/.exec(source);
  assert.ok(fast, "FAST_FALLBACK_GEMINI_MODEL not found");
  assert.notEqual(fast[1], "gemini-2.0-flash");
});
