import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeUrl } from "../src/lib/news/canonical-url.ts";
import { buildNewsMessage } from "../src/lib/delivery/message.ts";
import { DEFAULT_AUTO_SEND_POLICY, DEFAULT_TOPIC_FILTER } from "../src/lib/ai/config-types.ts";

test("canonicalizeUrl strips tracking params but keeps identity params", () => {
  const canonical = canonicalizeUrl("https://example.com/a?utm_source=x&id=5&gclid=abc");
  assert.ok(canonical.includes("id=5"));
  assert.ok(!canonical.includes("utm_source"));
  assert.ok(!canonical.includes("gclid"));
});

test("canonicalizeUrl survives unparseable input unchanged", () => {
  assert.equal(canonicalizeUrl("not a url"), "not a url");
});

test("buildNewsMessage renders the shared delivery text", () => {
  const text = buildNewsMessage({
    title: "عنوان خبر",
    summary: "خلاصه خبر",
    category: "اقتصاد",
    importanceScore: 80,
    url: "https://example.com/news/1",
  });

  assert.ok(text.includes("عنوان خبر"));
  assert.ok(text.includes("خلاصه خبر"));
  assert.ok(text.includes("اقتصاد"));
  assert.ok(text.includes("80 از ۱۰۰"));
  assert.ok(text.includes("https://example.com/news/1"));
});

test("buildNewsMessage tolerates missing analysis fields", () => {
  const text = buildNewsMessage({ title: "t", summary: null, category: null, importanceScore: null, url: "u" });
  assert.ok(text.includes("—"));
  assert.ok(text.includes("ثبت نشده"));
});

test("default topic filter is inactive (fail-open) and default policy is env-driven", () => {
  assert.equal(DEFAULT_TOPIC_FILTER.enabled, false);
  assert.equal(DEFAULT_TOPIC_FILTER.topics.length, 0);
  assert.equal(DEFAULT_AUTO_SEND_POLICY.useCustom, false);
  assert.equal(DEFAULT_AUTO_SEND_POLICY.destination, "local");
});
