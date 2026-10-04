import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hookUp } from './connectionSetup.ts';

/** Promesse dont le test décide quand — et comment — elle retombe. */
function differee<T>() {
  let resoudre!: (v: T) => void;
  let rejeter!: (e: unknown) => void;
  const promesse = new Promise<T>((res, rej) => {
    resoudre = res;
    rejeter = rej;
  });
  return { promesse, resoudre, rejeter };
}

/** Rend la main aux microtâches en attente, sans dormir. */
const laisserTourner = async (tours = 6): Promise<void> => {
  for (let i = 0; i < tours; i++) await Promise.resolve();
};

/**
 * Banc : un stream et un armement qu'on fait retomber à la main, dans
 * n'importe quel ordre. Aucune horloge — c'est tout l'objet du module.
 */
function banc(options: { alreadyActive?: boolean } = {}) {
  const stream = differee<void>();
  const armement = differee<void>();
  const ordre: string[] = [];
  /** Ce que le stream couvrait au DÉMARRAGE de chaque lecture. */
  const couverture: boolean[] = [];
  let arme = options.alreadyActive ?? false;

  return {
    stream,
    armement,
    ordre,
    couverture,
    /** Le serveur a armé les souscriptions : à partir d'ici, le fil couvre. */
    armer() {
      arme = true;
      armement.resoudre();
    },
    options: {
      streamAlreadyActive: () => arme,
      openStream: () => {
        ordre.push('stream:demande');
        return stream.promesse;
      },
      streamArmed: () => armement.promesse,
      catchUp: async () => {
        ordre.push('lecture');
        couverture.push(arme);
      },
      then: () => ordre.push('ensuite'),
    },
  };
}

describe('raccorder', () => {
  test('stream instantané : la lecture ne l’attend pas, la seconde la couvre', async () => {
    const b = banc();
    const fini = hookUp(b.options);

    // La lecture part sans rien attendre — c'est ce que l'utilisateur voit.
    await laisserTourner();
    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite']);

    b.stream.resoudre();
    b.armer();
    await fini;

    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite', 'lecture']);
    // La première a lu avant l'armement, la seconde après : c'est elle qui
    // garantit qu'aucun intervalle n'échappe aux deux transports.
    assert.deepEqual(b.couverture, [false, true]);
  });

  test('stream très lent : rien ne change — même ordre, mêmes garanties', async () => {
    const b = banc();
    const fini = hookUp(b.options);

    await laisserTourner();
    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite'], 'lecture déjà faite');

    // Le stream met « longtemps » — ici, un nombre arbitraire de tours de
    // boucle. Aucune constante de temps ne s'applique : rien ne se décide
    // pendant ce laps.
    await laisserTourner(50);
    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite']);

    b.stream.resoudre();
    await laisserTourner();
    // Toujours pas de seconde lecture : les souscriptions ne sont pas armées.
    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite']);

    b.armer();
    await fini;
    assert.deepEqual(b.couverture, [false, true], 'la seconde lecture couvre');
  });

  test('stream déjà actif : une seule lecture, et elle couvre', async () => {
    const b = banc({ alreadyActive: true });
    b.stream.resoudre(); // socket vivante : `ouvrirStream` ne fait rien

    await hookUp(b.options);

    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite']);
    assert.deepEqual(b.couverture, [true]);
  });

  test("l'échec du stream est relayé — mais après que l'utilisateur a eu ses messages", async () => {
    const b = banc();
    const fini = hookUp(b.options);
    const attendu = fini.then(
      () => null,
      (e: unknown) => e,
    );

    await laisserTourner();
    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite'], 'la lecture a eu lieu');

    b.stream.rejeter(new Error('pas de « connected » en 10000 ms'));
    const erreur = await attendu;

    // Relayé pour que le pilote de reconnexion garde son backoff…
    assert.ok(erreur instanceof Error);
    assert.match(erreur.message, /connected/);
    // …et sans seconde lecture : sans stream, il n'y a pas d'intervalle à
    // couvrir, et la prochaine tentative refera l'ensemble.
    assert.deepEqual(b.couverture, [false]);
  });

  test('une lecture qui échoue fait échouer le raccordement (le pilote retentera)', async () => {
    const b = banc({ alreadyActive: true });
    b.stream.resoudre();
    await assert.rejects(
      hookUp({ ...b.options, catchUp: () => Promise.reject(new Error('rooms.get: 429')) }),
      /429/,
    );
  });

  test('session terminée avant la lecture : on ne touche plus à rien', async () => {
    const b = banc();
    b.stream.resoudre();
    await hookUp({ ...b.options, isDiscarded: () => true });

    assert.deepEqual(b.ordre, ['stream:demande']);
  });

  test('session terminée pendant la lecture : pas de seconde passe', async () => {
    const b = banc();
    let abandonne = false;
    const fini = hookUp({
      ...b.options,
      catchUp: async () => {
        b.ordre.push('lecture');
        abandonne = true; // l'utilisateur se déconnecte pendant la lecture
      },
      isDiscarded: () => abandonne,
    });

    b.stream.resoudre();
    b.armer();
    await fini;

    assert.deepEqual(b.ordre, ['stream:demande', 'lecture', 'ensuite']);
  });
});
