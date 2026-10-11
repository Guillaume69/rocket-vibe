/**
 * Reminders ("Remind me"): personal, kept in this browser only
 * (brain/features/reminders.md). The times offered, the bounds, the excerpt
 * kept with a reminder and which ones are due.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Reminder {
  account: string;
  message: string;
  room: string;
  room_name: string;
  /** The thread root when the message is a reply. */
  root?: string;
  author: string;
  excerpt: string;
  /** ISO instant. */
  due: string;
  created: string;
}

export const reminderKey = (account: string, message: string): string =>
  account + ":" + message;

export function inHours(now: Date, hours: number): Date {
  return new Date(now.getTime() + hours * HOUR);
}

/** 09:00 the next day, on the device's clock. */
export function tomorrowNine(now: Date): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next;
}

/** At least a minute ahead, at most a year. */
export function acceptable(at: Date, now: Date): boolean {
  const ahead = at.getTime() - now.getTime();
  return Number.isFinite(ahead) && ahead >= MINUTE && ahead <= 365 * DAY;
}

/** The first 140 characters of the text, else what the message holds. */
export function excerpt(
  text: string,
  hasFiles: boolean,
  labels: { attachment: string; message: string },
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat) return [...flat].slice(0, 140).join("");
  return hasFiles ? labels.attachment : labels.message;
}

/** Due ones to fire, and those more than 7 days late to drop silently. */
export function due(
  list: Reminder[],
  now: Date,
): { fire: Reminder[]; drop: Reminder[] } {
  const fire: Reminder[] = [],
    drop: Reminder[] = [];
  for (const reminder of list) {
    const at = Date.parse(reminder.due);
    if (!(at <= now.getTime())) continue;
    (now.getTime() - at > 7 * DAY ? drop : fire).push(reminder);
  }
  return { fire, drop };
}

/** This account's pending reminders, soonest first. */
export function pending(list: Reminder[], account: string): Reminder[] {
  return list
    .filter((reminder) => reminder.account === account)
    .sort((a, b) => a.due.localeCompare(b.due));
}
