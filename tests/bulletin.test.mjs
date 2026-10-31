import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BULLETIN_ITEMS,
  DEFAULT_BULLETIN_SETTINGS,
  resolveBulletinSettings,
  validateBulletinSettings,
  buildBulletinMessage,
  pickBulletinItems,
} from "../src/lib/delivery/bulletin.ts";

const item = (overrides) => ({
  id: "n1",
  title: "انتشار رتبه‌بندی اعتباری شرکت‌های بزرگ",
  oneLiner: "خلاصه کوتاه خبر.",
  whyItMatters: "به سبد اعتباری بانک‌ها مربوط است.",
  url: "https://example.com/news/1",
  importanceScore: 80,
  publishedAt: new Date("2026-10-18T08:00:00Z"),
  ...overrides,
});

test("buildBulletinMessage: header, intro, and per-item minimal columns", () => {
  const text = buildBulletinMessage({
    intro: "امروز محور اصلی، تحولات رتبه‌بندی اعتباری بود.",
    items: [item({}), item({ id: "n2", title: "خبر دوم", url: "https://example.com/news/2" })],
    generatedAt: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  });

  assert.ok(text.startsWith("🗞️ بولتن خبری"));
  const introAt = text.indexOf("امروز محور اصلی");
  const firstTitleAt = text.indexOf("1️⃣ انتشار رتبه‌بندی");
  const secondTitleAt = text.indexOf("2️⃣ خبر دوم");
  assert.ok(introAt > 0);
  assert.ok(firstTitleAt > introAt);
  assert.ok(secondTitleAt > firstTitleAt);
  assert.ok(text.includes("خلاصه کوتاه خبر."));
  assert.ok(text.includes("چرا مهم است: به سبد اعتباری بانک‌ها مربوط است."));
  assert.ok(text.includes("[لینک اصلی خبر](https://example.com/news/1)"));
});

test("buildBulletinMessage: no intro block when AI brief is missing", () => {
  const text = buildBulletinMessage({
    intro: null,
    items: [item({})],
    generatedAt: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  });
  const lines = text.split("\n");
  assert.equal(lines[0].startsWith("🗞️ بولتن خبری"), true);
  // Second line is a blank separator straight before the first item.
  assert.ok(text.includes("1️⃣ "));
});

test("buildBulletinMessage: long fields are compacted", () => {
  const text = buildBulletinMessage({
    intro: "متن ".repeat(300),
    items: [item({ title: "عنوان ".repeat(60), oneLiner: "خط ".repeat(80) })],
    generatedAt: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  });
  for (const line of text.split("\n")) {
    assert.ok(line.length < 700, `line too long: ${line.slice(0, 40)}…`);
  }
});

test("buildBulletinMessage: invalid timezone falls back to ISO date", () => {
  const text = buildBulletinMessage({
    intro: null,
    items: [],
    generatedAt: new Date("2026-10-18T12:00:00Z"),
    timezone: "Not/AZone",
  });
  assert.ok(text.includes("2026-10-18"));
});

test("pickBulletinItems: ranks by importance then recency, caps at max", () => {
  const older = new Date("2026-10-17T08:00:00Z");
  const newer = new Date("2026-10-18T08:00:00Z");
  const picked = pickBulletinItems(
    [
      item({ id: "low", importanceScore: 40, publishedAt: newer }),
      item({ id: "high-old", importanceScore: 90, publishedAt: older }),
      item({ id: "high-new", importanceScore: 90, publishedAt: newer }),
      item({ id: "mid", importanceScore: 60, publishedAt: newer }),
    ],
    3,
  );
  assert.deepEqual(
    picked.map((entry) => entry.id),
    ["high-new", "high-old", "mid"],
  );
});

test("pickBulletinItems: never exceeds MAX_BULLETIN_ITEMS", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    item({ id: `n${index}`, importanceScore: 100 - index }),
  );
  assert.equal(pickBulletinItems(many).length, MAX_BULLETIN_ITEMS);
  assert.equal(pickBulletinItems(many, 2).length, 2);
});

test("buildBulletinMessage: corroborated item lists the other outlets", () => {
  const text = buildBulletinMessage({
    intro: null,
    items: [
      item({
        corroborated: true,
        corroborationSources: ["ایسنا", "مهر"],
      }),
    ],
    generatedAt: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  });
  assert.ok(text.includes("تأییدشده توسط ۳ منبع: ایسنا، مهر"));
});

test("buildBulletinMessage: corroborated without names still shows the badge", () => {
  const text = buildBulletinMessage({
    intro: null,
    items: [item({ corroborated: true })],
    generatedAt: new Date("2026-10-18T12:00:00Z"),
    timezone: "Asia/Tehran",
  });
  assert.ok(text.includes("تأییدشده توسط چند منبع ✓"));
});


test("bulletin settings preserve defaults for old configurations", () => {
  assert.deepEqual(resolveBulletinSettings(), DEFAULT_BULLETIN_SETTINGS);
  assert.deepEqual(validateBulletinSettings(undefined), []);
  const args = {intro: "مقدمه نمونه", items: [item({})], generatedAt: new Date("2026-01-01T12:00:00Z"), timezone: "Asia/Tehran"};
  assert.equal(buildBulletinMessage(args), buildBulletinMessage({...args, settings: DEFAULT_BULLETIN_SETTINGS}));
});

test("bulletin controls change title, count and optional sections, preserving source link", () => {
  const output = buildBulletinMessage({
    intro: "مقدمه نباید باشد", generatedAt: new Date("2026-01-01T12:00:00Z"), timezone: "Asia/Tehran",
    items: [item({entityTags:["نهاد نمونه"], corroborated: true}), item({title:"خبر دوم"})],
    settings: {title:"گزارش اختصاصی", maxItems:1, aiIntro:false, showSummary:false, showWhy:false, showEntities:false, showSources:false},
  });
  assert.ok(output.includes("گزارش اختصاصی"));
  assert.ok(output.includes("https://example.com/news/1"));
  for (const absent of ["خبر دوم", "مقدمه نباید باشد", "خلاصه کوتاه خبر", "چرا مهم است", "نهاد نمونه", "تأییدشده"]) assert.ok(!output.includes(absent));
});

test("bulletin validation rejects invalid limits, flags, text and containers", () => {
  for (const value of [null, [], {maxItems:0}, {maxItems:6}, {maxItems:1.5}, {introMaxTokens:501}, {introMaxTokens:0}, {aiIntro:"false"}, {title:" "}, {introPrompt:""}]) {
    assert.ok(validateBulletinSettings(value).length > 0);
  }
  assert.deepEqual(validateBulletinSettings({maxItems:3, aiIntro:false, introMaxTokens:50}), []);
});

test('custom bulletin and repeated item templates shape actual rendered output', () => {
  const output = buildBulletinMessage({intro:'مقدمه', generatedAt:new Date('2026-01-01T00:00:00Z'), timezone:'UTC',
    items:[item({title:'اول'}),item({title:'دوم'})], settings:{template:'گزارش {title} ({count})\n{intro}\n{items}',itemTemplate:'{number} {title} | {importanceScore}\n{originalUrl}'}});
  assert.ok(output.startsWith('گزارش بولتن خبری (2)'));
  assert.ok(output.includes('1️⃣ اول | 80'));
  assert.ok(output.includes('2️⃣ دوم | 80'));
  assert.ok(!output.includes('خلاصه کوتاه خبر'));
});

test('custom templates honor visibility toggles, append omitted links and replace once only', () => {
  const output = buildBulletinMessage({intro:'مقدمه مخفی',generatedAt:new Date('2026-01-01'),timezone:'UTC',items:[item({title:'{summary}'})],
    settings:{aiIntro:false,showSummary:false,template:'{intro}\n{items}',itemTemplate:'{title}\n{summary}\n{whyBlock}'}});
  assert.ok(output.includes('{summary}')); // source data cannot inject template substitutions
  assert.ok(output.includes('https://example.com/news/1'));
  assert.ok(!output.includes('مقدمه مخفی'));
  assert.ok(!output.includes('خلاصه کوتاه خبر'));
});

test('bulletin templates validate unknown variables, type, length and required items', () => {
  for (const value of [{template:'بدون خبر'}, {template:'{items} {unknown}'}, {itemTemplate:'{unknown}'}, {template:42}, {itemTemplate:'x'.repeat(8001)}]) {
    assert.ok(validateBulletinSettings(value).length > 0);
  }
  assert.deepEqual(validateBulletinSettings({template:'{title}\n{items}',itemTemplate:'{title}\n{originalUrl}'}),[]);
  assert.deepEqual(validateBulletinSettings({template:'',itemTemplate:''}),[]);
});


test('daily ranking prioritizes both relevance and importance, capped at five', () => {
  const rows = [
    {id:'imbalanced', importanceScore:100, relevanceScore:51, publishedAt:null},
    ...Array.from({length:6},(_,i)=>({id:String(i),importanceScore:85-i,relevanceScore:85-i,publishedAt:null})),
  ];
  const result = pickBulletinItems(rows,5);
  assert.equal(result.length,5);
  assert.deepEqual(result.map(row=>row.id),['0','1','2','3','4']);
});
