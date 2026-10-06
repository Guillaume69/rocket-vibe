import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeRoomPermalink,parseRoomLink,roomLinkMatches,serviceUrl,systemRoomPath} from './roomLinks.ts';
import type {Session} from './auth.ts';
const alice:Session={baseUrl:'https://chat.example.org/native',userId:'alice',username:'alice',authToken:'private-bearer',kind:'rocketvibe',siteUrl:null,nativeInstanceId:'instance',nativeDataEpoch:'epoch'};
test('native message links retain the service and actual thread while remaining shareable',()=>{
  const url=nativeRoomPermalink(alice,'room','reply','root')!;
  assert(!url.includes('alice')&&!url.includes('private-bearer'));
  const link=parseRoomLink(url)!;
  assert.equal(link.root,'root');assert.equal(link.message,'reply');assert(roomLinkMatches(link,alice));
  assert(roomLinkMatches(link,{...alice,userId:'bob'}));
  for(const other of [{...alice,baseUrl:'https://chat.example.org/other'},{...alice,baseUrl:'http://chat.example.org/native'},{...alice,baseUrl:'https://chat.example.org:8443/native'},{...alice,nativeDataEpoch:'restored'},{...alice,kind:'rocketchat' as const}])assert(!roomLinkMatches(link,other));
});
test('legacy and pinned notification scopes cannot select a foreign provider or account',()=>{
  const legacy=parseRoomLink('rocketvibe://salon/%72oom?host=https%3A%2F%2Fchat.example.org%2Fnative')!;
  assert(!roomLinkMatches(legacy,alice));assert(roomLinkMatches(legacy,{...alice,kind:'rocketchat'}));
  const url=new URL('rocketvibe://room/room');url.searchParams.set('host',alice.baseUrl);url.searchParams.set('nativeScope',JSON.stringify({instanceId:'instance',dataEpoch:'epoch',userId:'alice'}));
  const pinned=parseRoomLink(url.toString())!;
  assert(roomLinkMatches(pinned,alice));assert(!roomLinkMatches(pinned,{...alice,userId:'bob'}));
  assert.equal(new URL(systemRoomPath(url.toString())!,'https://app.test').searchParams.get('roomLink'),url.toString());
});
test('malformed service and identity parameters never degrade to an unscoped route',()=>{
  for(const url of ['https://salon/room','rocketvibe://salon/room/extra','rocketvibe://salon/room?host=file%3A%2F%2F%2Ftmp','rocketvibe://salon/room?host=https%3A%2F%2Fbearer%40chat.example.org','rocketvibe://salon/room?host=chat.example.org&host=other.example.org','rocketvibe://salon/room?instanceId=instance','rocketvibe://salon/room?userId=alice','rocketvibe://salon/room?nativeScope=null','rocketvibe://salon/room?msg=..%2Fsecret','rocketvibe://salon/room#token'])assert.equal(parseRoomLink(url),null,url);
  assert.equal(serviceUrl('https://CHAT.example.org:443/native/'),alice.baseUrl);
  assert.equal(systemRoomPath('/share'),'/share');
  assert.equal(systemRoomPath('rocketvibe://salon/room?nativeScope=null'),'/room/invalid?roomLink=invalid');
});
