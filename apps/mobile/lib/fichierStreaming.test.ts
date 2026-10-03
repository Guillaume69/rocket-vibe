import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {copierFichierVerifie} from './fichierStreaming.ts';
const sha=createHash('sha256').update(new Uint8Array([1,2,3])).digest('hex');
function body(bytes:number[]){return new ReadableStream<Uint8Array>({start(controller){for(const byte of bytes)controller.enqueue(new Uint8Array([byte]));controller.close();}});}
test('streamed private files publish only after exact byte count and SHA-256 verification',async()=>{
  for(const bytes of [[1,2,3],[1,2],[1,2,3,4],[1,2,4]]){
    let closed=false,aborted=false;const chunks:number[]=[];
    const writer=new WritableStream<Uint8Array>({write(chunk){chunks.push(...chunk);},close(){closed=true;},abort(){aborted=true;}}).getWriter();
    const operation=copierFichierVerifie({body:body(bytes),writer,bytes:3,sha256:sha,alive:()=>true});
    if(bytes.join(',')==='1,2,3'){await operation;assert.deepEqual(chunks,bytes);assert.equal(closed,true);}
    else{await assert.rejects(operation,/invalid_file/);assert.equal(closed,false);assert.equal(aborted,true);}
  }
});
test('authority lost between chunks aborts the writer and cannot publish a local file',async()=>{
  let active=true,writes=0,aborted=false,closed=false;
  const writer=new WritableStream<Uint8Array>({write(){writes++;active=false;},abort(){aborted=true;},close(){closed=true;}}).getWriter();
  await assert.rejects(copierFichierVerifie({body:body([1,2,3]),writer,bytes:3,sha256:sha,alive:()=>active}),/file_scope_closed/);
  assert.equal(writes,1);assert.equal(aborted,true);assert.equal(closed,false);
});
