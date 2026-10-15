import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { unicodeOfShortcode } from '../../lib/emojis.ts';
import { SlackClient } from './client.ts';
import { SlackDirectory, toSlackUser } from './directory.ts';
import { glyphOf, reactionCode, replaceSlackEmojis, slackName, slackReactable } from './emojis.ts';
import { slackCustomEmojis } from './index.ts';
import { COOKIE, TOKEN, fakeSlack } from './testing.ts';
import { slackCalls } from './calls.ts';
import { huddleCall } from './translator.ts';

describe('Slack emoji names', () => {
  test('text names and skin tones become glyphs; custom and unknown stay', () => {
    assert.equal(
      replaceSlackEmojis(':man-wearing-turban::skin-tone-6::female-office-worker: hi :issou: :+1:'),
      '\u{1F473}\u{1F3FF}‍♂️\u{1F469}‍\u{1F4BC} hi :issou: \u{1F44D}',
    );
    assert.equal(replaceSlackEmojis('time 12:30:45'), 'time 12:30:45');
    assert.equal(replaceSlackEmojis(':baby::skin-tone-9:'), '\u{1F476}:skin-tone-9:');
  });

  test('reactions go both ways through the app codes', () => {
    const thumbs = reactionCode('+1');
    assert.equal(unicodeOfShortcode(thumbs), '\u{1F44D}', thumbs);
    assert.equal(glyphOf(slackName(thumbs)), '\u{1F44D}');
    const toned = reactionCode('+1::skin-tone-3');
    assert.equal(unicodeOfShortcode(toned), '\u{1F44D}\u{1F3FC}');
    assert.ok(slackName(toned).endsWith('::skin-tone-3'));
    assert.equal(reactionCode('issou'), 'issou');
    assert.equal(slackName(':issou:'), 'issou');
  });

  test('a reaction is offered only for an emoji Slack has a name for', () => {
    assert.ok(slackReactable('thumbsup'));
    assert.ok(slackReactable(':+1:'));
    assert.ok(slackReactable(reactionCode('+1::skin-tone-3')));
    assert.ok(!slackReactable('couple_with_heart_man_man_dark_skin_tone_light_skin_tone'));
    assert.ok(!slackReactable('issou'));
  });
});

describe('huddles', () => {
  const message = (room: Record<string, unknown>) => ({ type: 'message', subtype: 'huddle_thread', team: 'T1', ts: '1.000000', room });
  test('a running huddle is a call whose id is its Slack page, its own or the room one', () => {
    assert.deepEqual(huddleCall(message({ huddle_link: 'https://app.slack.com/huddle/T1/C1' }), 'C1'), { type: 'videoconf', param: '', callId: 'https://app.slack.com/client/T1/C1?open=start_huddle' });
    assert.equal(huddleCall(message({}), 'D1')?.callId, 'https://app.slack.com/client/T1/D1?open=start_huddle');
  });
  test('once over, an ended call with its length', () => {
    assert.deepEqual(huddleCall(message({ date_start: 1000, date_end: 1600 }), 'C1'), { type: 'videoconf-ended', param: '600', callId: null });
    assert.equal(huddleCall(message({ has_ended: true }), 'C1')?.param, '');
    assert.equal(huddleCall({ type: 'message', ts: '1.000000' }, 'C1'), null);
  });
  test('calls start on the room huddle page and join only Slack pages', async () => {
    const calls = slackCalls('T1');
    const page = 'https://app.slack.com/client/T1/C9?open=start_huddle';
    assert.equal(await calls.start('C9', null, () => true), page);
    assert.equal(await calls.join(page, {}, () => true), page);
    assert.equal(await calls.join('https://app.slack.com/huddle/T1/C9', {}, () => true), page);
    await assert.rejects(calls.join('https://evil.example/x', {}, () => true));
  });
});

describe('status emoji', () => {
  test('from the given glyph, a standard shortcode, while it lasts', () => {
    const directory = new SlackDirectory(new SlackClient(TOKEN, COOKIE, { fetch: fakeSlack(() => undefined).fetcher }), 'https://test.slack.com');
    const user = (id: string, profile: Record<string, unknown>) => toSlackUser({ id, name: id.toLowerCase(), profile })!;
    directory.remember(user('U001', { status_emoji: ':star_of_david:', status_emoji_display_info: [{ unicode: '2721-fe0f' }] }));
    directory.remember(user('U002', { status_emoji: ':female-office-worker:' }));
    directory.remember(user('U003', { status_emoji: ':issou:' }));
    directory.remember(user('U004', { status_emoji: ':tada:', status_expiration: 1 }));
    assert.deepEqual([...directory.statusEmojis()], [['U001', '✡️'], ['U002', '\u{1F469}‍\u{1F4BC}']]);
  });
});

describe('custom emoji', () => {
  test('emoji.list with aliases of custom ones followed, standard aliases left out', async () => {
    const { fetcher } = fakeSlack((call) => (call.method === 'emoji.list' ? { body: { ok: true, emoji: {
      issou: 'https://emoji.slack-edge.com/T1/issou/abc.png',
      ris: 'alias:issou',
      yay: 'alias:tada',
      odd: 'https://evil.example/x.png',
    } } } : undefined));
    const list = await slackCustomEmojis(new SlackClient(TOKEN, COOKIE, { fetch: fetcher }));
    assert.deepEqual(list.map((e) => [e.name, e.uri]), [
      ['issou', 'https://emoji.slack-edge.com/T1/issou/abc.png'],
      ['ris', 'https://emoji.slack-edge.com/T1/issou/abc.png'],
    ]);
  });
});
