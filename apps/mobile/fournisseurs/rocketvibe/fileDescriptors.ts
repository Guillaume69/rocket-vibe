import type {FileDescriptor,Message} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {roomIdentifier} from './roomOperations.ts';
import {nativeCardAttachments} from './cards.ts';

export const FILE_MAX=100*1024*1024;
export const FILE_TYPES=['application/octet-stream','text/plain','application/pdf','application/zip','image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/ogg','audio/wav','audio/mp4','video/mp4','video/quicktime','video/webm'];
/** Never interpret a remote filename or identifier as a local path or URL. */
export function fileDescriptor(value:unknown,room?:string):FileDescriptor {
  const file=decodeNative('FileDescriptor',value);
  if(!roomIdentifier(file.id)||!roomIdentifier(file.room_id)||room!==undefined&&file.room_id!==room||
    !/^[1-9]\d*$/.test(file.bytes)||Number(file.bytes)>FILE_MAX||!/^[0-9a-f]{64}$/.test(file.sha256)||
    !FILE_TYPES.includes(file.media_type)||file.encrypted||!file.filename||
    new TextEncoder().encode(file.filename).length>255||/[\u0000-\u001f\u007f/\\]/.test(file.filename)||['.','..'].includes(file.filename))throw new Error('invalid_file');
  return file;
}
export function nativeAttachments(message:Message):string|null {
  const files=message.files??[];
  const cards=message.cards??[];
  if(cards.length&&(message.deleted||message.system))throw new Error('invalid_card');
  if(files.length&&(message.deleted||message.system))throw new Error('invalid_file');
  const all=[...nativeFileAttachments(files,message.room_id),...nativeCardAttachments(cards)];
  return all.length?JSON.stringify(all):null;
}
/** Shared projection for message files and membership-scoped quoted sources. */
export function nativeFileAttachments(files:readonly FileDescriptor[],room:string):Record<string,unknown>[] {
  if(files.length>1)throw new Error('invalid_file');
  return files.map(value=>{
    const file=fileDescriptor(value,room),url=`/api/v1/files/${encodeURIComponent(file.id)}`;
    const genre=/^(image|audio|video)\//.exec(file.media_type)?.[1];
    return {type:'file',fileId:file.id,native_file:file,title:file.filename,title_link:url,size:Number(file.bytes),
      ...(genre?{[`${genre}_url`]:url,[`${genre}_type`]:file.media_type,[`${genre}_size`]:Number(file.bytes)}:{})};
  });
}
