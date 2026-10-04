import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  finishPendingLogouts,
  type PendingLogout,
  type LogoutQueue,
} from './deferredLogout.ts';
import { ClientRest } from './rest.ts';

const ENTRY: PendingLogout = {
  baseUrl: 'https://x',
  userId: 'u1',
  authToken: 'jeton-mort-ou-vif',
  jetonPush: 'fcm-abc',
};

/** File en mémoire : on observe ce qui est retiré, et ce qui reste. */
function file(entries: PendingLogout[]): LogoutQueue & { remaining: () => string[] } {
  let list = [...entries];
  return {
    list: async () => [...list],
    remove: async (baseUrl) => {
      list = list.filter((d) => d.baseUrl !== baseUrl);
    },
    remaining: () => list.map((d) => d.baseUrl),
  };
}

/**
 * Client dont chaque route rend ce que la table dit. `null` = succès (200),
 * un nombre = ce statut HTTP avec une enveloppe Rocket.Chat.
 */
function clientThat(responses: Record<string, number | null>) {
  const calls: string[] = [];
  const create = (entry: PendingLogout) =>
    new ClientRest(entry.baseUrl, {
      sleep: async () => {},
      now: () => 0,
      random: () => 0,
      fetch: (async (url: string | URL) => {
        const path = String(url).split('/api/v1/')[1] ?? '';
        calls.push(path);
        const status = responses[path] ?? null;
        if (status === 0) throw new TypeError('Network request failed');
        if (status === null) return Response.json({ success: true });
        return Response.json(
          { success: false, error: 'You must be logged in to do this.' },
          { status },
        );
      }) as unknown as typeof globalThis.fetch,
    });
  return { create, calls };
}

describe('terminerDeconnexions', () => {
  test('les deux gestes passent : l’entrée est soldée', async () => {
    const f = file([ENTRY]);
    const { create, calls } = clientThat({});
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['push.token', 'logout'], 'le DELETE AVANT le logout');
    assert.deepEqual(f.remaining(), [], 'plus rien à rejouer');
  });

  test('réseau toujours coupé : l’entrée SURVIT pour le démarrage suivant', async () => {
    // Le cas nominal — l'utilisateur s'est déconnecté dans le métro, et rallume
    // son téléphone encore hors couverture. Perdre l'entrée ici, c'est laisser
    // le serveur pousser vers un appareil sans compte pour toujours.
    const f = file([ENTRY]);
    const { create } = clientThat({ 'push.token': 0, logout: 0 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(f.remaining(), ['https://x']);
  });

  test('le serveur a déjà tué le jeton (401) : l’entrée est soldée, pas retentée', async () => {
    // `logout` avait pu aboutir là où le DELETE échouait, ou le serveur a
    // expiré la session. Il n'y a plus rien à tuer : garder l'entrée serait
    // rejouer un appel voué au 401 à chaque démarrage, pour toujours.
    const f = file([ENTRY]);
    const { create } = clientThat({ 'push.token': 401, logout: 401 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(f.remaining(), []);
  });

  test('un jeton push déjà retiré (404) ne bloque pas le logout', async () => {
    // Réinstallation, rotation FCM : le 404 est un dé-enregistrement réussi.
    const f = file([ENTRY]);
    const { create, calls } = clientThat({ 'push.token': 404 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['push.token', 'logout']);
    assert.deepEqual(f.remaining(), []);
  });

  test('le logout est TENTÉ même si le retrait du jeton push a échoué', async () => {
    // Les deux gestes sont indépendants : renoncer au logout parce que le push
    // n'est pas parti laisserait la session ouverte côté serveur.
    const f = file([ENTRY]);
    const { create, calls } = clientThat({ 'push.token': 0 });
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['push.token', 'logout']);
    assert.deepEqual(f.remaining(), ['https://x'], 'le push reste à retirer');
  });

  test('sans jeton push, seul le logout est joué', async () => {
    const f = file([{ ...ENTRY, jetonPush: null }]);
    const { create, calls } = clientThat({});
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, ['logout']);
    assert.deepEqual(f.remaining(), []);
  });

  test('l’échec d’un serveur ne prive pas les autres de leur tour', async () => {
    // Multi-serveur : deux déconnexions en attente, dont une injoignable.
    const f = file([
      { ...ENTRY, baseUrl: 'https://mort' },
      { ...ENTRY, baseUrl: 'https://vivant' },
    ]);
    const create = (entry: PendingLogout) =>
      new ClientRest(entry.baseUrl, {
        sleep: async () => {},
        fetch: (async (url: string | URL) => {
          if (String(url).includes('mort')) throw new TypeError('Network request failed');
          return Response.json({ success: true });
        }) as unknown as typeof globalThis.fetch,
      });
    await finishPendingLogouts(f, create);
    assert.deepEqual(f.remaining(), ['https://mort']);
  });

  test('une file vide ne fait aucun appel', async () => {
    const f = file([]);
    const { create, calls } = clientThat({});
    await finishPendingLogouts(f, create);
    assert.deepEqual(calls, []);
  });
});
