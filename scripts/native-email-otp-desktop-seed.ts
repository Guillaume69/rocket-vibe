/** Disposable PostgreSQL/TLS bench only; never print a code or credential. */
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
const token=()=>randomBytes(32).toString('hex');
async function main(){
  if(process.env.RV_PEER_URL!=='http://server:3400' || process.env.RV_PEER_PASSWORD!=='native-pilot-test-password')throw new Error('fixture');
  const client=new NativeTransport(process.env.RV_PEER_URL);
  const username=process.env.RV_PILOT_OTP_USER??'gtk-email';
  if(!['gtk-email','swift-email'].includes(username))throw new Error('fixture');
  let ready=false;
  for(let i=0;i<60;i++){
    try{await client.discover();ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,500));}
  }
  if(!ready)throw new Error('fixture');
  await client.login(username,process.env.RV_PEER_PASSWORD);
  const contact=await client.emailStatus();
  const input={verification_id:token(),operation_id:token(),address:`${username}@example.test`,expected_version:contact.version,verification_version:contact.verification_version,context:contact.context};
  await client.beginEmailVerification(input);
  let code:string|null=null;
  for(let i=0;i<200;i++){
    try{const delivered=JSON.parse(await readFile(`/pilot-invitations/${username}-mail.json`,'utf8'));if(delivered.sequence===1 && /^\d{8}$/.test(delivered.code)){code=delivered.code;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  if(!code)throw new Error('fixture');
  await client.confirmEmailVerification({verification_id:input.verification_id,operation_id:input.operation_id,code,context:contact.context});code=null;
  const verified=await client.emailStatus(), factors=await client.factorStatus();
  if(process.env.RV_PILOT_EMAIL_SETTINGS!=='1')await client.enableEmailFactor({operation_id:token(),email_version:verified.version,factor_version:factors.factor_version??null,context:verified.context});
  await client.logout();
  console.log('Disposable desktop email fixture provisioned with verified contact and real TLS delivery');
}
main().catch(()=>{console.error('Disposable desktop email OTP seed failed');process.exitCode=1;});
