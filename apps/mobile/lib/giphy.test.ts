import test from 'node:test';
import assert from 'node:assert/strict';
import { imageLink, previews, searchGiphy, sendGiphy } from './giphy.ts';
import type { RestClient } from './rest.ts';

test('Rocket.Chat preview lookup and chosen item preserve query and thread', async () => {
  const calls: unknown[] = [];
  const item = { id: 'gif-1', type: 'image' as const, value: 'https://media.giphy.com/wave.gif' };
  const client = {
    get: async (...args: unknown[]) => {
      calls.push(args);
      return { preview: { items: [item] } };
    },
    post: async (...args: unknown[]) => {
      calls.push(args);
      return { success: true };
    },
  } as unknown as RestClient;
  assert.deepEqual(await searchGiphy(client, 'room-1', 'wave'), [item]);
  await sendGiphy(client, 'room-1', 'wave', item, 'trigger-1', 'thread-1');
  assert.deepEqual(calls, [
    ['commands.preview', { params: { command: 'giphy', roomId: 'room-1', params: 'wave' } }],
    [
      'commands.preview',
      {
        body: {
          command: 'giphy',
          roomId: 'room-1',
          params: 'wave',
          triggerId: 'trigger-1',
          previewItem: item,
          tmid: 'thread-1',
        },
      },
    ],
  ]);
});
test('preview images discard malformed and credential-bearing links', () => {
  assert.equal(imageLink('https://example.com/a?rc_token=secret'), false);
  assert.equal(imageLink('https://user:password@example.com/a'), false);
  assert.deepEqual(
    previews({
      preview: {
        items: [
          { id: '1', type: 'image', value: 'javascript:alert(1)' },
          { id: '2', type: 'text', value: 'https://example.com/a.gif' },
        ],
      },
    }),
    [],
  );
});
