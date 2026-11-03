import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_BLOCKED_KEYWORDS,
  evaluateTopicFilter,
  evaluateWithFirstParagraphFallback,
  extractOpeningParagraphForGate,
  isTopicGateActive,
  isTopicFilterActive,
  keywordMatchesHaystack,
  normalizeForMatch,
} from "../src/lib/news/topic-filter.ts";

const filter = (overrides) => ({
  enabled: true,
  mode: "include",
  topics: [],
  ...overrides,
});

const topic = (overrides) => ({
  id: "t1",
  label: "سیاست پولی",
  enabled: true,
  keywords: ["monetary policy", "central bank", "fed"],
  ...overrides,
});

test("normalizeForMatch folds Persian/Arabic variants, Latin case and ZWNJ", () => {
  assert.equal(normalizeForMatch("كي‌مي‌شود"), normalizeForMatch("کیمیشود"));
  assert.equal(normalizeForMatch("می‌شود"), normalizeForMatch("میشود"));
  assert.equal(normalizeForMatch("بانك"), normalizeForMatch("بانک"));
  assert.equal(normalizeForMatch("  Monetary Policy  "), "monetary policy");
  assert.equal(normalizeForMatch(null), "");
});

test("disabled filter passes everything (fail-open)", () => {
  const outcome = evaluateTopicFilter({ title: "Why Global Productivity Is Shifting" }, filter({ enabled: false }));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.reason, "filter_disabled");
});

test("missing/null filter passes everything (fail-open)", () => {
  assert.equal(evaluateTopicFilter({ title: "x" }, null).verdict, "pass");
  assert.equal(evaluateTopicFilter({ title: "x" }, undefined).verdict, "pass");
});

test("filter with no effective keywords passes everything (fail-open)", () => {
  const outcome = evaluateTopicFilter(
    { title: "Unrelated note" },
    filter({ topics: [topic({ keywords: [] }), topic({ id: "t2", enabled: false, keywords: ["gdp"] })] }),
  );
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.reason, "no_effective_topics");
});

test("include mode: matching English economic topic passes, non-matching is skipped", () => {
  const f = filter({ topics: [topic()] });

  const hit = evaluateTopicFilter({ title: "How Monetary Policy Transmits Under High Public Debt" }, f);
  assert.equal(hit.verdict, "pass");
  assert.equal(hit.reason, "matched_topic");
  assert.deepEqual(hit.matchedTopics, ["سیاست پولی"]);

  const miss = evaluateTopicFilter({ title: "Architecture Trends in Urban Design" }, f);
  assert.equal(miss.verdict, "skip");
  assert.equal(miss.reason, "not_in_selected_topics");
});

test("include mode matches across title/description/content and ORs topics", () => {
  const f = filter({
    topics: [topic(), topic({ id: "t2", label: "تجارت جهانی", keywords: ["supply chain", "tariff"] })],
  });

  const viaDescription = evaluateTopicFilter(
    { title: "Global Outlook", description: "New tariff regimes reshape industrial policy" },
    f,
  );
  assert.equal(viaDescription.verdict, "pass");
  assert.deepEqual(viaDescription.matchedTopics, ["تجارت جهانی"]);

  const viaContent = evaluateTopicFilter(
    { title: "Research Column", content: "Central bank balance sheets remain elevated." },
    f,
  );
  assert.equal(viaContent.verdict, "pass");
  assert.deepEqual(viaContent.matchedTopics, ["سیاست پولی"]);
});

test("short ASCII acronyms match on word boundaries and never inside longer words", () => {
  // CRITICAL: "nfl" is inside "i-nfl-ation"! Must NEVER block inflation articles!
  assert.equal(keywordMatchesHaystack("nfl", normalizeForMatch("Global inflation expectations eased")), false);
  assert.equal(keywordMatchesHaystack("nfl", normalizeForMatch("NFL playoffs draw record audience")), true);

  assert.equal(keywordMatchesHaystack("fed", normalizeForMatch("Portfolios stuffed with tech stocks")), false);
  assert.equal(keywordMatchesHaystack("fed", normalizeForMatch("The Fed signaled patience on rate cuts")), true);
  assert.equal(keywordMatchesHaystack("fed", normalizeForMatch("Fed's balance sheet runoff slows")), true);

  assert.equal(keywordMatchesHaystack("imf", normalizeForMatch("A simplified tax model")), false);
  assert.equal(keywordMatchesHaystack("imf", normalizeForMatch("IMF warns on sovereign debt")), true);

  assert.equal(keywordMatchesHaystack("ai", normalizeForMatch("Economists said growth remained steady")), false);
  assert.equal(keywordMatchesHaystack("ai", normalizeForMatch("AI adoption and labor productivity")), true);
});

test("inflation articles pass the baseline deny-list cleanly without colliding with NFL", () => {
  const outcome = evaluateTopicFilter(
    {
      title: "Why Core Inflation Remains Sticky in Services Sectors",
      description: "Central banks face persistent wage and service price pressures.",
    },
    null,
  );
  assert.equal(outcome.verdict, "pass");
});

test("multi-word keywords match as phrases", () => {
  const f = filter({ topics: [topic({ keywords: ["monetary policy"] })] });
  assert.equal(evaluateTopicFilter({ title: "Monetary policy in a fragmented world" }, f).verdict, "pass");
  assert.equal(evaluateTopicFilter({ title: "Monetary aggregates and fiscal policy" }, f).verdict, "skip");
});

test("Persian keywords match regardless of ZWNJ/Arabic letter variants", () => {
  const f = filter({ topics: [topic({ keywords: ["سیاست پولی"] })] });
  assert.equal(evaluateTopicFilter({ title: "سياست پولي بانک مرکزی" }, f).verdict, "pass");
});

test("exclude mode: matching topic is skipped, others pass", () => {
  const f = filter({ mode: "exclude", topics: [topic({ label: "رمزارز تبلیغاتی", keywords: ["memecoin"] })] });

  const noise = evaluateTopicFilter({ title: "Top memecoin rally today" }, f);
  assert.equal(noise.verdict, "skip");
  assert.equal(noise.reason, "matched_excluded_topic");

  const keep = evaluateTopicFilter({ title: "Sovereign debt sustainability in emerging markets" }, f);
  assert.equal(keep.verdict, "pass");
});

test("disabled topic rows are ignored", () => {
  const f = filter({ topics: [topic({ enabled: false })] });
  const outcome = evaluateTopicFilter({ title: "Central bank independence" }, f);
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.reason, "no_effective_topics");
});

test("blocked keywords win in include mode even when a topic matches", () => {
  const f = filter({ topics: [topic()], blockedKeywords: ["celebrity gossip", "فوتبال"] });
  const outcome = evaluateTopicFilter({ title: "Monetary policy joke in celebrity gossip column" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
  assert.deepEqual(outcome.blockedKeywords, ["celebrity gossip"]);
  assert.deepEqual(outcome.matchedTopics, []);
});

test("blocked keywords win in exclude mode too", () => {
  const f = filter({ mode: "exclude", topics: [topic()], blockedKeywords: ["حوادث"] });
  const outcome = evaluateTopicFilter({ title: "گزارش حوادث جاده‌ای" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
});

test("deny-list-only configuration filters blocked news and passes the rest", () => {
  const f = filter({ topics: [], blockedKeywords: ["horoscope", "سرگرمی"] });

  const blocked = evaluateTopicFilter({ title: "Daily horoscope and astrology" }, f);
  assert.equal(blocked.verdict, "skip");
  assert.equal(blocked.reason, "matched_blocked_keyword");

  const allowed = evaluateTopicFilter({ title: "Fiscal multipliers in open economies" }, f);
  assert.equal(allowed.verdict, "pass");
  assert.equal(allowed.reason, "no_excluded_match");
});

test("blocked keyword matching is Persian-normalized", () => {
  const f = filter({ topics: [topic()], blockedKeywords: ["سینما"] });
  const outcome = evaluateTopicFilter({ title: "بازگشت هنرمندان به سينما" }, f);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
});

test("isTopicFilterActive recognises a deny-list-only configuration", () => {
  assert.equal(isTopicFilterActive(filter({ topics: [], blockedKeywords: ["ورزش"] })), true);
  assert.equal(isTopicFilterActive(filter({ topics: [], blockedKeywords: ["  "] })), false);
});

test("isTopicFilterActive reflects real narrowing only", () => {
  assert.equal(isTopicFilterActive(null), false);
  assert.equal(isTopicFilterActive(filter({ enabled: false })), false);
  assert.equal(isTopicFilterActive(filter({ topics: [topic({ keywords: [] })] })), false);
  assert.equal(isTopicFilterActive(filter({ topics: [topic()] })), true);
});

test("baseline deny-list blocks English and Persian off-topic news even when the filter is disabled", () => {
  const enSports = evaluateTopicFilter({ title: "Premier League title race heats up" }, filter({ enabled: false }));
  assert.equal(enSports.verdict, "skip");
  assert.equal(enSports.reason, "matched_blocked_keyword");
  assert.deepEqual(enSports.blockedKeywords, ["premier league"]);

  const faSports = evaluateTopicFilter({ title: "تجاری‌شدن ورزش کودکان" }, filter({ enabled: false }));
  assert.equal(faSports.verdict, "skip");
  assert.equal(faSports.reason, "matched_blocked_keyword");
  assert.deepEqual(faSports.blockedKeywords, ["ورزش"]);
});

test("baseline deny-list applies when no filter is configured at all", () => {
  const outcome = evaluateTopicFilter({ title: "تصادف زنجیره‌ای در جاده" }, null);
  assert.equal(outcome.verdict, "skip");
  assert.equal(outcome.reason, "matched_blocked_keyword");
  assert.deepEqual(outcome.blockedKeywords, ["تصادف"]);
});

test("isTopicGateActive is always armed (baseline) while isTopicFilterActive is not", () => {
  assert.equal(isTopicGateActive(null), true);
  assert.equal(isTopicGateActive(filter({ enabled: false })), true);
  assert.equal(isTopicFilterActive(null), false);
});

test("baseline list is conservative and never blocks core economic terms", () => {
  assert.ok(BASELINE_BLOCKED_KEYWORDS.length > 0);
  for (const safeWord of ["economy", "inflation", "bank", "credit", "trade", "اقتصاد", "تورم", "بانک"]) {
    assert.equal(BASELINE_BLOCKED_KEYWORDS.includes(safeWord), false);
  }
});

test("operator baseline override replaces defaults even when topic filter is off", () => {
  const custom = { enabled: false, mode: "include", topics: [], baselineBlockedKeywords: ["نمونه ممنوع"] };
  assert.equal(evaluateTopicFilter({ title: "Premier League match" }, custom).verdict, "pass");
  assert.equal(evaluateTopicFilter({ title: "نمونه ممنوع" }, custom).verdict, "skip");
  assert.equal(evaluateTopicFilter({ title: "Premier League match" }, { ...custom, baselineBlockedKeywords: [] }).verdict, "pass");
  assert.equal(evaluateTopicFilter({ title: "Premier League match" }, null).verdict, "skip");
});

test("evaluateWithFirstParagraphFallback rescues title-ambiguous reports when the opening paragraph is on-topic", async () => {
  const aiFilter = filter({
    topics: [
      topic({
        id: "ai-econ",
        label: "اقتصاد هوش مصنوعی",
        keywords: ["artificial intelligence", "generative ai", "large language model"],
      }),
    ],
  });

  let fetchCalls = 0;
  const rescued = await evaluateWithFirstParagraphFallback(
    {
      url: "https://www.nber.org/papers/w33100",
      title: "Tasks, Wages, and the Future of White-Collar Work",
      description: "by Daron Acemoglu, Pascual Restrepo",
      content: null,
    },
    aiFilter,
    async () => {
      fetchCalls += 1;
      return [
        "## Abstract",
        "by Daron Acemoglu, Pascual Restrepo",
        "We study the macroeconomic and labor-market consequences of generative artificial intelligence across administrative task records in US firms over the next decade.",
        "Subsequent sections calibrate capital deepening and total factor productivity.",
      ].join("\n\n");
    },
  );

  assert.equal(fetchCalls, 1);
  assert.equal(rescued.checkedFirstParagraph, true);
  assert.equal(rescued.outcome.verdict, "pass");
  assert.deepEqual(rescued.outcome.matchedTopics, ["اقتصاد هوش مصنوعی"]);
  assert.ok(rescued.firstParagraph?.includes("generative artificial intelligence"));
});

test("evaluateWithFirstParagraphFallback inspects only the opening paragraph and ignores bottom-of-page noise", async () => {
  const aiFilter = filter({
    topics: [
      topic({
        id: "ai-econ",
        label: "اقتصاد هوش مصنوعی",
        keywords: ["generative ai", "artificial intelligence"],
      }),
    ],
  });

  const genuinelyOfftopic = await evaluateWithFirstParagraphFallback(
    {
      url: "https://www.nber.org/papers/w33101",
      title: "Grain Tariffs and Rural Land Values in Nineteenth-Century France",
      description: "by Pierre Blanc",
      content: null,
    },
    aiFilter,
    async () =>
      [
        "This paper examines how the Meline tariff of 1892 altered agricultural land rents, wheat prices, and internal rural migration across French departements using newly digitized cadastral records from 1875 to 1910.",
        "Second paragraph discusses regional railroad freight costs and grain market integration.",
        "Footer teaser far below: Read more in our generative AI working group.",
      ].join("\n\n"),
  );

  assert.equal(genuinelyOfftopic.checkedFirstParagraph, true);
  assert.equal(genuinelyOfftopic.outcome.verdict, "skip");
  assert.equal(genuinelyOfftopic.outcome.reason, "not_in_selected_topics");
});

test("evaluateWithFirstParagraphFallback skips network fetch when title already matches, hits deny-list, or has empty sentinel", async () => {
  const aiFilter = filter({
    topics: [topic({ id: "ai-econ", label: "اقتصاد هوش مصنوعی", keywords: ["generative ai"] })],
  });

  let calls = 0;
  const neverCalled = async () => {
    calls += 1;
    return "generative ai paragraph";
  };

  // 1) Already matches on title -> 0 fetches
  const directPass = await evaluateWithFirstParagraphFallback(
    { url: "https://example.com/1", title: "Generative AI and Firm Productivity", content: null },
    aiFilter,
    neverCalled,
  );
  assert.equal(directPass.outcome.verdict, "pass");
  assert.equal(directPass.checkedFirstParagraph, false);

  // 2) Blocked keyword in title -> 0 fetches
  const blocked = await evaluateWithFirstParagraphFallback(
    { url: "https://example.com/2", title: "Premier League Final Preview", content: null },
    aiFilter,
    neverCalled,
  );
  assert.equal(blocked.outcome.verdict, "skip");
  assert.equal(blocked.checkedFirstParagraph, false);

  // 3) Empty-string sentinel (`content === ""`) -> already probed previously -> 0 fetches
  const alreadyProbed = await evaluateWithFirstParagraphFallback(
    { url: "https://example.com/3", title: "Ambiguous Macro Headline", content: "" },
    aiFilter,
    neverCalled,
  );
  assert.equal(alreadyProbed.outcome.verdict, "skip");
  assert.equal(alreadyProbed.checkedFirstParagraph, false);
  assert.equal(calls, 0);
  assert.equal(extractOpeningParagraphForGate("## Heading\nby Jane Doe"), null);
});
