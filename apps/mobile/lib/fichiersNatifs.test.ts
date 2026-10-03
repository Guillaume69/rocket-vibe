import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ClientRest} from './rest.ts';
import {definirFichiersNatifs,chargerFichierNatif} from './fichiersNatifs.ts';
import {urlFichierProtege} from './upload.ts';
test('native media handles contain no credentials and retire with the active account',async()=>{
  const client=new ClientRest('https://native.example');client.identifiants={userId:'alice',authToken:'secret'};client.genre='rocketvibe';
  let version=0;
  const remove=definirFichiersNatifs(client,async id=>`file:///private/${id}`,undefined,()=>version),uri=urlFichierProtege(client,'/api/v1/files/file');
  assert(uri.startsWith('rv-file:'));assert(!uri.includes('secret'));assert.equal(await chargerFichierNatif(uri),'file:///private/file');
  assert.equal(urlFichierProtege(client,'https://other.example/api/v1/files/file'),'rv-file:unavailable');
  version++;await assert.rejects(chargerFichierNatif(uri),/file_scope_closed/);
  assert.equal(await chargerFichierNatif(urlFichierProtege(client,'/api/v1/files/file')),'file:///private/file');
  remove();await assert.rejects(chargerFichierNatif(uri),/file_scope_closed/);
});
test('an old asynchronous download cannot return a path after a provider replacement',async()=>{
  const client=new ClientRest('https://native.example');client.genre='rocketvibe';let release!:(value:string)=>void;
  const remove=definirFichiersNatifs(client,()=>new Promise(resolve=>{release=resolve;}));
  const old=chargerFichierNatif(urlFichierProtege(client,'/api/v1/files/file'));
  const fresh=definirFichiersNatifs(client,async()=> 'file:///fresh');release('file:///old');
  await assert.rejects(old,/file_scope_closed/);remove();assert.equal(await chargerFichierNatif(urlFichierProtege(client,'/api/v1/files/file')),'file:///fresh');fresh();
});
