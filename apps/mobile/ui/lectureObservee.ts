/** A pending timer never substitutes the newest cached message for its target. */
export type HorlogeLecture={maintenant:()=>number;programmer:(f:()=>void,ms:number)=>()=>void};
const horloge:HorlogeLecture={maintenant:()=>Date.now(),programmer:(f,ms)=>{const timer=setTimeout(f,ms);return()=>clearTimeout(timer);}};
export class LectureObservee {
  private active=false;
  private closed=false;
  private latest:string|null=null;
  private last:string|null=null;
  private lastAt=Number.NEGATIVE_INFINITY;
  private pending:{id:string;cancel:()=>void}|null=null;
  private readonly save:(id:string)=>Promise<void>;
  private readonly clock:HorlogeLecture;
  private readonly delay:number;
  private readonly floor:number;
  constructor(save:(id:string)=>Promise<void>,clock:HorlogeLecture=horloge,delay=1500,floor=10000) {
    this.save=save;this.clock=clock;this.delay=delay;this.floor=floor;
  }
  activer(active:boolean):void {
    if(this.closed || this.active===active)return;
    this.active=active;
    if(active)this.schedule();else {
      this.flusher();
      if(this.latest!==null && this.latest!==this.last)this.persist(this.latest);
    }
  }
  observer(id:string):void {
    if(this.closed || !this.active || this.latest===id)return;
    this.latest=id;this.schedule();
  }
  flusher():void {
    const operation=this.pending;
    if(!operation || this.closed)return;
    this.pending=null;operation.cancel();this.persist(operation.id);
  }
  fermer():void {
    this.activer(false);this.closed=true;
  }
  private persist(id:string):void {
    this.last=id;this.lastAt=this.clock.maintenant();
    void this.save(id).catch(()=>{});
    this.schedule();
  }
  private schedule():void {
    if(this.closed || !this.active || this.pending || this.latest===null || this.latest===this.last)return;
    const operation={id:this.latest,cancel:()=>{}};
    this.pending=operation;
    operation.cancel=this.clock.programmer(()=>{
      if(this.pending!==operation || this.closed || !this.active)return;
      this.pending=null;this.persist(operation.id);
    },Math.max(this.delay,this.lastAt+this.floor-this.clock.maintenant()));
  }
}
