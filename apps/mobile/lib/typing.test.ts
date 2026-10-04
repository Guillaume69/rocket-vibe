import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TypingEngine, summarizeTyping } from './typing.ts';

const event = (rid: string, args: unknown[]) => ({
  collection: 'stream-notify-room',
  eventKey: `${rid}/user-activity`,
  args,
});

/** Manual scheduler: timers fire on demand. */
function fakeTime() {
  const pending = new Map<number, () => void>();
  let n = 0;
  return {
    schedule: (fn: () => void) => {
      pending.set(++n, fn);
      return n;
    },
    cancel: (a: unknown) => void pending.delete(a as number),
    fireAll: () => {
      for (const fn of [...pending.values()]) fn();
      pending.clear();
    },
    size: () => pending.size,
  };
}

describe('TypingEngine', () => {
  test('typing shows, stopping clears, and I never see myself', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: 'alice', ...time });
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob']);

    engine.apply(event('r1', ['alice', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob'], 'my own typing is filtered out');

    engine.apply(event('r1', ['carol', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob', 'carol']);

    engine.apply(event('r1', ['bob', [], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['carol']);
    assert.ok(notifications >= 3);
  });

  test('another room or another key is ignored', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    engine.apply(event('r2', ['bob', ['user-typing'], {}]));
    engine.apply({
      collection: 'stream-notify-room',
      eventKey: 'r1/deleteMessage',
      args: [{ _id: 'x' }],
    });
    assert.deepEqual(engine.whoIsTyping(), []);
  });

  test('without a "stop" event, the entry EXPIRES on its own and notifies', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob']);

    time.fireAll();
    assert.deepEqual(engine.whoIsTyping(), [], 'the ghost "typing..." goes out on its own');
    assert.equal(notifications, 2);
  });

  test('typing again pushes back the deadline (the old timer is cancelled)', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    assert.equal(time.size(), 1, 'a single live timer per user');
    assert.deepEqual(engine.whoIsTyping(), ['bob']);
  });

  test('stop clears everything', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    engine.stop();
    assert.deepEqual(engine.whoIsTyping(), []);
    assert.equal(time.size(), 0);
  });
});

describe('summarizeTyping', () => {
  test('projection: one name, two names, then just the count', () => {
    assert.equal(summarizeTyping([]), null);
    assert.deepEqual(summarizeTyping(['bob']), { form: 'one', name: 'bob' });
    assert.deepEqual(summarizeTyping(['bob', 'carol']), { form: 'two', a: 'bob', b: 'carol' });
    assert.deepEqual(summarizeTyping(['a', 'b', 'c']), { form: 'many', n: 3 });
  });
});
