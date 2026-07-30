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

/**
 * Client dont le sommeil est instantané, l'horloge figée et la dispersion
 * nulle — les délais restent donc des nombres exacts, et c'est le test dédié
 * ci-dessous qui éprouve la dispersion.
 */
function client(dormirs: number[] = []) {
  return new ClientRest(base, {
    dormir: async (ms) => {
      dormirs.push(ms);
    },
    maintenant: () => 1_000_000,
    alea: () => 0,
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

  test('rejeuReseau : un échec réseau ponctuel est rejoué une fois puis réussit', async () => {
    // Reproduit la connexion keep-alive morte au 1er envoi : le `fetch` rejette
    // une fois (aucune réponse HTTP), le rejeu repart sur le vrai serveur.
    poignee = (_q, res) => repondre(res, 200, { success: true, ok: 1 });
    let appels = 0;
    const dormirs: number[] = [];
    const c = new ClientRest(base, {
      fetch: async (url, init) => {
        appels += 1;
        if (appels === 1) throw new TypeError('Network request failed');
        return globalThis.fetch(url, init);
      },
      dormir: async (ms) => {
        dormirs.push(ms);
      },
      maintenant: () => 1_000_000,
    });
    const r = await c.post<{ ok: number }>('users.updateOwnBasicInfo', {
      corps: { data: {} },
      rejeuReseau: true,
    });
    assert.equal(r.ok, 1);
    assert.equal(appels, 2, 'un échec puis un rejeu');
    assert.equal(dormirs.length, 1, 'une seule attente de rejeu');
  });

  test('rejeuReseau : deux échecs de suite remontent « serveur injoignable »', async () => {
    let appels = 0;
    const c = new ClientRest(base, {
      fetch: async () => {
        appels += 1;
        throw new TypeError('Network request failed');
      },
      dormir: async () => {},
      maintenant: () => 1_000_000,
    });
    await assert.rejects(c.post('users.setStatus', { corps: {}, rejeuReseau: true }), (e: unknown) => {
      assert.ok(e instanceof ErreurRest);
      assert.equal(e.statut, 0);
      assert.match(e.message, /injoignable/);
      return true;
    });
    assert.equal(appels, 2, "l'appel d'origine plus un seul rejeu");
  });

  test('sans rejeuReseau, un échec réseau lève tout de suite (aucun rejeu)', async () => {
    // `chat.sendMessage` n'active pas le rejeu : la ligne reste « en-attente »
    // dans lib/envoi, seul lieu où sa déduplication est sûre.
    let appels = 0;
    const c = new ClientRest(base, {
      fetch: async () => {
        appels += 1;
        throw new TypeError('Network request failed');
      },
      dormir: async () => {},
      maintenant: () => 1_000_000,
    });
    await assert.rejects(c.post('chat.sendMessage', { corps: {} }), (e: unknown) => {
      assert.ok(e instanceof ErreurRest);
      assert.equal(e.statut, 0);
      return true;
    });
    assert.equal(appels, 1, 'aucun rejeu sans le drapeau');
  });

  test('le rejeu 429 est DISPERSÉ, et la dispersion reste bornée', async () => {
    // Deux appels concurrents reçoivent le MÊME `x-ratelimit-reset` : sans
    // dispersion ils repartent à la même milliseconde sur une fenêtre qui
    // n'en admet que dix, et se reprennent un 429.
    const releve = async (alea: number) => {
      const dormirs: number[] = [];
      let appels = 0;
      poignee = (_q, res) => {
        appels++;
        if (appels === 1) {
          repondre(res, 429, { success: false }, { 'x-ratelimit-reset': '1002000' });
        } else {
          repondre(res, 200, { success: true });
        }
      };
      const c = new ClientRest(base, {
        dormir: async (ms) => {
          dormirs.push(ms);
        },
        maintenant: () => 1_000_000,
        alea: () => alea,
      });
      await c.get('chat.postMessage');
      return dormirs[0];
    };

    const [bas, milieu, haut] = [await releve(0), await releve(0.5), await releve(1)];
    assert.ok(bas < milieu && milieu < haut, `l’aléa doit moduler : ${bas}/${milieu}/${haut}`);
    // Encadrement : jamais AVANT le reset annoncé, jamais plus d'une
    // demi-seconde après — sinon la dispersion coûterait plus qu'elle ne rend.
    for (const d of [bas, milieu, haut]) {
      assert.ok(d >= 2250 && d <= 2750, `hors bornes : ${d}`);
    }
  });

  test('un en-tête de réinitialisation aberrant reste plafonné, dispersion comprise', async () => {
    const dormirs: number[] = [];
    poignee = (_q, res) =>
      repondre(res, 429, { success: false }, { 'x-ratelimit-reset': '9999999999999' });
    const c = new ClientRest(base, {
      dormir: async (ms) => {
        dormirs.push(ms);
      },
      maintenant: () => 1_000_000,
      alea: () => 1,
    });
    await assert.rejects(c.get('chat.postMessage'), ErreurRest);
    assert.deepEqual(dormirs, [30_000, 30_000, 30_000], 'le plafond tient malgré la dispersion');
  });

  test('un abort() PENDANT le sommeil de rejeu est constaté TOUT DE SUITE', async () => {
    // Le `finally` d'`appeler` retire l'écouteur d'annulation avant de dormir :
    // l'abandon n'était vu qu'au retour de récursion, jusqu'à 30 s plus tard.
    // Ici le sommeil ne se termine JAMAIS de lui-même — seule l'annulation
    // peut débloquer, donc le test ne peut pas passer par accident.
    poignee = (_q, res) =>
      repondre(res, 429, { success: false }, { 'x-ratelimit-reset': '1030000' });
    let dortMaintenant: () => void = () => {};
    const sommeilEntame = new Promise<void>((r) => {
      dortMaintenant = r;
    });
    const c = new ClientRest(base, {
      dormir: () =>
        new Promise<void>(() => {
          dortMaintenant();
        }),
      maintenant: () => 1_000_000,
      alea: () => 0,
    });

    const controleur = new AbortController();
    const p = c.get('chat.postMessage', { signal: controleur.signal });
    await sommeilEntame; // on SAIT qu'on dort — pas de délai arbitraire
    controleur.abort();

    // Le chien de garde n'est PAS une synchronisation : le chemin correct
    // répond immédiatement. Il est là pour que la régression se lise comme un
    // échec, et non comme une suite de tests qui pend pour toujours.
    const verdict = await Promise.race([
      p.then(
        () => 'résolue',
        (e: unknown) => (e instanceof Error && e.name === 'AbortError' ? 'annulée' : 'autre'),
      ),
      new Promise((r) => setTimeout(() => r('pendante'), 250)),
    ]);
    assert.equal(verdict, 'annulée', "l'annulation doit être vue PENDANT le sommeil");
  });

  test('un signal avorté juste AVANT le sommeil ne le laisse pas commencer', async () => {
    // `addEventListener('abort')` sur un signal DÉJÀ avorté ne se déclenche
    // jamais : sans le test en tête de `dormirAnnulable`, on dormirait le
    // délai complet et l'abandon ne serait vu qu'au retour de récursion.
    //
    // La fenêtre est étroite mais réelle : `appeler` retire son relais dans
    // son `finally`, puis `await reponse.body?.cancel()` rend la main. On
    // avorte exactement là, en fournissant nous-mêmes le corps de la réponse.
    let dodos = 0;
    const controleur = new AbortController();
    const c = new ClientRest(base, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              controleur.abort();
            },
          }),
          { status: 429, headers: { 'x-ratelimit-reset': '1030000' } },
        ),
      dormir: async () => {
        dodos++;
      },
      maintenant: () => 1_000_000,
      alea: () => 0,
    });

    await assert.rejects(c.get('chat.postMessage', { signal: controleur.signal }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.equal(dodos, 0, 'aucun sommeil entamé : 30 s économisées');
  });

  test('la barre finale de baseUrl est normalisée', () => {
    assert.equal(new ClientRest('http://x:3000///').baseUrl, 'http://x:3000');
  });
});
