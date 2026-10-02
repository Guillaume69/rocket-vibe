/** Read/favorite ordering is independent from metadata and uses exact decimals. */
import type {ReadState} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {roomIdentifier} from './roomOperations.ts';

export function readState(value:unknown,rid:string):ReadState {
  const state={...decodeNative('ReadState',value)};
  if(state.favorite_revision==null)delete state.favorite_revision;
  if(state.membership_version==null)delete state.membership_version;
  if(state.room_id!==rid)throw new Error('Mismatched native read state');
  for(const key of ['revision','root_position','reply_position','unread_roots','unread_replies','mentions','group_mentions'] as const){
    if(!/^(0|[1-9]\d*)$/.test(state[key]) || state[key].length>20 || BigInt(state[key])>18446744073709551615n)throw new Error('Invalid native read position');
  }
  if(state.favorite_revision!=null && (!/^(0|[1-9]\d*)$/.test(state.favorite_revision) || BigInt(state.favorite_revision)>BigInt(state.revision)))throw new Error('Invalid native favorite version');
  if(state.membership_version!=null && !roomIdentifier(state.membership_version))throw new Error('Invalid native membership version');
  return state;
}
export function readOrder(next:ReadState,old:ReadState):'older'|'same'|'reset' {
  if(BigInt(next.revision)<BigInt(old.revision))return 'older';
  if(next.revision===old.revision){
    for(const key of ['room_id','revision','root_position','reply_position','unread_roots','unread_replies','mentions','group_mentions','favorite','membership_version','favorite_revision'] as const){
      if(next[key]!==old[key])throw new Error('Conflicting native read version');
    }
  }
  if(next.membership_version!==old.membership_version)return 'reset';
  if(BigInt(next.root_position)<BigInt(old.root_position) || BigInt(next.reply_position)<BigInt(old.reply_position))throw new Error('Regressing native read state');
  if(next.favorite_revision!=null && old.favorite_revision!=null && BigInt(next.favorite_revision)<BigInt(old.favorite_revision))throw new Error('Regressing native favorite version');
  return 'same';
}
