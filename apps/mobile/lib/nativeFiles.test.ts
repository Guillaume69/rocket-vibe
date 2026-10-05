import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestClient} from './rest.ts';
import {setNativeFiles,loadNativeFile} from './nativeFiles.ts';
import {protectedFileUrl} from './upload.ts';
test('native media handles contain no credentials and retire with the active account',async()=>{
  const client=new RestClient('https://native.example');client.auth={userId:'alice',authToken:'secret'};client.kind='rocketvibe';
  let version=0;
  const remove=setNativeFiles(client,async id=>`file:///private/${id}`,undefined,()=>version),uri=protectedFileUrl(client,'/api/v1/files/file');
  assert(uri.startsWith('rv-file:'));assert(!uri.includes('secret'));assert.equal(await loadNativeFile(uri),'file:///private/file');
  assert.equal(protectedFileUrl(client,'https://other.example/api/v1/files/file'),'rv-file:unavailable');
  version++;await assert.rejects(loadNativeFile(uri),/file_scope_closed/);
  assert.equal(await loadNativeFile(protectedFileUrl(client,'/api/v1/files/file')),'file:///private/file');
  remove();await assert.rejects(loadNativeFile(uri),/file_scope_closed/);
});
test('an old asynchronous download cannot return a path after a provider replacement',async()=>{
  const client=new RestClient('https://native.example');client.kind='rocketvibe';let release!:(value:string)=>void;
  const remove=setNativeFiles(client,()=>new Promise(resolve=>{release=resolve;}));
  const old=loadNativeFile(protectedFileUrl(client,'/api/v1/files/file'));
  const fresh=setNativeFiles(client,async()=> 'file:///fresh');release('file:///old');
  await assert.rejects(old,/file_scope_closed/);remove();assert.equal(await loadNativeFile(protectedFileUrl(client,'/api/v1/files/file')),'file:///fresh');fresh();
});
