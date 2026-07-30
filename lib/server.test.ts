/**
 * Premiers tests de `lib/server.ts`, qui n'en avait AUCUN — c'est pourtant le
 * seul module que l'écran de connexion traverse avant d'afficher quoi que ce
 * soit, donc le seul dont une panne se lit comme « l'app ne démarre pas ».
 *
 * Le `fetch` est injecté (même seam que `ClientRest`) et les minuteries sont
 * simulées : la borne de 15 s s'éprouve sans attendre 15 s.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { ErreurRest } from './rest.ts';
import { ErreurServeur, normaliserUrl, sonderServeur } from './server.ts';

const REGLAGES = {
  settings: [
    { _id: 'Site_Url', value: 'https://chat.exemple.fr/' },
    { _id: 'Accounts_ShowFormLogin', value: true },
    { _id: 'Accounts_TwoFactorAuthentication_Enabled', value: true },
    { _id: 'Accounts_TwoFactorAuthentication_By_TOTP_Enabled', value: true },
    { _id: 'Accounts_TwoFactorAuthentication_By_Email_Enabled', value: false },
    { _id: 'LDAP_Enable', value: false },
    { _id: 'Accounts_OAuth_Github', value: true },
    { _id: 'Accounts_OAuth_Gitlab', value: false },
    { _id: 'E2E_Enable', value: true },
    { _id: 'FileUpload_ProtectFiles', value: true },
    { _id: 'Accounts_AvatarBlockUnauthenticatedAccess', value: true },
    { _id: 'Sans_valeur', value: null },
  ],
  success: true,
};

const json = (corps: unknown, statut = 200) =>
  new Response(JSON.stringify(corps), {
    status: statut,
    headers: { 'Content-Type': 'application/json' },
  });

/** Répond selon l'URL demandée, et note les URL réellement construites. */
function transport(reponses: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  return {
    urls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      void init;
      return reponses(u);
    }) as unknown as typeof globalThis.fetch,
  };
}

describe('normaliserUrl', () => {
  test('sans schéma, https est supposé', () => {
    assert.equal(normaliserUrl('chat.exemple.fr'), 'https://chat.exemple.fr');
  });

  test('le SOUS-CHEMIN est conservé — un Rocket.Chat derrière proxy vit sous /chat', () => {
    // `new URL(…).origin` le supprimerait, et toutes les requêtes viseraient
    // la racine du proxy : 404 partout, sans indice.
    assert.equal(normaliserUrl('https://exemple.fr/chat/'), 'https://exemple.fr/chat');
    assert.equal(normaliserUrl('https://exemple.fr/chat///'), 'https://exemple.fr/chat');
  });

  test('http explicite et port sont respectés', () => {
    assert.equal(normaliserUrl('http://192.168.1.106:3000'), 'http://192.168.1.106:3000');
  });

  test('les espaces autour sont ignorés', () => {
    assert.equal(normaliserUrl('  chat.exemple.fr  '), 'https://chat.exemple.fr');
  });

  test('vide et invalide lèvent ErreurServeur, pas une TypeError brute', () => {
    assert.throws(() => normaliserUrl('   '), ErreurServeur);
    assert.throws(() => normaliserUrl('https://'), ErreurServeur);
  });
});

describe('sonderServeur', () => {
  test('/api/info est demandé à la RACINE, settings.public sous /api/v1/', async () => {
    // La régression que `horsApiV1` pourrait introduire : `/api/v1/api/info`,
    // qui répond 404 — donc « serveur injoignable » sur un serveur sain.
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5', success: true }) : json(REGLAGES),
    );
    const profil = await sonderServeur('https://chat.exemple.fr', undefined, t);

    assert.equal(profil.version, '8.5');
    assert.ok(
      t.urls.includes('https://chat.exemple.fr/api/info'),
      `URL attendue absente : ${t.urls.join(' ')}`,
    );
    assert.ok(t.urls.some((u) => u.startsWith('https://chat.exemple.fr/api/v1/settings.public?')));
  });

  test('le sous-chemin du proxy est porté par les DEUX appels', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json(REGLAGES),
    );
    await sonderServeur('https://exemple.fr/chat', undefined, t);
    assert.ok(t.urls.every((u) => u.startsWith('https://exemple.fr/chat/')), t.urls.join(' '));
  });

  test('le profil est extrait des réglages publics', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json(REGLAGES),
    );
    const p = await sonderServeur('https://chat.exemple.fr', undefined, t);

    assert.equal(p.baseUrl, 'https://chat.exemple.fr');
    assert.equal(p.siteUrl, 'https://chat.exemple.fr/');
    assert.equal(p.formulaireDeConnexion, true);
    assert.deepEqual(p.deuxFacteurs, { actif: true, totp: true, email: false });
    assert.equal(p.ldap, false);
    assert.deepEqual(p.oauth, ['Github'], 'seuls les fournisseurs à true');
    assert.equal(p.e2eeActif, true);
    assert.equal(p.fichiersProteges, true);
    assert.equal(p.avatarsProteges, true);
  });

  test('un réglage absent vaut faux, jamais undefined', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json({ settings: [], success: true }),
    );
    const p = await sonderServeur('https://x', undefined, t);
    assert.equal(p.e2eeActif, false);
    assert.equal(p.siteUrl, null);
    assert.deepEqual(p.oauth, []);
  });

  test('une réponse /api/info sans version : « ne ressemble pas à un Rocket.Chat »', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ hello: 'world' }) : json(REGLAGES),
    );
    await assert.rejects(sonderServeur('https://x', undefined, t), (e: unknown) => {
      assert.ok(e instanceof ErreurServeur);
      assert.match(e.message, /ne ressemble pas/);
      return true;
    });
  });

  test('du HTML avec un code 200 sur /api/info devient une erreur lisible', async () => {
    // Un portail captif répond volontiers une page de connexion en 200.
    const t = transport((u) =>
      u.endsWith('/api/info')
        ? new Response('<html>Connectez-vous au Wi-Fi</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })
        : json(REGLAGES),
    );
    await assert.rejects(sonderServeur('https://x', undefined, t), (e: unknown) => {
      assert.ok(e instanceof ErreurServeur);
      assert.match(e.message, /non JSON/);
      assert.ok(e.origine instanceof ErreurRest, 'la cause est conservée');
      return true;
    });
  });

  test('settings.public en 404 remonte une ErreurServeur, pas un plantage', async () => {
    const t = transport((u) =>
      u.endsWith('/api/info') ? json({ version: '8.5' }) : json({ success: false }, 404),
    );
    await assert.rejects(sonderServeur('https://x', undefined, t), ErreurServeur);
  });

  test("un signal déjà avorté par l'appelant ressort en AbortError", async () => {
    const t = transport(() => json({ version: '8.5' }));
    const controleur = new AbortController();
    controleur.abort();
    await assert.rejects(sonderServeur('https://x', controleur.signal, t), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal(e.name, 'AbortError');
      return true;
    });
  });

  test('un /api/info PENDANT ne bloque plus l’écran de connexion à vie', async () => {
    // LE défaut du chantier 8. `/api/info` partait sur un `fetch` nu, sans
    // délai maximal : si `settings.public` réussissait et que `/api/info`
    // restait pendante (reverse proxy, portail captif), le `Promise.all` de
    // `sonderServeur` pendait pour toujours. Le `finally` d'app/connexion.tsx
    // ne s'exécutait pas, son garde `enVol` restait armé, et un second appui
    // ressortait dessus SANS jamais atteindre l'`abort()` : écran mort, muet,
    // jusqu'au redémarrage de l'app.
    //
    // Minuteries simulées : c'est la borne de 15 s de `ClientRest` qu'on
    // éprouve, pas la patience de la suite de tests.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // Ce `fetch` ne répond JAMAIS de lui-même : il ne rejette que si son
      // signal tombe, exactement comme le vrai. La seule chose qui puisse
      // débloquer, c'est donc la minuterie de `ClientRest`.
      const fetchMuet = (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).endsWith('/api/info')) return json(REGLAGES);
        return new Promise<Response>((_, rejeter) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.');
            e.name = 'AbortError';
            rejeter(e);
          });
        });
      }) as unknown as typeof globalThis.fetch;

      const p = sonderServeur('https://x', undefined, { fetch: fetchMuet });
      let etat = 'pendante';
      void p.then(
        () => (etat = 'résolue'),
        () => (etat = 'rejetée'),
      );

      mock.timers.tick(14_999);
      await Promise.resolve();
      assert.equal(etat, 'pendante', 'on ne coupe pas avant la borne');

      mock.timers.tick(2);
      await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof ErreurServeur);
        assert.match(e.message, /pas de réponse en 15 s/);
        return true;
      });
    } finally {
      mock.timers.reset();
    }
  });
});
