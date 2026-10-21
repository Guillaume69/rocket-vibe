/** An owned Chromium-family browser driven over the DevTools protocol. */
import { existsSync } from 'node:fs';
import { BridgeError } from './session.mjs';
export function executable(){
  const paths=process.platform==='win32'?['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe']:
    process.platform==='darwin'?['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']:['/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/usr/bin/microsoft-edge','/usr/bin/brave-browser'];
  const found=paths.find(p=>existsSync(p));if(!found)throw new BridgeError('supported_browser_missing');return found;
}
export class Cdp {
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
