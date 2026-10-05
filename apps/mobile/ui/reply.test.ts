import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestReply,refreshPrivateReply,refreshNativeReply,invalidateNativeReply,readReply,forgetReplies,type ReplyTarget} from './reply.ts';

const target=():ReplyTarget=>({id:'source',author:null,preview:null,permalink:'',localAttachment:'[]',previewImage:null,nativeUnavailable:true,
  native:{reference:{room_id:'room',message_id:'source',revision:'9007199254740993'},instance_id:'instance',data_epoch:'epoch',membership_version:'grant',crypto_admission:'a'.repeat(64)}});

test('a private composer preview loses every source word on blur while retaining only its selection',()=>{
  forgetReplies();const selected=target();requestReply('room',selected);
  refreshPrivateReply('room',selected,{author:'alice',text:'private preview'});
  const visible=readReply('room')!;assert.equal(visible.preview,'private preview');
  assert.equal(visible.native,selected.native);
  invalidateNativeReply('room',visible);
  const hidden=readReply('room')!;assert.equal(hidden.native,selected.native);assert.equal(hidden.nativeUnavailable,true);
  assert.equal(hidden.author,null);assert.equal(hidden.preview,null);assert.equal(hidden.previewImage,null);assert.equal(hidden.localAttachment,'[]');
  assert.ok(!JSON.stringify(hidden).includes('private preview'));
  refreshPrivateReply('room',selected,{author:'alice',text:'fresh preview'});
  assert.equal(readReply('room')?.preview,'fresh preview');
  forgetReplies();assert.equal(readReply('room'),null);
});

test('a delayed private preview cannot resurrect a cancelled, replaced or logged-out selection',()=>{
  forgetReplies();const old=target();requestReply('room',old);
  const replacement=target();requestReply('room',replacement);
  refreshPrivateReply('room',old,{author:'alice',text:'stale private preview'});
  assert.equal(readReply('room'),replacement);
  forgetReplies();refreshPrivateReply('room',replacement,{author:'alice',text:'late private preview'});
  assert.equal(readReply('room'),null);
});

test('private preview refresh leaves ordinary reply targets and another thread untouched',()=>{
  forgetReplies();const privateTarget=target();requestReply('room:thread',privateTarget);
  const ordinary={...target(),native:undefined,author:'bob',preview:'ordinary preview',nativeUnavailable:false};requestReply('room',ordinary);
  refreshPrivateReply('room',ordinary,{author:'alice',text:'private preview'});
  assert.equal(readReply('room'),ordinary);assert.equal(readReply('room:thread'),privateTarget);
  forgetReplies();
});

test('an ordinary reference in a protected composer is refreshed only while it remains selected',()=>{
  forgetReplies();const {crypto_admission:_admission,...native}=target().native!;
  const selected={...target(),native};requestReply('protected-destination',selected);
  refreshNativeReply('protected-destination',selected,{author:'bob',text:'ordinary excerpt'});
  const visible=readReply('protected-destination')!;assert.equal(visible.preview,'ordinary excerpt');
  invalidateNativeReply('protected-destination',visible);assert.equal(readReply('protected-destination')?.preview,null);
  refreshNativeReply('protected-destination',selected,{author:'bob',text:'refreshed excerpt'});
  assert.equal(readReply('protected-destination')?.preview,'refreshed excerpt');
  const replacement={...selected,native:{...native}};requestReply('protected-destination',replacement);
  refreshNativeReply('protected-destination',selected,{author:'bob',text:'late excerpt'});
  assert.equal(readReply('protected-destination'),replacement);forgetReplies();
});
