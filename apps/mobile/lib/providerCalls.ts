import type {RestClient} from './rest.ts';
import type {Provider} from './provider.ts';
import {setProviderCalls} from './call.ts';
import {meetingMediaState} from '../providers/rocketvibe/meetings.ts';

/** Shared lifetime in the application and in the real HTTP/SQLite bench. */
export function mountProviderCalls(client:RestClient,provider:Provider):()=>void {
  const chat=provider.native?.chat;
  client.kind=chat?'rocketvibe':'rocketchat';
  return setProviderCalls(client,chat?{
    available:(room,membership)=>chat.callAvailable(room,membership),
    memo:()=>chat.callsActive,
    start:(room,membership,alive)=>chat.startCall(room,membership,alive),
    join:async(id,scope,alive,state)=>meetingMediaState(await chat.joinCall(id,scope.room,scope.membership,alive),state),
  }:null);
}
