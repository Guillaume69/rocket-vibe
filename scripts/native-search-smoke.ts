// Actual mobile provider, PostgreSQL, SQLite and WebSocket; no legacy transport.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/providers/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import {createRocketVibeProvider} from '../apps/mobile/providers/rocketvibe/index.ts';
import {RestClient} from '../apps/mobile/lib/rest.ts';

export async function searchSmoke():Promise<void> {
  const base=process.env.RV_PEER_URL!,password=process.env.RV_PEER_PASSWORD!;assert(base&&password);
  const owner=new NativeTransport(base),reader=new NativeTransport(base);
  await owner.login('desktop',password);const account=await reader.login('mobile',password),discovery=await reader.discover();
  const nonce=randomBytes(8).toString('hex');
  const room=await owner.createRoom({operation_id:`search-${nonce}`,name:`Search provider ${nonce}`,private:true});
  await owner.addMember(room.id,account.user.id);
  const root=await owner.send(room.id,{operation_id:`search-root-${nonce}`,text:'provider needle root'});
  const child=await owner.send(room.id,{operation_id:`search-child-${nonce}`,text:'provider needle reply',reply_to:root.id});
  const secret=await owner.createRoom({operation_id:`search-secret-${nonce}`,name:`Secret search ${nonce}`,private:true});
  await owner.send(secret.id,{operation_id:`search-hidden-${nonce}`,text:'hiddenneedle'});
  const session={baseUrl:base,authToken:account.token,userId:account.user.id,username:account.user.username,kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const database=nativeTestDatabase(),store=new NativeStore(database.adapter,createWriteQueue(),session);
  const client=new RestClient(base,{fetch:async()=>{throw new Error('Unexpected RC request');}});client.kind='rocketvibe';
  const provider=createRocketVibeProvider(session,client,()=>randomBytes(12).toString('hex'),store),chat=provider.native!.chat;
  try {
    await chat.connect();assert(provider.capabilities.search);
    // A downloaded result outside the active history window remains ephemeral.
    await database.adapter.runAsync('DELETE FROM messages WHERE id IN (?,?)',[root.id,child.id]);
    const count=(await store.messages(room.id,100)).length,cursor=(await store.state())?.cursor;
    const hits=await provider.searchMessages!(room.id,'needle');
    assert.deepEqual(hits.map(m=>m.id),[child.id,root.id]);assert.equal(hits[0].threadId,root.id);
    assert(hits.every(m=>m.md!==null && m.text.includes('needle')));
    assert.equal((await store.messages(room.id,100)).length,count);assert.equal((await store.state())?.cursor,cursor);
    assert.equal((await provider.searchMessages!(room.id,'hiddenneedle')).length,0);
    await assert.rejects(provider.searchMessages!(secret.id,'hiddenneedle'));
    const version=chat.searchVersion;chat.suspend();assert.notEqual(chat.searchVersion,version);
    await assert.rejects(provider.searchMessages!(room.id,'needle'));
    console.log(JSON.stringify({searchSmoke:true,actualProvider:true,ephemeral:true,scope:true,threads:true,existingRenderer:true,suspension:true}));
  } finally {chat.stop();await new Promise(resolve=>setImmediate(resolve));database.db.close();}
}
