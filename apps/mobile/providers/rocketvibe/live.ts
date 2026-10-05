/** Volatile photo, never stored in SQLite or replayed through an outbox. */
import type {DdpEvent} from '../../lib/ddp.ts';
import type {LiveState} from './protocol.generated.ts';

function typists(state:LiveState|null):Map<string,{key:string;name:string}> {
  const entries=new Map<string,{key:string;name:string}>();
  for(const room of state?.rooms??[])for(const t of room.typing){
    const key=t.root_id?`${room.room_id}/thread/${t.root_id}/user-activity`:`${room.room_id}/user-activity`;
    entries.set(`${key}:${t.user.id}`,{key,name:t.user.username});
  }
  return entries;
}

export class NativeLive {
  private photo:LiveState|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private listeners=new Set<()=>void>();
  private events=new Set<(event:DdpEvent)=>void>();
  private losses=new Set<()=>void>();
  get state():LiveState|null{return this.photo;}
  subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  onEvent(fn:(event:DdpEvent)=>void):()=>void {this.events.add(fn);return()=>{this.events.delete(fn);};}
  onLoss(fn:()=>void):()=>void {this.losses.add(fn);return()=>{this.losses.delete(fn);};}
  apply(state:LiveState,ageMs=0):void {
    ageMs=Math.max(0,ageMs);
    if(state.limited || state.ttl_ms>8000 || state.ttl_ms<=ageMs){this.clear();return;}
    if(this.timer!==null)clearTimeout(this.timer);
    const before=typists(this.photo),after=typists(state);
    const changed=JSON.stringify(this.photo)!==JSON.stringify(state);
    this.photo=state;
    this.timer=setTimeout(()=>this.clear(),state.ttl_ms-ageMs);
    for(const [id,t] of before)if(!after.has(id))this.emit(t,false);
    // Refresh the existing typing engine's local expiry without causing a render.
    for(const t of after.values())this.emit(t,true);
    if(changed)for(const fn of this.listeners)fn();
  }
  private emit(t:{key:string;name:string},active:boolean):void {
    const event:DdpEvent={collection:'stream-notify-room',eventKey:t.key,args:[t.name,active?['user-typing']:[]]};
    for(const fn of this.events)fn(event);
  }
  clear():void {
    if(this.timer!==null)clearTimeout(this.timer);
    this.timer=null;
    const before=typists(this.photo);this.photo=null;
    for(const t of before.values())this.emit(t,false);
    for(const fn of this.listeners)fn();
    for(const fn of this.losses)fn();
  }
}
