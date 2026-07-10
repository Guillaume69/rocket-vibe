import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MoteurEnvoi, idDepuisOctets, type DepotEnvoi, type LigneSortie } from './envoi.ts';
import type { MessageLocal } from './normaliser.ts';
import { ClientRest } from './rest.ts';

function fauxDepot() {
  const sortie = new Map<string, LigneSortie>();
  const messages: MessageLocal[] = [];
  const depot: DepotEnvoi = {
    insererSortie: async (id, rid, texte, filId) =>
      void sortie.set(id, { id, rid, texte, filId, statut: 'en-attente', tentatives: 0 }),
    listerAEnvoyer: async () => [...sortie.values()],
    marquerEchec: async (id, erreur) => {
      const l = sortie.get(id);
      if (l) {
        l.statut = 'echec';
        l.tentatives++;
        void erreur;
      }
    },
    supprimerSortie: async (id) => void sortie.delete(id),
    upsertMessage: async (m) => void messages.push(m),
    supprimerMessageOptimiste: async (id) => {
      const i = messages.findIndex((m) => m.id === id && m.misAJourLe === 0);
      if (i !== -1) messages.splice(i, 1);
    },
  };
  return { depot, sortie, messages };
}

/** Client REST réel, fetch simulé : on éprouve la vraie sérialisation. */
function fauxClient(
  repondre: (corps: Record<string, unknown>) => Promise<Response>,
  repondreGet?: (url: string) => Promise<Response>,
) {
  const requetes: Record<string, unknown>[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      if (init?.body === undefined) {
        // GET (chat.getMessage) : introuvable par défaut.
        return repondreGet
          ? repondreGet(String(url))
          : ok({ success: false, error: 'not-found' });
      }
      const corps = JSON.parse(String(init.body)) as Record<string, unknown>;
      requetes.push(corps);
      return repondre(corps);
    },
    dormir: async () => {},
  });
  return { client, requetes };
}

const ok = (json: unknown) =>
  new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });

function moteurDeTest(options: {
  repondre: (corps: Record<string, unknown>) => Promise<Response>;
  repondreGet?: (url: string) => Promise<Response>;
}) {
  const { depot, sortie, messages } = fauxDepot();
  const { client, requetes } = fauxClient(options.repondre, options.repondreGet);
  const ingeres: Record<string, unknown>[] = [];
  let n = 0;
  const moteur = new MoteurEnvoi({
    depot,
    client,
    moi: { id: 'u1', username: 'alice' },
    genererId: () => `id-genere-${++n}`.padEnd(24, '0'),
    ingerer: async (doc) => void ingeres.push(doc),
    maintenant: () => 1000,
  });
  return { moteur, sortie, messages, requetes, ingeres };
}

describe('idDepuisOctets', () => {
  test('24 hexadécimaux, déterministes depuis les octets', () => {
    const id = idDepuisOctets(new Uint8Array([0, 1, 255, 16, 32, 64, 128, 200, 9, 10, 11, 12]));
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.equal(id, '0001ff10204080c8090a0b0c');
  });
});

describe('MoteurEnvoi', () => {
  test('envoyer : affichage optimiste AVANT le réseau, puis envoi et réconciliation', async () => {
    const { moteur, sortie, messages, requetes, ingeres } = moteurDeTest({
      repondre: async (corps) => {
        const m = (corps.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });

    const id = await moteur.envoyer('r1', 'bonjour');

    assert.equal(messages.length, 1, 'le message optimiste est écrit en base');
    assert.equal(messages[0].id, id);
    assert.equal(messages[0].misAJourLe, 0, 'toujours écrasable par le serveur');

    assert.equal(requetes.length, 1);
    const envoye = (requetes[0].message ?? {}) as Record<string, unknown>;
    assert.equal(envoye._id, id, 'le serveur reçoit le MÊME _id : sa clé de déduplication');
    assert.equal(envoye.msg, 'bonjour');

    assert.equal(sortie.size, 0, 'la file est vidée au succès');
    assert.equal(ingeres.length, 1, 'le document du serveur repasse par la synchro');
  });

  test('réponse de fil : `tmid` part au serveur, `filId` persiste pour le rejeu (8.3)', async () => {
    const { moteur, sortie, requetes } = moteurDeTest({
      repondre: async (corps) => {
        const m = (corps.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: { ...m, ts: { $date: 2000 }, u: { _id: 'u1' } } });
      },
    });
    await moteur.envoyer('r1', 'réponse dans le fil', 'racine-du-fil-000000000');
    const envoye = (requetes[0].message ?? {}) as Record<string, unknown>;
    assert.equal(envoye.tmid, 'racine-du-fil-000000000');
    assert.equal(sortie.size, 0);

    // Un message ORDINAIRE n'a pas de clé `tmid` du tout — pas un null.
    await moteur.envoyer('r1', 'hors fil');
    const ordinaire = (requetes[1].message ?? {}) as Record<string, unknown>;
    assert.ok(!('tmid' in ordinaire));
  });

  test('réseau injoignable : la ligne RESTE en-attente, prête pour le rejeu', async () => {
    const { moteur, sortie } = moteurDeTest({
      repondre: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await moteur.envoyer('r1', 'hors ligne');
    const lignes = [...sortie.values()];
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].statut, 'en-attente', "pas un échec : le réseau reviendra");
  });

  test('refus du serveur : échec actionnable, PAS de suppression', async () => {
    const { moteur, sortie } = moteurDeTest({
      repondre: async () => ok({ success: false, error: 'error-not-allowed' }),
    });
    await moteur.envoyer('r1', 'refusé');
    const lignes = [...sortie.values()];
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0].statut, 'echec');
    assert.equal(lignes[0].tentatives, 1);
  });

  test('un rejeu refusé mais DÉJÀ LIVRÉ est réconcilié, pas marqué échec', async () => {
    // Rocket.Chat 8.5 répond 400 sur un `_id` déjà accepté (vérifié : « Cannot
    // read properties of undefined (reading 'starred') ») : aucun doublon,
    // mais la réponse ne vaut pas refus — on demande à chat.getMessage.
    const { moteur, sortie } = moteurDeTest({
      repondre: async () =>
        ok({ success: false, error: "Cannot read properties of undefined (reading 'starred')" }),
      repondreGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id } });
      },
    });
    await moteur.envoyer('r1', 'rejoué après crash');
    assert.equal(sortie.size, 0, 'livré = réconcilié');
  });

  test('le document du « déjà livré » est INGÉRÉ : la version serveur remplace l’optimiste', async () => {
    const { moteur, ingeres } = moteurDeTest({
      repondre: async () => ok({ success: false, error: 'starred…' }),
      repondreGet: async (url) => {
        const id = new URL(url).searchParams.get('msgId');
        return ok({ success: true, message: { _id: id, msg: 'version serveur' } });
      },
    });
    await moteur.envoyer('r1', 'x');
    assert.equal(ingeres.length, 1);
    assert.equal(ingeres[0].msg, 'version serveur');
  });

  test('abandonner efface la ligne de sortie ET le message optimiste', async () => {
    const { moteur, sortie, messages } = moteurDeTest({
      repondre: async () => ok({ success: false, error: 'refus définitif' }),
    });
    const id = await moteur.envoyer('r1', 'condamné');
    assert.equal([...sortie.values()][0]?.statut, 'echec');

    await moteur.abandonner(id);
    assert.equal(sortie.size, 0);
    assert.equal(messages.length, 0, "l'optimiste ne doit pas hanter le salon");
  });

  test('un envoi pendant le flush est repris par une repasse, pas oublié', async () => {
    // Course réelle : envoyer('b') pendant que le POST de 'a' est en vol.
    // Sans repasse, 'b' resterait « ⏳ » jusqu'au prochain déclencheur.
    const vanne: { ouvrir: (() => void) | null } = { ouvrir: null };
    let premier = true;
    const { moteur, requetes, sortie } = moteurDeTest({
      repondre: (corps) => {
        const m = (corps.message ?? {}) as Record<string, unknown>;
        if (!premier) return Promise.resolve(ok({ success: true, message: m }));
        premier = false;
        return new Promise((resoudre) => {
          vanne.ouvrir = () => resoudre(ok({ success: true, message: m }));
        });
      },
    });

    const p1 = moteur.envoyer('r1', 'a');
    await new Promise((r) => setImmediate(r)); // 'a' atteint le réseau
    const p2 = moteur.envoyer('r1', 'b'); // pendant le vol de 'a'
    await new Promise((r) => setImmediate(r));
    vanne.ouvrir?.();
    await Promise.all([p1, p2]);

    assert.equal(requetes.length, 2, "la repasse a envoyé 'b'");
    assert.equal(sortie.size, 0);
  });

  test('le rejeu retente les échecs comme les attentes', async () => {
    let refuser = true;
    const { moteur, sortie } = moteurDeTest({
      repondre: async (corps) => {
        if (refuser) return ok({ success: false, error: 'temporaire' });
        const m = (corps.message ?? {}) as Record<string, unknown>;
        return ok({ success: true, message: m });
      },
    });
    await moteur.envoyer('r1', 'a');
    assert.equal([...sortie.values()][0]?.statut, 'echec');

    refuser = false;
    await moteur.traiter();
    assert.equal(sortie.size, 0, 'le rejeu a vidé la file');
  });

  test('deux traiter() concurrents ne doublent pas les requêtes', async () => {
    // Propriété d'objet et non variable locale : TypeScript ne voit pas
    // l'affectation faite dans l'exécuteur de la promesse.
    const vanne: { ouvrir: (() => void) | null } = { ouvrir: null };
    const { moteur, requetes } = moteurDeTest({
      repondre: (corps) =>
        new Promise((resoudre) => {
          vanne.ouvrir = () => {
            const m = (corps.message ?? {}) as Record<string, unknown>;
            resoudre(ok({ success: true, message: m }));
          };
        }),
    });
    const p1 = moteur.envoyer('r1', 'x');
    // Laisser la première passe atteindre le réseau (et bloquer sur la vanne).
    await new Promise((r) => setImmediate(r));
    // Pendant que l'envoi est en vol, un second passage ne doit rien faire —
    // et surtout ne pas bloquer : on ne l'attend qu'après avoir ouvert la vanne.
    const p2 = moteur.traiter();
    vanne.ouvrir?.();
    await Promise.all([p1, p2]);
    assert.equal(requetes.length, 1);
  });
});
