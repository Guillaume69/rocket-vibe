/**
 * Do not disturb on a RocketVibe server (brain/features/do-not-disturb.md),
 * the rule the server applies to push (`account_quiet`, migration 0055):
 * muted before `muted_until`, or inside the daily `quiet_hours` window read in
 * its own time zone (a window with start > end crosses midnight). The port of
 * the web client's `apps/web/src/quiet.ts`; the server holds push and call
 * rings back by itself, the app uses this to show the state.
 *
 * Node-pure. Hermes (RN 0.86, Intl on) reads a time zone through
 * `Intl.DateTimeFormat`; an engine that refuses the zone falls back to the
 * device's clock, the zone the window was saved in.
 */
import type { QuietHours, UserPreferences } from '../providers/vibez/protocol.generated.ts';

/** The window offered first: 22:00 to 08:00. */
export const DEFAULT_QUIET: { start_minute: number; end_minute: number } = { start_minute: 22 * 60, end_minute: 8 * 60 };

/** Minutes since midnight at `now` in `zone`; the device's when the zone is unknown. */
export function minuteIn(zone: string, now: Date): number {
  try {
    // `format` and a parse rather than `formatToParts`: the fewest Intl
    // features asked of the engine. "23:30" in en-GB, h23.
    const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    const match = /(\d{1,2})\D+(\d{2})/.exec(text);
    if (match) return (Number(match[1]) % 24) * 60 + Number(match[2]);
  } catch {
    // An unknown zone: the device's clock below.
  }
  return now.getHours() * 60 + now.getMinutes();
}

export function covers(window: QuietHours, minute: number): boolean {
  return window.start_minute < window.end_minute
    ? minute >= window.start_minute && minute < window.end_minute
    : minute >= window.start_minute || minute < window.end_minute;
}

/** The mute's end while it is ahead of `now`, else null. */
export function mutedUntil(preferences: Pick<UserPreferences, 'muted_until'> | null | undefined, now: Date): Date | null {
  const until = preferences?.muted_until ? Date.parse(preferences.muted_until) : NaN;
  return until > now.getTime() ? new Date(until) : null;
}

export function quietNow(preferences: Pick<UserPreferences, 'muted_until' | 'quiet_hours'> | null | undefined, now: Date): boolean {
  if (!preferences) return false;
  if (mutedUntil(preferences, now) !== null) return true;
  const window = preferences.quiet_hours;
  return !!window && covers(window, minuteIn(window.time_zone, now));
}

/** "22:00" for 1320. */
export function clock(minute: number): string {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

/** 1320 for "22:00" (or "22h00", "22.00"); null for anything else. */
export function minuteOf(text: string): number | null {
  const match = /^(\d{1,2})[:hH.](\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

/** The next `hour`:00 on the device's clock, tomorrow if it has passed today. */
export function nextMorning(now: Date, hour = 8): Date {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/** A window the server accepts: both ends below 1440, distinct. */
export function validWindow(start: number | null, end: number | null): boolean {
  return start !== null && end !== null && start !== end && start >= 0 && end >= 0 && start < 1440 && end < 1440;
}
