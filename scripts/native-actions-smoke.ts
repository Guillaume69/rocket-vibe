/** Actual mobile SQLite projections consume native action journal events. */
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
  const attempts:{operation_id:string;expected_revision:string;content:{kind:'plain';markdown:string;mentions:string[];quotes:never[];files:string[]}}[]=[];
  let loseEdit=true;
  let loseReaction=true;
  const reactions:{operation_id:string;emoji:string;present:boolean}[]=[];
  const transport=new NativeTransport(base!,async (url,options) => {
    const response=await fetch(url,options);
    if (username==='alice' && options?.method==='PATCH') {
      attempts.push(JSON.parse(String(options.body)));
      if (loseEdit && response.ok) {
        loseEdit=false;
        await response.arrayBuffer();
        return Response.json({code:'simulated_response_lost',request_id:'mobile-edit-smoke'},{status:503});
      }
    }
    if (username==='alice' && options?.method==='PUT' && String(url).endsWith('/reactions')) {
      reactions.push(JSON.parse(String(options.body)));
      if (loseReaction && response.ok) {
        loseReaction=false;
        await response.arrayBuffer();
        return Response.json({code:'simulated_reaction_response_lost',request_id:'mobile-react-smoke'},{status:503});
      }
    }
    return response;
  });
  const discovery=await transport.discover(); const login=await transport.login(username,'test-password-2026');
  const session: Session={genre:'rocketvibe',baseUrl:base!,siteUrl:null,authToken:login.token,userId:login.user.id,username:login.user.username,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const db=nativeTestDatabase(); const store=new NativeStore(db.adapter,creerFileEcritures(),session);
  let serial=0;
  const makeChat=() => new NativeChat(session,store,() => `${username}-action-smoke-${serial++}`,{transport});
  return {transport,db,store,session,makeChat,attempts,reactions};
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
  await assert.rejects(a.edit(room.id,id,original.revision,'Edited message'),/simulated_response_lost/);
  await until(async () => (await alice.store.pendingCommands()).length===0);
  assert.equal(alice.attempts.length,2);
  assert.deepEqual(alice.attempts[0],alice.attempts[1]);
  assert.equal(alice.attempts[1].expected_revision,original.revision);
  const edited=await alice.transport.message(id);
  assert.deepEqual(await alice.transport.editMessage(id,alice.attempts[0]),edited);
  await until(async () => (await bob.store.messages(room.id)).some(m => m.id===id && m.texte===edited.text));
  assert.equal(bob.db.db.prepare('SELECT modifie_le FROM messages WHERE id=?').get(id)!.modifie_le,Date.parse(edited.edited_at!));
  await assert.rejects(a.react(room.id,id,'+1',true),/simulated_reaction_response_lost/);
  await until(async () => (await alice.store.pendingCommands()).length===0);
  assert.equal(alice.reactions.length,2);
  assert.deepEqual(alice.reactions[0],alice.reactions[1]);
  await until(async () => Boolean(bob.db.db.prepare('SELECT reactions FROM messages WHERE id=?').get(id)?.reactions));
  const reacted=await alice.transport.message(id);
  assert.equal(reacted.reactions!.length,1); assert.equal(reacted.position,original.position);
  assert.equal(reacted.edited_at,edited.edited_at);
  await a.react(room.id,id,':thumbsup:',false);
  const removed=await alice.transport.message(id);
  assert.equal(removed.reactions?.length ?? 0,0);
  assert.deepEqual(await alice.transport.setReaction(id,alice.reactions[0]),removed,'an old add receipt cannot resurrect a removed reaction');
  await until(async () => bob.db.db.prepare('SELECT reactions FROM messages WHERE id=?').get(id)?.reactions===null);
  assert.equal((await b.actionContext(id)).permissions.delete,false);
  await assert.rejects(b.delete(room.id,id,edited.revision),/permission_denied/);
  assert.equal((await bob.store.pendingCommands()).length,0,'forbidden deletion must not retry');
  b.stop(); // Miss the deletion and all following events with a populated cache.
  await bob.store.drafts().ecrire(room.id,'Draft across reset');
  await bob.store.enqueue('bob-pending-reset',room.id,'Pending across reset');
  await a.delete(room.id,id,removed.revision);
  const deleted=await alice.transport.message(id);
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
  console.log('Native mobile actions: lost edit and reaction responses replay original SQLite intents on live WebSocket, emoji aliases converge, old add receipts cannot revert removals, permissions enforced, edit marker unchanged, tombstone erasure, bounded reset and preserved drafts/outbox');
} finally {a.stop(); b.stop(); await alice.store.state(); await bob.store.state(); alice.db.db.close(); bob.db.db.close();}
