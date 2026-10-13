import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import type {Session} from '../../lib/auth.ts';
import {registerNativePush} from './push.ts';
import {NativeTransport,NativeError} from './transport.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const discovery={...fixture.discovery,capabilities:{...fixture.discovery.capabilities,push:true}};
const session:Session={baseUrl:'https://example.org/native',authToken:'opaque-test-bearer',kind:'rocketvibe',userId:'alice',username:'alice',siteUrl:null,nativeInstanceId:discovery.instance_id,nativeDataEpoch:discovery.data_epoch};
const receipt={device_id:'family-device',instance_id:discovery.instance_id,data_epoch:discovery.data_epoch};

test('FCM registration pins discovery and persists only the own device family after confirmation',async()=>{
  const calls:{path:string;method:string;headers:Headers;body:unknown}[]=[];
  const remote=new NativeTransport(session.baseUrl,async(url,init)=>{
    calls.push({path:String(url),method:init!.method!,headers:new Headers(init!.headers),body:init!.body?JSON.parse(String(init!.body)):null});
    return Response.json(String(url).endsWith('/me/push')?receipt:discovery);
  });remote.restore(session.authToken);
  const saved:string[]=[];
  await registerNativePush(session,'fixture-fcm-token',async(s,device)=>{assert.equal(s,session);saved.push(device);},remote);
  assert.deepEqual(saved,['family-device']);
  assert.deepEqual(calls.map(c=>c.method),['GET','PUT','GET']);
  assert.equal(calls[0].headers.get('authorization'),null);
  assert.equal(calls[1].headers.get('authorization'),'Bearer '+session.authToken);
  assert.deepEqual(calls[1].body,{token:'fixture-fcm-token'});
  assert(calls.every(c=>c.path.startsWith(session.baseUrl)));
});
test('wrong instance, epoch, malformed device and changed discovery never reach SecureStore',async()=>{
  for(const altered of [{...receipt,instance_id:'foreign'},{...receipt,data_epoch:'restored'},{...receipt,device_id:'../device'}]){
    const remote=new NativeTransport(session.baseUrl,async url=>Response.json(String(url).endsWith('/me/push')?altered:discovery));remote.restore(session.authToken);
    let saved=false;
    await assert.rejects(registerNativePush(session,'fixture-fcm-token',async()=>{saved=true;},remote),NativeError);
    assert.equal(saved,false);
  }
  let discoveries=0;
  const remote=new NativeTransport(session.baseUrl,async url=>Response.json(String(url).endsWith('/me/push')?receipt:++discoveries===1?discovery:{...discovery,data_epoch:'restored'}));remote.restore(session.authToken);
  await assert.rejects(registerNativePush(session,'fixture-fcm-token',async()=>assert.fail('stale receipt'),remote),NativeError);
});
test('disabled push stays unavailable and a revoked local session cannot adopt a late receipt',async()=>{
  let registrations=0;
  const disabled=new NativeTransport(session.baseUrl,async()=>Response.json({...discovery,capabilities:{...discovery.capabilities,push:false}}));disabled.restore(session.authToken);
  await assert.rejects(registerNativePush(session,'fixture-fcm-token',async()=>{registrations++;},disabled),NativeError);
  assert.equal(registrations,0);
  const remote=new NativeTransport(session.baseUrl,async url=>Response.json(String(url).endsWith('/me/push')?receipt:discovery));remote.restore(session.authToken);
  await assert.rejects(registerNativePush(session,'fixture-fcm-token',async()=>{throw new NativeError(0,'session_closed');},remote),/session_closed/);
});
test('content retrieval and unregister use the native bearer API exclusively',async()=>{
  const calls:{url:string;method:string}[]=[];
  const remote=new NativeTransport(session.baseUrl,async(url,init)=>{
    calls.push({url:String(url),method:init!.method!});
    assert.equal(new Headers(init!.headers).get('authorization'),'Bearer '+session.authToken);
    if(init!.method==='DELETE')return new Response(null,{status:204});
    return Response.json({notification_id:'notification',...receipt,room:fixture.room,message:fixture.message});
  });remote.restore(session.authToken);
  assert.equal((await remote.pushContent('notification')).notification_id,'notification');
  await remote.unregisterPush();
  assert.deepEqual(calls.map(c=>c.method),['GET','DELETE']);
  assert(calls[0].url.endsWith('/api/v1/push/notifications/notification'));
  assert(calls[1].url.endsWith('/api/v1/me/push'));
});
