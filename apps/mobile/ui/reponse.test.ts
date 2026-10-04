import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demanderReponse,actualiserReponsePrivee,invaliderReponseNative,lireReponse,oublierReponses,type CibleReponse} from './reponse.ts';

const cible=():CibleReponse=>({id:'source',auteur:null,apercu:null,permalien:'',jointeLocale:'[]',imageApercu:null,nativeIndisponible:true,
  native:{reference:{room_id:'room',message_id:'source',revision:'9007199254740993'},instance_id:'instance',data_epoch:'epoch',membership_version:'grant',crypto_admission:'a'.repeat(64)}});

test('a private composer preview loses every source word on blur while retaining only its selection',()=>{
  oublierReponses();const selected=cible();demanderReponse('room',selected);
  actualiserReponsePrivee('room',selected,{author:'alice',text:'private preview'});
  const visible=lireReponse('room')!;assert.equal(visible.apercu,'private preview');
  assert.equal(visible.native,selected.native);
  invaliderReponseNative('room',visible);
  const hidden=lireReponse('room')!;assert.equal(hidden.native,selected.native);assert.equal(hidden.nativeIndisponible,true);
  assert.equal(hidden.auteur,null);assert.equal(hidden.apercu,null);assert.equal(hidden.imageApercu,null);assert.equal(hidden.jointeLocale,'[]');
  assert.ok(!JSON.stringify(hidden).includes('private preview'));
  actualiserReponsePrivee('room',selected,{author:'alice',text:'fresh preview'});
  assert.equal(lireReponse('room')?.apercu,'fresh preview');
  oublierReponses();assert.equal(lireReponse('room'),null);
});

test('a delayed private preview cannot resurrect a cancelled, replaced or logged-out selection',()=>{
  oublierReponses();const old=cible();demanderReponse('room',old);
  const replacement=cible();demanderReponse('room',replacement);
  actualiserReponsePrivee('room',old,{author:'alice',text:'stale private preview'});
  assert.equal(lireReponse('room'),replacement);
  oublierReponses();actualiserReponsePrivee('room',replacement,{author:'alice',text:'late private preview'});
  assert.equal(lireReponse('room'),null);
});

test('private preview refresh leaves ordinary reply targets and another thread untouched',()=>{
  oublierReponses();const privateTarget=cible();demanderReponse('room:thread',privateTarget);
  const ordinary={...cible(),native:undefined,auteur:'bob',apercu:'ordinary preview',nativeIndisponible:false};demanderReponse('room',ordinary);
  actualiserReponsePrivee('room',ordinary,{author:'alice',text:'private preview'});
  assert.equal(lireReponse('room'),ordinary);assert.equal(lireReponse('room:thread'),privateTarget);
  oublierReponses();
});
