/** Actual mobile SQLite projections consume native edit/delete journal events. */
import assert from 'node:assert/strict';
import { NativeTransport } from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import { NativeChat } from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import { NativeStore } from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import { nativeTestDatabase } from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import { creerFileEcritures } from '../apps/mobile/db/fileEcritures.ts';
import type { Session } from '../apps/mobile/lib/auth.ts';
const base=process.env.RV_SMOKE_URL;
if (!base) throw new Error('RV_SMOKE_URL is required');
async function runner(username:string) {
  const transport=new NativeTransport(base!);
  const discovery=await transport.discover(); const login=await transport.login(username,'test-password-2026');
  const session: Session={genre:'rocketvibe',baseUrl:base!,siteUrl:null,authToken:login.token,userId:login.user.id,username:login.user.username,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const db=nativeTestDatabase(); const store=new NativeStore(db.adapter,creerFileEcritures(),session);
  let serial=0;
  const makeChat=() => new NativeChat(session,store,() => `${username}-action-smoke-${serial++}`);
  return {transport,db,store,session,makeChat};
}
async function until(check:()=>Promise<boolean>) {
  const deadline=Date.now()+10_000;
  while (!await check()) {if (Date.now()>deadline) throw new Error('Native action projection timeout'); await new Promise(resolve => setTimeout(resolve,20));}
}
const alice=await runner('alice'), bob=await runner('bob');
const room=await alice.transport.createRoom({name:'Action projections',private:true,operation_id:'action-projection-room'});
await alice.transport.addMember(room.id,bob.session.userId);
const a=alice.makeChat(); let b=bob.makeChat();
try {
  await a.connect(); await b.connect();
  const id=await a.send(room.id,'Original message');
  await until(async () => (await bob.store.messages(room.id)).some(m => m.id===id));
  const original=await alice.transport.message(id);
  const edit={operation_id:'native-mobile-edit',expected_revision:original.revision,content:{kind:'plain' as const,markdown:'Edited message',mentions:[],quotes:[],files:[]}};
  const edited=await alice.transport.editMessage(id,edit);
  assert.deepEqual(await alice.transport.editMessage(id,edit),edited);
  await until(async () => (await bob.store.messages(room.id)).some(m => m.id===id && m.texte===edited.text));
  assert.equal(bob.db.db.prepare('SELECT modifie_le FROM messages WHERE id=?').get(id)!.modifie_le,Date.parse(edited.edited_at!));
  b.stop(); // Miss the deletion and all following events with a populated cache.
  await bob.store.drafts().ecrire(room.id,'Draft across reset');
  await bob.store.enqueue('bob-pending-reset',room.id,'Pending across reset');
  const deleted=await alice.transport.deleteMessage(id,{operation_id:'native-mobile-delete',expected_revision:edited.revision});
  assert.ok(deleted.deleted);
  await until(async () => !(await alice.store.messages(room.id)).some(m => m.id===id));
  await alice.store.ingest([original]);
  assert.ok(!(await alice.store.messages(room.id)).some(m => m.id===id),'late HTTP history cannot defeat a journal tombstone');
  for (let i=0;i<51;i++) await a.send(room.id,`Recent ${i}`);
  const oldProjection=bob.store.projectionToken();
  const reset=await bob.transport.snapshot();
  assert.ok(!reset.messages.some(m => m.id===id),'the deleted old position falls outside the recent 50-message snapshot');
  await bob.store.applySnapshot(reset);
  assert.equal(await bob.store.ingest([original],oldProjection),false);
  assert.ok(!(await bob.store.messages(room.id)).some(m => m.id===id));
  assert.equal(await bob.store.drafts().lire(room.id),'Draft across reset');
  assert.equal((await bob.store.pending())[0].id,'bob-pending-reset');
  b=bob.makeChat(); await b.connect();
  await until(async () => (await bob.store.pending()).length===0);
  assert.equal((await alice.transport.history(room.id)).messages.filter(m => m.id==='bob-pending-reset').length,1);
  console.log('Native mobile actions: real WebSocket edit marker, tombstone erasure, lost events beyond snapshot window, draft/outbox retained and stale history rejected');
} finally {a.stop(); b.stop(); await alice.store.state(); await bob.store.state(); alice.db.db.close(); bob.db.db.close();}
