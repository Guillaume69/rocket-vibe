import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canvasFile, canvasMarkdown } from './canvas.ts';

test('a channel canvas is found in its properties or its tabs', () => {
  assert.equal(canvasFile({ properties: { canvas: { file_id: 'F1' } } }), 'F1');
  assert.equal(canvasFile({ properties: { tabs: [{ type: 'files' }, { type: 'canvas', data: { file_id: 'F2' } }] } }), 'F2');
  assert.equal(canvasFile({ properties: {} }), null);
  assert.equal(canvasFile({}), null);
});

test('canvas html reads as the same markdown as on the desktop', () => {
  const html = '<html><head><title>x</title><style>p{}</style></head><body>'
    + '<h1>Plan &amp; goals</h1><p>Ship <b>notes</b>, <i>then</i> <a href="https://example.com/a?b=1&amp;c=2">docs</a>.</p>'
    + '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>'
    + '<ol><li>first</li><li>second</li></ol>'
    + '<ul class="checklist"><li class="checked">done</li><li class="unchecked">todo</li></ul>'
    + '<pre><code>let x = 1;\nlet y = 2;</code></pre>'
    + '<blockquote><p>quoted</p></blockquote><hr/><p>a&nbsp;b &#233;&#x1F680; <code>tt</code></p>'
    + '<script>alert(1)</script></body></html>';
  assert.equal(canvasMarkdown(html), '# Plan & goals\n\n'
    + 'Ship **notes**, _then_ [docs](https://example.com/a?b=1&c=2).\n\n'
    + '- one\n- two\n  - nested\n\n'
    + '1. first\n2. second\n\n'
    + '- [x] done\n- [ ] todo\n\n'
    + '```\nlet x = 1;\nlet y = 2;\n```\n\n'
    + '> quoted\n\n---\n\n'
    + 'a b é🚀 `tt`');
});

test('a link to anything but the web keeps its text only', () => {
  assert.equal(canvasMarkdown('<p><a href="javascript:alert(1)">click</a></p>'), 'click');
  assert.equal(canvasMarkdown('plain &unknown; text'), 'plain &unknown; text');
  assert.equal(canvasMarkdown(''), '');
});

test('a canvas reads as notes and is saved only over the version read', async () => {
  const { SlackActions } = await import('./actions.ts');
  const { SlackClient } = await import('./client.ts');
  const { SlackDirectory } = await import('./directory.ts');
  const { SlackHistory } = await import('./history.ts');
  const { SlackLive } = await import('./live.ts');
  const { SlackSaved } = await import('./saved.ts');
  const { SlackTranslator } = await import('./translator.ts');
  const { COOKIE, TOKEN, fakeSlack } = await import('./testing.ts');
  const { NOTES_CONFLICT } = await import('@rocket-vibe/provider-api/provider');
  const server = fakeSlack((call) => {
    switch (call.method) {
      case 'conversations.info':
        return { body: { ok: true, channel: call.args.channel === 'C001' ? { id: 'C001', properties: { canvas: { file_id: 'F001' } } } : { id: 'C002', properties: {} } } };
      case 'files.info':
        return { body: { ok: true, file: { id: 'F001', updated: 1780000500, last_editor: 'U001', url_private: 'https://files.slack.com/files-pri/T0-F001/canvas' } } };
      default:
        return { body: { ok: true } };
    }
  });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('https://files.slack.com/')
    ? new Response('<html><body><h1>Plan</h1><ul><li>ship</li></ul></body></html>', { status: 200 })
    : server.fetcher(input, init)) as typeof fetch;
  const client = new SlackClient(TOKEN, COOKIE, { fetch: fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: 'Alice', avatar: null });
  const history = new SlackHistory(client, directory);
  const live = new SlackLive({ client, directory, history, myId: 'U000' });
  const saved = new SlackSaved(client, history);
  const actions = new SlackActions({ client, directory, history, live, translator: new SlackTranslator(directory, 'U000', new Map(), saved.ids), saved });

  const notes = await actions.roomNotes('C001');
  assert.deepEqual(notes, { markdown: '# Plan\n\n- ship', revision: '1780000500', editable: false, updatedBy: 'Alice', updatedAt: 1780000500000 });
  await assert.rejects(actions.saveRoomNotes('C001', 'x', '1780000400'), (e: { code?: string }) => e.code === NOTES_CONFLICT);
  assert.equal(server.calls.filter((c) => c.method === 'canvases.edit').length, 0);
  await actions.saveRoomNotes('C001', '# Plan v2', '1780000500');
  const edit = server.calls.find((c) => c.method === 'canvases.edit');
  assert.equal(edit?.args.canvas_id, 'F001');
  assert.deepEqual(JSON.parse(edit?.args.changes ?? ''), [{ operation: 'replace', document_content: { type: 'markdown', markdown: '# Plan v2' } }]);
  assert.deepEqual(await actions.roomNotes('C002'), { markdown: '', revision: '0', editable: false, updatedBy: null, updatedAt: null });
  await actions.saveRoomNotes('C002', 'first', '0');
  const create = server.calls.find((c) => c.method === 'conversations.canvases.create');
  assert.equal(create?.args.channel_id, 'C002');
  assert.deepEqual(JSON.parse(create?.args.document_content ?? ''), { type: 'markdown', markdown: 'first' });
});
