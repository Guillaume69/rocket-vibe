/** Durable starts; participant URLs never enter SQLite or shared links. */
import type {NativeDatabase} from './store.ts';
import type {Meeting,MeetingJoin,StartMeeting} from './protocol.generated.ts';
import {roomIdentifier} from './roomOperations.ts';
import {decodeNative} from './validation.ts';
import {NativeError} from './transport.ts';

// Explicit parsing behaves identically on Hermes and Node (see lib/origine.ts).
const PUBLIC_URL=/^https:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:]+\])(?::([1-9][0-9]{0,4}))?\/[A-Za-z0-9_-]{1,256}$/i;
export function publicMeetingUrl(meeting:Meeting,room:string,id:string):string {
  const match=PUBLIC_URL.exec(meeting.public_url);
  if(meeting.id!==id || meeting.room_id!==room || !roomIdentifier(id) || !roomIdentifier(room)
    || meeting.public_url.length>1024 || !match || match[1]!==undefined&&Number(match[1])>65535
    || !Number.isFinite(Date.parse(meeting.expires_at)))throw new NativeError(502,'invalid_meeting');
  return meeting.public_url;
}
export function privateMeetingUrl(joined:MeetingJoin,room:string,id:string,now=Date.now()):string {
  const shared=publicMeetingUrl(joined.meeting,room,id);
  const expiry=Date.parse(joined.expires_at);
  const token=joined.url.startsWith(`${shared}?jwt=`)?joined.url.slice(shared.length+5):'';
  if(joined.meeting.ended || joined.url.length>16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    || !Number.isFinite(expiry) || expiry<=now || expiry>now+125000 || expiry>Date.parse(joined.meeting.expires_at)) {
    throw new NativeError(502,'invalid_meeting');
  }
  return joined.url;
}
export function meetingMediaState(url:string,state?:{cam?:boolean;mic?:boolean}):string {
  const flags:string[]=[];
  if(state?.cam!==undefined)flags.push(`config.startWithVideoMuted=${!state.cam}`);
  if(state?.mic!==undefined)flags.push(`config.startWithAudioMuted=${!state.mic}`);
  return flags.length?`${url}#${flags.join('&')}`:url;
}

export class NativeMeetingIntents {
  private readonly db:NativeDatabase;
  private readonly atomic:<T>(fn:()=>Promise<T>)=>Promise<T>;
  private readonly membership:(room:string,nonce:string)=>Promise<boolean>;
  private readonly epoch:string;
  constructor(db:NativeDatabase,atomic:<T>(fn:()=>Promise<T>)=>Promise<T>,membership:(room:string,nonce:string)=>Promise<boolean>,epoch:string) {
    this.db=db;this.atomic=atomic;this.membership=membership;this.epoch=epoch;
  }
  stage(room:string,input:StartMeeting):Promise<StartMeeting> {
    if(!roomIdentifier(room) || !roomIdentifier(input.operation_id) || !roomIdentifier(input.membership_version)
      || input.data_epoch!==this.epoch)throw new NativeError(422,'invalid_meeting');
    return this.atomic(async()=>{
      if(!await this.membership(room,input.membership_version))throw new NativeError(409,'delivery_revalidate');
      const row=await this.db.getFirstAsync<{id:string;payload:string}>('SELECT id,payload FROM native_meeting_intents WHERE rid=?',[room]);
      if(row){
        if(row.payload.length>4096)throw new NativeError(422,'invalid_meeting_intent');
        const saved=decodeNative('StartMeeting',JSON.parse(row.payload));
        if(!roomIdentifier(row.id) || saved.operation_id!==row.id || saved.membership_version!==input.membership_version
          || saved.data_epoch!==input.data_epoch)throw new NativeError(422,'invalid_meeting_intent');
        return saved;
      }
      await this.db.runAsync('INSERT INTO native_meeting_intents(id,rid,payload) VALUES(?,?,?)',[input.operation_id,room,JSON.stringify(input)]);
      return input;
    });
  }
  acknowledge(room:string,input:StartMeeting):Promise<boolean> {
    return this.atomic(async()=>{
      if(input.data_epoch!==this.epoch || !await this.membership(room,input.membership_version))return false;
      const row=await this.db.getFirstAsync('SELECT id FROM native_meeting_intents WHERE rid=? AND id=?',[room,input.operation_id]);
      if(!row)return false;
      await this.db.runAsync('DELETE FROM native_meeting_intents WHERE rid=? AND id=?',[room,input.operation_id]);
      return true;
    });
  }
}
