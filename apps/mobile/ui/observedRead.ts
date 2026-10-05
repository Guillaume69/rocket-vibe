/** A pending timer never substitutes the newest cached message for its target. */
export type ReadClock={now:()=>number;schedule:(f:()=>void,ms:number)=>()=>void};
const systemClock:ReadClock={now:()=>Date.now(),schedule:(f,ms)=>{const timer=setTimeout(f,ms);return()=>clearTimeout(timer);}};
export class ObservedRead {
  private active=false;
  private closed=false;
  private latest:string|null=null;
  private last:string|null=null;
  private lastAt=Number.NEGATIVE_INFINITY;
  private pending:{id:string;cancel:()=>void}|null=null;
  private readonly save:(id:string)=>Promise<void>;
  private readonly clock:ReadClock;
  private readonly delay:number;
  private readonly floor:number;
  constructor(save:(id:string)=>Promise<void>,clock:ReadClock=systemClock,delay=1500,floor=10000) {
    this.save=save;this.clock=clock;this.delay=delay;this.floor=floor;
  }
  activate(active:boolean):void {
    if(this.closed || this.active===active)return;
    this.active=active;
    if(active)this.schedule();else {
      this.flush();
      if(this.latest!==null && this.latest!==this.last)this.persist(this.latest);
    }
  }
  observer(id:string):void {
    if(this.closed || !this.active || this.latest===id)return;
    this.latest=id;this.schedule();
  }
  flush():void {
    const operation=this.pending;
    if(!operation || this.closed)return;
    this.pending=null;operation.cancel();this.persist(operation.id);
  }
  close():void {
    this.activate(false);this.closed=true;
  }
  private persist(id:string):void {
    this.last=id;this.lastAt=this.clock.now();
    void this.save(id).catch(()=>{});
    this.schedule();
  }
  private schedule():void {
    if(this.closed || !this.active || this.pending || this.latest===null || this.latest===this.last)return;
    const operation={id:this.latest,cancel:()=>{}};
    this.pending=operation;
    operation.cancel=this.clock.schedule(()=>{
      if(this.pending!==operation || this.closed || !this.active)return;
      this.pending=null;this.persist(operation.id);
    },Math.max(this.delay,this.lastAt+this.floor-this.clock.now()));
  }
}
