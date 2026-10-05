import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {NativeError,NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {NativeChat} from '../apps/mobile/providers/rocketvibe/chat.ts';
import {NativeStore} from '../apps/mobile/providers/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import {NativeFileOutbox} from '../apps/mobile/providers/rocketvibe/uploads.ts';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const base=process.env.RV_FILE_TEST_SERVER!;
let loseBytes=true,loseComplete=true;
const transport=new NativeTransport(base,async(input,options)=>{
 const url=new URL(String(input));assert.equal(url.origin,new URL(base).origin);assert.equal(options?.redirect,'error');
 const response=await fetch(input,options);
 if(response.ok && (loseBytes && url.pathname.endsWith('/bytes') || loseComplete && url.pathname.endsWith('/complete'))){
  if(url.pathname.endsWith('/bytes'))loseBytes=false;else loseComplete=false;
  await response.arrayBuffer();throw new Error('Injected lost acknowledgement');
 }
 return response;
});
const discovery=await transport.discover();assert.equal(discovery.capabilities.uploads,true);
await transport.login('mobile','files-test-password');
const room=await transport.createRoom({operation_id:randomUUID(),name:'Portable file lifecycle',private:true});
const bytes=new Uint8Array(420_000);bytes.fill(7);const sha=createHash('sha256').update(bytes).digest('hex');
const prepare={operation_id:randomUUID(),room_id:room.id,bytes:String(bytes.length),sha256:sha,media_type:'application/octet-stream',filename:'portable.bin',encrypted:false};
const upload=await transport.prepareUpload(prepare);assert.equal((await transport.prepareUpload(prepare)).id,upload.id);
await assert.rejects(transport.uploadBytes(upload.id,bytes.buffer),e=>e instanceof NativeError && e.code==='network_or_protocol_error');
assert.equal((await transport.uploadStatus(upload.id)).state,'ready');await transport.uploadBytes(upload.id,bytes.buffer);
const complete={operation_id:randomUUID(),content:{kind:'plain' as const,markdown:'',mentions:[],quotes:[],files:[upload.id]},reply_to:null};
await assert.rejects(transport.completeUpload(upload.id,complete),e=>e instanceof NativeError && e.code==='network_or_protocol_error');
const confirmed=await transport.completeUpload(upload.id,complete);assert.equal((await transport.uploadStatus(upload.id)).message_id,confirmed.id);
const history=await transport.history(room.id);const messages=history.messages.filter(m=>m.system==null);assert.equal(messages.length,1);assert.equal(messages[0].files![0].id,upload.id);
const downloaded=await transport.fileBytes(confirmed.files![0]);assert.equal(createHash('sha256').update(downloaded).digest('hex'),sha);
assert.equal((await transport.snapshot()).messages.find(m=>m.id===confirmed.id)?.files?.[0].bytes,prepare.bytes);
const cancelled=await transport.prepareUpload({...prepare,operation_id:randomUUID()});assert.equal((await transport.cancelUpload(cancelled.id)).state,'cancelled');
await assert.rejects(transport.uploadBytes(cancelled.id,bytes.buffer),e=>e instanceof NativeError && e.code==='upload_cancelled');
console.log(JSON.stringify({file_lifecycle:'passed',lost_byte_ack:'recovered',lost_message_ack:'one_message',bytes:downloaded.length}));

// Exercise the exact app outbox and actual SQLite across a process-style restart.
for(const lost of ['prepare','bytes','complete','cancel']){
 const directory=mkdtempSync(join(tmpdir(),'rv-upload-runner-')),database=join(directory,'account.sqlite'),source=join(directory,'original');
 writeFileSync(source,bytes);let inject=true,removed=0;
 const fetcher:typeof fetch=async(input,options)=>{
  const response=await fetch(input,options),path=new URL(String(input)).pathname;
  if(response.ok&&inject&&((lost==='prepare'||lost==='cancel')&&path==='/api/v1/uploads'||lost==='complete'&&path.endsWith('/complete'))){inject=false;await response.arrayBuffer();throw new Error('Lost upload reply');}
  return response;
 };
 const remote=new NativeTransport(base,fetcher),auth=await remote.login(`mobile-${lost}`,'files-test-password'),discovery=await remote.discover();
 const room=await remote.createRoom({operation_id:randomUUID(),name:`Outbox ${lost}`,private:true});
 const session={baseUrl:base,authToken:auth.token,userId:auth.user.id,username:auth.user.username,kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
 let h=nativeTestDatabase(database),store=new NativeStore(h.adapter,createWriteQueue(),session),chat=new NativeChat(session,store,randomUUID,{transport:remote});
 const io={copy:async()=>({uri:pathToFileURL(source).toString(),bytes:bytes.length,sha256:sha}),remove:async()=>{removed++;},
  send:async(url:string,headers:Record<string,string>,uri:string,signal:AbortSignal)=>{
   const response=await fetch(url,{method:'PUT',headers,body:readFileSync(fileURLToPath(uri)),redirect:'error',signal}),body=await response.text();
   if(response.ok&&inject&&lost==='bytes'){inject=false;throw new NativeError(0,'lost_byte_reply');}
   return {status:response.status,body};
  },
 };
 let outbox=new NativeFileOutbox(chat,io,randomUUID);
 try{
  await chat.connect();await outbox.send(room.id,{uri:pathToFileURL(source).toString(),name:'persisted.bin',type:'application/octet-stream',size:bytes.length},'Original caption');
  assert.equal(inject,false);const pending=(await store.uploads.list())[0];assert(pending);assert.equal(pending.complete.content.kind,'plain');
  if(lost==='cancel'){chat.suspend();await outbox.discard(pending.id);assert.equal((await store.uploads.get(pending.id))?.phase,'cancelling');}
  outbox.close();chat.stop();await store.state();h.db.close();
  h=nativeTestDatabase(database,false);store=new NativeStore(h.adapter,createWriteQueue(),session);chat=new NativeChat(session,store,()=>{throw new Error('Replay generated a new nonce');},{transport:remote});
  outbox=new NativeFileOutbox(chat,io,()=>{throw new Error('Replay generated a new nonce');});
  await chat.connect();await outbox.process();assert.deepEqual(await store.uploads.list(),[]);assert.equal(removed,1);
  const messages=(await remote.history(room.id)).messages.filter(m=>!m.system);
  if(lost==='cancel')assert.equal(messages.length,0);
  else{assert.equal(messages.length,1);assert.equal(messages[0].id,pending.complete.operation_id);assert.equal(messages[0].text,'Original caption');
    const access=await store.fileAccess(messages[0].files![0].id);assert(access);assert.equal(access.file.sha256,sha);}
 }finally{outbox.close();chat.stop();await store.state();h.db.close();unlinkSync(database);unlinkSync(source);rmdirSync(directory);}
}
console.log(JSON.stringify({mobile_outbox:'passed',restart_after_lost_prepare:'one_message',restart_after_lost_bytes:'one_message',restart_after_lost_complete:'one_message',offline_cancel:'no_message'}));
