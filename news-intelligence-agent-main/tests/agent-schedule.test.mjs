import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AGENT_SCHEDULE,
  coerceScheduleConfig,
  computeDueSlot,
  computeDueBulletinSlot,
  computeNextRun,
  describeSchedule,
  effectiveGraceMinutes,
  getZonedParts,
  isValidTimeZone,
  normalizeTime,
  normalizeTimes,
  validateScheduleInput,
  zonedTimeToUtc,
} from "../src/lib/agent/schedule.ts";

const schedule = (overrides = {}) => ({
  ...DEFAULT_AGENT_SCHEDULE,
  enabled: true,
  timezone: "Asia/Tehran",
  times: ["08:00"],
  ...overrides,
});

test("normalizeTimes pads, sorts, dedupes and drops invalid values", () => {
  assert.deepEqual(normalizeTimes(["20:30", "8:5", "08:05", "25:00", "ab", "00:00"]), [
    "00:00",
    "08:05",
    "20:30",
  ]);
  assert.deepEqual(normalizeTimes("08:00"), []);
  assert.deepEqual(normalizeTimes(null), []);
});

test("isValidTimeZone accepts IANA names and rejects garbage", () => {
  assert.equal(isValidTimeZone("Asia/Tehran"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("getZonedParts converts UTC to Tehran wall clock", () => {
  // 2026-10-17T05:00:00Z === 08:30 in Tehran (+03:30, no DST).
  const parts = getZonedParts(new Date("2026-10-17T05:00:00Z"), "Asia/Tehran");
  assert.deepEqual(parts, { year: 2026, month: 10, day: 17, hour: 8, minute: 30 });
});

test("zonedTimeToUtc maps a Tehran wall time to the right instant", () => {
  const at = zonedTimeToUtc("2026-10-17", "08:00", "Asia/Tehran");
  assert.equal(at.toISOString(), "2026-10-17T04:30:00.000Z");
});

test("a slot is due inside its grace window", () => {
  const result = computeDueSlot({
    now: new Date("2026-10-17T05:00:00Z"), // 08:30 Tehran
    config: schedule(),
    lastRunSlot: null,
  });

  assert.equal(result.due, true);
  assert.equal(result.slotKey, "2026-10-17T08:00");
  assert.equal(result.slotTime, "08:00");
  assert.equal(result.slotAt.toISOString(), "2026-10-17T04:30:00.000Z");
});

test("before the slot and after the grace window nothing runs", () => {
  const before = computeDueSlot({
    now: new Date("2026-10-17T04:00:00Z"), // 07:30 Tehran
    config: schedule(),
  });
  assert.equal(before.due, false);
  assert.equal(before.reason, "not_due");

  const after = computeDueSlot({
    now: new Date("2026-10-17T05:30:00Z"), // 09:00 Tehran, grace = 60m -> 09:00 is exclusive
    config: schedule(),
    graceMinutes: 30,
  });
  assert.equal(after.due, false);
});

test("effective grace follows the schedule cadence", () => {
  assert.equal(effectiveGraceMinutes(["08:00"]), 60);
  assert.equal(effectiveGraceMinutes(["08:00", "08:30", "09:00"]), 30);
  assert.equal(effectiveGraceMinutes(["08:00", "20:00"]), 60);
  assert.equal(effectiveGraceMinutes(["23:30", "00:00"]), 30);
});

test("a 30-minute cadence cannot fire an old slot after a newer one ran", () => {
  const times = Array.from({ length: 48 }, (_, index) => {
    const minutes = index * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });

  // 09:05 Tehran, the 09:00 slot already ran: the 08:30 slot is outside its
  // 30-minute window, so nothing runs (previously the 60-minute default would
  // have triggered a late second pass).
  const late = computeDueSlot({
    now: new Date("2026-10-17T05:35:00Z"),
    config: schedule({ times }),
    lastRunSlot: "2026-10-17T09:00",
  });
  assert.equal(late.due, false);
  assert.equal(late.reason, "already_ran");

  // At 09:05 with nothing run yet, the newest due slot (09:00) wins.
  const due = computeDueSlot({
    now: new Date("2026-10-17T05:35:00Z"),
    config: schedule({ times }),
    lastRunSlot: "2026-10-17T08:30",
  });
  assert.equal(due.due, true);
  assert.equal(due.slotKey, "2026-10-17T09:00");
});

test("the same slot never runs twice", () => {
  const result = computeDueSlot({
    now: new Date("2026-10-17T05:00:00Z"),
    config: schedule(),
    lastRunSlot: "2026-10-17T08:00",
  });
  assert.equal(result.due, false);
  assert.equal(result.reason, "already_ran");
});

test("the next day's slot is due again", () => {
  const result = computeDueSlot({
    now: new Date("2026-10-18T05:00:00Z"),
    config: schedule(),
    lastRunSlot: "2026-10-17T08:00",
  });
  assert.equal(result.due, true);
  assert.equal(result.slotKey, "2026-10-18T08:00");
});

test("disabled schedules and empty time lists never run", () => {
  assert.equal(computeDueSlot({ now: new Date(), config: schedule({ enabled: false }) }).due, false);
  assert.equal(
    computeDueSlot({ now: new Date(), config: schedule({ enabled: false }) }).reason,
    "disabled",
  );
  assert.equal(computeDueSlot({ now: new Date(), config: schedule({ times: [] }) }).reason, "no_times");
});

test("timezone changes the due decision", () => {
  const now = new Date("2026-10-17T05:00:00Z"); // 08:30 Tehran, 05:00 UTC
  assert.equal(computeDueSlot({ now, config: schedule({ timezone: "Asia/Tehran" }) }).due, true);
  assert.equal(computeDueSlot({ now, config: schedule({ timezone: "UTC" }) }).due, false);
});

test("computeNextRun returns the first future slot", () => {
  const next = computeNextRun({
    now: new Date("2026-10-17T00:00:00Z"), // 03:30 Tehran
    config: schedule(),
  });
  assert.equal(next.at.toISOString(), "2026-10-17T04:30:00.000Z");
  assert.equal(next.slotKey, "2026-10-17T08:00");

  const tomorrow = computeNextRun({
    now: new Date("2026-10-17T06:00:00Z"), // 09:30 Tehran, slot passed
    config: schedule(),
  });
  assert.equal(tomorrow.at.toISOString(), "2026-10-18T04:30:00.000Z");
});

test("multiple times: the latest due slot wins", () => {
  const result = computeDueSlot({
    now: new Date("2026-10-17T14:35:00Z"), // 18:05 Tehran
    config: schedule({ times: ["08:00", "18:00"] }),
  });
  assert.equal(result.due, true);
  assert.equal(result.slotTime, "18:00");
});

test("validateScheduleInput rejects enabled schedules without times and bad zones", () => {
  const empty = validateScheduleInput({ enabled: true, timezone: "Asia/Tehran", times: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(" "), /حداقل یک زمان/);

  const badZone = validateScheduleInput({ enabled: true, timezone: "Nowhere/City", times: ["08:00"] });
  assert.equal(badZone.ok, false);

  const badDestination = validateScheduleInput({
    enabled: true,
    timezone: "Asia/Tehran",
    times: ["08:00"],
    destination: "telegram",
  });
  assert.equal(badDestination.ok, false);
});

test("validateScheduleInput normalizes a valid payload", () => {
  const result = validateScheduleInput({
    enabled: true,
    timezone: "Asia/Tehran",
    times: ["20:15", "8:05", "20:15"],
    destination: "bale",
    minImportance: 140,
    maxAnalyze: 999,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.config.times, ["08:05", "20:15"]);
  assert.equal(result.config.minImportance, 100);
  assert.equal(result.config.maxAnalyze, 30);
  assert.equal(result.config.destination, "bale");
});

test("coerceScheduleConfig falls back safely for unknown values", () => {
  const config = coerceScheduleConfig({ timezone: "Nope", destination: "x", times: ["bad"] });
  assert.equal(config.timezone, DEFAULT_AGENT_SCHEDULE.timezone);
  assert.equal(config.destination, DEFAULT_AGENT_SCHEDULE.destination);
  assert.deepEqual(config.times, []);
  assert.equal(config.enabled, false);
});

test("describeSchedule is Persian and reflects the state", () => {
  assert.match(describeSchedule(schedule({ enabled: false }))[0], /خاموش/);
  const lines = describeSchedule(schedule({ times: ["08:00", "20:00"] }));
  assert.match(lines[0], /08:00 و 20:00/);
  assert.match(lines[1], /بله/);
});

test("normalizeTime accepts Persian and Arabic-Indic digits", () => {
  assert.equal(normalizeTime("۱۴:۳۰"), "14:30");
  assert.equal(normalizeTime("٠٨:٠٥"), "08:05");
  assert.equal(normalizeTime(" ۹:۰۵ "), "09:05");
  // Mixed digits also work (keyboard layouts do this).
  assert.equal(normalizeTime("1۴:3۰"), "14:30");
});

test("normalizeTimes keeps Persian-digit entries instead of dropping them", () => {
  assert.deepEqual(normalizeTimes(["۸:۰۰", "۱۴:۳۰", "۱۴:۳۰"]), ["08:00", "14:30"]);
});


test('bulletin catches up after cron delay beyond normal grace, within same local day', () => {
  const config = schedule({publishMode:'bulletin',bulletinTimes:['08:00','14:00']});
  const result = computeDueBulletinSlot({now:new Date('2026-10-28T14:30:00Z'),config});
  assert.equal(result.due,true);
  assert.equal(result.slotKey,'B2026-10-28T14:00');
});
test('bulletin catch-up does not run earlier slots after later slot claimed', () => {
  const config = schedule({publishMode:'bulletin',bulletinTimes:['08:00','14:00']});
  const result = computeDueBulletinSlot({now:new Date('2026-10-28T14:30:00Z'),config,lastBulletinSlot:'B2026-10-28T14:00'});
  assert.equal(result.due,false);
});
test('bulletin does not backfill yesterday before first slot today', () => {
  const config = schedule({publishMode:'bulletin',bulletinTimes:['08:00']});
  assert.equal(computeDueBulletinSlot({now:new Date('2026-10-28T01:00:00Z'),config,lastBulletinSlot:'B2026-10-27T08:00'}).due,false);
});
