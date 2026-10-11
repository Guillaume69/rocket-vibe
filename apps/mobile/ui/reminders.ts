/**
 * "Remind me" on the device (brain/features/reminders.md): the current
 * account's reminder store, mounted by `SyncProvider` like the emoji usage,
 * bound to the system's scheduled notifications (expo-notifications, a date
 * trigger on the `reminders` channel, so a reminder fires with the app
 * closed). The rules (times, content, reconciliation) are in
 * `lib/reminders.ts`; this module is their binding.
 *
 * - Mounting reconciles: every pending reminder gets exactly one scheduled
 *   notification, a missed one fires once (or is dropped past 7 days), a
 *   fired one leaves the store, an orphan notification is cancelled. Again
 *   each time the app comes back to the front.
 * - A reminder shown while the app is in front, or tapped, leaves the store
 *   at once (`reminderShown`); otherwise the next reconciliation finds it
 *   fired.
 * - Sign-out (`forgetReminders`, from the session's `clearTraces`) removes
 *   the account's reminders, their scheduled notifications and the ones
 *   still shown.
 *
 * Leaf module: imports nothing from `sync` or `session`.
 */

import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Alert, AppState, Platform } from 'react-native';

import { openDatabase } from '../db/client.ts';
import { migrateDatabase } from '../db/migrate.ts';
import { createReminderStore, type ReminderStore } from '../db/store.ts';
import type { Session } from '../lib/auth.ts';
import {
  parseReminderIdentifier,
  plainReminderLink,
  reconcileReminders,
  reminderAccountKey,
  reminderContent,
  reminderIdentifier,
  reminderPayload,
  type PendingReminder,
  type Reminder,
  type ReminderContent,
  type ReminderNotifier,
  type ReminderPayload,
} from '../lib/reminders.ts';
import { nativeRoomPermalink, serviceUrl } from '../lib/roomLinks.ts';
import { readSession } from '../lib/sessionStore.ts';
import { ExactAlarms } from '../modules/exact-alarms/index.ts';
import { translateCurrent } from './i18n.ts';

/** The Android channel reminders post on, apart from the `default` one of messages (`lib/push.ts`). */
export const REMINDER_CHANNEL = 'reminders';

type Mounted = { store: ReminderStore; session: Session; key: string };
let current: Mounted | null = null;

/** The link a reminder's notification opens: the account, the room, the message (and its thread). */
function linkFor(session: Session, reminder: Pick<Reminder, 'rid' | 'messageId' | 'threadId'>): string | null {
  if (session.kind === 'rocketvibe') return nativeRoomPermalink(session, reminder.rid, reminder.messageId, reminder.threadId);
  const host = serviceUrl(session.baseUrl);
  return host === null ? null : plainReminderLink(host, reminder.rid, reminder.messageId, reminder.threadId);
}

function contentFor(mounted: Mounted, reminder: Reminder): ReminderContent | null {
  const link = linkFor(mounted.session, reminder);
  if (link === null) return null;
  return reminderContent(
    reminder,
    { key: mounted.key, baseUrl: mounted.session.baseUrl, userId: mounted.session.userId },
    link,
    translateCurrent('reminders.notificationTitle'),
  );
}

function request(content: ReminderContent): Notifications.NotificationContentInput {
  return {
    title: content.title,
    subtitle: content.subtitle,
    body: content.body,
    data: content.data,
    sound: 'default',
  };
}

/** expo-notifications as `lib/reminders.ts` sees it. */
const notifier: ReminderNotifier = {
  async pending() {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    const found: PendingReminder[] = [];
    for (const n of all) {
      if (parseReminderIdentifier(n.identifier) === null) continue;
      const payload = reminderPayload(n.content.data);
      found.push({ identifier: n.identifier, dueAt: payload?.dueAt ?? null, baseUrl: payload?.baseUrl ?? null, userId: payload?.userId ?? null });
    }
    return found;
  },
  async schedule(identifier, content, dueAt) {
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: request(content),
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: dueAt, channelId: REMINDER_CHANNEL },
    });
  },
  async present(identifier, content) {
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: request(content),
      trigger: Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : null,
    });
  },
  async cancel(identifier) {
    await Notifications.cancelScheduledNotificationAsync(identifier);
  },
};

let channelReady: Promise<void> | null = null;
function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  channelReady ??= Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
    name: translateCurrent('reminders.title'),
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250],
  }).then(
    () => undefined,
    (e: unknown) => {
      channelReady = null;
      throw e;
    },
  );
  return channelReady;
}

/** The channel exists and notifications may show; asks once if the system still allows asking. */
async function ensureNotifications(): Promise<boolean> {
  try {
    await ensureChannel();
    const now = await Notifications.getPermissionsAsync();
    if (now.granted) return true;
    if (!now.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** Another account's leftover: its session is no longer on the device. */
async function accountGone(pending: PendingReminder): Promise<boolean> {
  if (pending.baseUrl === null || pending.userId === null) return true;
  try {
    const session = await readSession(pending.baseUrl);
    return session === null || session.userId !== pending.userId;
  } catch {
    return false;
  }
}

// One reconciliation at a time: the mount and a return to the front can race.
let reconciling: Promise<unknown> = Promise.resolve();
function reconcile(mounted: Mounted): Promise<unknown> {
  reconciling = reconciling.then(() => {
    if (current !== mounted) return;
    return reconcileReminders({
      rows: mounted.store,
      notifier,
      accountKey: mounted.key,
      now: Date.now(),
      accountGone,
      content: (reminder) => contentFor(mounted, reminder),
    }).catch(() => {});
  });
  return reconciling;
}

/**
 * Whether the system lets reminders use exact alarms. Without them
 * expo-notifications falls back to an inexact alarm, which Android 16 held
 * with a window of 45 minutes for a reminder an hour ahead. True on iOS, before
 * Android 12, and in a dev client built before the module existed.
 */
export function exactAlarmsAllowed(): boolean {
  if (Platform.OS !== 'android' || ExactAlarms === null) return true;
  try {
    return ExactAlarms.canSchedule();
  } catch {
    return true;
  }
}

/** Opens the system's "Alarms and reminders" screen for this app. */
export function openExactAlarmSettings(): boolean {
  try {
    return ExactAlarms?.openSettings() ?? false;
  } catch {
    return false;
  }
}

const EXACT_ASKED_KEY = 'reminders-exact-alarms-asked';

/**
 * After a reminder is set: when the system would deliver it late, explains why
 * once per install and offers its settings screen. A tap outside closes it
 * with nothing opened; the Reminders list keeps offering it afterwards.
 */
export async function askExactAlarmsOnce(): Promise<void> {
  if (exactAlarmsAllowed()) return;
  try {
    if ((await SecureStore.getItemAsync(EXACT_ASKED_KEY)) !== null) return;
    await SecureStore.setItemAsync(EXACT_ASKED_KEY, '1');
  } catch {
    return;
  }
  Alert.alert(
    translateCurrent('reminders.exactTitle'),
    translateCurrent('reminders.exactBody'),
    [
      { text: translateCurrent('reminders.exactLater'), style: 'cancel' },
      { text: translateCurrent('reminders.exactOpen'), onPress: () => void openExactAlarmSettings() },
    ],
    { cancelable: true },
  );
}

/**
 * Hands every future reminder to the system again: an alarm set while exact
 * alarms were refused stays inexact until it is replaced (same identifier).
 */
function rescheduleExact(mounted: Mounted): Promise<unknown> {
  reconciling = reconciling.then(async () => {
    if (current !== mounted) return;
    const now = Date.now();
    for (const reminder of await mounted.store.list()) {
      if (reminder.dueAt <= now) continue;
      const content = contentFor(mounted, reminder);
      if (content === null) continue;
      await notifier.schedule(reminderIdentifier(mounted.key, reminder.messageId), content, reminder.dueAt).catch(() => {});
    }
  }).catch(() => {});
  return reconciling;
}

/** Gives the session's store; reconciles now and at each return to the front. The returned function takes it back. */
export function mountReminders(store: ReminderStore, session: Session): () => void {
  const mounted: Mounted = { store, session, key: reminderAccountKey(session.baseUrl, session.userId) };
  current = mounted;
  void reconcile(mounted);
  let exact = exactAlarmsAllowed();
  const state = AppState.addEventListener('change', (next) => {
    if (next !== 'active') return;
    void reconcile(mounted);
    // Back from "Alarms and reminders" with the permission granted.
    const now = exactAlarmsAllowed();
    if (now && !exact) void rescheduleExact(mounted);
    exact = now;
  });
  return () => {
    state.remove();
    if (current === mounted) current = null;
  };
}

/** The current account's key, to tell its reminders; null without a session. */
export function currentReminderAccount(): string | null {
  return current?.key ?? null;
}

/** The message's reminder still to come, for "Cancel reminder (…)"; null when none or no session. */
export async function pendingReminder(messageId: string): Promise<Reminder | null> {
  const mounted = current;
  if (mounted === null) return null;
  try {
    const rows = await mounted.store.list();
    return rows.find((r) => r.messageId === messageId && r.dueAt > Date.now()) ?? null;
  } catch {
    return null;
  }
}

/** What the "Remind me" sheet needs of a message, armed by the message sheet. */
export type ReminderDraft = Omit<Reminder, 'dueAt' | 'createdAt' | 'scheduled'> & { account: string };

let armed: ReminderDraft | null = null;
/** Armed by the message sheet before it opens `app/remind-me.tsx`. */
export function armReminder(draft: ReminderDraft): void {
  armed = draft;
}
/** The armed draft, if it still belongs to the current account. */
export function armedReminder(): ReminderDraft | null {
  return armed !== null && armed.account === current?.key ? armed : null;
}

/**
 * Stores the reminder (replacing the message's earlier one) and hands it to
 * the system. Answers whether notifications may show: when not, it is kept
 * and listed all the same. Throws only when it could not be stored.
 */
export async function setReminder(draft: ReminderDraft, dueAt: number): Promise<{ notifies: boolean }> {
  const mounted = current;
  if (mounted === null || mounted.key !== draft.account) throw new Error('reminder_account_closed');
  const reminder: Reminder = {
    messageId: draft.messageId,
    rid: draft.rid,
    roomName: draft.roomName,
    threadId: draft.threadId,
    author: draft.author,
    excerpt: draft.excerpt,
    dueAt,
    createdAt: Date.now(),
    scheduled: false,
  };
  await mounted.store.save(reminder);
  if (armed?.messageId === draft.messageId) armed = null;
  const notifies = await ensureNotifications();
  const content = contentFor(mounted, reminder);
  if (content !== null) {
    try {
      await notifier.schedule(reminderIdentifier(mounted.key, reminder.messageId), content, dueAt);
      await mounted.store.markScheduled(reminder.messageId, dueAt);
    } catch {
      // Left unmarked: the next reconciliation schedules it.
    }
  }
  return { notifies };
}

/** "Cancel reminder": the row, its scheduled notification and one still shown. */
export async function cancelReminder(messageId: string): Promise<void> {
  const mounted = current;
  if (mounted === null) return;
  await mounted.store.cancel(messageId);
  const identifier = reminderIdentifier(mounted.key, messageId);
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  await Notifications.dismissNotificationAsync(identifier).catch(() => {});
}

/** A reminder's payload in a notification's data, or null for any other notification. */
export function reminderOf(content: Notifications.NotificationContent): ReminderPayload | null {
  return reminderPayload(content.data);
}

/** A reminder was shown in front or tapped: it leaves the store now (if it is the current account's). */
export function reminderShown(payload: ReminderPayload): void {
  const mounted = current;
  if (mounted === null || mounted.key !== payload.account) return;
  mounted.store.remove(payload.messageId, payload.dueAt).catch(() => {});
}

/**
 * Sign-out of `session`: its reminders, their scheduled notifications and
 * the ones still in the tray go. Best effort, never throws: the session is
 * leaving whatever happens here.
 */
export async function forgetReminders(session: Pick<Session, 'baseUrl' | 'userId'>): Promise<void> {
  const key = reminderAccountKey(session.baseUrl, session.userId);
  const ours = (identifier: string) => parseReminderIdentifier(identifier)?.accountKey === key;
  await Promise.all([
    Notifications.getAllScheduledNotificationsAsync()
      .then((all) => Promise.all(all.filter((n) => ours(n.identifier)).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))))
      .catch(() => {}),
    Notifications.getPresentedNotificationsAsync()
      .then((shown) => Promise.all(shown.filter((n) => ours(n.request.identifier)).map((n) => Notifications.dismissNotificationAsync(n.request.identifier))))
      .catch(() => {}),
    (async () => {
      if (current?.key === key) {
        await current.store.clear();
        return;
      }
      // Usually already unmounted (the session left the screen first): the
      // connection is still cached, opening it again is free.
      const { raw, writeQueue } = openDatabase(session.baseUrl, session.userId);
      await migrateDatabase(session.baseUrl, session.userId);
      await createReminderStore(raw, writeQueue).clear();
    })().catch(() => {}),
  ]);
}
