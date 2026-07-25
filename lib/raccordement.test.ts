import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { raccorder } from './raccordement.ts';

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
const laisserTourner = async (tours = 4): Promise<void> => {
  for (let i = 0; i < tours; i++) await Promise.resolve();
};

/** Attente injectée : le test la déclenche à la main. */
function fausseAttente() {
  const enAttente: (() => void)[] = [];
  return {
    patienter: (_ms: number) =>
      new Promise<void>((resoudre) => {
        enAttente.push(resoudre);
      }),
    /** Fait expirer le délai de grâce. */
    async expirer(): Promise<void> {
      for (const r of enAttente.splice(0)) r();
      await laisserTourner();
    },
    enAttente: () => enAttente.length,
  };
}

describe('raccorder', () => {
  test('le stream gagne la course : un seul rattrapage, après lui', async () => {
    const stream = differee<void>();
    const attente = fausseAttente();
    const ordre: string[] = [];

    const fini = raccorder({
      ouvrirStream: () => {
        ordre.push('stream:demande');
        return stream.promesse;
      },
      rattraper: async () => {
        ordre.push('rattrapage');
      },
      ensuite: () => ordre.push('ensuite'),
      patienter: attente.patienter,
    });

    // Tant que le stream n'a pas répondu ET que la grâce n'a pas expiré, on ne
    // lit rien : c'est l'ordre canonique (souscriptions avant lecture REST).
    await laisserTourner();
    assert.deepEqual(ordre, ['stream:demande']);

    stream.resoudre();
    await fini;

    // UNE seule passe : le stream étant là avant la fin du rattrapage, aucune
    // fenêtre à couvrir.
    assert.deepEqual(ordre, ['stream:demande', 'rattrapage', 'ensuite']);
  });

  test('stream trop lent : le rattrapage part sans lui, puis une seconde passe couvre la fenêtre', async () => {
    const stream = differee<void>();
    const attente = fausseAttente();
    const ordre: string[] = [];

    const fini = raccorder({
      ouvrirStream: () => stream.promesse,
      rattraper: async () => {
        ordre.push('rattrapage');
      },
      ensuite: () => ordre.push('ensuite'),
      patienter: attente.patienter,
    });

    await laisserTourner();
    assert.deepEqual(ordre, [], 'rien avant la fin de la grâce');

    // La grâce expire : on lit sans attendre le stream — c'est tout l'objet du
    // correctif, l'utilisateur ne paie plus le timeout de négociation.
    await attente.expirer();
    assert.deepEqual(ordre, ['rattrapage', 'ensuite']);

    // Le stream arrive après coup : l'intervalle entre la fin de la lecture et
    // son établissement n'a été vu par personne, une seconde passe le couvre.
    stream.resoudre();
    await fini;
    assert.deepEqual(ordre, ['rattrapage', 'ensuite', 'rattrapage']);
  });

  test("l'échec du stream reste un échec — mais après que l'utilisateur a eu ses messages", async () => {
    const stream = differee<void>();
    const attente = fausseAttente();
    const ordre: string[] = [];

    const fini = raccorder({
      ouvrirStream: () => stream.promesse,
      rattraper: async () => {
        ordre.push('rattrapage');
      },
      ensuite: () => ordre.push('ensuite'),
      patienter: attente.patienter,
    });
    // Sans quoi le rejet ci-dessous compterait comme non observé.
    const attendu = fini.then(
      () => null,
      (e: unknown) => e,
    );

    await attente.expirer();
    assert.deepEqual(ordre, ['rattrapage', 'ensuite'], 'le rattrapage a eu lieu');

    stream.rejeter(new Error('pas de « connected » en 10000 ms'));
    const erreur = await attendu;

    // Relayé pour que le pilote de reconnexion garde son backoff…
    assert.ok(erreur instanceof Error);
    assert.match(erreur.message, /connected/);
    // …et surtout : pas de seconde passe, le stream n'est pas venu.
    assert.deepEqual(ordre, ['rattrapage', 'ensuite']);
  });

  test('socket déjà vivante : rattrapage immédiat, sans attendre la grâce', async () => {
    const attente = fausseAttente();
    const ordre: string[] = [];

    await raccorder({
      ouvrirStream: () => Promise.resolve(),
      rattraper: async () => {
        ordre.push('rattrapage');
      },
      ensuite: () => ordre.push('ensuite'),
      patienter: attente.patienter,
    });

    assert.deepEqual(ordre, ['rattrapage', 'ensuite']);
  });

  test('un rattrapage qui échoue fait échouer le raccordement (le pilote retentera)', async () => {
    const attente = fausseAttente();
    await assert.rejects(
      raccorder({
        ouvrirStream: () => Promise.resolve(),
        rattraper: () => Promise.reject(new Error('rooms.get: 429')),
        patienter: attente.patienter,
      }),
      /429/,
    );
  });

  test('session terminée pendant la grâce : on ne touche plus à rien', async () => {
    const stream = differee<void>();
    const attente = fausseAttente();
    let rattrapages = 0;
    let ensuiteJoue = false;

    const fini = raccorder({
      ouvrirStream: () => stream.promesse,
      rattraper: async () => {
        rattrapages++;
      },
      ensuite: () => {
        ensuiteJoue = true;
      },
      estAbandonne: () => true,
      patienter: attente.patienter,
    });
    stream.resoudre();
    await fini;

    assert.equal(rattrapages, 0);
    assert.equal(ensuiteJoue, false);
  });

  test('session terminée pendant le rattrapage : pas de seconde passe', async () => {
    const stream = differee<void>();
    const attente = fausseAttente();
    let abandonne = false;
    let rattrapages = 0;

    const fini = raccorder({
      ouvrirStream: () => stream.promesse,
      rattraper: async () => {
        rattrapages++;
        abandonne = true; // l'utilisateur se déconnecte pendant la lecture
      },
      estAbandonne: () => abandonne,
      patienter: attente.patienter,
    });

    await attente.expirer();
    stream.resoudre();
    await fini;

    assert.equal(rattrapages, 1, 'la seconde passe est annulée');
  });
});
