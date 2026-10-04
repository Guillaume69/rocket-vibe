import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  customEmojiCodes,
  setCustomEmojis,
  filterAliases,
  buildIndex,
  normalizeEntry,
  onCustomEmojisChange,
  syncCustomEmojis,
  customEmojiUrl,
  clearCustomEmojis,
  type EmojiStore,
  type CustomEmoji,
} from './customEmojis.ts';

function fakeStore(initial: CustomEmoji[] = []): EmojiStore & { content: CustomEmoji[] } {
  const d = {
    content: initial,
    async replace(e: CustomEmoji[]) {
      d.content = e;
    },
    async list() {
      return d.content;
    },
  };
  return d;
}

const PARROT: CustomEmoji = { name: 'party_parrot', extension: 'gif', aliases: ['parrot', 'fete'] };
const SHIP: CustomEmoji = { name: 'shipit', extension: 'png', aliases: [] };

describe('buildIndex', () => {
  test('unfolds the canonical name AND each alias to the same file', () => {
    const i = buildIndex([PARROT]);
    assert.deepEqual(i.get('party_parrot'), { name: 'party_parrot', extension: 'gif' });
    assert.deepEqual(i.get('parrot'), { name: 'party_parrot', extension: 'gif' });
    assert.deepEqual(i.get('fete'), { name: 'party_parrot', extension: 'gif' });
  });

  test('a canonical name wins over an alias of the same name, WHATEVER the order', () => {
    // `shipit` is SHIP's NAME and a made-up ALIAS of PARROT. The two passes
    // (names first) guarantee the name wins even if the alias, hence the other
    // entry, comes FIRST, which first-write-wins got wrong.
    const parrotAliasShipit: CustomEmoji = { ...PARROT, aliases: ['shipit'] };
    assert.equal(buildIndex([SHIP, parrotAliasShipit]).get('shipit')?.name, 'shipit');
    assert.equal(buildIndex([parrotAliasShipit, SHIP]).get('shipit')?.name, 'shipit');
  });

  test('ignores an entry without a name or extension', () => {
    const i = buildIndex([{ name: 'ok', extension: 'png', aliases: [] }, { extension: 'png' } as never]);
    assert.equal(i.size, 1);
    assert.equal(i.get('ok')?.name, 'ok');
  });
});

describe('filterAliases', () => {
  test('keeps only strings; anything else becomes []', () => {
    assert.deepEqual(filterAliases(['a', 1, null, 'b', {}]), ['a', 'b']);
    assert.deepEqual(filterAliases(undefined), []);
    assert.deepEqual(filterAliases('pas un tableau'), []);
  });
});

describe('customEmojiUrl', () => {
  afterEach(clearCustomEmojis);

  test('builds the URL from the canonical NAME, even for an alias', () => {
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    // The `:parrot:` alias must point to party_parrot.gif, not parrot.gif
    // (which would return the server's fallback SVG).
    assert.equal(customEmojiUrl('parrot'), 'https://chat.exemple.fr/emoji-custom/party_parrot.gif');
    assert.equal(customEmojiUrl('party_parrot'), 'https://chat.exemple.fr/emoji-custom/party_parrot.gif');
  });

  test('normalizes the baseUrl trailing slash', () => {
    setCustomEmojis('https://chat.exemple.fr/', [SHIP]);
    assert.equal(customEmojiUrl('shipit'), 'https://chat.exemple.fr/emoji-custom/shipit.png');
  });

  test('an unknown shortcode, or a prototype member, is null', () => {
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    assert.equal(customEmojiUrl('inexistant'), null);
    assert.equal(customEmojiUrl('constructor'), null);
    assert.equal(customEmojiUrl('__proto__'), null);
  });

  test('after clearing, nothing resolves: the previous server index does not leak', () => {
    setCustomEmojis('https://a.fr', [PARROT]);
    clearCustomEmojis();
    assert.equal(customEmojiUrl('party_parrot'), null);
  });
});

describe('onCustomEmojisChange', () => {
  afterEach(clearCustomEmojis);

  test('notifies on each index set or clear, and the snapshot changes identity', () => {
    // The emoji picker's `useSyncExternalStore` contract: without this
    // notification the panel, which NEVER unmounts, would keep the first
    // install's empty list for the whole session.
    let notifications = 0;
    const unsubscribe = onCustomEmojisChange(() => notifications++);
    const before = customEmojiCodes();
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    assert.equal(notifications, 1);
    const after = customEmojiCodes();
    assert.notEqual(before, after);
    assert.ok(after.includes('party_parrot'));
    clearCustomEmojis();
    assert.equal(notifications, 2);
    unsubscribe();
  });

  test('the snapshot is STABLE between two changes (useSyncExternalStore requirement)', () => {
    setCustomEmojis('https://chat.exemple.fr', [PARROT]);
    assert.equal(customEmojiCodes(), customEmojiCodes());
  });

  test('unsubscribing holds', () => {
    let notifications = 0;
    onCustomEmojisChange(() => notifications++)();
    setCustomEmojis('https://chat.exemple.fr', [SHIP]);
    assert.equal(notifications, 0);
  });
});

describe('syncCustomEmojis', () => {
  afterEach(clearCustomEmojis);

  test('fills the table and the index from a server list', async () => {
    const store = fakeStore();
    const client = {
      baseUrl: 'https://chat.exemple.fr',
      get: async <T>(): Promise<T> =>
        ({ emojis: { update: [{ name: 'dino', extension: 'gif', aliases: ['trex'] }] } }) as T,
    };
    await syncCustomEmojis(client, store);
    assert.equal(store.content.length, 1);
    assert.equal(customEmojiUrl('trex'), 'https://chat.exemple.fr/emoji-custom/dino.gif');
  });

  test('a failed call (no `update`) does NOT empty the cache, the key to the count=0 bug', async () => {
    const store = fakeStore([{ name: 'dino', extension: 'gif', aliases: [] }]);
    // The server answered `success:false`: no `emojis`, no `update`.
    const client = {
      baseUrl: 'https://chat.exemple.fr',
      get: async <T>(): Promise<T> => ({ success: false }) as T,
    };
    await syncCustomEmojis(client, store);
    assert.deepEqual(store.content.map((e) => e.name), ['dino'], 'the offline cache survives');
  });

  test('a fetch resolved AFTER discard does not re-arm the index (cross-server leak)', async () => {
    const store = fakeStore();
    const clientA = {
      baseUrl: 'https://serveur-a.fr',
      get: async <T>(): Promise<T> =>
        ({ emojis: { update: [{ name: 'propre_a_A', extension: 'png', aliases: [] }] } }) as T,
    };
    // Session A is already over when the response arrives.
    await syncCustomEmojis(clientA, store, () => true);
    // A's database is written (harmless), but the GLOBAL in-memory index must
    // not fill with A's emojis after the switch to B.
    assert.equal(customEmojiUrl('propre_a_A'), null);
  });
});

describe('normalizeEntry', () => {
  test('accepts a well-formed server entry', () => {
    assert.deepEqual(normalizeEntry({ name: 'dino', extension: 'gif', aliases: ['trex'] }), {
      name: 'dino',
      extension: 'gif',
      aliases: ['trex'],
    });
  });

  test('missing or non-array aliases becomes []', () => {
    assert.deepEqual(normalizeEntry({ name: 'dino', extension: 'gif' })?.aliases, []);
    assert.deepEqual(normalizeEntry({ name: 'dino', extension: 'gif', aliases: 'x' })?.aliases, []);
  });

  test('rejects an entry without name or extension', () => {
    assert.equal(normalizeEntry({ extension: 'gif' }), null);
    assert.equal(normalizeEntry({ name: 'dino' }), null);
    assert.equal(normalizeEntry(null), null);
  });
});
