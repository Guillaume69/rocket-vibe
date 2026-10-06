import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {objectSize,PRIVATE_FILE_MAX,sendPrivateFile} from './privateFiles.ts';
import {privateFileAttachments,privateRow} from './cryptoProjection.ts';
import {NativeError} from './transport.ts';
import type {CryptoMessage} from './cryptoConversations.ts';

const vector=JSON.parse(readFileSync(new URL('../../../../crates/rv-crypto-public/fixtures/file-v1.json',import.meta.url),'utf8'));
const sealed={key:'k'.repeat(43),bytes:'5',sha256:'a'.repeat(64),object_bytes:String(objectSize(5)),object_sha256:'b'.repeat(64)};

test('object sizes match the Rust format and its limit',()=>{
  for(const c of vector.cases)assert.equal(String(objectSize(Number(c.bytes))),c.object_bytes);
  assert.equal(objectSize(PRIVATE_FILE_MAX),100*1024*1024);
  assert.ok(objectSize(PRIVATE_FILE_MAX+1)>100*1024*1024);
});

function fixture(fail?:'upload'|'send') {
  const calls:string[]=[];let prepared:unknown=null,sent:unknown=null;
  const upload=(state:string)=>({id:'upload-1',state,expires_at:'2099-01-01T00:00:00Z',message_id:null,
    file:{id:'upload-1',room_id:'room',bytes:sealed.object_bytes,sha256:sealed.object_sha256,media_type:'application/octet-stream',filename:null,encrypted:true}});
  const transport={
    prepareUpload:async(input:unknown)=>{prepared=input;calls.push('prepare');return upload('prepared');},
    uploadLocal:async(id:string,uri:string)=>{calls.push(`bytes:${id}:${uri}`);if(fail==='upload')throw new NativeError(0,'network_error');return upload('ready');},
    cancelUpload:async(id:string)=>{calls.push(`cancel:${id}`);return upload('cancelled');},
  };
  const access={send:async(text:string,quotes:unknown[],files:unknown[])=>{sent={text,quotes,files};calls.push('send');
    if(fail==='send')throw new NativeError(0,'network_error');return 'operation';}};
  const crypto={sealFile:async(source:string,target:string)=>{calls.push(`seal:${source}:${target}`);return JSON.stringify(sealed);},openFile:async()=>{}};
  const run=()=>sendPrivateFile({crypto,transport:transport as never,send:async()=>({status:200,body:''}),access:access as never,
    room:'room',file:{uri:'file:///picked/photo.png',name:'photo privée.png',type:'image/png'},caption:'caption',
    object:'file:///cache/private-outbox/x',operation:'op-1',progress:()=>{},signal:new AbortController().signal});
  return {calls,run,get prepared(){return prepared;},get sent(){return sent;}};
}

test('a private file is sealed, uploaded opaque, then sent with its descriptor',async()=>{
  const f=fixture();
  assert.equal(await f.run(),'operation');
  assert.deepEqual(f.calls,['seal:file:///picked/photo.png:file:///cache/private-outbox/x','prepare','bytes:upload-1:file:///cache/private-outbox/x','send']);
  assert.deepEqual(f.prepared,{operation_id:'op-1',room_id:'room',bytes:sealed.object_bytes,sha256:sealed.object_sha256,
    media_type:'application/octet-stream',filename:null,encrypted:true});
  assert.deepEqual(f.sent,{text:'caption',quotes:[],files:[{id:'upload-1',key:sealed.key,filename:'photo privée.png',media_type:'image/png',bytes:'5',sha256:sealed.sha256}]});
});

test('a failure before the message releases the reservation, after it the outbox keeps it',async()=>{
  const lost=fixture('upload');
  await assert.rejects(lost.run());
  assert.deepEqual(lost.calls.slice(-1),['cancel:upload-1']);
  const pending=fixture('send');
  await assert.rejects(pending.run());
  assert.ok(!pending.calls.some(c=>c.startsWith('cancel')));
});

test('private rows show their files like native ones, previews for allowed types only',()=>{
  const files=[{id:'f1',key:'k',filename:'a.png',media_type:'image/png',bytes:'10',sha256:'a'.repeat(64)},
    {id:'f2',key:'k',filename:'b.svg',media_type:'image/svg+xml',bytes:'3',sha256:'a'.repeat(64)}];
  assert.deepEqual(privateFileAttachments(files),[
    {type:'file',title:'a.png',title_link:'/api/v1/files/f1',size:10,image_url:'/api/v1/files/f1',image_type:'image/png',image_size:10},
    {type:'file',title:'b.svg',title_link:'/api/v1/files/f2',size:3}]);
  const row={id:'m',operation:'m',author:'alice',position:'1',observed_at:'1',status:'journaled',
    document:{operation_id:'m',text:'',files:[files[0]]}} as CryptoMessage;
  assert.equal(JSON.parse(privateRow(row,'room').attachments!)[0].title_link,'/api/v1/files/f1');
});
