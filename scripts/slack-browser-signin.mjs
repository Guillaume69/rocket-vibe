#!/usr/bin/env node
/** Development bridge. No credential printing/export, no existing-profile attachment. */
import { spawn } from 'node:child_process';
import { bridgeServer } from './slack/server.mjs';
import { ownedBrowser } from './slack/browser.mjs';
import { SessionCollector,BridgeError } from './slack/session.mjs';
const collector=new SessionCollector();let issue='waiting_for_sign_in',browser,server;
const smoke=process.argv.includes('--smoke');
async function stop(){collector.close();await browser?.close();await new Promise(resolve=>server?.close(resolve)??resolve());}
try{
  if(smoke){browser=await ownedBrowser(collector,{smoke:true,onStatus:s=>{issue=s;}});await stop();if(issue!=='browser_transport_ready')throw new BridgeError('smoke_failed');console.log('Slack bridge: dedicated browser transport passed; temporary profile removed.');}
  else{
    const bridge=await bridgeServer(collector,()=>issue);server=bridge.server;
    browser=await ownedBrowser(collector,{onStatus:s=>{issue=s;},onClosed:()=>{void stop();}});
    const url=bridge.url;
    console.log('Slack bridge ready. The local pairing page opens in your browser.');console.log('Sign in in the fresh Slack window and open the web client. Press Ctrl+C when finished. The bridge does not print session credentials or export them to files.');
    const command=process.platform==='win32'?'cmd.exe':process.platform==='darwin'?'open':'xdg-open';const args=process.platform==='win32'?['/c','start','',url]:[url];const opened=spawn(command,args,{stdio:'ignore',windowsHide:true});opened.on('error',()=>{});
    let stopping=false;const finish=()=>{if(stopping)return;stopping=true;void stop().finally(()=>{process.exitCode=0;});};process.once('SIGINT',finish);process.once('SIGTERM',finish);
    setTimeout(finish,20*60*1000).unref();
  }
}catch(error){await stop();console.error('Slack bridge: '+(error instanceof BridgeError?error.code:'unavailable'));process.exitCode=1;}
