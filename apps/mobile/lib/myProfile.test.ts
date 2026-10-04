import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  diffInfos,
  saveBasicInfo,
  saveStatus,
  requiresPassword,
  readMyProfile,
  profileFromMe,
  type MyProfile,
} from './myProfile.ts';
import { ClientRest } from './rest.ts';

/** Client qui enregistre chaque appel et répond ce qu'on lui donne par chemin. */
function spyClient(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      const path = String(url).split('/api/v1/')[1] ?? '';
      calls.push({
        method: init?.method ?? 'GET',
        path,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers),
      });
      return new Response(JSON.stringify(responses[path] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  client.auth = { authToken: 'jeton-alice', userId: 'uid-alice' };
  return { client, calls };
}

describe('profilDepuisMe', () => {
  test('normalise les champs présents (statusDefault prioritaire)', () => {
    const p = profileFromMe({
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
    assert.equal(profileFromMe({ status: 'offline', statusDefault: 'online' }).status, 'online');
  });

  test('sans statusDefault, on retombe sur status', () => {
    assert.equal(profileFromMe({ status: 'away' }).status, 'away');
  });

  test('champs absents → chaînes vides, statut inconnu → offline', () => {
    const p = profileFromMe({ username: 'bob' });
    assert.equal(p.name, '');
    assert.equal(p.email, '');
    assert.equal(p.bio, '');
    assert.equal(p.statusText, '');
    assert.equal(p.status, 'offline');
  });

  test('statut hors-liste → offline', () => {
    assert.equal(profileFromMe({ status: 'invisible' }).status, 'offline');
  });

  test('emails vide ou malformé → e-mail vide, sans planter', () => {
    assert.equal(profileFromMe({ emails: [] }).email, '');
    assert.equal(profileFromMe({ emails: 'pas-un-tableau' }).email, '');
    assert.equal(profileFromMe({ emails: [{ verified: true }] }).email, '');
  });
});

describe('lireMonProfil', () => {
  test('lit GET me et normalise', async () => {
    const { client, calls } = spyClient({ me: { username: 'alice', status: 'online' } });
    const p = await readMyProfile(client);
    assert.equal(calls[0]?.path, 'me');
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(p.username, 'alice');
    assert.equal(p.status, 'online');
  });
});

describe('enregistrerStatut', () => {
  test('poste status ET message ensemble', async () => {
    const { client, calls } = spyClient();
    await saveStatus(client, { status: 'away', message: 'Déjeuner' });
    assert.equal(calls[0]?.path, 'users.setStatus');
    assert.deepEqual(calls[0]?.body, { status: 'away', message: 'Déjeuner' });
  });
});

describe('enregistrerInfos', () => {
  test('poste { data } sans en-tête 2FA quand aucun code', async () => {
    const { client, calls } = spyClient();
    await saveBasicInfo(client, { name: 'Alice M.' });
    assert.equal(calls[0]?.path, 'users.updateOwnBasicInfo');
    assert.deepEqual(calls[0]?.body, { data: { name: 'Alice M.' } });
    assert.equal(calls[0]?.headers.get('x-2fa-code'), null);
  });

  test('ajoute les en-têtes x-2fa-* quand un code est fourni', async () => {
    const { client, calls } = spyClient();
    await saveBasicInfo(client, { email: 'neuf@x.fr' }, { code: '123456', method: 'totp' });
    assert.equal(calls[0]?.headers.get('x-2fa-code'), '123456');
    assert.equal(calls[0]?.headers.get('x-2fa-method'), 'totp');
  });
});

describe('diffInfos', () => {
  const base: MyProfile = {
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
    assert.equal(requiresPassword({ email: 'x@y.fr' }), true);
    assert.equal(requiresPassword({ username: 'neuf' }), true);
  });
  test('nom ou bio seuls → faux', () => {
    assert.equal(requiresPassword({ name: 'X', bio: 'Y' }), false);
    assert.equal(requiresPassword({}), false);
  });
});
