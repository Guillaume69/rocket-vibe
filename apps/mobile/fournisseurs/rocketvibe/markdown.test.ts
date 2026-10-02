import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {arbreDuMessage,unicodeDEmoji} from '../../lib/markdown.ts';
import {localMessage,NativeStore} from './store.ts';
import {nativeMarkdown,nativeTree} from './markdown.ts';
import {decodeNative} from './validation.ts';
import {nativeTestDatabase} from './testDatabase.ts';
import {creerFileEcritures} from '../../db/fileEcritures.ts';
import type {Message,Snapshot,Document,Node as NativeNode} from './protocol.generated.ts';

type Local={type?:string;value?:unknown;shortCode?:string;unicode?:string};
function visible(value:unknown):string {
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(visible).join('');
  if(value===null || typeof value!=='object')return '';
  const node=value as Local;
  if(node.type==='EMOJI')return unicodeDEmoji(node)??`:${node.shortCode}:`;
  if(node.type==='MENTION_USER')return `@${visible(node.value)}`;
  if(node.type==='MENTION_CHANNEL')return `#${visible(node.value)}`;
  if(node.type==='LINK')return visible((node.value as {label?:unknown}).label);
  if(node.type==='CODE')return (node.value as unknown[]).map(visible).join('\n');
  return visible(node.value);
}
function mentions(value:unknown):string[] {
  if(Array.isArray(value))return value.flatMap(mentions);
  if(value===null || typeof value!=='object')return [];
  const node=value as Local;
  return node.type==='MENTION_USER'?[visible(node.value)]:Object.values(value).flatMap(mentions);
}
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/native-rendering.fixture.json',import.meta.url),'utf8')) as {cases:{id:string;source:string;document:unknown;local_tree:unknown;mentions:string[];contains:string[]}[]};
test('native corpus crosses schema, local projection and existing mobile renderer',()=>{
  for(const row of fixture.cases) {
    const document=decodeNative('Document',row.document);
    assert.deepEqual(nativeTree(document),row.local_tree,row.id);
    const md=nativeMarkdown(document),tree=arbreDuMessage(md,row.source);
    const shown=visible(tree);
    for(const expected of row.contains)assert.ok(shown.includes(expected),`${row.id} missing ${expected}: ${shown}`);
    assert.deepEqual([...new Set(mentions(tree))].sort(),row.mentions.filter(name=>name!=='here').sort(),row.id);
    assert.equal(nativeMarkdown(undefined),null);
  }
});
test('optional list attributes retain bullets without NaN or phantom checkboxes',()=>{
  const doc:Document={format:'native1',nodes:[{kind:'list',children:[{kind:'list_item',children:[{kind:'paragraph',children:[{kind:'text',text:'item'}]}]}]}]};
  assert.equal(nativeTree(doc)[0].type,'UNORDERED_LIST');
  assert.doesNotMatch(JSON.stringify(nativeTree(doc)),/NaN|TASKS/);
});
test('deep native documents are refused before recursive UI conversion',()=>{
  let node:NativeNode={kind:'text',text:'safe'};
  for(let i=0;i<70;i++)node={kind:'quote',children:[node]};
  assert.throws(()=>decodeNative('Document',{format:'native1',nodes:[node]}),/Invalid RocketVibe/);
  assert.throws(()=>decodeNative('Document',{format:'html',nodes:[]}),/Invalid RocketVibe/);
});
test('native SQLite replaces rich bodies by revision and clears them on deletion',async()=>{
  const {db,adapter}=nativeTestDatabase();
  const session={baseUrl:'http://localhost:3400',authToken:'test-token',userId:'self',username:'self',genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:'fixture-instance',nativeDataEpoch:'fixture-epoch'};
  const store=new NativeStore(adapter,creerFileEcritures(),session);
  const source=fixture.cases.find(c=>c.id==='styles')!;
  const message=decodeNative('Message',{id:'rich',room_id:'room',author:{id:'other',username:'alice',display_name:'Alice'},text:source.source,body:source.document,created_at:'2026-10-02T08:00:00Z',position:'1',revision:'1'});
  const snapshot:Snapshot={protocol_version:1,cursor:'1',rooms:[{id:'room',name:'Room',kind:'private',revision:'1'}],messages:[message]};
  await store.applySnapshot(snapshot);
  assert.equal((await adapter.getFirstAsync<{md:string}>('SELECT md FROM messages WHERE id=?',['rich']))!.md,localMessage(message).md);
  const edited:Message={...message,text:'plain',revision:'2',body:{format:'native1',nodes:[{kind:'paragraph',children:[{kind:'text',text:'plain'}]}]}};
  await store.ingest([edited]);await store.ingest([message]);
  assert.equal(visible(arbreDuMessage((await adapter.getFirstAsync<{md:string}>('SELECT md FROM messages WHERE id=?',['rich']))!.md,null)),'plain');
  await store.ingest([{...edited,text:'',deleted:true,revision:'3',body:message.body}]);
  assert.equal(await adapter.getFirstAsync('SELECT id FROM messages WHERE id=?',['rich']),null);
  db.close();
});
