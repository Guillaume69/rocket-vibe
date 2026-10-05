/** Disposable Docker pilot only: provision two factor accounts, never log codes. */
import {createHmac} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {NativeTransport} from '../apps/mobile/providers/rocketvibe/transport.ts';

const base=process.env.RV_PEER_URL;
if(base!=='http://server:3400' || process.env.RV_PEER_PASSWORD!=='native-pilot-test-password')throw new Error('Requires the disposable Docker pilot');
let ready=false;
for(let i=0;i<60;i++){
  try{await new NativeTransport(base).discover();ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}
}
if(!ready)throw new Error('Pilot server unavailable');
const accounts=[['gtk-factor','gtk-factors.json'],['swift-factor','swift-factors.json']];
if(process.env.RV_PILOT_SECURITY==='1')accounts.push(['gtk-security','gtk-security-factors.json'],['swift-security','swift-security-factors.json']);
for(const [username,file] of accounts){
  const client=new NativeTransport(base);await client.login(username,process.env.RV_PEER_PASSWORD);
  const setup=await client.beginFactorSetup({operation_id:`pilot-${username}-setup`});
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';
  for(const char of setup.secret)bits+=alphabet.indexOf(char).toString(2).padStart(5,'0');
  const secret=Buffer.from(Array.from({length:Math.floor(bits.length/8)},(_,i)=>parseInt(bits.slice(i*8,i*8+8),2)));
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)));
  const digest=createHmac('sha1',secret).update(counter).digest();const code=String((digest.readUInt32BE(digest[19]&15)&0x7fffffff)%1_000_000).padStart(6,'0');
  const backup=await client.enableFactor({setup_id:setup.setup_id,operation_id:`pilot-${username}-enable`,code});
  await writeFile(`/pilot-invitations/${file}`,JSON.stringify(backup),{mode:0o600});
  await client.logout();secret.fill(0);digest.fill(0);
}
console.log(`Native pilot factors provisioned for ${accounts.length} disposable accounts`);
