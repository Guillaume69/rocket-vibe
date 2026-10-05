import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {integrationCards} from './cards.ts';
import {NativeStore,localMessage} from './store.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {createWriteQueue} from '../../db/writeQueue.ts';
import {integrationCard} from '../../lib/integrationCards.ts';
import type {Session} from '../../lib/auth.ts';
import type {Message} from './protocol.generated.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const card={author:'CI',title:'Build &amp; ready',url:'https://example.org/build/1',text:'Details',color:'#1177aa',fields:[{title:'Commit',value:'abcdef',short:true}]};
const message:Message={...fixture.message,cards:[card]};
test('integration card validation bounds fields and rejects executable or credentialed navigation',()=>{
  assert.deepEqual(integrationCards([card]),[card]);
  for(const c of [{...card,url:'javascript:alert(1)'},{...card,url:'https://user:secret@example.org/'},{...card,title:'é'.repeat(257)},{...card,fields:Array(13).fill(card.fields[0])},{...card,html:'<script>'},{...card,color:'url(x)'}])assert.throws(()=>integrationCards([c]));
  assert.throws(()=>integrationCards(Array(4).fill(card)));
  assert.throws(()=>localMessage({...message,deleted:true,text:''}));
});
test('existing attachment presentation distinguishes cards, files, quotes and safe external navigation',()=>{
  const raw=JSON.parse(localMessage(message).attachments!)[0],c=integrationCard(raw)!;
  assert.equal(c.title,card.title);assert.equal(c.url,card.url);assert.equal(c.fields[0].value,'abcdef');
  assert.equal(integrationCard({...raw,native_file:{}}),null);
  assert.equal(integrationCard({...raw,message_link:'quote'}),null);
  assert.equal(integrationCard({...raw,title_link:'/file-upload/file'}),null);
  assert.equal(integrationCard({...raw,title_link:'https://user:secret@example.org'} )!.url,null);
});
test('SQLite retains integration cards through quote refresh, failed batches, restart and revocation',async()=>{
  const h=nativeTestDatabase(),session:Session={baseUrl:'http://localhost',authToken:'token',userId:fixture.session.user.id,username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:fixture.discovery.instance_id,nativeDataEpoch:fixture.discovery.data_epoch};
  const store=new NativeStore(h.adapter,createWriteQueue(),session);
  try{
    await store.applySnapshot({protocol_version:1,rooms:[fixture.room],messages:[message],cursor:'cards'});
    const read=async()=>integrationCard(JSON.parse((await h.adapter.getFirstAsync<{attachments:string}>('SELECT attachments FROM messages WHERE id=?',[message.id]))!.attachments)[0]);
    assert.equal((await read())!.title,card.title);
    h.failWhen(sql=>sql.startsWith('INSERT INTO native_sync_state'));
    await assert.rejects(store.applyBatch({protocol_version:1,changes:[{type:'message_upsert',data:{...message,revision:'9007199254740994',cards:[]}}],cursor:'failed',has_more:false}));
    h.failWhen(null);assert.equal((await read())!.title,card.title);
    const restored=new NativeStore(h.adapter,createWriteQueue(),session);assert.equal((await restored.state())!.cursor,'cards');assert.equal((await read())!.title,card.title);
    await restored.applyBatch({protocol_version:1,changes:[{type:'room_removed',data:{room_id:message.room_id}}],cursor:'removed',has_more:false});
    assert.equal(await h.adapter.getFirstAsync('SELECT id FROM messages WHERE id=?',[message.id]),null);
  }finally{h.db.close();}
});
