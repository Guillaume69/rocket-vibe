import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TypingEngine, summarizeTyping } from './typing.ts';

const evenement = (rid: string, args: unknown[]) => ({
  collection: 'stream-notify-room',
  eventKey: `${rid}/user-activity`,
  args,
});

/** Planificateur manuel : les minuteries se déclenchent à la demande. */
function fauxTemps() {
  const enAttente = new Map<number, () => void>();
  let n = 0;
  return {
    schedule: (fn: () => void) => {
      enAttente.set(++n, fn);
      return n;
    },
    cancel: (a: unknown) => void enAttente.delete(a as number),
    declencherTout: () => {
      for (const fn of [...enAttente.values()]) fn();
      enAttente.clear();
    },
    size: () => enAttente.size,
  };
}

describe('MoteurSaisie', () => {
  test('taper affiche, s’arrêter efface, et je ne me vois jamais', () => {
    const temps = fauxTemps();
    const moteur = new TypingEngine({ rid: 'r1', me: 'alice', ...temps });
    let notifications = 0;
    moteur.onChange(() => notifications++);

    moteur.apply(evenement('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(moteur.whoIsTyping(), ['bob']);

    moteur.apply(evenement('r1', ['alice', ['user-typing'], {}]));
    assert.deepEqual(moteur.whoIsTyping(), ['bob'], 'ma propre saisie est filtrée');

    moteur.apply(evenement('r1', ['carol', ['user-typing'], {}]));
    assert.deepEqual(moteur.whoIsTyping(), ['bob', 'carol']);

    moteur.apply(evenement('r1', ['bob', [], {}]));
    assert.deepEqual(moteur.whoIsTyping(), ['carol']);
    assert.ok(notifications >= 3);
  });

  test('un autre salon ou une autre clé sont ignorés', () => {
    const temps = fauxTemps();
    const moteur = new TypingEngine({ rid: 'r1', me: null, ...temps });
    moteur.apply(evenement('r2', ['bob', ['user-typing'], {}]));
    moteur.apply({
      collection: 'stream-notify-room',
      eventKey: 'r1/deleteMessage',
      args: [{ _id: 'x' }],
    });
    assert.deepEqual(moteur.whoIsTyping(), []);
  });

  test('sans événement « stop », l’entrée EXPIRE d’elle-même et notifie', () => {
    const temps = fauxTemps();
    const moteur = new TypingEngine({ rid: 'r1', me: null, ...temps });
    let notifications = 0;
    moteur.onChange(() => notifications++);

    moteur.apply(evenement('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(moteur.whoIsTyping(), ['bob']);

    temps.declencherTout();
    assert.deepEqual(moteur.whoIsTyping(), [], 'le « écrit… » fantôme s’éteint seul');
    assert.equal(notifications, 2);
  });

  test('re-taper repousse l’échéance (l’ancienne minuterie est annulée)', () => {
    const temps = fauxTemps();
    const moteur = new TypingEngine({ rid: 'r1', me: null, ...temps });
    moteur.apply(evenement('r1', ['bob', ['user-typing'], {}]));
    moteur.apply(evenement('r1', ['bob', ['user-typing'], {}]));
    assert.equal(temps.size(), 1, 'une seule minuterie vivante par utilisateur');
    assert.deepEqual(moteur.whoIsTyping(), ['bob']);
  });

  test('arreter purge tout', () => {
    const temps = fauxTemps();
    const moteur = new TypingEngine({ rid: 'r1', me: null, ...temps });
    moteur.apply(evenement('r1', ['bob', ['user-typing'], {}]));
    moteur.stop();
    assert.deepEqual(moteur.whoIsTyping(), []);
    assert.equal(temps.size(), 0);
  });
});

describe('resumerSaisie', () => {
  test('projection : un nom, deux noms, puis le compte seul', () => {
    assert.equal(summarizeTyping([]), null);
    assert.deepEqual(summarizeTyping(['bob']), { forme: 'un', name: 'bob' });
    assert.deepEqual(summarizeTyping(['bob', 'carol']), { forme: 'deux', a: 'bob', b: 'carol' });
    assert.deepEqual(summarizeTyping(['a', 'b', 'c']), { forme: 'plusieurs', n: 3 });
  });
});
