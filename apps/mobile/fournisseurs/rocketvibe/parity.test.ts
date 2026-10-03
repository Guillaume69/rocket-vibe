import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeNative } from './validation.ts';
import { capacitesEffectives, CAPACITES_ROCKETVIBE } from './index.ts';
import { CAPACITES_ROCKETCHAT } from '../../lib/fournisseur.ts';
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
  assert.equal(capacitesEffectives(announced).fichiers,false);
  assert.equal(capacitesEffectives(announced).typing,true);
  assert.equal(capacitesEffectives(announced,{...CAPACITES_ROCKETVIBE,typing:false}).typing,false);
  assert.equal(capacitesEffectives(announced,CAPACITES_ROCKETCHAT).typing,true);
  assert.equal(capacitesEffectives(null,CAPACITES_ROCKETCHAT).typing,false);
  assert.equal(capacitesEffectives(fixture.discovery.capabilities,{...CAPACITES_ROCKETVIBE,typing:true}).typing,false);
  assert.equal(capacitesEffectives({...announced,read_markers:true}).lecturesSalon,true);
  assert.equal(capacitesEffectives({...announced,read_markers:false}).lecturesSalon,false);
  assert.equal(capacitesEffectives({...announced,read_markers:true},{...CAPACITES_ROCKETVIBE,lecturesSalon:false}).lecturesSalon,false);
});
