/** Encrypted files of private rooms (E2EE_FILES.md): the object format's sizes,
 * and sending one file. Sealing and opening happen in Rust (`CryptoNative`). */
import type {CryptoFileBridge} from '../../modules/crypto-native/index.ts';
import type {CryptoConversationAccess} from './cryptoConversations.ts';
import type {EncryptedFile} from './protocol.generated.ts';
import type {NativeFileSender} from './uploads.ts';
import {NativeError,type NativeTransport} from './transport.ts';

export const FILE_CHUNK=65536;
/** The largest plaintext whose object fits the server's 100 MiB. */
export const PRIVATE_FILE_MAX=104_831_977;
/** Exact object size for a plaintext of `bytes`: header, chunks and tags. */
export function objectSize(bytes:number):number {
  return 23+bytes+16*Math.max(1,Math.ceil(bytes/FILE_CHUNK));
}
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,15})$/.test(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);

/** Seals `file` beside it, uploads the opaque object, then sends the private
 * message carrying its descriptor. Before the message, a failure releases the
 * reservation; after, the private outbox owns the retry. */
export async function sendPrivateFile(options:{
  crypto:CryptoFileBridge;transport:NativeTransport;send:NativeFileSender;access:CryptoConversationAccess;
  room:string;file:{uri:string;name:string;type:string};caption:string;object:string;operation:string;
  progress:(fraction:number)=>void;signal:AbortSignal;
}):Promise<string> {
  const {crypto,transport,access,file}=options;
  const sealed=JSON.parse(await crypto.sealFile(file.uri,options.object)) as Record<string,unknown>;
  if(typeof sealed.key!=='string' || !decimal(sealed.bytes) || !hex(sealed.sha256) || !decimal(sealed.object_bytes)
    || !hex(sealed.object_sha256) || Number(sealed.object_bytes)!==objectSize(Number(sealed.bytes)))throw new NativeError(0,'invalid_file');
  const upload=await transport.prepareUpload({operation_id:options.operation,room_id:options.room,bytes:sealed.object_bytes,
    sha256:sealed.object_sha256,media_type:'application/octet-stream',filename:null,encrypted:true});
  let prepared=false;
  try {
    const ready=upload.state==='ready'?upload:await transport.uploadLocal(upload.id,options.object,options.send,options.signal,options.progress);
    if(ready.state!=='ready' || !ready.file.encrypted || ready.file.bytes!==sealed.object_bytes || ready.file.sha256!==sealed.object_sha256)
      throw new NativeError(502,'invalid_upload');
    const descriptor:EncryptedFile={id:ready.file.id,key:sealed.key,filename:file.name,media_type:file.type||'application/octet-stream',
      bytes:sealed.bytes,sha256:sealed.sha256};
    prepared=true;
    return await access.send(options.caption,[],[descriptor]);
  } catch(error) {
    if(!prepared)await transport.cancelUpload(upload.id).catch(()=>{});
    throw error;
  }
}
