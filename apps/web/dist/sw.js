const CACHE='rv-shell-ad5d8627cdd14e69';
const ASSETS=["/","/assets/Baloo2_600SemiBold-BdWXeuOC.ttf","/assets/Baloo2_700Bold-Cjbtejvw.ttf","/assets/Baloo2_800ExtraBold-qOkBzYl0.ttf","/assets/Noto-COLRv1-BcXdrMyF.ttf","/assets/Nunito_400Regular-BaWrjX0c.ttf","/assets/Nunito_600SemiBold-B4qcAUfD.ttf","/assets/Nunito_700Bold-LWqDuPdh.ttf","/assets/Nunito_800ExtraBold-De0aZuyy.ttf","/assets/admin-BT5d9jBN.js","/assets/bots-B_uVGr-M.js","/assets/cue-join-Dmu9mole.ogg","/assets/cue-leave-B_cDRH_7.ogg","/assets/cue-message-CABt2Nf6.ogg","/assets/cue-missed-CL2Dn533.ogg","/assets/cue-mute-D9Q3KU93.ogg","/assets/cue-unmute-CcvS9xyy.ogg","/assets/emblem-system-symbolic-Sry63SBf.svg","/assets/favicon-Cmjb6sZ-.png","/assets/index-CsobWAij.js","/assets/index-DnaqxWOO.css","/assets/livekit-client.e2ee.worker-CHfIzpN8.mjs","/assets/livekit-client.esm-Bl9Ber4A.js","/assets/panels-Wj2JMPWa.js","/assets/ringback-D-kwUb0S.ogg","/assets/ringtone-BMzPUTkY.ogg","/assets/rv_crypto_web_bg-CSHwi6f8.wasm","/assets/system-run-symbolic-CybRJGJG.svg","/assets/worker-DqS6mFae.js","/assets/workflow-forms-C1oJIUX4.js","/assets/icon-b56deead0816.png","/manifest.webmanifest"];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('rv-shell-')&&name!==CACHE).slice(0,-1).map(name=>caches.delete(name)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
const url=new URL(event.request.url);
if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/.well-known/'))return;
if(event.request.mode==='navigate'&&(url.pathname==='/'||url.pathname.startsWith('/room/'))){
event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/'))));return;}
if(ASSETS.includes(url.pathname)||/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname))event.respondWith(caches.match(event.request,{ignoreVary:true}).then(response=>response||fetch(event.request)));
});
const waiting=[];
self.addEventListener('message',event=>{
const data=event.data;
if(!data||typeof data!=='object')return;
if(data.type==='rv-notification-hello'&&event.ports[0]){
event.ports[0].postMessage({version:1,inlineReply:typeof NotificationEvent!=='undefined'&&'reply' in NotificationEvent.prototype});return;}
if(data.type==='rv-notification-ready'&&event.source)
for(const item of waiting.splice(0)){event.source.postMessage(item.click);item.done();}
});
self.addEventListener('notificationclick',event=>{
const data=event.notification.data;
if(!data||data.rv!=='message')return;
event.notification.close();
const click={type:'rv-notification',action:['read','like','reply'].includes(event.action)?event.action:'open',reply:typeof event.reply==='string'?event.reply:null,account:data.account,room:data.room,message:data.message};
const work=hand(click).catch(()=>{});
// A synthetic event (tests) cannot extend its lifetime; the work still runs.
try{event.waitUntil(work)}catch{}
});
async function hand(click){
const background=click.action==='read'||click.action==='like'||(click.action==='reply'&&!!click.reply&&!!click.reply.trim());
const tabs=await self.clients.matchAll({type:'window',includeUncontrolled:true});
const tab=tabs.find(c=>c.focused)||tabs.find(c=>c.visibilityState==='visible')||tabs[0];
if(tab){
if(!background)try{await tab.focus()}catch{}
tab.postMessage(click);return;}
await new Promise(done=>{
const item={click,done};
waiting.push(item);
setTimeout(()=>{const at=waiting.indexOf(item);if(at>=0)waiting.splice(at,1);done();},60000);
self.clients.openWindow('/room/'+encodeURIComponent(click.room)).catch(()=>{});
});
}
