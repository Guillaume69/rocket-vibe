/** Reader-scoped source views. Called inside the store's message/cursor transaction. */
import type {NativeDatabase} from './store.ts';
import type {Message,MessageQuote,QuoteExcerpt,QuoteReference} from './protocol.generated.ts';
import {roomIdentifier} from './roomOperations.ts';
import {readDecimal,readState} from './readStates.ts';
import {decodeNative} from './validation.ts';
import {fileDescriptor,nativeFileAttachments} from './fileDescriptors.ts';

type SourceRow={rid:string;membership:string|null;view_position:string;payload:string|null};
export type NativeQuoteAttachment={message_link:string;native_reference:QuoteReference;native_unavailable:boolean;text:string;author_name?:string;attachments?:(NativeQuoteAttachment|Record<string,unknown>)[]};
export type NativeQuoteSelection={reference:QuoteReference;instance_id:string;data_epoch:string;membership_version:string};
function position(value:string):bigint {
  const n=readDecimal(value);
  if(n>9223372036854775807n)throw new Error('Invalid native quote position');
  return n;
}

export class NativeQuoteCache {
  private readonly db:NativeDatabase;
  private readonly identity:{instance_id:string;data_epoch:string};
  constructor(db:NativeDatabase,identity:{instance_id:string;data_epoch:string}) {this.db=db;this.identity=identity;}
  async selection(rid:string,id:string):Promise<NativeQuoteSelection> {
    const row=await this.db.getFirstAsync<{revision:string}>('SELECT p.revision FROM native_positions p JOIN messages m ON m.id=p.id WHERE p.id=? AND p.rid=? AND m.type_systeme IS NULL',[id,rid]);
    const grant=await this.membership(rid);
    if(!row || grant===null || !roomIdentifier(id) || !roomIdentifier(rid) || position(row.revision)===0n)throw new Error('Native quote source unavailable');
    return {reference:{message_id:id,room_id:rid,revision:row.revision},...this.identity,membership_version:grant};
  }
  async enqueue(id:string,rid:string,selected:readonly NativeQuoteSelection[]):Promise<QuoteReference[]> {
    if(selected.length>8)throw new Error('Too many native quote references');
    const ids=new Set<string>(),refs:QuoteReference[]=[];
    for(const value of selected){
      const r=value.reference;
      const current=await this.selection(r.room_id,r.message_id);
      if(r.message_id===id || ids.has(r.message_id) || value.instance_id!==current.instance_id || value.data_epoch!==current.data_epoch || value.membership_version!==current.membership_version || r.revision!==current.reference.revision)throw new Error('Native quote selection changed');
      ids.add(r.message_id);refs.push({...current.reference});
    }
    for(const [ordinal,r] of refs.entries())await this.db.runAsync('INSERT INTO native_quote_references(message_id,rid,ordinal,source_id,source_room,observed_revision) VALUES(?,?,?,?,?,?)',[id,rid,ordinal,r.message_id,r.room_id,r.revision]);
    await this.refresh(new Set(),id);
    return refs;
  }
  private async membership(rid:string):Promise<string|null> {
    const saved=await this.db.getFirstAsync<{payload:string}>('SELECT payload FROM native_read_states WHERE rid=?',[rid]);
    return saved?readState(JSON.parse(saved.payload),rid).membership_version??null:null;
  }
  /** Null wins a tie, so an old source view cannot resurrect a deleted excerpt. */
  private async save(id:string,rid:string,membership:string|null,view:string,excerpt:QuoteExcerpt|null):Promise<void> {
    const next=position(view),old=await this.db.getFirstAsync<SourceRow>('SELECT * FROM native_quote_sources WHERE id=?',[id]);
    if(old){
      if(old.rid!==rid)throw new Error('Mismatched native quote source room');
      const previous=position(old.view_position);
      if(next<previous || next===previous && (old.payload===null || excerpt!==null))return;
    }
    // Descendant text belongs only in its own membership-scoped source row.
    const stored:QuoteExcerpt|null=excerpt?{author:{id:excerpt.author.id,username:excerpt.author.username,display_name:excerpt.author.display_name},text:excerpt.text,created_at:excerpt.created_at,revision:excerpt.revision,membership_version:excerpt.membership_version,files:(excerpt.files??[]).map(f=>fileDescriptor(f,rid)),references:excerpt.references??[],quotes:[]}:null;
    await this.db.runAsync('INSERT INTO native_quote_sources(id,rid,membership,view_position,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET membership=excluded.membership,view_position=excluded.view_position,payload=excluded.payload',[id,rid,membership,view,stored?JSON.stringify(stored):null]);
  }
  private async view(quote:MessageQuote,depth=1):Promise<void> {
    if(depth>2)throw new Error('Native quote depth exceeded');
    const stamp=quote.view_position??'0',watermark=position(stamp);
    if(watermark===0n)return; // Legacy prototypes supply no read authority.
    const r=quote.reference,current=await this.membership(r.room_id),grant=quote.source_membership_version??null;
    if(!roomIdentifier(r.message_id) || !roomIdentifier(r.room_id) || position(r.revision)===0n)throw new Error('Invalid nested quote reference');
    const excerpt=quote.excerpt;
    if(excerpt && (grant!==excerpt.membership_version || position(excerpt.revision)===0n || position(excerpt.revision)>watermark || !roomIdentifier(excerpt.author.id) || Array.from(excerpt.text).length>1024 || !Number.isFinite(Date.parse(excerpt.created_at))))throw new Error('Invalid native quote excerpt');
    if(excerpt){
      nativeFileAttachments(excerpt.files??[],r.room_id);
      const refs=excerpt.references??[],children=excerpt.quotes??[],ids=new Set<string>();
      if(refs.length>8 || children.length>8 || depth===2 && children.length)throw new Error('Invalid nested quote bounds');
      for(const ref of refs){
        if(!roomIdentifier(ref.message_id) || !roomIdentifier(ref.room_id) || ref.message_id===r.message_id || ids.has(ref.message_id) || position(ref.revision)===0n)throw new Error('Invalid nested source references');
        ids.add(ref.message_id);
      }
      if(children.length && (children.length!==refs.length || children.some((child,i)=>{const ref=refs[i];return child.reference.message_id!==ref.message_id || child.reference.room_id!==ref.room_id || child.reference.revision!==ref.revision;})))throw new Error('Mismatched nested quote references');
    }
    if(grant!==null){
      if(!roomIdentifier(grant))throw new Error('Invalid native quote lifetime');
      if(current!==grant)return;
    }else if(current!==null){
      const room=await this.db.getFirstAsync<{revision:string}>('SELECT revision FROM native_room_access WHERE rid=?',[r.room_id]);
      if(!room)throw new Error('Native quote room version unavailable');
      // A null read from before joining cannot clear the new membership's views.
      if(watermark<=position(room.revision))return;
      const sources=await this.db.getAllAsync<{id:string}>('SELECT id FROM native_quote_sources WHERE rid=?',[r.room_id]);
      for(const {id} of sources)await this.save(id,r.room_id,null,stamp,null);
    }
    if(excerpt)for(const child of excerpt.quotes??[])await this.view(child,depth+1);
    await this.save(r.message_id,r.room_id,grant,stamp,excerpt??null);
  }
  async project(message:Message,publicFresh:boolean):Promise<void> {
    const quotes=message.quotes??[],ids=new Set<string>();
    if(quotes.length>8)throw new Error('Too many native quote references');
    for(const quote of quotes){
      const r=quote.reference;
      if(!roomIdentifier(r.message_id) || !roomIdentifier(r.room_id) || r.message_id===message.id || ids.has(r.message_id) || position(r.revision)===0n)throw new Error('Invalid native quote reference');
      ids.add(r.message_id);
      const known=await this.db.getFirstAsync<{rid:string}>('SELECT rid FROM native_positions WHERE id=?',[r.message_id]);
      if(known && known.rid!==r.room_id)throw new Error('Mismatched native quote reference room');
    }
    if(publicFresh){
      await this.db.runAsync('DELETE FROM native_quote_references WHERE message_id=?',[message.id]);
      if(!message.deleted)for(const [ordinal,quote] of quotes.entries()){
        const r=quote.reference;
        await this.db.runAsync('INSERT INTO native_quote_references(message_id,rid,ordinal,source_id,source_room,observed_revision) VALUES(?,?,?,?,?,?)',[message.id,message.room_id,ordinal,r.message_id,r.room_id,r.revision]);
      }
    }
    if(!message.deleted)for(const quote of quotes)await this.view(quote);
    const grant=await this.membership(message.room_id);
    if(grant!==null && position(message.revision)>0n){
      const excerpt:QuoteExcerpt|null=message.deleted||message.system!=null?null:{author:message.author,text:Array.from(message.text).slice(0,1024).join(''),created_at:message.created_at,revision:message.revision,membership_version:grant,files:message.files??[],references:quotes.map(q=>q.reference),quotes:[]};
      await this.save(message.id,message.room_id,grant,message.revision,excerpt);
    }
    await this.refresh(new Set([message.room_id,...quotes.map(q=>q.reference.room_id)]),message.id);
  }
  private async attachments(id:string):Promise<string|null> {
    const refs=await this.db.getAllAsync<{source_id:string;source_room:string;observed_revision:string}>('SELECT source_id,source_room,observed_revision FROM native_quote_references WHERE message_id=? ORDER BY ordinal',[id]);
    const cards:NativeQuoteAttachment[]=[];
    for(const r of refs)cards.push(await this.card({message_id:r.source_id,room_id:r.source_room,revision:r.observed_revision},1,[id]));
    return cards.length?JSON.stringify(cards):null;
  }
  private async card(reference:QuoteReference,depth:number,path:readonly string[]):Promise<NativeQuoteAttachment> {
    const source=await this.db.getFirstAsync<SourceRow>('SELECT * FROM native_quote_sources WHERE id=? AND rid=?',[reference.message_id,reference.room_id]),grant=await this.membership(reference.room_id);
    const excerpt=!path.includes(reference.message_id) && grant!==null && source?.membership===grant && source.payload!==null?decodeNative('QuoteExcerpt',JSON.parse(source.payload)):null;
    const card:NativeQuoteAttachment={message_link:'',native_reference:reference,native_unavailable:excerpt===null,text:excerpt?.text??'',...(excerpt?{author_name:excerpt.author.username}:{})};
    if(excerpt)card.attachments=nativeFileAttachments(excerpt.files??[],reference.room_id);
    if(excerpt && depth<2 && excerpt.references?.length){
      for(const child of excerpt.references)card.attachments!.push(await this.card(child,depth+1,[...path,reference.message_id]));
    }
    return card;
  }
  async fileAccess(id:string):Promise<{file:import('./protocol.generated.ts').FileDescriptor;membership:string}|null>{
    const row=await this.db.getFirstAsync<{rid:string;membership:string;file:string}>(`SELECT q.rid,q.membership,f.value AS file
      FROM native_quote_sources q JOIN native_read_states s ON s.rid=q.rid,json_each(q.payload,'$.files') f
      WHERE q.membership=json_extract(s.payload,'$.membership_version') AND json_extract(f.value,'$.id')=? LIMIT 1`,[id]);
    return row?{file:fileDescriptor(JSON.parse(row.file),row.rid),membership:row.membership}:null;
  }
  async refreshOrigin(rid:string):Promise<void> { await this.refresh(new Set([rid])); }
  /** Immutable references for an edit intent; never capture excerpt or access authority. */
  async references(id:string):Promise<QuoteReference[]> {
    const rows=await this.db.getAllAsync<{source_id:string;source_room:string;observed_revision:string}>('SELECT source_id,source_room,observed_revision FROM native_quote_references WHERE message_id=? ORDER BY ordinal',[id]);
    return rows.map(r=>({message_id:r.source_id,room_id:r.source_room,revision:r.observed_revision}));
  }
  /** Update the same pieces_jointes column watched by the existing mobile UI. */
  private async refresh(rooms:Set<string>,own?:string):Promise<void> {
    const ids=new Set(own?[own]:[]),roomIds=[...rooms];
    if(roomIds.length){
      const placeholders=roomIds.map(()=>'?').join(',');
      const rows=await this.db.getAllAsync<{message_id:string}>(`WITH RECURSIVE seeds(id) AS (
        SELECT id FROM native_quote_sources WHERE rid IN (${placeholders}) UNION
        SELECT s.id FROM native_quote_sources s,json_each(s.payload,'$.references') edge WHERE json_extract(edge.value,'$.room_id') IN (${placeholders})),
        affected(id) AS (SELECT id FROM seeds UNION SELECT s.id FROM native_quote_sources s,json_each(s.payload,'$.references') edge JOIN affected a ON json_extract(edge.value,'$.message_id')=a.id)
        SELECT DISTINCT message_id FROM native_quote_references WHERE source_room IN (${placeholders}) OR source_id IN (SELECT id FROM affected)`,[...roomIds,...roomIds,...roomIds]);
      for(const row of rows)ids.add(row.message_id);
    }
    for(const id of ids){
      const row=await this.db.getFirstAsync<{pieces_jointes:string|null}>('SELECT pieces_jointes FROM messages WHERE id=?',[id]);
      const files:unknown[]=row?.pieces_jointes?JSON.parse(row.pieces_jointes).filter((a:Record<string,unknown>)=>a.native_file!==undefined):[];
      const quotes=await this.attachments(id),all=[...files,...(quotes?JSON.parse(quotes):[])];
      const cards=all.length?JSON.stringify(all):null;
      await this.db.runAsync('UPDATE messages SET pieces_jointes=? WHERE id=? AND pieces_jointes IS NOT ?',[cards,id,cards]);
    }
  }
}
