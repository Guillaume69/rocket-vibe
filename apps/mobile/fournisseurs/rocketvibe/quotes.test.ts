import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeNative} from './validation.ts';

test('quote resolutions preserve exact stamps and keep legacy views distinguishable',()=>{
  const legacy={reference:{room_id:'origin',message_id:'source',revision:'1'},excerpt:null};
  const old=decodeNative('MessageQuote',legacy);
  assert.equal(old.view_position,undefined);
  assert.equal(old.source_membership_version,undefined);
  const current={...legacy,view_position:'9007199254740993',source_membership_version:'current-grant'};
  assert.deepEqual(decodeNative('MessageQuote',current),current);
  assert.throws(()=>decodeNative('MessageQuote',{...current,view_position:9007199254740993}),/Invalid RocketVibe/);
  assert.throws(()=>decodeNative('MessageQuote',{...current,source_membership_version:123}),/Invalid RocketVibe/);
});
