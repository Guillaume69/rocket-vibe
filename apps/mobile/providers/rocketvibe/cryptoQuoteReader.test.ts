import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CryptoQuoteReader,overlayQuoteRows,quoteRows} from './cryptoQuoteReader.ts';
import {ordinaryQuoteRoom,type PrivateQuoteRoom} from './cryptoQuotes.ts';
import type {QuoteReference} from './protocol.generated.ts';

const ref=(room_id:string,message_id:string):QuoteReference=>({room_id,message_id,revision:'9007199254740993'});
const privateReference=ref('private-room','private-source');
function privateRoom():PrivateQuoteRoom {
  return {room:'private-room',membership:'private-grant',admission:'ab'.repeat(32),observation:null,messages:[{
    id:'private-source',operation:'private-op',author:'alice',position:'9007199254740993',observed_at:'1700000000',status:'journaled',
    document:{operation_id:'private-op',text:'private source words',reply_to:null,quotes:[],cards:[]}}]};
}
const clearRoom=()=>ordinaryQuoteRoom('clear-room',{membership:'clear-grant',messages:[{id:'clear-source',excerpt:{
  author:{id:'bob',username:'Bob',display_name:'Bob'},text:'ordinary parent',created_at:'2026-10-05T00:00:00Z',revision:'5',membership_version:'clear-grant',
  references:[privateReference],files:[],quotes:[]}}]});
const rows=()=>[{id:'ordinary-destination-message',attachments:JSON.stringify([
  {native_card:true,title:'existing integration'},
  {message_link:'',native_reference:ref('clear-room','clear-source'),native_unavailable:false,text:'ordinary parent',author_name:'Bob',
    attachments:[{message_link:'',native_reference:privateReference,native_unavailable:true,text:''}]},
])}];

test('ordinary cards resolve private descendants in a volatile overlay without changing cached rows or sending',async()=>{
  const cached=rows(),before=JSON.stringify(cached),requests:{room:string;synchronize:boolean}[]=[];
  const reader=new CryptoQuoteReader('ordinary-destination',async()=>{},async(room,_ids,synchronize)=>{
    requests.push({room,synchronize});
    if(room!=='clear-room')return privateRoom();
    const value=clearRoom();value.messages[0].public_files=[{id:'ordinary-file',room_id:room,bytes:'42',sha256:'a'.repeat(64),media_type:'application/pdf',filename:'source.pdf',encrypted:false}];
    return value;
  },async()=>{});
  const cards=await reader.project(quoteRows(cached)),rendered=overlayQuoteRows(cached,cards);
  assert.equal(JSON.parse(rendered[0].attachments)[1].attachments[0].native_file.id,'ordinary-file');
  assert.equal(JSON.parse(rendered[0].attachments)[1].attachments[1].text,'private source words');
  assert.equal(JSON.parse(rendered[0].attachments)[0].title,'existing integration');
  assert.equal(JSON.stringify(cached),before);assert.ok(!before.includes('private source words'));
  assert.equal(overlayQuoteRows(cached,{})[0],cached[0]);
  assert.equal(requests.filter(r=>r.room==='private-room' && r.synchronize).length,1);
  await reader.close();await assert.rejects(reader.project(quoteRows(cached)),/session_closed/);
});

test('withdrawn descendants lose author and words while an ordinary parent stays readable',async()=>{
  let reads=0;
  const reader=new CryptoQuoteReader('ordinary-destination',async()=>{},async room=>{
    if(room==='clear-room')return clearRoom();return ++reads===1?privateRoom():null;
  },async()=>{});
  const projected=await reader.project(quoteRows(rows())),parent=projected['ordinary-destination-message'][0];
  assert.equal(parent.text,'ordinary parent');const child=parent.attachments?.[0];
  assert.equal(child?.text,'');assert.equal(child?.author_name,undefined);assert.equal(child?.native_unavailable,true);
  assert.ok(!JSON.stringify(projected).includes('private source words'));await reader.close();
});

test('a changed private admission masks the parent and all descendants before publication',async()=>{
  let reads=0;
  const reader=new CryptoQuoteReader('ordinary-destination',async()=>{},async()=>{
    const value=privateRoom();if(++reads>1)value.admission='cd'.repeat(32);return value;
  },async()=>{});
  const cards=await reader.project([{id:'parent',references:[privateReference]}]);
  assert.equal(cards.parent[0].native_unavailable,true);assert.equal(cards.parent[0].text,'');
  assert.equal(cards.parent[0].attachments,undefined);assert.equal(cards.parent[0].author_name,undefined);await reader.close();
});

test('a late private response cannot cross closure or a destination membership change',async()=>{
  for(const close of [true,false]) {
    let release!:()=>void,started!:()=>void,active=true,disposals=0;
    const beginning=new Promise<void>(r=>{started=r;}),waiting=new Promise<void>(r=>{release=r;});
    const reader=new CryptoQuoteReader('ordinary-destination',async()=>{if(!active)throw Error('destination withdrawn');},
      async()=>{started();await waiting;return privateRoom();},async()=>{disposals++;});
    const result=reader.project([{id:'parent',references:[privateReference]}]);await beginning;
    if(close)await reader.close();else active=false;release();
    await assert.rejects(result,close?/session_closed/:/destination withdrawn/);await reader.close();assert.equal(disposals,1);
  }
});

test('a source callback from a different room cannot supply an excerpt',async()=>{
  const reader=new CryptoQuoteReader('ordinary-destination',async()=>{},async()=>({...privateRoom(),room:'wrong-room'}),async()=>{});
  await assert.rejects(reader.project([{id:'parent',references:[privateReference]}]),/crypto_scope_changed/);await reader.close();
});

test('ordinary compose previews require the exact private scope, grant, admission and retained position',async()=>{
  const identity={instance_id:'instance',data_epoch:'epoch'};
  const selection={...identity,reference:privateReference,membership_version:'private-grant',crypto_admission:'ab'.repeat(32)};
  let reads=0,withdraw=false;
  const reader=new CryptoQuoteReader('ordinary-destination',async()=>{},async()=>{
    reads++;return withdraw && reads%2===0?null:privateRoom();
  },async()=>{},identity);
  assert.equal((await reader.previewQuote(selection))?.text,'private source words');
  for(const invalid of [{...selection,instance_id:'other'},{...selection,data_epoch:'other'},{...selection,membership_version:'old'},
    {...selection,crypto_admission:'cd'.repeat(32)},{...selection,crypto_admission:undefined},{...selection,reference:{...privateReference,revision:'2'}}]) {
    assert.equal(await reader.previewQuote(invalid),null);
  }
  reads=0;withdraw=true;assert.equal(await reader.previewQuote(selection),null);
  await reader.close();await assert.rejects(reader.previewQuote(selection),/session_closed/);
});
