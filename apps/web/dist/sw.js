const CACHE='rv-shell-10ad72fd0afe3e67';
const ASSETS=["/","/assets/Baloo2_600SemiBold-BdWXeuOC.ttf","/assets/Baloo2_700Bold-Cjbtejvw.ttf","/assets/Baloo2_800ExtraBold-qOkBzYl0.ttf","/assets/Noto-COLRv1-BcXdrMyF.ttf","/assets/Nunito_400Regular-BaWrjX0c.ttf","/assets/Nunito_600SemiBold-B4qcAUfD.ttf","/assets/Nunito_700Bold-LWqDuPdh.ttf","/assets/Nunito_800ExtraBold-De0aZuyy.ttf","/assets/cue-join-xgNC4jwo.ogg","/assets/cue-leave-DVXW9D-K.ogg","/assets/cue-missed-CTnauKK-.ogg","/assets/cue-mute-4QEtROfH.ogg","/assets/cue-unmute-BWSe_5VY.ogg","/assets/emblem-system-symbolic-Sry63SBf.svg","/assets/favicon-Cmjb6sZ-.png","/assets/index-Bacj9GEi.css","/assets/index-CVK12ZqS.js","/assets/livekit-client.e2ee.worker-CHfIzpN8.mjs","/assets/livekit-client.esm-Bl9Ber4A.js","/assets/ringback-B5tbZIZJ.ogg","/assets/ringtone-BJS6bYjD.ogg","/assets/rv_crypto_web_bg-X1XTRAfk.wasm","/assets/system-run-symbolic-CybRJGJG.svg","/assets/worker-DMOFM3AU.js","/assets/workflow-forms-Bltz8wFu.js","/assets/icon-b56deead0816.png","/manifest.webmanifest"];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('rv-shell-')&&name!==CACHE).slice(0,-1).map(name=>caches.delete(name)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
const url=new URL(event.request.url);
if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/.well-known/'))return;
if(event.request.mode==='navigate'&&(url.pathname==='/'||url.pathname.startsWith('/room/'))){
event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/'))));return;}
if(ASSETS.includes(url.pathname)||/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname))event.respondWith(caches.match(event.request).then(response=>response||fetch(event.request)));
});
