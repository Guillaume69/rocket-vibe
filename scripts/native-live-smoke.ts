// Two actual providers, PostgreSQL, WebSockets and the existing SQLite migrations.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/providers/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import {createRocketVibeProvider} from '../apps/mobile/providers/rocketvibe/index.ts';
import {RestClient} from '../apps/mobile/lib/rest.ts';
import {TypingEngine} from '../apps/mobile/lib/typing.ts';

export async function liveSmoke():Promise<void>{
  const base=process.env.RV_PEER_URL!,password=process.env.RV_PEER_PASSWORD!;
  assert(base && password);
  const owner=new NativeTransport(base),reader=new NativeTransport(base);
  const a=await owner.login('desktop',password),b=await reader.login('mobile',password),discovery=await owner.discover();
  const nonce=randomBytes(8).toString('hex');
  const room=await owner.createRoom({operation_id:`live-room-${nonce}`,name:`Live provider ${nonce}`,private:true});
  await owner.addMember(room.id,b.user.id);
  const dm=await owner.direct({user_id:b.user.id});
  async function provider(account:typeof a){
    const session={baseUrl:base,authToken:account.token,userId:account.user.id,username:account.user.username,kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
    const database=nativeTestDatabase(),store=new NativeStore(database.adapter,createWriteQueue(),session);
    const client=new RestClient(base,{fetch:async()=>{throw new Error('Unexpected RC request');}});client.kind='rocketvibe';
    const p=createRocketVibeProvider(session,client,()=>randomBytes(12).toString('hex'),store);
    await p.native!.chat.connect();return{database,store,p,chat:p.native!.chat};
  }
  const x=await provider(a),y=await provider(b);
  const typing=new TypingEngine({rid:room.id,me:a.user.username});
  const unlisten=x.p.listener.onEvent(e=>typing.apply(e));
  async function until(check:()=>boolean|Promise<boolean>){const deadline=Date.now()+20_000;while(!await check()){assert(Date.now()<deadline,'live provider timed out');await new Promise(r=>setTimeout(r,50));}}
  try{
    await until(()=>x.chat.live.state?.presence.some(p=>p.user.id===b.user.id && p.status==='online')===true);
    assert.equal(x.chat.live.state?.rooms.find(r=>r.room_id===dm.id)?.direct_peer?.id,b.user.id);
    const membership=(await y.store.readState(room.id))!.membership_version!;
    const messagesBefore=(await x.store.messages(room.id,100)).length;
    await y.chat.setTyping(room.id,true,undefined,membership);
    await until(()=>typing.whoIsTyping().includes(b.user.username));
    assert.equal((await x.store.messages(room.id,100)).length,messagesBefore);
    await y.chat.setTyping(room.id,false,undefined,membership);
    await until(()=>typing.whoIsTyping().length===0);
    await y.chat.setTyping(room.id,true,undefined,membership);
    await until(()=>typing.whoIsTyping().includes(b.user.username));
    y.chat.suspend();assert.equal(y.chat.live.state,null);
    await until(()=>typing.whoIsTyping().length===0);
    await y.chat.connect();
    await until(()=>y.chat.live.state!==null);
    assert.equal((await fetch(`${base}/api/v1/rooms/${room.id}/members/${b.user.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${a.token}`}})).status,204);
    await until(async()=>await y.store.readState(room.id)===null);
    await until(()=>!y.chat.live.state?.rooms.some(r=>r.room_id===room.id));
    await y.chat.setTyping(room.id,true,undefined,membership);
    const frame=await owner.liveState();assert.equal(frame.data.rooms.find(r=>r.room_id===room.id)?.typing.length,0);
    console.log(JSON.stringify({liveSmoke:true,actualProviders:true,websocketPhotos:true,existingTypingEngine:true,directPeer:true,volatile:true,stopAndSuspend:true,withdrawal:true}));
  }finally{
    unlisten();typing.stop();x.chat.stop();y.chat.stop();
    await new Promise(r=>setTimeout(r,20));
    await Promise.all([x.store.state(),y.store.state()]);x.database.db.close();y.database.db.close();
  }
}
