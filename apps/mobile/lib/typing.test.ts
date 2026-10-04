import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TypingEngine, summarizeTyping } from './typing.ts';

const event = (rid: string, args: unknown[]) => ({
  collection: 'stream-notify-room',
  eventKey: `${rid}/user-activity`,
  args,
});

/** Planificateur manuel : les minuteries se déclenchent à la demande. */
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

describe('MoteurSaisie', () => {
  test('taper affiche, s’arrêter efface, et je ne me vois jamais', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: 'alice', ...time });
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob']);

    engine.apply(event('r1', ['alice', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob'], 'ma propre saisie est filtrée');

    engine.apply(event('r1', ['carol', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob', 'carol']);

    engine.apply(event('r1', ['bob', [], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['carol']);
    assert.ok(notifications >= 3);
  });

  test('un autre salon ou une autre clé sont ignorés', () => {
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

  test('sans événement « stop », l’entrée EXPIRE d’elle-même et notifie', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    let notifications = 0;
    engine.onChange(() => notifications++);

    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(engine.whoIsTyping(), ['bob']);

    time.fireAll();
    assert.deepEqual(engine.whoIsTyping(), [], 'le « écrit… » fantôme s’éteint seul');
    assert.equal(notifications, 2);
  });

  test('re-taper repousse l’échéance (l’ancienne minuterie est annulée)', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    assert.equal(time.size(), 1, 'une seule minuterie vivante par utilisateur');
    assert.deepEqual(engine.whoIsTyping(), ['bob']);
  });

  test('arreter purge tout', () => {
    const time = fakeTime();
    const engine = new TypingEngine({ rid: 'r1', me: null, ...time });
    engine.apply(event('r1', ['bob', ['user-typing'], {}]));
    engine.stop();
    assert.deepEqual(engine.whoIsTyping(), []);
    assert.equal(time.size(), 0);
  });
});

describe('resumerSaisie', () => {
  test('projection : un nom, deux noms, puis le compte seul', () => {
    assert.equal(summarizeTyping([]), null);
    assert.deepEqual(summarizeTyping(['bob']), { form: 'one', name: 'bob' });
    assert.deepEqual(summarizeTyping(['bob', 'carol']), { form: 'two', a: 'bob', b: 'carol' });
    assert.deepEqual(summarizeTyping(['a', 'b', 'c']), { form: 'many', n: 3 });
  });
});
