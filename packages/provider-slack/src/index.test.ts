import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Session } from '@rocket-vibe/provider-api/session';
import type { DdpEvent, DdpState } from '@rocket-vibe/provider-api/ddp';
import type { Listener } from '@rocket-vibe/provider-api/provider';
import { memoryStore } from '@rocket-vibe/provider-api/testing';
import { SyncEngine } from '@rocket-vibe/provider-api/sync';
import { SlackError } from './client.ts';
import { createSlackProvider, describeSlackError } from './index.ts';
import { COOKIE, TOKEN, fakeSlack } from './testing.ts';

const SESSION: Session = { baseUrl: 'https://test.slack.com', authToken: TOKEN, userId: 'U000', username: 'me', kind: 'slack', siteUrl: null, slackCookie: COOKIE, slackTeamId: 'T000' };

/** A listener the write/read assertions don't exercise; the real RTM is tested in rtm.test.ts. */
class StubListener implements Listener {
  state: DdpState = 'closed';
  async connect(): Promise<void> {}
  subscribe(): () => void {
    return () => {};
  }
  onEvent(_fn: (event: DdpEvent) => void): () => void {
    return () => {};
  }
  onLoss(): () => void {
    return () => {};
  }
  close(): void {}
  async checkAlive(): Promise<boolean> {
    return true;
  }
  async armedSubscriptions(): Promise<void> {}
  reset(): void {}
}

test('the provider: text, files, marks, presence and search on, DMs refused, a refused session reported', async () => {
  const rejected: string[] = [];
  const rest = { onTokenRejected: (token: string) => void rejected.push(token) };
  const server = fakeSlack(() => ({ body: { ok: false, error: 'token_revoked' } }));
  const provider = createSlackProvider(SESSION, rest, () => 'local-1', { fetch: server.fetcher, listener: new StubListener() });
  assert.deepEqual(
    [provider.capabilities.sending, provider.capabilities.editing, provider.capabilities.deletion, provider.capabilities.reactions, provider.capabilities.alsoInRoom],
    [true, true, true, true, true],
  );
  assert.deepEqual(
    [provider.capabilities.files, provider.capabilities.marks, provider.capabilities.presence, provider.capabilities.search, provider.capabilities.typing],
    [true, true, true, true, true],
  );
  assert.ok(provider.searchMessages && provider.ownActivity && provider.loadPresence);
  await assert.rejects(provider.actions.openOrCreateDm('alice'), (e) => e instanceof SlackError && e.code === 'unsupported');
  await assert.rejects(provider.actions.react('C001', 'C002:1780000000.000001', 'eyes', true), (e) => e instanceof SlackError && e.code === 'message_not_found');
  const local = memoryStore();
  const engine = new SyncEngine(local.store, provider.translator);
  await assert.rejects(provider.catchUpGlobal(engine, () => false), (e) => provider.describeError(e, true).rejectsSession);
  assert.deepEqual(rejected, [TOKEN]);
  assert.equal(describeSlackError(new SlackError('http_error', 502), true).rejectsSession, false);
  assert.equal(describeSlackError(new SlackError('invalid_auth'), false).rejectsSession, false);
});
