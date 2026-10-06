/** Private durable room forms. Never replace an ambiguous attempt with a fresh nonce. */
import type {ChangeRoomRole, LeaveRoom, UpdateRoom} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';

export type RoomOperation =
  | {kind:'settings';input:UpdateRoom}
  | {kind:'role';target:string;input:ChangeRoomRole}
  | {kind:'leave';input:LeaveRoom};
export type SavedRoomOperation = {room:string;command:RoomOperation;failed:boolean;error:string|null};
export type RoomOperationRow = {id:string;rid:string;payload:string;state:string;error:string|null};

export function roomIdentifier(value:string):boolean { return /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function bytes(value:string):number {
  let count=0;
  for(const char of value){const code=char.codePointAt(0)!;count+=code<128?1:code<2048?2:code<65536?3:4;}
  return count;
}
export function roomOperation(value:unknown):RoomOperation {
  if(value===null || typeof value!=='object' || Array.isArray(value))throw new Error('Invalid room intention');
  const raw=value as Record<string,unknown>;
  let command:RoomOperation;
  switch(raw.kind){
    case 'settings':command={kind:'settings',input:decodeNative('UpdateRoom',raw.input)};break;
    case 'role':
      if(typeof raw.target!=='string' || !roomIdentifier(raw.target))throw new Error('Invalid room target');
      command={kind:'role',target:raw.target,input:{...decodeNative('ChangeRoomRole',raw.input)}};break;
    case 'leave':command={kind:'leave',input:{...decodeNative('LeaveRoom',raw.input)}};break;
    default:throw new Error('Invalid room intention');
  }
  if(Object.keys(raw).some(key=>!['kind','input',...(command.kind==='role'?['target']:[])].includes(key))
    || !roomIdentifier(command.input.operation_id) || !roomIdentifier(command.input.expected_revision))throw new Error('Invalid room intention');
  if(command.kind==='settings'){
    const input={...command.input,name:command.input.name.trim()};
    if(!input.name || bytes(input.name)>128 || /[\x00-\x1f\x7f-\x9f]/.test(input.name)
      || bytes(input.topic)>1024 || bytes(input.description)>4096 || bytes(input.announcement)>4096
      || [input.topic,input.description,input.announcement].some(text=>text.includes('\0')))throw new Error('Invalid room settings');
    command={kind:'settings',input};
  }
  return command;
}
export function sameRoomForm(left:RoomOperation,right:RoomOperation):boolean {
  if(left.kind!==right.kind)return false;
  if(left.kind==='settings' && right.kind==='settings')return ['name','private','topic','description','announcement','read_only'].every(key=>left.input[key as keyof UpdateRoom]===right.input[key as keyof UpdateRoom]);
  if(left.kind==='role' && right.kind==='role')return left.target===right.target && left.input.role===right.input.role;
  return true;
}
export function savedRoomOperation(row:RoomOperationRow):SavedRoomOperation {
  const command=roomOperation(JSON.parse(row.payload));
  if(command.input.operation_id!==row.id || !roomIdentifier(row.rid) || !['pending','failed'].includes(row.state)
    || (row.error!==null && !roomIdentifier(row.error)))throw new Error('Invalid saved room intention');
  return {room:row.rid,command,failed:row.state==='failed',error:row.error};
}
