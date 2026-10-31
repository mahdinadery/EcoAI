/**
 * Helpers for "every N minutes" schedule presets — pure, client-safe.
 *
 * The scheduler stores a plain list of local `HH:MM` slots, so an interval is
 * just an evenly spaced list covering the day (e.g. 48 slots for every 30
 * minutes). Keeping the math here makes it testable without React and lets the
 * dashboard collapse the long list into a single summary row.
 */

/** Parses "HH:MM" into minutes since midnight, or null when invalid. */
export function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Every `interval` minutes of a full day, as sorted "HH:MM" strings. */
export function buildIntervalTimes(interval: number): string[] {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const step = Math.round(interval);
  const times: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += step) {
    times.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return times;
}

/**
 * Returns the uniform repeat interval (minutes) when the list covers the day
 * evenly, otherwise null. Requires at least four slots so two or three
 * hand-picked times never get mislabelled as an interval.
 */
export function detectInterval(values: string[]): number | null {
  const minutes = values
    .map(minutesOf)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (minutes.length < 4) return null;

  let gap = 0;
  for (let index = 0; index < minutes.length; index += 1) {
    const next = index + 1 < minutes.length ? minutes[index + 1] : minutes[0] + 24 * 60;
    const currentGap = next - minutes[index];
    if (currentGap <= 0) return null;
    if (index === 0) gap = currentGap;
    else if (currentGap !== gap) return null;
  }

  return gap * minutes.length === 24 * 60 ? gap : null;
}

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toPersianDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

/** Persian label for an interval, e.g. 30 -> «هر ۳۰ دقیقه». */
export function intervalLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "هر ۱ ساعت" : `هر ${toPersianDigits(hours)} ساعت`;
  }
  return `هر ${toPersianDigits(minutes)} دقیقه`;
}
