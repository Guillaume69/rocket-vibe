import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Session} from '../../lib/auth.ts';
import {nativeRoomPermalink,parseRoomLink} from '../../lib/roomLinks.ts';
import {NativeStore} from './store.ts';
import {NativeChat} from './chat.ts';
import type {NativeTransport} from './transport.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {decodeNative} from './validation.ts';
const f=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const session:Session={baseUrl:'https://chat.test/native',genre:'rocketvibe',userId:f.session.user.id,username:'alice',authToken:'fixture-token',siteUrl:null,nativeInstanceId:f.discovery.instance_id,nativeDataEpoch:f.discovery.data_epoch};
const room=decodeNative('Room',{...f.room,read_state:{room_id:f.room.id,membership_version:'grant',revision:'1',root_position:'0',reply_position:'0',unread_roots:'0',unread_replies:'0',mentions:'0',group_mentions:'0',favorite:false}});
test('native links resolve authorized targets and refuse scope changes before committing to SQLite',async()=>{
  for(const scenario of ['normal','wrong-room','deleted','wrong-thread','rejoined','restored','closed'] as const){
    const {db,adapter}=nativeTestDatabase();const store=new NativeStore(adapter,creerFileEcritures(),session);
    await store.applySnapshot({protocol_version:1,rooms:[room],messages:[],cursor:'initial'});
    let changed=false;let chat:NativeChat;
    const transport={discover:async()=>({...f.discovery,data_epoch:changed?'restored':f.discovery.data_epoch}),me:async()=>f.session.user,changes:async()=>({protocol_version:1,changes:[],cursor:'initial',has_more:false}),socketUrl:async()=>'ws://chat.test/native/socket',
      message:async()=>{
        if(scenario==='restored')changed=true;
        if(scenario==='rejoined')await store.applySnapshot({protocol_version:1,rooms:[{...room,read_state:{...room.read_state!,membership_version:'new-grant',revision:'10'}}],messages:[],cursor:'rejoined'});
        if(scenario==='closed')chat.stop();
        return decodeNative('Message',{...f.message,id:'reply',reply_to:'root',room_id:scenario==='wrong-room'?'other':room.id,deleted:scenario==='deleted',text:scenario==='deleted'?'':f.message.text});
      },
    } as unknown as NativeTransport;
    chat=new NativeChat(session,store,()=>{throw new Error('Link must not send');},{transport,socket:()=>{
      const socket={readyState:0,onopen:null,onclose:null,onerror:null,onmessage:null,close:()=>{}} as unknown as WebSocket;
      queueMicrotask(()=>socket.onopen?.(new Event('open')));return socket;
    }});
    try {
      await chat.connect();
      const url=nativeRoomPermalink(session,room.id,'reply',scenario==='wrong-thread'?'forged-root':null)!;
      if(scenario==='normal'){const result=await chat.resolveRoomLink(parseRoomLink(url)!);assert.equal(result.link.root,'root');assert(db.prepare('SELECT id FROM messages WHERE id=?').get('reply'));}
      else {await assert.rejects(chat.resolveRoomLink(parseRoomLink(url)!));assert.equal(db.prepare('SELECT id FROM messages WHERE id=?').get('reply'),undefined,scenario);}
    } finally {chat.stop();db.close();}
  }
});
test('native message rank is independent of clocks and JavaScript integer rounding',async()=>{
  const {db,adapter}=nativeTestDatabase();const store=new NativeStore(adapter,creerFileEcritures(),session);
  const early=decodeNative('Message',{...f.message,id:'early',position:'9007199254740993',revision:'9007199254740993'});
  const late=decodeNative('Message',{...early,id:'late',position:'9007199254740994',revision:'9007199254740994',created_at:'2020-01-01T00:00:00Z'});
  try {await store.applySnapshot({protocol_version:1,rooms:[room],messages:[early,late],cursor:'initial'});assert.equal(await store.messageRank(room.id,'early'),1);assert.equal(await store.messageRank(room.id,'late'),0);assert.equal(await store.messageRank('other','early'),null);}finally{db.close();}
});
