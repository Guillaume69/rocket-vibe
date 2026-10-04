import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MoteurSaisie, resumerSaisie } from './typing.ts';

const evenement = (rid: string, args: unknown[]) => ({
  collection: 'stream-notify-room',
  cleEvenement: `${rid}/user-activity`,
  args,
});

/** Planificateur manuel : les minuteries se déclenchent à la demande. */
function fauxTemps() {
  const enAttente = new Map<number, () => void>();
  let n = 0;
  return {
    planifier: (fn: () => void) => {
      enAttente.set(++n, fn);
      return n;
    },
    annuler: (a: unknown) => void enAttente.delete(a as number),
    declencherTout: () => {
      for (const fn of [...enAttente.values()]) fn();
      enAttente.clear();
    },
    taille: () => enAttente.size,
  };
}

describe('MoteurSaisie', () => {
  test('taper affiche, s’arrêter efface, et je ne me vois jamais', () => {
    const temps = fauxTemps();
    const moteur = new MoteurSaisie({ rid: 'r1', moi: 'alice', ...temps });
    let notifications = 0;
    moteur.surChangement(() => notifications++);

    moteur.appliquer(evenement('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(moteur.quiTape(), ['bob']);

    moteur.appliquer(evenement('r1', ['alice', ['user-typing'], {}]));
    assert.deepEqual(moteur.quiTape(), ['bob'], 'ma propre saisie est filtrée');

    moteur.appliquer(evenement('r1', ['carol', ['user-typing'], {}]));
    assert.deepEqual(moteur.quiTape(), ['bob', 'carol']);

    moteur.appliquer(evenement('r1', ['bob', [], {}]));
    assert.deepEqual(moteur.quiTape(), ['carol']);
    assert.ok(notifications >= 3);
  });

  test('un autre salon ou une autre clé sont ignorés', () => {
    const temps = fauxTemps();
    const moteur = new MoteurSaisie({ rid: 'r1', moi: null, ...temps });
    moteur.appliquer(evenement('r2', ['bob', ['user-typing'], {}]));
    moteur.appliquer({
      collection: 'stream-notify-room',
      cleEvenement: 'r1/deleteMessage',
      args: [{ _id: 'x' }],
    });
    assert.deepEqual(moteur.quiTape(), []);
  });

  test('sans événement « stop », l’entrée EXPIRE d’elle-même et notifie', () => {
    const temps = fauxTemps();
    const moteur = new MoteurSaisie({ rid: 'r1', moi: null, ...temps });
    let notifications = 0;
    moteur.surChangement(() => notifications++);

    moteur.appliquer(evenement('r1', ['bob', ['user-typing'], {}]));
    assert.deepEqual(moteur.quiTape(), ['bob']);

    temps.declencherTout();
    assert.deepEqual(moteur.quiTape(), [], 'le « écrit… » fantôme s’éteint seul');
    assert.equal(notifications, 2);
  });

  test('re-taper repousse l’échéance (l’ancienne minuterie est annulée)', () => {
    const temps = fauxTemps();
    const moteur = new MoteurSaisie({ rid: 'r1', moi: null, ...temps });
    moteur.appliquer(evenement('r1', ['bob', ['user-typing'], {}]));
    moteur.appliquer(evenement('r1', ['bob', ['user-typing'], {}]));
    assert.equal(temps.taille(), 1, 'une seule minuterie vivante par utilisateur');
    assert.deepEqual(moteur.quiTape(), ['bob']);
  });

  test('arreter purge tout', () => {
    const temps = fauxTemps();
    const moteur = new MoteurSaisie({ rid: 'r1', moi: null, ...temps });
    moteur.appliquer(evenement('r1', ['bob', ['user-typing'], {}]));
    moteur.arreter();
    assert.deepEqual(moteur.quiTape(), []);
    assert.equal(temps.taille(), 0);
  });
});

describe('resumerSaisie', () => {
  test('projection : un nom, deux noms, puis le compte seul', () => {
    assert.equal(resumerSaisie([]), null);
    assert.deepEqual(resumerSaisie(['bob']), { forme: 'un', nom: 'bob' });
    assert.deepEqual(resumerSaisie(['bob', 'carol']), { forme: 'deux', a: 'bob', b: 'carol' });
    assert.deepEqual(resumerSaisie(['a', 'b', 'c']), { forme: 'plusieurs', n: 3 });
  });
});
