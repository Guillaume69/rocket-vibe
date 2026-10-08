import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { BotReference } from '../providers/rocketvibe/protocol.generated.ts';
import { BOT_SCOPES, botErrorKey, curlExample, expiryDays, sameScopes, scopeRoutes, toggleScope } from './botsModel.ts';

const reference: BotReference = {
  key_prefix: 'rvb_',
  sends_per_minute: 60,
  direct_per_minute: 10,
  groups: [
    { routes: [{ method: 'GET', path: '/api/v1/me' }] },
    { scope: 'rooms:read', routes: [{ method: 'GET', path: '/api/v1/rooms' }, { method: 'GET', path: '/api/v1/rooms/{room}' }] },
    { scope: 'dm:write', routes: [{ method: 'POST', path: '/api/v1/direct-messages' }] },
  ],
};

describe('scopes', () => {
  test('toggling keeps the server order and round-trips', () => {
    const some = toggleScope(toggleScope([], 'dm:write'), 'rooms:read');
    assert.deepEqual(some, ['rooms:read', 'dm:write']);
    assert.deepEqual(toggleScope(some, 'dm:write'), ['rooms:read']);
    assert.equal(BOT_SCOPES.length, 7);
  });

  test('an edit compares scopes as sets', () => {
    assert.ok(sameScopes(['dm:write', 'rooms:read'], ['rooms:read', 'dm:write']));
    assert.ok(!sameScopes(['rooms:read'], ['rooms:read', 'dm:write']));
  });

  test('routes come from the reference, the scopeless group for `always`', () => {
    assert.deepEqual(scopeRoutes(reference, 'rooms:read').map((r) => r.path), ['/api/v1/rooms', '/api/v1/rooms/{room}']);
    assert.deepEqual(scopeRoutes(reference, 'always'), [{ method: 'GET', path: '/api/v1/me' }]);
    assert.deepEqual(scopeRoutes(reference, 'files:write'), []);
    assert.deepEqual(scopeRoutes(null, 'rooms:read'), []);
  });
});

describe('expiryDays', () => {
  test('empty is never, 1 to 3650 days, anything else refused', () => {
    assert.equal(expiryDays('  '), null);
    assert.equal(expiryDays('30'), 30);
    assert.equal(expiryDays('3650'), 3650);
    assert.equal(expiryDays('0'), undefined);
    assert.equal(expiryDays('3651'), undefined);
    assert.equal(expiryDays('1.5'), undefined);
    assert.equal(expiryDays('-3'), undefined);
  });
});

describe('botErrorKey', () => {
  test('words every refusal of the bot routes', () => {
    assert.equal(botErrorKey('bots_disabled', 403), 'bots.errDisabled');
    assert.equal(botErrorKey('bot_limit', 409), 'bots.errLimit');
    assert.equal(botErrorKey('username_taken', 409), 'bots.errUsernameTaken');
    assert.equal(botErrorKey('bot_key_limit', 409), 'bots.errKeyLimit');
    assert.equal(botErrorKey('bot_disabled', 409), 'bots.errBotDisabled');
    assert.equal(botErrorKey('bot_key_replayed', 409), 'bots.errKeyReplayed');
    assert.equal(botErrorKey('reauthentication_required', 403), 'bots.errReauth');
    assert.equal(botErrorKey('invalid_request', 400), 'bots.errInvalid');
    assert.equal(botErrorKey('not_found', 404), 'bots.errNotFound');
    assert.equal(botErrorKey('bot_encrypted_room', 409), 'bots.errEncryptedRoom');
    assert.equal(botErrorKey('crypto_bot_member', 409), 'bots.errBotMember');
  });

  test('falls back on offline, rate limit, then a generic sentence', () => {
    assert.equal(botErrorKey('network_or_protocol_error', 0), 'bots.errOffline');
    assert.equal(botErrorKey('anything', 429), 'bots.errRateLimited');
    assert.equal(botErrorKey('anything', 418), 'bots.failed');
  });
});

describe('curlExample', () => {
  test('fills in the server and the key, leaves the room to choose', () => {
    const example = curlExample('https://chat.example.org/', 'rvb_abc');
    assert.ok(example.startsWith('curl -X POST "https://chat.example.org/api/v1/rooms/<ROOM_ID>/messages"'));
    assert.ok(example.includes('-H "Authorization: Bearer rvb_abc"'));
    assert.ok(example.endsWith(`-d '{"operation_id":"hello-1","text":"Hello"}'`));
  });
});
