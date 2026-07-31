import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  codesEmojiCustom,
  definirEmojisCustom,
  filtrerAliases,
  indexer,
  normaliserEntree,
  surChangementEmojisCustom,
  synchroniserEmojisCustom,
  urlEmojiCustom,
  viderEmojisCustom,
  type DepotEmojis,
  type EmojiCustom,
} from './emojisCustom.ts';

function depotFactice(initial: EmojiCustom[] = []): DepotEmojis & { contenu: EmojiCustom[] } {
  const d = {
    contenu: initial,
    async remplacer(e: EmojiCustom[]) {
      d.contenu = e;
    },
    async lister() {
      return d.contenu;
    },
  };
  return d;
}

const PARROT: EmojiCustom = { nom: 'party_parrot', extension: 'gif', aliases: ['parrot', 'fete'] };
const SHIP: EmojiCustom = { nom: 'shipit', extension: 'png', aliases: [] };

describe('indexer', () => {
  test('déplie le nom canonique ET chaque alias vers le même fichier', () => {
    const i = indexer([PARROT]);
    assert.deepEqual(i.get('party_parrot'), { nom: 'party_parrot', extension: 'gif' });
    assert.deepEqual(i.get('parrot'), { nom: 'party_parrot', extension: 'gif' });
    assert.deepEqual(i.get('fete'), { nom: 'party_parrot', extension: 'gif' });
  });

  test('un nom canonique gagne sur un alias homonyme, QUEL QUE SOIT l’ordre', () => {
    // `shipit` est le NOM de SHIP et un ALIAS fictif de PARROT. Les deux passes
    // (noms d'abord) garantissent que le nom l'emporte même si l'alias, donc
    // l'autre entrée, apparaît en PREMIER — ce que first-write-wins ratait.
    const parrotAliasShipit: EmojiCustom = { ...PARROT, aliases: ['shipit'] };
    assert.equal(indexer([SHIP, parrotAliasShipit]).get('shipit')?.nom, 'shipit');
    assert.equal(indexer([parrotAliasShipit, SHIP]).get('shipit')?.nom, 'shipit');
  });

  test('ignore une entrée sans nom ou sans extension', () => {
    const i = indexer([{ nom: 'ok', extension: 'png', aliases: [] }, { extension: 'png' } as never]);
    assert.equal(i.size, 1);
    assert.equal(i.get('ok')?.nom, 'ok');
  });
});

describe('filtrerAliases', () => {
  test('ne garde que les chaînes ; tout le reste devient []', () => {
    assert.deepEqual(filtrerAliases(['a', 1, null, 'b', {}]), ['a', 'b']);
    assert.deepEqual(filtrerAliases(undefined), []);
    assert.deepEqual(filtrerAliases('pas un tableau'), []);
  });
});

describe('urlEmojiCustom', () => {
  afterEach(viderEmojisCustom);

  test('construit l’URL depuis le NOM canonique, même pour un alias', () => {
    definirEmojisCustom('https://chat.exemple.fr', [PARROT]);
    // L'alias `:parrot:` doit pointer sur party_parrot.gif, pas parrot.gif
    // (qui renverrait le SVG de secours du serveur).
    assert.equal(urlEmojiCustom('parrot'), 'https://chat.exemple.fr/emoji-custom/party_parrot.gif');
    assert.equal(urlEmojiCustom('party_parrot'), 'https://chat.exemple.fr/emoji-custom/party_parrot.gif');
  });

  test('normalise le slash final de la baseUrl', () => {
    definirEmojisCustom('https://chat.exemple.fr/', [SHIP]);
    assert.equal(urlEmojiCustom('shipit'), 'https://chat.exemple.fr/emoji-custom/shipit.png');
  });

  test('un code court inconnu, ou un membre du prototype, vaut null', () => {
    definirEmojisCustom('https://chat.exemple.fr', [PARROT]);
    assert.equal(urlEmojiCustom('inexistant'), null);
    assert.equal(urlEmojiCustom('constructor'), null);
    assert.equal(urlEmojiCustom('__proto__'), null);
  });

  test('après vidage, plus rien ne résout — l’index de l’ancien serveur ne fuit pas', () => {
    definirEmojisCustom('https://a.fr', [PARROT]);
    viderEmojisCustom();
    assert.equal(urlEmojiCustom('party_parrot'), null);
  });
});

describe('surChangementEmojisCustom', () => {
  afterEach(viderEmojisCustom);

  test('notifie à chaque pose ou vidage d’index, et l’instantané change d’identité', () => {
    // Le contrat `useSyncExternalStore` du navigateur d'emojis : sans cette
    // notification, le panneau — qui ne se démonte JAMAIS — garderait la liste
    // vide de la première installation pour toute la session.
    let notifications = 0;
    const desabonner = surChangementEmojisCustom(() => notifications++);
    const avant = codesEmojiCustom();
    definirEmojisCustom('https://chat.exemple.fr', [PARROT]);
    assert.equal(notifications, 1);
    const apres = codesEmojiCustom();
    assert.notEqual(avant, apres);
    assert.ok(apres.includes('party_parrot'));
    viderEmojisCustom();
    assert.equal(notifications, 2);
    desabonner();
  });

  test('l’instantané est STABLE entre deux changements (exigence useSyncExternalStore)', () => {
    definirEmojisCustom('https://chat.exemple.fr', [PARROT]);
    assert.equal(codesEmojiCustom(), codesEmojiCustom());
  });

  test('le désabonnement tient', () => {
    let notifications = 0;
    surChangementEmojisCustom(() => notifications++)();
    definirEmojisCustom('https://chat.exemple.fr', [SHIP]);
    assert.equal(notifications, 0);
  });
});

describe('synchroniserEmojisCustom', () => {
  afterEach(viderEmojisCustom);

  test('remplit la table et l’index depuis une liste serveur', async () => {
    const depot = depotFactice();
    const client = {
      baseUrl: 'https://chat.exemple.fr',
      get: async <T>(): Promise<T> =>
        ({ emojis: { update: [{ name: 'dino', extension: 'gif', aliases: ['trex'] }] } }) as T,
    };
    await synchroniserEmojisCustom(client, depot);
    assert.equal(depot.contenu.length, 1);
    assert.equal(urlEmojiCustom('trex'), 'https://chat.exemple.fr/emoji-custom/dino.gif');
  });

  test('un appel raté (pas d’`update`) NE vide PAS le cache — la clé du bug count=0', async () => {
    const depot = depotFactice([{ nom: 'dino', extension: 'gif', aliases: [] }]);
    // Le serveur a répondu `success:false` : ni `emojis`, ni `update`.
    const client = {
      baseUrl: 'https://chat.exemple.fr',
      get: async <T>(): Promise<T> => ({ success: false }) as T,
    };
    await synchroniserEmojisCustom(client, depot);
    assert.deepEqual(depot.contenu.map((e) => e.nom), ['dino'], 'le cache offline survit');
  });

  test('un fetch résolu APRÈS abandon ne réarme pas l’index (fuite cross-serveur)', async () => {
    const depot = depotFactice();
    const clientA = {
      baseUrl: 'https://serveur-a.fr',
      get: async <T>(): Promise<T> =>
        ({ emojis: { update: [{ name: 'propre_a_A', extension: 'png', aliases: [] }] } }) as T,
    };
    // La session A est déjà tournée quand la réponse arrive.
    await synchroniserEmojisCustom(clientA, depot, () => true);
    // La base (de A) est écrite — inoffensif —, mais l'index mémoire GLOBAL,
    // lui, ne doit pas se remplir des emojis de A après le passage à B.
    assert.equal(urlEmojiCustom('propre_a_A'), null);
  });
});

describe('normaliserEntree', () => {
  test('accepte une entrée serveur bien formée', () => {
    assert.deepEqual(normaliserEntree({ name: 'dino', extension: 'gif', aliases: ['trex'] }), {
      nom: 'dino',
      extension: 'gif',
      aliases: ['trex'],
    });
  });

  test('aliases absent ou non-tableau devient []', () => {
    assert.deepEqual(normaliserEntree({ name: 'dino', extension: 'gif' })?.aliases, []);
    assert.deepEqual(normaliserEntree({ name: 'dino', extension: 'gif', aliases: 'x' })?.aliases, []);
  });

  test('rejette une entrée sans name ou extension', () => {
    assert.equal(normaliserEntree({ extension: 'gif' }), null);
    assert.equal(normaliserEntree({ name: 'dino' }), null);
    assert.equal(normaliserEntree(null), null);
  });
});
