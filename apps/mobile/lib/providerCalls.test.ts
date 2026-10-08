import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RestClient} from './rest.ts';
import {joinConference} from './call.ts';
import {mountProviderCalls} from './providerCalls.ts';
import type {Provider} from './provider.ts';

test('a kChat call joins kMeet only, whatever the link says',async()=>{
  const client=new RestClient('https://acme.kchat.infomaniak.com');
  const detach=mountProviderCalls(client,{identity:{kind:'kchat'}} as Provider);
  try{
    assert.equal(await joinConference(client,'https://kmeet.infomaniak.com/room'),'https://kmeet.infomaniak.com/room');
    await assert.rejects(joinConference(client,'https://evil.example/room'),/call_url_invalid/);
  }finally{detach();}
});
