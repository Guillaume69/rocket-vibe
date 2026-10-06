import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ObservedRead,type ReadClock} from './observedRead.ts';
function setup(){
  let now=0;const saved:string[]=[],timers:{f:()=>void;at:number;cancelled:boolean}[]=[];
  const clock:ReadClock={now:()=>now,schedule:(f,ms)=>{const timer={f,at:now+ms,cancelled:false};timers.push(timer);return()=>{timer.cancelled=true;};}};
  const controller=new ObservedRead(async id=>{saved.push(id);},clock);
  const tick=(ms:number)=>{const end=now+ms;for(;;){const next=timers.filter(t=>!t.cancelled && t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!next)break;next.cancelled=true;now=next.at;next.f();}now=end;};
  return {controller,saved,timers,tick};
}
test('a burst does not postpone the original observed ID or replace it before saving',()=>{
  const {controller,saved,tick}=setup();controller.activate(true);controller.observer('actually-visible');
  tick(1000);controller.observer('later-visible');tick(500);
  assert.deepEqual(saved,['actually-visible']);tick(9999);assert.deepEqual(saved,['actually-visible']);tick(1);
  assert.deepEqual(saved,['actually-visible','later-visible']);
});
test('leaving flushes the captured target, ignores covered-screen observations and fences old callbacks',()=>{
  const {controller,saved,timers,tick}=setup();controller.activate(true);controller.observer('observed');
  const old=timers[0];controller.activate(false);controller.observer('covered');old.f();tick(20000);
  assert.deepEqual(saved,['observed']);controller.activate(true);controller.observer('visible-on-return');controller.close();
  controller.observer('closed');timers.at(-1)!.f();assert.deepEqual(saved,['observed','visible-on-return']);
});
test('equal observations and read ACK notifications do not rearm any timer',()=>{
  const {controller,saved,timers,tick}=setup();controller.activate(true);controller.observer('observed');tick(1500);
  for(let i=0;i<20;i++)controller.observer('observed');tick(20000);
  assert.deepEqual(saved,['observed']);assert.equal(timers.length,1);
});
test('leaving a burst stages both actual observations without substituting an unseen cache ID',()=>{
  const {controller,saved,tick}=setup();controller.activate(true);controller.observer('first-visible');
  tick(500);controller.observer('second-visible');controller.activate(false);
  assert.deepEqual(saved,['first-visible','second-visible']);tick(20000);assert.equal(saved.length,2);
});
