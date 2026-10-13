import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CryptoStorageKeyAccess} from './cryptoStorageKey.ts';

function access(answer:(input:string)=>string) {
  const calls:string[]=[];
  const identity={withIdentity:<T,>(fn:(handle:string,own:string,read:unknown,check:()=>Promise<void>)=>Promise<T>)=>fn('handle','own',null,async()=>{})};
  const bridge={storageAction:async(handle:string,own:string,input:string)=>{assert.equal(handle,'handle');assert.equal(own,'own');calls.push(input);return answer(input);}};
  return {calls,keys:new CryptoStorageKeyAccess(identity as never,bridge as never)};
}

test('storage key status, renewal and its schedule cross as dates only',async()=>{
  const f=access(input=>JSON.stringify({rotated_at:'1800000000',due_at:'1802592000',renewed:input.includes('"renew"')}));
  assert.deepEqual(await f.keys.view(),{rotated_at:'1800000000',due_at:'1802592000',renewed:false});
  assert.equal((await f.keys.renew()).renewed,true);
  await f.keys.renewIfDue();
  assert.deepEqual(f.calls.map(c=>JSON.parse(c).action),['view','renew','renew_if_due']);
  const never=access(()=>JSON.stringify({rotated_at:null,due_at:null,renewed:false}));
  assert.equal((await never.keys.view()).rotated_at,null);
  for(const bad of [{rotated_at:'01',due_at:null,renewed:false},{rotated_at:null,due_at:null},{rotated_at:'x',due_at:null,renewed:true},{key:'secret'}]) {
    await assert.rejects(access(()=>JSON.stringify(bad)).keys.view());
  }
});
