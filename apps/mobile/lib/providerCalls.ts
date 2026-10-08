import type {RestClient} from './rest.ts';
import type {Provider} from './provider.ts';
import {setProviderCalls,type NativeCalls} from './call.ts';

/**
 * Shared lifetime in the application and in the real HTTP/SQLite bench. A
 * RocketVibe server has no video conference: its rooms call through voice
 * sessions (`lib/voice.ts`), so the native mount binds no call provider.
 */
export function mountProviderCalls(client:RestClient,provider:Provider):()=>void {
  client.kind=provider.identity.kind;
  return setProviderCalls(client,provider.identity.kind==='kchat'?KMEET:null);
}

/** kChat calls are kMeet meetings: a call post's `callId` is the meeting URL, joined as is. Starting one is not mapped. */
const KMEET:NativeCalls={
  available:async()=>false,
  memo:()=>false,
  start:async()=>{throw new Error('call_start_unavailable');},
  join:async(id)=>{if(!/^https:\/\//i.test(id))throw new Error('call_url_invalid');return id;},
};
