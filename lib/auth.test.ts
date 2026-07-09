import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  appliquerSession,
  preparerCodeDeuxFacteurs,
  reprendreSession,
  seConnecter,
  seDeconnecter,
} from './auth.ts';
import { ClientRest, ErreurDeuxFacteurs } from './rest.ts';

const hacher = async (t: string) => createHash('sha256').update(t).digest('hex');

let serveur: Server;
let base: string;
let poignee: (req: IncomingMessage, res: ServerResponse, corps: string) => void;
let recues: { url: string; corps: unknown; enTetes: Record<string, string | string[] | undefined> }[] =
  [];

before(async () => {
  serveur = createServer((req, res) => {
    let brut = '';
    req.on('data', (c) => (brut += c));
    req.on('end', () => {
      recues.push({
        url: req.url ?? '',
        corps: brut === '' ? null : (JSON.parse(brut) as unknown),
        enTetes: req.headers,
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
    const s = await seConnecter(new ClientRest(base), {
      utilisateur: 'alice',
      motDePasse: 'secret',
    });
    assert.deepEqual(s, {
      baseUrl: base,
      authToken: 'jeton-abc',
      userId: 'u1',
      username: 'alice',
    });
    assert.deepEqual(recues[0].corps, { user: 'alice', password: 'secret' });
  });

  test("le login n'envoie pas d'en-têtes d'authentification", async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    const c = new ClientRest(base);
    c.identifiants = { authToken: 'ancien', userId: 'vieux' };
    await seConnecter(c, { utilisateur: 'alice', motDePasse: 'secret' });
    assert.equal(recues[0].enTetes['x-auth-token'], undefined);
  });

  test('une 2FA requise lève ErreurDeuxFacteurs avec sa méthode', async () => {
    poignee = (_q, res) =>
      json(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'totp', availableMethods: ['totp'], codeGenerated: false },
      });
    await assert.rejects(
      seConnecter(new ClientRest(base), { utilisateur: 'alice', motDePasse: 's' }),
      (e: unknown) => {
        assert.ok(e instanceof ErreurDeuxFacteurs);
        assert.equal(e.methode, 'totp');
        return true;
      },
    );
  });

  test('un code TOTP est transmis tel quel', async () => {
    const erreur = new ErreurDeuxFacteurs('totp', ['totp'], false);
    const code = await preparerCodeDeuxFacteurs(erreur, ' 123456 ', hacher);
    assert.deepEqual(code, { methode: 'totp', code: '123456' });
  });

  test("pour la méthode `password`, c'est le SHA-256 qui part, pas le clair", async () => {
    const erreur = new ErreurDeuxFacteurs('password', [], false);
    const code = await preparerCodeDeuxFacteurs(erreur, 'mon-mot-de-passe', hacher);
    assert.equal(code.methode, 'password');
    assert.equal(code.code, await hacher('mon-mot-de-passe'));
    assert.notEqual(code.code, 'mon-mot-de-passe');
    assert.match(code.code, /^[0-9a-f]{64}$/);
  });

  test('le rejeu avec le code envoie les en-têtes 2FA', async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    await seConnecter(
      new ClientRest(base),
      { utilisateur: 'alice', motDePasse: 's' },
      { code: '123456', methode: 'totp' },
    );
    assert.equal(recues[0].enTetes['x-2fa-code'], '123456');
    assert.equal(recues[0].enTetes['x-2fa-method'], 'totp');
  });

  test('reprendreSession envoie `resume`, pas de mot de passe', async () => {
    poignee = (_q, res) => json(res, 200, SUCCES_LOGIN);
    const s = await reprendreSession(new ClientRest(base), 'jeton-stocke');
    assert.deepEqual(recues[0].corps, { resume: 'jeton-stocke' });
    assert.equal(s.userId, 'u1');
  });

  test('une réponse de login sans jeton est rejetée proprement', async () => {
    poignee = (_q, res) => json(res, 200, { status: 'success', data: { me: {} } });
    await assert.rejects(
      seConnecter(new ClientRest(base), { utilisateur: 'a', motDePasse: 'b' }),
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
      seConnecter(new ClientRest(base), { utilisateur: 'a', motDePasse: 'b' }),
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
    c.identifiants = { authToken: 'x', userId: 'y' };
    await seDeconnecter(c); // ne doit pas lever
    assert.equal(c.identifiants, null, 'un jeton déjà invalide ne doit pas rester en mémoire');
  });

  test('appliquerSession branche les identifiants sur le client', () => {
    const c = new ClientRest(base);
    appliquerSession(c, { baseUrl: base, authToken: 't', userId: 'u', username: 'alice' });
    assert.deepEqual(c.identifiants, { authToken: 't', userId: 'u' });
  });
});
