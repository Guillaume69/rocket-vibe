import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativePushMatches,nativePushScope,nativePushServerUrl} from './nativePushNavigation.ts';
import {roomNotificationId} from './notificationId.ts';
import type {Session} from './auth.ts';
const session:Session={baseUrl:'https://chat.example.org/native',authToken:'private-bearer',userId:'alice',username:'alice',kind:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
test('notification navigation binds the original account, instance and restore epoch',()=>{
  const scope=nativePushScope(JSON.stringify({instanceId:'instance',dataEpoch:'epoch',userId:'alice'}))!;
  assert(nativePushMatches(scope,session));
  for(const changed of [{...session,userId:'bob'},{...session,nativeInstanceId:'other'},{...session,nativeDataEpoch:'restored'},{...session,kind:'rocketchat' as const}])assert(!nativePushMatches(scope,changed));
  for(const input of [null,[],JSON.stringify({instanceId:'instance',dataEpoch:'epoch',userId:'../alice'}),'null','x'.repeat(1025)])assert.equal(nativePushScope(input),null);
});
test('server switching keeps proxy base paths and rejects URLs carrying credentials or query parameters',()=>{
  assert.equal(nativePushServerUrl('https://chat.example.org/native/'),session.baseUrl);
  assert.notEqual(nativePushServerUrl('https://chat.example.org/other'),session.baseUrl);
  for(const url of ['https://bearer@chat.example.org/native','https://chat.example.org/native?token=secret','https://chat.example.org/native#fragment','file:///tmp','invalid'])assert.equal(nativePushServerUrl(url),null);
});
test('notification dismissal and grouping cannot collide across native accounts or restore epochs',()=>{
  const id=roomNotificationId('room',session);
  assert.notEqual(id,roomNotificationId('room',{...session,userId:'bob'}));
  assert.notEqual(id,roomNotificationId('room',{...session,nativeDataEpoch:'restored'}));
  assert.notEqual(id,roomNotificationId('room'));
  assert.equal(roomNotificationId('room',{...session,kind:'rocketchat'}),roomNotificationId('room'));
});
