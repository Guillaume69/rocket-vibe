import {encode} from 'uqr';

export const QUIET_ZONE=4;
export type QrMatrix={version:number;size:number;dark:boolean[][]};
export type QrRun={x:number;y:number;length:number};

export function totpQr(uri:string):QrMatrix|null {
  if(!uri.startsWith('otpauth://totp/'))return null;
  return textQr(uri);
}

/** Any text as a QR (a WhatsApp linking code), medium error correction. */
export function textQr(text:string):QrMatrix|null {
  if(text==='')return null;
  const qr=encode(text,{ecc:'M',border:QUIET_ZONE});
  return {version:qr.version,size:qr.size,dark:qr.data};
}

export function qrRuns(matrix:QrMatrix):QrRun[] {
  const runs:QrRun[]=[];
  matrix.dark.forEach((row,y)=>{
    let x=0;
    while(x<row.length){
      if(!row[x]){x++;continue;}
      const start=x;
      while(x<row.length && row[x])x++;
      runs.push({x:start,y,length:x-start});
    }
  });
  return runs;
}
