// Existing mobile provider, protected HTTP avatars, WebSocket stamps and actual SQLite.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/providers/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {createRocketVibeProvider} from '../apps/mobile/providers/rocketvibe/index.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import {RestClient} from '../apps/mobile/lib/rest.ts';
import {mountProviderProfiles} from '../apps/mobile/lib/providerProfiles.ts';
import {setProfileClient,setProfileNavigator,readPreloadedProfile,openProfileCard} from '../apps/mobile/lib/profilePreload.ts';
import {loadNativeAvatar,nativeAvatarPhoto} from '../apps/mobile/lib/nativeAvatars.ts';
import {avatarUrl} from '../apps/mobile/lib/upload.ts';
import {nativeMyProfile} from '../apps/mobile/providers/rocketvibe/profileOperations.ts';

const base=process.env.RV_SMOKE_URL!,password='profiles-test-password',png=readFileSync(process.env.RV_PROFILE_PNG!);
assert(base);
const owner=new NativeTransport(base),avatarRequests:RequestInit[]=[],profileWrites:string[]=[];
let loseProfileAck=false;
const reader=new NativeTransport(base,async(input,options)=>{
  if(new URL(String(input)).pathname.startsWith('/api/v1/avatars/'))avatarRequests.push(options!);
  const path=new URL(String(input)).pathname;
  if(path==='/api/v1/me'&&options?.method==='PATCH')profileWrites.push(String(options.body));
  const response=await fetch(input,options);
  if(loseProfileAck&&path==='/api/v1/me'&&options?.method==='PATCH'&&response.ok){loseProfileAck=false;throw new TypeError('Lost profile acknowledgement after commit');}
  return response;
});
const a=await owner.login('profile_owner',password),b=await reader.login('profile_reader',password),discovery=await owner.discover();
const dm=await owner.direct({user_id:b.user.id});
const id=()=>randomBytes(12).toString('hex');
let own=await owner.ownProfile();
await owner.updateProfile({operation_id:id(),expected_revision:own.profile.revision,username:a.user.username,display_name:'Mobile profile',bio:'Native public bio',status:'busy',status_text:'Testing profiles'});
own=await owner.ownProfile();
await owner.setAvatar({operation_id:id(),expected_revision:own.profile.revision},{mime:'image/png',bytes:png});
own=await owner.ownProfile();assert(own.profile.avatar_file_id);
const account={baseUrl:base,authToken:b.token,userId:b.user.id,username:b.user.username,kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const database=nativeTestDatabase(),store=new NativeStore(database.adapter,createWriteQueue(),account);
const client=new RestClient(base,{fetch:async()=>{throw new Error('Unexpected Rocket.Chat request');}});client.kind='rocketvibe';
const provider=createRocketVibeProvider(account,client,id,store,{transport:reader});
const chat=provider.native!.chat,unmount=mountProviderProfiles(client,provider);
let resumed:ReturnType<typeof createRocketVibeProvider>|null=null;
async function until(check:()=>boolean|Promise<boolean>){const deadline=Date.now()+20_000;while(!await check()){assert(Date.now()<deadline,'Profile provider timed out');await new Promise(r=>setTimeout(r,40));}}
try{
  await chat.connect();
  await until(()=>chat.live.state?.profiles?.some(p=>p.user.id===a.user.id&&p.revision===own.profile.revision)===true);
  assert.equal(database.db.prepare('SELECT dm_other_uid FROM rooms WHERE rid=?').get(dm.id)?.dm_other_uid,a.user.id);
  const cursor=(await store.state())!.cursor,navigations:unknown[]=[];
  setProfileClient(client);setProfileNavigator(p=>navigations.push(p));
  await openProfileCard({uid:a.user.id});
  const publicProfile=readPreloadedProfile({uid:a.user.id})!.user!;
  assert.equal(publicProfile.username,'profile_owner');assert.equal(publicProfile.name,'Mobile profile');assert.equal(publicProfile.bio,'Native public bio');assert.equal(publicProfile.email,undefined);
  assert.equal(navigations.length,1);assert.equal((await store.state())!.cursor,cursor);
  const uri=avatarUrl(client,{uid:a.user.id,etag:publicProfile.avatarETag as string})!;
  await loadNativeAvatar(uri);const pixels=nativeAvatarPhoto(uri).uri!;assert(pixels.startsWith('data:image/png;base64,'));
  assert.deepEqual(Buffer.from(pixels.split(',')[1],'base64'),Buffer.from(await owner.avatarBytes(own.profile.avatar_file_id!)));
  assert(avatarRequests.length>0);
  for(const options of avatarRequests){assert.equal(options.redirect,'error');assert.equal(new Headers(options.headers).get('Authorization'),`Bearer ${b.token}`);}
  await owner.updateProfile({operation_id:id(),expected_revision:own.profile.revision,username:'profile_owner_renamed',display_name:'Renamed mobile profile',bio:'Current bio',status:'away',status_text:'Renamed'});
  own=await owner.ownProfile();
  await until(()=>database.db.prepare('SELECT username FROM users WHERE uid=?').get(a.user.id)?.username==='profile_owner_renamed');
  assert.equal(database.db.prepare('SELECT u.username FROM rooms s JOIN users u ON u.uid=s.dm_other_uid WHERE s.rid=?').get(dm.id)?.username,'profile_owner_renamed');
  assert.equal((await provider.readProfile!({uid:a.user.id}))?.name,'Renamed mobile profile');
  await owner.setAvatar({operation_id:id(),expected_revision:own.profile.revision});
  await until(()=>database.db.prepare('SELECT avatar_etag FROM users WHERE uid=?').get(a.user.id)?.avatar_etag==='none');
  await until(()=>nativeAvatarPhoto(uri).uri===null);
  assert.equal((await provider.readProfile!({uid:a.user.id}))?.avatarETag,'none');
  assert.equal(avatarUrl(client,{uid:a.user.id,etag:'none'}),null);
  assert.equal((await provider.actions.openOrCreateDm('obsolete-name',a.user.id)).rid,dm.id);
  await until(()=>chat.status.online);
  // Same personal editor adapter: preserve the original command after a lost response.
  const before=await chat.ownProfile();loseProfileAck=true;
  await assert.rejects(chat.editOwnProfile({...nativeMyProfile(before),bio:'Saved before connection loss'}));
  chat.stop();const saved=await store.profileOperations.get('profile');assert(saved);
  const committed=await reader.ownProfile();assert.equal(committed.profile.bio,'Saved before connection loss');
  await reader.updateProfile({operation_id:id(),expected_revision:committed.profile.revision,username:b.user.username,display_name:'More recent name',bio:'Newer remote bio',status:'away',status_text:'Other device'});
  resumed=createRocketVibeProvider(account,client,id,store,{transport:reader});const fresh=resumed.native!.chat;await fresh.connect();
  await until(async()=>await store.profileOperations.get('profile')===null);
  assert.equal(profileWrites[profileWrites.length-1],profileWrites[0]);
  assert.equal((await fresh.ownProfile()).profile.bio,'Newer remote bio','Replay must not undo a later update');
  const preferences=(await fresh.ownProfile()).preferences;
  const updated=await fresh.updateOwnPreferences(preferences,{language:'fr'});
  assert.equal(updated.preferences.language,'fr');assert.equal(updated.preferences.clock_24h,preferences.clock_24h);
  assert.equal(updated.preferences.push_enabled,preferences.push_enabled);
  assert.equal(updated.preferences.desktop_notifications,preferences.desktop_notifications);
  const photo=await fresh.setOwnAvatar(updated.profile.revision,{mime:'image/png',bytes:png});assert(photo.profile.avatar_file_id);
  assert.equal((await fresh.setOwnAvatar(photo.profile.revision)).profile.avatar_file_id,null);
  assert.equal(await store.profileOperations.get('avatar'),null);
  assert.equal(await store.profileOperations.get('preferences'),null);
  unmount();assert.equal(nativeAvatarPhoto(uri).uri,null);assert.equal(avatarUrl(client,{uid:a.user.id,etag:publicProfile.avatarETag as string}),null);
  console.log('Mobile public/personal profiles, original-command replay after lost response, preferences, protected avatar, live identity and account cleanup verified against HTTP/PostgreSQL/WebSocket/SQLite.');
}finally{
  unmount();setProfileClient(null);setProfileNavigator(null);chat.stop();resumed?.native!.chat.stop();await store.state();database.db.close();
}
