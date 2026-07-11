import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { rattraperGlobal, rattraperSalon, reconcilierSalons } from './rattrapage.ts';
import { ClientRest } from './rest.ts';
import { MoteurSynchro, type Depot } from './sync.ts';

function fauxDepotComplet() {
  const curseurs = new Map<string, number>();
  const supprimesSalons: string[] = [];
  const supprimesAbonnements: string[] = [];
  const supprimesMessages: string[] = [];
  const salons: string[] = [];
  const abonnements: string[] = [];
  const messages: string[] = [];
  const supprimesParSubId: string[] = [];
  const purges: string[][] = [];
  const depot: Depot = {
    upsertMessage: async (m) => void messages.push(m.id),
    upsertSalon: async (s) => void salons.push(s.rid),
    upsertAbonnement: async (a) => void abonnements.push(a.rid),
    supprimerMessage: async (id) => void supprimesMessages.push(id),
    supprimerSalon: async (rid) => void supprimesSalons.push(rid),
    supprimerAbonnement: async (rid) => void supprimesAbonnements.push(rid),
    supprimerParSubId: async (subId) => void supprimesParSubId.push(subId),
    purgerSalonsAbsents: async (rids) => void purges.push(rids),
    lireCurseur: async (portee, flux) => curseurs.get(`${portee}|${flux}`) ?? null,
    ecrireCurseur: async (portee, flux, valeur) => {
      const cle = `${portee}|${flux}`;
      const courant = curseurs.get(cle);
      if (courant === undefined || valeur > courant) curseurs.set(cle, valeur);
    },
    transaction: async (fn) => fn(depot),
  };
  return {
    depot,
    curseurs,
    salons,
    abonnements,
    messages,
    supprimesSalons,
    supprimesAbonnements,
    supprimesMessages,
    supprimesParSubId,
    purges,
  };
}

/** Client réel, fetch simulé : on vérifie les VRAIS paramètres d'URL. */
function fauxClient(reponses: Record<string, unknown>) {
  const urls: string[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      const u = String(url);
      urls.push(u);
      const chemin = new URL(u).pathname.split('/api/v1/')[1];
      return new Response(JSON.stringify(reponses[chemin] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
  return { client, urls };
}

describe('rattraperGlobal', () => {
  test('sans curseur : chargement complet (pas d’updatedSince), puis curseurs posés', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot);
    const { client, urls } = fauxClient({
      'rooms.get': {
        update: [{ _id: 'r1', t: 'c', _updatedAt: { $date: 500 } }],
        remove: [],
      },
      'subscriptions.get': {
        update: [{ rid: 'r1', _updatedAt: { $date: 700 } }],
        remove: [],
      },
    });

    await rattraperGlobal(client, moteur);

    assert.ok(!urls.some((u) => u.includes('updatedSince')), 'premier passage = complet');
    assert.deepEqual(d.salons, ['r1']);
    assert.equal(d.curseurs.get('*|salons'), 500, 'curseur = plus grand _updatedAt INGÉRÉ');
    assert.equal(d.curseurs.get('*|abonnements'), 700);
  });

  test('avec curseur : updatedSince est envoyé, les remove font le ménage', async () => {
    const d = fauxDepotComplet();
    d.curseurs.set('*|salons', 1000);
    d.curseurs.set('*|abonnements', 1000);
    const moteur = new MoteurSynchro(d.depot);
    const { client, urls } = fauxClient({
      // Projections réelles du serveur 8.5 : `remove[]` de rooms.get porte le
      // `_id` du SALON supprimé ; celui de subscriptions.get porte le `_id`
      // de l'ABONNEMENT (jamais le rid).
      'rooms.get': { update: [], remove: [{ _id: 'r-detruit' }] },
      'subscriptions.get': { update: [], remove: [{ _id: 'sub-quitte' }] },
    });

    await rattraperGlobal(client, moteur);

    const urlSalons = urls.find((u) => u.includes('rooms.get'));
    assert.ok(
      urlSalons?.includes(`updatedSince=${encodeURIComponent(new Date(1000).toISOString())}`),
      'le delta part du curseur',
    );
    assert.deepEqual(d.supprimesSalons, ['r-detruit']);
    assert.deepEqual(d.supprimesParSubId, ['sub-quitte']);
    assert.equal(d.curseurs.get('*|salons'), 1000, 'rien d’ingéré : le curseur ne bouge pas');
  });
});

describe('rattraperSalon', () => {
  test('sans curseur : ne fait RIEN — syncMessages sans borne re-téléchargerait tout', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot);
    const { client, urls } = fauxClient({});
    await rattraperSalon(client, moteur, 'r1');
    assert.equal(urls.length, 0);
  });

  test('avec curseur : syncMessages ingère, supprime, avance le curseur', async () => {
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 2000);
    const moteur = new MoteurSynchro(d.depot);
    const { client, urls } = fauxClient({
      'chat.syncMessages': {
        result: {
          updated: [
            {
              _id: 'm1',
              rid: 'r1',
              msg: 'raté pendant la coupure',
              ts: { $date: 2500 },
              u: { _id: 'u1' },
              _updatedAt: { $date: 2600 },
            },
          ],
          deleted: [{ _id: 'm-efface' }],
        },
      },
    });

    await rattraperSalon(client, moteur, 'r1');

    assert.ok(urls[0]?.includes('chat.syncMessages'));
    assert.ok(urls[0]?.includes('roomId=r1'));
    assert.ok(urls[0]?.includes(`lastUpdate=${encodeURIComponent(new Date(2000).toISOString())}`));
    assert.deepEqual(d.messages, ['m1']);
    assert.deepEqual(d.supprimesMessages, ['m-efface']);
    assert.equal(d.curseurs.get('r1|messages'), 2600);
  });

  test('abandonné entre la réponse et l’écriture : rien n’est écrit', async () => {
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 2000);
    const moteur = new MoteurSynchro(d.depot);
    const { client } = fauxClient({
      'chat.syncMessages': {
        result: { updated: [{ _id: 'm1', rid: 'r1', ts: { $date: 1 }, u: { _id: 'u' } }] },
      },
    });
    await rattraperSalon(client, moteur, 'r1', () => true);
    assert.equal(d.messages.length, 0);
  });
});

describe('reconcilierSalons', () => {
  test('purge les rids absents de la liste vivante des abonnements', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot);
    const { client, urls } = fauxClient({
      'subscriptions.get': { update: [{ rid: 'r1' }, { rid: 'r2' }] },
    });
    await reconcilierSalons(client, moteur);
    // Full : pas d'updatedSince — on veut l'état courant, pas un delta.
    assert.match(urls[0], /\/subscriptions\.get(\?|$)/);
    assert.doesNotMatch(urls[0], /updatedSince/);
    assert.deepEqual(d.purges, [['r1', 'r2']]);
  });

  test('une liste vide ne purge RIEN — garde-fou anti-purge-totale', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot);
    const { client } = fauxClient({ 'subscriptions.get': { update: [] } });
    await reconcilierSalons(client, moteur);
    assert.equal(d.purges.length, 0);
  });

  test('abandonné en vol : aucune purge', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot);
    const { client } = fauxClient({ 'subscriptions.get': { update: [{ rid: 'r1' }] } });
    await reconcilierSalons(client, moteur, () => true);
    assert.equal(d.purges.length, 0);
  });
});
