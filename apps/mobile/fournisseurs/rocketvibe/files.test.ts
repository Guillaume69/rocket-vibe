import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NativeError,NativeTransport} from './transport.ts';
import type {FileDescriptor,Upload} from './protocol.generated.ts';

const file:FileDescriptor={id:'a'.repeat(64),room_id:'room',bytes:'3',sha256:'b'.repeat(64),media_type:'application/octet-stream',filename:'photo.bin',encrypted:false};
const upload:Upload={id:file.id,file,state:'prepared',expires_at:'2026-10-04T12:00:00Z',message_id:null};
test('file transfers keep credentials in headers on the pinned origin and retain operation identities',async()=>{
 const calls:{url:URL;options:RequestInit}[]=[];
 const transport=new NativeTransport('https://native.example',async(input,options)=>{
  const url=new URL(String(input));calls.push({url,options:options!});
  return url.pathname.startsWith('/api/v1/files/')?new Response(new Uint8Array([1,2,3]),{headers:{'content-type':file.media_type,'content-length':'3'}}):new Response(JSON.stringify(upload));
 });transport.restore('private-token');
 const prepare={operation_id:'stable-prepare',room_id:file.room_id,bytes:file.bytes,sha256:file.sha256,media_type:file.media_type,filename:file.filename,encrypted:false};
 assert.equal((await transport.prepareUpload(prepare)).id,file.id);await transport.prepareUpload(prepare);
 assert.deepEqual(calls.slice(0,2).map(c=>JSON.parse(c.options.body as string).operation_id),['stable-prepare','stable-prepare']);
 await transport.uploadBytes(file.id,new Uint8Array([1,2,3]).buffer);assert.equal(calls.at(-1)!.options.method,'PUT');
 assert.equal((await transport.uploadStatus(file.id)).state,'prepared');await transport.cancelUpload(file.id);assert.equal(calls.at(-1)!.options.method,'DELETE');
 assert.deepEqual(await transport.fileBytes(file),new Uint8Array([1,2,3]));
 await transport.uploadStatus('https://other.example/path?token=steal');assert.equal(calls.at(-1)!.url.origin,'https://native.example');assert(!calls.at(-1)!.url.search);
 for(const call of calls){assert.equal(call.options.redirect,'error');assert.equal((call.options.headers as Record<string,string>).authorization,'Bearer private-token');assert(!call.url.href.includes('private-token'));}
});
test('file bytes reject a changed media type, truncation and oversized replies while old avatars stay bounded',async()=>{
 let response=new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'text/html'}});
 const transport=new NativeTransport('https://native.example',async()=>response);transport.restore('token');
 await assert.rejects(transport.fileBytes(file),(e:unknown)=>e instanceof NativeError&&e.code==='invalid_file');
 response=new Response(new Uint8Array([1,2]),{headers:{'content-type':file.media_type}});
 await assert.rejects(transport.fileBytes(file),/invalid_file/);
 response=new Response(new Uint8Array([1,2,3,4]),{headers:{'content-type':file.media_type,'content-length':'4'}});
 await assert.rejects(transport.fileBytes(file),/invalid_file/);
 await assert.rejects(transport.fileBytes({...file,bytes:'104857601'}),/invalid_file/);
 await assert.rejects(transport.fileBytes({...file,encrypted:true}),/invalid_file/);
});
