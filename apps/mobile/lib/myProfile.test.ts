import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  diffInfos,
  enregistrerInfos,
  enregistrerStatut,
  exigeMotDePasse,
  lireMonProfil,
  profilDepuisMe,
  type MonProfil,
} from './myProfile.ts';
import { ClientRest } from './rest.ts';

/** Client qui enregistre chaque appel et répond ce qu'on lui donne par chemin. */
function clientEspion(reponses: Record<string, unknown> = {}) {
  const appels: { methode: string; chemin: string; corps: unknown; entetes: Headers }[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      const chemin = String(url).split('/api/v1/')[1] ?? '';
      appels.push({
        methode: init?.method ?? 'GET',
        chemin,
        corps: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        entetes: new Headers(init?.headers),
      });
      return new Response(JSON.stringify(reponses[chemin] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
  client.identifiants = { authToken: 'jeton-alice', userId: 'uid-alice' };
  return { client, appels };
}

describe('profilDepuisMe', () => {
  test('normalise les champs présents (statusDefault prioritaire)', () => {
    const p = profilDepuisMe({
      username: 'alice',
      name: 'Alice Merveille',
      status: 'online',
      statusDefault: 'busy',
      statusText: 'En réunion',
      bio: 'Développeuse',
      emails: [{ address: 'alice@x.fr', verified: true }],
    });
    assert.deepEqual(p, {
      username: 'alice',
      name: 'Alice Merveille',
      email: 'alice@x.fr',
      status: 'busy',
      statusText: 'En réunion',
      bio: 'Développeuse',
    });
  });

  test('statusDefault prime sur la présence live (offline à froid)', () => {
    // Le cas réel : app juste ouverte, présence encore offline, mais le choix
    // de l'utilisateur est « online ». L'éditeur doit montrer le choix.
    assert.equal(profilDepuisMe({ status: 'offline', statusDefault: 'online' }).status, 'online');
  });

  test('sans statusDefault, on retombe sur status', () => {
    assert.equal(profilDepuisMe({ status: 'away' }).status, 'away');
  });

  test('champs absents → chaînes vides, statut inconnu → offline', () => {
    const p = profilDepuisMe({ username: 'bob' });
    assert.equal(p.name, '');
    assert.equal(p.email, '');
    assert.equal(p.bio, '');
    assert.equal(p.statusText, '');
    assert.equal(p.status, 'offline');
  });

  test('statut hors-liste → offline', () => {
    assert.equal(profilDepuisMe({ status: 'invisible' }).status, 'offline');
  });

  test('emails vide ou malformé → e-mail vide, sans planter', () => {
    assert.equal(profilDepuisMe({ emails: [] }).email, '');
    assert.equal(profilDepuisMe({ emails: 'pas-un-tableau' }).email, '');
    assert.equal(profilDepuisMe({ emails: [{ verified: true }] }).email, '');
  });
});

describe('lireMonProfil', () => {
  test('lit GET me et normalise', async () => {
    const { client, appels } = clientEspion({ me: { username: 'alice', status: 'online' } });
    const p = await lireMonProfil(client);
    assert.equal(appels[0]?.chemin, 'me');
    assert.equal(appels[0]?.methode, 'GET');
    assert.equal(p.username, 'alice');
    assert.equal(p.status, 'online');
  });
});

describe('enregistrerStatut', () => {
  test('poste status ET message ensemble', async () => {
    const { client, appels } = clientEspion();
    await enregistrerStatut(client, { status: 'away', message: 'Déjeuner' });
    assert.equal(appels[0]?.chemin, 'users.setStatus');
    assert.deepEqual(appels[0]?.corps, { status: 'away', message: 'Déjeuner' });
  });
});

describe('enregistrerInfos', () => {
  test('poste { data } sans en-tête 2FA quand aucun code', async () => {
    const { client, appels } = clientEspion();
    await enregistrerInfos(client, { name: 'Alice M.' });
    assert.equal(appels[0]?.chemin, 'users.updateOwnBasicInfo');
    assert.deepEqual(appels[0]?.corps, { data: { name: 'Alice M.' } });
    assert.equal(appels[0]?.entetes.get('x-2fa-code'), null);
  });

  test('ajoute les en-têtes x-2fa-* quand un code est fourni', async () => {
    const { client, appels } = clientEspion();
    await enregistrerInfos(client, { email: 'neuf@x.fr' }, { code: '123456', methode: 'totp' });
    assert.equal(appels[0]?.entetes.get('x-2fa-code'), '123456');
    assert.equal(appels[0]?.entetes.get('x-2fa-method'), 'totp');
  });
});

describe('diffInfos', () => {
  const base: MonProfil = {
    username: 'alice',
    name: 'Alice',
    email: 'alice@x.fr',
    status: 'online',
    statusText: '',
    bio: 'Bonjour',
  };

  test('aucun changement → objet vide', () => {
    assert.deepEqual(diffInfos(base, { ...base }), {});
  });

  test('ne retient que les champs modifiés', () => {
    const d = diffInfos(base, { ...base, name: 'Alice M.', bio: 'Salut' });
    assert.deepEqual(d, { name: 'Alice M.', bio: 'Salut' });
  });

  test('le statut et le texte de statut ne passent PAS par diffInfos', () => {
    const d = diffInfos(base, { ...base, status: 'busy', statusText: 'X' });
    assert.deepEqual(d, {});
  });
});

describe('exigeMotDePasse', () => {
  test('e-mail ou nom d’utilisateur → vrai', () => {
    assert.equal(exigeMotDePasse({ email: 'x@y.fr' }), true);
    assert.equal(exigeMotDePasse({ username: 'neuf' }), true);
  });
  test('nom ou bio seuls → faux', () => {
    assert.equal(exigeMotDePasse({ name: 'X', bio: 'Y' }), false);
    assert.equal(exigeMotDePasse({}), false);
  });
});
