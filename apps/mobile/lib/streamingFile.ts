import {createHash} from 'crypto';
/** Verify bounded chunks before the caller publishes a private .part file. */
export async function copyVerifiedFile(options:{
  body:ReadableStream<Uint8Array>;writer:WritableStreamDefaultWriter<Uint8Array>;bytes:number;
  /** `null` for an encrypted object: its own authentication checks it once opened. */
  sha256:string|null;
  alive:()=>boolean;progress?:(fraction:number)=>void;
}):Promise<void>{
  const reader=options.body.getReader(),hash=createHash('sha256');let bytes=0;
  try{
    for(;;){const next=await reader.read();if(next.done)break;
      if(!options.alive())throw new Error('file_scope_closed');
      bytes+=next.value.length;if(bytes>options.bytes)throw new Error('invalid_file');
      hash.update(next.value);await options.writer.write(next.value);options.progress?.(bytes/options.bytes);
    }
    if(!options.alive())throw new Error('file_scope_closed');
    if(bytes!==options.bytes||options.sha256!==null&&hash.digest('hex')!==options.sha256)throw new Error('invalid_file');
    await options.writer.close();
  }catch(error){await options.writer.abort().catch(()=>{});throw error;}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();options.writer.releaseLock();}
}
