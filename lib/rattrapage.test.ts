import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { rattraperGlobal, rattraperSalon, reconcilierSalons } from './rattrapage.ts';
import { ClientRest } from './rest.ts';
import { MoteurSynchro, type Depot } from './sync.ts';
import { TraducteurRC } from '../fournisseurs/rocketchat/traducteur.ts';

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
  const identites: { uid: string; username: string; avatarEtag: string | null }[] = [];
  let dernierLocal: number | null = null;
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
    dernierMessageMisAJour: async () => dernierLocal,
    listerClesSalon: async () => [],
    messagesADechiffrer: async () => [],
    majTexteMessage: async () => {},
    masquerMessagesChiffres: async () => {},
    majApercuChiffre: async () => {},
    majAvatarUtilisateur: async () => {},
    majAvatarSalon: async () => {},
    enregistrerIdentite: async (i) => void identites.push(i),
    transaction: async (fn) => fn(depot),
  };
  return {
    depot,
    curseurs,
    identites,
    salons,
    abonnements,
    messages,
    supprimesSalons,
    supprimesAbonnements,
    supprimesMessages,
    supprimesParSubId,
    purges,
    setDernierLocal: (v: number | null) => {
      dernierLocal = v;
    },
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
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
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
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
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

  test('MA version d’avatar est rattrapée par `me` — le seul chemin après une app fermée', async () => {
    // Photo changée depuis un autre client pendant que l'app dormait : aucun
    // stream ne l'a annoncé. Sans cette lecture, l'ancienne photo resterait
    // affichée jusqu'au prochain changement.
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client } = fauxClient({
      'rooms.get': { update: [], remove: [] },
      'subscriptions.get': { update: [], remove: [] },
      me: { _id: 'u1', username: 'alice', avatarETag: 'etag-frais' },
    });

    await rattraperGlobal(client, moteur);

    assert.deepEqual(d.identites, [{ uid: 'u1', username: 'alice', avatarEtag: 'etag-frais' }]);
  });

  test('un `me` en échec ne fait pas échouer le rattrapage', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        const chemin = new URL(String(url)).pathname.split('/api/v1/')[1];
        if (chemin === 'me') throw new Error('réseau coupé');
        return new Response(JSON.stringify({ update: [{ _id: 'r1', t: 'c' }], remove: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      dormir: async () => {},
    });

    await rattraperGlobal(client, moteur);

    assert.deepEqual(d.salons, ['r1'], 'les salons passent quand même');
    assert.equal(d.identites.length, 0);
  });
});

/** Réponses servies DANS L'ORDRE — c'est ce qui permet de tester la pagination. */
function clientSequence(reponses: (Record<string, unknown> | number)[]) {
  const urls: string[] = [];
  let i = 0;
  const client = new ClientRest('http://x', {
    fetch: async (url) => {
      urls.push(String(url));
      const r = reponses[Math.min(i, reponses.length - 1)];
      i++;
      const statut = typeof r === 'number' ? r : 200;
      const corps = typeof r === 'number' ? { success: false, error: 'params' } : r;
      return new Response(JSON.stringify(corps), {
        status: statut,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
  return { client, urls };
}

/** Une page en mode curseur, telle que le serveur 8.5 la rend. */
const page = (updated: unknown[], next: string | null, deleted: unknown[] = []) => ({
  result: { updated, deleted, cursor: { next, previous: '0' } },
});

const msg = (id: string, maj: number) => ({
  _id: id,
  rid: 'r1',
  msg: id,
  ts: { $date: maj },
  u: { _id: 'u1' },
  _updatedAt: { $date: maj },
});

describe('rattraperSalon', () => {
  test('sans curseur : ne fait RIEN — repartir de l’origine re-téléchargerait tout', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client, urls } = fauxClient({});
    await rattraperSalon(client, moteur, 'r1');
    assert.equal(urls.length, 0);
  });

  test('mode curseur : type/next/count, et SURTOUT pas de lastUpdate', async () => {
    // `lastUpdate`, s'il est présent, GAGNE sur `type`/`next` : la réponse
    // retombe en mode non borné (1,85 Mo mesurés). Son absence est le cœur du
    // correctif, pas un détail de forme.
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 2000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client, urls } = clientSequence([page([msg('m1', 2600)], null)]);

    await rattraperSalon(client, moteur, 'r1');

    assert.ok(urls[0]?.includes('chat.syncMessages'));
    assert.ok(urls[0]?.includes('roomId=r1'));
    assert.ok(urls[0]?.includes('type=UPDATED'));
    assert.ok(urls[0]?.includes('next=2000'));
    assert.ok(urls[0]?.includes('count=50'));
    assert.ok(!urls[0]?.includes('lastUpdate'), `lastUpdate doit être absent, vu ${urls[0]}`);
    assert.deepEqual(d.messages, ['m1']);
  });

  test('le curseur avance APRÈS CHAQUE page, pas seulement à la fin', async () => {
    // C'est ce qui rend le plafonnement sûr : interrompu à n'importe quelle
    // page, le passage suivant reprend là où on s'est arrêté.
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 1000);
    d.curseurs.set('r1|messages-supprimes', 9_000_000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const vus: (number | undefined)[] = [];
    const { client } = clientSequence([page([msg('m1', 1500)], '2000'), page([msg('m2', 2500)], null)]);
    const ecrire = d.depot.ecrireCurseur.bind(d.depot);
    d.depot.ecrireCurseur = async (portee, flux, v) => {
      if (flux === 'messages') vus.push(v);
      await ecrire(portee, flux, v);
    };

    await rattraperSalon(client, moteur, 'r1');

    // Le curseur du SERVEUR (2000), pas le plus grand `_updatedAt` ingéré (1500).
    assert.deepEqual(vus, [2000]);
    assert.deepEqual(d.messages, ['m1', 'm2']);
  });

  test('plafond : 2 pages au plus, même si le serveur en promet d’autres', async () => {
    // Sans plafond, une tempête `_updatedAt` (changement de pseudo → tous les
    // messages réécrits) redescendrait 60 pages, soit 1,85 Mo.
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 1000);
    d.curseurs.set('r1|messages-supprimes', 9_000_000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    // Chaque page promet une suite : seul le plafond peut arrêter la boucle.
    const { client, urls } = clientSequence([
      page([msg('m1', 1500)], '2000'),
      page([msg('m2', 2500)], '3000'),
      page([msg('m3', 3500)], '4000'),
    ]);

    await rattraperSalon(client, moteur, 'r1');

    const majs = urls.filter((u) => u.includes('type=UPDATED'));
    assert.equal(majs.length, 2, 'la 3e page ne doit pas être demandée');
    assert.deepEqual(d.messages, ['m1', 'm2']);
    assert.equal(d.curseurs.get('r1|messages'), 3000, 'le reste est repris au prochain passage');
  });

  test('un curseur qui n’avance pas arrête la boucle — pas de sur-place', async () => {
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 5000);
    d.curseurs.set('r1|messages-supprimes', 9_000_000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client, urls } = clientSequence([page([], '5000')]);

    await rattraperSalon(client, moteur, 'r1');

    assert.equal(urls.filter((u) => u.includes('type=UPDATED')).length, 1);
  });

  test('suppressions : premier passage = on cale le curseur, sans rien rapatrier', async () => {
    // Sinon on redescendrait toute la corbeille du salon depuis l'origine.
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 4000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client, urls } = clientSequence([page([], null)]);

    await rattraperSalon(client, moteur, 'r1');

    assert.equal(urls.filter((u) => u.includes('type=DELETED')).length, 0);
    assert.equal(d.curseurs.get('r1|messages-supprimes'), 4000);
  });

  test('suppressions : passage suivant → les messages effacés côté serveur partent', async () => {
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 4000);
    d.curseurs.set('r1|messages-supprimes', 4000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client, urls } = clientSequence([
      page([], null),
      { result: { deleted: [{ _id: 'm-efface' }], cursor: { next: '5000', previous: '0' } } },
      { result: { deleted: [], cursor: { next: null, previous: '0' } } },
    ]);

    await rattraperSalon(client, moteur, 'r1');

    const suppr = urls.filter((u) => u.includes('type=DELETED'));
    assert.ok(suppr[0]?.includes('next=4000'));
    assert.deepEqual(d.supprimesMessages, ['m-efface']);
    assert.equal(d.curseurs.get('r1|messages-supprimes'), 5000);
  });

  test('abandonné entre la réponse et l’écriture : rien n’est écrit', async () => {
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 2000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client } = clientSequence([page([msg('m1', 2500)], null)]);
    await rattraperSalon(client, moteur, 'r1', () => true);
    assert.equal(d.messages.length, 0);
  });

  test('un timeout REMONTE sans basculer en mode non borné', async () => {
    // Le repli ne doit se déclencher que sur des paramètres refusés (400).
    // Basculer sur `lastUpdate` parce que le réseau flanche rapporterait
    // exactement les mégaoctets qu'on cherche à éviter.
    const d = fauxDepotComplet();
    d.curseurs.set('r1|messages', 1000);
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const urls: string[] = [];
    const client = new ClientRest('http://x', {
      fetch: async (url) => {
        urls.push(String(url));
        throw new Error('timeout');
      },
    });

    await assert.rejects(() => rattraperSalon(client, moteur, 'r1'));

    assert.ok(!urls.some((u) => u.includes('lastUpdate')), 'aucun repli sur un timeout');
    assert.equal(d.curseurs.get('r1|messages'), 1000, 'curseur intact : la reprise est exacte');
  });

  describe('repli sur un serveur sans mode curseur (< 7.5)', () => {
    const jour = 24 * 60 * 60 * 1000;

    test('400 sur la première page → lastUpdate, fenêtre ramenée à 24 h', async () => {
      const maintenant = 100 * jour;
      const d = fauxDepotComplet();
      d.curseurs.set('r1|messages', 2 * jour); // 98 jours de retard
      const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
      const { client, urls } = clientSequence([400, { result: { updated: [] } }]);

      await rattraperSalon(client, moteur, 'r1', () => false, () => maintenant);

      const attendu = encodeURIComponent(new Date(maintenant - jour).toISOString());
      assert.ok(urls[1]?.includes(`lastUpdate=${attendu}`), `vu ${urls[1]}`);
    });

    test('une réponse SANS cursor vaut refus — le serveur ignore les paramètres', async () => {
      const d = fauxDepotComplet();
      d.curseurs.set('r1|messages', 2000);
      const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
      const { client, urls } = clientSequence([
        { result: { updated: [] } },
        { result: { updated: [msg('m1', 2600)] } },
      ]);

      await rattraperSalon(client, moteur, 'r1', () => false, () => 3000);

      assert.ok(urls[1]?.includes('lastUpdate'), `vu ${urls[1]}`);
      assert.deepEqual(d.messages, ['m1']);
    });

    test('le repli échoue → curseur RÉ-ANCRÉ sur le dernier message local', async () => {
      // Sans mode curseur, la requête n'est pas bornée et timeoute sur un gros
      // backlog. Le curseur ne s'avançant qu'APRÈS ingestion, il resterait
      // coincé → boucle sans fin. Le ré-ancrage ne vaut que pour ce chemin-là.
      const d = fauxDepotComplet();
      d.curseurs.set('r1|messages', 1000);
      d.setDernierLocal(9000);
      const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
      let premier = true;
      const client = new ClientRest('http://x', {
        fetch: async () => {
          if (premier) {
            premier = false;
            return new Response(JSON.stringify({ success: false }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          throw new Error('timeout');
        },
        dormir: async () => {},
      });

      await assert.rejects(() => rattraperSalon(client, moteur, 'r1'));
      assert.equal(d.curseurs.get('r1|messages'), 9000);
    });
  });
});

describe('reconcilierSalons', () => {
  test('purge les rids absents de la liste vivante des abonnements', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
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
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client } = fauxClient({ 'subscriptions.get': { update: [] } });
    await reconcilierSalons(client, moteur);
    assert.equal(d.purges.length, 0);
  });

  test('abandonné en vol : aucune purge', async () => {
    const d = fauxDepotComplet();
    const moteur = new MoteurSynchro(d.depot, new TraducteurRC());
    const { client } = fauxClient({ 'subscriptions.get': { update: [{ rid: 'r1' }] } });
    await reconcilierSalons(client, moteur, () => true);
    assert.equal(d.purges.length, 0);
  });
});
