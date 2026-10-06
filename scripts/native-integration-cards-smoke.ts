/** Read the real server card through the mobile engine and its SQLite cache. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';
import {NativeStore,localMessage} from '../apps/mobile/providers/rocketvibe/store.ts';
import {NativeChat} from '../apps/mobile/providers/rocketvibe/chat.ts';
import {nativeTestDatabase} from '../apps/mobile/providers/rocketvibe/testDatabase.ts';
import {createWriteQueue} from '../apps/mobile/db/writeQueue.ts';
import {integrationCard} from '../apps/mobile/lib/integrationCards.ts';
const base=process.env.RV_CARDS_TEST_SERVER!,room=process.env.RV_CARDS_TEST_ROOM!,id=process.env.RV_CARDS_TEST_MESSAGE!;
const transport=new NativeTransport(base),discovery=await transport.discover();assert.equal(discovery.capabilities.structured_cards,true);
const auth=await transport.login('cards-owner','disposable-cards-password');
const session={baseUrl:base,authToken:auth.token,userId:auth.user.id,username:auth.user.username,kind:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const h=nativeTestDatabase(),store=new NativeStore(h.adapter,createWriteQueue(),session),chat=new NativeChat(session,store,randomUUID,{transport});
try {
  await chat.connect();
  const row=h.db.prepare('SELECT attachments FROM messages WHERE id=?').get(id) as {attachments:string};assert(row);
  const card=integrationCard(JSON.parse(row.attachments)[0])!;assert.equal(card.title,'Release ready');assert.equal(card.fields[0].value,'abcdef');
  const hits=await chat.searchMessages(room,'abcdef');assert.equal(hits.length,1);assert.equal(hits[0].id,id);
  const temporary=integrationCard(JSON.parse(localMessage(hits[0]).attachments!)[0])!;assert.deepEqual(temporary,card);
  console.log(JSON.stringify({integration_card_http_sqlite:'passed',existing_presentation:'verified',temporary_search:'verified'}));
} finally {chat.stop();await store.state();h.db.close();}
