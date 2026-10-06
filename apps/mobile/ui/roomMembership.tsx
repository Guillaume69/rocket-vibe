/** Remount private room widgets when an authoritative membership lifetime changes. */
import {Fragment,type ReactNode} from 'react';
import {eq,sql} from 'drizzle-orm';
import type {LocalDatabase} from '../db/client.ts';
import {nativeReadStates} from '../db/schema.ts';
import {useCoalescedLiveQuery} from './liveQuery.ts';

export function RoomMembershipBound({base,rid,children}:{base:LocalDatabase;rid:string;children:(membership:string|null)=>ReactNode}) {
  const {data,loaded}=useCoalescedLiveQuery(base.select({membership:sql<string|null>`json_extract(${nativeReadStates.payload}, '$.membership_version')`}).from(nativeReadStates).where(eq(nativeReadStates.rid,rid)),[rid]);
  if(!loaded)return null;
  const membership=data[0]?.membership??null;
  return <Fragment key={JSON.stringify([rid,membership])}>{children(membership)}</Fragment>;
}
