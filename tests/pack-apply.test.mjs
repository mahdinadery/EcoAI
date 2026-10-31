import assert from "node:assert/strict";
import test from "node:test";

import { applyPackSources } from "../src/lib/news/pack-apply.ts";

function source(name, url, extra = {}) {
  return {
    name,
    url,
    type: "rss",
    category: "اقتصاد",
    description: "",
    priority: 3,
    fetchIntervalMinutes: 30,
    maxItemsPerFetch: 40,
    ...extra,
  };
}

function packOf(sources) {
  return { id: "test-pack", title: "بسته آزمایشی", description: "", topics: [], sources };
}

test("adds only new sources and skips existing URLs (normalized)", async () => {
  const added = [];
  const probed = [];

  const result = await applyPackSources(
    packOf([
      source("موجود", "https://example.com/rss/"),
      source("جدید", "https://new.example/rss"),
    ]),
    {
      listExistingUrls: async () => ["https://EXAMPLE.com/rss"],
      probe: async (url) => {
        probed.push(url);
        return { ok: true, itemCount: 12 };
      },
      create: async (item) => {
        added.push(item.name);
      },
    },
  );

  assert.deepEqual(added, ["جدید"]);
  assert.deepEqual(probed, ["https://new.example/rss"]);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].status, "skipped");
  assert.equal(result.results[1].status, "added");
  assert.match(result.results[1].message, /12/);
});

test("a failing probe does not block the other sources", async () => {
  const added = [];

  const result = await applyPackSources(
    packOf([
      source("خراب", "https://broken.example/rss"),
      source("سالم", "https://ok.example/rss"),
    ]),
    {
      listExistingUrls: async () => [],
      probe: async (url) =>
        url.includes("broken")
          ? { ok: false, message: "Network fetch failed (timeout)", detail: "undici" }
          : { ok: true, itemCount: 3 },
      create: async (item) => added.push(item.name),
    },
  );

  assert.deepEqual(added, ["سالم"]);
  assert.equal(result.results[0].status, "failed");
  assert.match(result.results[0].message, /timeout/);
  assert.match(result.results[0].message, /undici/);
  assert.equal(result.failed, 1);
  assert.equal(result.added, 1);
});

test("a throwing probe or create is reported as failed, never thrown", async () => {
  const result = await applyPackSources(
    packOf([
      source("خطای تست", "https://throw.example/rss"),
      source("خطای ثبت", "https://create.example/rss"),
    ]),
    {
      listExistingUrls: async () => [],
      probe: async (url) => {
        if (url.includes("throw")) throw new Error("boom");
        return { ok: true, itemCount: 1 };
      },
      create: async () => {
        throw new Error("db down");
      },
    },
  );

  assert.equal(result.failed, 2);
  assert.match(result.results[0].message, /boom/);
  assert.match(result.results[1].message, /db down/);
  assert.equal(result.added, 0);
});

test("results keep the pack order and respect the concurrency limit", async () => {
  const sources = Array.from({ length: 6 }, (_, index) => source(`منبع ${index}`, `https://s${index}.example/rss`));
  let active = 0;
  let maxActive = 0;

  const result = await applyPackSources(packOf(sources), {
    listExistingUrls: async () => [],
    concurrency: 2,
    probe: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ok: true, itemCount: 1 };
    },
    create: async () => {},
  });

  assert.equal(result.added, 6);
  assert.equal(maxActive <= 2, true);
  assert.deepEqual(
    result.results.map((item) => item.name),
    sources.map((item) => item.name),
  );
});
