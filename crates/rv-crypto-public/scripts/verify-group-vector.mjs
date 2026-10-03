// Independent OpenSSL verification of the public framing fixture; no app crypto.
import {readFileSync} from 'node:fs';
import {createHash,createPublicKey,verify} from 'node:crypto';
import assert from 'node:assert/strict';
const vector=JSON.parse(readFileSync(new URL('../fixtures/group-transition-v1.json',import.meta.url),'utf8'));
const input=vector.transition;
const root=s=>({version:s.version,instance:s.instance,user:s.user,generation:s.generation,public_key:s.public_key});
const device=s=>({version:s.version,root:root(s.root),device:s.device,incarnation:s.incarnation,serial:s.serial,suite:s.suite,signature_key:s.signature_key,issued_at:s.issued_at,expires_at:s.expires_at});
const certificate={device:device(input.certificate.device),signature:input.certificate.signature};
const s=input.plan.scope;
const scope={instance:s.instance,data_epoch:s.data_epoch,room:s.room,incarnation:s.incarnation};
const p=input.plan;
const plan={version:p.version,scope,operation:p.operation,expected_revision:p.expected_revision,expected_epoch:p.expected_epoch,epoch:p.epoch,previous:p.previous,authority_version:p.authority_version,
  members:p.members.map(m=>({user:m.user,access_version:m.access_version,activation_version:m.activation_version})),
  participants:p.participants.map(d=>({user:d.user,device:d.device,incarnation:d.incarnation,root:d.root,certificate:d.certificate,leaf:d.leaf,key_package:d.key_package})),
  context:p.context,commit:p.commit,tree:p.tree,welcomes:p.welcomes.map(w=>({device:w.device,incarnation:w.incarnation,key_package:w.key_package,digest:w.digest}))};
const frame=(domain,value)=>Buffer.concat([Buffer.from(`${domain}\0`),Buffer.from(JSON.stringify(value))]);
const hash=(domain,value)=>createHash('sha256').update(frame(domain,value)).digest();
const key=bytes=>createPublicKey({format:'jwk',key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(bytes).toString('base64url')}});
assert.equal(verify(null,frame('rocketvibe-device-certificate-v1',certificate.device),key(certificate.device.root.public_key),Buffer.from(certificate.signature)),true);
assert.deepEqual(hash('rocketvibe-root-fingerprint-v1',root(certificate.device.root)),Buffer.from(plan.participants[0].root));
assert.deepEqual(hash('rocketvibe-certificate-fingerprint-v1',certificate),Buffer.from(plan.participants[0].certificate));
assert.deepEqual(hash('rocketvibe-group-id-v1',scope),Buffer.from(vector.group_id));
const leaf=key(certificate.device.signature_key);
assert.equal(verify(null,frame('rocketvibe-group-transition-v1',plan),leaf,Buffer.from(input.signature)),true);
assert.deepEqual(hash('rocketvibe-group-transition-fingerprint-v1',{certificate,plan,signature:input.signature}),Buffer.from(vector.fingerprint));
const changes=[q=>q.scope.room='foreign-room',q=>q.scope.data_epoch='restored-epoch',q=>q.scope.incarnation[0]^=1,q=>q.previous[0]^=1,q=>q.context[0]^=1,q=>q.tree[0]^=1,q=>q.commit[0]^=1,q=>q.members[1].access_version='rejoined',q=>q.members[1].activation_version='reactivated',q=>q.participants[1].root[0]^=1,q=>q.participants[1].certificate[0]^=1,q=>q.participants[1].leaf=4,q=>q.participants[1].key_package[0]^=1,q=>q.welcomes[0].digest[0]^=1,q=>q.operation='new-operation'];
for(const change of changes){const altered=structuredClone(plan);change(altered);assert.equal(verify(null,frame('rocketvibe-group-transition-v1',altered),leaf,Buffer.from(input.signature)),false);}
assert.equal(verify(null,frame('rocketvibe-device-request-v1',plan),leaf,Buffer.from(input.signature)),false);
console.log('Public group fixture: certificate, group scope, transition signature/fingerprint and substitutions verified independently');
