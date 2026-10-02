/** Remount private room widgets when an authoritative membership lifetime changes. */
import {Fragment,type ReactNode} from 'react';
import {eq,sql} from 'drizzle-orm';
import type {BaseLocale} from '../db/client.ts';
import {nativeReadStates} from '../db/schema.ts';
import {useRequeteVive} from './requeteVive.ts';

export function BorneAdhesionSalon({base,rid,children}:{base:BaseLocale;rid:string;children:(membership:string|null)=>ReactNode}) {
  const {data,loaded}=useRequeteVive(base.select({membership:sql<string|null>`json_extract(${nativeReadStates.payload}, '$.membership_version')`}).from(nativeReadStates).where(eq(nativeReadStates.rid,rid)),[rid]);
  if(!loaded)return null;
  const membership=data[0]?.membership??null;
  return <Fragment key={JSON.stringify([rid,membership])}>{children(membership)}</Fragment>;
}
