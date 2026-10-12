const CACHE='rv-shell-11ee49aa1327c0bc';
const ASSETS=["/","/assets/Baloo2_600SemiBold-BdWXeuOC.ttf","/assets/Baloo2_700Bold-Cjbtejvw.ttf","/assets/Baloo2_800ExtraBold-qOkBzYl0.ttf","/assets/Noto-COLRv1-BcXdrMyF.ttf","/assets/Nunito_400Regular-BaWrjX0c.ttf","/assets/Nunito_600SemiBold-B4qcAUfD.ttf","/assets/Nunito_700Bold-LWqDuPdh.ttf","/assets/Nunito_800ExtraBold-De0aZuyy.ttf","/assets/admin-D_3lOPQr.js","/assets/bots-geBH0sjD.js","/assets/cue-join-xgNC4jwo.ogg","/assets/cue-leave-DVXW9D-K.ogg","/assets/cue-message-69heR_nf.ogg","/assets/cue-missed-CTnauKK-.ogg","/assets/cue-mute-4QEtROfH.ogg","/assets/cue-unmute-BWSe_5VY.ogg","/assets/emblem-system-symbolic-Sry63SBf.svg","/assets/favicon-Cmjb6sZ-.png","/assets/index-DrWcYT6U.css","/assets/index-wGzq0ckc.js","/assets/livekit-client.e2ee.worker-CHfIzpN8.mjs","/assets/livekit-client.esm-Bl9Ber4A.js","/assets/panels-CQSL2WwJ.js","/assets/ringback-B5tbZIZJ.ogg","/assets/ringtone-BJS6bYjD.ogg","/assets/rv_crypto_web_bg-D_RAeoB6.wasm","/assets/system-run-symbolic-CybRJGJG.svg","/assets/worker-BkPj8Ok4.js","/assets/workflow-forms-CKY4GsVE.js","/assets/icon-b56deead0816.png","/manifest.webmanifest"];
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
