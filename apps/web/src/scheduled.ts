/**
 * Scheduled messages (Vibez): the times "Send later" offers and the
 * bounds the server accepts (docs/protocol/SCHEDULED.md).
 */
import type { ScheduledMessage } from "./protocol";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function inOneHour(now: Date): Date {
  return new Date(now.getTime() + 60 * MINUTE);
}

/** 08:00 the next day, on the device's clock. */
export function tomorrowMorning(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(8, 0, 0, 0);
  return next;
}

/** At least a minute ahead, at most 30 days: what the server takes. */
export function acceptable(at: Date, now: Date): boolean {
  const ahead = at.getTime() - now.getTime();
  return Number.isFinite(ahead) && ahead >= MINUTE && ahead <= 30 * DAY;
}

/** This room's scheduled messages, soonest first. */
export function forRoom(
  list: ScheduledMessage[],
  room: string | undefined,
): ScheduledMessage[] {
  return list
    .filter((message) => message.room_id === room)
    .sort((a, b) => a.send_at.localeCompare(b.send_at));
}

/** `<input type="datetime-local">` value for a date, local time. */
export function localInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    at.getFullYear() +
    "-" +
    pad(at.getMonth() + 1) +
    "-" +
    pad(at.getDate()) +
    "T" +
    pad(at.getHours()) +
    ":" +
    pad(at.getMinutes())
  );
}

/** "Sun 11 Oct, 14:20": the day and time a scheduled message leaves, 24-hour like the rest of the client. */
export function when(at: Date, locale: string): string {
  return at.toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
