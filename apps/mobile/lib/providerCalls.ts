import type {RestClient} from './rest.ts';
import type {Provider} from './provider.ts';
import {setProviderCalls} from './call.ts';

/**
 * Shared lifetime in the application and in the real HTTP/SQLite bench. A
 * RocketVibe server has no video conference: its rooms call through voice
 * sessions (`lib/voice.ts`), so the native mount binds no call provider.
 */
export function mountProviderCalls(client:RestClient,provider:Provider):()=>void {
  client.kind=provider.native?'rocketvibe':'rocketchat';
  return setProviderCalls(client,null);
}
