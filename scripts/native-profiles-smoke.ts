// Existing mobile provider, protected HTTP avatars, WebSocket stamps and actual SQLite.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import {monterProfilsFournisseur} from '../apps/mobile/lib/profilsFournisseur.ts';
import {definirClientProfil,definirNavigateurProfil,lireProfilPrecharge,ouvrirFicheProfil} from '../apps/mobile/lib/profilPreload.ts';
import {chargerAvatarNatif,photoAvatarNatif} from '../apps/mobile/lib/avatarsNatifs.ts';
import {urlAvatar} from '../apps/mobile/lib/upload.ts';

const base=process.env.RV_SMOKE_URL!,password='profiles-test-password',png=readFileSync(process.env.RV_PROFILE_PNG!);
assert(base);
const owner=new NativeTransport(base),avatarRequests:RequestInit[]=[];
const reader=new NativeTransport(base,async(input,options)=>{
  if(new URL(String(input)).pathname.startsWith('/api/v1/avatars/'))avatarRequests.push(options!);
  return fetch(input,options);
});
const a=await owner.login('profile_owner',password),b=await reader.login('profile_reader',password),discovery=await owner.discover();
const dm=await owner.direct({user_id:b.user.id});
const id=()=>randomBytes(12).toString('hex');
let own=await owner.ownProfile();
await owner.updateProfile({operation_id:id(),expected_revision:own.profile.revision,username:a.user.username,display_name:'Mobile profile',bio:'Native public bio',status:'busy',status_text:'Testing profiles'});
own=await owner.ownProfile();
await owner.setAvatar({operation_id:id(),expected_revision:own.profile.revision},{mime:'image/png',bytes:png});
own=await owner.ownProfile();assert(own.profile.avatar_file_id);
const account={baseUrl:base,authToken:b.token,userId:b.user.id,username:b.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const database=nativeTestDatabase(),store=new NativeStore(database.adapter,creerFileEcritures(),account);
const client=new ClientRest(base,{fetch:async()=>{throw new Error('Unexpected Rocket.Chat request');}});client.genre='rocketvibe';
const provider=creerFournisseurRV(account,client,id,store,{transport:reader});
const chat=provider.native!.chat,unmount=monterProfilsFournisseur(client,provider);
async function until(check:()=>boolean|Promise<boolean>){const deadline=Date.now()+20_000;while(!await check()){assert(Date.now()<deadline,'Profile provider timed out');await new Promise(r=>setTimeout(r,40));}}
try{
  await chat.connect();
  await until(()=>chat.live.state?.profiles?.some(p=>p.user.id===a.user.id&&p.revision===own.profile.revision)===true);
  assert.equal(database.db.prepare('SELECT dm_autre_uid FROM salons WHERE rid=?').get(dm.id)?.dm_autre_uid,a.user.id);
  const cursor=(await store.state())!.cursor,navigations:unknown[]=[];
  definirClientProfil(client);definirNavigateurProfil(p=>navigations.push(p));
  await ouvrirFicheProfil({uid:a.user.id});
  const publicProfile=lireProfilPrecharge({uid:a.user.id})!.user!;
  assert.equal(publicProfile.username,'profile_owner');assert.equal(publicProfile.name,'Mobile profile');assert.equal(publicProfile.bio,'Native public bio');assert.equal(publicProfile.email,undefined);
  assert.equal(navigations.length,1);assert.equal((await store.state())!.cursor,cursor);
  const uri=urlAvatar(client,{uid:a.user.id,etag:publicProfile.avatarETag as string})!;
  await chargerAvatarNatif(uri);const pixels=photoAvatarNatif(uri).uri!;assert(pixels.startsWith('data:image/png;base64,'));
  assert.deepEqual(Buffer.from(pixels.split(',')[1],'base64'),Buffer.from(await owner.avatarBytes(own.profile.avatar_file_id!)));
  assert(avatarRequests.length>0);
  for(const options of avatarRequests){assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('Authorization'),`Bearer ${b.token}`);}
  await owner.updateProfile({operation_id:id(),expected_revision:own.profile.revision,username:'profile_owner_renamed',display_name:'Renamed mobile profile',bio:'Current bio',status:'away',status_text:'Renamed'});
  own=await owner.ownProfile();
  await until(()=>database.db.prepare('SELECT username FROM utilisateurs WHERE uid=?').get(a.user.id)?.username==='profile_owner_renamed');
  assert.equal(database.db.prepare('SELECT u.username FROM salons s JOIN utilisateurs u ON u.uid=s.dm_autre_uid WHERE s.rid=?').get(dm.id)?.username,'profile_owner_renamed');
  assert.equal((await provider.lireProfil!({uid:a.user.id}))?.name,'Renamed mobile profile');
  await owner.setAvatar({operation_id:id(),expected_revision:own.profile.revision});
  await until(()=>database.db.prepare('SELECT avatar_etag FROM utilisateurs WHERE uid=?').get(a.user.id)?.avatar_etag==='sans-photo');
  await until(()=>photoAvatarNatif(uri).uri===null);
  assert.equal((await provider.lireProfil!({uid:a.user.id}))?.avatarETag,'sans-photo');
  assert.equal(urlAvatar(client,{uid:a.user.id,etag:'sans-photo'}),null);
  assert.equal((await provider.actions.ouvrirOuCreerDm('obsolete-name',a.user.id)).rid,dm.id);
  unmount();assert.equal(photoAvatarNatif(uri).uri,null);assert.equal(urlAvatar(client,{uid:a.user.id,etag:publicProfile.avatarETag as string}),null);
  console.log('Mobile profile presentation/preload, protected avatar, live rename/removal, stable-UID DM and account cleanup verified against HTTP/PostgreSQL/WebSocket/SQLite.');
}finally{
  unmount();definirClientProfil(null);definirNavigateurProfil(null);chat.stop();await store.state();database.db.close();
}
