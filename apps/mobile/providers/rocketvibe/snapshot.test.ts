import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const page = (index: number) => ({protocol_version:1,snapshot_id:'immutable-view',page_index:index,rooms:[],messages:[],next:null,cursor:null});
function client(pages: unknown[]) {
  let calls = 0;
  const c = new NativeTransport('https://example.org',async url => {
    if (String(url).endsWith('/.well-known/rocketvibe')) return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,snapshot_paging:true}});
    calls++;
    return Response.json(pages.shift());
  });
  c.restore('token');
  return {c,calls:() => calls};
}

test('snapshot pages assemble once at a fixed watermark before reaching SQLite',async () => {
  const h = client([
    {...page(0),rooms:[fixture.room],next:'page-next'},
    {...page(1),messages:[fixture.message],cursor:'complete-watermark'},
  ]);
  const snapshot = await h.c.snapshot();
  assert.equal(snapshot.cursor,'complete-watermark');
  assert.deepEqual(snapshot.rooms,[fixture.room]);
  assert.deepEqual(snapshot.messages,[fixture.message]);
  assert.equal(h.calls(),2);
});
test('broken page order, identities, duplicate messages, missing rooms and premature cursors abort the whole view',async () => {
  for (const bad of [
    {...page(2),cursor:'end'},
    {...page(1),snapshot_id:'another-view',cursor:'end'},
    {...page(1),messages:[fixture.message,fixture.message],cursor:'end'},
    {...page(1),messages:[{...fixture.message,room_id:'unlisted'}],cursor:'end'},
    {...page(1),next:'third-page',cursor:'premature'},
    {...page(1),next:'page-next'},
    {...page(1)},
  ]) {
    const h = client([{...page(0),rooms:[fixture.room],next:'page-next'},bad]);
    await assert.rejects(h.c.snapshot(),(e: unknown) => e instanceof NativeError && e.code==='invalid_snapshot');
    assert.equal(h.calls(),2);
  }
});
test('expired or withdrawn pages never return a partially assembled snapshot',async () => {
  let calls = 0;
  const c = new NativeTransport('https://example.org',async url => {
    if (String(url).endsWith('/.well-known/rocketvibe')) return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,snapshot_paging:true}});
    calls++;
    return calls===1 ? Response.json({...page(0),rooms:[fixture.room],next:'page-next'})
      : Response.json({code:'sync_reset_required',request_id:'expired-page'},{status:409});
  });
  c.restore('token');
  await assert.rejects(c.snapshot(),(e: unknown) => e instanceof NativeError && e.code==='sync_reset_required');
});
test('UTF-8 bytes bound each page, including Unicode and escaped source',async () => {
  const h = client([{...page(0),rooms:[fixture.room],messages:[{...fixture.message,text:'🚀'.repeat(300_000)}],cursor:'end'}]);
  await assert.rejects(h.c.snapshot(),(e: unknown) => e instanceof NativeError && e.code==='invalid_snapshot');
});
test('an older v1 native server keeps its original snapshot route',async () => {
  const paths: string[] = [];
  const c = new NativeTransport('https://example.org',async url => {
    paths.push(String(url));
    return Response.json(String(url).endsWith('/.well-known/rocketvibe') ? fixture.discovery : fixture.snapshot);
  });
  c.restore('token');
  assert.deepEqual(await c.snapshot(),fixture.snapshot);
  assert.equal(paths[1],'https://example.org/api/v1/sync/snapshot');
});

test('page wire size includes whitespace and an oversized length cancels before decoding',async () => {
  for (const header of [true,false]) {
    let read = false;
    const c = new NativeTransport('https://example.org',async url => {
      if (String(url).endsWith('/.well-known/rocketvibe')) return Response.json({...fixture.discovery,capabilities:{...fixture.discovery.capabilities,snapshot_paging:true}});
      const response = new Response(' '.repeat(1_100_000)+JSON.stringify({...page(0),cursor:'end'}),{headers:header ? {'content-length':'1100000'} : {}});
      const original = response.text.bind(response);
      response.text = () => { read = true; return original(); };
      return response;
    });
    c.restore('token');
    await assert.rejects(c.snapshot(),(e: unknown) => e instanceof NativeError && e.code==='invalid_snapshot');
    assert.equal(read,!header);
  }
});
