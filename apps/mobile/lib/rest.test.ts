import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { ClientRest, TwoFactorError, RestError, isTokenRejected } from './rest.ts';

type Handle = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let handle: Handle;
/** Requêtes reçues, pour vérifier les en-têtes réellement envoyés. */
let received: { url: string; method: string; headers: Record<string, string | string[] | undefined> }[] = [];

before(async () => {
  server = createServer((req, res) => {
    received.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
    handle(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('adresse inattendue');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => server.close());

// Sans cela, `recues[0]` pointerait sur la requête d'un autre test dès qu'on en
// ajoute un avant, et l'échec serait incompréhensible.
beforeEach(() => {
  received = [];
});

function reply(res: ServerResponse, status: number, body: unknown, headers: object = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Client dont le sommeil est instantané, l'horloge figée et la dispersion
 * nulle — les délais restent donc des nombres exacts, et c'est le test dédié
 * ci-dessous qui éprouve la dispersion.
 */
function client(sleeps: number[] = []) {
  return new ClientRest(base, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1_000_000,
    random: () => 0,
  });
}

describe('ClientRest', () => {
  test('un GET réussi renvoie le JSON', async () => {
    handle = (_q, res) => reply(res, 200, { success: true, version: '8.5' });
    const r = await client().get<{ version: string }>('info');
    assert.equal(r.version, '8.5');
    assert.equal(received[0].url, '/api/v1/info');
  });

  test('les paramètres de requête sont encodés, `undefined` est omis', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    await client().get('channels.history', {
      params: { roomId: 'a b&c', count: 100, absent: undefined },
    });
    assert.equal(received[0].url, '/api/v1/channels.history?roomId=a+b%26c&count=100');
  });

  test("les en-têtes d'authentification sont envoyés, sauf en anonyme", async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    const c = client();
    c.auth = { authToken: 'jeton', userId: 'moi' };

    await c.get('me');
    assert.equal(received[0].headers['x-auth-token'], 'jeton');
    assert.equal(received[0].headers['x-user-id'], 'moi');

    await c.post('login', { anonymous: true, body: {} });
    assert.equal(received[1].headers['x-auth-token'], undefined);
  });

  test('les en-têtes 2FA sont envoyés quand un code est fourni', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    await client().post('settings/Push_enable', {
      body: { value: true },
      twoFactor: { code: 'abcdef', method: 'password' },
    });
    assert.equal(received[0].headers['x-2fa-code'], 'abcdef');
    assert.equal(received[0].headers['x-2fa-method'], 'password');
  });

  test('`totp-required` lève une ErreurDeuxFacteurs, même quand la méthode est `password`', async () => {
    handle = (_q, res) =>
      reply(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'password', availableMethods: [], codeGenerated: false },
      });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof TwoFactorError);
      assert.equal(e.method, 'password');
      assert.deepEqual(e.availableMethods, []);
      assert.equal(e.generatedCode, false);
      return true;
    });
  });

  test('la forme 2FA de /login (`error`, sans `errorType`) est reconnue', async () => {
    // Relevé tel quel sur un serveur 8.5 : /api/v1/login ne pose PAS errorType.
    handle = (_q, res) =>
      reply(res, 401, {
        success: false,
        error: 'totp-required',
        status: 'error',
        message: 'TOTP Required',
        details: { method: 'email', availableMethods: ['email'], codeGenerated: false },
      });
    await assert.rejects(client().post('login', { anonymous: true }), (e: unknown) => {
      assert.ok(e instanceof TwoFactorError, 'doit être une ErreurDeuxFacteurs, pas ErreurRest');
      assert.equal(e.method, 'email');
      assert.deepEqual(e.availableMethods, ['email']);
      return true;
    });
  });

  test('une méthode 2FA inconnue retombe sur `password` sans planter', async () => {
    handle = (_q, res) =>
      reply(res, 401, {
        success: false,
        errorType: 'totp-required',
        details: { method: 'sms-du-futur', availableMethods: ['totp', 'martien'] },
      });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof TwoFactorError);
      assert.equal(e.method, 'password');
      assert.deepEqual(e.availableMethods, ['totp']);
      return true;
    });
  });

  test('un 401 ordinaire lève une ErreurRest portant le statut', async () => {
    handle = (_q, res) => reply(res, 401, { success: false, error: 'unauthorized' });
    await assert.rejects(client().get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 401);
      assert.equal(e.error, 'unauthorized');
      return true;
    });
  });

  test("`status: 'error'` de /login est traité comme un échec malgré le code 200", async () => {
    handle = (_q, res) => reply(res, 200, { status: 'error', message: 'Unauthorized' });
    await assert.rejects(client().post('login', { anonymous: true }), RestError);
  });

  test('un 429 est rejoué en honorant `x-ratelimit-reset`', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    handle = (_q, res) => {
      calls++;
      if (calls <= 2) {
        // maintenant() est figé à 1_000_000 : reset dans 2 s.
        reply(res, 429, { success: false }, { 'x-ratelimit-reset': '1002000' });
      } else {
        reply(res, 200, { success: true, ok: 1 });
      }
    };
    const r = await client(sleeps).get<{ ok: number }>('chat.postMessage');
    assert.equal(r.ok, 1);
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2250, 2250], 'délai = reset - maintenant + 250 ms');
  });

  test('sans en-tête de réinitialisation, le repli est exponentiel', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    handle = (_q, res) => {
      calls++;
      calls <= 2 ? reply(res, 429, { success: false }) : reply(res, 200, { success: true });
    };
    await client(sleeps).get('chat.postMessage');
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('après 3 rejeux, le 429 remonte comme erreur', async () => {
    const sleeps: number[] = [];
    handle = (_q, res) => reply(res, 429, { success: false, error: 'too-many' });
    await assert.rejects(client(sleeps).get('chat.postMessage'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 429);
      return true;
    });
    assert.equal(sleeps.length, 3);
  });

  test('un corps HTML avec un code 200 ne devient pas « serveur injoignable »', async () => {
    handle = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>502 Bad Gateway</html>');
    };
    await assert.rejects(client().get('info'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.match(e.message, /non JSON/);
      return true;
    });
  });

  test('un 200 au corps vide est un succès, pas un « JSON invalide »', async () => {
    // `POST /api/v1/logout` se comporte exactement ainsi sur un serveur 8.5.
    handle = (_q, res) => {
      res.writeHead(200);
      res.end();
    };
    assert.deepEqual(await client().post('logout'), {});
  });

  test('un corps vide avec un code 4xx reste une erreur', async () => {
    handle = (_q, res) => {
      res.writeHead(502);
      res.end();
    };
    await assert.rejects(client().get('info'), RestError);
  });

  test("une annulation par l'appelant propage AbortError, pas une ErreurRest", async () => {
    handle = () => {
      /* jamais de réponse */
    };
    const controller = new AbortController();
    const p = client().get('info', { signal: controller.signal });
    controller.abort();
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
  });

  test('un signal déjà avorté empêche la requête de partir', async () => {
    handle = (_q, res) => reply(res, 200, { success: true });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(client().get('info', { signal: controller.signal }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.equal(received.length, 0, 'aucune requête ne doit atteindre le serveur');
  });

  test('rejeuReseau : un échec réseau ponctuel est rejoué une fois puis réussit', async () => {
    // Reproduit la connexion keep-alive morte au 1er envoi : le `fetch` rejette
    // une fois (aucune réponse HTTP), le rejeu repart sur le vrai serveur.
    handle = (_q, res) => reply(res, 200, { success: true, ok: 1 });
    let calls = 0;
    const sleeps: number[] = [];
    const c = new ClientRest(base, {
      fetch: async (url, init) => {
        calls += 1;
        if (calls === 1) throw new TypeError('Network request failed');
        return globalThis.fetch(url, init);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000,
    });
    const r = await c.post<{ ok: number }>('users.updateOwnBasicInfo', {
      body: { data: {} },
      networkReplay: true,
    });
    assert.equal(r.ok, 1);
    assert.equal(calls, 2, 'un échec puis un rejeu');
    assert.equal(sleeps.length, 1, 'une seule attente de rejeu');
  });

  test('rejeuReseau : deux échecs de suite remontent « serveur injoignable »', async () => {
    let calls = 0;
    const c = new ClientRest(base, {
      fetch: async () => {
        calls += 1;
        throw new TypeError('Network request failed');
      },
      sleep: async () => {},
      now: () => 1_000_000,
    });
    await assert.rejects(c.post('users.setStatus', { body: {}, networkReplay: true }), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 0);
      assert.match(e.message, /injoignable/);
      return true;
    });
    assert.equal(calls, 2, "l'appel d'origine plus un seul rejeu");
  });

  test('sans rejeuReseau, un échec réseau lève tout de suite (aucun rejeu)', async () => {
    // `chat.sendMessage` n'active pas le rejeu : la ligne reste « en-attente »
    // dans lib/outbox, seul lieu où sa déduplication est sûre.
    let calls = 0;
    const c = new ClientRest(base, {
      fetch: async () => {
        calls += 1;
        throw new TypeError('Network request failed');
      },
      sleep: async () => {},
      now: () => 1_000_000,
    });
    await assert.rejects(c.post('chat.sendMessage', { body: {} }), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 0);
      return true;
    });
    assert.equal(calls, 1, 'aucun rejeu sans le drapeau');
  });

  test('le rejeu 429 est DISPERSÉ, et la dispersion reste bornée', async () => {
    // Deux appels concurrents reçoivent le MÊME `x-ratelimit-reset` : sans
    // dispersion ils repartent à la même milliseconde sur une fenêtre qui
    // n'en admet que dix, et se reprennent un 429.
    const measure = async (random: number) => {
      const sleeps: number[] = [];
      let calls = 0;
      handle = (_q, res) => {
        calls++;
        if (calls === 1) {
          reply(res, 429, { success: false }, { 'x-ratelimit-reset': '1002000' });
        } else {
          reply(res, 200, { success: true });
        }
      };
      const c = new ClientRest(base, {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        now: () => 1_000_000,
        random: () => random,
      });
      await c.get('chat.postMessage');
      return sleeps[0];
    };

    const [bottom, middle, top] = [await measure(0), await measure(0.5), await measure(1)];
    assert.ok(bottom < middle && middle < top, `l’aléa doit moduler : ${bottom}/${middle}/${top}`);
    // Encadrement : jamais AVANT le reset annoncé, jamais plus d'une
    // demi-seconde après — sinon la dispersion coûterait plus qu'elle ne rend.
    for (const d of [bottom, middle, top]) {
      assert.ok(d >= 2250 && d <= 2750, `hors bornes : ${d}`);
    }
  });

  test('un en-tête de réinitialisation aberrant reste plafonné, dispersion comprise', async () => {
    const sleeps: number[] = [];
    handle = (_q, res) =>
      reply(res, 429, { success: false }, { 'x-ratelimit-reset': '9999999999999' });
    const c = new ClientRest(base, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_000_000,
      random: () => 1,
    });
    await assert.rejects(c.get('chat.postMessage'), RestError);
    assert.deepEqual(sleeps, [30_000, 30_000, 30_000], 'le plafond tient malgré la dispersion');
  });

  test('un abort() PENDANT le sommeil de rejeu est constaté TOUT DE SUITE', async () => {
    // Le `finally` d'`appeler` retire l'écouteur d'annulation avant de dormir :
    // l'abandon n'était vu qu'au retour de récursion, jusqu'à 30 s plus tard.
    // Ici le sommeil ne se termine JAMAIS de lui-même — seule l'annulation
    // peut débloquer, donc le test ne peut pas passer par accident.
    handle = (_q, res) =>
      reply(res, 429, { success: false }, { 'x-ratelimit-reset': '1030000' });
    let sleepsNow: () => void = () => {};
    const sleepStarted = new Promise<void>((r) => {
      sleepsNow = r;
    });
    const c = new ClientRest(base, {
      sleep: () =>
        new Promise<void>(() => {
          sleepsNow();
        }),
      now: () => 1_000_000,
      random: () => 0,
    });

    const controller = new AbortController();
    const p = c.get('chat.postMessage', { signal: controller.signal });
    await sleepStarted; // on SAIT qu'on dort — pas de délai arbitraire
    controller.abort();

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
    let naps = 0;
    const controller = new AbortController();
    const c = new ClientRest(base, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              controller.abort();
            },
          }),
          { status: 429, headers: { 'x-ratelimit-reset': '1030000' } },
        ),
      sleep: async () => {
        naps++;
      },
      now: () => 1_000_000,
      random: () => 0,
    });

    await assert.rejects(c.get('chat.postMessage', { signal: controller.signal }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
    assert.equal(naps, 0, 'aucun sommeil entamé : 30 s économisées');
  });

  test('la barre finale de baseUrl est normalisée', () => {
    assert.equal(new ClientRest('http://x:3000///').baseUrl, 'http://x:3000');
  });
});

/**
 * Le prédicat qui autorise une déconnexion automatique. Écrit et éprouvé AVANT
 * d'être branché : c'est le seul garde-fou contre le vrai danger de ce
 * chantier — éjecter un utilisateur dont la session est parfaitement valide.
 *
 * Les valeurs de statut ci-dessous ne sont pas choisies : elles sont celles
 * relevées contre un Rocket.Chat 8.5 (banc local, 30/07/2026).
 */
describe('estJetonRefuse', () => {
  /** Ce que `ClientRest` construit quand il a LU l'enveloppe Rocket.Chat. */
  const fromServer = (status: number, error?: string, errorType?: string) =>
    new RestError(error ?? 'x', status, error, errorType, true);

  test('un 401 du serveur applicatif est un jeton refusé', () => {
    // Le corps exact d'un jeton révoqué par `logout`, relevé sur 8.5.
    assert.equal(isTokenRejected(fromServer(401, 'You must be logged in to do this.')), true);
  });

  test('un défi 2FA n’est PAS un jeton refusé', () => {
    // `ErreurDeuxFacteurs` se DÉCLARE 401 quel que soit le statut HTTP réel —
    // et sur 8.5 une opération sensible en cours de session (users.update)
    // répond 400. Sans cette exclusion, changer son mot de passe déconnectait.
    assert.equal(isTokenRejected(new TwoFactorError('password', ['password'], false)), false);
  });

  test('un échec réseau (statut 0) n’est PAS un jeton refusé', () => {
    // C'est la moitié du chantier : hors ligne n'est pas révoqué. Un client
    // mobile passe sa vie sans réseau ; jeter la session pour ça serait pire
    // que l'état zombie qu'on corrige.
    assert.equal(isTokenRejected(new RestError('serveur injoignable.', 0)), false);
  });

  test('une erreur d’un autre transport (DDP) n’est PAS un jeton refusé', () => {
    class DdpError extends Error {}
    assert.equal(isTokenRejected(new DdpError('Message refusé')), false);
    assert.equal(isTokenRejected(new Error('boum')), false);
    assert.equal(isTokenRejected('401'), false);
    assert.equal(isTokenRejected(null), false);
    assert.equal(isTokenRejected(undefined), false);
  });

  test('un 401 dont le corps n’est PAS du Rocket.Chat est ignoré', () => {
    // Le proxy d'entreprise, le portail captif, le ballast de maintenance :
    // ils répondent 401 en HTML. `ClientRest` lève alors sans `reponseComprise`
    // (branche « réponse non JSON »), et ce statut est le LEUR.
    assert.equal(isTokenRejected(new RestError('réponse non JSON (401, 812 octets).', 401)), false);
  });

  test('les refus que 8.5 rend AUTREMENT qu’en 401 sont ignorés', () => {
    // Relevés un par un sur le banc. Chacun survient en session parfaitement
    // valide, et chacun aurait éjecté l'utilisateur si on s'était contenté de
    // « le serveur a dit non ».
    assert.equal(isTokenRejected(fromServer(403, 'User does not have the permissions required for this action [error-unauthorized]')), false);
    assert.equal(isTokenRejected(fromServer(400, 'Not allowed [error-not-allowed]', 'error-not-allowed')), false);
    assert.equal(isTokenRejected(fromServer(400, 'does not match any channel [error-room-not-found]', 'error-room-not-found')), false);
    assert.equal(isTokenRejected(fromServer(404, 'Not Found')), false);
    assert.equal(isTokenRejected(fromServer(429, 'too many requests')), false);
    assert.equal(isTokenRejected(fromServer(500, 'boum')), false);
  });
});

describe('ClientRest — signalement du jeton refusé', () => {
  test('un 401 du serveur signale le jeton RÉELLEMENT envoyé', async () => {
    handle = (_req, res) =>
      reply(res, 401, {
        success: false,
        error: 'You must be logged in to do this.',
        status: 'error',
        message: 'You must be logged in to do this.',
      });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    const reported: string[] = [];
    c.onTokenRejected = (j) => reported.push(j);

    await assert.rejects(c.get('chat.syncMessages'));
    assert.deepEqual(reported, ['jeton-a']);
  });

  test('le jeton signalé est celui du DÉPART, pas celui de l’arrivée', async () => {
    // La course réelle : déconnexion puis reconnexion pendant que la requête
    // volait. Signaler le jeton courant ferait effacer la session TOUTE NEUVE.
    const c = client();
    c.auth = { authToken: 'ancien', userId: 'u1' };
    handle = (_req, res) => {
      c.auth = { authToken: 'tout-neuf', userId: 'u1' };
      reply(res, 401, { success: false, error: 'You must be logged in to do this.' });
    };
    const reported: string[] = [];
    c.onTokenRejected = (j) => reported.push(j);

    await assert.rejects(c.get('me'));
    assert.deepEqual(reported, ['ancien'], 'l’appelant doit pouvoir reconnaître un 401 périmé');
  });

  test('un appel ANONYME ne signale rien : il n’a pas envoyé de jeton', async () => {
    // `settings.public`, `/api/info`, le login lui-même. Leur 401 ne dit rien
    // de la session — et au login il n'y en a même pas encore.
    handle = (_req, res) => reply(res, 401, { success: false, error: 'unauthorized' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.get('settings.public', { anonymous: true }));
    assert.equal(reported, 0);
  });

  test('un défi 2FA en cours de session ne signale rien', async () => {
    // Sondé sur 8.5 : `users.update` sans code répond **400** `totp-required`.
    handle = (_req, res) =>
      reply(res, 400, {
        success: false,
        error: 'TOTP Required [totp-required]',
        errorType: 'totp-required',
        details: { method: 'password', codeGenerated: false, availableMethods: [] },
      });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.post('users.update'), (e: unknown) => e instanceof TwoFactorError);
    assert.equal(reported, 0, 'changer son mot de passe ne doit pas déconnecter');
  });

  test('un 401 JSON qui n’est PAS du Rocket.Chat ne signale rien', async () => {
    // Une passerelle d'API répond volontiers `{"message":"Unauthorized"}` :
    // ça parse, donc « on a lu du JSON » ne prouve rien. Ce qu'il faut, c'est
    // la marque de l'enveloppe maison — `success`, `status`, `errorType`.
    handle = (_req, res) => reply(res, 401, { message: 'Unauthorized' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.understoodResponse, false);
      return true;
    });
    assert.equal(reported, 0);
  });

  test('un 401 de LOGIN porte bien l’enveloppe — mais l’appel est anonyme', async () => {
    // Sondé sur 8.5 : un mauvais mot de passe rend
    // `{"success":false,"error":"Unauthorized","status":"error"}` en 401. C'est
    // une enveloppe Rocket.Chat parfaitement valide : seule la garde `anonyme`
    // empêche une saisie ratée de détruire la session en cours.
    handle = (_req, res) =>
      reply(res, 401, { success: false, error: 'Unauthorized', status: 'error' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.post('login', { anonymous: true, body: { user: 'x', password: 'y' } }));
    assert.equal(reported, 0);
  });

  test('un 401 en HTML (proxy) ne signale rien', async () => {
    handle = (_req, res) => {
      res.writeHead(401, { 'content-type': 'text/html' });
      res.end('<html><body>401 Authorization Required</body></html>');
    };
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    await assert.rejects(c.get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 401, 'le statut du proxy est bien conservé…');
      assert.equal(e.understoodResponse, false, '…mais il ne vient pas du serveur applicatif');
      return true;
    });
    assert.equal(reported, 0);
  });

  test('une session saine ne signale jamais rien', async () => {
    // Les trois refus légitimes de 8.5, joués contre un vrai serveur HTTP.
    const cases = [
      [403, { success: false, error: 'User does not have the permissions required for this action [error-unauthorized]' }],
      [400, { success: false, error: 'Not allowed [error-not-allowed]', errorType: 'error-not-allowed' }],
      [500, { success: false, error: 'boum' }],
    ] as const;
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    let reported = 0;
    c.onTokenRejected = () => reported++;

    for (const [status, body] of cases) {
      handle = (_req, res) => reply(res, status, body);
      await assert.rejects(c.get('quelque.chose'));
    }
    assert.equal(reported, 0);
  });

  test('sans abonné, un 401 reste une erreur ordinaire', async () => {
    handle = (_req, res) => reply(res, 401, { success: false, error: 'You must be logged in to do this.' });
    const c = client();
    c.auth = { authToken: 'jeton-a', userId: 'u1' };
    await assert.rejects(c.get('me'), (e: unknown) => {
      assert.ok(e instanceof RestError);
      assert.equal(e.status, 401);
      return true;
    });
  });
});
