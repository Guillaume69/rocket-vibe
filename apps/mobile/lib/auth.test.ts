import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  applySession,
  prepareTwoFactorCode,
  resumeSession,
  logIn,
  logOut,
} from './auth.ts';
import { ClientRest, TwoFactorError } from './rest.ts';

const hacher = async (t: string) => createHash('sha256').update(t).digest('hex');

let serveur: Server;
let base: string;
let poignee: (req: IncomingMessage, res: ServerResponse, corps: string) => void;
let recues: { url: string; body: unknown; headers: Record<string, string | string[] | undefined> }[] =
  [];

before(async () => {
  serveur = createServer((req, res) => {
    let brut = '';
    req.on('data', (c) => (brut += c));
    req.on('end', () => {
      recues.push({
        url: req.url ?? '',
        body: brut === '' ? null : (JSON.parse(brut) as unknown),
        headers: req.headers,
      });
      poignee(req, res, brut);
    });
  });
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const a = serveur.address();
  if (typeof a === 'string' || a === null) throw new Error('adresse inattendue');
  base = `http://127.0.0.1:${a.port}`;
});

after(() => serveur.close());
beforeEach(() => {
  recues = [];
});

function json(res: ServerResponse, statut: number, corps: unknown) {
  res.writeHead(statut, { 'content-type': 'application/json' });
  res.end(JSON.stringify(corps));
}

const SUCCES_LOGIN = {
  status: 'success',
  data: { authToken: 'jeton-abc', userId: 'u1', me: { username: 'alice' } },
};

describe('auth', () => {
  test('un login sans 2FA renvoie une session', async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    const s = await logIn(new ClientRest(base), {
      user: 'alice',
      password: 'secret',
    });
    assert.deepEqual(s, {
      baseUrl: base,
      authToken: 'jeton-abc',
      userId: 'u1',
      username: 'alice',
      genre: 'rocketchat',
      // `Site_Url` ne vient pas du login : l'écran de connexion le complète
      // depuis son sondage avant de persister.
      siteUrl: null,
    });
    assert.deepEqual(recues[0].body, { user: 'alice', password: 'secret' });
  });

  test("le login n'envoie pas d'en-têtes d'authentification", async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    const c = new ClientRest(base);
    c.auth = { authToken: 'ancien', userId: 'vieux' };
    await logIn(c, { user: 'alice', password: 'secret' });
    assert.equal(recues[0].headers['x-auth-token'], undefined);
  });

  test('une 2FA requise lève ErreurDeuxFacteurs avec sa méthode', async () => {
    poignee = (_q, res) =>
      json(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'totp', availableMethods: ['totp'], codeGenerated: false },
      });
    await assert.rejects(
      logIn(new ClientRest(base), { user: 'alice', password: 's' }),
      (e: unknown) => {
        assert.ok(e instanceof TwoFactorError);
        assert.equal(e.method, 'totp');
        return true;
      },
    );
  });

  test('un code TOTP est transmis tel quel', async () => {
    const erreur = new TwoFactorError('totp', ['totp'], false);
    const code = await prepareTwoFactorCode(erreur, ' 123456 ', hacher);
    assert.deepEqual(code, { method: 'totp', code: '123456' });
  });

  test("pour la méthode `password`, c'est le SHA-256 qui part, pas le clair", async () => {
    const erreur = new TwoFactorError('password', [], false);
    const code = await prepareTwoFactorCode(erreur, 'mon-mot-de-passe', hacher);
    assert.equal(code.method, 'password');
    assert.equal(code.code, await hacher('mon-mot-de-passe'));
    assert.notEqual(code.code, 'mon-mot-de-passe');
    assert.match(code.code, /^[0-9a-f]{64}$/);
  });

  test('le rejeu avec le code envoie les en-têtes 2FA', async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    await logIn(
      new ClientRest(base),
      { user: 'alice', password: 's' },
      { code: '123456', method: 'totp' },
    );
    assert.equal(recues[0].headers['x-2fa-code'], '123456');
    assert.equal(recues[0].headers['x-2fa-method'], 'totp');
  });

  test('reprendreSession envoie `resume`, pas de mot de passe', async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    const s = await resumeSession(new ClientRest(base), 'jeton-stocke');
    assert.deepEqual(recues[0].body, { resume: 'jeton-stocke' });
    assert.equal(s.userId, 'u1');
  });

  test('une réponse de login sans jeton est rejetée proprement', async () => {
    poignee = (_q, res) => json(res, 200, { status: 'success', data: { me: {} } });
    await assert.rejects(
      logIn(new ClientRest(base), { user: 'a', password: 'b' }),
      /Réponse de login invalide/,
    );
  });

  test('un login à 200 sans corps ne produit pas de TypeError brute', async () => {
    // `ClientRest` rend `{}` sur un 200 vide (nécessaire pour /logout) : sans
    // garde, `reponse.data.authToken` lèverait un TypeError incompréhensible.
    poignee = (_q, res) => {
      res.writeHead(200);
      res.end();
    };
    await assert.rejects(
      logIn(new ClientRest(base), { user: 'a', password: 'b' }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal(e.name, 'ErreurLogin');
        return true;
      },
    );
  });

  test('seDeconnecter est best-effort : un 401 ne rejette pas', async () => {
    poignee = (_q, res) => json(res, 401, { success: false, error: 'invalid' });
    const c = new ClientRest(base);
    c.auth = { authToken: 'x', userId: 'y' };
    await logOut(c); // ne doit pas lever
    assert.equal(c.auth, null, 'un jeton déjà invalide ne doit pas rester en mémoire');
  });

  test('appliquerSession branche les identifiants sur le client', () => {
    const c = new ClientRest(base);
    applySession(c, {
      baseUrl: base,
      authToken: 't',
      userId: 'u',
      username: 'alice',
      genre: 'rocketchat',
      siteUrl: null,
    });
    assert.deepEqual(c.auth, { authToken: 't', userId: 'u' });
  });
});
