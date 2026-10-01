// Disposable invitation code is read from the private pilot volume, never logged.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {nativeRegister,nativeRecover} from '../apps/mobile/fournisseurs/rocketvibe/auth.ts';
import {NativeTransport,NativeError} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {creerFournisseurRV} from '../apps/mobile/fournisseurs/rocketvibe/index.ts';
import {ClientRest} from '../apps/mobile/lib/rest.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
export async function invitationSmoke():Promise<void> {
  const path=process.env.RV_NATIVE_INVITATION_FILE;if(!path)return;
  const base=process.env.RV_PEER_URL!,password=process.env.RV_PEER_PASSWORD!;
  const token=JSON.parse(readFileSync(path,'utf8')).token as string;
  const transport=new NativeTransport(base);const discovery=await transport.discover();
  assert.equal(discovery.capabilities.account_invitations,true);
  const session=await nativeRegister(base,discovery,{utilisateur:'mobile-invited',motDePasse:password},token);
  const replay=await nativeRegister(base,discovery,{utilisateur:'mobile-invited',motDePasse:password},token);
  assert.equal(replay.userId,session.userId);
  transport.restore(session.authToken);assert.equal((await transport.me()).id,session.userId);
  const database=nativeTestDatabase(),queue=creerFileEcritures(),store=new NativeStore(database.adapter,queue,session);
  const rest=new ClientRest(base,{fetch:async()=>{throw new Error('Unexpected Rocket.Chat call during signup');}});rest.genre='rocketvibe';
  const provider=creerFournisseurRV(session,rest,()=>randomBytes(12).toString('hex'),store);
  try {
    await provider.native!.chat.connect();
    const room=await provider.native!.chat.createRoom('invited-mobile-room',false);
    const remote=await transport.createRoom({name:'invited-mobile-api-room',private:false});
    const message=await transport.send(remote.id,{operation_id:randomBytes(12).toString('hex'),text:'Message from an invited mobile account'});
    assert.equal(message.author.id,session.userId);
    assert(room);
    assert.equal(JSON.stringify(session).includes(token),false);
    console.log('Mobile invitation: signup/replay, native runner and real SQLite passed');
  } finally {provider.native!.chat.stop();await store.state();database.db.close();await transport.logout();}
}

export async function recoverySmoke():Promise<void> {
  const path=process.env.RV_NATIVE_RECOVERY_FILE;if(!path)return;
  const base=process.env.RV_PEER_URL!,original=process.env.RV_PEER_PASSWORD!,password='native-recovered-test-password';
  const token=JSON.parse(readFileSync(path,'utf8')).token as string;
  const old=new NativeTransport(base),discovery=await old.discover(),before=await old.login('mobile-recovery',original);
  const room=await old.createRoom({name:'recovery-kept-room',private:true});
  const prior=await old.send(room.id,{operation_id:randomBytes(12).toString('hex'),text:'Preserve mobile conversation across password recovery'});
  const session=await nativeRecover(base,discovery,{utilisateur:'mobile-recovery',motDePasse:password},token);
  assert.equal(session.userId,before.user.id);
  await assert.rejects(old.me(),e=>e instanceof NativeError&&e.status===401);
  const replay=await nativeRecover(base,discovery,{utilisateur:'mobile-recovery',motDePasse:password},token);
  assert.equal(replay.userId,session.userId);
  const current=new NativeTransport(base);current.restore(session.authToken);assert.equal((await current.me()).id,session.userId);
  const database=nativeTestDatabase(),queue=creerFileEcritures(),store=new NativeStore(database.adapter,queue,session);
  const rest=new ClientRest(base,{fetch:async()=>{throw new Error('Unexpected Rocket.Chat recovery request');}});rest.genre='rocketvibe';
  const provider=creerFournisseurRV(session,rest,()=>randomBytes(12).toString('hex'),store);
  try {
    await provider.native!.chat.connect();
    assert((await store.rooms()).some(r=>r.rid===room.id));
    assert((await store.messages(room.id,100)).some(m=>m.id===prior.id));
    assert.equal(JSON.stringify(session).includes(token),false);
    console.log('Mobile recovery: UID/conversation preserved, old session revoked, receipt replay and real SQLite passed');
  } finally {provider.native!.chat.stop();await store.state();database.db.close();await current.logout();}
}
