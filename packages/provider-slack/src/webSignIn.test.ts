import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSlackWebDone, isSlackWebPage, scrapeToken, sessionCookie, signInFromWeb, slackUserAgent, workspaceHosts } from './webSignIn.ts';
import { AUTH, COOKIE, TOKEN, fakeSlack } from './testing.ts';

test('the web view shows Slack pages only and stops on the handoff or the web client', () => {
  assert.ok(isSlackWebPage('https://slack.com/signin'));
  assert.ok(isSlackWebPage('https://team-1.slack.com/'));
  assert.ok(!isSlackWebPage('https://slack.com.evil.example/'));
  assert.ok(!isSlackWebPage('https://evil.com\\.slack.com/'));
  assert.ok(!isSlackWebPage('http://slack.com/'));
  assert.ok(isSlackWebDone('https://team.slack.com/ssb/redirect'));
  assert.ok(isSlackWebDone('https://app.slack.com/client/T1/C1'));
  assert.ok(!isSlackWebDone('https://slack.com/signin'));
});

test('workspace hosts leave Slack infrastructure out; the cookie is the one xoxd d', () => {
  assert.deepEqual(workspaceHosts(['app.slack.com', 'Team.slack.com', 'team.slack.com', 'slack.com', 'files.slack.com']), ['team.slack.com']);
  assert.equal(sessionCookie(`b=1; d=${COOKIE}; x=2`), COOKIE);
  assert.equal(sessionCookie('d=nope'), null);
  assert.equal(sessionCookie(`d=${COOKIE}; d=xoxd-other`), null, 'two sessions: which one is unknowable');
});

test("Slack is shown a desktop browser of the web view's own Chromium version", () => {
  const phone = 'Mozilla/5.0 (Linux; Android 16; SM-S938B Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.7390.24 Mobile Safari/537.36';
  assert.equal(slackUserAgent(phone), 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36');
  assert.match(slackUserAgent(null), /Chrome\/141\.0\.0\.0 Safari/);
  assert.ok(!slackUserAgent(phone).includes('Android'));
});

test('the boot page token is scraped, the keyed one first', () => {
  assert.equal(scrapeToken('{"x":"xoxc-1-a","api_token":"xoxc-2-b"}'), 'xoxc-2-b');
  assert.equal(scrapeToken('boot xoxc-3-c end'), 'xoxc-3-c');
  assert.equal(scrapeToken('<html>signed out</html>'), null);
});

test('a finished web sign-in reads the workspace boot page, then proves the token', async () => {
  const server = fakeSlack(() => ({ body: AUTH }));
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://team.slack.com/') {
      assert.equal(new Headers(init?.headers).get('Cookie'), `d=${COOKIE}`);
      return new Response(`<script>var b={"api_token":"${TOKEN}"}</script>`, { status: 403 });
    }
    return server.fetcher(input, init);
  };
  const sessions = await signInFromWeb('https://team.slack.com/ssb/redirect', `d=${COOKIE}`, [], { fetch: fetcher });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.authToken, TOKEN);
  assert.equal(sessions[0]!.slackCookie, COOKIE);
  await assert.rejects(signInFromWeb('https://team.slack.com/ssb/redirect', 'x=1', [], { fetch: fetcher }));
});
