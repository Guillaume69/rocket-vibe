/** Owned temporary Chromium profile. Never attaches to an existing user profile. */
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { spawn } from 'node:child_process';
import { BridgeError,tokenRequest } from './session.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function executable(){
  const paths=process.platform==='win32'?['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']:
    process.platform==='darwin'?['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/microsoft-edge'];
  const found=paths.find(p=>existsSync(p));if(!found)throw new BridgeError('supported_browser_missing');return found;
}
class Cdp {
  #next=0;#pending=new Map();#listeners=new Set();
  constructor(ws){this.ws=ws;ws.addEventListener('message',event=>{
    let packet;try{if(event.data.length>4000000)return;packet=JSON.parse(event.data);}catch{return;}
    if(packet.id){const p=this.#pending.get(packet.id);if(p){this.#pending.delete(packet.id);clearTimeout(p.timer);packet.error?p.reject(new BridgeError('browser_command_failed')):p.resolve(packet.result);}return;}
    for(const listener of this.#listeners)listener(packet);
  });ws.addEventListener('close',()=>{for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('browser_closed'));}this.#pending.clear();});}
  static async connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(new BridgeError('browser_unavailable'));},15000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(new BridgeError('browser_unavailable'));},{once:true});});return new Cdp(ws);}
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.#next;const timer=setTimeout(()=>{this.#pending.delete(id);reject(new BridgeError('browser_timeout'));},15000);this.#pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{} )}));});}
  on(listener){this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  close(){this.#listeners.clear();this.ws.close();}
}
export function teamsTokenRequest(requestEvent){
  try{if(new URL(requestEvent.documentURL).origin!=='https://teams.microsoft.com')return null;}catch{return null;}
  return tokenRequest(requestEvent.request.url,requestEvent.request.postData);
}
export async function ownedBrowser(collector,{smoke=false,onStatus=()=>{},onClosed=()=>{}}={}){
  const base=resolve(tmpdir()),profile=await mkdtemp(join(base,'rocketvibe-teams-'));
  if(!resolve(profile).startsWith(base+sep))throw new BridgeError('unsafe_profile_path');
  let child,cdp,closed=false;const active=new Map();const sessions=new Set();
  const close=async()=>{
    if(closed)return;closed=true;active.clear();collector.close();
    if(cdp){try{await cdp.send('Browser.close');}catch{}cdp.close();}
    if(child&&child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);if(child.exitCode===null)child.kill();}
    for(let n=0;n<4;n++){try{await rm(profile,{recursive:true,force:true});return;}catch{await sleep(500);}}
    onStatus('profile_cleanup_pending');
  };
  try{
    // No insecure certificate flag, imported cookies, user-profile discovery or borrowed client ID.
    child=spawn(executable(),['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check',...(smoke?['--headless=new']:[]),'about:blank'],{stdio:'ignore',windowsHide:smoke});
    let spawnError=false;child.on('error',()=>{spawnError=true;});let endpoint;
    for(let n=0;n<150;n++){
      if(spawnError||child.exitCode!==null)throw new BridgeError('browser_unavailable');
      try{const lines=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');if(/^\d{1,5}$/.test(lines[0])&&Number(lines[0])>0&&Number(lines[0])<65536&&/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1])){endpoint='ws://127.0.0.1:'+lines[0]+lines[1];break;}}catch{}
      await sleep(100);
    }
    if(!endpoint)throw new BridgeError('browser_unavailable');cdp=await Cdp.connect(endpoint);
    const unsubscribe=cdp.on(packet=>{void(async()=>{
      if(closed)return;
      if(packet.method==='Target.attachedToTarget'){
        const {sessionId,targetInfo}=packet.params;
        let trusted=false;try{const u=new URL(targetInfo.url);trusted=['https://teams.microsoft.com','https://login.microsoftonline.com'].includes(u.origin)||targetInfo.url==='about:blank';}catch{}
        if(trusted&&['page','iframe','worker','service_worker'].includes(targetInfo.type)){
          sessions.add(sessionId);await cdp.send('Network.enable',{maxTotalBufferSize:2000000,maxResourceBufferSize:300000,maxPostDataSize:200000},sessionId);
        }
        await cdp.send('Runtime.runIfWaitingForDebugger',{},sessionId);return;
      }
      if(!sessions.has(packet.sessionId))return;
      const p=packet.params,key=packet.sessionId+':'+p.requestId;
      if(packet.method==='Network.requestWillBeSent'){
        active.delete(key);if(p.request.method!=='POST')return;
        // Only collect OAuth responses issued by Microsoft's own browser requests.
        const metadata=teamsTokenRequest(p);if(metadata){if(active.size>=100)active.delete(active.keys().next().value);active.set(key,{metadata,ok:false});}
      }else if(packet.method==='Network.responseReceived'){
        const item=active.get(key);if(item)item.ok=p.response.status===200&&tokenRequest(p.response.url,'client_id='+item.metadata.clientId+'&scope='+encodeURIComponent({spaces:'https://api.spaces.skype.com/.default',aggregator:'https://chatsvcagg.teams.microsoft.com/.default',chat:'https://ic3.teams.office.com/.default'}[item.metadata.audience]))!==null;
      }else if(packet.method==='Network.loadingFailed'){active.delete(key);}
      else if(packet.method==='Network.loadingFinished'){
        const item=active.get(key);active.delete(key);if(!item?.ok)return;
        const raw=await cdp.send('Network.getResponseBody',{requestId:p.requestId},packet.sessionId);
        const body=raw.base64Encoded?Buffer.from(raw.body,'base64').toString():raw.body;
        if(body.length>300000)throw new BridgeError('response_too_large');
        await collector.accept(item.metadata,JSON.parse(body));onStatus('capturing');
      }
    })().catch(error=>{if(!closed)onStatus(error instanceof BridgeError?error.code:'capture_unavailable');});});
    await cdp.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
    const targets=await cdp.send('Target.getTargets');
    // Navigate only the fresh blank page after Network.enable has been installed.
    const target=targets.targetInfos.find(t=>t.type==='page'&&t.url==='about:blank');
    if(target){const attached=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true});sessions.add(attached.sessionId);await cdp.send('Network.enable',{maxTotalBufferSize:2000000,maxResourceBufferSize:300000},attached.sessionId);if(!smoke)await cdp.send('Page.navigate',{url:'https://teams.microsoft.com/'},attached.sessionId);}
    if(smoke){await cdp.send('Browser.getVersion');onStatus('browser_transport_ready');}
    child.once('exit',()=>{if(!closed)void close().finally(onClosed);});
    return {close:async()=>{unsubscribe();await close();}};
  }catch(error){await close();throw error instanceof BridgeError?error:new BridgeError('browser_unavailable');}
}
