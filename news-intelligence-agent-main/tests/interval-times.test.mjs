import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntervalTimes,
  detectInterval,
  intervalLabel,
  minutesOf,
  toPersianDigits,
} from "../src/lib/agent/interval-times.ts";
import { effectiveGraceMinutes } from "../src/lib/agent/schedule.ts";

test("minutesOf parses valid wall-clock times and rejects garbage", () => {
  assert.equal(minutesOf("00:00"), 0);
  assert.equal(minutesOf("8:05"), 485);
  assert.equal(minutesOf("23:59"), 1439);
  assert.equal(minutesOf("24:00"), null);
  assert.equal(minutesOf("08:60"), null);
  assert.equal(minutesOf("۸:۰۰"), null);
  assert.equal(minutesOf(""), null);
});

test("buildIntervalTimes covers a full day at 30-minute steps", () => {
  const times = buildIntervalTimes(30);

  assert.equal(times.length, 48);
  assert.equal(times[0], "00:00");
  assert.equal(times[1], "00:30");
  assert.equal(times.at(-1), "23:30");
  assert.equal(new Set(times).size, times.length);
});

test("buildIntervalTimes handles 15, 60 and 120 minute steps", () => {
  assert.equal(buildIntervalTimes(15).length, 96);
  assert.equal(buildIntervalTimes(60).length, 24);
  assert.equal(buildIntervalTimes(120).length, 12);
  assert.deepEqual(buildIntervalTimes(0), []);
  assert.deepEqual(buildIntervalTimes(-30), []);
});

test("detectInterval recognises full-day uniform schedules", () => {
  assert.equal(detectInterval(buildIntervalTimes(30)), 30);
  assert.equal(detectInterval(buildIntervalTimes(15)), 15);
  assert.equal(detectInterval(buildIntervalTimes(60)), 60);
  assert.equal(detectInterval(buildIntervalTimes(120)), 120);
});

test("detectInterval ignores hand-picked and non-uniform schedules", () => {
  assert.equal(detectInterval(["08:00"]), null);
  assert.equal(detectInterval(["08:00", "20:00"]), null);
  assert.equal(detectInterval(["08:00", "08:30", "09:00", "12:00"]), null);
  assert.equal(detectInterval(["08:00", "08:15", "08:30", "08:45"]), null); // does not cover the day
  assert.equal(detectInterval(["08:00", "08:15", "08:30", "08:45", "09:00", "bad"]), null);
});

test("a 30-minute schedule gets a 30-minute grace window", () => {
  assert.equal(effectiveGraceMinutes(buildIntervalTimes(30)), 30);
  assert.equal(effectiveGraceMinutes(buildIntervalTimes(15)), 15);
  assert.equal(effectiveGraceMinutes(buildIntervalTimes(60)), 60);
});

test("toPersianDigits converts ASCII numbers", () => {
  assert.equal(toPersianDigits(120), "۱۲۰");
  assert.equal(toPersianDigits("30 دقیقه"), "۳۰ دقیقه");
});

test("interval labels are Persian", () => {
  assert.equal(intervalLabel(15), "هر ۱۵ دقیقه");
  assert.equal(intervalLabel(30), "هر ۳۰ دقیقه");
  assert.equal(intervalLabel(60), "هر ۱ ساعت");
  assert.equal(intervalLabel(120), "هر ۲ ساعت");
});
