import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { reactionList } from '../../lib/reactions.ts';
import { MmClient } from './client.ts';
import { MmDirectory } from './directory.ts';
import { post } from './testing.ts';
import { MM_POST, MM_QUIET, MmTranslator, record } from './translator.ts';

function translator() {
  const directory = new MmDirectory(new MmClient('http://mm.test', 't'));
  directory.remember({ id: 'u-me', username: 'me', displayName: 'Me Myself', lastPictureUpdate: null });
  directory.remember({ id: 'u-bob', username: 'bob', displayName: 'Bob Builder', lastPictureUpdate: null });
  return new MmTranslator(directory, 'u-me');
}

describe('MmTranslator.toMessage', () => {
  test('a plain post carries its author by username and its server times', () => {
    const m = translator().toMessage(post('p1', { create_at: 10, update_at: 20, edit_at: 15 }));
    assert.equal(m?.authorName, 'bob');
    assert.equal(m?.ts, 10);
    assert.equal(m?.updatedAt, 20);
    assert.equal(m?.editedAt, 15);
    assert.equal(m?.threadId, null);
  });

  test('a reply points at its root; a root carries its thread counters', () => {
    const t = translator();
    assert.equal(t.toMessage(post('p2', { root_id: 'p1' }))?.threadId, 'p1');
    const root = t.toMessage(post('p1', { reply_count: 3, last_reply_at: 50 }));
    assert.equal(root?.threadCount, 3);
    assert.equal(root?.threadLast, 50);
  });

  test('a deleted post is not a message', () => {
    assert.equal(translator().toMessage(post('p1', { delete_at: 5 })), null);
  });

  test('system posts map onto the types the renderer knows', () => {
    const joined = translator().toMessage(post('p1', { type: 'system_join_channel', props: { username: 'bob' } }));
    assert.equal(joined?.systemType, 'uj');
    assert.equal(joined?.text, 'bob');
    const header = translator().toMessage(post('p2', { type: 'system_header_change', props: { new_header: 'news' } }));
    assert.equal(header?.systemType, 'room_changed_topic');
    assert.equal(header?.text, 'news');
  });

  test('reactions group by emoji with usernames, readable by `reactionList`', () => {
    const m = translator().toMessage(post('p1', {
      metadata: { reactions: [
        { user_id: 'u-me', emoji_name: '+1' },
        { user_id: 'u-bob', emoji_name: '+1' },
        { user_id: 'u-bob', emoji_name: 'smile' },
      ] },
    }));
    const list = reactionList(m?.reactions ?? null, 'me');
    assert.deepEqual(list.find((r) => r.code === '+1'), { code: '+1', total: 2, byMe: true });
    assert.deepEqual(list.find((r) => r.code === 'smile'), { code: 'smile', total: 1, byMe: false });
  });

  test('files become attachments on the file API, images with their preview', () => {
    const m = translator().toMessage(post('p1', {
      metadata: { files: [
        { id: 'f1', name: 'cat.png', mime_type: 'image/png', size: 9, width: 4, height: 3, has_preview_image: true },
        { id: 'f2', name: 'doc.pdf', mime_type: 'application/pdf', size: 7 },
      ] },
    }));
    const [image, doc] = JSON.parse(m?.attachments ?? '[]');
    assert.equal(image.image_url, '/api/v4/files/f1/preview');
    assert.deepEqual(image.image_dimensions, { width: 4, height: 3 });
    assert.equal(doc.title_link, '/api/v4/files/f2');
    assert.equal(doc.image_url, undefined);
  });
});

describe('MmTranslator rooms and memberships', () => {
  test('a DM is named after the other user, never me', () => {
    const room = translator().toRoom({ channel: { id: 'd1', type: 'D', name: 'u-bob__u-me', update_at: 1 } });
    assert.equal(room?.type, 'd');
    assert.equal(room?.dmOtherUid, 'u-bob');
    assert.equal(room?.dmOtherUsername, 'bob');
    assert.equal(room?.displayName, 'Bob Builder');
  });

  test('a group DM drops my own name from its label', () => {
    const room = translator().toRoom({ channel: { id: 'g1', type: 'G', name: 'x', display_name: 'bob, me, carol' } });
    assert.equal(room?.displayName, 'bob, carol');
  });

  test('the newest root post feeds the list preview', () => {
    const room = translator().toRoom({ channel: { id: 'ch1', type: 'O', name: 'dev', display_name: 'Dev' }, lastPost: post('p9', { create_at: 77 }) });
    assert.equal(room?.lastMessage, 'message p9');
    assert.equal(room?.lastMessageTs, 77);
  });

  test('unread counts root posts only, mentions come from the membership', () => {
    const sub = translator().toSubscription({
      channel: { id: 'ch1', total_msg_count: 30, total_msg_count_root: 10 },
      member: { channel_id: 'ch1', msg_count: 20, msg_count_root: 7, mention_count: 2, roles: 'channel_user channel_admin' },
    });
    assert.equal(sub?.unread, 3);
    assert.equal(sub?.mentions, 2);
    assert.equal(sub?.roles, JSON.stringify(['owner']));
  });
});

describe('MmTranslator.translateEvent', () => {
  test('a post envelope carrying a deletion is a deletion', () => {
    const t = translator().translateEvent({ collection: MM_POST, eventKey: 'ch1', args: [post('p1', { delete_at: 3 })] });
    assert.deepEqual(t, { kind: 'change', change: { type: 'message-deleted', id: 'p1' } });
  });

  test('quiet events are silence, unknown ones are counted', () => {
    assert.equal(translator().translateEvent({ collection: MM_QUIET, eventKey: 'typing', args: [] }).kind, 'silence');
    assert.equal(translator().translateEvent({ collection: 'channel_bookmark_created', eventKey: '', args: [] }).kind, 'ignore');
  });

  test('nested documents are accepted as JSON strings (Mattermost) and objects (kChat)', () => {
    assert.deepEqual(record('{"a":1}'), { a: 1 });
    assert.deepEqual(record({ a: 1 }), { a: 1 });
    assert.equal(record('[1]'), null);
  });
});
