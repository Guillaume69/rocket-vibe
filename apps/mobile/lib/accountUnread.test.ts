import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nativeRoomsUnread, serverHost, subscriptionsUnread } from './accountUnread.ts';
import type { Room } from '../providers/rocketvibe/protocol.generated.ts';

test('a Rocket.Chat account is unread like the desktop room list', () => {
  assert.equal(subscriptionsUnread({ update: [] }), false);
  assert.equal(subscriptionsUnread({ update: [{ unread: 0, alert: false }] }), false);
  assert.equal(subscriptionsUnread({ update: [{ unread: 2 }] }), true);
  assert.equal(subscriptionsUnread({ update: [{ unread: 0, alert: true }] }), true);
  assert.equal(subscriptionsUnread({ update: [{ unread: 3, open: false }] }), false, 'a hidden room');
  assert.equal(subscriptionsUnread(null), false);
});

test('a RocketVibe account is unread when a read state has something to read', () => {
  const state = (unread: string, mentions = '0') => ({
    favorite: false, group_mentions: '0', mentions, reply_position: '0', revision: '1',
    room_id: 'r1', root_position: '0', unread_replies: '0', unread_roots: unread,
  });
  const room = (read_state: Room['read_state']): Room => ({ id: 'r1', kind: 'channel' as Room['kind'], name: 'general', revision: '1', read_state });
  assert.equal(nativeRoomsUnread([room(null), room(state('0'))]), false);
  assert.equal(nativeRoomsUnread([room(state('0')), room(state('4'))]), true);
  assert.equal(nativeRoomsUnread([room(state('0', '1'))]), true);
});

test('servers are matched by host', () => {
  assert.equal(serverHost('https://Chat.Example.org/'), 'chat.example.org');
  assert.equal(serverHost('http://10.0.2.2:3000'), '10.0.2.2:3000');
  assert.equal(serverHost('chat.example.org'), 'chat.example.org');
});
