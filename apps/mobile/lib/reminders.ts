/**
 * "Remind me" reminders (brain/features/reminders.md): a message turned into a
 * personal reminder, kept ON THE DEVICE in the account's database and handed
 * to the system as a scheduled notification, so it fires with the app closed.
 * No server stores or sends them, whatever the server kind.
 *
 * Node-pure: the offered times, the excerpt, the notification's identifier,
 * content and route, and the startup reconciliation, all over injected ports
 * (`ReminderRows`, `ReminderNotifier`) that `ui/reminders.ts` binds to SQLite
 * and expo-notifications.
 */

import { databaseFileName } from '../db/fileName.ts';

/** One reminder of the account, as stored (`db/schema.ts#reminders`). */
export type Reminder = {
  messageId: string;
  rid: string;
  roomName: string;
  /** The thread root when the message is a reply, else null. */
  threadId: string | null;
  author: string;
  excerpt: string;
  /** When it fires, ms since the epoch. */
  dueAt: number;
  createdAt: number;
  /** Handed to the system: a scheduled notification exists (or existed and fired). */
  scheduled: boolean;
};

/** At least a minute ahead. */
export const MIN_DELAY_MS = 60_000;
/** A reminder more than this late is dropped silently instead of fired. */
export const LATE_LIMIT_MS = 7 * 86_400_000;
/** The stored excerpt's length, in characters. */
export const EXCERPT_LENGTH = 140;

/** `now` plus `hours`, to the minute ("In 1 hour", "In 3 hours"). */
export function inHours(now: Date, hours: number): Date {
  const at = new Date(now.getTime() + hours * 3_600_000);
  at.setSeconds(0, 0);
  return at;
}

/** `hour`:00 the next day on the device's clock (DST included: `setDate`, not +24 h). */
export function tomorrowAt(now: Date, hour: number): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(hour, 0, 0, 0);
  return at;
}

/** The latest time a reminder may take: a year from `now`, same clock time. */
export function latestReminder(now: Date): Date {
  const at = new Date(now);
  at.setFullYear(at.getFullYear() + 1);
  // 29 February plus a year lands on 1 March: keep the last day of February.
  if (at.getMonth() !== now.getMonth()) at.setDate(0);
  return at;
}

/** Whether `at` is a time a reminder may take: a minute ahead at least, a year at most. */
export function remindable(at: Date, now: Date): boolean {
  const delta = at.getTime() - now.getTime();
  return Number.isFinite(delta) && delta >= MIN_DELAY_MS && at.getTime() <= latestReminder(now).getTime();
}

/** Midnight of `day`, on the device's clock. */
export function startOfDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

/** `day` moved by `days` days (midnight). */
export function addDays(day: Date, days: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days);
}

/** `day` moved by `months` months (midnight), the 31st of a shorter month clamped to its last day. */
export function addMonths(day: Date, months: number): Date {
  const first = new Date(day.getFullYear(), day.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day.getDate(), last));
}

/** `day` kept between today and the last day a reminder may take. */
export function clampDay(day: Date, now: Date): Date {
  const first = startOfDay(now);
  const last = startOfDay(latestReminder(now));
  if (day.getTime() < first.getTime()) return first;
  if (day.getTime() > last.getTime()) return last;
  return startOfDay(day);
}

/**
 * The stored excerpt: the text as plain as is cheap (a Rocket.Chat quote's
 * leading permalink, emphasis and code marks dropped, whitespace collapsed),
 * cut at `EXCERPT_LENGTH` characters; "Attachment" or "Message" when there
 * is no text.
 */
export function reminderExcerpt(
  text: string | null,
  hasAttachment: boolean,
  labels: { attachment: string; message: string },
): string {
  const plain = (text ?? '')
    // A Rocket.Chat quote starts with `[ ](<permalink>)`.
    .replace(/^(\s*\[ \]\([^)]*\))+/, '')
    .replace(/```|\*\*|~~|`/g, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain === '') return hasAttachment ? labels.attachment : labels.message;
  const chars = [...plain];
  return chars.length <= EXCERPT_LENGTH ? plain : `${chars.slice(0, EXCERPT_LENGTH - 1).join('').trimEnd()}…`;
}

/** Whether a stored attachments JSON names at least one attachment. */
export function hasAttachments(attachments: string | null): boolean {
  if (attachments === null) return false;
  try {
    const parsed = JSON.parse(attachments) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The notification: identifier, content, route

/** An account's key in notification identifiers: the database file's (server, account) slug, never a ':'. */
export function reminderAccountKey(baseUrl: string, userId: string): string {
  return databaseFileName(baseUrl, userId).replace(/^rocket-vibe-/, '').replace(/\.db$/, '');
}

const PREFIX = 'reminder:';

/** The system notification's identifier: one per (account, message), so scheduling again replaces it. */
export function reminderIdentifier(accountKey: string, messageId: string): string {
  return `${PREFIX}${accountKey}:${messageId}`;
}

/** The account key and message of a reminder identifier; null for any other notification. */
export function parseReminderIdentifier(identifier: string): { accountKey: string; messageId: string } | null {
  if (!identifier.startsWith(PREFIX)) return null;
  const rest = identifier.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { accountKey: rest.slice(0, colon), messageId: rest.slice(colon + 1) };
}

/** What a reminder's notification carries in `data.reminder`. */
export type ReminderPayload = {
  account: string;
  /** The account's server, to tell a signed-out account's leftovers. */
  baseUrl: string;
  userId: string;
  rid: string;
  messageId: string;
  dueAt: number;
  /** The `rocketvibe://room/<rid>?…` link a tap follows (`lib/roomLinks.ts`). */
  link: string;
};

export type ReminderContent = {
  title: string;
  subtitle: string;
  body: string;
  data: { reminder: ReminderPayload };
};

/** The notification: titled "Reminder", the room under it, "<author>: <excerpt>" as text. */
export function reminderContent(
  reminder: Reminder,
  account: { key: string; baseUrl: string; userId: string },
  link: string,
  title: string,
): ReminderContent {
  return {
    title,
    subtitle: reminder.roomName,
    body: reminder.author === '' ? reminder.excerpt : `${reminder.author}: ${reminder.excerpt}`,
    data: {
      reminder: {
        account: account.key,
        baseUrl: account.baseUrl,
        userId: account.userId,
        rid: reminder.rid,
        messageId: reminder.messageId,
        dueAt: reminder.dueAt,
        link,
      },
    },
  };
}

/** A notification's reminder payload, checked; null for anything else. */
export function reminderPayload(data: unknown): ReminderPayload | null {
  const raw = (data as { reminder?: unknown } | null | undefined)?.reminder;
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const strings = ['account', 'baseUrl', 'userId', 'rid', 'messageId', 'link'] as const;
  if (strings.some((k) => typeof r[k] !== 'string' || r[k] === '') || typeof r.dueAt !== 'number') return null;
  if (!(r.link as string).startsWith('rocketvibe://room/')) return null;
  return {
    account: r.account as string,
    baseUrl: r.baseUrl as string,
    userId: r.userId as string,
    rid: r.rid as string,
    messageId: r.messageId as string,
    dueAt: r.dueAt as number,
    link: r.link as string,
  };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The link of a Rocket.Chat or Mattermost account's reminder: the room on
 * its server, the message, and the thread root of a reply (`parseRoomLink`'s
 * `msg` and `tmid`). A RocketVibe account takes `nativeRoomPermalink`, which
 * also names the server's instance and data epoch.
 */
export function plainReminderLink(host: string, rid: string, messageId: string, threadId: string | null): string | null {
  if (!ID.test(rid)) return null;
  const url = new URL(`rocketvibe://room/${rid}`);
  url.searchParams.set('host', host);
  if (ID.test(messageId)) url.searchParams.set('msg', messageId);
  if (threadId !== null && ID.test(threadId)) url.searchParams.set('tmid', threadId);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Reconciliation

/** The account's stored reminders, as reconciliation needs them. */
export interface ReminderRows {
  list(): Promise<Reminder[]>;
  /** Records that the system holds `messageId`'s notification for `dueAt` (a replaced time is left alone). */
  markScheduled(messageId: string, dueAt: number): Promise<void>;
  /** Removes `messageId`'s reminder if it is still the one due at `dueAt`. */
  remove(messageId: string, dueAt: number): Promise<void>;
}

/** A reminder notification the system still holds. */
export type PendingReminder = { identifier: string; dueAt: number | null; baseUrl: string | null; userId: string | null };

/** The system's notifications, as reconciliation needs them. */
export interface ReminderNotifier {
  /** Every scheduled notification whose identifier is a reminder's, any account. */
  pending(): Promise<PendingReminder[]>;
  schedule(identifier: string, content: ReminderContent, dueAt: number): Promise<void>;
  /** Shows it now. */
  present(identifier: string, content: ReminderContent): Promise<void>;
  cancel(identifier: string): Promise<void>;
}

export type ReconcilePlan = {
  /** Identifiers to cancel first: orphans, stale ones, a time that moved. */
  cancel: string[];
  /** Due later, not (or no longer correctly) held by the system. */
  schedule: Reminder[];
  /** Already held by the system for the right time, not yet marked. */
  mark: Reminder[];
  /** Missed (never handed over, or lost by the system), less than 7 days late: shown now, then removed. */
  present: Reminder[];
  /** Fired by the system, or too late: removed without a notification. */
  remove: Reminder[];
};

/**
 * What to do so that every pending reminder of the account has exactly one
 * scheduled notification and every due one fires once:
 *
 * - due later: a notification held for that time stays (marked if it was
 *   not yet); none, or one for another time, is (re)scheduled;
 * - due: one the system still holds was missed (an alarm lost to a force
 *   stop: expo keeps the request but the alarm is gone), it is cancelled and
 *   shown now; one handed over earlier and no longer held was fired by the
 *   system, it is removed; one never handed over is shown now. Shown now
 *   only if at most 7 days late, otherwise just removed;
 * - a held reminder notification of this account without a row is an
 *   orphan, cancelled; one of another account is cancelled when that
 *   account is gone (`accountGone`, signed out).
 */
export function planReconcile(input: {
  rows: readonly Reminder[];
  pending: readonly PendingReminder[];
  accountKey: string;
  now: number;
  accountGone: (pending: PendingReminder) => boolean;
}): ReconcilePlan {
  const plan: ReconcilePlan = { cancel: [], schedule: [], mark: [], present: [], remove: [] };
  const held = new Map(input.pending.map((p) => [p.identifier, p]));
  const known = new Set<string>();
  for (const row of input.rows) {
    const identifier = reminderIdentifier(input.accountKey, row.messageId);
    known.add(identifier);
    const pending = held.get(identifier);
    if (row.dueAt > input.now) {
      if (pending !== undefined && pending.dueAt === row.dueAt) {
        if (!row.scheduled) plan.mark.push(row);
      } else {
        if (pending !== undefined) plan.cancel.push(identifier);
        plan.schedule.push(row);
      }
      continue;
    }
    if (pending !== undefined) plan.cancel.push(identifier);
    else if (row.scheduled) {
      plan.remove.push(row);
      continue;
    }
    if (input.now - row.dueAt > LATE_LIMIT_MS) plan.remove.push(row);
    else plan.present.push(row);
  }
  for (const pending of input.pending) {
    if (known.has(pending.identifier)) continue;
    const parsed = parseReminderIdentifier(pending.identifier);
    if (parsed === null) continue;
    if (parsed.accountKey === input.accountKey || input.accountGone(pending)) plan.cancel.push(pending.identifier);
  }
  return plan;
}

/**
 * Runs the reconciliation over the ports. Each step is independent: a
 * failed schedule leaves its row unmarked, so the next reconciliation tries
 * again; a reminder is removed only once shown (or found fired or too late).
 * `content` answers null when the notification cannot be built yet (no link
 * for this session): the row waits.
 */
export async function reconcileReminders(input: {
  rows: ReminderRows;
  notifier: ReminderNotifier;
  accountKey: string;
  now: number;
  accountGone: (pending: PendingReminder) => boolean | Promise<boolean>;
  content: (reminder: Reminder) => ReminderContent | null;
}): Promise<ReconcilePlan> {
  const [rows, pending] = await Promise.all([input.rows.list(), input.notifier.pending()]);
  const gone = new Set<string>();
  for (const p of pending) {
    const parsed = parseReminderIdentifier(p.identifier);
    if (parsed !== null && parsed.accountKey !== input.accountKey && (await input.accountGone(p))) gone.add(p.identifier);
  }
  const plan = planReconcile({ rows, pending, accountKey: input.accountKey, now: input.now, accountGone: (p) => gone.has(p.identifier) });
  const quietly = (work: Promise<unknown>) => work.then(() => true, () => false);
  for (const identifier of plan.cancel) await quietly(input.notifier.cancel(identifier));
  for (const row of plan.mark) await quietly(input.rows.markScheduled(row.messageId, row.dueAt));
  for (const row of plan.schedule) {
    const content = input.content(row);
    if (content === null) continue;
    const identifier = reminderIdentifier(input.accountKey, row.messageId);
    if (await quietly(input.notifier.schedule(identifier, content, row.dueAt))) await quietly(input.rows.markScheduled(row.messageId, row.dueAt));
  }
  for (const row of plan.present) {
    const content = input.content(row);
    const identifier = reminderIdentifier(input.accountKey, row.messageId);
    // No content (no link to build yet): kept, the next reconciliation tries again.
    if (content !== null && (await quietly(input.notifier.present(identifier, content)))) await quietly(input.rows.remove(row.messageId, row.dueAt));
  }
  for (const row of plan.remove) await quietly(input.rows.remove(row.messageId, row.dueAt));
  return plan;
}
