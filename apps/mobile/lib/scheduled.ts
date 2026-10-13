/**
 * Scheduled messages (brain/features/scheduled-messages.md): text the server
 * sends later for its author. The neutral shape the screens read, the
 * provider port (only the Vibez driver has one, behind
 * `capabilities.scheduledMessages`), and the times the "Send later" sheet
 * offers. Node-pure: the choices are computed on the device's clock.
 */

/** One scheduled message of mine, pending or failed. */
export type ScheduledItem = {
  id: string;
  rid: string;
  text: string;
  /** The thread it replies to, or null for the room's main stream. */
  threadId: string | null;
  /** When the server sends it, ms since the epoch. */
  sendAt: number;
  /** The server could not send it: `error` says why; it waits for Remove. */
  failed: boolean;
  error: string | null;
};

export interface ProviderScheduled {
  /** Schedules `text` in `rid` (a reply when `threadId`). A retry of the same
   * text in the same place replays the same operation, never a second one. */
  schedule(rid: string, text: string, sendAt: number, threadId: string | null): Promise<ScheduledItem>;
  /** This room's scheduled messages of mine, soonest first. */
  list(rid: string): Promise<ScheduledItem[]>;
  /** Cancels a pending one or removes a failed one. */
  cancel(id: string): Promise<void>;
}

/** The server's bounds: at least a minute ahead, at most 30 days. */
export const MIN_DELAY_MS = 60_000;
export const MAX_DAYS = 30;

/** "In 1 hour", to the minute. */
export function inOneHour(now: Date): Date {
  const at = new Date(now.getTime() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

/** "Tomorrow at 08:00", on the device's clock (DST included: `setDate`, not +24 h). */
export function tomorrowMorning(now: Date): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(8, 0, 0, 0);
  return at;
}

/** The days "Pick a time" offers: today, then each of the next 30, at midnight. */
export function pickableDays(now: Date): Date[] {
  const days: Date[] = [];
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    days.push(day);
  }
  return days;
}

/** `day` (its date) at `minute` minutes after midnight, on the device's clock. */
export function atMinute(day: Date, minute: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60);
}

/** Whether the server will take `at`: a minute ahead at least, 30 days at most. */
export function schedulable(at: Date, now: Date): boolean {
  const delta = at.getTime() - now.getTime();
  return Number.isFinite(delta) && delta >= MIN_DELAY_MS && delta <= MAX_DAYS * 86_400_000;
}
