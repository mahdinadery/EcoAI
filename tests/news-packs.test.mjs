import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_ECONOMICS_PACK,
  DEFAULT_NEWS_PACK,
  ENGLISH_ECONOMICS_PACK,
  NEWS_PACKS,
  appendAudienceNote,
  mergeBlockedKeywords,
  getNewsPack,
  mergePackTopics,
  normalizeSourceUrl,
  normalizeTopicLabel,
  upgradeLegacyPackTopicFilter,
} from "../src/lib/news/news-packs.ts";
import { evaluateTopicFilter } from "../src/lib/news/topic-filter.ts";

test("ai-economics pack is internally consistent and saveable", () => {
  const pack = AI_ECONOMICS_PACK;

  assert.equal(pack.id, "ai-economics");
  assert.equal(DEFAULT_NEWS_PACK.id, "ai-economics");
  assert.equal(ENGLISH_ECONOMICS_PACK.id, "ai-economics");
  assert.ok(pack.topics.length >= 6, "pack should cover major Economics of AI sub-domains");
  assert.ok(pack.topics.length <= 30);

  const labels = new Set();
  const ids = new Set();
  for (const topic of pack.topics) {
    assert.ok(topic.label.trim().length > 0);
    assert.ok(topic.label.length <= 80);
    assert.equal(topic.enabled, true);
    assert.ok(topic.keywords.length > 0);
    assert.ok(topic.keywords.length <= 50);
    for (const keyword of topic.keywords) {
      assert.ok(keyword.trim().length > 0);
      assert.ok(keyword.length <= 120);
    }
    assert.equal(labels.has(normalizeTopicLabel(topic.label)), false, `duplicate label: ${topic.label}`);
    labels.add(normalizeTopicLabel(topic.label));
    assert.equal(ids.has(topic.id), false, `duplicate id: ${topic.id}`);
    ids.add(topic.id);
  }

  assert.ok(pack.sources.length >= 8);
  const urls = new Set();
  for (const source of pack.sources) {
    assert.equal(source.type, "rss");
    assert.match(source.url, /^https:\/\//);
    assert.ok(source.name.trim().length > 0);
    assert.ok(source.priority >= 1 && source.priority <= 5);
    assert.ok(source.fetchIntervalMinutes >= 5 && source.fetchIntervalMinutes <= 1440);
    assert.ok(source.maxItemsPerFetch >= 1 && source.maxItemsPerFetch <= 200);
    const normalized = normalizeSourceUrl(source.url);
    assert.equal(urls.has(normalized), false, `duplicate source: ${source.url}`);
    urls.add(normalized);
  }

  assert.match(pack.audienceNote ?? "", /اقتصاد هوش مصنوعی/);
  assert.ok(pack.audienceMarker && (pack.audienceNote ?? "").includes(pack.audienceMarker));
});

test("pack registry exposes ai-economics and backward-compatible english-economics alias", () => {
  assert.equal(getNewsPack("ai-economics")?.id, "ai-economics");
  assert.equal(getNewsPack("english-economics")?.id, "ai-economics");
  assert.equal(getNewsPack("does-not-exist"), undefined);
  assert.ok(NEWS_PACKS.length >= 1);
});

test("mergePackTopics adds every topic with a pack-aiecon id", () => {
  const result = mergePackTopics([], AI_ECONOMICS_PACK);

  assert.equal(result.added.length, AI_ECONOMICS_PACK.topics.length);
  assert.equal(result.topics.length, AI_ECONOMICS_PACK.topics.length);
  assert.equal(result.truncated, 0);
  assert.equal(result.skipped.length, 0);

  for (const topic of result.topics) {
    assert.ok(topic.id.startsWith("pack-aiecon-"));
    assert.deepEqual(
      topic.keywords,
      AI_ECONOMICS_PACK.topics.find((item) => item.label === topic.label)?.keywords,
    );
  }
});

test("applying the pack twice does not duplicate topics", () => {
  const first = mergePackTopics([], AI_ECONOMICS_PACK);
  const second = mergePackTopics(first.topics, AI_ECONOMICS_PACK);

  assert.equal(second.topics.length, first.topics.length);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, AI_ECONOMICS_PACK.topics.length);
  assert.equal(second.truncated, 0);
});

test("labels are compared Persian-friendly (ZWNJ / Arabic variants)", () => {
  const existing = [
    { id: "x", label: "بهرهوري، رشد اقتصادي و کلان اقتصاد هوش مصنوعي", enabled: true, keywords: ["ai"] },
    { id: "y", label: "بازار کار، مشاغل، دستمزد و سرمايه انساني", enabled: true, keywords: ["labor"] },
  ];
  // ZWNJ-normalized matching
  const existingExactVariant = [
    { id: "x", label: "بهره‌وري، رشد اقتصادي و کلان اقتصاد هوش مصنوعي", enabled: true, keywords: ["ai"] },
    { id: "y", label: "بازار کار، مشاغل، دستمزد و سرمايه انساني", enabled: true, keywords: ["labor"] },
  ];
  void existing;
  const result = mergePackTopics(existingExactVariant, AI_ECONOMICS_PACK);

  assert.equal(result.skipped.includes("بهره‌وری، رشد اقتصادی و کلان اقتصاد هوش مصنوعی"), true);
  assert.equal(result.skipped.includes("بازار کار، مشاغل، دستمزد و سرمایه انسانی"), true);
  assert.equal(result.topics.length, existingExactVariant.length + AI_ECONOMICS_PACK.topics.length - 2);
});

test("the 30-topic configuration limit is respected", () => {
  const existing = Array.from({ length: 28 }, (_, index) => ({
    id: `existing-${index}`,
    label: `موضوع ${index}`,
    enabled: true,
    keywords: [`کلید ${index}`],
  }));

  const result = mergePackTopics(existing, AI_ECONOMICS_PACK);

  assert.equal(result.topics.length, 30);
  assert.equal(result.added.length, 2);
  assert.equal(result.truncated, AI_ECONOMICS_PACK.topics.length - 2);
  assert.deepEqual(
    existing.map((topic) => topic.id),
    Array.from({ length: 28 }, (_, index) => `existing-${index}`),
  );
});

test("mergePackTopics never mutates the input keywords", () => {
  const existing = [{ id: "a", label: "موضوع", enabled: true, keywords: ["artificial intelligence"] }];
  const result = mergePackTopics(existing, AI_ECONOMICS_PACK);
  result.topics[0].keywords.push("تغییر");

  assert.deepEqual(existing[0].keywords, ["artificial intelligence"]);
});

test("normalizeSourceUrl ignores case, trailing slashes and fragments", () => {
  assert.equal(
    normalizeSourceUrl("https://Example.COM/rss/"),
    normalizeSourceUrl("https://example.com/rss#section"),
  );
  assert.equal(normalizeSourceUrl("https://example.com/feeds?x=1"), "https://example.com/feeds?x=1");
  assert.equal(normalizeSourceUrl("not a url///"), "not a url");
});

test("appendAudienceNote adds The Economics of AI context exactly once", () => {
  const prompt = "شما یک اقتصاددان حوزهٔ هوش مصنوعی هستید.";
  const first = appendAudienceNote(prompt, AI_ECONOMICS_PACK);

  assert.equal(first.alreadyPresent, false);
  assert.ok(first.prompt.startsWith(prompt));
  assert.ok(first.prompt.includes(AI_ECONOMICS_PACK.audienceNote));

  const second = appendAudienceNote(first.prompt, AI_ECONOMICS_PACK);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.prompt, first.prompt);
});

test("pack ships a bilingual deny-list of off-topic keywords", () => {
  assert.ok((AI_ECONOMICS_PACK.blockedKeywords ?? []).includes("nfl"));
  assert.ok((AI_ECONOMICS_PACK.blockedKeywords ?? []).includes("celebrity gossip"));
  assert.ok((AI_ECONOMICS_PACK.blockedKeywords ?? []).includes("ورزش"));
  assert.ok((AI_ECONOMICS_PACK.blockedKeywords ?? []).includes("حوادث"));
});

test("mergeBlockedKeywords appends only new keywords", () => {
  const first = mergeBlockedKeywords(["ورزش"], AI_ECONOMICS_PACK);
  assert.ok(first.added.includes("حوادث"));
  assert.ok(first.skipped.includes("ورزش"));
  assert.equal(first.blockedKeywords[0], "ورزش");

  const second = mergeBlockedKeywords(first.blockedKeywords, AI_ECONOMICS_PACK);
  assert.deepEqual(second.added, []);
  assert.equal(second.blockedKeywords.length, first.blockedKeywords.length);
});

test("mergeBlockedKeywords ignores letter variants and blanks", () => {
  const result = mergeBlockedKeywords(["فوتبال"], {
    ...AI_ECONOMICS_PACK,
    blockedKeywords: ["فوتبال", "  ", "فوتبال"],
  });
  assert.deepEqual(result.added, []);
});

test("ai-economics pack covers core Economics of AI keywords and authoritative sources", () => {
  const allKeywords = AI_ECONOMICS_PACK.topics.flatMap((topic) => topic.keywords);
  for (const key of [
    "economics of ai",
    "ai productivity",
    "ai and jobs",
    "task automation",
    "semiconductor",
    "ai capex",
    "ai investment",
    "ai regulation",
  ]) {
    assert.ok(allKeywords.includes(key), `expected keyword "${key}" in pack`);
  }
  const sourceHosts = AI_ECONOMICS_PACK.sources.map((s) => new URL(s.url).hostname);
  assert.ok(sourceHosts.some((h) => h.includes("brookings.edu")));
  assert.ok(sourceHosts.some((h) => h.includes("nber.org")));
  assert.ok(sourceHosts.some((h) => h.includes("technologyreview.com")));
  assert.ok(sourceHosts.some((h) => h.includes("project-syndicate.org")));
});

test("ai-economics pack topic gate rejects off-topic NBER general economics papers while passing AI-economics articles", () => {
  const activeFilter = {
    enabled: true,
    topics: AI_ECONOMICS_PACK.topics.map((t) => ({ ...t, enabled: true })),
    blockedKeywords: [...AI_ECONOMICS_PACK.blockedKeywords],
  };

  // Exact NBER off-topic working paper from user screenshot + general economics papers:
  const offTopicPapers = [
    {
      title: "College Success: Understanding the Roles of Financial Aid, Loans, and Student Support",
      description:
        "Using administrative data from higher education, we estimate how financial aid packages affect human capital accumulation, labor market earnings, and wage inequality.",
      content: null,
    },
    {
      title: "Monetary Policy, Housing Supply, and Economic Growth Across Metropolitan Labor Markets",
      description:
        "We study mortgage rate transmission, venture capital flows, monopoly market power, and competition policy in retail.",
      content: null,
    },
  ];

  for (const paper of offTopicPapers) {
    const verdict = evaluateTopicFilter(paper, activeFilter);
    assert.notEqual(
      verdict.verdict,
      "pass",
      `expected off-topic paper "${paper.title}" to be filtered out, but matched: ${JSON.stringify(verdict)}`,
    );
  }

  // Genuine Economics of AI articles must pass:
  const onTopicPapers = [
    {
      title: "Generative AI, Task Automation, and the Macroeconomics of Productivity Growth",
      description:
        "Daron Acemoglu and Erik Brynjolfsson evaluate how large language model adoption reshapes wage inequality and firm productivity.",
      content: null,
    },
    {
      title: "Hyperscaler AI Capex, NVIDIA GPU Bottlenecks, and Token Inference Cost Curves",
      description: "An empirical analysis of data center investment and unit economics in foundation models.",
      content: null,
    },
  ];

  for (const paper of onTopicPapers) {
    const verdict = evaluateTopicFilter(paper, activeFilter);
    assert.equal(verdict.verdict, "pass", `expected AI-economics paper "${paper.title}" to pass`);
  }
});

test("upgradeLegacyPackTopicFilter replaces retired pack-econ-* and stale pack-aiecon-* keywords while keeping custom topics", () => {
  const legacyFilter = {
    enabled: true,
    topics: [
      {
        id: "pack-econ-labor",
        label: "بازار کار قدیمی",
        enabled: true,
        keywords: ["labor market", "human capital", "financial aid"],
      },
      {
        id: "pack-aiecon-labor-workforce",
        label: "بازار کار، مشاغل، دستمزد و سرمایه انسانی",
        enabled: false,
        keywords: ["labor market", "workforce", "human capital"],
      },
      {
        id: "custom-operator-topic",
        label: "موضوع سفارشی ادمین",
        enabled: true,
        keywords: ["anthropic claude enterprise"],
      },
    ],
    blockedKeywords: ["sports"],
  };

  const upgraded = upgradeLegacyPackTopicFilter(legacyFilter);
  assert.ok(!upgraded.topics.some((t) => t.id.startsWith("pack-econ-")), "retired pack-econ-* must be removed");
  assert.ok(upgraded.topics.some((t) => t.id === "custom-operator-topic"), "custom operator topic must be preserved");

  const laborTopic = upgraded.topics.find((t) => t.id === "pack-aiecon-labor-workforce");
  assert.ok(laborTopic);
  assert.equal(laborTopic.enabled, false, "disabled state of pack-aiecon-* topic must be respected");
  assert.ok(!laborTopic.keywords.includes("labor market"), "broad non-AI keyword must be purged");

  // Filter without any pack topics (e.g. DEFAULT_TOPIC_FILTER) stays completely untouched:
  const emptyFilter = { enabled: false, topics: [], blockedKeywords: [] };
  assert.equal(upgradeLegacyPackTopicFilter(emptyFilter), emptyFilter);
});
