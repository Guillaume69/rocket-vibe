import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toMessage } from './normalize.ts';
import { unvouchedMentionsAsText } from './vouchedMentions.ts';

const mention = (type: string, name: string) => ({ type, value: { type: 'PLAIN_TEXT', value: name } });
const text = (value: string) => ({ type: 'PLAIN_TEXT', value });

describe('unvouched mentions', () => {
  test('only the vouched ones stay mentions, nested ones included', () => {
    const tree = [{ type: 'PARAGRAPH', value: [mention('MENTION_USER', 'bob'), mention('MENTION_USER', 'nobody'), { type: 'BOLD', value: [mention('MENTION_CHANNEL', 'nowhere')] }] }];
    const { tree: out, changed } = unvouchedMentionsAsText(tree, (u) => u === 'bob', () => false);
    assert.equal(changed, true);
    assert.deepEqual(out, [{ type: 'PARAGRAPH', value: [mention('MENTION_USER', 'bob'), text('@nobody'), { type: 'BOLD', value: [text('#nowhere')] }] }]);
    assert.equal(unvouchedMentionsAsText(out, (u) => u === 'bob', () => false).changed, false);
  });

  test("a Rocket.Chat message keeps only what its mentions and channels list", () => {
    const md = [{ type: 'PARAGRAPH', value: [mention('MENTION_USER', 'bob'), mention('MENTION_USER', 'nobody'), mention('MENTION_USER', 'here'), mention('MENTION_CHANNEL', 'general'), mention('MENTION_CHANNEL', 'nowhere')] }];
    const base = { _id: 'm1', rid: 'r1', ts: 1000, u: { _id: 'u1', username: 'alice' }, msg: 'x', md };
    const listed = toMessage({ ...base, mentions: [{ _id: 'u2', username: 'bob' }], channels: [{ _id: 'GENERAL', name: 'general' }] });
    assert.deepEqual(JSON.parse(listed!.md!)[0].value, [mention('MENTION_USER', 'bob'), text('@nobody'), mention('MENTION_USER', 'here'), mention('MENTION_CHANNEL', 'general'), text('#nowhere')]);
    assert.deepEqual(JSON.parse(toMessage(base)!.md!), md);
  });
});
