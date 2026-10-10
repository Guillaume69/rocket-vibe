/**
 * Do not disturb, as the server applies it to push (`account_quiet`): muted
 * before `muted_until`, or inside the daily `quiet_hours` window read in its
 * own time zone (a window with start > end crosses midnight). The browser's
 * own notifications follow the same rule.
 */
import type { QuietHours, UserPreferences } from "./protocol";

/** Minutes since midnight at `now` in `zone`; the device's when it is unknown. */
export function minuteIn(zone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return value("hour") * 60 + value("minute");
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

export function covers(window: QuietHours, minute: number): boolean {
  return window.start_minute < window.end_minute
    ? minute >= window.start_minute && minute < window.end_minute
    : minute >= window.start_minute || minute < window.end_minute;
}

export function quietNow(
  preferences: UserPreferences | undefined,
  now: Date,
): boolean {
  if (!preferences) return false;
  const until = preferences.muted_until
    ? Date.parse(preferences.muted_until)
    : NaN;
  if (until > now.getTime()) return true;
  const window = preferences.quiet_hours;
  return !!window && covers(window, minuteIn(window.time_zone, now));
}

/** "22:00" for 1320. */
export function clock(minute: number): string {
  return (
    String(Math.floor(minute / 60)).padStart(2, "0") +
    ":" +
    String(minute % 60).padStart(2, "0")
  );
}

/** 1320 for "22:00"; null for anything else. */
export function minuteOf(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** The next `hour`:00 on the device's clock, tomorrow if it has passed today. */
export function nextMorning(now: Date, hour = 8): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}
