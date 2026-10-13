import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {NativeStore} from './store.ts';
import {decodeNative} from './validation.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import type {Session} from '../../lib/auth.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
test('social cards survive snapshot quote refresh, vote updates and projection restart',async()=>{
 const h=nativeTestDatabase();
 const session:Session={baseUrl:'http://localhost',authToken:'test-token',userId:fixture.session.user.id,username:'alice',kind:'vibez',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
 const card=decodeNative('SocialCard',{kind:'poll',question:'Choose a game',multiple:false,closed:false,options:[{label:'Co-op',voters:[]},{label:'Racing',voters:[]}],closes_at:null});
 const message=decodeNative('Message',{...fixture.message,social:card});
 const store=new NativeStore(h.adapter,createWriteQueue(),session);
 const read=async()=>JSON.parse((await h.adapter.getFirstAsync<{attachments:string}>('SELECT attachments FROM messages WHERE id=?',[message.id]))!.attachments)[0].native_social;
 try{
  await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[message],cursor:'social'});
  assert.deepEqual(await read(),card);
  const voted=decodeNative('SocialCard',{...card,options:[{label:'Co-op',voters:[session.userId]},{label:'Racing',voters:[]}]});
  await store.applyBatch({protocol_version:1,changes:[{type:'message_upsert',data:{...message,social:voted,revision:'9007199254740994'}}],cursor:'voted',has_more:false});
  assert.deepEqual(await read(),voted);
  const reopened=new NativeStore(h.adapter,createWriteQueue(),session);
  assert.equal((await reopened.state())!.cursor,'voted');assert.deepEqual(await read(),voted);
 }finally{h.db.close();}
});