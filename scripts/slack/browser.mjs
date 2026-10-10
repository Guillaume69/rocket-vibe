/** Only an owned Chromium profile is inspected. Slack content never enters logs. */
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Cdp,executable } from '../teams/browser.mjs';
import { BridgeError,slackUrl,candidates,sessionCookie } from './session.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Check location in the evaluated context before accessing storage, covering navigation races.
export const snapshotExpression=`(()=>{const u=new URL(location.href);if(u.protocol!=='https:'||u.port||!/^([a-z0-9-]+\\.)?slack\\.com$/.test(u.hostname)||!/^\\/(client|app)(\\/|$)/.test(u.pathname))return null;let config=null;try{const s=localStorage.getItem('localConfig_v2');if(s&&s.length<=2000000)config=s;}catch{}let total=0;const tokens=new Set();for(const s of document.scripts){const t=s.textContent||'';total+=t.length;if(total>2000000)break;for(const m of t.matchAll(/["']api_token["']\\s*:\\s*["'](xoxc-[A-Za-z0-9-]+)["']/g))tokens.add(m[1]);}return {url:u.href,config,bootToken:tokens.size===1?[...tokens][0]:null};})()`;
export async function ownedBrowser(collector,{smoke=false,onStatus=()=>{},onClosed=()=>{}}={}){
 const base=resolve(tmpdir()),profile=await mkdtemp(join(base,'rocketvibe-slack-'));if(!resolve(profile).startsWith(base+sep))throw new BridgeError('unsafe_profile_path');
 let child,cdp,closed=false,polling=false,timer;const checked=new Map();let previousCookie=null;
 const close=async()=>{if(closed)return;closed=true;clearInterval(timer);checked.clear();previousCookie=null;collector.close();
  if(cdp){try{await cdp.send('Browser.close');}catch{}cdp.close();}
  if(child&&child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)child.kill();}
  for(let n=0;n<4;n++){try{await rm(profile,{recursive:true,force:true});return;}catch{await sleep(500);}}onStatus('profile_cleanup_pending');
 };
 try{
  child=spawn(executable(),['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check',...(smoke?['--headless=new']:[]),'about:blank'],{stdio:'ignore',windowsHide:smoke});let spawnError=false;child.on('error',()=>{spawnError=true;});let endpoint;
  for(let n=0;n<150;n++){if(spawnError||child.exitCode!==null)throw new BridgeError('browser_unavailable');try{const lines=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');if(/^\d{1,5}$/.test(lines[0])&&Number(lines[0])>0&&Number(lines[0])<65536&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1])){endpoint='ws://127.0.0.1:'+lines[0]+lines[1];break;}}catch{}await sleep(100);}
  if(!endpoint)throw new BridgeError('browser_unavailable');cdp=await Cdp.connect(endpoint);
  if(smoke){await cdp.send('Browser.getVersion');onStatus('browser_transport_ready');}
  else{
   const targets=await cdp.send('Target.getTargets'),blank=targets.targetInfos.find(t=>t.type==='page'&&t.url==='about:blank');if(!blank)throw new BridgeError('browser_unavailable');
   const attached=await cdp.send('Target.attachToTarget',{targetId:blank.targetId,flatten:true});await cdp.send('Page.navigate',{url:'https://slack.com/signin'},attached.sessionId);await cdp.send('Target.detachFromTarget',{sessionId:attached.sessionId});
   const poll=async()=>{if(closed||polling)return;polling=true;try{
    const targets=await cdp.send('Target.getTargets');let usable=false;
    for(const target of targets.targetInfos.filter(t=>t.type==='page'&&slackUrl(t.url,true)).slice(0,20)){
     let sessionId;try{
      ({sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
      const evaluated=await cdp.send('Runtime.evaluate',{expression:snapshotExpression,returnByValue:true},sessionId),snapshot=evaluated.result?.value;
      if(!snapshot||!slackUrl(snapshot.url,true))continue;
      const result=await cdp.send('Network.getCookies',{urls:[snapshot.url]},sessionId),session=sessionCookie(result.cookies,snapshot.url);if(!session)continue;usable=true;
      const cookieHash=createHash('sha256').update(session.cookie).digest('hex');if(previousCookie!==cookieHash){collector.invalidate();checked.clear();previousCookie=cookieHash;}
      for(const candidate of candidates(snapshot.url,snapshot.config,snapshot.bootToken)){
       if(closed)return;const key=createHash('sha256').update(candidate.token).update(session.cookie).digest('hex');if((checked.get(key)||0)>Date.now()-30000)continue;checked.set(key,Date.now());if(checked.size>100)checked.delete(checked.keys().next().value);
       await collector.accept(candidate,session);onStatus('capturing');
      }
     }finally{if(sessionId&&!closed)try{await cdp.send('Target.detachFromTarget',{sessionId});}catch{}}
    }
    if(!usable){collector.invalidate();checked.clear();previousCookie=null;onStatus('waiting_for_sign_in');}
   }catch(error){if(!closed)onStatus(error instanceof BridgeError?error.code:'capture_unavailable');}finally{polling=false;}};
   timer=setInterval(()=>{void poll();},2000);void poll();
  }
  child.once('exit',()=>{if(!closed)void close().finally(onClosed);});return {close};
 }catch(error){await close();throw error instanceof BridgeError?error:new BridgeError('browser_unavailable');}
}
