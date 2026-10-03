/** Read the real server card through the mobile engine and its SQLite cache. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
import {NativeStore,localMessage} from '../apps/mobile/fournisseurs/rocketvibe/store.ts';
import {NativeChat} from '../apps/mobile/fournisseurs/rocketvibe/chat.ts';
import {nativeTestDatabase} from '../apps/mobile/fournisseurs/rocketvibe/testDatabase.ts';
import {creerFileEcritures} from '../apps/mobile/db/fileEcritures.ts';
import {carteIntegration} from '../apps/mobile/lib/cartesIntegration.ts';
const base=process.env.RV_CARDS_TEST_SERVER!,room=process.env.RV_CARDS_TEST_ROOM!,id=process.env.RV_CARDS_TEST_MESSAGE!;
const transport=new NativeTransport(base),discovery=await transport.discover();assert.equal(discovery.capabilities.structured_cards,true);
const auth=await transport.login('cards-owner','disposable-cards-password');
const session={baseUrl:base,authToken:auth.token,userId:auth.user.id,username:auth.user.username,genre:'rocketvibe' as const,siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const h=nativeTestDatabase(),store=new NativeStore(h.adapter,creerFileEcritures(),session),chat=new NativeChat(session,store,randomUUID,{transport});
try {
  await chat.connect();
  const row=h.db.prepare('SELECT pieces_jointes FROM messages WHERE id=?').get(id) as {pieces_jointes:string};assert(row);
  const card=carteIntegration(JSON.parse(row.pieces_jointes)[0])!;assert.equal(card.titre,'Release ready');assert.equal(card.champs[0].valeur,'abcdef');
  const hits=await chat.searchMessages(room,'abcdef');assert.equal(hits.length,1);assert.equal(hits[0].id,id);
  const temporary=carteIntegration(JSON.parse(localMessage(hits[0]).piecesJointes!)[0])!;assert.deepEqual(temporary,card);
  console.log(JSON.stringify({integration_card_http_sqlite:'passed',existing_presentation:'verified',temporary_search:'verified'}));
} finally {chat.stop();await store.state();h.db.close();}
