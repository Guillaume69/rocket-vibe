// Actual native runner + HTTP/PostgreSQL + durable SQLite, with disposable actors.
import assert from 'node:assert/strict';
import {mkdtempSync,rmdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {NativeError,NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import type {SendMessage} from '../apps/mobile/fournisseurs/rocketvibe/protocol.generated.ts';

export async function quoteSmoke():Promise<void> {
  const base=process.env.RV_PEER_URL!,password=process.env.RV_PEER_PASSWORD!;
  assert(base && password);
  const readyUntil=Date.now()+30_000;
  while(true){
    try {if((await fetch(`${base}/health/ready`,{signal:AbortSignal.timeout(2000)})).ok)break;}catch{}
    assert(Date.now()<readyUntil,'quote server did not become ready');await new Promise(resolve=>setTimeout(resolve,100));
  }
  const owner=new NativeTransport(base),reader=new NativeTransport(base);
  const ownerAccount=await owner.login(process.env.RV_QUOTES_OWNER??'desktop',password);
  const account=await reader.login(process.env.RV_QUOTES_READER??'mobile',password),discovery=await reader.discover();
  const nonce=randomBytes(8).toString('hex');
  const destination=await owner.createRoom({operation_id:`quote-destination-${nonce}`,name:`Quote destination ${nonce}`,private:true});
  const origin=await owner.createRoom({operation_id:`quote-origin-${nonce}`,name:`Quote origin ${nonce}`,private:true});
  await owner.addMember(destination.id,account.user.id);await owner.addMember(origin.id,account.user.id);
  const source=await owner.send(origin.id,{operation_id:`quote-source-${nonce}`,text:'*Source privée* _autorisée_'});
  const session={baseUrl:base,authToken:account.token,userId:account.user.id,username:account.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const dir=mkdtempSync(join(tmpdir(),'rv-quote-peer-')),filename=join(dir,'cache.sqlite');
  let harness=nativeTestDatabase(filename),store=new NativeStore(harness.adapter,creerFileEcritures(),session);
  const chats:NativeChat[]=[];
  const socket=()=>{
    const value={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
    queueMicrotask(()=>value.onopen?.(new Event('open')));return value;
  }; // Suppress socket echoes to exercise an HTTP response lost after commit.
  try {
    await store.applySnapshot(await reader.snapshot());
    const selected=await store.quoteSelection(origin.id,source.id),grant=(await store.readState(destination.id))!.membership_version!;
    const losing=new NativeTransport(base);losing.restore(account.token);
    const attempts:SendMessage[]=[];
    losing.send=async(rid,input)=>{attempts.push(structuredClone(input));await reader.send(rid,input);throw new NativeError(503,'response_lost');};
    const first=new NativeChat(session,store,()=>`quote-send-${nonce}`,{transport:losing,socket});chats.push(first);
    await first.connect();
    const id=await first.send(destination.id,'Ma réponse',{membership:grant},[selected]);
    first.stop();assert.equal(attempts.length,1);
    const pending=(await store.pending())[0];assert.equal(pending.id,id);assert.deepEqual(pending.quotes,[selected.reference]);
    const removed=await fetch(`${base}/api/v1/rooms/${origin.id}/members/${account.user.id}`,{method:'DELETE',headers:{authorization:`Bearer ${ownerAccount.token}`}});assert.equal(removed.status,204);
    harness.db.close();harness=nativeTestDatabase(filename,false);store=new NativeStore(harness.adapter,creerFileEcritures(),session);
    const restored=(await store.pending())[0];assert.deepEqual(restored,pending);
    const retry={operation_id:restored.id,text:restored.texte,quotes:restored.quotes};assert.deepEqual(retry,attempts[0]);
    const replay=await reader.send(destination.id,retry);
    assert.equal(replay.id,id);assert.equal(replay.quotes![0].excerpt,null);
    await store.ingest([replay]);
    let cursor=(await store.state())!.cursor;
    for(let pages=0;pages<100;pages++){
      const changes=await reader.changes(cursor);await store.applyBatch(changes);cursor=changes.cursor;
      if(!changes.has_more)break;
      assert(pages<99,'quote catch-up stalled');
    }
    const cards=JSON.parse(harness.db.prepare('SELECT pieces_jointes FROM messages WHERE id=?').get(id)!.pieces_jointes as string);
    assert.equal(cards[0].native_unavailable,true);assert.equal(cards[0].text,'');assert.equal(cards[0].author_name,undefined);
    assert.equal(harness.db.prepare('SELECT id FROM messages WHERE id=?').get(source.id),undefined);
    assert.equal((await reader.history(destination.id)).messages.filter(m=>m.id===id).length,1);
    assert.deepEqual(await store.pending(),[]);

    // A source edited after enqueue rejects that immutable intent, without losing words.
    const secondSource=await owner.send(destination.id,{operation_id:`quote-second-source-${nonce}`,text:'Avant édition'});
    await store.ingest([secondSource]);
    const secondSelection=await store.quoteSelection(destination.id,secondSource.id);
    await store.enqueue(`quote-conflict-${nonce}`,destination.id,'Mots conservés',{membership:grant},[secondSelection]);
    await owner.editMessage(secondSource.id,{operation_id:`quote-edit-source-${nonce}`,expected_revision:secondSource.revision,content:{kind:'plain',markdown:'Après édition',mentions:[],quotes:[],files:[]}});
    const second=new NativeChat(session,store,()=>`quote-fresh-${nonce}`,{transport:reader,socket});chats.push(second);
    await second.connect();
    const failed=harness.db.prepare('SELECT texte,statut,derniere_erreur FROM sortie WHERE id=?').get(`quote-conflict-${nonce}`)!;
    assert.equal(failed.statut,'echec');assert.equal(failed.texte,'Mots conservés');assert.equal(failed.derniere_erreur,'quote_revision_conflict');
    const fresh=await store.quoteSelection(destination.id,secondSource.id);
    const freshId=await second.send(destination.id,'Mots conservés',{membership:grant},[fresh]);
    assert.equal((await reader.history(destination.id)).messages.filter(m=>m.id===freshId).length,1);
    assert.deepEqual(await store.pending(),[]);
    console.log(JSON.stringify({nativeQuoteRunner:true,actualPostgres:true,lostResponse:true,sqliteRestart:true,sourceWithdrawal:true,immutableConflict:true,freshSelection:true}));
  }finally {for(const chat of chats)chat.stop();await store.state();harness.db.close();unlinkSync(filename);rmdirSync(dir);}
}
