// Real native HTTP -> SQLite -> existing mobile presentation. Disposable accounts.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
const owner=new NativeTransport(process.env.RV_ROOM_PEER_URL!),reader=new NativeTransport(process.env.RV_ROOM_PEER_URL!);
await owner.login('read-owner','read-test-password-2026');
const account=await reader.login('read-member','read-test-password-2026'),discovery=await reader.discover(),room=process.env.RV_ROOM_PEER_ROOM!;
const fixture=JSON.parse(readFileSync(new URL('../docs/protocol/native-rendering.fixture.json',import.meta.url),'utf8')) as {cases:{id:string;source:string;document:unknown;local_tree:unknown}[]};
const posted=[];
for(const row of fixture.cases) {
  const message=await owner.send(room,{operation_id:`native-rich-${row.id}`,text:row.source});
  assert.deepEqual(message.body,row.document,row.id);posted.push(message);
}
const {db,adapter}=nativeTestDatabase();
try {
  const session={baseUrl:process.env.RV_ROOM_PEER_URL!,authToken:account.token,userId:account.user.id,username:account.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
  const cache=new NativeStore(adapter,creerFileEcritures(),session);
  await cache.applySnapshot(await reader.snapshot());
  for(let i=0;i<posted.length;i++) {
    const md=(await adapter.getFirstAsync<{md:string}>('SELECT md FROM messages WHERE id=?',[posted[i].id]))!.md;
    assert.deepEqual(JSON.parse(md),fixture.cases[i].local_tree,fixture.cases[i].id);
  }
  const old=posted[1],updated=await owner.editMessage(old.id,{operation_id:'rich-edit',expected_revision:old.revision,content:{kind:'plain',markdown:'**Édité** @read-member',mentions:[],quotes:[],files:[]}});
  await cache.ingest([updated]);await cache.ingest([old]);
  const md=(await adapter.getFirstAsync<{md:string}>('SELECT md FROM messages WHERE id=?',[old.id]))!.md;
  assert.match(md,/Édité/);assert.doesNotMatch(md,/imbriqué/);
  const deleted=await owner.deleteMessage(old.id,{operation_id:'rich-delete',expected_revision:updated.revision});
  assert.equal(deleted.body,undefined);assert.equal(deleted.text,'');
  await cache.ingest([deleted]);await cache.ingest([updated]);
  assert.equal(await adapter.getFirstAsync('SELECT md FROM messages WHERE id=?',[old.id]),null);
  console.log(JSON.stringify({canonicalNativeBody:true,existingMobileRenderer:true,revisionAndDeletion:true,cases:fixture.cases.length}));
} finally {db.close();}
