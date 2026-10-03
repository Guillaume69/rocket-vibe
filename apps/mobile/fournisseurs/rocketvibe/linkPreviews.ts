import type {LinkPreview,Message,PreviewImage} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {roomIdentifier} from './roomOperations.ts';

const hex=(value:string)=>/^[0-9a-f]{64}$/.test(value);
function utf8(value:string):number {
  let bytes=0;
  for(const c of value){const cp=c.codePointAt(0)!;bytes+=cp<=0x7f?1:cp<=0x7ff?2:cp<=0xffff?3:4;}
  return bytes;
}
const text=(value:string|null|undefined,max:number)=>value==null||value.length>0&&utf8(value)<=max&&!/[\u0000-\u001f\u007f]/.test(value);
export function previewImage(value:unknown):PreviewImage {
  const image=decodeNative('PreviewImage',value);
  if(!hex(image.file_id)||!hex(image.sha256)||image.media_type!=='image/png'||image.width<1||image.width>1200||image.height<1||image.height>1200||! /^[1-9]\d{0,6}$/.test(image.bytes)||BigInt(image.bytes)>4194304n)throw new Error('Invalid native preview image');
  return image;
}
export function linkPreview(value:unknown):LinkPreview {
  const p=decodeNative('LinkPreview',value);
  const url=new URL(p.url);
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||utf8(p.url)>2048||/[\u0000-\u001f\u007f]/.test(p.url)||!text(p.title,512)||!text(p.description,2048)||!text(p.site,256))throw new Error('Invalid native preview');
  if(p.image)previewImage(p.image);
  if(p.kind==='image'?!p.image:!p.title&&!p.image)throw new Error('Empty native preview');
  return p;
}
export function nativeUrls(message:Message):string|null {
  const items=message.previews??[];
  if(items.length>3||new Set(items.map(p=>p.url)).size!==items.length||(message.deleted||message.system)&&items.length)throw new Error('Invalid native preview list');
  if(!roomIdentifier(message.id))throw new Error('Invalid native preview message');
  return items.length?JSON.stringify(items.map(item=>({url:item.url,native_message:message.id,native_preview:linkPreview(item)}))):null;
}
export type PreviewAccess={message:string;room:string;image:PreviewImage;scope:string};
export const previewKey=(message:string,file:string)=>`${message}/${file}`;
export const previewImageIdentity=(image:PreviewImage)=>JSON.stringify([image.file_id,image.sha256,image.bytes,image.width,image.height,image.media_type]);
