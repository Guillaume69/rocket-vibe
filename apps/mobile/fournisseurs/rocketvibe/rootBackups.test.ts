import assert from 'node:assert/strict';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {decodeNative} from './validation.ts';
import {NativeError,NativeTransport} from './transport.ts';
const fixture=JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json',import.meta.url),'utf8'));
const request=decodeNative('PublishRootBackup',fixture.parity.e2ee_publish_root_backup);
const state=decodeNative('RootBackupState',fixture.parity.e2ee_root_backup);
const receipt=state.active!.receipt;
test('OpenSSL independently verifies the root backup vector and exact packet purpose binding',()=>{
  const publication=JSON.parse(Buffer.from(request.publication,'base64url').toString('utf8'));
  const root=publication.packet.header.root;
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(root.public_key)]),format:'der',type:'spki'});
  const frame=(domain:string,value:unknown)=>Buffer.concat([Buffer.from(domain+'\0'),Buffer.from(JSON.stringify(value))]);
  const signature=Buffer.from(publication.signature);
  assert(verify(null,frame('rocketvibe-root-backup-publication-v1',publication.body),key,signature));
  assert(!verify(null,frame('rocketvibe-device-revocation-v1',publication.body),key,signature));
  assert(!verify(null,frame('rocketvibe-root-backup-publication-v1',{...publication.body,expected_revision:null}),key,signature));
  const packetDigest=createHash('sha256').update(JSON.stringify(publication.packet)).digest();
  assert.deepEqual([...packetDigest],publication.body.packet_digest);
  assert.equal(packetDigest.toString('hex'),receipt.packet_digest);
  assert.equal(createHash('sha256').update(frame('rocketvibe-root-fingerprint-v1',root)).digest('hex'),receipt.root_fingerprint);
  assert.equal(publication.body.device_revision,'9007199254740993');
});
test('lost backup result is readable by its original receipt and by a fresh device without a second POST',async()=>{
  let posts=0;
  const calls:{path:string;options?:RequestInit}[]=[];
  const transport=new NativeTransport('https://example.org',async(url,options)=>{
    const path=new URL(String(url)).pathname;calls.push({path,options});
    if(options?.method==='POST') {
      assert.equal(posts++,0);assert.deepEqual(JSON.parse(String(options.body)),request);
      throw TypeError('Lost backup response');
    }
    return Response.json(path.includes('/operations/')?receipt:state);
  });
  transport.restore('saved-token');
  await assert.rejects(transport.publishCryptoRootBackup(request));
  assert.deepEqual(await transport.cryptoRootBackupOperation(request.operation_id),receipt);
  assert.deepEqual(await transport.cryptoRootBackup(),state);
  assert.equal(posts,1);assert.equal(calls.length,3);
  assert.equal(calls[0].path,'/api/v1/e2ee/root-backup');
  assert.equal(calls[1].path,'/api/v1/e2ee/root-backup/operations/fixture-root-backup');
  assert.equal(receipt.backup_revision,'9007199254740993');
  for(const call of calls) {assert.equal(new Headers(call.options?.headers).get('authorization'),'Bearer saved-token');assert.equal(call.options?.redirect,'error');}
});
test('backup cooldown does not suppress receipt reads and public DTOs reject private fields',async()=>{
  let calls=0;
  const transport=new NativeTransport('https://example.org',async(_url,options)=>{
    calls++;return options?.method==='POST'?Response.json({code:'crypto_backup_limit',request_id:'quota'},{status:429,headers:{'retry-after':'30'}}):Response.json(receipt);
  });transport.restore('saved-token');
  await assert.rejects(transport.publishCryptoRootBackup(request),error=>error instanceof NativeError&&error.status===429);
  await assert.rejects(transport.publishCryptoRootBackup(request),error=>error instanceof NativeError&&error.status===429);
  assert.equal(calls,1);
  assert.deepEqual(await transport.cryptoRootBackupOperation(request.operation_id),receipt);
  assert.equal(calls,2);
  for(const field of ['recovery_code','private_key','seed','plaintext']) {
    assert.throws(()=>decodeNative('PublishRootBackup',{...request,[field]:'forbidden'}));
    assert.throws(()=>decodeNative('RootBackupReceipt',{...receipt,[field]:'forbidden'}));
    assert.throws(()=>decodeNative('RootBackupState',{...state,[field]:'forbidden'}));
  }
  for(const field of ['device_revision','backup_revision'])assert.throws(()=>decodeNative('RootBackupReceipt',{...receipt,[field]:9007199254740993}));
});
