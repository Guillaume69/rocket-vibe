import type { CardActionAnswer } from './provider.ts';

/** Presentation shared by Rocket.Chat and Vibez attachments. */
export type IntegrationCard={author:string|null;title:string|null;url:string|null;pretext:string|null;text:string|null;color:string|null;fields:{title:string;value:string;short:boolean}[];actions:CardAction[]};
export type CardAction={id:string;name:string;style:string|null;cookie:string|null;menu:CardMenu|null};
/** A card menu: its listed choices, or people or channels the server searches, and the value chosen before any press. */
export type CardMenu={source:MenuSource;options:MenuOption[];initial:string|null};
export type MenuSource='options'|'users'|'channels';
export type MenuOption={label:string;value:string};
export function integrationCard(value:unknown):IntegrationCard|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const a=value as Record<string,unknown>;
  if(['message_link','image_url','audio_url','video_url','native_file'].some(k=>a[k]!=null)||a.type==='file'||a.title_link_download===true)return null;
  const read=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&new TextEncoder().encode(v).length<=max?v.trim():null;
  const link=read(a.title_link,2048);
  if(link?.startsWith('/'))return null;
  let url:string|null=null;
  if(link){try{const u=new URL(link);if(['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password)url=link;}catch{/* Plain card without navigation. */}}
  const fields=(Array.isArray(a.fields)?a.fields.slice(0,12):[]).flatMap((field:unknown)=>{
    if(!field||typeof field!=='object')return [];
    const f=field as Record<string,unknown>,title=read(f.title,128),value=read(f.value,2048);
    return title?[{title,value:value??'',short:f.short===true}]:[];
  });
  const actions=(Array.isArray(a.actions)?a.actions:[]).flatMap((action:unknown)=>{
    if(!action||typeof action!=='object')return [];
    const b=action as Record<string,unknown>,id=read(b.id,256),name=read(b.name,512);
    const menu=b.type==='select'?cardMenu(b):null;
    if(b.type==='select'&&menu===null)return [];
    return id&&name?[{id,name,style:read(b.style,32),cookie:typeof b.cookie==='string'&&b.cookie?b.cookie:null,menu}]:[];
  }).slice(0,10);
  const title=read(a.title,512),text=read(a.text,8192),pretext=read(a.pretext,8192);
  if(!title&&!text&&!pretext&&!fields.length&&!actions.length)return null;
  return {author:read(a.author_name,256),title,url,pretext,text,color:typeof a.color==='string'&&/^#[0-9a-fA-F]{6}$/.test(a.color)?a.color:null,fields,actions};
}

function cardMenu(b:Record<string,unknown>):CardMenu|null {
  const source:MenuSource=b.source==='users'||b.source==='channels'?b.source:'options';
  const options=(Array.isArray(b.options)?b.options:[]).flatMap((option:unknown)=>{
    if(!option||typeof option!=='object')return [];
    const o=option as Record<string,unknown>;
    return typeof o.text==='string'&&o.text.trim()&&typeof o.value==='string'?[{label:o.text.trim(),value:o.value}]:[];
  }).slice(0,500);
  if(source==='options'&&!options.length)return null;
  return {source,options,initial:typeof b.default==='string'&&b.default?b.default:null};
}

/** What a menu shows: the choice made, else the listed initial one, else its name. */
export function menuLabel(action:CardAction,chosen:string|null):string {
  return chosen??action.menu?.options.find(o=>o.value===action.menu?.initial)?.label??action.name;
}

/** The listed choices matching what is typed, case and accents ignored. */
export function filterMenuOptions(options:readonly MenuOption[],term:string):MenuOption[] {
  const fold=(s:string)=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
  const wanted=fold(term.trim());
  return wanted?options.filter(o=>fold(o.label).includes(wanted)):[...options];
}


const ROUTE_ID = /^[A-Za-z0-9_-]+$/;

/** A button's route, `null` when an id could climb out of it. */
export function cardActionRoute(postId: string, actionId: string): string | null {
  return ROUTE_ID.test(postId) && ROUTE_ID.test(actionId) ? `/posts/${postId}/actions/${actionId}` : null;
}

/** Presses a card button: its answer becomes a private note or an opened http(s) link, a failure `failed` and `false`. */
export async function pressCardAction(
  press: () => Promise<CardActionAnswer>,
  then: { note: (text: string) => void; open: (url: string) => void; failed: () => void },
): Promise<boolean> {
  let answer: CardActionAnswer;
  try {
    answer = await press();
  } catch {
    then.failed();
    return false;
  }
  if (answer.ephemeralText !== null) then.note(answer.ephemeralText);
  if (answer.gotoLocation !== null && /^https?:\/\//i.test(answer.gotoLocation)) then.open(answer.gotoLocation);
  return true;
}
