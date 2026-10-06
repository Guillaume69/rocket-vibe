/** Private original intentions saved before HTTP. No cached watermark replaces an observed ID. */
import type {SetRoomFavorite} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {readDecimal} from './readStates.ts';
import {roomIdentifier} from './roomOperations.ts';

export type PendingRead={room:string;membership:string;root_position:string};
export type FavoriteRow={id:string;rid:string;membership:string;payload:string;phase:string;receipt_revision:string|null;error:string|null};
export type SavedFavorite={room:string;membership:string;input:SetRoomFavorite;phase:'pending'|'confirmed'|'failed';receiptRevision:string|null;error:string|null};
export const FAVORITE_SELECT='SELECT id,rid,membership,payload,phase,receipt_revision,error FROM native_favorite_intents';
export function savedFavorite(row:FavoriteRow):SavedFavorite {
  const input=decodeNative('SetRoomFavorite',JSON.parse(row.payload));
  if(input.operation_id!==row.id || ![row.id,row.rid,row.membership].every(roomIdentifier)
    || !['pending','confirmed','failed'].includes(row.phase) || row.error!==null && !roomIdentifier(row.error))throw new Error('Invalid saved favorite');
  const expected=readDecimal(input.expected_revision);
  const floor=row.receipt_revision===null?null:readDecimal(row.receipt_revision);
  if((row.phase==='confirmed')!==(floor!==null) || floor!==null && floor<expected)throw new Error('Invalid favorite receipt floor');
  return {room:row.rid,membership:row.membership,input,phase:row.phase as SavedFavorite['phase'],receiptRevision:row.receipt_revision,error:row.error};
}
