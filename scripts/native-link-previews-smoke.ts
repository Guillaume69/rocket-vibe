/** HTTP/WebSocket/SQLite bench; only discovery's still-gated capability is enabled here. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import type {Fournisseur} from '../apps/mobile/lib/fournisseur.ts';
import {apercusDeLien} from '../apps/mobile/lib/apercuLien.ts';
import {chargerApercuNatif,monterApercusNatifs,photoApercuNatif,uriApercuNatif} from '../apps/mobile/lib/apercusNatifs.ts';

const base=process.env.RV_PREVIEW_TEST_SERVER!,id=process.env.RV_PREVIEW_TEST_MESSAGE!;
let imageReads=0;
const transport=new NativeTransport(base,async(input,options)=>{
  const url=new URL(String(input));assert.equal(url.origin,new URL(base).origin);assert.equal(options?.redirect,'error');
  const response=await fetch(input,options);
  if(url.pathname.includes('/previews/')){imageReads++;assert(new Headers(options?.headers).get('authorization')?.startsWith('Bearer '));assert.equal(url.search,'');}
  if(url.pathname==='/.well-known/rocketvibe'&&response.ok){const discovery=await response.json();return Response.json({...discovery,capabilities:{...discovery.capabilities,link_previews:true}});}
  return response;
});
const discovery=await transport.discover(),auth=await transport.login('owner','test-password-2026');
const session={baseUrl:base,authToken:auth.token,userId:auth.user.id,username:auth.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session),chat=new NativeChat(session,store,randomUUID,{transport});
const client=new ClientRest(base);client.genre='rocketvibe';
let unmount:()=>void=()=>{};
async function until(check:()=>Promise<boolean>|boolean){const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw new Error('Preview event did not reach the app');await new Promise<void>(r=>setTimeout(r,20));}}
async function urls(){await store.state();const row=h.db.prepare('SELECT urls FROM messages WHERE id=?').get(id) as {urls:string|null}|undefined;assert(row);return row.urls;}
try{
  await chat.connect();assert(chat.previewsActive);unmount=monterApercusNatifs(client,{native:{chat}} as unknown as Fournisseur);
  const message=await transport.message(id),image=message.previews![0].image!;
  const cards=apercusDeLien(await urls(),3,(message,file)=>uriApercuNatif(client,message,file));assert.equal(cards.length,1);assert.equal(cards[0].type,'carte');
  const uri=uriApercuNatif(client,id,image.file_id)!;assert(!uri.includes(auth.token));await chargerApercuNatif(uri);
  const pixels=photoApercuNatif(uri).uri!;assert(pixels?.startsWith('data:image/png;base64,'));
  assert.equal(createHash('sha256').update(Buffer.from(pixels.split(',')[1],'base64')).digest('hex'),image.sha256);
  assert.equal(imageReads,1);await chargerApercuNatif(uri);assert.equal(imageReads,1);
  await transport.editMessage(id,{operation_id:randomUUID(),expected_revision:message.revision,content:{kind:'plain',markdown:'Edited without a link',mentions:[],quotes:[],files:[]}});
  await until(async()=>!await urls());
  await until(()=>photoApercuNatif(uri).uri===null);
  assert.equal(apercusDeLien(await urls(),3,(m,f)=>uriApercuNatif(client,m,f)).length,0);
  await assert.rejects(transport.previewBytes(id,image),/not_found/);
  unmount();assert.equal(uriApercuNatif(client,id,image.file_id),null);
  console.log(JSON.stringify({preview_http_sqlite:'passed',private_pixels:'verified',edit_websocket:'retired',cache_reads:imageReads}));
}finally{unmount();chat.stop();await store.state();h.db.close();}
