import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExperimentalUnlock } from './experimentalUnlock.ts';
test('exactly nine individual activations unlock; a pause resets the sequence',() => {
  const gate=new ExperimentalUnlock();
  for(let n=0;n<8;n++) assert.equal(gate.tap(n*250),false);
  assert.equal(gate.tap(2000),true); assert.equal(gate.tap(2100),false);
  for(let n=0;n<8;n++) assert.equal(gate.tap(10000+n*100),false);
  assert.equal(gate.tap(10800),true);
});
test('clock changes do not combine separate sequences',() => {
  const gate=new ExperimentalUnlock(); for(let n=0;n<8;n++) gate.tap(10000+n);
  assert.equal(gate.tap(1),false); for(let n=2;n<=8;n++) assert.equal(gate.tap(n),false); assert.equal(gate.tap(9),true);
});
