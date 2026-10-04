import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ClientRest } from './rest.ts';
import {
  confirmerMedia,
  setAvatar,
  UploadError,
  uploadBytes,
  urlAvatar,
  protectedFileUrl,
  type TransportUpload,
} from './upload.ts';

function clientAuthentifie(reponsesPost: Record<string, unknown>) {
  const posts: { path: string; body: unknown }[] = [];
  const client = new ClientRest('http://x', {
    fetch: async (url, init) => {
      const chemin = String(url).split('/api/v1/')[1] ?? '';
      posts.push({ path: chemin, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(reponsesPost[chemin] ?? { success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    sleep: async () => {},
  });
  client.auth = { authToken: 'jeton-alice', userId: 'uid-alice' };
  return { client, posts };
}

const fichier = { uri: 'file:///x/mini.png', name: 'mini.png', type: 'image/png' };

describe('televerserOctets', () => {
  test('poste sur rooms.media, authentifié, et rend le fileId — SANS rien confirmer', async () => {
    const appels: string[] = [];
    const transport: TransportUpload = async (url, entetes) => {
      appels.push(url);
      assert.equal(entetes['X-Auth-Token'], 'jeton-alice', "l'upload est authentifié");
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' }, success: true }) };
    };
    const { client, posts } = clientAuthentifie({});

    const fileId = await uploadBytes({ client, transport, rid: 'r1', file: fichier });

    assert.deepEqual(appels, ['http://x/api/v1/rooms.media/r1']);
    assert.equal(fileId, 'f1', 'c’est LUI qu’on persiste avant d’aller plus loin');
    assert.equal(posts.length, 0, 'les deux temps sont bien séparés');
  });

  test('un refus de rooms.media est une erreur claire', async () => {
    const transport: TransportUpload = async () => ({
      status: 413,
      body: JSON.stringify({ success: false, error: 'File too large' }),
    });
    const { client, posts } = clientAuthentifie({});
    await assert.rejects(
      uploadBytes({ client, transport, rid: 'r1', file: fichier }),
      (e: unknown) => e instanceof UploadError && e.message === 'File too large',
    );
    assert.equal(posts.length, 0);
  });

  test('une réponse non JSON (reverse proxy) ne plante pas en TypeError', async () => {
    const transport: TransportUpload = async () => ({ status: 502, body: '<html>bad gateway' });
    const { client } = clientAuthentifie({});
    await assert.rejects(uploadBytes({ client, transport, rid: 'r1', file: fichier }), UploadError);
  });

  test('l’interrupteur de la tâche est remonté à l’appelant', async () => {
    let annuler: (() => Promise<void>) | null = null;
    let annule = false;
    const transport: TransportUpload = async (_u, _e, _f, _p, surAnnulable) => {
      surAnnulable?.(async () => void (annule = true));
      return { status: 200, body: JSON.stringify({ file: { _id: 'f1' } }) };
    };
    const { client } = clientAuthentifie({});
    await uploadBytes({
      client,
      transport,
      rid: 'r1',
      file: fichier,
      onCancelable: (a) => void (annuler = a),
    });
    assert.notEqual(annuler, null, 'sans lui, « Abandonner » ne serait qu’un DELETE');
    await (annuler as unknown as () => Promise<void>)();
    assert.ok(annule);
  });
});

describe('confirmerMedia', () => {
  test('c’est mediaConfirm qui CRÉE le message — rooms.media seul laisse un orphelin', async () => {
    const { client, posts } = clientAuthentifie({
      'rooms.mediaConfirm/r1/f1': { success: true, message: { _id: 'm1', rid: 'r1' } },
    });
    const message = await confirmerMedia({ client, rid: 'r1', fileId: 'f1', message: 'légende' });
    assert.equal(posts[0]?.path, 'rooms.mediaConfirm/r1/f1');
    assert.deepEqual(posts[0]?.body, { msg: 'légende' });
    assert.equal(message._id, 'm1');
  });

  test('sans légende, le corps est VIDE (additionalProperties: false)', async () => {
    const { client, posts } = clientAuthentifie({
      'rooms.mediaConfirm/r1/f1': { success: true, message: { _id: 'm1' } },
    });
    await confirmerMedia({ client, rid: 'r1', fileId: 'f1' });
    assert.deepEqual(posts[0]?.body, {}, 'le serveur refuserait toute clé en trop');
  });

  test('une confirmation sans message est une erreur, pas un succès silencieux', async () => {
    const { client } = clientAuthentifie({ 'rooms.mediaConfirm/r1/f1': { success: true } });
    await assert.rejects(confirmerMedia({ client, rid: 'r1', fileId: 'f1' }), UploadError);
  });
});

describe('definirAvatar', () => {
  test('poste vers users.setAvatar, authentifié', async () => {
    let urlVue = '';
    const transport: TransportUpload = async (url, entetes) => {
      urlVue = url;
      assert.equal(entetes['X-Auth-Token'], 'jeton-alice', "l'upload d'avatar est authentifié");
      return { status: 200, body: JSON.stringify({ success: true }) };
    };
    const { client } = clientAuthentifie({});
    await setAvatar({ client, transport, file: fichier });
    assert.equal(urlVue, 'http://x/api/v1/users.setAvatar');
  });

  test('un refus serveur devient une ErreurUpload claire', async () => {
    const transport: TransportUpload = async () => ({
      status: 400,
      body: JSON.stringify({ success: false, error: 'Avatar change disabled' }),
    });
    const { client } = clientAuthentifie({});
    await assert.rejects(
      setAvatar({ client, transport, file: fichier }),
      (e: unknown) => e instanceof UploadError && e.message === 'Avatar change disabled',
    );
  });

  test('une réponse non JSON ne plante pas en TypeError', async () => {
    const transport: TransportUpload = async () => ({ status: 502, body: '<html>' });
    const { client } = clientAuthentifie({});
    await assert.rejects(setAvatar({ client, transport, file: fichier }), UploadError);
  });
});

describe('urlFichierProtege', () => {
  test('ajoute rc_uid et rc_token — FileUpload_ProtectFiles les exige', () => {
    const { client } = clientAuthentifie({});
    assert.equal(
      protectedFileUrl(client, '/file-upload/f1/mini.png'),
      'http://x/file-upload/f1/mini.png?rc_uid=uid-alice&rc_token=jeton-alice',
    );
  });

  test('respecte une query déjà présente', () => {
    const { client } = clientAuthentifie({});
    assert.match(protectedFileUrl(client, '/file-upload/f1/x.png?a=1'), /\?a=1&rc_uid=/);
  });

  test('un chemin ABSOLU vers un autre hôte ne reçoit PAS le jeton', () => {
    // `title_link` vient d'un `attachments` de message, que `chat.sendMessage`
    // accepte tel quel : un lien absolu forgé repartait d'ici avec rc_uid et
    // rc_token collés dessus, et une `<Image>` les livrait à cet hôte.
    const { client } = clientAuthentifie({});
    const url = protectedFileUrl(client, 'https://evil.example/collecte.png');
    assert.equal(url, 'https://evil.example/collecte.png');
    assert.ok(!url.includes('rc_token'));
  });

  test('un hôte dont le nôtre est un préfixe reste un autre hôte', () => {
    const { client } = clientAuthentifie({});
    assert.ok(!protectedFileUrl(client, 'http://x.evil.example/f.png').includes('rc_token'));
  });

  test("un userinfo qui imite notre hôte n'obtient rien non plus", () => {
    const { client } = clientAuthentifie({});
    assert.ok(!protectedFileUrl(client, 'http://x@evil.example/f.png').includes('rc_token'));
  });

  test('une URL absolue vers NOTRE serveur reste authentifiée', () => {
    const { client } = clientAuthentifie({});
    assert.match(protectedFileUrl(client, 'http://x/file-upload/f1/x.png'), /rc_token=jeton-alice/);
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
