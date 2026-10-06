/** HTTP/WebSocket/SQLite bench using the server's advertised capability. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {NativeChat} from '../apps/mobile/providers/rocketvibe/chat.ts';
import {NativeStore} from '../apps/mobile/providers/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import {RestClient} from '../apps/mobile/lib/rest.ts';
import type {Provider} from '../apps/mobile/lib/provider.ts';
import {linkPreviews} from '../apps/mobile/lib/linkPreview.ts';
import {loadNativePreview,mountNativePreviews,nativePreviewPhoto,nativePreviewUri} from '../apps/mobile/lib/nativePreviews.ts';

const base=process.env.RV_PREVIEW_TEST_SERVER!,id=process.env.RV_PREVIEW_TEST_MESSAGE!;
let imageReads=0;
const transport=new NativeTransport(base,async(input,options)=>{
  const url=new URL(String(input));assert.equal(url.origin,new URL(base).origin);assert.equal(options?.redirect,'error');
  const response=await fetch(input,options);
  if(url.pathname.includes('/previews/')){imageReads++;assert(new Headers(options?.headers).get('authorization')?.startsWith('Bearer '));assert.equal(url.search,'');}
  return response;
});
const discovery=await transport.discover(),auth=await transport.login('owner','test-password-2026');
assert.equal(discovery.capabilities.link_previews,true);
const session={baseUrl:base,authToken:auth.token,userId:auth.user.id,username:auth.user.username,kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const h=nativeTestDatabase(),store=new NativeStore(h.adapter,createWriteQueue(),session),chat=new NativeChat(session,store,randomUUID,{transport});
const client=new RestClient(base);client.kind='rocketvibe';
let unmount:()=>void=()=>{};
async function until(check:()=>Promise<boolean>|boolean){const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw new Error('Preview event did not reach the app');await new Promise<void>(r=>setTimeout(r,20));}}
async function urls(){await store.state();const row=h.db.prepare('SELECT urls FROM messages WHERE id=?').get(id) as {urls:string|null}|undefined;assert(row);return row.urls;}
try{
  await chat.connect();assert(chat.previewsActive);unmount=mountNativePreviews(client,{native:{chat}} as unknown as Provider);
  const message=await transport.message(id),image=message.previews![0].image!;
  const cards=linkPreviews(await urls(),3,(message,file)=>nativePreviewUri(client,message,file));assert.equal(cards.length,1);assert.equal(cards[0].type,'card');
  const uri=nativePreviewUri(client,id,image.file_id)!;assert(!uri.includes(auth.token));await loadNativePreview(uri);
  const pixels=nativePreviewPhoto(uri).uri!;assert(pixels?.startsWith('data:image/png;base64,'));
  assert.equal(createHash('sha256').update(Buffer.from(pixels.split(',')[1],'base64')).digest('hex'),image.sha256);
  assert.equal(imageReads,1);await loadNativePreview(uri);assert.equal(imageReads,1);
  await transport.editMessage(id,{operation_id:randomUUID(),expected_revision:message.revision,content:{kind:'plain',markdown:'Edited without a link',mentions:[],quotes:[],files:[]}});
  await until(async()=>!await urls());
  await until(()=>nativePreviewPhoto(uri).uri===null);
  assert.equal(linkPreviews(await urls(),3,(m,f)=>nativePreviewUri(client,m,f)).length,0);
  await assert.rejects(transport.previewBytes(id,image),/not_found/);
  unmount();assert.equal(nativePreviewUri(client,id,image.file_id),null);
  console.log(JSON.stringify({preview_http_sqlite:'passed',private_pixels:'verified',edit_websocket:'retired',cache_reads:imageReads}));
}finally{unmount();chat.stop();await store.state();h.db.close();}
