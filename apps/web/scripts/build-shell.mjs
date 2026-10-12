import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
// The video reduction worker (Mediabunny, about 100 KB gzipped) is fetched
// only when a video is reduced, never precached for everyone; offline, the
// video goes out in original quality.
const assets = readdirSync("dist/assets")
  .filter((name) => !name.startsWith("video-reduce.worker-"))
  .sort()
  .map((name) => "/assets/" + name);
const icon = readFileSync(
  "../desktop/data/icons/hicolor/256x256/apps/com.rocketvibe.app.png",
);
const iconName =
  "/assets/icon-" +
  createHash("sha256").update(icon).digest("hex").slice(0, 12) +
  ".png";
writeFileSync("dist" + iconName, icon);
assets.push(iconName);
const version = createHash("sha256")
  .update(assets.join("\n"))
  .digest("hex")
  .slice(0, 16);
writeFileSync(
  "dist/manifest.webmanifest",
  JSON.stringify({
    name: "rocket-vibe",
    short_name: "rocket-vibe",
    start_url: "/",
    display: "standalone",
    background_color: "#0C0B16",
    theme_color: "#0C0B16",
    icons: [{ src: iconName, sizes: "256x256", type: "image/png" }],
  }),
);
// Message notifications (src/notifications.ts): the worker holds no session.
// A click or a button goes to a live tab, which acts with its own session;
// with no tab, one is opened on the room and gets the click once it says it
// is ready. A click only focuses; the buttons act in the background.
const notificationWorker = `const waiting=[];
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
`;
// Public same-origin assets have identical bytes for every request Origin.
// Precache requests lack that header while crossorigin module/style requests
// send it; Vary: Origin on a static host must not bypass the offline shell.
writeFileSync(
  "dist/sw.js",
  `const CACHE='rv-shell-${version}';
const ASSETS=${JSON.stringify(["/", ...assets, "/manifest.webmanifest"])};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name.startsWith('rv-shell-')&&name!==CACHE).slice(0,-1).map(name=>caches.delete(name)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
const url=new URL(event.request.url);
if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/.well-known/'))return;
if(event.request.mode==='navigate'&&(url.pathname==='/'||url.pathname.startsWith('/room/'))){
event.respondWith(fetch(event.request).catch(()=>caches.open(CACHE).then(cache=>cache.match('/'))));return;}
if(ASSETS.includes(url.pathname)||/^\\/assets\\/[a-zA-Z0-9_.-]+$/.test(url.pathname))event.respondWith(caches.match(event.request,{ignoreVary:true}).then(response=>response||fetch(event.request)));
});
${notificationWorker}`,
);
