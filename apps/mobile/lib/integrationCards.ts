/** Presentation shared by Rocket.Chat and RocketVibe attachments. */
export type IntegrationCard={author:string|null;title:string|null;url:string|null;text:string|null;color:string|null;fields:{title:string;value:string;short:boolean}[]};
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
  const title=read(a.title,512),text=read(a.text,8192);
  if(!title&&!text&&!fields.length)return null;
  return {author:read(a.author_name,256),title,url,text,color:typeof a.color==='string'&&/^#[0-9a-fA-F]{6}$/.test(a.color)?a.color:null,fields};
}
