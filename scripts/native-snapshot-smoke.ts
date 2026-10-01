/** Real mobile bootstrap with an over-8-MiB immutable snapshot and actual SQLite. */
import assert from 'node:assert/strict';
import { NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import { NativeChat } from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import { NativeStore } from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import { nativeTestDatabase } from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import { creerFileEcritures } from '../apps/mobile/db/fileEcritures.ts';
import type { Session } from '../apps/mobile/lib/auth.ts';

const base = process.env.RV_SMOKE_URL;
if (!base) throw new Error('RV_SMOKE_URL is required');
const loginClient = new NativeTransport(base);
const discovery = await loginClient.discover();
const login = await loginClient.login('alice',process.env.RV_SMOKE_PASSWORD ?? 'test-password-2026');
const session: Session = {genre:'rocketvibe',baseUrl:base,siteUrl:null,authToken:login.token,userId:login.user.id,username:login.user.username,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const db = nativeTestDatabase();
const store = new NativeStore(db.adapter,creerFileEcritures(),session);
let pages = 0;
const transport = new NativeTransport(base,async (url,options) => {
  if (String(url).includes('/sync/snapshots/')) {
    pages++;
    assert.equal(await store.state(),null,'a partial page must not publish its cursor');
    assert.deepEqual(await store.rooms(),[],'a partial snapshot must not reach the UI projection');
  }
  return fetch(url,options);
});
transport.restore(login.token);
const chat = new NativeChat(session,store,() => 'unused-intention',{transport});
try {
  await chat.connect();
  const rooms = await store.rooms();
  assert.equal(rooms.length,3);
  let messages = 0;
  let future = false;
  for (const room of rooms) {
    const rows = await store.messages(room.rid);
    messages += rows.length;
    future ||= rows.some(m => m.id === 'after-materialization');
  }
  assert.equal(messages,150);
  assert.ok(future);
  assert.ok(pages>1);
  assert.ok((await store.state())?.cursor);
  console.log('Mobile immutable snapshot: all pages applied atomically to actual SQLite; 150 large messages preserved');
} finally { chat.stop(); db.db.close(); }
