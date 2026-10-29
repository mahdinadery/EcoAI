import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDossierStats,
  buildEntityStats,
  buildPublisherStats,
  compareStats,
  emptyMetricStat,
  sortStats,
} from "../src/lib/admin/dossier-stats.ts";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const row = (overrides = {}) => ({
  source: "ایسنا",
  entityTags: ["بانک ملت"],
  importanceScore: 80,
  corroborationCount: 0,
  publishedAt: new Date("2026-10-18T10:00:00.000Z"),
  createdAt: new Date("2026-10-18T09:00:00.000Z"),
  ...overrides,
});

test("publisher stats: count / avg over scored / max / buckets / corroboration", () => {
  const rows = [
    row({ source: "ایسنا", importanceScore: 80 }),
    row({ source: "ایسنا", importanceScore: 90 }),
    row({ source: "ایسنا", importanceScore: null }), // unscored: counted, not averaged
    row({ source: "مهر", importanceScore: 55, corroborationCount: 2 }),
    row({ source: "  ", importanceScore: 10 }), // empty publisher name skipped
  ];
  const stats = buildPublisherStats(rows, NOW);
  assert.deepEqual(
    stats.map((entry) => entry.name),
    ["ایسنا", "مهر"],
  );

  const isna = stats.find((entry) => entry.name === "ایسنا");
  assert.ok(isna);
  assert.equal(isna.count, 3);
  assert.equal(isna.scoredCount, 2);
  assert.equal(isna.avgImportance, 85); // (80+90)/2
  assert.equal(isna.maxImportance, 90);
  assert.equal(isna.highCount, 2);
  assert.equal(isna.midCount, 0);
  assert.equal(isna.lowCount, 0);
  assert.equal(isna.corroboratedCount, 0);

  const mehr = stats.find((entry) => entry.name === "مهر");
  assert.ok(mehr);
  assert.equal(mehr.avgImportance, 55);
  assert.equal(mehr.highCount, 0);
  assert.equal(mehr.midCount, 1);
  assert.equal(mehr.lowCount, 0);
  assert.equal(mehr.corroboratedCount, 1);
});

test("importance buckets: >=70 high, 40..69 mid, <40 low", () => {
  const stats = buildPublisherStats(
    [
      row({ importanceScore: 70 }),
      row({ importanceScore: 69 }),
      row({ importanceScore: 40 }),
      row({ importanceScore: 39 }),
      row({ importanceScore: 0 }),
    ],
    NOW,
  );
  assert.equal(stats[0].highCount, 1);
  assert.equal(stats[0].midCount, 2);
  assert.equal(stats[0].lowCount, 2);
});

test("time: last/first from publishedAt, fallback createdAt, ISO output", () => {
  const stats = buildPublisherStats(
    [
      row({ publishedAt: new Date("2026-10-10T00:00:00.000Z") }),
      row({ publishedAt: null, createdAt: new Date("2026-10-17T00:00:00.000Z") }),
      row({ publishedAt: new Date("2026-10-01T00:00:00.000Z") }),
    ],
    NOW,
  );
  assert.equal(stats[0].lastPublishedAt, "2026-10-17T00:00:00.000Z");
  assert.equal(stats[0].firstPublishedAt, "2026-10-01T00:00:00.000Z");
});

test("recent7d counts items within 7 days of now (mixed published/created)", () => {
  const stats = buildPublisherStats(
    [
      row({ publishedAt: new Date(NOW.getTime() - 2 * DAY) }),
      row({ publishedAt: null, createdAt: new Date(NOW.getTime() - 6 * DAY) }),
      row({ publishedAt: new Date(NOW.getTime() - 8 * DAY) }),
      row({ publishedAt: null, createdAt: new Date(NOW.getTime() - 30 * DAY) }),
    ],
    NOW,
  );
  assert.equal(stats[0].recent7d, 2);
});

test("entity stats: one count per tag, trims, skips empty tags and null lists", () => {
  const rows = [
    row({ entityTags: ["بانک ملت", "  ", "بورس کالا"] }),
    row({ entityTags: ["بانک ملت"] }),
    row({ entityTags: null }),
    row({ entityTags: [] }),
    row({ entityTags: ["  بانک مرکزی  "] }),
  ];
  const stats = buildEntityStats(rows, NOW);
  // Persian alphabetical order (fa collation): ر before ل, ا before و.
  assert.deepEqual(
    stats.map((entry) => entry.name),
    ["بانک مرکزی", "بانک ملت", "بورس کالا"],
  );
  assert.equal(stats[0].count, 1); // بانک مرکزی
  const mellat = stats.find((entry) => entry.name === "بانک ملت");
  assert.ok(mellat);
  assert.equal(mellat.count, 2);
});

test("kpis: totals, overall avg, corroborated count, last time", () => {
  const rows = [
    row({ importanceScore: 80, corroborationCount: 2 }),
    row({ importanceScore: 60, corroborationCount: 1 }),
    row({ importanceScore: null, corroborationCount: 3, publishedAt: null, createdAt: new Date("2026-10-19T11:00:00.000Z") }),
    row({ source: "مهر", entityTags: ["بانک مرکزی"], importanceScore: 90 }),
  ];
  const { publishers, entities, kpis } = buildDossierStats(rows, NOW);
  assert.equal(kpis.scanned, 4);
  assert.equal(kpis.publisherCount, 2);
  assert.equal(kpis.entityCount, 2); // بانک ملت + بانک مرکزی
  assert.equal(kpis.scoredCount, 3);
  assert.equal(kpis.avgImportance, 77); // (80+60+90)/3 = 76.67 → 77
  assert.equal(kpis.corroboratedCount, 2);
  assert.equal(kpis.lastPublishedAt, "2026-10-19T11:00:00.000Z");
});

test("compareStats: count sorts with Persian name tie-break, both directions", () => {
  const a = { ...emptyMetricStat("الف"), count: 5 };
  const b = { ...emptyMetricStat("ب"), count: 5 };
  const c = { ...emptyMetricStat("پ"), count: 9 };
  assert.equal(compareStats(a, b, "count", "desc"), a.name.localeCompare(b.name, "fa"));
  assert.equal(compareStats(b, a, "count", "desc"), b.name.localeCompare(a.name, "fa"));
  const sorted = sortStats([b, c, a], "count", "desc");
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ["پ", "الف", "ب"],
  );
});

test("compareStats: time keeps nulls last in BOTH directions", () => {
  const older = { ...emptyMetricStat("الف"), lastPublishedAt: "2026-10-01T00:00:00.000Z" };
  const newer = { ...emptyMetricStat("ب"), lastPublishedAt: "2026-10-18T00:00:00.000Z" };
  const never = { ...emptyMetricStat("پ"), lastPublishedAt: null };
  const desc = sortStats([never, older, newer], "time", "desc");
  assert.deepEqual(
    desc.map((entry) => entry.name),
    ["ب", "الف", "پ"],
  );
  const asc = sortStats([never, older, newer], "time", "asc");
  assert.deepEqual(
    asc.map((entry) => entry.name),
    ["الف", "ب", "پ"],
  );
});

test("compareStats: importance ties fall to max, then count, then name", () => {
  const a = { ...emptyMetricStat("الف"), avgImportance: 70, maxImportance: 90, count: 1 };
  const b = { ...emptyMetricStat("ب"), avgImportance: 70, maxImportance: 95, count: 1 };
  const c = { ...emptyMetricStat("پ"), avgImportance: 70, maxImportance: 90, count: 4 };
  assert.ok(compareStats(b, a, "importance", "desc") < 0); // higher max first
  assert.ok(compareStats(c, a, "importance", "desc") < 0); // higher count first
  const sorted = sortStats([a, c, b], "importance", "desc");
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ["ب", "پ", "الف"],
  );
});

test("sortStats returns a new array and never mutates the input", () => {
  const a = { ...emptyMetricStat("الف"), count: 1 };
  const b = { ...emptyMetricStat("ب"), count: 2 };
  const input = [a, b];
  const sorted = sortStats(input, "count", "desc");
  assert.deepEqual(
    input.map((entry) => entry.name),
    ["الف", "ب"],
  );
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ["ب", "الف"],
  );
});

test("emptyMetricStat is a safe dossier fallback", () => {
  const stat = emptyMetricStat("ناشر ناشناس");
  assert.equal(stat.count, 0);
  assert.equal(stat.avgImportance, 0);
  assert.equal(stat.lastPublishedAt, null);
  assert.equal(stat.recent7d, 0);
});
