// Existing mobile provider, HTTP/PostgreSQL and disk SQLite; only socket echoes are suppressed.
import assert from 'node:assert/strict';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import type {SQLiteDatabase} from 'expo-sqlite';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {NativeError,NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {creerDepotEnvoi} from '../apps/mobile/db/depot.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import type {SendMessage} from '../apps/mobile/fournisseurs/rocketvibe/protocol.generated.ts';

export async function threadSmoke():Promise<void>{
  const base=process.env.RV_PEER_URL!,password=process.env.RV_PEER_PASSWORD!;
  assert(base && password);
  const owner=new NativeTransport(base),reader=new NativeTransport(base);
  const ownerAccount=await owner.login('desktop',password),account=await reader.login('mobile',password);
  const discovery=await reader.discover();assert.equal(discovery.capabilities.threads,true);
  const nonce=randomBytes(8).toString('hex');
  const room=await owner.createRoom({operation_id:`thread-room-${nonce}`,name:`Thread provider ${nonce}`,private:true});
  await owner.addMember(room.id,account.user.id);
  const root=await owner.send(room.id,{operation_id:`thread-root-${nonce}`,text:'First thread'});
  const other=await owner.send(room.id,{operation_id:`thread-other-${nonce}`,text:'Second thread'});
  await reader.markRoomRead(room.id,{root_position:other.position,reply_position:'0'});
  const firstReply=await owner.send(room.id,{operation_id:`thread-first-${nonce}`,text:'Visible first-thread reply',reply_to:root.id});
  await owner.send(room.id,{operation_id:`thread-second-${nonce}`,text:'Other thread remains unread',reply_to:other.id});
  assert.equal((await reader.roomReadState(room.id)).unread_replies,'2');
  const session={baseUrl:base,authToken:account.token,userId:account.user.id,username:account.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const dir=mkdtempSync(join(tmpdir(),'rv-thread-peer-')),filename=join(dir,'cache.sqlite');
  let h=nativeTestDatabase(filename),store=new NativeStore(h.adapter,creerFileEcritures(),session);
  const chats:NativeChat[]=[];
  const socket=()=>{
    const value={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>value.onopen?.(new Event('open')));return value;
  };
  try{
    await store.applySnapshot(await reader.snapshot());
    const grant=(await store.readState(room.id))!.membership_version!;
    const drafts=store.drafts({room:room.id,membership:grant});
    await drafts.ecrire(room.id,'Room words');await drafts.ecrire(`${room.id}:${root.id}`,'Thread words');
    const losing=new NativeTransport(base);losing.restore(account.token);
    const attempts:SendMessage[]=[];
    losing.send=async(rid,input)=>{attempts.push(structuredClone(input));await reader.send(rid,input);throw new NativeError(503,'response_lost');};
    const provider=creerFournisseurRV(session,new ClientRest(base),()=>`thread-send-${nonce}`,store,{transport:losing,socket});
    const first=provider.native!.chat;chats.push(first);await first.connect();
    assert.equal(provider.capacites.fils,true);assert.equal(provider.capacites.modeleFil,'root_id');
    await provider.chargerFil({} as never,root.id,()=>false);
    const id=await provider.creerEnvoi(creerDepotEnvoi(h.adapter as SQLiteDatabase,creerFileEcritures()),async()=>{}).envoyer(room.id,'Durable mobile thread reply',root.id);
    first.stop();assert.equal(attempts.length,1);assert.equal(attempts[0].reply_to,root.id);
    assert.equal((await store.pending())[0].reply_to,root.id);
    const current=await owner.message(root.id);
    await owner.deleteMessage(root.id,{operation_id:`thread-delete-${nonce}`,expected_revision:current.revision});
    await first.flushStateIntents();await store.state();
    h.db.close();h=nativeTestDatabase(filename,false);store=new NativeStore(h.adapter,creerFileEcritures(),session);
    assert.equal(await store.drafts().lire(room.id),'Room words');
    assert.equal(await store.drafts().lire(`${room.id}:${root.id}`),'Thread words');
    const restored=(await store.pending())[0];
    assert.deepEqual({operation_id:restored.id,text:restored.texte,quotes:restored.quotes,reply_to:restored.reply_to},attempts[0]);
    const secondProvider=creerFournisseurRV(session,new ClientRest(base),()=>`thread-fresh-${nonce}`,store,{transport:reader,socket});
    const second=secondProvider.native!.chat;chats.push(second);await second.connect();
    await secondProvider.chargerFil({} as never,root.id,()=>false);
    const page=await reader.thread(root.id);
    assert.equal(page.root.deleted,true);assert.equal(page.messages.filter(m=>m.id===id).length,1);
    assert.equal(page.root.thread?.replies,'2');assert.equal((await store.pending()).length,0);
    assert.equal(h.db.prepare('SELECT fil_id FROM messages WHERE id=?').get(id)!.fil_id,root.id);
    assert.equal((await reader.history(room.id)).messages.some(m=>m.reply_to!=null),false);
    await assert.rejects(second.send(room.id,'New response after deletion',{membership:grant},[],root.id),/root unavailable/);
    await second.markObservedThreadRead(root.id,firstReply.id,grant);
    assert.equal((await reader.thread(root.id)).read_state.unread,'0');
    assert.equal((await reader.thread(other.id)).read_state.unread,'1');
    assert.equal((await reader.roomReadState(room.id)).unread_replies,'1');
    assert.equal((await store.readState(room.id))!.unread_replies,'1');
    const retainedDrafts=store.drafts({room:room.id,membership:grant});
    const withdrawn=await fetch(`${base}/api/v1/rooms/${room.id}/members/${account.user.id}`,{method:'DELETE',headers:{authorization:`Bearer ${ownerAccount.token}`}});assert.equal(withdrawn.status,204);
    let cursor=(await store.state())!.cursor;
    for(let pages=0;pages<100;pages++){
      const batch=await reader.changes(cursor);await store.applyBatch(batch);cursor=batch.cursor;
      if(!batch.has_more)break;assert(pages<99,'thread catch-up stalled');
    }
    assert.equal(await store.drafts().lire(`${room.id}:${root.id}`),null);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM messages WHERE rid=?').get(room.id)!.n,0);
    assert.equal((await store.pendingThreadReads()).length,0);
    await retainedDrafts.ecrire(`${room.id}:${root.id}`,'Late private callback');
    assert.equal(await store.drafts().lire(`${room.id}:${root.id}`),null);
    console.log(JSON.stringify({nativeThreadProvider:true,actualPostgres:true,existingOutbox:true,lostResponse:true,sqliteRestart:true,rootDeletionReplay:true,separateDrafts:true,independentReads:true,withdrawalPurge:true}));
  }catch(error){console.error(error instanceof Error?error.stack:error);throw error;}
  finally{for(const chat of chats)chat.stop();await Promise.all(chats.map(chat=>chat.flushStateIntents()));await store.state();h.db.close();unlinkSync(filename);rmdirSync(dir);}
}
