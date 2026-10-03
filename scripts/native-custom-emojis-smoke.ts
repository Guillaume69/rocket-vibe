import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import {monterEmojisFournisseur} from '../apps/mobile/lib/emojisFournisseur.ts';
import {codesEmojiCustom,urlEmojiCustom} from '../apps/mobile/lib/emojisCustom.ts';
import {chargerAvatarNatif,photoAvatarNatif} from '../apps/mobile/lib/avatarsNatifs.ts';

const base=process.env.RV_FILE_TEST_SERVER!,password=process.env.RV_FILE_TEST_PASSWORD!;
assert(base&&password);
const transport=new NativeTransport(base),account=await transport.login('desktop-files',password),discovery=await transport.discover();
const room=await transport.createRoom({operation_id:randomUUID(),name:'Mobile custom emoji bench',private:true});
const message=await transport.send(room.id,{operation_id:randomUUID(),text:':vibe_parrot:'});
const session={baseUrl:base,siteUrl:null,genre:'rocketvibe' as const,authToken:account.token,userId:account.user.id,username:account.user.username,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session),client=new ClientRest(base);
client.genre='rocketvibe';
const provider=creerFournisseurRV(session,client,randomUUID,store,{transport}),chat=provider.native!.chat;
const unmount=monterEmojisFournisseur(client,provider);
async function until(check:()=>boolean|Promise<boolean>,timeout=20_000){const deadline=Date.now()+timeout;while(!await check()){assert(Date.now()<deadline,'Emoji live update timed out');await new Promise(r=>setTimeout(r,40));}}
try{
  await chat.connect();assert(provider.capacites.emojisCustom);
  assert(codesEmojiCustom().includes('party_parrot')&&codesEmojiCustom().includes('vibe_parrot'));
  const uri=urlEmojiCustom('vibe_parrot')!;assert.match(uri,/^rv-emoji:/);assert.equal(uri,urlEmojiCustom('party_parrot'));assert(!uri.includes(account.token));
  await chargerAvatarNatif(uri);assert(photoAvatarNatif(uri).uri?.startsWith('data:image/png;base64,'));
  await chat.react(room.id,message.id,':vibe_parrot:',true);
  const confirmed=(await transport.history(room.id)).messages.find(m=>m.id===message.id)!;
  assert.equal(confirmed.reactions?.[0].emoji,'party_parrot');
  if(process.env.RV_EMOJI_WAIT_REMOVAL==='1'){
    console.log('native mobile emojis: waiting for operator retirement');
    await until(()=>chat.customEmojis.items.length===0,120_000);
    assert.equal(codesEmojiCustom().length,0);assert.equal(photoAvatarNatif(uri).uri,null);
    await assert.rejects(chat.react(room.id,message.id,'party_parrot',true),/unknown_emoji/);
  }
  await chat.react(room.id,message.id,'party_parrot',false);
  assert.deepEqual((await transport.history(room.id)).messages.find(m=>m.id===message.id)!.reactions??[],[]);
  chat.stop();unmount();assert.equal(photoAvatarNatif(uri).uri,null);assert.equal(codesEmojiCustom().length,0);
  console.log(`native mobile emojis: real HTTP/SQLite/WebSocket catalogue, protected pixels, canonical reactions and account cleanup passed${process.env.RV_EMOJI_WAIT_REMOVAL==='1'?'; operator retirement passed':''}`);
}finally{chat.stop();unmount();await store.state();h.db.close();}
