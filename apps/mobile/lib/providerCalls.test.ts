import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestClient} from './rest.ts';
import {joinConference,probeCallAvailable,startConference} from './call.ts';
import {mountProviderCalls} from './providerCalls.ts';
import type {Provider} from './provider.ts';
import {MmClient} from '../providers/mattermost/client.ts';
import {kmeetCalls} from '../providers/mattermost/kmeet.ts';
import {fakeServer} from '../providers/mattermost/testing.ts';

test('a kChat call starts and joins through the server\'s conferences, on kMeet only',async()=>{
  let url='https://kmeet.infomaniak.com/room';
  const server=fakeServer((call)=>{
    if(call.method==='POST'&&call.path==='/conferences')return {status:201,body:{id:'conf-1',url,jwt:'j w'}};
    if(call.method==='POST'&&call.path==='/conferences/conf-1/answer')return {body:{id:'conf-1',url,jwt:'j w'}};
    return undefined;
  },'https://acme.kchat.infomaniak.com');
  const client=new RestClient('https://acme.kchat.infomaniak.com');
  const detach=mountProviderCalls(client,{identity:{kind:'kchat'},calls:kmeetCalls(new MmClient(server.base,'tok',{fetch:server.fetcher}))} as unknown as Provider);
  try{
    assert.equal(await probeCallAvailable(client),true);
    assert.equal(await startConference(client,'room-id'),'conf-1');
    assert.deepEqual(server.calls[0]?.body,{channel_id:'room-id'});
    assert.equal(await joinConference(client,'conf-1'),'https://kmeet.infomaniak.com/room?jwt=j%20w');
    url='https://evil.example/room';
    await assert.rejects(joinConference(client,'conf-1'),/call_url_invalid/);
  }finally{detach();}
});
