import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  actionsPossibles,
  messageGoneFromServer,
  rulesFromSettings,
  textToCopy,
} from './messageActions.ts';
import { RestError } from './rest.ts';

const rules = {
  editAllowed: true,
  editBlockMinutes: 5,
  deleteAllowed: true,
  deleteBlockMinutes: 0,
  pinAllowed: true,
  starAllowed: true,
};

const base = {
  message: {
    authorId: 'moi',
    ts: 1_000_000,
    systemType: null,
    text: 'coucou',
    attachments: null as string | null,
    pinned: false,
    starred: false,
  },
  me: 'moi',
  rules,
  permissions: null as string[] | null,
  readOnly: false,
  encrypted: false,
  inThread: false,
  now: 1_000_000 + 60_000, // one minute later
};

describe('actionsPossibles', () => {
  test('my recent message: everything allowed', () => {
    assert.deepEqual(actionsPossibles(base), [
      'react',
      'reply',
      'replyInThread',
      'copy',
      'share',
      'edit',
      'delete',
      'pin',
      'star',
    ]);
  });

  test('the edit TIME LIMIT comes from settings, not permissions', () => {
    // 6 minutes later, with BlockEditInMinutes = 5: no more editing, but
    // deleting (limit 0 = unlimited) stays.
    const late = { ...base, now: base.message.ts + 6 * 60_000 };
    assert.deepEqual(actionsPossibles(late), ['react', 'reply', 'replyInThread', 'copy', 'share', 'delete', 'pin', 'star']);
  });

  test('`bypass-time-limit-edit-and-delete` reopens editing after the limit', () => {
    const admin = {
      ...base,
      now: base.message.ts + 6 * 60_000,
      permissions: ['bypass-time-limit-edit-and-delete'],
    };
    assert.ok(actionsPossibles(admin).includes('edit'));
  });

  test('`edit-message` allows editing SOMEONE ELSE’s message', () => {
    const moderator = {
      ...base,
      message: { ...base.message, authorId: 'lui' },
      permissions: ['edit-message'],
    };
    assert.ok(actionsPossibles(moderator).includes('edit'));
  });

  test('SOMEONE ELSE’s message can be neither edited nor deleted (without permission)', () => {
    const others = { ...base, message: { ...base.message, authorId: 'lui' } };
    assert.deepEqual(actionsPossibles(others), ['react', 'reply', 'replyInThread', 'copy', 'share', 'pin', 'star']);
  });

  test('read-only: no reaction or reply; system message: nothing at all', () => {
    const readOnly = actionsPossibles({ ...base, readOnly: true });
    assert.ok(!readOnly.includes('react'));
    assert.ok(!readOnly.includes('reply'));
    assert.ok(!readOnly.includes('replyInThread'));
    assert.deepEqual(
      actionsPossibles({ ...base, message: { ...base.message, systemType: 'uj' } }),
      [],
    );
  });

  // These three cases replace a test that passed `encrypted: true` with
  // `systemType: null`, a combination that does NOT exist in the database: a
  // message of an encrypted room always carries the `e2e` marker, which
  // `db/upserts.ts` does not remove on decryption. The test thus claimed
  // "react stays" while the early return on `systemType !== null` returned an
  // empty array.
  test('encrypted room, DECRYPTED message: everything except quote-reply', () => {
    const readable = actionsPossibles({
      ...base,
      encrypted: true,
      message: { ...base.message, systemType: 'e2e', text: 'clair' },
    });
    assert.deepEqual(readable, ['react', 'replyInThread', 'copy', 'share', 'edit', 'delete', 'pin', 'star']);
    // The quote card is built by the server from the text, which it cannot
    // read in an encrypted room.
    assert.ok(!readable.includes('reply'));
  });

  test('encrypted room, STILL OPAQUE message: no action', () => {
    assert.deepEqual(
      actionsPossibles({
        ...base,
        encrypted: true,
        message: { ...base.message, systemType: 'e2e', text: null },
      }),
      [],
    );
  });

  test('a real system message stays closed, even with a text', () => {
    assert.deepEqual(
      actionsPossibles({
        ...base,
        message: { ...base.message, systemType: 'uj', text: 'a rejoint le salon' },
      }),
      [],
    );
  });

  test('from a thread screen: reply, but not open a thread', () => {
    const actions = actionsPossibles({ ...base, inThread: true });
    assert.ok(actions.includes('reply'));
    assert.ok(!actions.includes('replyInThread'));
  });

  test('read-only: copy and share stay', () => {
    const readOnly = actionsPossibles({ ...base, readOnly: true });
    assert.ok(readOnly.includes('copy'));
    assert.ok(readOnly.includes('share'));
  });

  test('image without caption: share and save the file, but nothing to copy', () => {
    const image = JSON.stringify([
      { title: 'photo.jpg', title_link: '/file-upload/f1/photo.jpg', image_url: '/file-upload/t1/photo.jpg' },
    ]);
    const actions = actionsPossibles({
      ...base,
      message: { ...base.message, text: '', attachments: image },
    });
    assert.ok(actions.includes('share'));
    assert.ok(actions.includes('save'));
    assert.ok(!actions.includes('copy'));
  });

  test('no text or file, or a quote without a word: neither copy nor share', () => {
    const link = '[ ](https://chat.example/channel/general?msg=abc)';
    for (const text of [null, '', '   ', link, `${link}  `]) {
      const actions = actionsPossibles({ ...base, message: { ...base.message, text } });
      assert.ok(!actions.includes('copy'), String(text));
      assert.ok(!actions.includes('share'), String(text));
    }
  });
});

describe('textToCopy', () => {
  test('strips the leading quote permalink', () => {
    assert.equal(
      textToCopy('[ ](https://chat.example/channel/general?msg=abc) oui, **ça** marche'),
      'oui, **ça** marche',
    );
  });

  test('nothing to take: null', () => {
    assert.equal(textToCopy(null), null);
    assert.equal(textToCopy('  '), null);
  });
});

describe('rulesFromSettings', () => {
  test('reads the settings and falls back to permissive when missing', () => {
    const r = rulesFromSettings([
      { _id: 'Message_AllowEditing', value: true },
      { _id: 'Message_AllowEditing_BlockEditInMinutes', value: 5 },
      { _id: 'Message_AllowDeleting', value: false },
    ]);
    assert.equal(r.editBlockMinutes, 5);
    assert.equal(r.deleteAllowed, false);
    assert.equal(r.pinAllowed, true, 'missing = allowed, the server will decide');
    assert.equal(r.starAllowed, true);
    assert.equal(
      rulesFromSettings([{ _id: 'Message_AllowStarring', value: false }]).starAllowed,
      false,
    );
  });
});

describe('actionsPossibles: permissions loaded', () => {
  const others = { ...base.message, authorId: 'lui' };

  test('plain member: own messages yes, no pinning', () => {
    const member = { ...base, permissions: ['delete-own-message'] };
    const actions = actionsPossibles(member);
    assert.ok(actions.includes('edit') && actions.includes('delete'));
    assert.ok(!actions.includes('pin'));
  });

  test('without delete-own-message, even one’s own message cannot be deleted', () => {
    assert.ok(!actionsPossibles({ ...base, permissions: [] }).includes('delete'));
  });

  test('moderator: edits, deletes and pins someone else’s message, within the limit', () => {
    const moderator = {
      ...base,
      message: others,
      permissions: ['edit-message', 'delete-message', 'pin-message'],
    };
    const actions = actionsPossibles(moderator);
    for (const x of ['edit', 'delete', 'pin'] as const) assert.ok(actions.includes(x), x);

    const late = actionsPossibles({ ...moderator, now: base.message.ts + 6 * 60_000 });
    assert.ok(!late.includes('edit'), 'the limit also applies to edit-message');
    assert.ok(late.includes('delete'), 'unlimited delete limit (0)');
  });

  test('force-delete-message deletes even past the limit and with deleting disabled', () => {
    const owner = {
      ...base,
      message: others,
      rules: { ...rules, deleteAllowed: false, deleteBlockMinutes: 1 },
      now: base.message.ts + 60 * 60_000,
      permissions: ['force-delete-message'],
    };
    assert.ok(actionsPossibles(owner).includes('delete'));
  });
});

describe('actionsPossibles: pin, star', () => {
  test('a pinned message offers Unpin, a message starred by me Remove from favorites', () => {
    const mark = { ...base, message: { ...base.message, pinned: true, starred: true } };
    const actions = actionsPossibles(mark);
    assert.ok(actions.includes('unpin') && !actions.includes('pin'));
    assert.ok(actions.includes('unstar') && !actions.includes('star'));
  });

  test('settings off: neither pin nor star', () => {
    const closed = {
      ...base,
      rules: { ...rules, pinAllowed: false, starAllowed: false },
    };
    const actions = actionsPossibles(closed);
    for (const a of ['pin', 'unpin', 'star', 'unstar'] as const) {
      assert.ok(!actions.includes(a), a);
    }
  });
});

describe('messageGoneFromServer', () => {
  const client = (get: () => Promise<unknown>) => ({ get });

  test('chat.getMessage answers: the message still exists, a real refusal', async () => {
    const c = client(() => Promise.resolve({ message: { _id: 'm1' } }));
    assert.equal(await messageGoneFromServer(c, 'm1'), false);
  });

  test('400: the server no longer knows this message, ghost confirmed', async () => {
    const c = client(() =>
      Promise.reject(new RestError('No message found with the id of "m1".', 400)),
    );
    assert.equal(await messageGoneFromServer(c, 'm1'), true);
  });

  test('status 0 (network) or 429 (rate limit): NOT concluded as gone', async () => {
    const offline = client(() => Promise.reject(new RestError('injoignable', 0)));
    assert.equal(await messageGoneFromServer(offline, 'm1'), false);
    const limit = client(() => Promise.reject(new RestError('too many requests', 429)));
    assert.equal(await messageGoneFromServer(limit, 'm1'), false);
  });

  test('an error that is not a RestError does not conclude either', async () => {
    const c = client(() => Promise.reject(new Error('boom')));
    assert.equal(await messageGoneFromServer(c, 'm1'), false);
  });
});
