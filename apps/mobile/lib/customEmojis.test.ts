import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  codesEmojiCustom,
  setCustomEmojis,
  filterAliases,
  buildIndex,
  normalizeEntry,
  onCustomEmojisChange,
  syncCustomEmojis,
  urlEmojiCustom,
  clearCustomEmojis,
  type EmojiStore,
  type EmojiCustom,
} from './customEmojis.ts';

function depotFactice(initial: EmojiCustom[] = []): EmojiStore & { content: EmojiCustom[] } {
  const d = {
    content: initial,
    async replace(e: EmojiCustom[]) {
      d.content = e;
    },
    async list() {
      return d.content;
    },
  };
  return d;
}

const PARROT: EmojiCustom = { name: 'party_parrot', extension: 'gif', aliases: ['parrot', 'fete'] };
const SHIP: EmojiCustom = { name: 'shipit', extension: 'png', aliases: [] };

describe('indexer', () => {
  test('déplie le nom canonique ET chaque alias vers le même fichier', () => {
    const i = buildIndex([PARROT]);
    assert.deepEqual(i.get('party_parrot'), { name: 'party_parrot', extension: 'gif' });
    assert.deepEqual(i.get('parrot'), { name: 'party_parrot', extension: 'gif' });
    assert.deepEqual(i.get('fete'), { name: 'party_parrot', extension: 'gif' });
  });

  test('un nom canonique gagne sur un alias homonyme, QUEL QUE SOIT l’ordre', () => {
    // `shipit` est le NOM de SHIP et un ALIAS fictif de PARROT. Les deux passes
    // (noms d'abord) garantissent que le nom l'emporte même si l'alias, donc
    // l'autre entrée, apparaît en PREMIER — ce que first-write-wins ratait.
    const parrotAliasShipit: EmojiCustom = { ...PARROT, aliases: ['shipit'] };
    assert.equal(buildIndex([SHIP, parrotAliasShipit]).get('shipit')?.name, 'shipit');
    assert.equal(buildIndex([parrotAliasShipit, SHIP]).get('shipit')?.name, 'shipit');
  });

  test('ignore une entrée sans nom ou sans extension', () => {
    const i = buildIndex([{ name: 'ok', extension: 'png', aliases: [] }, { extension: 'png' } as never]);
    assert.equal(i.size, 1);
    assert.equal(i.get('ok')?.name, 'ok');
  });
});

describe('filtrerAliases', () => {
  test('ne garde que les chaînes ; tout le reste devient []', () => {
    assert.deepEqual(filterAliases(['a', 1, null, 'b', {}]), ['a', 'b']);
    assert.deepEqual(filterAliases(undefined), []);
    assert.deepEqual(filterAliases('pas un tableau'), []);
  });
});

describe('urlEmojiCustom', () => {
  afterEach(clearCustomEmojis);

  test('construit l’URL depuis le NOM canonique, même pour un alias', () => {
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    // L'alias `:parrot:` doit pointer sur party_parrot.gif, pas parrot.gif
    // (qui renverrait le SVG de secours du serveur).
    assert.equal(urlEmojiCustom('parrot'), 'https://chat.exemple.fr/emoji-custom/party_parrot.gif');
    assert.equal(urlEmojiCustom('party_parrot'), 'https://chat.exemple.fr/emoji-custom/party_parrot.gif');
  });

  test('normalise le slash final de la baseUrl', () => {
    setCustomEmojis('https://chat.exemple.fr/', [SHIP]);
    assert.equal(urlEmojiCustom('shipit'), 'https://chat.exemple.fr/emoji-custom/shipit.png');
  });

  test('un code court inconnu, ou un membre du prototype, vaut null', () => {
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    assert.equal(urlEmojiCustom('inexistant'), null);
    assert.equal(urlEmojiCustom('constructor'), null);
    assert.equal(urlEmojiCustom('__proto__'), null);
  });

  test('après vidage, plus rien ne résout — l’index de l’ancien serveur ne fuit pas', () => {
    setCustomEmojis('https://a.fr', [PARROT]);
    clearCustomEmojis();
    assert.equal(urlEmojiCustom('party_parrot'), null);
  });
});

describe('surChangementEmojisCustom', () => {
  afterEach(clearCustomEmojis);

  test('notifie à chaque pose ou vidage d’index, et l’instantané change d’identité', () => {
    // Le contrat `useSyncExternalStore` du navigateur d'emojis : sans cette
    // notification, le panneau — qui ne se démonte JAMAIS — garderait la liste
    // vide de la première installation pour toute la session.
    let notifications = 0;
    const desabonner = onCustomEmojisChange(() => notifications++);
    const avant = codesEmojiCustom();
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    assert.equal(notifications, 1);
    const apres = codesEmojiCustom();
    assert.notEqual(avant, apres);
    assert.ok(apres.includes('party_parrot'));
    clearCustomEmojis();
    assert.equal(notifications, 2);
    desabonner();
  });

  test('l’instantané est STABLE entre deux changements (exigence useSyncExternalStore)', () => {
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    assert.equal(codesEmojiCustom(), codesEmojiCustom());
  });

  test('le désabonnement tient', () => {
    let notifications = 0;
    onCustomEmojisChange(() => notifications++)();
    setCustomEmojis('https://chat.exemple.fr', [SHIP]);
    assert.equal(notifications, 0);
  });
});

describe('synchroniserEmojisCustom', () => {
  afterEach(clearCustomEmojis);

  test('remplit la table et l’index depuis une liste serveur', async () => {
    const depot = depotFactice();
    const client = {
      baseUrl: 'https://chat.exemple.fr',
      get: async <T>(): Promise<T> =>
        ({ emojis: { update: [{ name: 'dino', extension: 'gif', aliases: ['trex'] }] } }) as T,
    };
    await syncCustomEmojis(client, depot);
    assert.equal(depot.content.length, 1);
    assert.equal(urlEmojiCustom('trex'), 'https://chat.exemple.fr/emoji-custom/dino.gif');
  });

  test('un appel raté (pas d’`update`) NE vide PAS le cache — la clé du bug count=0', async () => {
    const depot = depotFactice([{ name: 'dino', extension: 'gif', aliases: [] }]);
    // Le serveur a répondu `success:false` : ni `emojis`, ni `update`.
    const client = {
      baseUrl: 'https://chat.exemple.fr',
      get: async <T>(): Promise<T> => ({ success: false }) as T,
    };
    await syncCustomEmojis(client, depot);
    assert.deepEqual(depot.content.map((e) => e.name), ['dino'], 'le cache offline survit');
  });

  test('un fetch résolu APRÈS abandon ne réarme pas l’index (fuite cross-serveur)', async () => {
    const depot = depotFactice();
    const clientA = {
      baseUrl: 'https://serveur-a.fr',
      get: async <T>(): Promise<T> =>
        ({ emojis: { update: [{ name: 'propre_a_A', extension: 'png', aliases: [] }] } }) as T,
    };
    // La session A est déjà tournée quand la réponse arrive.
    await syncCustomEmojis(clientA, depot, () => true);
    // La base (de A) est écrite — inoffensif —, mais l'index mémoire GLOBAL,
    // lui, ne doit pas se remplir des emojis de A après le passage à B.
    assert.equal(urlEmojiCustom('propre_a_A'), null);
  });
});

describe('normaliserEntree', () => {
  test('accepte une entrée serveur bien formée', () => {
    assert.deepEqual(normalizeEntry({ name: 'dino', extension: 'gif', aliases: ['trex'] }), {
      name: 'dino',
      extension: 'gif',
      aliases: ['trex'],
    });
  });

  test('aliases absent ou non-tableau devient []', () => {
    assert.deepEqual(normalizeEntry({ name: 'dino', extension: 'gif' })?.aliases, []);
    assert.deepEqual(normalizeEntry({ name: 'dino', extension: 'gif', aliases: 'x' })?.aliases, []);
  });

  test('rejette une entrée sans name ou extension', () => {
    assert.equal(normalizeEntry({ extension: 'gif' }), null);
    assert.equal(normalizeEntry({ name: 'dino' }), null);
    assert.equal(normalizeEntry(null), null);
  });
});
