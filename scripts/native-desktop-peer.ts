// Disposable integration peer: the actual mobile runner + the application's SQLite migrations.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import {creerDepotEnvoi} from '../apps/mobile/db/depot.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {renewCredentials,renewalDue,type CredentialRecord} from '../apps/mobile/fournisseurs/rocketvibe/renewal.ts';
const base=process.env.RV_PEER_URL!;const password=process.env.RV_PEER_PASSWORD!;
assert(base && password);
const readyUntil=Date.now()+30_000;
while (true) {
  try {if((await fetch(`${base}/health/ready`)).ok)break;} catch {}
  assert(Date.now()<readyUntil,'Native server did not become ready');
  await new Promise(r=>setTimeout(r,100));
}
const transport=new NativeTransport(base);const discovery=await transport.discover();const login=await transport.login('mobile',password);
const desktop=(await transport.users()).find(u=>u.username==='desktop')!;assert(desktop);
const publicRoom=await transport.createRoom({name:'native-pilot',private:false});
const privateRoom=await transport.createRoom({name:'native-withdrawal',private:true});
await transport.addMember(publicRoom.id,desktop.id);await transport.addMember(privateRoom.id,desktop.id);
const account={baseUrl:base,userId:login.user.id,username:'mobile',authToken:login.token,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const database=nativeTestDatabase();const queue=creerFileEcritures();const store=new NativeStore(database.adapter,queue,account);
const client=new ClientRest(base,{fetch:async()=>{throw new Error('Unexpected Rocket.Chat request in native peer');}});client.genre='rocketvibe';
let credentials:CredentialRecord={session:account,pending:null,expires_at:login.expires_at};
let renewals=0;
const provider=creerFournisseurRV(account,client,()=>randomBytes(12).toString('hex'),store,{
  credentials:async()=>{
    if(renewalDue(credentials)) {
      credentials=await renewCredentials(credentials,{token:async()=>randomBytes(32).toString('hex'),save:async record=>{credentials=structuredClone(record);}});
      renewals++;transport.restore(credentials.session.authToken);
    }
    return credentials.session;
  },
});
const chat=provider.native!.chat;
const outbox=provider.creerEnvoi(creerDepotEnvoi(database.adapter,queue),async()=>{});
async function until(check:()=>Promise<boolean>) {const end=Date.now()+120_000;while(!await check()){if(Date.now()>end)throw new Error('Desktop/mobile peer timed out');await new Promise(r=>setTimeout(r,50));}}
async function has(text:string){return(await store.messages(publicRoom.id,1000)).some(m=>m.texte===text);}
try {
  await chat.connect();
  assert.equal(renewals,1,'the mobile runner renews the disposable pilot short initial bearer');
  const devices=await transport.deviceSessions();assert.equal(devices.filter(d=>d.current).length,1);
  await chat.createRoom('native-discovery',false);
  await outbox.envoyer(publicRoom.id,'Message du mobile');await outbox.envoyer(privateRoom.id,'Private before withdrawal');
  await until(()=>has('desktop-offline-trigger'));
  await outbox.envoyer(publicRoom.id,'mobile-missed-while-desktop-offline');
  await until(()=>has('desktop-public-created'));
  const directory=await chat.publicRooms('Desktop public discovery');
  assert.equal(directory.rooms.length,1);assert.equal(directory.rooms[0].joined,false);
  const joined=await chat.joinPublic(directory.rooms[0].room.id);
  await until(async()=>chat.status.online && (await store.rooms()).some(r=>r.rid===joined));
  await outbox.envoyer(joined,'Mobile joined desktop public');
  await outbox.envoyer(publicRoom.id,'mobile-public-joined');
  await until(()=>has('desktop-request-withdrawal'));
  const removed=await fetch(`${base}/api/v1/rooms/${privateRoom.id}/members/${desktop.id}`,{method:'DELETE',headers:{authorization:`Bearer ${credentials.session.authToken}`}});assert.equal(removed.status,204);
  await outbox.envoyer(publicRoom.id,'mobile-withdrawal-complete');
  await until(()=>has('desktop-core-complete'));
  await until(()=>has('Message du bureau GTK'));
  await outbox.envoyer(publicRoom.id,'Réponse du mobile au bureau GTK');
  console.log('Mobile peer: desktop exchange, public discovery/join, offline replay and private withdrawal passed');
} finally {chat.stop();database.db.close();}
