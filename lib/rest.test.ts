import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { ClientRest, ErreurDeuxFacteurs, ErreurRest } from './rest.ts';

type Poignee = (req: IncomingMessage, res: ServerResponse) => void;

let serveur: Server;
let base: string;
let poignee: Poignee;
/** Requêtes reçues, pour vérifier les en-têtes réellement envoyés. */
let recues: { url: string; methode: string; enTetes: Record<string, string | string[] | undefined> }[] = [];

before(async () => {
  serveur = createServer((req, res) => {
    recues.push({ url: req.url ?? '', methode: req.method ?? '', enTetes: req.headers });
    poignee(req, res);
  });
  await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
  const adresse = serveur.address();
  if (typeof adresse === 'string' || adresse === null) throw new Error('adresse inattendue');
  base = `http://127.0.0.1:${adresse.port}`;
});

after(() => serveur.close());

// Sans cela, `recues[0]` pointerait sur la requête d'un autre test dès qu'on en
// ajoute un avant, et l'échec serait incompréhensible.
beforeEach(() => {
  recues = [];
});

function repondre(res: ServerResponse, statut: number, corps: unknown, enTetes: object = {}) {
  res.writeHead(statut, { 'content-type': 'application/json', ...enTetes });
  res.end(typeof corps === 'string' ? corps : JSON.stringify(corps));
}

/** Client dont le sommeil est instantané et l'horloge figée. */
function client(dormirs: number[] = []) {
  return new ClientRest(base, {
    dormir: async (ms) => {
      dormirs.push(ms);
    },
    maintenant: () => 1_000_000,
  });
}

describe('ClientRest', () => {
  test('un GET réussi renvoie le JSON', async () => {
    poignee = (_q, res) => repondre(res, 200, { success: true, version: '8.5' });
    const r = await client().get<{ version: string }>('info');
    assert.equal(r.version, '8.5');
    assert.equal(recues[0].url, '/api/v1/info');
  });

  test('les paramètres de requête sont encodés, `undefined` est omis', async () => {
    poignee = (_q, res) => repondre(res, 200, { success: true });
    await client().get('channels.history', {
      params: { roomId: 'a b&c', count: 100, absent: undefined },
    });
    assert.equal(recues[0].url, '/api/v1/channels.history?roomId=a+b%26c&count=100');
  });

  test("les en-têtes d'authentification sont envoyés, sauf en anonyme", async () => {
    poignee = (_q, res) => repondre(res, 200, { success: true });
    const c = client();
    c.identifiants = { authToken: 'jeton', userId: 'moi' };

    await c.get('me');
    assert.equal(recues[0].enTetes['x-auth-token'], 'jeton');
    assert.equal(recues[0].enTetes['x-user-id'], 'moi');

    await c.post('login', { anonyme: true, corps: {} });
    assert.equal(recues[1].enTetes['x-auth-token'], undefined);
  });

  test('les en-têtes 2FA sont envoyés quand un code est fourni', async () => {
    poignee = (_q, res) => repondre(res, 200, { success: true });
    await client().post('settings/Push_enable', {
      corps: { value: true },
      deuxFacteurs: { code: 'abcdef', methode: 'password' },
    });
    assert.equal(recues[0].enTetes['x-2fa-code'], 'abcdef');
    assert.equal(recues[0].enTetes['x-2fa-method'], 'password');
  });

  test('`totp-required` lève une ErreurDeuxFacteurs, même quand la méthode est `password`', async () => {
    poignee = (_q, res) =>
      repondre(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'password', availableMethods: [], codeGenerated: false },
      });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof ErreurDeuxFacteurs);
      assert.equal(e.methode, 'password');
      assert.deepEqual(e.methodesDisponibles, []);
      assert.equal(e.codeGenere, false);
      return true;
    });
  });

  test('la forme 2FA de /login (`error`, sans `errorType`) est reconnue', async () => {
    // Relevé tel quel sur un serveur 8.5 : /api/v1/login ne pose PAS errorType.
    poignee = (_q, res) =>
      repondre(res, 401, {
        success: false,
        error: 'totp-required',
        status: 'error',
        message: 'TOTP Required',
        details: { method: 'email', availableMethods: ['email'], codeGenerated: false },
      });
    await assert.rejects(client().post('login', { anonyme: true }), (e: unknown) => {
      assert.ok(e instanceof ErreurDeuxFacteurs, 'doit être une ErreurDeuxFacteurs, pas ErreurRest');
      assert.equal(e.methode, 'email');
      assert.deepEqual(e.methodesDisponibles, ['email']);
      return true;
    });
  });

  test('une méthode 2FA inconnue retombe sur `password` sans planter', async () => {
    poignee = (_q, res) =>
      repondre(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'sms-du-futur', availableMethods: ['totp', 'martien'] },
      });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof ErreurDeuxFacteurs);
      assert.equal(e.methode, 'password');
      assert.deepEqual(e.methodesDisponibles, ['totp']);
      return true;
    });
  });

  test('un 401 ordinaire lève une ErreurRest portant le statut', async () => {
    poignee = (_q, res) => repondre(res, 401, { success: false, error: 'unauthorized' });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof ErreurRest);
      assert.equal(e.statut, 401);
      assert.equal(e.erreur, 'unauthorized');
      return true;
    });
  });

  test("`status: 'error'` de /login est traité comme un échec malgré le code 200", async () => {
    poignee = (_q, res) => repondre(res, 200, { status: 'error', message: 'Unauthorized' });
    await assert.rejects(client().post('login', { anonyme: true }), ErreurRest);
  });

  test('un 429 est rejoué en honorant `x-ratelimit-reset`', async () => {
    const dormirs: number[] = [];
    let appels = 0;
    poignee = (_q, res) => {
      appels++;
      if (appels <= 2) {
        // maintenant() est figé à 1_000_000 : reset dans 2 s.
        repondre(res, 429, { success: false }, { 'x-ratelimit-reset': '1002000' });
      } else {
        repondre(res, 200, { success: true, ok: 1 });
      }
    };
    const r = await client(dormirs).get<{ ok: number }>('chat.postMessage');
    assert.equal(r.ok, 1);
    assert.equal(appels, 3);
    assert.deepEqual(dormirs, [2250, 2250], 'délai = reset - maintenant + 250 ms');
  });

  test('sans en-tête de réinitialisation, le repli est exponentiel', async () => {
    const dormirs: number[] = [];
    let appels = 0;
    poignee = (_q, res) => {
      appels++;
      appels <= 2 ? repondre(res, 429, { success: false }) : repondre(res, 200, { success: true });
    };
    await client(dormirs).get('chat.postMessage');
    assert.deepEqual(dormirs, [1000, 2000]);
  });

  test('après 3 rejeux, le 429 remonte comme erreur', async () => {
    const dormirs: number[] = [];
    poignee = (_q, res) => repondre(res, 429, { success: false, error: 'too-many' });
    await assert.rejects(client(dormirs).get('chat.postMessage'), (e: unknown) => {
      assert.ok(e instanceof ErreurRest);
      assert.equal(e.statut, 429);
      return true;
    });
    assert.equal(dormirs.length, 3);
  });

  test('un corps HTML avec un code 200 ne devient pas « serveur injoignable »', async () => {
    poignee = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
    };
    await assert.rejects(client().get('info'), (e: unknown) => {
      assert.ok(e instanceof ErreurRest);
      assert.match(e.message, /non JSON/);
      return true;
    });
  });

  test('un 200 au corps vide est un succès, pas un « JSON invalide »', async () => {
    // `POST /api/v1/logout` se comporte exactement ainsi sur un serveur 8.5.
    poignee = (_q, res) => {
      res.writeHead(200);
      res.end();
    };
    assert.deepEqual(await client().post('logout'), {});
  });

  test('un corps vide avec un code 4xx reste une erreur', async () => {
    poignee = (_q, res) => {
      res.writeHead(502);
      res.end();
    };
    await assert.rejects(client().get('info'), ErreurRest);
  });

  test("une annulation par l'appelant propage AbortError, pas une ErreurRest", async () => {
    poignee = () => {
      /* jamais de réponse */
    };
    const controleur = new AbortController();
    const p = client().get('info', { signal: controleur.signal });
    controleur.abort();
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
  });

  test('un signal déjà avorté empêche la requête de partir', async () => {
    poignee = (_q, res) => repondre(res, 200, { success: true });
    const controleur = new AbortController();
    controleur.abort();
    await assert.rejects(client().get('info', { signal: controleur.signal }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.equal(recues.length, 0, 'aucune requête ne doit atteindre le serveur');
  });

  test('la barre finale de baseUrl est normalisée', () => {
    assert.equal(new ClientRest('http://x:3000///').baseUrl, 'http://x:3000');
  });
});
