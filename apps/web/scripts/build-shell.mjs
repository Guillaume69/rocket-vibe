import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const assets = readdirSync("dist/assets")
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
if(ASSETS.includes(url.pathname)||/^\\/assets\\/[a-zA-Z0-9_.-]+$/.test(url.pathname))event.respondWith(caches.match(event.request).then(response=>response||fetch(event.request)));
});
`,
);
