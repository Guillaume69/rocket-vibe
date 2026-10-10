/**
 * Video calls in the existing screens, with the session's provider.
 * RocketVibe uses the native binding below; Rocket.Chat keeps its REST
 * video-conference endpoints.
 *
 * The engine is the provider configured SERVER-SIDE (Jitsi on the target
 * `chat.barrut.me`). As everywhere, we ACT over REST, never a DDP method,
 * deprecated since 8.0:
 *
 *   - `video-conference.start`  creates the conference AND posts the call message
 *     in the room; returns a `callId`.
 *   - `video-conference.join`   returns the provider URL (JWT included) to open
 *     to enter the call.
 *   - `video-conference.capabilities` is the availability PROBE: the server
 *     answers 400 `no-videoconf-provider-app` when no provider is plugged in
 *     (the local Docker case), so we hide the call button.
 *
 * The call is RENDERED in a WebView (`app/call/[callId].tsx`): Jitsi is a web
 * app, so loading it in a WebView is the only reasonable IN-APP path. The native
 * Jitsi SDK targets `react-native ~0.79` (we are on 0.86) and ships
 * react-native-webrtc, too risky under the New Architecture for the gain.
 *
 * Module without `react-native`: it depends only on the REST client, like `rest.ts`.
 */

import { RestError, isTokenRejected } from './rest.ts';
import type { RestClient } from './rest.ts';

export type CallScope={room?:string;membership?:string|null;alive?:()=>boolean};
export type NativeCalls={
  available:(room?:string,membership?:string|null)=>Promise<boolean>;
  memo:()=>boolean;
  start:(room:string,membership:string|null|undefined,alive:()=>boolean)=>Promise<string>;
  join:(id:string,scope:CallScope,alive:()=>boolean,state?:{cam?:boolean;mic?:boolean})=>Promise<string>;
};
type Binding={key:string;calls:NativeCalls|null};
const bindings=new WeakMap<RestClient,Binding>(),identities=new WeakMap<RestClient,string>();
let serial=0;
let availabilityByClient=new WeakMap<RestClient,boolean>();

/** A callback belongs to this provider mount, even when the ClientRest object is reused. */
export function setProviderCalls(client:RestClient,calls:NativeCalls|null):()=>void {
  const binding={key:`appels-${++serial}`,calls};bindings.set(client,binding);availabilityByClient.delete(client);
  return()=>{if(bindings.get(client)===binding){bindings.delete(client);availabilityByClient.delete(client);}};
}
/** Ephemeral route scope, containing neither bearer nor participant token. */
export function callContext(client:RestClient):string {
  const bound=bindings.get(client);if(bound)return bound.key;
  let id=identities.get(client);if(!id){id=`client-${++serial}`;identities.set(client,id);}return id;
}
function current(client:RestClient,binding:Binding|undefined,scope:CallScope={}):boolean {
  return bindings.get(client)===binding && scope.alive?.()!==false;
}
function check(client:RestClient,binding:Binding|undefined,scope:CallScope={}):void {
  if(!current(client,binding,scope))throw new Error('call_scope_closed');
  if(client.kind==='rocketvibe'&&!binding?.calls)throw new Error('call_provider_unavailable');
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

type StartResponse = { data?: { callId?: unknown } };
type JoinResponse = { url?: unknown };

/**
 * Starts a conference in room `roomId` and returns its `callId`. This call is
 * also what makes the "call started" message appear for every room member:
 * that is how the other party is notified, since mobile ringing
 * (`VideoConf_Mobile_Ringing`) is disabled on the target.
 */
export async function startConference(client: RestClient, roomId: string,scope:CallScope={}): Promise<string> {
  const binding=bindings.get(client);check(client,binding,scope);
  if(binding?.calls){
    const id=await binding.calls.start(roomId,scope.membership,()=>current(client,binding,scope));
    check(client,binding,scope);return id;
  }
  const r = await client.post<StartResponse>('video-conference.start', { body: { roomId } });
  check(client,binding,scope);
  const callId = asString(r.data?.callId);
  if (callId === null) throw new RestError('The server returned no call id.', 0);
  return callId;
}

/**
 * Provider URL to open to JOIN call `callId` (JWT included if the server
 * requires Jitsi authentication). `state` presets camera/mic on entry; omitted,
 * the provider decides.
 */
export async function joinConference(
  client: RestClient,
  callId: string,
  state?: { cam?: boolean; mic?: boolean },
  scope:CallScope={},
): Promise<string> {
  const binding=bindings.get(client);check(client,binding,scope);
  if(binding?.calls){
    const url=await binding.calls.join(callId,scope,()=>current(client,binding,scope),state);
    check(client,binding,scope);return url;
  }
  const r = await client.post<JoinResponse>('video-conference.join', {
    body: state === undefined ? { callId } : { callId, state },
  });
  check(client,binding,scope);
  const url = asString(r.url);
  if (url === null) throw new RestError('The server returned no call URL.', 0);
  return url;
}

/**
 * The meeting's own address, to share (`video-conference.info`), WITHOUT the
 * query nor the fragment: the URL `join` returns carries the joiner's signed
 * token (`?jwt=`), which must never be handed to someone else. The desktop's
 * `call::meeting_link`. `null` when the provider gives no address.
 */
export async function meetingLink(client: RestClient, callId: string): Promise<string | null> {
  const r = await client.get<{ url?: unknown }>('video-conference.info', { params: { callId } });
  const url = asString(r.url);
  return url === null ? null : withoutToken(url);
}

/** `url` cut before its query or fragment. */
export function withoutToken(url: string): string {
  return url.split(/[?#]/u)[0] ?? url;
}

/**
 * Rocket.Chat availability, MEMOIZED per session client: the probe costs only
 * one call per session, however many rooms are opened.
 *
 * A missing provider (400) is a DEFINITIVE "no" for the session, so memoized.
 * A network failure (`status === 0`) is uncertain, so not memoized: the next
 * room opening retries. When in doubt, return `false`: a missing button beats
 * a button that fails on tap.
 *
 * RocketVibe checks the current configuration and membership on every probe.
 */
export async function probeCallAvailable(client: RestClient,room?:string,membership?:string|null): Promise<boolean> {
  const binding=bindings.get(client);
  if(binding?.calls || client.kind==='rocketvibe'){
    if(!binding?.calls)return false;
    const available=await binding.calls.available(room,membership);
    return current(client,binding)&&available;
  }
  const memo = availabilityByClient.get(client);
  if (memo !== undefined) return memo;
  try {
    await client.get('video-conference.capabilities');
    if(!current(client,binding))return false;
    availabilityByClient.set(client, true);
    return true;
  } catch (e) {
    // A 401 says nothing about video conferencing, it says the session is over.
    // Memoizing it turned the call button off for the life of the process, even
    // after a successful reconnection, and no gesture got out of it.
    if (current(client,binding) && e instanceof RestError && e.status >=400 && e.status<500 && e.status!==429 && !isTokenRejected(e)) {
      availabilityByClient.set(client, false);
    }
    return false;
  }
}

/** Session end / server change: the verdict belongs to one account. */
export function forgetCallAvailability(): void {
  availabilityByClient=new WeakMap();
}

/**
 * SYNCHRONOUS read of the memo, without probing: `false` while unknown (same
 * cautious default as the probe). Pins the "Call" button's presence from the
 * first frame when the probe has already run (preloaded profile).
 */
export function memoizedCallAvailable(client: RestClient): boolean {
  const calls=bindings.get(client)?.calls;
  if(calls || client.kind==='rocketvibe')return calls?.memo()??false;
  return availabilityByClient.get(client) ?? false;
}
