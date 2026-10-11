import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EXCERPT_LENGTH,
  LATE_LIMIT_MS,
  addDays,
  addMonths,
  clampDay,
  hasAttachments,
  inHours,
  latestReminder,
  parseReminderIdentifier,
  plainReminderLink,
  planReconcile,
  reconcileReminders,
  remindable,
  reminderAccountKey,
  reminderContent,
  reminderExcerpt,
  reminderIdentifier,
  reminderPayload,
  tomorrowAt,
  type PendingReminder,
  type Reminder,
  type ReminderContent,
  type ReminderNotifier,
  type ReminderRows,
} from './reminders.ts';
import { parseRoomLink, roomLinkMatches } from './roomLinks.ts';
import type { Session } from './auth.ts';

describe('the offered times', () => {
  test('follow the device clock, to the minute', () => {
    const now = new Date(2026, 9, 11, 23, 30, 42);
    assert.deepEqual(inHours(now, 1), new Date(2026, 9, 12, 0, 30, 0));
    assert.deepEqual(inHours(now, 3), new Date(2026, 9, 12, 2, 30, 0));
    assert.deepEqual(tomorrowAt(now, 9), new Date(2026, 9, 12, 9, 0, 0));
    // Just after midnight, "tomorrow" is still the next calendar day; across a month and a year end.
    assert.deepEqual(tomorrowAt(new Date(2026, 9, 12, 0, 5), 9), new Date(2026, 9, 13, 9, 0, 0));
    assert.deepEqual(tomorrowAt(new Date(2026, 11, 31, 12, 0), 9), new Date(2027, 0, 1, 9, 0, 0));
  });

  test('a time is remindable from one minute to one year ahead', () => {
    const now = new Date(2026, 9, 11, 12, 0, 0);
    assert.equal(remindable(new Date(now.getTime() + 59_000), now), false);
    assert.equal(remindable(new Date(now.getTime() + 60_000), now), true);
    assert.equal(remindable(new Date(2027, 9, 11, 12, 0, 0), now), true);
    assert.equal(remindable(new Date(2027, 9, 11, 12, 1, 0), now), false);
    assert.equal(remindable(new Date(NaN), now), false);
    assert.equal(remindable(new Date(2026, 9, 11, 11, 0), now), false);
  });

  test('a year from 29 February stops at the end of February', () => {
    assert.deepEqual(latestReminder(new Date(2028, 1, 29, 10, 0)), new Date(2029, 1, 28, 10, 0));
  });

  test('the day stepper moves by days and months, kept within the year', () => {
    const now = new Date(2026, 9, 11, 15, 0);
    assert.deepEqual(addDays(new Date(2026, 9, 31), 1), new Date(2026, 10, 1));
    assert.deepEqual(addMonths(new Date(2027, 0, 31), 1), new Date(2027, 1, 28));
    assert.deepEqual(addMonths(new Date(2026, 9, 11), -1), new Date(2026, 8, 11));
    assert.deepEqual(clampDay(addMonths(new Date(2026, 9, 11), -1), now), new Date(2026, 9, 11));
    assert.deepEqual(clampDay(addMonths(new Date(2027, 9, 1), 1), now), new Date(2027, 9, 11));
    assert.deepEqual(clampDay(new Date(2027, 2, 3, 18, 30), now), new Date(2027, 2, 3));
  });
});

describe('the excerpt', () => {
  const labels = { attachment: 'Attachment', message: 'Message' };

  test('plain text, whitespace collapsed, quote permalink and marks dropped', () => {
    assert.equal(reminderExcerpt('[ ](https://chat.example/channel/general?msg=abc)  **look**\n> at `this`', false, labels), 'look at this');
    assert.equal(reminderExcerpt('  hello\n\nworld ', false, labels), 'hello world');
  });

  test('cut at 140 characters, emoji counted whole', () => {
    const long = '😀'.repeat(200);
    const cut = reminderExcerpt(long, false, labels);
    assert.equal([...cut].length, EXCERPT_LENGTH);
    assert.ok(cut.endsWith('…'));
    assert.equal(reminderExcerpt('a'.repeat(EXCERPT_LENGTH), false, labels), 'a'.repeat(EXCERPT_LENGTH));
  });

  test('"Attachment" or "Message" without text', () => {
    assert.equal(reminderExcerpt(null, true, labels), 'Attachment');
    assert.equal(reminderExcerpt('   ', false, labels), 'Message');
    assert.equal(hasAttachments('[{"title":"a.png"}]'), true);
    assert.equal(hasAttachments('[]'), false);
    assert.equal(hasAttachments('oops'), false);
    assert.equal(hasAttachments(null), false);
  });
});

describe('the notification', () => {
  const key = reminderAccountKey('https://chat.example/', 'u1');
  const reminder: Reminder = {
    messageId: 'msg1',
    rid: 'room1',
    roomName: 'general',
    threadId: 'root1',
    author: 'alice',
    excerpt: 'hello',
    dueAt: 5000,
    createdAt: 10,
    scheduled: false,
  };

  test('identifiers are per (account, message) and parse back', () => {
    assert.equal(key, 'chat_example-u1');
    assert.equal(reminderAccountKey('chat.example', 'u1'), key);
    const id = reminderIdentifier(key, 'msg:with:colons');
    assert.deepEqual(parseReminderIdentifier(id), { accountKey: key, messageId: 'msg:with:colons' });
    assert.equal(parseReminderIdentifier('expo-notification-1'), null);
    assert.equal(parseReminderIdentifier('reminder:only'), null);
  });

  test('titled "Reminder", the room under it, "<author>: <excerpt>" as text, and a checked payload', () => {
    const content = reminderContent(reminder, { key, baseUrl: 'https://chat.example', userId: 'u1' }, 'rocketvibe://room/room1', 'Reminder');
    assert.equal(content.title, 'Reminder');
    assert.equal(content.subtitle, 'general');
    assert.equal(content.body, 'alice: hello');
    assert.deepEqual(reminderPayload(content.data), content.data.reminder);
    assert.equal(reminderContent({ ...reminder, author: '' }, { key, baseUrl: 'x', userId: 'u1' }, 'rocketvibe://room/room1', 'R').body, 'hello');
    assert.equal(reminderPayload({ ejson: '{}' }), null);
    assert.equal(reminderPayload({ reminder: { ...content.data.reminder, link: 'https://evil.example' } }), null);
    assert.equal(reminderPayload({ reminder: { ...content.data.reminder, dueAt: '5000' } }), null);
    assert.equal(reminderPayload(null), null);
  });

  test('a Rocket.Chat or Mattermost link routes to the room, the message and its thread, on its own server', () => {
    const link = plainReminderLink('https://chat.example', 'room1', 'msg1', 'root1');
    assert.ok(link !== null);
    const parsed = parseRoomLink(link);
    assert.deepEqual(parsed, { rid: 'room1', host: 'https://chat.example', instanceId: null, dataEpoch: null, userId: null, message: 'msg1', root: 'root1' });
    const session = { baseUrl: 'https://chat.example/', userId: 'u1', kind: 'rocketchat' } as Session;
    assert.equal(roomLinkMatches(parsed!, session), true);
    assert.equal(roomLinkMatches(parsed!, { ...session, baseUrl: 'https://other.example' }), false);
    // No thread: the message alone; an id the link cannot carry is left out.
    assert.equal(parseRoomLink(plainReminderLink('https://chat.example', 'room1', 'msg1', null)!)?.root, null);
    assert.equal(parseRoomLink(plainReminderLink('https://chat.example', 'room1', 'bad id', null)!)?.message, null);
    assert.equal(plainReminderLink('https://chat.example', 'bad room', 'msg1', null), null);
  });
});

describe('reconciliation', () => {
  const key = 'chat_example-u1';
  const now = 1_000_000_000;
  const row = (messageId: string, dueAt: number, scheduled: boolean): Reminder => ({
    messageId, rid: 'r', roomName: 'general', threadId: null, author: 'alice', excerpt: 'hi', dueAt, createdAt: 1, scheduled,
  });
  const held = (messageId: string, dueAt: number | null, account = key): PendingReminder => ({
    identifier: reminderIdentifier(account, messageId), dueAt, baseUrl: 'https://chat.example', userId: 'u1',
  });
  const plan = (rows: Reminder[], pending: PendingReminder[], gone: (p: PendingReminder) => boolean = () => false) =>
    planReconcile({ rows, pending, accountKey: key, now, accountGone: gone });
  const ids = (rows: Reminder[]) => rows.map((r) => r.messageId);

  test('a pending reminder keeps its one notification, or gets one', () => {
    const p = plan([row('a', now + 60_000, true), row('b', now + 60_000, false), row('c', now + 60_000, false), row('d', now + 60_000, true)], [
      held('a', now + 60_000),
      held('b', now + 60_000),
      held('d', now + 1),
    ]);
    assert.deepEqual(ids(p.mark), ['b']);
    // `c` never reached the system; `d`'s notification is for another time.
    assert.deepEqual(ids(p.schedule), ['c', 'd']);
    assert.deepEqual(p.cancel, [reminderIdentifier(key, 'd')]);
    assert.deepEqual([p.present, p.remove], [[], []]);
  });

  test('a due one fired by the system is removed; a missed one fires once', () => {
    const p = plan([row('fired', now - 1000, true), row('never', now - 1000, false), row('lost', now - 1000, true)], [held('lost', now - 1000)]);
    assert.deepEqual(ids(p.remove), ['fired']);
    // `lost`: expo still holds the request but its alarm is gone (force stop).
    assert.deepEqual(ids(p.present), ['never', 'lost']);
    assert.deepEqual(p.cancel, [reminderIdentifier(key, 'lost')]);
  });

  test('more than 7 days late is dropped silently', () => {
    const p = plan([row('old', now - LATE_LIMIT_MS - 1, false), row('week', now - LATE_LIMIT_MS, false)], []);
    assert.deepEqual(ids(p.remove), ['old']);
    assert.deepEqual(ids(p.present), ['week']);
  });

  test('orphans are cancelled: this account without a row, a signed-out account', () => {
    const p = plan([], [held('gone', now + 1), held('x', now + 1, 'other-u2'), held('y', now + 1, 'third-u3')], (pending) => pending.identifier.includes('other'));
    assert.deepEqual(p.cancel, [reminderIdentifier(key, 'gone'), reminderIdentifier('other-u2', 'x')]);
  });

  test('runs the plan over the ports, and a failure is retried by the next run', async () => {
    const stored = new Map<string, Reminder>([
      ['soon', row('soon', now + 60_000, false)],
      ['missed', row('missed', now - 5000, false)],
      ['fired', row('fired', now - 5000, true)],
      ['flaky', row('flaky', now + 120_000, false)],
    ]);
    const rows: ReminderRows = {
      list: async () => [...stored.values()],
      markScheduled: async (id, dueAt) => {
        const r = stored.get(id);
        if (r && r.dueAt === dueAt) stored.set(id, { ...r, scheduled: true });
      },
      remove: async (id, dueAt) => {
        if (stored.get(id)?.dueAt === dueAt) stored.delete(id);
      },
    };
    const scheduled = new Map<string, number>([[reminderIdentifier('other-u2', 'x'), now + 1]]);
    const shown: string[] = [];
    const cancelled: string[] = [];
    let failOnce = true;
    const notifier: ReminderNotifier = {
      pending: async () => [...scheduled].map(([identifier, dueAt]) => ({ identifier, dueAt, baseUrl: 'https://other.example', userId: 'u2' })),
      schedule: async (identifier, _content, dueAt) => {
        if (identifier.endsWith(':flaky') && failOnce) {
          failOnce = false;
          throw new Error('alarm refused');
        }
        scheduled.set(identifier, dueAt);
      },
      present: async (identifier) => void shown.push(identifier),
      cancel: async (identifier) => {
        cancelled.push(identifier);
        scheduled.delete(identifier);
      },
    };
    const content = (r: Reminder): ReminderContent => reminderContent(r, { key, baseUrl: 'https://chat.example', userId: 'u1' }, 'rocketvibe://room/r', 'Reminder');
    await reconcileReminders({ rows, notifier, accountKey: key, now, accountGone: async () => true, content });
    assert.deepEqual(shown, [reminderIdentifier(key, 'missed')]);
    assert.deepEqual(cancelled, [reminderIdentifier('other-u2', 'x')]);
    assert.deepEqual([...stored.keys()].sort(), ['flaky', 'soon']);
    assert.equal(stored.get('soon')?.scheduled, true);
    assert.equal(stored.get('flaky')?.scheduled, false);
    assert.deepEqual([...scheduled.keys()], [reminderIdentifier(key, 'soon')]);
    // The next run schedules the one that failed, and changes nothing else.
    await reconcileReminders({ rows, notifier, accountKey: key, now, accountGone: async () => true, content });
    assert.equal(stored.get('flaky')?.scheduled, true);
    assert.deepEqual([...scheduled.keys()].sort(), [reminderIdentifier(key, 'flaky'), reminderIdentifier(key, 'soon')]);
    assert.deepEqual(shown, [reminderIdentifier(key, 'missed')]);
  });

  test('a reminder whose notification cannot be built yet waits', async () => {
    const stored = [row('due', now - 5000, false)];
    const removed: string[] = [];
    const notifier: ReminderNotifier = {
      pending: async () => [],
      schedule: async () => {},
      present: async () => assert.fail('nothing to show'),
      cancel: async () => {},
    };
    await reconcileReminders({
      rows: { list: async () => stored, markScheduled: async () => {}, remove: async (id) => void removed.push(id) },
      notifier,
      accountKey: key,
      now,
      accountGone: () => false,
      content: () => null,
    });
    assert.deepEqual(removed, []);
  });
});
