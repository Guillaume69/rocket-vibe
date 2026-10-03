import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {NativeError,NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';

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
