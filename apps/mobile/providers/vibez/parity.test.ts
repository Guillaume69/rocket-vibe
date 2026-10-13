import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeNative } from './validation.ts';
import { effectiveCapabilities, ROCKETVIBE_CAPABILITIES } from './index.ts';
import { ROCKETCHAT_CAPABILITIES } from '../../lib/provider.ts';
const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));

test('J0 parity fixture is understood by the same runtime decoder as native responses', () => {
  const contract = decodeNative('ParityContract',fixture.parity);
  assert.equal(contract.room_permissions.role,'member');
  assert.equal(contract.read_state.root_position,'9007199254740993');
  assert.equal(contract.file.bytes,'9007199254740993');
  assert.equal(contract.key_backup.crypto_identity,'historical-uid-preserved');
  assert.throws(() => decodeNative('SetReaction',{emoji:'rocket',present:true,user_id:'other'}));
  assert.throws(() => decodeNative('MarkRead',{root_position:9007199254740992,reply_position:'0'}));
  assert.throws(() => decodeNative('MessageContent',{kind:'encrypted',format:'opaque',key_version:'1',payload:'blob',markdown:'secret'}));
});
test('a server flag alone cannot expose a feature absent from the installed app', () => {
  const announced = {...fixture.discovery.capabilities,typing:true,uploads:true,search:true};
  assert.equal(effectiveCapabilities(announced).files,true);
  assert.equal(effectiveCapabilities({...announced,uploads:false}).files,false);
  assert.equal(effectiveCapabilities(announced,{...ROCKETVIBE_CAPABILITIES,files:false}).files,false);
  assert.equal(effectiveCapabilities({...announced,custom_emojis:true}).customEmojis,true);
  assert.equal(effectiveCapabilities({...announced,custom_emojis:true},{...ROCKETVIBE_CAPABILITIES,customEmojis:false}).customEmojis,false);
  assert.equal(effectiveCapabilities(announced).typing,true);
  assert.equal(effectiveCapabilities(announced).search,true);
  assert.equal(effectiveCapabilities(announced,{...ROCKETVIBE_CAPABILITIES,search:false}).search,false);
  assert.equal(effectiveCapabilities({...announced,search:false}).search,false);
  assert.equal(effectiveCapabilities(announced,{...ROCKETVIBE_CAPABILITIES,typing:false}).typing,false);
  assert.equal(effectiveCapabilities(announced,ROCKETCHAT_CAPABILITIES).typing,true);
  assert.equal(effectiveCapabilities(null,ROCKETCHAT_CAPABILITIES).typing,false);
  assert.equal(effectiveCapabilities(fixture.discovery.capabilities,{...ROCKETVIBE_CAPABILITIES,typing:true}).typing,false);
  assert.equal(effectiveCapabilities({...announced,read_markers:true}).roomReads,true);
  assert.equal(effectiveCapabilities({...announced,read_markers:false}).roomReads,false);
  assert.equal(effectiveCapabilities({...announced,read_markers:true},{...ROCKETVIBE_CAPABILITIES,roomReads:false}).roomReads,false);
});
