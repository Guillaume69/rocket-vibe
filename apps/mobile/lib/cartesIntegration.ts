/** Presentation shared by Rocket.Chat and RocketVibe attachments. */
export type CarteIntegration={auteur:string|null;titre:string|null;url:string|null;texte:string|null;couleur:string|null;champs:{titre:string;valeur:string;court:boolean}[]};
export function carteIntegration(value:unknown):CarteIntegration|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const a=value as Record<string,unknown>;
  if(['message_link','image_url','audio_url','video_url','native_file'].some(k=>a[k]!=null)||a.type==='file'||a.title_link_download===true)return null;
  const read=(v:unknown,max:number)=>typeof v==='string'&&v.trim()&&new TextEncoder().encode(v).length<=max?v.trim():null;
  const link=read(a.title_link,2048);
  if(link?.startsWith('/'))return null;
  let url:string|null=null;
  if(link){try{const u=new URL(link);if(['http:','https:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password)url=link;}catch{/* Plain card without navigation. */}}
  const champs=(Array.isArray(a.fields)?a.fields.slice(0,12):[]).flatMap((field:unknown)=>{
    if(!field||typeof field!=='object')return [];
    const f=field as Record<string,unknown>,titre=read(f.title,128),valeur=read(f.value,2048);
    return titre?[{titre,valeur:valeur??'',court:f.short===true}]:[];
  });
  const titre=read(a.title,512),texte=read(a.text,8192);
  if(!titre&&!texte&&!champs.length)return null;
  return {auteur:read(a.author_name,256),titre,url,texte,couleur:typeof a.color==='string'&&/^#[0-9a-fA-F]{6}$/.test(a.color)?a.color:null,champs};
}
