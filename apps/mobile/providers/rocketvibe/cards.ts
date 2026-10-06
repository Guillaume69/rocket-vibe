import type {IntegrationCard} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';

const bytes=(s:string)=>new TextEncoder().encode(s).length;
function text(s:string,limit:number,multiline=false):boolean {
  return !!s.trim() && bytes(s)<=limit && ![...s].some(c=>/[\u0000-\u001f\u007f-\u009f]/.test(c)&&!(multiline&&'\n\t\r'.includes(c)));
}
export function integrationCards(values:readonly unknown[]):IntegrationCard[] {
  if(values.length>3)throw new Error('invalid_card');
  const cards=values.map(value=>decodeNative('IntegrationCard',value));
  if(bytes(JSON.stringify(cards))>16*1024)throw new Error('invalid_card');
  for(const c of cards){
    const fields=c.fields??[];
    let url=true;
    if(c.url!=null){try{const u=new URL(c.url);url=bytes(c.url)<=2048&&!/[\u0000-\u001f\u007f-\u009f]/.test(c.url)&&['http:','https:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{url=false;}}
    if(c.author!=null&&!text(c.author,256)||c.title!=null&&!text(c.title,512)||c.text!=null&&!text(c.text,8192,true)||!url||
      c.color!=null&&!/^#[0-9a-fA-F]{6}$/.test(c.color)||fields.length>12||fields.some(f=>!text(f.title,128)||!text(f.value,2048,true))||
      c.title==null&&c.text==null&&!fields.length)throw new Error('invalid_card');
  }
  return cards;
}
export function nativeCardAttachments(values:readonly unknown[]):Record<string,unknown>[] {
  return integrationCards(values).map(c=>({native_card:true,author_name:c.author,title:c.title,title_link:c.url,text:c.text,color:c.color,fields:c.fields??[]}));
}
