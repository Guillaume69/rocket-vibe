import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  terminerDeconnexions,
  type DeconnexionEnSuspens,
  type FileDeconnexions,
} from './deferredLogout.ts';
import { ClientRest } from './rest.ts';

const ENTREE: DeconnexionEnSuspens = {
  baseUrl: 'https://x',
  userId: 'u1',
  authToken: 'jeton-mort-ou-vif',
  jetonPush: 'fcm-abc',
};

/** File en mémoire : on observe ce qui est retiré, et ce qui reste. */
function file(entrees: DeconnexionEnSuspens[]): FileDeconnexions & { restantes: () => string[] } {
  let liste = [...entrees];
  return {
    lister: async () => [...liste],
    retirer: async (baseUrl) => {
      liste = liste.filter((d) => d.baseUrl !== baseUrl);
    },
    restantes: () => liste.map((d) => d.baseUrl),
  };
}

/**
 * Client dont chaque route rend ce que la table dit. `null` = succès (200),
 * un nombre = ce statut HTTP avec une enveloppe Rocket.Chat.
 */
function clientQui(reponses: Record<string, number | null>) {
  const appels: string[] = [];
  const creer = (entree: DeconnexionEnSuspens) =>
    new ClientRest(entree.baseUrl, {
      dormir: async () => {},
      maintenant: () => 0,
      alea: () => 0,
      fetch: (async (url: string | URL) => {
        const chemin = String(url).split('/api/v1/')[1] ?? '';
        appels.push(chemin);
        const statut = reponses[chemin] ?? null;
        if (statut === 0) throw new TypeError('Network request failed');
        if (statut === null) return Response.json({ success: true });
        return Response.json(
          { success: false, error: 'You must be logged in to do this.' },
          { status: statut },
        );
      }) as unknown as typeof globalThis.fetch,
    });
  return { creer, appels };
}

describe('terminerDeconnexions', () => {
  test('les deux gestes passent : l’entrée est soldée', async () => {
    const f = file([ENTREE]);
    const { creer, appels } = clientQui({});
    await terminerDeconnexions(f, creer);
    assert.deepEqual(appels, ['push.token', 'logout'], 'le DELETE AVANT le logout');
    assert.deepEqual(f.restantes(), [], 'plus rien à rejouer');
  });

  test('réseau toujours coupé : l’entrée SURVIT pour le démarrage suivant', async () => {
    // Le cas nominal — l'utilisateur s'est déconnecté dans le métro, et rallume
    // son téléphone encore hors couverture. Perdre l'entrée ici, c'est laisser
    // le serveur pousser vers un appareil sans compte pour toujours.
    const f = file([ENTREE]);
    const { creer } = clientQui({ 'push.token': 0, logout: 0 });
    await terminerDeconnexions(f, creer);
    assert.deepEqual(f.restantes(), ['https://x']);
  });

  test('le serveur a déjà tué le jeton (401) : l’entrée est soldée, pas retentée', async () => {
    // `logout` avait pu aboutir là où le DELETE échouait, ou le serveur a
    // expiré la session. Il n'y a plus rien à tuer : garder l'entrée serait
    // rejouer un appel voué au 401 à chaque démarrage, pour toujours.
    const f = file([ENTREE]);
    const { creer } = clientQui({ 'push.token': 401, logout: 401 });
    await terminerDeconnexions(f, creer);
    assert.deepEqual(f.restantes(), []);
  });

  test('un jeton push déjà retiré (404) ne bloque pas le logout', async () => {
    // Réinstallation, rotation FCM : le 404 est un dé-enregistrement réussi.
    const f = file([ENTREE]);
    const { creer, appels } = clientQui({ 'push.token': 404 });
    await terminerDeconnexions(f, creer);
    assert.deepEqual(appels, ['push.token', 'logout']);
    assert.deepEqual(f.restantes(), []);
  });

  test('le logout est TENTÉ même si le retrait du jeton push a échoué', async () => {
    // Les deux gestes sont indépendants : renoncer au logout parce que le push
    // n'est pas parti laisserait la session ouverte côté serveur.
    const f = file([ENTREE]);
    const { creer, appels } = clientQui({ 'push.token': 0 });
    await terminerDeconnexions(f, creer);
    assert.deepEqual(appels, ['push.token', 'logout']);
    assert.deepEqual(f.restantes(), ['https://x'], 'le push reste à retirer');
  });

  test('sans jeton push, seul le logout est joué', async () => {
    const f = file([{ ...ENTREE, jetonPush: null }]);
    const { creer, appels } = clientQui({});
    await terminerDeconnexions(f, creer);
    assert.deepEqual(appels, ['logout']);
    assert.deepEqual(f.restantes(), []);
  });

  test('l’échec d’un serveur ne prive pas les autres de leur tour', async () => {
    // Multi-serveur : deux déconnexions en attente, dont une injoignable.
    const f = file([
      { ...ENTREE, baseUrl: 'https://mort' },
      { ...ENTREE, baseUrl: 'https://vivant' },
    ]);
    const creer = (entree: DeconnexionEnSuspens) =>
      new ClientRest(entree.baseUrl, {
        dormir: async () => {},
        fetch: (async (url: string | URL) => {
          if (String(url).includes('mort')) throw new TypeError('Network request failed');
          return Response.json({ success: true });
        }) as unknown as typeof globalThis.fetch,
      });
    await terminerDeconnexions(f, creer);
    assert.deepEqual(f.restantes(), ['https://mort']);
  });

  test('une file vide ne fait aucun appel', async () => {
    const f = file([]);
    const { creer, appels } = clientQui({});
    await terminerDeconnexions(f, creer);
    assert.deepEqual(appels, []);
  });
});
