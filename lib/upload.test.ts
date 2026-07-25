import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientRest } from './rest.ts';
import {
  definirAvatar,
  ErreurUpload,
  televerser,
  urlAvatar,
  urlFichierProtege,
  type TransportUpload,
} from './upload.ts';

function clientAuthentifie(reponsesPost: Record<string, unknown>) {
  const posts: { chemin: string; corps: unknown }[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      const chemin = String(url).split('/api/v1/')[1] ?? '';
      posts.push({ chemin, corps: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(reponsesPost[chemin] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    dormir: async () => {},
  });
  client.identifiants = { authToken: 'jeton-alice', userId: 'uid-alice' };
  return { client, posts };
}

const fichier = { uri: 'file:///x/mini.png', nom: 'mini.png', type: 'image/png' };

describe('televerser', () => {
  test('media PUIS mediaConfirm : le message confirmé est rendu', async () => {
    const appels: string[] = [];
    const transport: TransportUpload = async (url, entetes) => {
      appels.push(url);
      assert.equal(entetes['X-Auth-Token'], 'jeton-alice', "l'upload est authentifié");
      return { statut: 200, corps: JSON.stringify({ file: { _id: 'f1' }, success: true }) };
    };
    const { client, posts } = clientAuthentifie({
      'rooms.mediaConfirm/r1/f1': { success: true, message: { _id: 'm1', rid: 'r1' } },
    });

    const message = await televerser({ client, transport, rid: 'r1', fichier, message: 'légende' });

    assert.deepEqual(appels, ['http://x/api/v1/rooms.media/r1']);
    assert.equal(posts[0]?.chemin, 'rooms.mediaConfirm/r1/f1', 'SANS confirm, fichier orphelin');
    assert.deepEqual(posts[0]?.corps, { msg: 'légende' });
    assert.equal(message._id, 'm1');
  });

  test('sans légende, le corps du confirm est VIDE (additionalProperties: false)', async () => {
    const transport: TransportUpload = async () => ({
      statut: 200,
      corps: JSON.stringify({ file: { _id: 'f1' } }),
    });
    const { client, posts } = clientAuthentifie({
      'rooms.mediaConfirm/r1/f1': { success: true, message: { _id: 'm1' } },
    });
    await televerser({ client, transport, rid: 'r1', fichier });
    assert.deepEqual(posts[0]?.corps, {});
  });

  test('un refus de rooms.media est une erreur claire, et AUCUN confirm ne part', async () => {
    const transport: TransportUpload = async () => ({
      statut: 413,
      corps: JSON.stringify({ success: false, error: 'File too large' }),
    });
    const { client, posts } = clientAuthentifie({});
    await assert.rejects(
      televerser({ client, transport, rid: 'r1', fichier }),
      (e: unknown) => e instanceof ErreurUpload && e.message === 'File too large',
    );
    assert.equal(posts.length, 0);
  });

  test('une réponse non JSON (reverse proxy) ne plante pas en TypeError', async () => {
    const transport: TransportUpload = async () => ({ statut: 502, corps: '<html>bad gateway' });
    const { client } = clientAuthentifie({});
    await assert.rejects(televerser({ client, transport, rid: 'r1', fichier }), ErreurUpload);
  });
});

describe('definirAvatar', () => {
  test('poste vers users.setAvatar, authentifié', async () => {
    let urlVue = '';
    const transport: TransportUpload = async (url, entetes) => {
      urlVue = url;
      assert.equal(entetes['X-Auth-Token'], 'jeton-alice', "l'upload d'avatar est authentifié");
      return { statut: 200, corps: JSON.stringify({ success: true }) };
    };
    const { client } = clientAuthentifie({});
    await definirAvatar({ client, transport, fichier });
    assert.equal(urlVue, 'http://x/api/v1/users.setAvatar');
  });

  test('un refus serveur devient une ErreurUpload claire', async () => {
    const transport: TransportUpload = async () => ({
      statut: 400,
      corps: JSON.stringify({ success: false, error: 'Avatar change disabled' }),
    });
    const { client } = clientAuthentifie({});
    await assert.rejects(
      definirAvatar({ client, transport, fichier }),
      (e: unknown) => e instanceof ErreurUpload && e.message === 'Avatar change disabled',
    );
  });

  test('une réponse non JSON ne plante pas en TypeError', async () => {
    const transport: TransportUpload = async () => ({ statut: 502, corps: '<html>' });
    const { client } = clientAuthentifie({});
    await assert.rejects(definirAvatar({ client, transport, fichier }), ErreurUpload);
  });
});

describe('urlFichierProtege', () => {
  test('ajoute rc_uid et rc_token — FileUpload_ProtectFiles les exige', () => {
    const { client } = clientAuthentifie({});
    assert.equal(
      urlFichierProtege(client, '/file-upload/f1/mini.png'),
      'http://x/file-upload/f1/mini.png?rc_uid=uid-alice&rc_token=jeton-alice',
    );
  });

  test('respecte une query déjà présente', () => {
    const { client } = clientAuthentifie({});
    assert.match(urlFichierProtege(client, '/file-upload/f1/x.png?a=1'), /\?a=1&rc_uid=/);
  });
});

describe('urlAvatar', () => {
  test('vise par uid, authentifié — Accounts_AvatarBlockUnauthenticatedAccess l\'exige', () => {
    const { client } = clientAuthentifie({});
    assert.equal(
      urlAvatar(client, { uid: 'u123' }),
      'http://x/avatar/uid/u123?rc_uid=uid-alice&rc_token=jeton-alice',
    );
  });

  test('un pseudo prime sur l\'uid, et est encodé', () => {
    const { client } = clientAuthentifie({});
    assert.match(urlAvatar(client, { username: 'a b', uid: 'u1' }) ?? '', /\/avatar\/a%20b\?/);
  });

  test('un canal vise /avatar/room/<rid>', () => {
    const { client } = clientAuthentifie({});
    assert.match(urlAvatar(client, { rid: 'GENERAL' }) ?? '', /\/avatar\/room\/GENERAL\?/);
  });

  test('rend null si rien ne désigne de cible — l\'appelant garde sa tuile', () => {
    const { client } = clientAuthentifie({});
    assert.equal(urlAvatar(client, { uid: null, username: '', rid: undefined }), null);
  });

  test('la version de la photo entre dans l\'URI — sinon le cache image la fige à vie', () => {
    // Le serveur ignore le paramètre ; c'est le CACHE d'Android qu'il vise. Sans
    // lui, `/avatar/alice` reste identique après un changement de photo et
    // l'ancienne image s'affiche pour toujours (aucun ETag HTTP côté serveur,
    // relevé sur 8.5).
    const { client } = clientAuthentifie({});
    const avant = urlAvatar(client, { username: 'alice', etag: 'e1' });
    const apres = urlAvatar(client, { username: 'alice', etag: 'e2' });
    assert.match(avant ?? '', /\/avatar\/alice\?etag=e1&rc_uid=/);
    assert.notEqual(avant, apres, 'une nouvelle version doit donner une nouvelle URI');
  });

  test('sans version connue, l\'URI reste celle d\'avant — rien ne régresse', () => {
    const { client } = clientAuthentifie({});
    assert.equal(
      urlAvatar(client, { username: 'alice', etag: null }),
      urlAvatar(client, { username: 'alice' }),
    );
  });

  test('la version d\'un salon est encodée elle aussi', () => {
    const { client } = clientAuthentifie({});
    assert.match(urlAvatar(client, { rid: 'r 1', etag: 'a/b' }) ?? '', /\/avatar\/room\/r%201\?etag=a%2Fb&/);
  });
});
