import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginSlack, resumeSlack, slackUnread } from './auth.ts';
import { SlackError } from './client.ts';
import { AUTH, COOKIE, TOKEN, fakeSlack } from './testing.ts';

test('a pasted token and cookie become a saved Slack account named by auth.test', async () => {
  const server = fakeSlack(() => ({ body: AUTH }));
  const session = await loginSlack(` ${TOKEN} `, `d=${COOKIE}`, null, { fetch: server.fetcher });
  assert.deepEqual(session, {
    baseUrl: 'https://test.slack.com', authToken: TOKEN, userId: 'U000', username: 'me', kind: 'slack', siteUrl: null, slackCookie: COOKIE, slackTeamId: 'T000',
  });
  assert.equal(server.calls[0]!.headers.get('Cookie'), 'd=' + COOKIE);
});

test('an identity other than the expected one is refused', async () => {
  const server = fakeSlack(() => ({ body: AUTH }));
  await assert.rejects(loginSlack(TOKEN, COOKIE, { teamId: 'T000', userId: 'U001' }, { fetch: server.fetcher }), (e) => e instanceof SlackError && e.code === 'identity_mismatch');
  await assert.rejects(loginSlack(TOKEN, COOKIE, { teamId: 'T001', userId: 'U000' }, { fetch: server.fetcher }), (e) => e instanceof SlackError && e.code === 'identity_mismatch');
});

test('malformed credentials never reach the network', async () => {
  const server = fakeSlack(() => ({ body: AUTH }));
  await assert.rejects(loginSlack('xoxb-000', COOKIE, null, { fetch: server.fetcher }), (e) => e instanceof SlackError && e.code === 'invalid_credentials');
  await assert.rejects(loginSlack(TOKEN, 'xoxd-a; b=c', null, { fetch: server.fetcher }), (e) => e instanceof SlackError && e.code === 'invalid_credentials');
  assert.equal(server.calls.length, 0);
});

test('resume checks the pinned workspace and account', async () => {
  const session = await loginSlack(TOKEN, COOKIE, null, { fetch: fakeSlack(() => ({ body: AUTH })).fetcher });
  assert.equal((await resumeSlack(session, { fetch: fakeSlack(() => ({ body: { ...AUTH, user: 'renamed' } })).fetcher })).username, 'renamed');
  await assert.rejects(resumeSlack(session, { fetch: fakeSlack(() => ({ body: { ...AUTH, team_id: 'T001' } })).fetcher }), (e) => e instanceof SlackError && e.code === 'identity_mismatch');
  await assert.rejects(resumeSlack(session, { fetch: fakeSlack(() => ({ body: { ok: false, error: 'invalid_auth' } })).fetcher }), (e) => e instanceof SlackError && e.rejectsSession);
  await assert.rejects(resumeSlack({ ...session, slackCookie: undefined }), (e) => e instanceof SlackError && e.code === 'invalid_credentials');
});

test('the server rail reads unread state from client.counts', async () => {
  const session = await loginSlack(TOKEN, COOKIE, null, { fetch: fakeSlack(() => ({ body: AUTH })).fetcher });
  const counts = (entry: Record<string, unknown>) => fakeSlack(() => ({ body: { ok: true, channels: [], mpims: [], ims: [{ id: 'D000', ...entry }] } })).fetcher;
  assert.equal(await slackUnread(session, { fetch: counts({ has_unreads: false, mention_count: 0 }) }), false);
  assert.equal(await slackUnread(session, { fetch: counts({ has_unreads: true, mention_count: 0 }) }), true);
  assert.equal(await slackUnread(session, { fetch: counts({ has_unreads: false, mention_count: 2 }) }), true);
});
