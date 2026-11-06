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

async function canvasActions(engine: import('./canvasEngine.ts').CanvasEngine | null) {
  const { SlackActions } = await import('./actions.ts');
  const { SlackClient } = await import('./client.ts');
  const { SlackDirectory } = await import('./directory.ts');
  const { SlackHistory } = await import('./history.ts');
  const { SlackLive } = await import('./live.ts');
  const { SlackSaved } = await import('./saved.ts');
  const { SlackTranslator } = await import('./translator.ts');
  const { COOKIE, TOKEN, fakeSlack } = await import('./testing.ts');
  const server = fakeSlack((call) => {
    switch (call.method) {
      case 'conversations.info':
        return { body: { ok: true, channel: call.args.channel === 'C001' ? { id: 'C001', properties: { canvas: { file_id: 'F001' } } } : { id: 'C002', properties: {} } } };
      case 'files.info':
        return { body: { ok: true, file: { id: 'F001', updated: 1780000500, last_editor: 'U001', url_private: 'https://files.slack.com/files-pri/T0-F001/canvas' } } };
      case 'quip.lookupThreadIds':
        return { body: { ok: true, lookup: { F001: 'TH1' } } };
      default:
        return { body: { ok: true } };
    }
  });
  const canvasCalls: { path: string; form: Record<string, string>; headers: Headers }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://files.slack.com/')) return new Response('<html><body><h1>Plan</h1><ul><li>ship</li></ul></body></html>', { status: 200 });
    if (url.startsWith('https://app.slack.com/canvas/-/')) {
      canvasCalls.push({ path: url.slice('https://app.slack.com/canvas/-/'.length), form: Object.fromEntries(new URLSearchParams(String(init?.body))), headers: new Headers(init?.headers) });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return server.fetcher(input, init);
  }) as typeof fetch;
  const client = new SlackClient(TOKEN, COOKIE, { fetch: fetcher });
  const directory = new SlackDirectory(client, 'https://test.slack.com');
  directory.remember({ id: 'U001', username: 'alice', displayName: 'Alice', avatar: null });
  const history = new SlackHistory(client, directory);
  const live = new SlackLive({ client, directory, history, myId: 'U000' });
  const saved = new SlackSaved(client, history);
  const actions = new SlackActions({ client, directory, history, live, translator: new SlackTranslator(directory, 'U000', new Map(), saved.ids), saved, canvas: engine });
  return { actions, server, canvasCalls, TOKEN, COOKIE };
}

test('without a canvas engine a canvas reads from its HTML, read-only', async () => {
  const { actions } = await canvasActions(null);
  assert.deepEqual(await actions.roomNotes('C001'), { markdown: '# Plan\n\n- ship', revision: '1780000500', editable: false, updatedBy: 'Alice', updatedAt: 1780000500000 });
  await assert.rejects(actions.saveRoomNotes('C001', 'x', '1780000500'), (e: { code?: string }) => e.code === 'not_supported');
  assert.deepEqual(await actions.roomNotes('C002'), { markdown: '', revision: '0', editable: false, updatedBy: null, updatedAt: null });
});

test('with a canvas engine a canvas is read through Quip and saved over the version read', async () => {
  const { NOTES_CONFLICT } = await import('@rocket-vibe/provider-api/provider');
  const plans: { load: string; markdown: string; session: string; suffix: string }[] = [];
  const engine = {
    read: (load: string) => (load === 'AQID' ? { markdown: '# Plan\n\n- ship\n', version: '3000', thread: 'TH1', document: 'DOC1', title: 'Plan' } : null),
    plan: (load: string, markdown: string, session: string, suffix: string) => {
      plans.push({ load, markdown, session, suffix });
      return markdown === '# Plan\n\n- ship\n' ? { data: '', changed: 0 } : { data: 'REFUQQ==', changed: 1 };
    },
  };
  const { actions, canvasCalls, TOKEN, COOKIE } = await canvasActions(engine);
  assert.deepEqual(await actions.roomNotes('C001'), { markdown: '# Plan\n\n- ship\n', revision: '3000', editable: true, updatedBy: 'Alice', updatedAt: 1780000500000 });
  const load = canvasCalls[0]!;
  assert.equal(load.path, 'load-data/editor/1');
  assert.equal(load.form.token, TOKEN);
  assert.equal(load.headers.get('cookie'), 'd=' + COOKIE);
  await assert.rejects(actions.saveRoomNotes('C001', 'x', '2000'), (e: { code?: string }) => e.code === NOTES_CONFLICT);
  await actions.saveRoomNotes('C001', '# Plan\n\n- ship\n', '3000');
  assert.equal(canvasCalls.filter((c) => c.path === 'edit-document').length, 0, 'nothing changed, nothing sent');
  await actions.saveRoomNotes('C001', '# Plan v2\n\n- ship\n', '3000');
  const edits = canvasCalls.filter((c) => c.path === 'edit-document');
  assert.equal(edits.length, 1);
  const form = edits[0]!.form;
  assert.deepEqual([form.thread, form.document, form.title, form.data_binary, form.sequence], ['TH1', 'DOC1', 'Plan', 'REFUQQ==', '1']);
  assert.match(form.session!, /^[0-9a-f]{12}$/);
  assert.equal(plans.at(-1)!.session, form.session);
  assert.match(plans.at(-1)!.suffix, /^[0-9a-f]{8}$/);
  await assert.rejects(actions.saveRoomNotes('C002', 'first', '0'), (e: { code?: string }) => e.code === 'not_supported');
});

test('the canvas load request matches the web client byte for byte', async () => {
  const { loadRequest } = await import('./canvasEngine.ts');
  assert.equal(loadRequest('eTd9AAR4bTh'), 'CgtlVGQ5QUFSNGJUaBoPCAESC2VUZDlBQVI0YlRoKgZlZGl0b3IwAQ==');
});
