import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hookUp } from './connectionSetup.ts';

/** Promesse dont le test décide quand — et comment — elle retombe. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Rend la main aux microtâches en attente, sans dormir. */
const letRun = async (turns = 6): Promise<void> => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/**
 * Banc : un stream et un armement qu'on fait retomber à la main, dans
 * n'importe quel ordre. Aucune horloge — c'est tout l'objet du module.
 */
function bench(options: { alreadyActive?: boolean } = {}) {
  const stream = deferred<void>();
  const arming = deferred<void>();
  const order: string[] = [];
  /** Ce que le stream couvrait au DÉMARRAGE de chaque lecture. */
  const coverage: boolean[] = [];
  let armed = options.alreadyActive ?? false;

  return {
    stream,
    arming,
    order,
    coverage,
    /** Le serveur a armé les souscriptions : à partir d'ici, le fil couvre. */
    armer() {
      armed = true;
      arming.resolve();
    },
    options: {
      streamAlreadyActive: () => armed,
      openStream: () => {
        order.push('stream:demande');
        return stream.promise;
      },
      streamArmed: () => arming.promise,
      catchUp: async () => {
        order.push('lecture');
        coverage.push(armed);
      },
      then: () => order.push('ensuite'),
    },
  };
}

describe('raccorder', () => {
  test('stream instantané : la lecture ne l’attend pas, la seconde la couvre', async () => {
    const b = bench();
    const done = hookUp(b.options);

    // La lecture part sans rien attendre — c'est ce que l'utilisateur voit.
    await letRun();
    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite']);

    b.stream.resolve();
    b.armer();
    await done;

    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite', 'lecture']);
    // La première a lu avant l'armement, la seconde après : c'est elle qui
    // garantit qu'aucun intervalle n'échappe aux deux transports.
    assert.deepEqual(b.coverage, [false, true]);
  });

  test('stream très lent : rien ne change — même ordre, mêmes garanties', async () => {
    const b = bench();
    const done = hookUp(b.options);

    await letRun();
    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite'], 'lecture déjà faite');

    // Le stream met « longtemps » — ici, un nombre arbitraire de tours de
    // boucle. Aucune constante de temps ne s'applique : rien ne se décide
    // pendant ce laps.
    await letRun(50);
    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite']);

    b.stream.resolve();
    await letRun();
    // Toujours pas de seconde lecture : les souscriptions ne sont pas armées.
    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite']);

    b.armer();
    await done;
    assert.deepEqual(b.coverage, [false, true], 'la seconde lecture couvre');
  });

  test('stream déjà actif : une seule lecture, et elle couvre', async () => {
    const b = bench({ alreadyActive: true });
    b.stream.resolve(); // socket vivante : `ouvrirStream` ne fait rien

    await hookUp(b.options);

    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite']);
    assert.deepEqual(b.coverage, [true]);
  });

  test("l'échec du stream est relayé — mais après que l'utilisateur a eu ses messages", async () => {
    const b = bench();
    const done = hookUp(b.options);
    const expected = done.then(
      () => null,
      (e: unknown) => e,
    );

    await letRun();
    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite'], 'la lecture a eu lieu');

    b.stream.reject(new Error('pas de « connected » en 10000 ms'));
    const error = await expected;

    // Relayé pour que le pilote de reconnexion garde son backoff…
    assert.ok(error instanceof Error);
    assert.match(error.message, /connected/);
    // …et sans seconde lecture : sans stream, il n'y a pas d'intervalle à
    // couvrir, et la prochaine tentative refera l'ensemble.
    assert.deepEqual(b.coverage, [false]);
  });

  test('une lecture qui échoue fait échouer le raccordement (le pilote retentera)', async () => {
    const b = bench({ alreadyActive: true });
    b.stream.resolve();
    await assert.rejects(
      hookUp({ ...b.options, catchUp: () => Promise.reject(new Error('rooms.get: 429')) }),
      /429/,
    );
  });

  test('session terminée avant la lecture : on ne touche plus à rien', async () => {
    const b = bench();
    b.stream.resolve();
    await hookUp({ ...b.options, isDiscarded: () => true });

    assert.deepEqual(b.order, ['stream:demande']);
  });

  test('session terminée pendant la lecture : pas de seconde passe', async () => {
    const b = bench();
    let discarded = false;
    const done = hookUp({
      ...b.options,
      catchUp: async () => {
        b.order.push('lecture');
        discarded = true; // l'utilisateur se déconnecte pendant la lecture
      },
      isDiscarded: () => discarded,
    });

    b.stream.resolve();
    b.armer();
    await done;

    assert.deepEqual(b.order, ['stream:demande', 'lecture', 'ensuite']);
  });
});
