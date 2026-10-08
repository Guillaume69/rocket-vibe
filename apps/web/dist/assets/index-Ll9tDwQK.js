(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),t.credentials=e.crossOrigin===`use-credentials`?`include`:e.crossOrigin===`anonymous`?`omit`:`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e=class extends Error{status;code;retryAfter;constructor(e,t,n=0){super(t),this.status=e,this.code=t,this.retryAfter=n}},t=class{token=``;expired=()=>{};async request(t,n=`GET`,r,i=!1){if(!t.startsWith(`/api/`)&&t!==`/.well-known/rocketvibe`)throw Error(`Invalid API path`);let a=this.token,o=new Headers;a&&!i&&o.set(`Authorization`,`Bearer `+a);let s;r instanceof Blob?(s=r,o.set(`Content-Type`,r.type||`application/octet-stream`)):r!==void 0&&(s=JSON.stringify(r),o.set(`Content-Type`,`application/json`));let c=await fetch(t,{method:n,headers:o,body:s,credentials:`omit`,cache:`no-store`,signal:AbortSignal.timeout(3e4)});if(!c.ok){let t=await c.json().catch(()=>null),n=t&&typeof t==`object`&&`code`in t&&typeof t.code==`string`?t.code:`http_`+c.status;throw c.status===401&&a===this.token&&!i&&n===`session_rejected`&&t&&typeof t==`object`&&`request_id`in t&&typeof t.request_id==`string`&&this.expired(),new e(c.status,n,Math.min(300,Number(c.headers.get(`Retry-After`))||0))}if(c.status!==204)return await c.json()}async upload(t,n,r){if(!t.startsWith(`/api/v1/uploads/`))throw Error(`Invalid upload path`);let i=this.token;await new Promise((a,o)=>{let s=new XMLHttpRequest;s.open(`PUT`,t),s.timeout=3e5,s.setRequestHeader(`Authorization`,`Bearer `+i),s.setRequestHeader(`Content-Type`,n.type||`application/octet-stream`),s.upload.onprogress=e=>{e.lengthComputable&&r(e.loaded/e.total)},s.onerror=()=>o(TypeError(`Network unavailable`)),s.ontimeout=()=>o(Error(`Upload timed out`)),s.onload=()=>{if(s.status>=200&&s.status<300){r(1),a();return}let t=`upload_failed`;try{t=JSON.parse(s.responseText).code||t}catch{}o(new e(s.status,t))},s.send(n)})}async blob(t){if(!t.startsWith(`/api/`))throw Error(`Invalid resource path`);let n=await fetch(t,{headers:{Authorization:`Bearer `+this.token},credentials:`omit`,cache:`no-store`,signal:AbortSignal.timeout(6e4)});if(!n.ok)throw new e(n.status,`download_failed`);return n.blob()}async snapshot(e){if(!e.capabilities.snapshot_paging)return this.request(`/api/v1/sync/snapshot`);let t=await this.request(`/api/v1/sync/snapshots`,`POST`,null),n=t.snapshot_id,r={protocol_version:1,rooms:[],messages:[],cursor:``},i=new Set,a=new Set,o=new Set,s=0;for(let e=0;e<128;e++){if(s+=JSON.stringify(t).length,t.protocol_version!==1||!n||t.snapshot_id!==n||t.page_index!==e||s>67108864)throw Error(`Invalid snapshot`);for(let e of t.rooms){if(a.has(e.id))throw Error(`Duplicate room`);a.add(e.id)}for(let e of t.messages){if(o.has(e.id))throw Error(`Duplicate message`);o.add(e.id)}if(r.rooms.push(...t.rooms),r.messages.push(...t.messages),!t.next&&t.cursor)return r.cursor=t.cursor,r;if(!t.next||t.cursor||i.has(t.next)||!/^[a-zA-Z0-9_-]+$/.test(t.next))throw Error(`Invalid page`);i.add(t.next),t=await this.request(`/api/v1/sync/snapshots/`+t.next)}throw Error(`Snapshot exceeds page limit`)}},n=e=>encodeURIComponent(e),r=()=>crypto.randomUUID().replaceAll(`-`,``),i=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),e=>e.toString(16).padStart(2,`0`)).join(``),a=(e,t)=>BigInt(e)>=BigInt(t),o=class{rooms=new Map;messages=new Map;cursor=``;replace(e){this.rooms=new Map(e.rooms.map(e=>[e.id,e])),this.messages=new Map(e.messages.map(e=>[e.id,e])),this.cursor=e.cursor}put(e){let t=this.messages.get(e.id);(!t||a(e.revision,t.revision))&&(this.messages.set(e.id,e),t&&(e.deleted||e.revision!==t.revision)&&this.invalidateQuote(e.id))}batch(e){if(e.protocol_version!==1||!e.cursor)throw Error(`Invalid sync batch`);for(let t of e.changes)if(t.type===`room_removed`)this.rooms.delete(t.data.room_id),this.invalidateRoom(t.data.room_id);else if(t.type===`room_upsert`){let e=this.rooms.get(t.data.id),n=t.data.read_state?.membership_version;e&&n&&e.read_state?.membership_version!==n&&this.invalidateRoom(e.id);let r=t.data;if(e&&e.read_state&&r.read_state&&e.read_state.membership_version===n){let t=r.read_state;a(t.favorite_revision||`0`,e.read_state.favorite_revision||`0`)||(t.favorite=e.read_state.favorite,t.favorite_revision=e.read_state.favorite_revision),a(t.revision,e.read_state.revision)||(r.read_state={...e.read_state,favorite:t.favorite,favorite_revision:t.favorite_revision})}this.rooms.set(r.id,e&&!a(r.revision,e.revision)?{...e,read_state:r.read_state}:r)}else t.type===`message_upsert`&&this.rooms.has(t.data.room_id)&&this.put(t.data);this.cursor=e.cursor}invalidateQuote(e){let t=n=>n.reference.message_id===e?{...n,excerpt:null}:n.excerpt?.quotes?{...n,excerpt:{...n.excerpt,quotes:n.excerpt.quotes.map(t)}}:n;for(let[e,n]of this.messages)n.quotes?.length&&this.messages.set(e,{...n,quotes:n.quotes.map(t)})}invalidateRoom(e){for(let[t,n]of this.messages)n.room_id===e&&this.messages.delete(t);let t=n=>n.reference.room_id===e?{...n,excerpt:null}:n.excerpt?.quotes?{...n,excerpt:{...n.excerpt,quotes:n.excerpt.quotes.map(t)}}:n;for(let[e,n]of this.messages)n.quotes?.length&&this.messages.set(e,{...n,quotes:n.quotes.map(t)})}snapshot(){return{protocol_version:1,rooms:[...this.rooms.values()],messages:[...this.messages.values()],cursor:this.cursor}}timeline(e,t){return[...this.messages.values()].filter(n=>n.room_id===e&&!n.deleted&&(t?n.reply_to===t:!n.reply_to)).sort((e,t)=>BigInt(e.position)<BigInt(t.position)?-1:BigInt(e.position)>BigInt(t.position)?1:e.id.localeCompare(t.id))}},s;function c(){return s??=new Promise((e,t)=>{let n=indexedDB.open(`rocket-vibe-web`,4);n.onupgradeneeded=()=>{for(let e of[`accounts`,`cache`,`outbox`,`drafts`,`operations`,`uploads`,`staged`,`media`])n.result.objectStoreNames.contains(e)||n.result.createObjectStore(e)},n.onsuccess=()=>e(n.result),n.onerror=()=>t(n.error)})}async function l(e,t){let n=await c();return new Promise((r,i)=>{let a=n.transaction(e).objectStore(e).get(t);a.onsuccess=()=>r(a.result),a.onerror=()=>i(a.error)})}async function u(e,t,n){let r=await c();return new Promise((i,a)=>{let o=r.transaction(e,`readwrite`);n===void 0?o.objectStore(e).delete(t):o.objectStore(e).put(n,t),o.oncomplete=()=>i(),o.onerror=()=>a(o.error),o.onabort=()=>a(o.error)})}async function d(e){let t=await c();return new Promise((n,r)=>{let i=t.transaction(e).objectStore(e).getAll();i.onsuccess=()=>n(i.result),i.onerror=()=>r(i.error)})}async function f(e,t){let n=await c();await new Promise((r,i)=>{let a=n.transaction([`outbox`,`uploads`,`drafts`,`staged`,`media`],`readwrite`);for(let n of[`outbox`,`uploads`,`drafts`,`staged`,`media`]){let r=a.objectStore(n).openCursor();r.onsuccess=()=>{let n=r.result;if(!n)return;let i=n.value;(String(n.key)===e+`:`+t||String(n.key).startsWith(e+`:`+t+`:`)||i&&typeof i==`object`&&i.account===e&&i.room===t)&&n.delete(),n.continue()}}a.oncomplete=()=>r(),a.onerror=()=>i(a.error)})}async function p(e){let t=await c();return new Promise((n,r)=>{let i=t.transaction([`accounts`,`cache`,`outbox`,`drafts`,`operations`,`uploads`,`staged`,`media`],`readwrite`);i.objectStore(`accounts`).delete(e),i.objectStore(`cache`).delete(e);for(let t of[`outbox`,`drafts`,`operations`,`uploads`,`staged`,`media`]){let n=i.objectStore(t).openCursor();n.onsuccess=()=>{let t=n.result;t&&(String(t.key).startsWith(e+`:`)&&t.delete(),t.continue())}}i.oncomplete=()=>n(),i.onerror=()=>r(i.error)})}function m(e){for(let t of e.querySelectorAll(`audio,video`))!t.classList.contains(`voice-audio`)&&!t.classList.contains(`voice-camera`)&&(t.pause(),t.removeAttribute(`src`),t.load())}function h(e,t=``,n=``){let r=document.createElement(e);return r.className=t,n&&(r.textContent=n),r}function g(e,t,n=`flat`){let r=h(`button`,n,e);return r.type=`button`,r.addEventListener(`click`,()=>{r.disabled||(r.disabled=!0,Promise.resolve().then(t).catch(v).finally(()=>{r.disabled=!1}))}),r}function _(e,t=``,n=`text`){let r=h(`label`,`field`);r.append(h(`span`,`pill-caption`,e));let i=h(`input`,`pill-entry`);return i.type=n,i.value=t,r.append(i),[r,i]}function v(e){let t=h(`div`,`toast`,e instanceof Error?e.message:String(e));document.querySelector(`#toasts`)?.append(t),setTimeout(()=>t.remove(),6e3)}function y(e){let t=h(`dialog`),n=h(`header`,`dialog-header`);n.append(h(`h2`,``,e),g(`×`,()=>t.close()));let r=h(`div`,`dialog-body`);return t.append(n,r),t.addEventListener(`click`,e=>{if(e.target===t){let n=t.getBoundingClientRect();(e.clientX<n.left||e.clientX>n.right||e.clientY<n.top||e.clientY>n.bottom)&&t.close()}}),t.addEventListener(`close`,()=>{m(t),t.remove()}),document.body.append(t),t.showModal(),[t,r]}var b=e=>e.trim().split(/\s+/).slice(0,2).map(e=>Array.from(e)[0]||``).join(``).toUpperCase();function x(e,t=`message`,n){let r=0;for(let t=0;t<e.length;t++)r=Math.imul(r,31)+e.charCodeAt(t)|0;return r=Math.abs(r),h(`div`,`tile tile-`+t+` tile-g`+r%7,n??b(e))}var S={search:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%206.5%200%20c%20-3.578125%200%20-6.5%202.921875%20-6.5%206.5%20s%202.921875%206.496094%206.5%206.496094%20c%201.429688%200%202.753906%20-0.464844%203.828125%20-1.253906%20l%202.945313%202.945312%20c%200.957031%200.9375%202.363281%20-0.5%201.40625%20-1.4375%20l%20-2.929688%20-2.929688%20c%200.785156%20-1.074218%201.25%20-2.394531%201.25%20-3.820312%20c%200%20-3.578125%20-2.921875%20-6.5%20-6.5%20-6.5%20z%20m%200%202%20c%202.496094%200%204.5%202.003906%204.5%204.5%20s%20-2.003906%204.496094%20-4.5%204.496094%20s%20-4.5%20-2%20-4.5%20-4.496094%20s%202.003906%20-4.5%204.5%20-4.5%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,plus:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%207%201%20v%206%20h%20-6%20v%202%20h%206%20v%206%20h%202%20v%20-6%20h%206%20v%20-2%20h%20-6%20v%20-6%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,attach:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%209.75%200.277344%20c%20-0.890625%200%20-1.78125%200.339844%20-2.457031%201.015625%20l%20-3.5%203.5%20c%20-0.019531%200.019531%20-0.039063%200.039062%20-0.058594%200.0625%20c%20-0.070313%200.082031%20-0.574219%200.628906%20-0.792969%201.4375%20c%20-0.21875%200.804687%20-0.058594%201.972656%200.839844%202.902343%20c%200.914062%200.941407%202.128906%201.09375%202.945312%200.867188%20c%200.8125%20-0.230469%201.222657%20-0.585938%201.5%20-0.875%20l%201.980469%20-1.980469%20c%200.390625%20-0.390625%200.390625%20-1.023437%200%20-1.414062%20s%20-1.023437%20-0.390625%20-1.414062%200%20l%20-2%202%20c%20-0.007813%200.003906%20-0.011719%200.011719%20-0.019531%200.019531%20c%200.113281%20-0.117188%20-0.289063%200.238281%20-0.589844%200.324219%20c%20-0.296875%200.082031%20-0.5%200.148437%20-0.964844%20-0.332031%20c%20-0.484375%20-0.5%20-0.421875%20-0.710938%20-0.347656%20-0.988282%20c%200.074218%20-0.273437%200.257812%20-0.503906%200.386718%20-0.660156%20l%203.449219%20-3.449219%20c%200.644531%20-0.644531%201.441407%20-0.644531%202.085938%200%20l%202.5%202.5%20c%200.644531%200.644531%200.644531%201.441407%200%202.085938%20l%20-6%206%20s%20-0.183594%200.183593%20-0.472657%200.375%20c%20-0.289062%200.191406%20-0.652343%200.332031%20-0.820312%200.332031%20h%20-3%20c%20-0.167969%200%20-0.449219%20-0.113281%20-0.667969%20-0.332031%20s%20-0.332031%20-0.5%20-0.332031%20-0.667969%20v%20-4%20c%200%20-0.550781%20-0.449219%20-1%20-1%20-1%20s%20-1%200.449219%20-1%201%20v%204%20c%200%200.832031%200.386719%201.550781%200.917969%202.082031%20s%201.25%200.917969%202.082031%200.917969%20h%203%20c%200.832031%200%201.46875%20-0.359375%201.929688%20-0.667969%20c%200.460937%20-0.308593%200.777343%20-0.625%200.777343%20-0.625%20l%206%20-6%20c%201.355469%20-1.355469%201.355469%20-3.558593%200%20-4.914062%20l%20-2.5%20-2.5%20c%20-0.675781%20-0.675781%20-1.566406%20-1.015625%20-2.457031%20-1.015625%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,mic:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%208%200%20c%20-1.660156%200%20-3%201.339844%20-3%203%20v%205%20c%200%201.660156%201.339844%203%203%203%20s%203%20-1.339844%203%20-3%20v%20-5%20c%200%20-1.660156%20-1.339844%20-3%20-3%20-3%20z%20m%20-6%206%20v%202.011719%20c%200%202.964843%202.164062%205.429687%205%205.90625%20v%202.082031%20h%202%20v%20-2.082031%20c%202.835938%20-0.476563%205%20-2.941407%205%20-5.90625%20v%20-2.011719%20h%20-1.5%20v%202.011719%20c%200%202.5%20-1.992188%204.488281%20-4.5%204.488281%20s%20-4.5%20-1.988281%20-4.5%20-4.488281%20v%20-2.011719%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,smile:`data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%20width='16'%20height='16'%3e%3cpath%20d='M8%201a7%207%200%20100%2014A7%207%200%20008%201zM6%205c.559%200%201.031.473%201.031%201.031V7c0%20.558-.472%201-1.03%201-.56%200-1-.442-1-1v-.969C5%205.473%205.44%205%206%205zm4%200c.559%200%201%20.473%201%201.031V7c0%20.558-.441%201-1%201-.558%200-1-.442-1-1v-.969C9%205.473%209.442%205%2010%205zM3%209.07c.997.637%204.017.917%205%20.917.984%200%203.805.051%205-.917v.5c0%20.68-1.744%201.404-5%201.404-3.256%200-5-.872-5-1.404z'%20fill='%23474747'/%3e%3c/svg%3e`,settings:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%2013.855469%200%20l%20-1.539063%201.4375%20c%20-0.453125%200.421875%20-0.53125%201.148438%20-0.269531%201.707031%20l%20-5.886719%205.996094%20c%20-0.011718%200%20-0.019531%200%20-0.03125%200%20c%20-0.257812%20-0.128906%20-0.550781%20-0.183594%20-0.839844%20-0.148437%20c%20-0.328124%200.046874%20-0.632812%200.199218%20-0.867187%200.441406%20l%20-3.945313%203.996094%20c%20-0.3906245%200.375%20-0.5468745%200.933593%20-0.4062495%201.457031%20c%200.1406255%200.523437%200.5546875%200.929687%201.0820315%201.058593%20c%200.527344%200.132813%201.082031%20-0.03125%201.453125%20-0.425781%20l%203.945312%20-3.996093%20c%200.472657%20-0.453126%200.59375%20-1.15625%200.296875%20-1.738282%20l%205.890625%20-5.964844%20c%200.558594%200.25%201.273438%200.148438%201.707031%20-0.289062%20l%201.414063%20-1.5625%20z%20m%20-10.308594%200.0898438%20c%20-0.398437%200%20-0.785156%200.0937502%20-1.140625%200.2187502%20l%201.882812%201.878906%20c%200.390626%200.382812%200.390626%201%200%201.386719%20l%20-0.710937%200.707031%20c%20-0.386719%200.386719%20-1%200.386719%20-1.390625%200%20l%20-1.882812%20-1.878906%20c%20-0.125%200.355468%20-0.2187505%200.742187%20-0.2187505%201.140625%20c%200%201.90625%201.5507815%203.453125%203.4609375%203.453125%20c%200.402344%200%200.789063%20-0.09375%201.144531%20-0.21875%20l%201.175782%201.171875%20h%200.058593%20l%202.070313%20-2.0625%20l%20-1.203125%20-1.203125%20c%200.125%20-0.359375%200.214843%20-0.742188%200.214843%20-1.140625%20c%200%20-1.90625%20-1.546874%20-3.4531252%20-3.460937%20-3.4531252%20z%20m%206.550781%207.8906252%20l%20-2.070312%202.066406%20c%200.011718%200.027344%200.023437%200.058594%200.03125%200.089844%20l%201.144531%201.140625%20c%20-0.125%200.355468%20-0.21875%200.742187%20-0.21875%201.140625%20c%200%201.902343%201.550781%203.449219%203.460937%203.449219%20c%200.433594%200%200.855469%20-0.101563%201.238282%20-0.246094%20l%20-2.007813%20-2%20c%20-0.386719%20-0.386719%20-0.386719%20-1.035156%200%20-1.417969%20l%200.679688%20-0.679687%20c%200.195312%20-0.191407%200.457031%20-0.308594%200.710937%20-0.308594%20s%200.515625%200.117187%200.710938%200.308594%20l%201.945312%201.941406%20c%200.105469%20-0.328125%200.183594%20-0.683594%200.183594%20-1.046875%20c%200%20-1.90625%20-1.546875%20-3.453125%20-3.460938%20-3.453125%20c%20-0.398437%200%20-0.785156%200.09375%20-1.140624%200.21875%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,logout:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cg%20fill='%232e3436'%3e%3cpath%20d='m%2013%205%20v%200.003906%20c%200.265625%200%200.519531%200.105469%200.707031%200.289063%20l%202%202%20c%200.390625%200.390625%200.390625%201.023437%200%201.414062%20l%20-2%202%20c%20-0.1875%200.183594%20-0.441406%200.289063%20-0.707031%200.285157%20v%200.007812%20h%20-1%20v%20-2%20h%20-5%20c%20-0.550781%200%20-1%20-0.449219%20-1%20-1%20s%200.449219%20-1%201%20-1%20h%205%20v%20-2%20z%20m%200%200'/%3e%3cpath%20d='m%209.179688%201.097656%20c%20-2.394532%20-0.40625%20-4.910157%200.453125%20-6.546876%202.398438%20c%20-2.175781%202.597656%20-2.175781%206.40625%200%209%20c%202.179688%202.597656%205.929688%203.257812%208.863282%201.5625%20c%200.230468%20-0.132813%200.398437%20-0.351563%200.46875%20-0.605469%20c%200.066406%20-0.257813%200.03125%20-0.53125%20-0.101563%20-0.761719%20c%20-0.277343%20-0.476562%20-0.886719%20-0.640625%20-1.367187%20-0.363281%20c%20-2.105469%201.214844%20-4.765625%200.75%20-6.328125%20-1.117187%20c%20-1.5625%20-1.863282%20-1.5625%20-4.5625%200%20-6.429688%20c%201.5625%20-1.863281%204.222656%20-2.332031%206.328125%20-1.113281%20c%200.480468%200.273437%201.089844%200.113281%201.367187%20-0.367188%20c%200.132813%20-0.226562%200.167969%20-0.5%200.101563%20-0.757812%20c%20-0.070313%20-0.257813%20-0.238282%20-0.476563%20-0.46875%20-0.609375%20c%20-0.730469%20-0.421875%20-1.515625%20-0.699219%20-2.316406%20-0.835938%20z%20m%200%200'/%3e%3c/g%3e%3c/svg%3e`,pin:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%205%200%20c%20-0.550781%200%20-1%200.449219%20-1%201%20s%200.449219%201%201%201%20h%200.140625%20l%200.515625%203.59375%20c%20-1.632812%200.867188%20-2.652344%202.558594%20-2.65625%204.40625%20h%2010%20c%20-0.003906%20-1.847656%20-1.023438%20-3.539062%20-2.65625%20-4.40625%20l%200.511719%20-3.59375%20h%200.144531%20c%200.550781%200%201%20-0.449219%201%20-1%20c%200%20-0.265625%20-0.105469%20-0.519531%20-0.292969%20-0.707031%20s%20-0.441406%20-0.292969%20-0.707031%20-0.292969%20z%20m%202%2011%20v%204%20l%201%201%20l%201%20-1%20v%20-4%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,back:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%2012%202%20c%200%20-0.265625%20-0.105469%20-0.519531%20-0.292969%20-0.707031%20c%20-0.390625%20-0.390625%20-1.023437%20-0.390625%20-1.414062%200%20l%20-6%206%20c%20-0.1875%200.1875%20-0.292969%200.441406%20-0.292969%200.707031%20s%200.105469%200.519531%200.292969%200.707031%20l%206%206%20c%200.390625%200.390625%201.023437%200.390625%201.414062%200%20c%200.1875%20-0.1875%200.292969%20-0.441406%200.292969%20-0.707031%20s%20-0.105469%20-0.519531%20-0.292969%20-0.707031%20l%20-5.292969%20-5.292969%20l%205.292969%20-5.292969%20c%200.1875%20-0.1875%200.292969%20-0.441406%200.292969%20-0.707031%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,close:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%204%204%20h%201%20h%200.03125%20c%200.253906%200.011719%200.511719%200.128906%200.6875%200.3125%20l%202.28125%202.28125%20l%202.3125%20-2.28125%20c%200.265625%20-0.230469%200.445312%20-0.304688%200.6875%20-0.3125%20h%201%20v%201%20c%200%200.285156%20-0.035156%200.550781%20-0.25%200.75%20l%20-2.28125%202.28125%20l%202.25%202.25%20c%200.1875%200.1875%200.28125%200.453125%200.28125%200.71875%20v%201%20h%20-1%20c%20-0.265625%200%20-0.53125%20-0.09375%20-0.71875%20-0.28125%20l%20-2.28125%20-2.28125%20l%20-2.28125%202.28125%20c%20-0.1875%200.1875%20-0.453125%200.28125%20-0.71875%200.28125%20h%20-1%20v%20-1%20c%200%20-0.265625%200.09375%20-0.53125%200.28125%20-0.71875%20l%202.28125%20-2.25%20l%20-2.28125%20-2.28125%20c%20-0.210938%20-0.195312%20-0.304688%20-0.46875%20-0.28125%20-0.75%20z%20m%200%200'%20fill='%232e3436'/%3e%3c/svg%3e`,video:`data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'?%3e%3csvg%20height='16px'%20viewBox='0%200%2016%2016'%20width='16px'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='m%207%203.003906%20c%20-1.644531%200%20-3%201.355469%20-3%203%20v%201.425782%20l%20-3.320312%20-3.433594%20h%20-0.679688%20v%209%20h%200.644531%20l%203.355469%20-3.492188%20v%201.5%20c%200%201.644532%201.355469%203%203%203%20h%206%20c%201.644531%200%203%20-1.355468%203%20-3%20v%20-5%20c%200%20-1.644531%20-1.355469%20-3%20-3%20-3%20z%20m%200%202%20h%206%20c%200.570312%200%201%200.429688%201%201%20v%205%20c%200%200.570313%20-0.429688%201%20-1%201%20h%20-6%20c%20-0.570312%200%20-1%20-0.429687%20-1%20-1%20v%20-5%20c%200%20-0.570312%200.429688%20-1%201%20-1%20z%20m%200%200'%20fill='%232e3434'/%3e%3c/svg%3e`},C={plus:`M8 3v10M3 8h10`,search:`M10.8 10.8l3.7 3.7M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0`,send:`M8 14.5v-13M2.5 7l5.5-5.5L13.5 7`,attach:`m6 10 5-5a2 2 0 0 1 3 3l-6 6a4 4 0 0 1-6-6l6-6`,mic:`M6 3a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0V3ZM3 7v1a5 5 0 0 0 10 0V7M8 13v2M5 15h6`,smile:`M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM5 6h.01M11 6h.01M5 10q3 4 6 0`,settings:`M3 3h10v10H3V3ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0`,logout:`M6 2H2v12h4M5 8h10m-4-4 4 4-4 4`,pin:`m5 2 6 0-1 5 3 3H3l3-3-1-5ZM8 10v5`,back:`m10 3-5 5 5 5`,close:`m4 4 8 8M12 4l-8 8`,more:`M3 8h.01M8 8h.01M13 8h.01`,video:`M2 4h8v8H2V4Zm8 3 4-2v6l-4-2`,arrow:`m5 3 6 5-6 5`,bold:`M5 2h4a3 3 0 0 1 0 6H5V2Zm0 6h5a3 3 0 0 1 0 6H5V8`,italic:`M7 2h6M3 14h6M10 2 6 14`,quote:`M2 4h5v5H3l-1 4M9 4h5v5h-4l-1 4`,code:`m5 4-4 4 4 4m6-8 4 4-4 4`,star:`m8 1 2 4 5 .8-3.5 3.5.9 5L8 12l-4.4 2.3.9-5L1 5.8 6 5l2-4`};function w(e){if(S[e]){let t=document.createElement(`span`);return t.className=`symbolic-icon`,t.style.maskImage=`url(`+JSON.stringify(S[e])+`)`,t.setAttribute(`aria-hidden`,`true`),t}let t=document.createElementNS(`http://www.w3.org/2000/svg`,`svg`);t.setAttribute(`viewBox`,`0 0 16 16`),t.setAttribute(`aria-hidden`,`true`);let n=document.createElementNS(t.namespaceURI,`path`);n.setAttribute(`d`,C[e]||C.more);for(let[e,t]of Object.entries({fill:`none`,stroke:`currentColor`,"stroke-width":`1.6`,"stroke-linecap":`round`,"stroke-linejoin":`round`}))n.setAttribute(e,t);return t.append(n),t}function T(e,t,n,r=`flat`){let i=g(``,n,r);return i.title=t,i.setAttribute(`aria-label`,t),i.append(w(e)),i}var ee={connect:[`Connect`,`Connexion`],server:[`Server`,`Serveur`],username:[`Username or email`,`Identifiant ou email`],password:[`Password`,`Mot de passe`],login:[`Sign in`,`Se connecter`],code:[`Verification code`,`Code de vérification`],verify:[`Verify`,`Vérifier`],cancel:[`Cancel`,`Annuler`],logout:[`Sign out`,`Se déconnecter`],add:[`Add`,`Ajouter`],unread:[`Unread`,`Non lus`],favorites:[`Favourites`,`Favoris`],channels:[`Channels`,`Salons`],direct:[`Direct messages`,`Messages directs`],new:[`New conversation`,`Nouvelle conversation`],send:[`Send`,`Envoyer`],message:[`Write a message…`,`Écrire un message…`],settings:[`Settings`,`Paramètres`],search:[`Search`,`Rechercher`],pins:[`Pinned messages`,`Messages épinglés`],stars:[`Starred messages`,`Messages favoris`],thread:[`Thread`,`Fil de discussion`],reply:[`Reply in thread`,`Répondre dans un fil`],quote:[`Quote`,`Citer`],edit:[`Edit`,`Modifier`],delete:[`Delete`,`Supprimer`],save:[`Save`,`Enregistrer`],retry:[`Retry`,`Réessayer`],pin:[`Pin`,`Épingler`],unpin:[`Unpin`,`Désépingler`],star:[`Star`,`Ajouter aux favoris`],unstar:[`Unstar`,`Retirer des favoris`],react:[`React`,`Réagir`],copy:[`Copy text`,`Copier le texte`],loading:[`Loading…`,`Chargement…`],empty:[`Your conversations, a little brighter`,`Vos conversations, un peu plus lumineuses`],emptyHint:[`Choose a conversation to start chatting.`,`Choisissez une conversation pour discuter.`],encrypted:[`Encrypted conversation`,`Conversation chiffrée`],encryptedHint:[`Encrypted conversations are not supported in the web client. Open this conversation in the desktop or mobile app.`,`Les conversations chiffrées ne sont pas prises en charge sur le web. Ouvrez cette conversation dans l’application desktop ou mobile.`],online:[`Connected`,`Connecté`],connecting:[`Connecting`,`Connexion`],offline:[`Offline`,`Hors ligne`],profile:[`Profile`,`Profil`],appearance:[`Appearance`,`Apparence`],security:[`Security`,`Sécurité`],notifications:[`Notifications`,`Notifications`],sessions:[`Devices and sessions`,`Appareils et sessions`],language:[`Language`,`Langue`],name:[`Display name`,`Nom affiché`],bio:[`About me`,`À propos de moi`],status:[`Status`,`Statut`],statusText:[`Status message`,`Message de statut`],people:[`People`,`Personnes`],rooms:[`Rooms`,`Salons`],create:[`Create`,`Créer`],join:[`Join`,`Rejoindre`],private:[`Private room`,`Salon privé`],topic:[`Topic`,`Sujet`],description:[`Description`,`Description`],announcement:[`Announcement`,`Annonce`],members:[`Members`,`Membres`],leave:[`Leave conversation`,`Quitter la conversation`],download:[`Download`,`Télécharger`],attach:[`Attach a file`,`Joindre un fichier`],voice:[`Record a voice message`,`Enregistrer un message vocal`],stop:[`Stop recording`,`Arrêter l’enregistrement`],older:[`Load older messages`,`Charger les messages précédents`],all:[`All messages`,`Tous les messages`],mention:[`Mentions only`,`Mentions seulement`],nothing:[`None`,`Aucune`],notificationsEnable:[`Enable browser notifications`,`Activer les notifications du navigateur`],failed:[`Not sent`,`Non envoyé`],pending:[`Sending…`,`Envoi…`],size:[`Text size`,`Taille du texte`],clock:[`24-hour clock`,`Horloge sur 24 heures`],roomInfo:[`Room information`,`Informations du salon`],details:[`Details`,`Détails`],close:[`Close`,`Fermer`],reconnect:[`Reconnect`,`Reconnecter`],admin:[`Administration`,`Administration`],general:[`Overview`,`Vue d’ensemble`],reports:[`Reports`,`Signalements`],readOnly:[`This conversation is read-only.`,`Cette conversation est en lecture seule.`],signup:[`Create an account`,`Créer un compte`],invitation:[`Invitation code`,`Code d’invitation`],recovery:[`Recover my account`,`Récupérer mon compte`],recoveryCode:[`Recovery code`,`Code de récupération`],noResults:[`No results`,`Aucun résultat`],email:[`Email`,`Email`],totp:[`Authenticator`,`Application d’authentification`],recovery_code:[`Recovery code`,`Code de récupération`],markRead:[`Mark as read`,`Marquer comme lu`],today:[`Today`,`Aujourd’hui`],yesterday:[`Yesterday`,`Hier`],newMessages:[`New messages`,`Nouveaux messages`],slogan:[`A little magic in your conversations`,`Un peu de magie dans vos conversations`]},E=localStorage.getItem(`rv-language`)||(navigator.language.startsWith(`fr`)?`fr`:`en`);function D(e){E=e===`fr`?`fr`:`en`,localStorage.setItem(`rv-language`,E),document.documentElement.lang=E}var O=e=>ee[e][+(E===`fr`)];function k(e){let t=e.system;if(!t)return e.text;let n=e.author.display_name||e.author.username,r={room_created:[`created the room`,`a créé le salon`],room_renamed:[`renamed the room`,`a renommé le salon`],topic_changed:[`changed the topic`,`a modifié le sujet`],description_changed:[`changed the description`,`a modifié la description`],announcement_changed:[`changed the announcement`,`a modifié l’annonce`],privacy_changed:[`changed the room privacy`,`a modifié la confidentialité du salon`],read_only_changed:[`changed read-only mode`,`a modifié le mode lecture seule`],member_joined:[`joined the room`,`a rejoint le salon`],member_left:[`left the room`,`a quitté le salon`],member_added:[`added`,`a ajouté`],member_removed:[`removed`,`a retiré`],role_changed:[`changed the role of`,`a modifié le rôle de`],call_started:[`started a call`,`a lancé un appel`]},i=``;return`user`in t&&(i=` `+(t.user.display_name||t.user.username)),`name`in t&&(i=` `+t.name),`topic`in t&&(i=`: `+t.topic),`role`in t&&(i+=` (`+t.role+`)`),n+` `+(r[t.kind]?.[+(E===`fr`)]||t.kind)+i}function A(e){return e.map(e=>`children`in e?A(e.children):`text`in e?e.text:`name`in e?e.name:e.kind===`emoji`?`:`+e.shortcode+`:`:e.kind===`break`?` `:``).join(``)}var te=e=>e.system?k(e):e.body?A(e.body.nodes):e.text;function ne(e){let t=/^\/(\w+)(?:\s+([\s\S]*))?$/.exec(e.trim());if(!t)return e;let n=t[1],r=(t[2]||``).trim(),i={gimme:`༼ つ ◕_◕ ༽つ`,lennyface:`( ͡° ͜ʖ ͡°)`,shrug:`¯\\_(ツ)_/¯`,tableflip:`(╯°□°）╯︵ ┻━┻`,unflip:`┬─┬ ノ( ゜-゜ノ)`};if(n===`me`)return r?`_`+r+`_`:``;if(n===`gimme`)return[i[n],r].filter(Boolean).join(` `);if(i[n])return[r,i[n]].filter(Boolean).join(` `)}var re=`grinning	1f600	people	+
grinning_face	1f600	-	-
smiley	1f603	people	+
smile	1f604	people	+
grin	1f601	people	+
laughing	1f606	people	+
satisfied	1f606	-	+
face_holding_back_tears	1f979	people	-
sweat_smile	1f605	people	+
joy	1f602	people	+
rofl	1f923	people	+
rolling_on_the_floor_laughing	1f923	-	+
smiling_face_with_tear	1f972	people	-
relaxed	263a-fe0f	people	+
smiling_face	263a-fe0f	-	-
blush	1f60a	people	+
innocent	1f607	people	+
slight_smile	1f642	people	+
slightly_smiling_face	1f642	-	+
upside_down	1f643	people	+
upside_down_face	1f643	-	+
wink	1f609	people	+
winking_face	1f609	-	-
relieved	1f60c	people	+
relieved_face	1f60c	-	-
heart_eyes	1f60d	people	+
smiling_face_with_3_hearts	1f970	people	+
kissing_heart	1f618	people	+
kissing	1f617	people	+
kissing_face	1f617	-	-
kissing_smiling_eyes	1f619	people	+
kissing_closed_eyes	1f61a	people	+
yum	1f60b	people	+
stuck_out_tongue	1f61b	people	+
stuck_out_tongue_closed_eyes	1f61d	people	+
stuck_out_tongue_winking_eye	1f61c	people	+
zany_face	1f92a	people	+
face_with_raised_eyebrow	1f928	people	+
face_with_monocle	1f9d0	people	+
nerd	1f913	people	+
nerd_face	1f913	-	+
sunglasses	1f60e	people	+
disguised_face	1f978	people	-
star_struck	1f929	people	+
partying_face	1f973	people	+
head_shaking_vertically	1f642-200d-2195-fe0f	people	-
smirk	1f60f	people	+
smirking_face	1f60f	-	-
unamused	1f612	people	+
unamused_face	1f612	-	-
head_shaking_horizontally	1f642-200d-2194-fe0f	people	-
disappointed	1f61e	people	+
pensive	1f614	people	+
pensive_face	1f614	-	-
worried	1f61f	people	+
worried_face	1f61f	-	-
confused	1f615	people	+
confused_face	1f615	-	-
slight_frown	1f641	people	+
slightly_frowning_face	1f641	-	+
frowning2	2639-fe0f	people	+
white_frowning_face	2639-fe0f	-	+
frowning_face	2639-fe0f	-	-
persevere	1f623	people	+
confounded	1f616	people	+
tired_face	1f62b	people	+
weary	1f629	people	+
weary_face	1f629	-	-
pleading_face	1f97a	people	+
cry	1f622	people	+
crying_face	1f622	-	-
sob	1f62d	people	+
triumph	1f624	people	+
angry	1f620	people	+
angry_face	1f620	-	-
rage	1f621	people	+
pouting_face	1f621	-	-
face_with_symbols_over_mouth	1f92c	people	+
exploding_head	1f92f	people	+
flushed	1f633	people	+
flushed_face	1f633	-	-
hot_face	1f975	people	+
cold_face	1f976	people	+
face_in_clouds	1f636-200d-1f32b-fe0f	people	-
scream	1f631	people	+
fearful	1f628	people	+
fearful_face	1f628	-	-
cold_sweat	1f630	people	+
disappointed_relieved	1f625	people	+
sweat	1f613	people	+
hugging	1f917	people	+
hugging_face	1f917	-	+
thinking	1f914	people	+
thinking_face	1f914	-	+
face_with_peeking_eye	1fae3	people	-
face_with_hand_over_mouth	1f92d	people	+
face_with_open_eyes_and_hand_over_mouth	1fae2	people	-
saluting_face	1fae1	people	-
shushing_face	1f92b	people	+
melting_face	1fae0	people	-
lying_face	1f925	people	+
liar	1f925	-	+
no_mouth	1f636	people	+
dotted_line_face	1fae5	people	-
neutral_face	1f610	people	+
face_with_diagonal_mouth	1fae4	people	-
expressionless	1f611	people	+
shaking_face	1fae8	people	-
grimacing	1f62c	people	+
rolling_eyes	1f644	people	+
face_with_rolling_eyes	1f644	-	+
hushed	1f62f	people	+
hushed_face	1f62f	-	-
frowning	1f626	people	+
anguished	1f627	people	+
open_mouth	1f62e	people	+
astonished	1f632	people	+
yawning_face	1f971	people	-
face_with_bags_under_eyes	1fae9	people	-
sleeping	1f634	people	+
sleeping_face	1f634	-	-
drooling_face	1f924	people	+
drool	1f924	-	+
sleepy	1f62a	people	+
sleepy_face	1f62a	-	-
face_exhaling	1f62e-200d-1f4a8	people	-
dizzy_face	1f635	people	+
face_with_spiral_eyes	1f635-200d-1f4ab	people	-
zipper_mouth	1f910	people	+
zipper_mouth_face	1f910	-	+
woozy_face	1f974	people	+
nauseated_face	1f922	people	+
sick	1f922	-	+
face_vomiting	1f92e	people	+
sneezing_face	1f927	people	+
sneeze	1f927	-	+
mask	1f637	people	+
thermometer_face	1f912	people	+
face_with_thermometer	1f912	-	+
head_bandage	1f915	people	+
face_with_head_bandage	1f915	-	+
money_mouth	1f911	people	+
money_mouth_face	1f911	-	+
cowboy	1f920	people	+
face_with_cowboy_hat	1f920	-	+
smiling_imp	1f608	people	+
imp	1f47f	people	+
japanese_ogre	1f479	people	+
ogre	1f479	-	-
japanese_goblin	1f47a	people	+
goblin	1f47a	-	-
clown	1f921	people	+
clown_face	1f921	-	+
poop	1f4a9	people	+
shit	1f4a9	-	+
hankey	1f4a9	-	+
poo	1f4a9	-	+
pile_of_poo	1f4a9	-	-
ghost	1f47b	people	+
skull	1f480	people	+
skeleton	1f480	-	+
skull_crossbones	2620-fe0f	people	+
skull_and_crossbones	2620-fe0f	-	+
alien	1f47d	people	+
space_invader	1f47e	people	+
alien_monster	1f47e	-	-
robot	1f916	people	+
robot_face	1f916	-	+
jack_o_lantern	1f383	people	+
smiley_cat	1f63a	people	+
grinning_cat	1f63a	-	-
smile_cat	1f638	people	+
joy_cat	1f639	people	+
heart_eyes_cat	1f63b	people	+
smirk_cat	1f63c	people	+
kissing_cat	1f63d	people	+
scream_cat	1f640	people	+
weary_cat	1f640	-	-
crying_cat_face	1f63f	people	+
crying_cat	1f63f	-	-
pouting_cat	1f63e	people	+
heart_hands	1faf6	people	-
heart_hands_tone1	1faf6-1f3fb	-	-
heart_hands_light_skin_tone	1faf6-1f3fb	-	-
heart_hands_tone2	1faf6-1f3fc	-	-
heart_hands_medium_light_skin_tone	1faf6-1f3fc	-	-
heart_hands_tone3	1faf6-1f3fd	-	-
heart_hands_medium_skin_tone	1faf6-1f3fd	-	-
heart_hands_tone4	1faf6-1f3fe	-	-
heart_hands_medium_dark_skin_tone	1faf6-1f3fe	-	-
heart_hands_tone5	1faf6-1f3ff	-	-
heart_hands_dark_skin_tone	1faf6-1f3ff	-	-
palms_up_together	1f932	people	+
palms_up_together_tone1	1f932-1f3fb	-	+
palms_up_together_light_skin_tone	1f932-1f3fb	-	+
palms_up_together_tone2	1f932-1f3fc	-	+
palms_up_together_medium_light_skin_tone	1f932-1f3fc	-	+
palms_up_together_tone3	1f932-1f3fd	-	+
palms_up_together_medium_skin_tone	1f932-1f3fd	-	+
palms_up_together_tone4	1f932-1f3fe	-	+
palms_up_together_medium_dark_skin_tone	1f932-1f3fe	-	+
palms_up_together_tone5	1f932-1f3ff	-	+
palms_up_together_dark_skin_tone	1f932-1f3ff	-	+
open_hands	1f450	people	+
open_hands_tone1	1f450-1f3fb	-	+
open_hands_tone2	1f450-1f3fc	-	+
open_hands_tone3	1f450-1f3fd	-	+
open_hands_tone4	1f450-1f3fe	-	+
open_hands_tone5	1f450-1f3ff	-	+
raised_hands	1f64c	people	+
raising_hands	1f64c	-	-
raised_hands_tone1	1f64c-1f3fb	-	+
raised_hands_tone2	1f64c-1f3fc	-	+
raised_hands_tone3	1f64c-1f3fd	-	+
raised_hands_tone4	1f64c-1f3fe	-	+
raised_hands_tone5	1f64c-1f3ff	-	+
clap	1f44f	people	+
clap_tone1	1f44f-1f3fb	-	+
clap_tone2	1f44f-1f3fc	-	+
clap_tone3	1f44f-1f3fd	-	+
clap_tone4	1f44f-1f3fe	-	+
clap_tone5	1f44f-1f3ff	-	+
handshake	1f91d	people	+
shaking_hands	1f91d	-	+
handshake_tone1	1f91d-1f3fb	-	-
handshake_light_skin_tone	1f91d-1f3fb	-	-
handshake_tone1_tone2	1faf1-1f3fb-200d-1faf2-1f3fc	-	-
handshake_light_skin_tone_medium_light_skin_tone	1faf1-1f3fb-200d-1faf2-1f3fc	-	-
handshake_tone1_tone3	1faf1-1f3fb-200d-1faf2-1f3fd	-	-
handshake_light_skin_tone_medium_skin_tone	1faf1-1f3fb-200d-1faf2-1f3fd	-	-
handshake_tone1_tone4	1faf1-1f3fb-200d-1faf2-1f3fe	-	-
handshake_light_skin_tone_medium_dark_skin_tone	1faf1-1f3fb-200d-1faf2-1f3fe	-	-
handshake_tone1_tone5	1faf1-1f3fb-200d-1faf2-1f3ff	-	-
handshake_light_skin_tone_dark_skin_tone	1faf1-1f3fb-200d-1faf2-1f3ff	-	-
handshake_tone2_tone1	1faf1-1f3fc-200d-1faf2-1f3fb	-	-
handshake_medium_light_skin_tone_light_skin_tone	1faf1-1f3fc-200d-1faf2-1f3fb	-	-
handshake_tone2	1f91d-1f3fc	-	-
handshake_medium_light_skin_tone	1f91d-1f3fc	-	-
handshake_tone2_tone3	1faf1-1f3fc-200d-1faf2-1f3fd	-	-
handshake_medium_light_skin_tone_medium_skin_tone	1faf1-1f3fc-200d-1faf2-1f3fd	-	-
handshake_tone2_tone4	1faf1-1f3fc-200d-1faf2-1f3fe	-	-
handshake_medium_light_skin_tone_medium_dark_skin_tone	1faf1-1f3fc-200d-1faf2-1f3fe	-	-
handshake_tone2_tone5	1faf1-1f3fc-200d-1faf2-1f3ff	-	-
handshake_medium_light_skin_tone_dark_skin_tone	1faf1-1f3fc-200d-1faf2-1f3ff	-	-
handshake_tone3_tone1	1faf1-1f3fd-200d-1faf2-1f3fb	-	-
handshake_medium_skin_tone_light_skin_tone	1faf1-1f3fd-200d-1faf2-1f3fb	-	-
handshake_tone3_tone2	1faf1-1f3fd-200d-1faf2-1f3fc	-	-
handshake_medium_skin_tone_medium_light_skin_tone	1faf1-1f3fd-200d-1faf2-1f3fc	-	-
handshake_tone3	1f91d-1f3fd	-	-
handshake_medium_skin_tone	1f91d-1f3fd	-	-
handshake_tone3_tone4	1faf1-1f3fd-200d-1faf2-1f3fe	-	-
handshake_medium_skin_tone_medium_dark_skin_tone	1faf1-1f3fd-200d-1faf2-1f3fe	-	-
handshake_tone3_tone5	1faf1-1f3fd-200d-1faf2-1f3ff	-	-
handshake_medium_skin_tone_dark_skin_tone	1faf1-1f3fd-200d-1faf2-1f3ff	-	-
handshake_tone4_tone1	1faf1-1f3fe-200d-1faf2-1f3fb	-	-
handshake_medium_dark_skin_tone_light_skin_tone	1faf1-1f3fe-200d-1faf2-1f3fb	-	-
handshake_tone4_tone2	1faf1-1f3fe-200d-1faf2-1f3fc	-	-
handshake_medium_dark_skin_tone_medium_light_skin_tone	1faf1-1f3fe-200d-1faf2-1f3fc	-	-
handshake_tone4_tone3	1faf1-1f3fe-200d-1faf2-1f3fd	-	-
handshake_medium_dark_skin_tone_medium_skin_tone	1faf1-1f3fe-200d-1faf2-1f3fd	-	-
handshake_tone4	1f91d-1f3fe	-	-
handshake_medium_dark_skin_tone	1f91d-1f3fe	-	-
handshake_tone4_tone5	1faf1-1f3fe-200d-1faf2-1f3ff	-	-
handshake_medium_dark_skin_tone_dark_skin_tone	1faf1-1f3fe-200d-1faf2-1f3ff	-	-
handshake_tone5_tone1	1faf1-1f3ff-200d-1faf2-1f3fb	-	-
handshake_dark_skin_tone_light_skin_tone	1faf1-1f3ff-200d-1faf2-1f3fb	-	-
handshake_tone5_tone2	1faf1-1f3ff-200d-1faf2-1f3fc	-	-
handshake_dark_skin_tone_medium_light_skin_tone	1faf1-1f3ff-200d-1faf2-1f3fc	-	-
handshake_tone5_tone3	1faf1-1f3ff-200d-1faf2-1f3fd	-	-
handshake_dark_skin_tone_medium_skin_tone	1faf1-1f3ff-200d-1faf2-1f3fd	-	-
handshake_tone5_tone4	1faf1-1f3ff-200d-1faf2-1f3fe	-	-
handshake_dark_skin_tone_medium_dark_skin_tone	1faf1-1f3ff-200d-1faf2-1f3fe	-	-
handshake_tone5	1f91d-1f3ff	-	-
handshake_dark_skin_tone	1f91d-1f3ff	-	-
thumbsup	1f44d	people	+
+1	1f44d	-	+
thumbup	1f44d	-	+
thumbs_up	1f44d	-	-
thumbsup_tone1	1f44d-1f3fb	-	+
+1_tone1	1f44d-1f3fb	-	+
thumbup_tone1	1f44d-1f3fb	-	+
thumbsup_tone2	1f44d-1f3fc	-	+
+1_tone2	1f44d-1f3fc	-	+
thumbup_tone2	1f44d-1f3fc	-	+
thumbsup_tone3	1f44d-1f3fd	-	+
+1_tone3	1f44d-1f3fd	-	+
thumbup_tone3	1f44d-1f3fd	-	+
thumbsup_tone4	1f44d-1f3fe	-	+
+1_tone4	1f44d-1f3fe	-	+
thumbup_tone4	1f44d-1f3fe	-	+
thumbsup_tone5	1f44d-1f3ff	-	+
+1_tone5	1f44d-1f3ff	-	+
thumbup_tone5	1f44d-1f3ff	-	+
thumbsdown	1f44e	people	+
-1	1f44e	-	+
thumbdown	1f44e	-	+
thumbs_down	1f44e	-	-
thumbsdown_tone1	1f44e-1f3fb	-	+
-1_tone1	1f44e-1f3fb	-	+
thumbdown_tone1	1f44e-1f3fb	-	+
thumbsdown_tone2	1f44e-1f3fc	-	+
-1_tone2	1f44e-1f3fc	-	+
thumbdown_tone2	1f44e-1f3fc	-	+
thumbsdown_tone3	1f44e-1f3fd	-	+
-1_tone3	1f44e-1f3fd	-	+
thumbdown_tone3	1f44e-1f3fd	-	+
thumbsdown_tone4	1f44e-1f3fe	-	+
-1_tone4	1f44e-1f3fe	-	+
thumbdown_tone4	1f44e-1f3fe	-	+
thumbsdown_tone5	1f44e-1f3ff	-	+
-1_tone5	1f44e-1f3ff	-	+
thumbdown_tone5	1f44e-1f3ff	-	+
punch	1f44a	people	+
oncoming_fist	1f44a	-	-
punch_tone1	1f44a-1f3fb	-	+
punch_tone2	1f44a-1f3fc	-	+
punch_tone3	1f44a-1f3fd	-	+
punch_tone4	1f44a-1f3fe	-	+
punch_tone5	1f44a-1f3ff	-	+
fist	270a	people	+
raised_fist	270a	-	-
fist_tone1	270a-1f3fb	-	+
fist_tone2	270a-1f3fc	-	+
fist_tone3	270a-1f3fd	-	+
fist_tone4	270a-1f3fe	-	+
fist_tone5	270a-1f3ff	-	+
left_facing_fist	1f91b	people	+
left_fist	1f91b	-	+
left_facing_fist_tone1	1f91b-1f3fb	-	+
left_fist_tone1	1f91b-1f3fb	-	+
left_facing_fist_tone2	1f91b-1f3fc	-	+
left_fist_tone2	1f91b-1f3fc	-	+
left_facing_fist_tone3	1f91b-1f3fd	-	+
left_fist_tone3	1f91b-1f3fd	-	+
left_facing_fist_tone4	1f91b-1f3fe	-	+
left_fist_tone4	1f91b-1f3fe	-	+
left_facing_fist_tone5	1f91b-1f3ff	-	+
left_fist_tone5	1f91b-1f3ff	-	+
right_facing_fist	1f91c	people	+
right_fist	1f91c	-	+
right_facing_fist_tone1	1f91c-1f3fb	-	+
right_fist_tone1	1f91c-1f3fb	-	+
right_facing_fist_tone2	1f91c-1f3fc	-	+
right_fist_tone2	1f91c-1f3fc	-	+
right_facing_fist_tone3	1f91c-1f3fd	-	+
right_fist_tone3	1f91c-1f3fd	-	+
right_facing_fist_tone4	1f91c-1f3fe	-	+
right_fist_tone4	1f91c-1f3fe	-	+
right_facing_fist_tone5	1f91c-1f3ff	-	+
right_fist_tone5	1f91c-1f3ff	-	+
leftwards_pushing_hand	1faf7	people	-
leftwards_pushing_hand_tone1	1faf7-1f3fb	-	-
leftwards_pushing_hand_light_skin_tone	1faf7-1f3fb	-	-
leftwards_pushing_hand_tone2	1faf7-1f3fc	-	-
leftwards_pushing_hand_medium_light_skin_tone	1faf7-1f3fc	-	-
leftwards_pushing_hand_tone3	1faf7-1f3fd	-	-
leftwards_pushing_hand_medium_skin_tone	1faf7-1f3fd	-	-
leftwards_pushing_hand_tone4	1faf7-1f3fe	-	-
leftwards_pushing_hand_medium_dark_skin_tone	1faf7-1f3fe	-	-
leftwards_pushing_hand_tone5	1faf7-1f3ff	-	-
leftwards_pushing_hand_dark_skin_tone	1faf7-1f3ff	-	-
rightwards_pushing_hand	1faf8	people	-
rightwards_pushing_hand_tone1	1faf8-1f3fb	-	-
rightwards_pushing_hand_light_skin_tone	1faf8-1f3fb	-	-
rightwards_pushing_hand_tone2	1faf8-1f3fc	-	-
rightwards_pushing_hand_medium_light_skin_tone	1faf8-1f3fc	-	-
rightwards_pushing_hand_tone3	1faf8-1f3fd	-	-
rightwards_pushing_hand_medium_skin_tone	1faf8-1f3fd	-	-
rightwards_pushing_hand_tone4	1faf8-1f3fe	-	-
rightwards_pushing_hand_medium_dark_skin_tone	1faf8-1f3fe	-	-
rightwards_pushing_hand_tone5	1faf8-1f3ff	-	-
rightwards_pushing_hand_dark_skin_tone	1faf8-1f3ff	-	-
fingers_crossed	1f91e	people	+
hand_with_index_and_middle_finger_crossed	1f91e	-	+
fingers_crossed_tone1	1f91e-1f3fb	-	+
hand_with_index_and_middle_fingers_crossed_tone1	1f91e-1f3fb	-	+
fingers_crossed_tone2	1f91e-1f3fc	-	+
hand_with_index_and_middle_fingers_crossed_tone2	1f91e-1f3fc	-	+
fingers_crossed_tone3	1f91e-1f3fd	-	+
hand_with_index_and_middle_fingers_crossed_tone3	1f91e-1f3fd	-	+
fingers_crossed_tone4	1f91e-1f3fe	-	+
hand_with_index_and_middle_fingers_crossed_tone4	1f91e-1f3fe	-	+
fingers_crossed_tone5	1f91e-1f3ff	-	+
hand_with_index_and_middle_fingers_crossed_tone5	1f91e-1f3ff	-	+
v	270c-fe0f	people	+
victory_hand	270c-fe0f	-	-
v_tone1	270c-1f3fb	-	+
v_tone2	270c-1f3fc	-	+
v_tone3	270c-1f3fd	-	+
v_tone4	270c-1f3fe	-	+
v_tone5	270c-1f3ff	-	+
hand_with_index_finger_and_thumb_crossed	1faf0	people	-
hand_with_index_finger_and_thumb_crossed_tone1	1faf0-1f3fb	-	-
hand_with_index_finger_and_thumb_crossed_light_skin_tone	1faf0-1f3fb	-	-
hand_with_index_finger_and_thumb_crossed_tone2	1faf0-1f3fc	-	-
hand_with_index_finger_and_thumb_crossed_medium_light_skin_tone	1faf0-1f3fc	-	-
hand_with_index_finger_and_thumb_crossed_tone3	1faf0-1f3fd	-	-
hand_with_index_finger_and_thumb_crossed_medium_skin_tone	1faf0-1f3fd	-	-
hand_with_index_finger_and_thumb_crossed_tone4	1faf0-1f3fe	-	-
hand_with_index_finger_and_thumb_crossed_medium_dark_skin_tone	1faf0-1f3fe	-	-
hand_with_index_finger_and_thumb_crossed_tone5	1faf0-1f3ff	-	-
hand_with_index_finger_and_thumb_crossed_dark_skin_tone	1faf0-1f3ff	-	-
love_you_gesture	1f91f	people	+
love_you_gesture_tone1	1f91f-1f3fb	-	+
love_you_gesture_light_skin_tone	1f91f-1f3fb	-	+
love_you_gesture_tone2	1f91f-1f3fc	-	+
love_you_gesture_medium_light_skin_tone	1f91f-1f3fc	-	+
love_you_gesture_tone3	1f91f-1f3fd	-	+
love_you_gesture_medium_skin_tone	1f91f-1f3fd	-	+
love_you_gesture_tone4	1f91f-1f3fe	-	+
love_you_gesture_medium_dark_skin_tone	1f91f-1f3fe	-	+
love_you_gesture_tone5	1f91f-1f3ff	-	+
love_you_gesture_dark_skin_tone	1f91f-1f3ff	-	+
metal	1f918	people	+
sign_of_the_horns	1f918	-	+
metal_tone1	1f918-1f3fb	-	+
sign_of_the_horns_tone1	1f918-1f3fb	-	+
metal_tone2	1f918-1f3fc	-	+
sign_of_the_horns_tone2	1f918-1f3fc	-	+
metal_tone3	1f918-1f3fd	-	+
sign_of_the_horns_tone3	1f918-1f3fd	-	+
metal_tone4	1f918-1f3fe	-	+
sign_of_the_horns_tone4	1f918-1f3fe	-	+
metal_tone5	1f918-1f3ff	-	+
sign_of_the_horns_tone5	1f918-1f3ff	-	+
ok_hand	1f44c	people	+
ok_hand_tone1	1f44c-1f3fb	-	+
ok_hand_tone2	1f44c-1f3fc	-	+
ok_hand_tone3	1f44c-1f3fd	-	+
ok_hand_tone4	1f44c-1f3fe	-	+
ok_hand_tone5	1f44c-1f3ff	-	+
pinched_fingers	1f90c	people	-
pinched_fingers_tone2	1f90c-1f3fc	-	-
pinched_fingers_medium_light_skin_tone	1f90c-1f3fc	-	-
pinched_fingers_tone1	1f90c-1f3fb	-	-
pinched_fingers_light_skin_tone	1f90c-1f3fb	-	-
pinched_fingers_tone3	1f90c-1f3fd	-	-
pinched_fingers_medium_skin_tone	1f90c-1f3fd	-	-
pinched_fingers_tone4	1f90c-1f3fe	-	-
pinched_fingers_medium_dark_skin_tone	1f90c-1f3fe	-	-
pinched_fingers_tone5	1f90c-1f3ff	-	-
pinched_fingers_dark_skin_tone	1f90c-1f3ff	-	-
pinching_hand	1f90f	people	-
pinching_hand_tone1	1f90f-1f3fb	-	-
pinching_hand_light_skin_tone	1f90f-1f3fb	-	-
pinching_hand_tone2	1f90f-1f3fc	-	-
pinching_hand_medium_light_skin_tone	1f90f-1f3fc	-	-
pinching_hand_tone3	1f90f-1f3fd	-	-
pinching_hand_medium_skin_tone	1f90f-1f3fd	-	-
pinching_hand_tone4	1f90f-1f3fe	-	-
pinching_hand_medium_dark_skin_tone	1f90f-1f3fe	-	-
pinching_hand_tone5	1f90f-1f3ff	-	-
pinching_hand_dark_skin_tone	1f90f-1f3ff	-	-
palm_down_hand	1faf3	people	-
palm_down_hand_tone1	1faf3-1f3fb	-	-
palm_down_hand_light_skin_tone	1faf3-1f3fb	-	-
palm_down_hand_tone2	1faf3-1f3fc	-	-
palm_down_hand_medium_light_skin_tone	1faf3-1f3fc	-	-
palm_down_hand_tone3	1faf3-1f3fd	-	-
palm_down_hand_medium_skin_tone	1faf3-1f3fd	-	-
palm_down_hand_tone4	1faf3-1f3fe	-	-
palm_down_hand_medium_dark_skin_tone	1faf3-1f3fe	-	-
palm_down_hand_tone5	1faf3-1f3ff	-	-
palm_down_hand_dark_skin_tone	1faf3-1f3ff	-	-
palm_up_hand	1faf4	people	-
palm_up_hand_tone1	1faf4-1f3fb	-	-
palm_up_hand_light_skin_tone	1faf4-1f3fb	-	-
palm_up_hand_tone2	1faf4-1f3fc	-	-
palm_up_hand_medium_light_skin_tone	1faf4-1f3fc	-	-
palm_up_hand_tone3	1faf4-1f3fd	-	-
palm_up_hand_medium_skin_tone	1faf4-1f3fd	-	-
palm_up_hand_tone4	1faf4-1f3fe	-	-
palm_up_hand_medium_dark_skin_tone	1faf4-1f3fe	-	-
palm_up_hand_tone5	1faf4-1f3ff	-	-
palm_up_hand_dark_skin_tone	1faf4-1f3ff	-	-
point_left	1f448	people	+
point_left_tone1	1f448-1f3fb	-	+
point_left_tone2	1f448-1f3fc	-	+
point_left_tone3	1f448-1f3fd	-	+
point_left_tone4	1f448-1f3fe	-	+
point_left_tone5	1f448-1f3ff	-	+
point_right	1f449	people	+
point_right_tone1	1f449-1f3fb	-	+
point_right_tone2	1f449-1f3fc	-	+
point_right_tone3	1f449-1f3fd	-	+
point_right_tone4	1f449-1f3fe	-	+
point_right_tone5	1f449-1f3ff	-	+
point_up_2	1f446	people	+
point_up_2_tone1	1f446-1f3fb	-	+
point_up_2_tone2	1f446-1f3fc	-	+
point_up_2_tone3	1f446-1f3fd	-	+
point_up_2_tone4	1f446-1f3fe	-	+
point_up_2_tone5	1f446-1f3ff	-	+
point_down	1f447	people	+
point_down_tone1	1f447-1f3fb	-	+
point_down_tone2	1f447-1f3fc	-	+
point_down_tone3	1f447-1f3fd	-	+
point_down_tone4	1f447-1f3fe	-	+
point_down_tone5	1f447-1f3ff	-	+
point_up	261d-fe0f	people	+
point_up_tone1	261d-1f3fb	-	+
point_up_tone2	261d-1f3fc	-	+
point_up_tone3	261d-1f3fd	-	+
point_up_tone4	261d-1f3fe	-	+
point_up_tone5	261d-1f3ff	-	+
raised_hand	270b	people	+
raised_hand_tone1	270b-1f3fb	-	+
raised_hand_tone2	270b-1f3fc	-	+
raised_hand_tone3	270b-1f3fd	-	+
raised_hand_tone4	270b-1f3fe	-	+
raised_hand_tone5	270b-1f3ff	-	+
raised_back_of_hand	1f91a	people	+
back_of_hand	1f91a	-	+
raised_back_of_hand_tone1	1f91a-1f3fb	-	+
back_of_hand_tone1	1f91a-1f3fb	-	+
raised_back_of_hand_tone2	1f91a-1f3fc	-	+
back_of_hand_tone2	1f91a-1f3fc	-	+
raised_back_of_hand_tone3	1f91a-1f3fd	-	+
back_of_hand_tone3	1f91a-1f3fd	-	+
raised_back_of_hand_tone4	1f91a-1f3fe	-	+
back_of_hand_tone4	1f91a-1f3fe	-	+
raised_back_of_hand_tone5	1f91a-1f3ff	-	+
back_of_hand_tone5	1f91a-1f3ff	-	+
hand_splayed	1f590-fe0f	people	+
raised_hand_with_fingers_splayed	1f590-fe0f	-	+
hand_splayed_tone1	1f590-1f3fb	-	+
raised_hand_with_fingers_splayed_tone1	1f590-1f3fb	-	+
hand_splayed_tone2	1f590-1f3fc	-	+
raised_hand_with_fingers_splayed_tone2	1f590-1f3fc	-	+
hand_splayed_tone3	1f590-1f3fd	-	+
raised_hand_with_fingers_splayed_tone3	1f590-1f3fd	-	+
hand_splayed_tone4	1f590-1f3fe	-	+
raised_hand_with_fingers_splayed_tone4	1f590-1f3fe	-	+
hand_splayed_tone5	1f590-1f3ff	-	+
raised_hand_with_fingers_splayed_tone5	1f590-1f3ff	-	+
vulcan	1f596	people	+
raised_hand_with_part_between_middle_and_ring_fingers	1f596	-	+
vulcan_salute	1f596	-	-
vulcan_tone1	1f596-1f3fb	-	+
raised_hand_with_part_between_middle_and_ring_fingers_tone1	1f596-1f3fb	-	+
vulcan_tone2	1f596-1f3fc	-	+
raised_hand_with_part_between_middle_and_ring_fingers_tone2	1f596-1f3fc	-	+
vulcan_tone3	1f596-1f3fd	-	+
raised_hand_with_part_between_middle_and_ring_fingers_tone3	1f596-1f3fd	-	+
vulcan_tone4	1f596-1f3fe	-	+
raised_hand_with_part_between_middle_and_ring_fingers_tone4	1f596-1f3fe	-	+
vulcan_tone5	1f596-1f3ff	-	+
raised_hand_with_part_between_middle_and_ring_fingers_tone5	1f596-1f3ff	-	+
wave	1f44b	people	+
waving_hand	1f44b	-	-
wave_tone1	1f44b-1f3fb	-	+
wave_tone2	1f44b-1f3fc	-	+
wave_tone3	1f44b-1f3fd	-	+
wave_tone4	1f44b-1f3fe	-	+
wave_tone5	1f44b-1f3ff	-	+
call_me	1f919	people	+
call_me_hand	1f919	-	+
call_me_tone1	1f919-1f3fb	-	+
call_me_hand_tone1	1f919-1f3fb	-	+
call_me_tone2	1f919-1f3fc	-	+
call_me_hand_tone2	1f919-1f3fc	-	+
call_me_tone3	1f919-1f3fd	-	+
call_me_hand_tone3	1f919-1f3fd	-	+
call_me_tone4	1f919-1f3fe	-	+
call_me_hand_tone4	1f919-1f3fe	-	+
call_me_tone5	1f919-1f3ff	-	+
call_me_hand_tone5	1f919-1f3ff	-	+
leftwards_hand	1faf2	people	-
leftwards_hand_tone1	1faf2-1f3fb	-	-
leftwards_hand_light_skin_tone	1faf2-1f3fb	-	-
leftwards_hand_tone2	1faf2-1f3fc	-	-
leftwards_hand_medium_light_skin_tone	1faf2-1f3fc	-	-
leftwards_hand_tone3	1faf2-1f3fd	-	-
leftwards_hand_medium_skin_tone	1faf2-1f3fd	-	-
leftwards_hand_tone4	1faf2-1f3fe	-	-
leftwards_hand_medium_dark_skin_tone	1faf2-1f3fe	-	-
leftwards_hand_tone5	1faf2-1f3ff	-	-
leftwards_hand_dark_skin_tone	1faf2-1f3ff	-	-
rightwards_hand	1faf1	people	-
rightwards_hand_tone1	1faf1-1f3fb	-	-
rightwards_hand_light_skin_tone	1faf1-1f3fb	-	-
rightwards_hand_tone2	1faf1-1f3fc	-	-
rightwards_hand_medium_light_skin_tone	1faf1-1f3fc	-	-
rightwards_hand_tone3	1faf1-1f3fd	-	-
rightwards_hand_medium_skin_tone	1faf1-1f3fd	-	-
rightwards_hand_tone4	1faf1-1f3fe	-	-
rightwards_hand_medium_dark_skin_tone	1faf1-1f3fe	-	-
rightwards_hand_tone5	1faf1-1f3ff	-	-
rightwards_hand_dark_skin_tone	1faf1-1f3ff	-	-
muscle	1f4aa	people	+
flexed_biceps	1f4aa	-	-
muscle_tone1	1f4aa-1f3fb	-	+
muscle_tone2	1f4aa-1f3fc	-	+
muscle_tone3	1f4aa-1f3fd	-	+
muscle_tone4	1f4aa-1f3fe	-	+
muscle_tone5	1f4aa-1f3ff	-	+
mechanical_arm	1f9be	people	-
middle_finger	1f595	people	+
reversed_hand_with_middle_finger_extended	1f595	-	+
middle_finger_tone1	1f595-1f3fb	-	+
reversed_hand_with_middle_finger_extended_tone1	1f595-1f3fb	-	+
middle_finger_tone2	1f595-1f3fc	-	+
reversed_hand_with_middle_finger_extended_tone2	1f595-1f3fc	-	+
middle_finger_tone3	1f595-1f3fd	-	+
reversed_hand_with_middle_finger_extended_tone3	1f595-1f3fd	-	+
middle_finger_tone4	1f595-1f3fe	-	+
reversed_hand_with_middle_finger_extended_tone4	1f595-1f3fe	-	+
middle_finger_tone5	1f595-1f3ff	-	+
reversed_hand_with_middle_finger_extended_tone5	1f595-1f3ff	-	+
writing_hand	270d-fe0f	people	+
writing_hand_tone1	270d-1f3fb	-	+
writing_hand_tone2	270d-1f3fc	-	+
writing_hand_tone3	270d-1f3fd	-	+
writing_hand_tone4	270d-1f3fe	-	+
writing_hand_tone5	270d-1f3ff	-	+
pray	1f64f	people	+
folded_hands	1f64f	-	-
pray_tone1	1f64f-1f3fb	-	+
pray_tone2	1f64f-1f3fc	-	+
pray_tone3	1f64f-1f3fd	-	+
pray_tone4	1f64f-1f3fe	-	+
pray_tone5	1f64f-1f3ff	-	+
index_pointing_at_the_viewer	1faf5	people	-
index_pointing_at_the_viewer_tone1	1faf5-1f3fb	-	-
index_pointing_at_the_viewer_light_skin_tone	1faf5-1f3fb	-	-
index_pointing_at_the_viewer_tone2	1faf5-1f3fc	-	-
index_pointing_at_the_viewer_medium_light_skin_tone	1faf5-1f3fc	-	-
index_pointing_at_the_viewer_tone3	1faf5-1f3fd	-	-
index_pointing_at_the_viewer_medium_skin_tone	1faf5-1f3fd	-	-
index_pointing_at_the_viewer_tone4	1faf5-1f3fe	-	-
index_pointing_at_the_viewer_medium_dark_skin_tone	1faf5-1f3fe	-	-
index_pointing_at_the_viewer_tone5	1faf5-1f3ff	-	-
index_pointing_at_the_viewer_dark_skin_tone	1faf5-1f3ff	-	-
foot	1f9b6	people	+
foot_tone1	1f9b6-1f3fb	-	+
foot_light_skin_tone	1f9b6-1f3fb	-	+
foot_tone2	1f9b6-1f3fc	-	+
foot_medium_light_skin_tone	1f9b6-1f3fc	-	+
foot_tone3	1f9b6-1f3fd	-	+
foot_medium_skin_tone	1f9b6-1f3fd	-	+
foot_tone4	1f9b6-1f3fe	-	+
foot_medium_dark_skin_tone	1f9b6-1f3fe	-	+
foot_tone5	1f9b6-1f3ff	-	+
foot_dark_skin_tone	1f9b6-1f3ff	-	+
leg	1f9b5	people	+
leg_tone1	1f9b5-1f3fb	-	+
leg_light_skin_tone	1f9b5-1f3fb	-	+
leg_tone2	1f9b5-1f3fc	-	+
leg_medium_light_skin_tone	1f9b5-1f3fc	-	+
leg_tone3	1f9b5-1f3fd	-	+
leg_medium_skin_tone	1f9b5-1f3fd	-	+
leg_tone4	1f9b5-1f3fe	-	+
leg_medium_dark_skin_tone	1f9b5-1f3fe	-	+
leg_tone5	1f9b5-1f3ff	-	+
leg_dark_skin_tone	1f9b5-1f3ff	-	+
mechanical_leg	1f9bf	people	-
lipstick	1f484	people	+
kiss	1f48b	people	+
kiss_mark	1f48b	-	-
lips	1f444	people	+
mouth	1f444	-	-
biting_lip	1fae6	people	-
tooth	1f9b7	people	+
tongue	1f445	people	+
ear	1f442	people	+
ear_tone1	1f442-1f3fb	-	+
ear_tone2	1f442-1f3fc	-	+
ear_tone3	1f442-1f3fd	-	+
ear_tone4	1f442-1f3fe	-	+
ear_tone5	1f442-1f3ff	-	+
ear_with_hearing_aid	1f9bb	people	-
ear_with_hearing_aid_tone1	1f9bb-1f3fb	-	-
ear_with_hearing_aid_light_skin_tone	1f9bb-1f3fb	-	-
ear_with_hearing_aid_tone2	1f9bb-1f3fc	-	-
ear_with_hearing_aid_medium_light_skin_tone	1f9bb-1f3fc	-	-
ear_with_hearing_aid_tone3	1f9bb-1f3fd	-	-
ear_with_hearing_aid_medium_skin_tone	1f9bb-1f3fd	-	-
ear_with_hearing_aid_tone4	1f9bb-1f3fe	-	-
ear_with_hearing_aid_medium_dark_skin_tone	1f9bb-1f3fe	-	-
ear_with_hearing_aid_tone5	1f9bb-1f3ff	-	-
ear_with_hearing_aid_dark_skin_tone	1f9bb-1f3ff	-	-
nose	1f443	people	+
nose_tone1	1f443-1f3fb	-	+
nose_tone2	1f443-1f3fc	-	+
nose_tone3	1f443-1f3fd	-	+
nose_tone4	1f443-1f3fe	-	+
nose_tone5	1f443-1f3ff	-	+
fingerprint	1fac6	people	-
footprints	1f463	people	+
eye	1f441-fe0f	people	+
eyes	1f440	people	+
anatomical_heart	1fac0	people	-
lungs	1fac1	people	-
brain	1f9e0	people	+
speaking_head	1f5e3-fe0f	people	+
speaking_head_in_silhouette	1f5e3-fe0f	-	+
bust_in_silhouette	1f464	people	+
busts_in_silhouette	1f465	people	+
people_hugging	1fac2	people	-
baby	1f476	people	+
baby_tone1	1f476-1f3fb	-	+
baby_tone2	1f476-1f3fc	-	+
baby_tone3	1f476-1f3fd	-	+
baby_tone4	1f476-1f3fe	-	+
baby_tone5	1f476-1f3ff	-	+
child	1f9d2	people	+
child_tone1	1f9d2-1f3fb	-	+
child_light_skin_tone	1f9d2-1f3fb	-	+
child_tone2	1f9d2-1f3fc	-	+
child_medium_light_skin_tone	1f9d2-1f3fc	-	+
child_tone3	1f9d2-1f3fd	-	+
child_medium_skin_tone	1f9d2-1f3fd	-	+
child_tone4	1f9d2-1f3fe	-	+
child_medium_dark_skin_tone	1f9d2-1f3fe	-	+
child_tone5	1f9d2-1f3ff	-	+
child_dark_skin_tone	1f9d2-1f3ff	-	+
girl	1f467	people	+
girl_tone1	1f467-1f3fb	-	+
girl_tone2	1f467-1f3fc	-	+
girl_tone3	1f467-1f3fd	-	+
girl_tone4	1f467-1f3fe	-	+
girl_tone5	1f467-1f3ff	-	+
boy	1f466	people	+
boy_tone1	1f466-1f3fb	-	+
boy_tone2	1f466-1f3fc	-	+
boy_tone3	1f466-1f3fd	-	+
boy_tone4	1f466-1f3fe	-	+
boy_tone5	1f466-1f3ff	-	+
adult	1f9d1	people	+
person	1f9d1	-	-
adult_tone1	1f9d1-1f3fb	-	+
adult_light_skin_tone	1f9d1-1f3fb	-	+
adult_tone2	1f9d1-1f3fc	-	+
adult_medium_light_skin_tone	1f9d1-1f3fc	-	+
adult_tone3	1f9d1-1f3fd	-	+
adult_medium_skin_tone	1f9d1-1f3fd	-	+
adult_tone4	1f9d1-1f3fe	-	+
adult_medium_dark_skin_tone	1f9d1-1f3fe	-	+
adult_tone5	1f9d1-1f3ff	-	+
adult_dark_skin_tone	1f9d1-1f3ff	-	+
woman	1f469	people	+
woman_tone1	1f469-1f3fb	-	+
woman_tone2	1f469-1f3fc	-	+
woman_tone3	1f469-1f3fd	-	+
woman_tone4	1f469-1f3fe	-	+
woman_tone5	1f469-1f3ff	-	+
man	1f468	people	+
man_tone1	1f468-1f3fb	-	+
man_tone2	1f468-1f3fc	-	+
man_tone3	1f468-1f3fd	-	+
man_tone4	1f468-1f3fe	-	+
man_tone5	1f468-1f3ff	-	+
person_curly_hair	1f9d1-200d-1f9b1	people	-
person_tone1_curly_hair	1f9d1-1f3fb-200d-1f9b1	-	-
person_light_skin_tone_curly_hair	1f9d1-1f3fb-200d-1f9b1	-	-
person_tone2_curly_hair	1f9d1-1f3fc-200d-1f9b1	-	-
person_medium_light_skin_tone_curly_hair	1f9d1-1f3fc-200d-1f9b1	-	-
person_tone3_curly_hair	1f9d1-1f3fd-200d-1f9b1	-	-
person_medium_skin_tone_curly_hair	1f9d1-1f3fd-200d-1f9b1	-	-
person_tone4_curly_hair	1f9d1-1f3fe-200d-1f9b1	-	-
person_medium_dark_skin_tone_curly_hair	1f9d1-1f3fe-200d-1f9b1	-	-
person_tone5_curly_hair	1f9d1-1f3ff-200d-1f9b1	-	-
person_dark_skin_tone_curly_hair	1f9d1-1f3ff-200d-1f9b1	-	-
woman_curly_haired	1f469-200d-1f9b1	people	+
woman_curly_haired_tone1	1f469-1f3fb-200d-1f9b1	-	+
woman_curly_haired_light_skin_tone	1f469-1f3fb-200d-1f9b1	-	+
woman_curly_haired_tone2	1f469-1f3fc-200d-1f9b1	-	+
woman_curly_haired_medium_light_skin_tone	1f469-1f3fc-200d-1f9b1	-	+
woman_curly_haired_tone3	1f469-1f3fd-200d-1f9b1	-	+
woman_curly_haired_medium_skin_tone	1f469-1f3fd-200d-1f9b1	-	+
woman_curly_haired_tone4	1f469-1f3fe-200d-1f9b1	-	+
woman_curly_haired_medium_dark_skin_tone	1f469-1f3fe-200d-1f9b1	-	+
woman_curly_haired_tone5	1f469-1f3ff-200d-1f9b1	-	+
woman_curly_haired_dark_skin_tone	1f469-1f3ff-200d-1f9b1	-	+
man_curly_haired	1f468-200d-1f9b1	people	+
man_curly_haired_tone1	1f468-1f3fb-200d-1f9b1	-	+
man_curly_haired_light_skin_tone	1f468-1f3fb-200d-1f9b1	-	+
man_curly_haired_tone2	1f468-1f3fc-200d-1f9b1	-	+
man_curly_haired_medium_light_skin_tone	1f468-1f3fc-200d-1f9b1	-	+
man_curly_haired_tone3	1f468-1f3fd-200d-1f9b1	-	+
man_curly_haired_medium_skin_tone	1f468-1f3fd-200d-1f9b1	-	+
man_curly_haired_tone4	1f468-1f3fe-200d-1f9b1	-	+
man_curly_haired_medium_dark_skin_tone	1f468-1f3fe-200d-1f9b1	-	+
man_curly_haired_tone5	1f468-1f3ff-200d-1f9b1	-	+
man_curly_haired_dark_skin_tone	1f468-1f3ff-200d-1f9b1	-	+
person_red_hair	1f9d1-200d-1f9b0	people	-
person_tone1_red_hair	1f9d1-1f3fb-200d-1f9b0	-	-
person_light_skin_tone_red_hair	1f9d1-1f3fb-200d-1f9b0	-	-
person_tone2_red_hair	1f9d1-1f3fc-200d-1f9b0	-	-
person_medium_light_skin_tone_red_hair	1f9d1-1f3fc-200d-1f9b0	-	-
person_tone3_red_hair	1f9d1-1f3fd-200d-1f9b0	-	-
person_medium_skin_tone_red_hair	1f9d1-1f3fd-200d-1f9b0	-	-
person_tone4_red_hair	1f9d1-1f3fe-200d-1f9b0	-	-
person_medium_dark_skin_tone_red_hair	1f9d1-1f3fe-200d-1f9b0	-	-
person_tone5_red_hair	1f9d1-1f3ff-200d-1f9b0	-	-
person_dark_skin_tone_red_hair	1f9d1-1f3ff-200d-1f9b0	-	-
woman_red_haired	1f469-200d-1f9b0	people	+
woman_red_haired_tone1	1f469-1f3fb-200d-1f9b0	-	+
woman_red_haired_light_skin_tone	1f469-1f3fb-200d-1f9b0	-	+
woman_red_haired_tone2	1f469-1f3fc-200d-1f9b0	-	+
woman_red_haired_medium_light_skin_tone	1f469-1f3fc-200d-1f9b0	-	+
woman_red_haired_tone3	1f469-1f3fd-200d-1f9b0	-	+
woman_red_haired_medium_skin_tone	1f469-1f3fd-200d-1f9b0	-	+
woman_red_haired_tone4	1f469-1f3fe-200d-1f9b0	-	+
woman_red_haired_medium_dark_skin_tone	1f469-1f3fe-200d-1f9b0	-	+
woman_red_haired_tone5	1f469-1f3ff-200d-1f9b0	-	+
woman_red_haired_dark_skin_tone	1f469-1f3ff-200d-1f9b0	-	+
man_red_haired	1f468-200d-1f9b0	people	+
man_red_hair	1f468-200d-1f9b0	-	-
man_red_haired_tone1	1f468-1f3fb-200d-1f9b0	-	+
man_red_haired_light_skin_tone	1f468-1f3fb-200d-1f9b0	-	+
man_red_haired_tone2	1f468-1f3fc-200d-1f9b0	-	+
man_red_haired_medium_light_skin_tone	1f468-1f3fc-200d-1f9b0	-	+
man_red_haired_tone3	1f468-1f3fd-200d-1f9b0	-	+
man_red_haired_medium_skin_tone	1f468-1f3fd-200d-1f9b0	-	+
man_red_haired_tone4	1f468-1f3fe-200d-1f9b0	-	+
man_red_haired_medium_dark_skin_tone	1f468-1f3fe-200d-1f9b0	-	+
man_red_haired_tone5	1f468-1f3ff-200d-1f9b0	-	+
man_red_haired_dark_skin_tone	1f468-1f3ff-200d-1f9b0	-	+
blond_haired_person	1f471	people	+
person_with_blond_hair	1f471	-	+
blond_haired_person_tone1	1f471-1f3fb	-	+
person_with_blond_hair_tone1	1f471-1f3fb	-	+
blond_haired_person_tone2	1f471-1f3fc	-	+
person_with_blond_hair_tone2	1f471-1f3fc	-	+
blond_haired_person_tone3	1f471-1f3fd	-	+
person_with_blond_hair_tone3	1f471-1f3fd	-	+
blond_haired_person_tone4	1f471-1f3fe	-	+
person_with_blond_hair_tone4	1f471-1f3fe	-	+
blond_haired_person_tone5	1f471-1f3ff	-	+
person_with_blond_hair_tone5	1f471-1f3ff	-	+
blond-haired_woman	1f471-200d-2640-fe0f	people	+
blond-haired_woman_tone1	1f471-1f3fb-200d-2640-fe0f	-	+
blond-haired_woman_light_skin_tone	1f471-1f3fb-200d-2640-fe0f	-	+
blond-haired_woman_tone2	1f471-1f3fc-200d-2640-fe0f	-	+
blond-haired_woman_medium_light_skin_tone	1f471-1f3fc-200d-2640-fe0f	-	+
blond-haired_woman_tone3	1f471-1f3fd-200d-2640-fe0f	-	+
blond-haired_woman_medium_skin_tone	1f471-1f3fd-200d-2640-fe0f	-	+
blond-haired_woman_tone4	1f471-1f3fe-200d-2640-fe0f	-	+
blond-haired_woman_medium_dark_skin_tone	1f471-1f3fe-200d-2640-fe0f	-	+
blond-haired_woman_tone5	1f471-1f3ff-200d-2640-fe0f	-	+
blond-haired_woman_dark_skin_tone	1f471-1f3ff-200d-2640-fe0f	-	+
blond-haired_man	1f471-200d-2642-fe0f	people	+
blond-haired_man_tone1	1f471-1f3fb-200d-2642-fe0f	-	+
blond-haired_man_light_skin_tone	1f471-1f3fb-200d-2642-fe0f	-	+
blond-haired_man_tone2	1f471-1f3fc-200d-2642-fe0f	-	+
blond-haired_man_medium_light_skin_tone	1f471-1f3fc-200d-2642-fe0f	-	+
blond-haired_man_tone3	1f471-1f3fd-200d-2642-fe0f	-	+
blond-haired_man_medium_skin_tone	1f471-1f3fd-200d-2642-fe0f	-	+
blond-haired_man_tone4	1f471-1f3fe-200d-2642-fe0f	-	+
blond-haired_man_medium_dark_skin_tone	1f471-1f3fe-200d-2642-fe0f	-	+
blond-haired_man_tone5	1f471-1f3ff-200d-2642-fe0f	-	+
blond-haired_man_dark_skin_tone	1f471-1f3ff-200d-2642-fe0f	-	+
person_white_hair	1f9d1-200d-1f9b3	people	-
person_tone1_white_hair	1f9d1-1f3fb-200d-1f9b3	-	-
person_light_skin_tone_white_hair	1f9d1-1f3fb-200d-1f9b3	-	-
person_tone2_white_hair	1f9d1-1f3fc-200d-1f9b3	-	-
person_medium_light_skin_tone_white_hair	1f9d1-1f3fc-200d-1f9b3	-	-
person_tone3_white_hair	1f9d1-1f3fd-200d-1f9b3	-	-
person_medium_skin_tone_white_hair	1f9d1-1f3fd-200d-1f9b3	-	-
person_tone4_white_hair	1f9d1-1f3fe-200d-1f9b3	-	-
person_medium_dark_skin_tone_white_hair	1f9d1-1f3fe-200d-1f9b3	-	-
person_tone5_white_hair	1f9d1-1f3ff-200d-1f9b3	-	-
person_dark_skin_tone_white_hair	1f9d1-1f3ff-200d-1f9b3	-	-
woman_white_haired	1f469-200d-1f9b3	people	+
woman_white_haired_tone1	1f469-1f3fb-200d-1f9b3	-	+
woman_white_haired_light_skin_tone	1f469-1f3fb-200d-1f9b3	-	+
woman_white_haired_tone2	1f469-1f3fc-200d-1f9b3	-	+
woman_white_haired_medium_light_skin_tone	1f469-1f3fc-200d-1f9b3	-	+
woman_white_haired_tone3	1f469-1f3fd-200d-1f9b3	-	+
woman_white_haired_medium_skin_tone	1f469-1f3fd-200d-1f9b3	-	+
woman_white_haired_tone4	1f469-1f3fe-200d-1f9b3	-	+
woman_white_haired_medium_dark_skin_tone	1f469-1f3fe-200d-1f9b3	-	+
woman_white_haired_tone5	1f469-1f3ff-200d-1f9b3	-	+
woman_white_haired_dark_skin_tone	1f469-1f3ff-200d-1f9b3	-	+
man_white_haired	1f468-200d-1f9b3	people	+
man_white_haired_tone1	1f468-1f3fb-200d-1f9b3	-	+
man_white_haired_light_skin_tone	1f468-1f3fb-200d-1f9b3	-	+
man_white_haired_tone2	1f468-1f3fc-200d-1f9b3	-	+
man_white_haired_medium_light_skin_tone	1f468-1f3fc-200d-1f9b3	-	+
man_white_haired_tone3	1f468-1f3fd-200d-1f9b3	-	+
man_white_haired_medium_skin_tone	1f468-1f3fd-200d-1f9b3	-	+
man_white_haired_tone4	1f468-1f3fe-200d-1f9b3	-	+
man_white_haired_medium_dark_skin_tone	1f468-1f3fe-200d-1f9b3	-	+
man_white_haired_tone5	1f468-1f3ff-200d-1f9b3	-	+
man_white_haired_dark_skin_tone	1f468-1f3ff-200d-1f9b3	-	+
person_bald	1f9d1-200d-1f9b2	people	-
person_tone1_bald	1f9d1-1f3fb-200d-1f9b2	-	-
person_light_skin_tone_bald	1f9d1-1f3fb-200d-1f9b2	-	-
person_tone2_bald	1f9d1-1f3fc-200d-1f9b2	-	-
person_medium_light_skin_tone_bald	1f9d1-1f3fc-200d-1f9b2	-	-
person_tone3_bald	1f9d1-1f3fd-200d-1f9b2	-	-
person_medium_skin_tone_bald	1f9d1-1f3fd-200d-1f9b2	-	-
person_tone4_bald	1f9d1-1f3fe-200d-1f9b2	-	-
person_medium_dark_skin_tone_bald	1f9d1-1f3fe-200d-1f9b2	-	-
person_tone5_bald	1f9d1-1f3ff-200d-1f9b2	-	-
person_dark_skin_tone_bald	1f9d1-1f3ff-200d-1f9b2	-	-
woman_bald	1f469-200d-1f9b2	people	+
woman_bald_tone1	1f469-1f3fb-200d-1f9b2	-	+
woman_bald_light_skin_tone	1f469-1f3fb-200d-1f9b2	-	+
woman_bald_tone2	1f469-1f3fc-200d-1f9b2	-	+
woman_bald_medium_light_skin_tone	1f469-1f3fc-200d-1f9b2	-	+
woman_bald_tone3	1f469-1f3fd-200d-1f9b2	-	+
woman_bald_medium_skin_tone	1f469-1f3fd-200d-1f9b2	-	+
woman_bald_tone4	1f469-1f3fe-200d-1f9b2	-	+
woman_bald_medium_dark_skin_tone	1f469-1f3fe-200d-1f9b2	-	+
woman_bald_tone5	1f469-1f3ff-200d-1f9b2	-	+
woman_bald_dark_skin_tone	1f469-1f3ff-200d-1f9b2	-	+
man_bald	1f468-200d-1f9b2	people	+
man_bald_tone1	1f468-1f3fb-200d-1f9b2	-	+
man_bald_light_skin_tone	1f468-1f3fb-200d-1f9b2	-	+
man_bald_tone2	1f468-1f3fc-200d-1f9b2	-	+
man_bald_medium_light_skin_tone	1f468-1f3fc-200d-1f9b2	-	+
man_bald_tone3	1f468-1f3fd-200d-1f9b2	-	+
man_bald_medium_skin_tone	1f468-1f3fd-200d-1f9b2	-	+
man_bald_tone4	1f468-1f3fe-200d-1f9b2	-	+
man_bald_medium_dark_skin_tone	1f468-1f3fe-200d-1f9b2	-	+
man_bald_tone5	1f468-1f3ff-200d-1f9b2	-	+
man_bald_dark_skin_tone	1f468-1f3ff-200d-1f9b2	-	+
bearded_person	1f9d4	people	+
person_beard	1f9d4	-	-
bearded_person_tone1	1f9d4-1f3fb	-	+
bearded_person_light_skin_tone	1f9d4-1f3fb	-	+
bearded_person_tone2	1f9d4-1f3fc	-	+
bearded_person_medium_light_skin_tone	1f9d4-1f3fc	-	+
bearded_person_tone3	1f9d4-1f3fd	-	+
bearded_person_medium_skin_tone	1f9d4-1f3fd	-	+
bearded_person_tone4	1f9d4-1f3fe	-	+
bearded_person_medium_dark_skin_tone	1f9d4-1f3fe	-	+
bearded_person_tone5	1f9d4-1f3ff	-	+
bearded_person_dark_skin_tone	1f9d4-1f3ff	-	+
woman_beard	1f9d4-200d-2640-fe0f	people	-
woman_tone1_beard	1f9d4-1f3fb-200d-2640-fe0f	-	-
woman_light_skin_tone_beard	1f9d4-1f3fb-200d-2640-fe0f	-	-
woman_tone2_beard	1f9d4-1f3fc-200d-2640-fe0f	-	-
woman_medium_light_skin_tone_beard	1f9d4-1f3fc-200d-2640-fe0f	-	-
woman_tone3_beard	1f9d4-1f3fd-200d-2640-fe0f	-	-
woman_medium_skin_tone_beard	1f9d4-1f3fd-200d-2640-fe0f	-	-
woman_tone4_beard	1f9d4-1f3fe-200d-2640-fe0f	-	-
woman_medium_dark_skin_tone_beard	1f9d4-1f3fe-200d-2640-fe0f	-	-
woman_tone5_beard	1f9d4-1f3ff-200d-2640-fe0f	-	-
woman_dark_skin_tone_beard	1f9d4-1f3ff-200d-2640-fe0f	-	-
man_beard	1f9d4-200d-2642-fe0f	people	-
man_tone1_beard	1f9d4-1f3fb-200d-2642-fe0f	-	-
man_light_skin_tone_beard	1f9d4-1f3fb-200d-2642-fe0f	-	-
man_tone2_beard	1f9d4-1f3fc-200d-2642-fe0f	-	-
man_medium_light_skin_tone_beard	1f9d4-1f3fc-200d-2642-fe0f	-	-
man_tone3_beard	1f9d4-1f3fd-200d-2642-fe0f	-	-
man_medium_skin_tone_beard	1f9d4-1f3fd-200d-2642-fe0f	-	-
man_tone4_beard	1f9d4-1f3fe-200d-2642-fe0f	-	-
man_medium_dark_skin_tone_beard	1f9d4-1f3fe-200d-2642-fe0f	-	-
man_tone5_beard	1f9d4-1f3ff-200d-2642-fe0f	-	-
man_dark_skin_tone_beard	1f9d4-1f3ff-200d-2642-fe0f	-	-
older_adult	1f9d3	people	+
older_person	1f9d3	-	-
older_adult_tone1	1f9d3-1f3fb	-	+
older_adult_light_skin_tone	1f9d3-1f3fb	-	+
older_adult_tone2	1f9d3-1f3fc	-	+
older_adult_medium_light_skin_tone	1f9d3-1f3fc	-	+
older_adult_tone3	1f9d3-1f3fd	-	+
older_adult_medium_skin_tone	1f9d3-1f3fd	-	+
older_adult_tone4	1f9d3-1f3fe	-	+
older_adult_medium_dark_skin_tone	1f9d3-1f3fe	-	+
older_adult_tone5	1f9d3-1f3ff	-	+
older_adult_dark_skin_tone	1f9d3-1f3ff	-	+
older_woman	1f475	people	+
grandma	1f475	-	+
old_woman	1f475	-	-
older_woman_tone1	1f475-1f3fb	-	+
grandma_tone1	1f475-1f3fb	-	+
older_woman_tone2	1f475-1f3fc	-	+
grandma_tone2	1f475-1f3fc	-	+
older_woman_tone3	1f475-1f3fd	-	+
grandma_tone3	1f475-1f3fd	-	+
older_woman_tone4	1f475-1f3fe	-	+
grandma_tone4	1f475-1f3fe	-	+
older_woman_tone5	1f475-1f3ff	-	+
grandma_tone5	1f475-1f3ff	-	+
older_man	1f474	people	+
old_man	1f474	-	-
older_man_tone1	1f474-1f3fb	-	+
older_man_tone2	1f474-1f3fc	-	+
older_man_tone3	1f474-1f3fd	-	+
older_man_tone4	1f474-1f3fe	-	+
older_man_tone5	1f474-1f3ff	-	+
man_with_chinese_cap	1f472	people	+
man_with_gua_pi_mao	1f472	-	+
man_with_chinese_cap_tone1	1f472-1f3fb	-	+
man_with_gua_pi_mao_tone1	1f472-1f3fb	-	+
man_with_chinese_cap_tone2	1f472-1f3fc	-	+
man_with_gua_pi_mao_tone2	1f472-1f3fc	-	+
man_with_chinese_cap_tone3	1f472-1f3fd	-	+
man_with_gua_pi_mao_tone3	1f472-1f3fd	-	+
man_with_chinese_cap_tone4	1f472-1f3fe	-	+
man_with_gua_pi_mao_tone4	1f472-1f3fe	-	+
man_with_chinese_cap_tone5	1f472-1f3ff	-	+
man_with_gua_pi_mao_tone5	1f472-1f3ff	-	+
person_wearing_turban	1f473	people	+
man_with_turban	1f473	-	+
person_wearing_turban_tone1	1f473-1f3fb	-	+
man_with_turban_tone1	1f473-1f3fb	-	+
person_wearing_turban_tone2	1f473-1f3fc	-	+
man_with_turban_tone2	1f473-1f3fc	-	+
person_wearing_turban_tone3	1f473-1f3fd	-	+
man_with_turban_tone3	1f473-1f3fd	-	+
person_wearing_turban_tone4	1f473-1f3fe	-	+
man_with_turban_tone4	1f473-1f3fe	-	+
person_wearing_turban_tone5	1f473-1f3ff	-	+
man_with_turban_tone5	1f473-1f3ff	-	+
woman_wearing_turban	1f473-200d-2640-fe0f	people	+
woman_wearing_turban_tone1	1f473-1f3fb-200d-2640-fe0f	-	+
woman_wearing_turban_light_skin_tone	1f473-1f3fb-200d-2640-fe0f	-	+
woman_wearing_turban_tone2	1f473-1f3fc-200d-2640-fe0f	-	+
woman_wearing_turban_medium_light_skin_tone	1f473-1f3fc-200d-2640-fe0f	-	+
woman_wearing_turban_tone3	1f473-1f3fd-200d-2640-fe0f	-	+
woman_wearing_turban_medium_skin_tone	1f473-1f3fd-200d-2640-fe0f	-	+
woman_wearing_turban_tone4	1f473-1f3fe-200d-2640-fe0f	-	+
woman_wearing_turban_medium_dark_skin_tone	1f473-1f3fe-200d-2640-fe0f	-	+
woman_wearing_turban_tone5	1f473-1f3ff-200d-2640-fe0f	-	+
woman_wearing_turban_dark_skin_tone	1f473-1f3ff-200d-2640-fe0f	-	+
man_wearing_turban	1f473-200d-2642-fe0f	people	+
man_wearing_turban_tone1	1f473-1f3fb-200d-2642-fe0f	-	+
man_wearing_turban_light_skin_tone	1f473-1f3fb-200d-2642-fe0f	-	+
man_wearing_turban_tone2	1f473-1f3fc-200d-2642-fe0f	-	+
man_wearing_turban_medium_light_skin_tone	1f473-1f3fc-200d-2642-fe0f	-	+
man_wearing_turban_tone3	1f473-1f3fd-200d-2642-fe0f	-	+
man_wearing_turban_medium_skin_tone	1f473-1f3fd-200d-2642-fe0f	-	+
man_wearing_turban_tone4	1f473-1f3fe-200d-2642-fe0f	-	+
man_wearing_turban_medium_dark_skin_tone	1f473-1f3fe-200d-2642-fe0f	-	+
man_wearing_turban_tone5	1f473-1f3ff-200d-2642-fe0f	-	+
man_wearing_turban_dark_skin_tone	1f473-1f3ff-200d-2642-fe0f	-	+
woman_with_headscarf	1f9d5	people	+
woman_with_headscarf_tone1	1f9d5-1f3fb	-	+
woman_with_headscarf_light_skin_tone	1f9d5-1f3fb	-	+
woman_with_headscarf_tone2	1f9d5-1f3fc	-	+
woman_with_headscarf_medium_light_skin_tone	1f9d5-1f3fc	-	+
woman_with_headscarf_tone3	1f9d5-1f3fd	-	+
woman_with_headscarf_medium_skin_tone	1f9d5-1f3fd	-	+
woman_with_headscarf_tone4	1f9d5-1f3fe	-	+
woman_with_headscarf_medium_dark_skin_tone	1f9d5-1f3fe	-	+
woman_with_headscarf_tone5	1f9d5-1f3ff	-	+
woman_with_headscarf_dark_skin_tone	1f9d5-1f3ff	-	+
police_officer	1f46e	people	+
cop	1f46e	-	+
police_officer_tone1	1f46e-1f3fb	-	+
cop_tone1	1f46e-1f3fb	-	+
police_officer_tone2	1f46e-1f3fc	-	+
cop_tone2	1f46e-1f3fc	-	+
police_officer_tone3	1f46e-1f3fd	-	+
cop_tone3	1f46e-1f3fd	-	+
police_officer_tone4	1f46e-1f3fe	-	+
cop_tone4	1f46e-1f3fe	-	+
police_officer_tone5	1f46e-1f3ff	-	+
cop_tone5	1f46e-1f3ff	-	+
woman_police_officer	1f46e-200d-2640-fe0f	people	+
woman_police_officer_tone1	1f46e-1f3fb-200d-2640-fe0f	-	+
woman_police_officer_light_skin_tone	1f46e-1f3fb-200d-2640-fe0f	-	+
woman_police_officer_tone2	1f46e-1f3fc-200d-2640-fe0f	-	+
woman_police_officer_medium_light_skin_tone	1f46e-1f3fc-200d-2640-fe0f	-	+
woman_police_officer_tone3	1f46e-1f3fd-200d-2640-fe0f	-	+
woman_police_officer_medium_skin_tone	1f46e-1f3fd-200d-2640-fe0f	-	+
woman_police_officer_tone4	1f46e-1f3fe-200d-2640-fe0f	-	+
woman_police_officer_medium_dark_skin_tone	1f46e-1f3fe-200d-2640-fe0f	-	+
woman_police_officer_tone5	1f46e-1f3ff-200d-2640-fe0f	-	+
woman_police_officer_dark_skin_tone	1f46e-1f3ff-200d-2640-fe0f	-	+
man_police_officer	1f46e-200d-2642-fe0f	people	+
man_police_officer_tone1	1f46e-1f3fb-200d-2642-fe0f	-	+
man_police_officer_light_skin_tone	1f46e-1f3fb-200d-2642-fe0f	-	+
man_police_officer_tone2	1f46e-1f3fc-200d-2642-fe0f	-	+
man_police_officer_medium_light_skin_tone	1f46e-1f3fc-200d-2642-fe0f	-	+
man_police_officer_tone3	1f46e-1f3fd-200d-2642-fe0f	-	+
man_police_officer_medium_skin_tone	1f46e-1f3fd-200d-2642-fe0f	-	+
man_police_officer_tone4	1f46e-1f3fe-200d-2642-fe0f	-	+
man_police_officer_medium_dark_skin_tone	1f46e-1f3fe-200d-2642-fe0f	-	+
man_police_officer_tone5	1f46e-1f3ff-200d-2642-fe0f	-	+
man_police_officer_dark_skin_tone	1f46e-1f3ff-200d-2642-fe0f	-	+
construction_worker	1f477	people	+
construction_worker_tone1	1f477-1f3fb	-	+
construction_worker_tone2	1f477-1f3fc	-	+
construction_worker_tone3	1f477-1f3fd	-	+
construction_worker_tone4	1f477-1f3fe	-	+
construction_worker_tone5	1f477-1f3ff	-	+
woman_construction_worker	1f477-200d-2640-fe0f	people	+
woman_construction_worker_tone1	1f477-1f3fb-200d-2640-fe0f	-	+
woman_construction_worker_light_skin_tone	1f477-1f3fb-200d-2640-fe0f	-	+
woman_construction_worker_tone2	1f477-1f3fc-200d-2640-fe0f	-	+
woman_construction_worker_medium_light_skin_tone	1f477-1f3fc-200d-2640-fe0f	-	+
woman_construction_worker_tone3	1f477-1f3fd-200d-2640-fe0f	-	+
woman_construction_worker_medium_skin_tone	1f477-1f3fd-200d-2640-fe0f	-	+
woman_construction_worker_tone4	1f477-1f3fe-200d-2640-fe0f	-	+
woman_construction_worker_medium_dark_skin_tone	1f477-1f3fe-200d-2640-fe0f	-	+
woman_construction_worker_tone5	1f477-1f3ff-200d-2640-fe0f	-	+
woman_construction_worker_dark_skin_tone	1f477-1f3ff-200d-2640-fe0f	-	+
man_construction_worker	1f477-200d-2642-fe0f	people	+
man_construction_worker_tone1	1f477-1f3fb-200d-2642-fe0f	-	+
man_construction_worker_light_skin_tone	1f477-1f3fb-200d-2642-fe0f	-	+
man_construction_worker_tone2	1f477-1f3fc-200d-2642-fe0f	-	+
man_construction_worker_medium_light_skin_tone	1f477-1f3fc-200d-2642-fe0f	-	+
man_construction_worker_tone3	1f477-1f3fd-200d-2642-fe0f	-	+
man_construction_worker_medium_skin_tone	1f477-1f3fd-200d-2642-fe0f	-	+
man_construction_worker_tone4	1f477-1f3fe-200d-2642-fe0f	-	+
man_construction_worker_medium_dark_skin_tone	1f477-1f3fe-200d-2642-fe0f	-	+
man_construction_worker_tone5	1f477-1f3ff-200d-2642-fe0f	-	+
man_construction_worker_dark_skin_tone	1f477-1f3ff-200d-2642-fe0f	-	+
guard	1f482	people	+
guardsman	1f482	-	+
guard_tone1	1f482-1f3fb	-	+
guardsman_tone1	1f482-1f3fb	-	+
guard_tone2	1f482-1f3fc	-	+
guardsman_tone2	1f482-1f3fc	-	+
guard_tone3	1f482-1f3fd	-	+
guardsman_tone3	1f482-1f3fd	-	+
guard_tone4	1f482-1f3fe	-	+
guardsman_tone4	1f482-1f3fe	-	+
guard_tone5	1f482-1f3ff	-	+
guardsman_tone5	1f482-1f3ff	-	+
woman_guard	1f482-200d-2640-fe0f	people	+
woman_guard_tone1	1f482-1f3fb-200d-2640-fe0f	-	+
woman_guard_light_skin_tone	1f482-1f3fb-200d-2640-fe0f	-	+
woman_guard_tone2	1f482-1f3fc-200d-2640-fe0f	-	+
woman_guard_medium_light_skin_tone	1f482-1f3fc-200d-2640-fe0f	-	+
woman_guard_tone3	1f482-1f3fd-200d-2640-fe0f	-	+
woman_guard_medium_skin_tone	1f482-1f3fd-200d-2640-fe0f	-	+
woman_guard_tone4	1f482-1f3fe-200d-2640-fe0f	-	+
woman_guard_medium_dark_skin_tone	1f482-1f3fe-200d-2640-fe0f	-	+
woman_guard_tone5	1f482-1f3ff-200d-2640-fe0f	-	+
woman_guard_dark_skin_tone	1f482-1f3ff-200d-2640-fe0f	-	+
man_guard	1f482-200d-2642-fe0f	people	+
man_guard_tone1	1f482-1f3fb-200d-2642-fe0f	-	+
man_guard_light_skin_tone	1f482-1f3fb-200d-2642-fe0f	-	+
man_guard_tone2	1f482-1f3fc-200d-2642-fe0f	-	+
man_guard_medium_light_skin_tone	1f482-1f3fc-200d-2642-fe0f	-	+
man_guard_tone3	1f482-1f3fd-200d-2642-fe0f	-	+
man_guard_medium_skin_tone	1f482-1f3fd-200d-2642-fe0f	-	+
man_guard_tone4	1f482-1f3fe-200d-2642-fe0f	-	+
man_guard_medium_dark_skin_tone	1f482-1f3fe-200d-2642-fe0f	-	+
man_guard_tone5	1f482-1f3ff-200d-2642-fe0f	-	+
man_guard_dark_skin_tone	1f482-1f3ff-200d-2642-fe0f	-	+
detective	1f575-fe0f	people	+
spy	1f575-fe0f	-	+
sleuth_or_spy	1f575-fe0f	-	+
detective_tone1	1f575-1f3fb	-	+
spy_tone1	1f575-1f3fb	-	+
sleuth_or_spy_tone1	1f575-1f3fb	-	+
detective_tone2	1f575-1f3fc	-	+
spy_tone2	1f575-1f3fc	-	+
sleuth_or_spy_tone2	1f575-1f3fc	-	+
detective_tone3	1f575-1f3fd	-	+
spy_tone3	1f575-1f3fd	-	+
sleuth_or_spy_tone3	1f575-1f3fd	-	+
detective_tone4	1f575-1f3fe	-	+
spy_tone4	1f575-1f3fe	-	+
sleuth_or_spy_tone4	1f575-1f3fe	-	+
detective_tone5	1f575-1f3ff	-	+
spy_tone5	1f575-1f3ff	-	+
sleuth_or_spy_tone5	1f575-1f3ff	-	+
woman_detective	1f575-fe0f-200d-2640-fe0f	people	+
woman_detective_tone1	1f575-1f3fb-200d-2640-fe0f	-	+
woman_detective_light_skin_tone	1f575-1f3fb-200d-2640-fe0f	-	+
woman_detective_tone2	1f575-1f3fc-200d-2640-fe0f	-	+
woman_detective_medium_light_skin_tone	1f575-1f3fc-200d-2640-fe0f	-	+
woman_detective_tone3	1f575-1f3fd-200d-2640-fe0f	-	+
woman_detective_medium_skin_tone	1f575-1f3fd-200d-2640-fe0f	-	+
woman_detective_tone4	1f575-1f3fe-200d-2640-fe0f	-	+
woman_detective_medium_dark_skin_tone	1f575-1f3fe-200d-2640-fe0f	-	+
woman_detective_tone5	1f575-1f3ff-200d-2640-fe0f	-	+
woman_detective_dark_skin_tone	1f575-1f3ff-200d-2640-fe0f	-	+
man_detective	1f575-fe0f-200d-2642-fe0f	people	+
man_detective_tone1	1f575-1f3fb-200d-2642-fe0f	-	+
man_detective_light_skin_tone	1f575-1f3fb-200d-2642-fe0f	-	+
man_detective_tone2	1f575-1f3fc-200d-2642-fe0f	-	+
man_detective_medium_light_skin_tone	1f575-1f3fc-200d-2642-fe0f	-	+
man_detective_tone3	1f575-1f3fd-200d-2642-fe0f	-	+
man_detective_medium_skin_tone	1f575-1f3fd-200d-2642-fe0f	-	+
man_detective_tone4	1f575-1f3fe-200d-2642-fe0f	-	+
man_detective_medium_dark_skin_tone	1f575-1f3fe-200d-2642-fe0f	-	+
man_detective_tone5	1f575-1f3ff-200d-2642-fe0f	-	+
man_detective_dark_skin_tone	1f575-1f3ff-200d-2642-fe0f	-	+
health_worker	1f9d1-200d-2695-fe0f	people	-
health_worker_tone1	1f9d1-1f3fb-200d-2695-fe0f	-	-
health_worker_light_skin_tone	1f9d1-1f3fb-200d-2695-fe0f	-	-
health_worker_tone2	1f9d1-1f3fc-200d-2695-fe0f	-	-
health_worker_medium_light_skin_tone	1f9d1-1f3fc-200d-2695-fe0f	-	-
health_worker_tone3	1f9d1-1f3fd-200d-2695-fe0f	-	-
health_worker_medium_skin_tone	1f9d1-1f3fd-200d-2695-fe0f	-	-
health_worker_tone4	1f9d1-1f3fe-200d-2695-fe0f	-	-
health_worker_medium_dark_skin_tone	1f9d1-1f3fe-200d-2695-fe0f	-	-
health_worker_tone5	1f9d1-1f3ff-200d-2695-fe0f	-	-
health_worker_dark_skin_tone	1f9d1-1f3ff-200d-2695-fe0f	-	-
woman_health_worker	1f469-200d-2695-fe0f	people	+
woman_health_worker_tone1	1f469-1f3fb-200d-2695-fe0f	-	+
woman_health_worker_light_skin_tone	1f469-1f3fb-200d-2695-fe0f	-	+
woman_health_worker_tone2	1f469-1f3fc-200d-2695-fe0f	-	+
woman_health_worker_medium_light_skin_tone	1f469-1f3fc-200d-2695-fe0f	-	+
woman_health_worker_tone3	1f469-1f3fd-200d-2695-fe0f	-	+
woman_health_worker_medium_skin_tone	1f469-1f3fd-200d-2695-fe0f	-	+
woman_health_worker_tone4	1f469-1f3fe-200d-2695-fe0f	-	+
woman_health_worker_medium_dark_skin_tone	1f469-1f3fe-200d-2695-fe0f	-	+
woman_health_worker_tone5	1f469-1f3ff-200d-2695-fe0f	-	+
woman_health_worker_dark_skin_tone	1f469-1f3ff-200d-2695-fe0f	-	+
man_health_worker	1f468-200d-2695-fe0f	people	+
man_health_worker_tone1	1f468-1f3fb-200d-2695-fe0f	-	+
man_health_worker_light_skin_tone	1f468-1f3fb-200d-2695-fe0f	-	+
man_health_worker_tone2	1f468-1f3fc-200d-2695-fe0f	-	+
man_health_worker_medium_light_skin_tone	1f468-1f3fc-200d-2695-fe0f	-	+
man_health_worker_tone3	1f468-1f3fd-200d-2695-fe0f	-	+
man_health_worker_medium_skin_tone	1f468-1f3fd-200d-2695-fe0f	-	+
man_health_worker_tone4	1f468-1f3fe-200d-2695-fe0f	-	+
man_health_worker_medium_dark_skin_tone	1f468-1f3fe-200d-2695-fe0f	-	+
man_health_worker_tone5	1f468-1f3ff-200d-2695-fe0f	-	+
man_health_worker_dark_skin_tone	1f468-1f3ff-200d-2695-fe0f	-	+
farmer	1f9d1-200d-1f33e	people	-
farmer_tone1	1f9d1-1f3fb-200d-1f33e	-	-
farmer_light_skin_tone	1f9d1-1f3fb-200d-1f33e	-	-
farmer_tone2	1f9d1-1f3fc-200d-1f33e	-	-
farmer_medium_light_skin_tone	1f9d1-1f3fc-200d-1f33e	-	-
farmer_tone3	1f9d1-1f3fd-200d-1f33e	-	-
farmer_medium_skin_tone	1f9d1-1f3fd-200d-1f33e	-	-
farmer_tone4	1f9d1-1f3fe-200d-1f33e	-	-
farmer_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f33e	-	-
farmer_tone5	1f9d1-1f3ff-200d-1f33e	-	-
farmer_dark_skin_tone	1f9d1-1f3ff-200d-1f33e	-	-
woman_farmer	1f469-200d-1f33e	people	+
woman_farmer_tone1	1f469-1f3fb-200d-1f33e	-	+
woman_farmer_light_skin_tone	1f469-1f3fb-200d-1f33e	-	+
woman_farmer_tone2	1f469-1f3fc-200d-1f33e	-	+
woman_farmer_medium_light_skin_tone	1f469-1f3fc-200d-1f33e	-	+
woman_farmer_tone3	1f469-1f3fd-200d-1f33e	-	+
woman_farmer_medium_skin_tone	1f469-1f3fd-200d-1f33e	-	+
woman_farmer_tone4	1f469-1f3fe-200d-1f33e	-	+
woman_farmer_medium_dark_skin_tone	1f469-1f3fe-200d-1f33e	-	+
woman_farmer_tone5	1f469-1f3ff-200d-1f33e	-	+
woman_farmer_dark_skin_tone	1f469-1f3ff-200d-1f33e	-	+
man_farmer	1f468-200d-1f33e	people	+
man_farmer_tone1	1f468-1f3fb-200d-1f33e	-	+
man_farmer_light_skin_tone	1f468-1f3fb-200d-1f33e	-	+
man_farmer_tone2	1f468-1f3fc-200d-1f33e	-	+
man_farmer_medium_light_skin_tone	1f468-1f3fc-200d-1f33e	-	+
man_farmer_tone3	1f468-1f3fd-200d-1f33e	-	+
man_farmer_medium_skin_tone	1f468-1f3fd-200d-1f33e	-	+
man_farmer_tone4	1f468-1f3fe-200d-1f33e	-	+
man_farmer_medium_dark_skin_tone	1f468-1f3fe-200d-1f33e	-	+
man_farmer_tone5	1f468-1f3ff-200d-1f33e	-	+
man_farmer_dark_skin_tone	1f468-1f3ff-200d-1f33e	-	+
cook	1f9d1-200d-1f373	people	-
cook_tone1	1f9d1-1f3fb-200d-1f373	-	-
cook_light_skin_tone	1f9d1-1f3fb-200d-1f373	-	-
cook_tone2	1f9d1-1f3fc-200d-1f373	-	-
cook_medium_light_skin_tone	1f9d1-1f3fc-200d-1f373	-	-
cook_tone3	1f9d1-1f3fd-200d-1f373	-	-
cook_medium_skin_tone	1f9d1-1f3fd-200d-1f373	-	-
cook_tone4	1f9d1-1f3fe-200d-1f373	-	-
cook_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f373	-	-
cook_tone5	1f9d1-1f3ff-200d-1f373	-	-
cook_dark_skin_tone	1f9d1-1f3ff-200d-1f373	-	-
woman_cook	1f469-200d-1f373	people	+
woman_cook_tone1	1f469-1f3fb-200d-1f373	-	+
woman_cook_light_skin_tone	1f469-1f3fb-200d-1f373	-	+
woman_cook_tone2	1f469-1f3fc-200d-1f373	-	+
woman_cook_medium_light_skin_tone	1f469-1f3fc-200d-1f373	-	+
woman_cook_tone3	1f469-1f3fd-200d-1f373	-	+
woman_cook_medium_skin_tone	1f469-1f3fd-200d-1f373	-	+
woman_cook_tone4	1f469-1f3fe-200d-1f373	-	+
woman_cook_medium_dark_skin_tone	1f469-1f3fe-200d-1f373	-	+
woman_cook_tone5	1f469-1f3ff-200d-1f373	-	+
woman_cook_dark_skin_tone	1f469-1f3ff-200d-1f373	-	+
man_cook	1f468-200d-1f373	people	+
man_cook_tone1	1f468-1f3fb-200d-1f373	-	+
man_cook_light_skin_tone	1f468-1f3fb-200d-1f373	-	+
man_cook_tone2	1f468-1f3fc-200d-1f373	-	+
man_cook_medium_light_skin_tone	1f468-1f3fc-200d-1f373	-	+
man_cook_tone3	1f468-1f3fd-200d-1f373	-	+
man_cook_medium_skin_tone	1f468-1f3fd-200d-1f373	-	+
man_cook_tone4	1f468-1f3fe-200d-1f373	-	+
man_cook_medium_dark_skin_tone	1f468-1f3fe-200d-1f373	-	+
man_cook_tone5	1f468-1f3ff-200d-1f373	-	+
man_cook_dark_skin_tone	1f468-1f3ff-200d-1f373	-	+
student	1f9d1-200d-1f393	people	-
student_tone1	1f9d1-1f3fb-200d-1f393	-	-
student_light_skin_tone	1f9d1-1f3fb-200d-1f393	-	-
student_tone2	1f9d1-1f3fc-200d-1f393	-	-
student_medium_light_skin_tone	1f9d1-1f3fc-200d-1f393	-	-
student_tone3	1f9d1-1f3fd-200d-1f393	-	-
student_medium_skin_tone	1f9d1-1f3fd-200d-1f393	-	-
student_tone4	1f9d1-1f3fe-200d-1f393	-	-
student_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f393	-	-
student_tone5	1f9d1-1f3ff-200d-1f393	-	-
student_dark_skin_tone	1f9d1-1f3ff-200d-1f393	-	-
woman_student	1f469-200d-1f393	people	+
woman_student_tone1	1f469-1f3fb-200d-1f393	-	+
woman_student_light_skin_tone	1f469-1f3fb-200d-1f393	-	+
woman_student_tone2	1f469-1f3fc-200d-1f393	-	+
woman_student_medium_light_skin_tone	1f469-1f3fc-200d-1f393	-	+
woman_student_tone3	1f469-1f3fd-200d-1f393	-	+
woman_student_medium_skin_tone	1f469-1f3fd-200d-1f393	-	+
woman_student_tone4	1f469-1f3fe-200d-1f393	-	+
woman_student_medium_dark_skin_tone	1f469-1f3fe-200d-1f393	-	+
woman_student_tone5	1f469-1f3ff-200d-1f393	-	+
woman_student_dark_skin_tone	1f469-1f3ff-200d-1f393	-	+
man_student	1f468-200d-1f393	people	+
man_student_tone1	1f468-1f3fb-200d-1f393	-	+
man_student_light_skin_tone	1f468-1f3fb-200d-1f393	-	+
man_student_tone2	1f468-1f3fc-200d-1f393	-	+
man_student_medium_light_skin_tone	1f468-1f3fc-200d-1f393	-	+
man_student_tone3	1f468-1f3fd-200d-1f393	-	+
man_student_medium_skin_tone	1f468-1f3fd-200d-1f393	-	+
man_student_tone4	1f468-1f3fe-200d-1f393	-	+
man_student_medium_dark_skin_tone	1f468-1f3fe-200d-1f393	-	+
man_student_tone5	1f468-1f3ff-200d-1f393	-	+
man_student_dark_skin_tone	1f468-1f3ff-200d-1f393	-	+
singer	1f9d1-200d-1f3a4	people	-
singer_tone1	1f9d1-1f3fb-200d-1f3a4	-	-
singer_light_skin_tone	1f9d1-1f3fb-200d-1f3a4	-	-
singer_tone2	1f9d1-1f3fc-200d-1f3a4	-	-
singer_medium_light_skin_tone	1f9d1-1f3fc-200d-1f3a4	-	-
singer_tone3	1f9d1-1f3fd-200d-1f3a4	-	-
singer_medium_skin_tone	1f9d1-1f3fd-200d-1f3a4	-	-
singer_tone4	1f9d1-1f3fe-200d-1f3a4	-	-
singer_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f3a4	-	-
singer_tone5	1f9d1-1f3ff-200d-1f3a4	-	-
singer_dark_skin_tone	1f9d1-1f3ff-200d-1f3a4	-	-
woman_singer	1f469-200d-1f3a4	people	+
woman_singer_tone1	1f469-1f3fb-200d-1f3a4	-	+
woman_singer_light_skin_tone	1f469-1f3fb-200d-1f3a4	-	+
woman_singer_tone2	1f469-1f3fc-200d-1f3a4	-	+
woman_singer_medium_light_skin_tone	1f469-1f3fc-200d-1f3a4	-	+
woman_singer_tone3	1f469-1f3fd-200d-1f3a4	-	+
woman_singer_medium_skin_tone	1f469-1f3fd-200d-1f3a4	-	+
woman_singer_tone4	1f469-1f3fe-200d-1f3a4	-	+
woman_singer_medium_dark_skin_tone	1f469-1f3fe-200d-1f3a4	-	+
woman_singer_tone5	1f469-1f3ff-200d-1f3a4	-	+
woman_singer_dark_skin_tone	1f469-1f3ff-200d-1f3a4	-	+
man_singer	1f468-200d-1f3a4	people	+
man_singer_tone1	1f468-1f3fb-200d-1f3a4	-	+
man_singer_light_skin_tone	1f468-1f3fb-200d-1f3a4	-	+
man_singer_tone2	1f468-1f3fc-200d-1f3a4	-	+
man_singer_medium_light_skin_tone	1f468-1f3fc-200d-1f3a4	-	+
man_singer_tone3	1f468-1f3fd-200d-1f3a4	-	+
man_singer_medium_skin_tone	1f468-1f3fd-200d-1f3a4	-	+
man_singer_tone4	1f468-1f3fe-200d-1f3a4	-	+
man_singer_medium_dark_skin_tone	1f468-1f3fe-200d-1f3a4	-	+
man_singer_tone5	1f468-1f3ff-200d-1f3a4	-	+
man_singer_dark_skin_tone	1f468-1f3ff-200d-1f3a4	-	+
teacher	1f9d1-200d-1f3eb	people	-
teacher_tone1	1f9d1-1f3fb-200d-1f3eb	-	-
teacher_light_skin_tone	1f9d1-1f3fb-200d-1f3eb	-	-
teacher_tone2	1f9d1-1f3fc-200d-1f3eb	-	-
teacher_medium_light_skin_tone	1f9d1-1f3fc-200d-1f3eb	-	-
teacher_tone3	1f9d1-1f3fd-200d-1f3eb	-	-
teacher_medium_skin_tone	1f9d1-1f3fd-200d-1f3eb	-	-
teacher_tone4	1f9d1-1f3fe-200d-1f3eb	-	-
teacher_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f3eb	-	-
teacher_tone5	1f9d1-1f3ff-200d-1f3eb	-	-
teacher_dark_skin_tone	1f9d1-1f3ff-200d-1f3eb	-	-
woman_teacher	1f469-200d-1f3eb	people	+
woman_teacher_tone1	1f469-1f3fb-200d-1f3eb	-	+
woman_teacher_light_skin_tone	1f469-1f3fb-200d-1f3eb	-	+
woman_teacher_tone2	1f469-1f3fc-200d-1f3eb	-	+
woman_teacher_medium_light_skin_tone	1f469-1f3fc-200d-1f3eb	-	+
woman_teacher_tone3	1f469-1f3fd-200d-1f3eb	-	+
woman_teacher_medium_skin_tone	1f469-1f3fd-200d-1f3eb	-	+
woman_teacher_tone4	1f469-1f3fe-200d-1f3eb	-	+
woman_teacher_medium_dark_skin_tone	1f469-1f3fe-200d-1f3eb	-	+
woman_teacher_tone5	1f469-1f3ff-200d-1f3eb	-	+
woman_teacher_dark_skin_tone	1f469-1f3ff-200d-1f3eb	-	+
man_teacher	1f468-200d-1f3eb	people	+
man_teacher_tone1	1f468-1f3fb-200d-1f3eb	-	+
man_teacher_light_skin_tone	1f468-1f3fb-200d-1f3eb	-	+
man_teacher_tone2	1f468-1f3fc-200d-1f3eb	-	+
man_teacher_medium_light_skin_tone	1f468-1f3fc-200d-1f3eb	-	+
man_teacher_tone3	1f468-1f3fd-200d-1f3eb	-	+
man_teacher_medium_skin_tone	1f468-1f3fd-200d-1f3eb	-	+
man_teacher_tone4	1f468-1f3fe-200d-1f3eb	-	+
man_teacher_medium_dark_skin_tone	1f468-1f3fe-200d-1f3eb	-	+
man_teacher_tone5	1f468-1f3ff-200d-1f3eb	-	+
man_teacher_dark_skin_tone	1f468-1f3ff-200d-1f3eb	-	+
factory_worker	1f9d1-200d-1f3ed	people	-
factory_worker_tone1	1f9d1-1f3fb-200d-1f3ed	-	-
factory_worker_light_skin_tone	1f9d1-1f3fb-200d-1f3ed	-	-
factory_worker_tone2	1f9d1-1f3fc-200d-1f3ed	-	-
factory_worker_medium_light_skin_tone	1f9d1-1f3fc-200d-1f3ed	-	-
factory_worker_tone3	1f9d1-1f3fd-200d-1f3ed	-	-
factory_worker_medium_skin_tone	1f9d1-1f3fd-200d-1f3ed	-	-
factory_worker_tone4	1f9d1-1f3fe-200d-1f3ed	-	-
factory_worker_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f3ed	-	-
factory_worker_tone5	1f9d1-1f3ff-200d-1f3ed	-	-
factory_worker_dark_skin_tone	1f9d1-1f3ff-200d-1f3ed	-	-
woman_factory_worker	1f469-200d-1f3ed	people	+
woman_factory_worker_tone1	1f469-1f3fb-200d-1f3ed	-	+
woman_factory_worker_light_skin_tone	1f469-1f3fb-200d-1f3ed	-	+
woman_factory_worker_tone2	1f469-1f3fc-200d-1f3ed	-	+
woman_factory_worker_medium_light_skin_tone	1f469-1f3fc-200d-1f3ed	-	+
woman_factory_worker_tone3	1f469-1f3fd-200d-1f3ed	-	+
woman_factory_worker_medium_skin_tone	1f469-1f3fd-200d-1f3ed	-	+
woman_factory_worker_tone4	1f469-1f3fe-200d-1f3ed	-	+
woman_factory_worker_medium_dark_skin_tone	1f469-1f3fe-200d-1f3ed	-	+
woman_factory_worker_tone5	1f469-1f3ff-200d-1f3ed	-	+
woman_factory_worker_dark_skin_tone	1f469-1f3ff-200d-1f3ed	-	+
man_factory_worker	1f468-200d-1f3ed	people	+
man_factory_worker_tone1	1f468-1f3fb-200d-1f3ed	-	+
man_factory_worker_light_skin_tone	1f468-1f3fb-200d-1f3ed	-	+
man_factory_worker_tone2	1f468-1f3fc-200d-1f3ed	-	+
man_factory_worker_medium_light_skin_tone	1f468-1f3fc-200d-1f3ed	-	+
man_factory_worker_tone3	1f468-1f3fd-200d-1f3ed	-	+
man_factory_worker_medium_skin_tone	1f468-1f3fd-200d-1f3ed	-	+
man_factory_worker_tone4	1f468-1f3fe-200d-1f3ed	-	+
man_factory_worker_medium_dark_skin_tone	1f468-1f3fe-200d-1f3ed	-	+
man_factory_worker_tone5	1f468-1f3ff-200d-1f3ed	-	+
man_factory_worker_dark_skin_tone	1f468-1f3ff-200d-1f3ed	-	+
technologist	1f9d1-200d-1f4bb	people	-
technologist_tone1	1f9d1-1f3fb-200d-1f4bb	-	-
technologist_light_skin_tone	1f9d1-1f3fb-200d-1f4bb	-	-
technologist_tone2	1f9d1-1f3fc-200d-1f4bb	-	-
technologist_medium_light_skin_tone	1f9d1-1f3fc-200d-1f4bb	-	-
technologist_tone3	1f9d1-1f3fd-200d-1f4bb	-	-
technologist_medium_skin_tone	1f9d1-1f3fd-200d-1f4bb	-	-
technologist_tone4	1f9d1-1f3fe-200d-1f4bb	-	-
technologist_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f4bb	-	-
technologist_tone5	1f9d1-1f3ff-200d-1f4bb	-	-
technologist_dark_skin_tone	1f9d1-1f3ff-200d-1f4bb	-	-
woman_technologist	1f469-200d-1f4bb	people	+
woman_technologist_tone1	1f469-1f3fb-200d-1f4bb	-	+
woman_technologist_light_skin_tone	1f469-1f3fb-200d-1f4bb	-	+
woman_technologist_tone2	1f469-1f3fc-200d-1f4bb	-	+
woman_technologist_medium_light_skin_tone	1f469-1f3fc-200d-1f4bb	-	+
woman_technologist_tone3	1f469-1f3fd-200d-1f4bb	-	+
woman_technologist_medium_skin_tone	1f469-1f3fd-200d-1f4bb	-	+
woman_technologist_tone4	1f469-1f3fe-200d-1f4bb	-	+
woman_technologist_medium_dark_skin_tone	1f469-1f3fe-200d-1f4bb	-	+
woman_technologist_tone5	1f469-1f3ff-200d-1f4bb	-	+
woman_technologist_dark_skin_tone	1f469-1f3ff-200d-1f4bb	-	+
man_technologist	1f468-200d-1f4bb	people	+
man_technologist_tone1	1f468-1f3fb-200d-1f4bb	-	+
man_technologist_light_skin_tone	1f468-1f3fb-200d-1f4bb	-	+
man_technologist_tone2	1f468-1f3fc-200d-1f4bb	-	+
man_technologist_medium_light_skin_tone	1f468-1f3fc-200d-1f4bb	-	+
man_technologist_tone3	1f468-1f3fd-200d-1f4bb	-	+
man_technologist_medium_skin_tone	1f468-1f3fd-200d-1f4bb	-	+
man_technologist_tone4	1f468-1f3fe-200d-1f4bb	-	+
man_technologist_medium_dark_skin_tone	1f468-1f3fe-200d-1f4bb	-	+
man_technologist_tone5	1f468-1f3ff-200d-1f4bb	-	+
man_technologist_dark_skin_tone	1f468-1f3ff-200d-1f4bb	-	+
office_worker	1f9d1-200d-1f4bc	people	-
office_worker_tone1	1f9d1-1f3fb-200d-1f4bc	-	-
office_worker_light_skin_tone	1f9d1-1f3fb-200d-1f4bc	-	-
office_worker_tone2	1f9d1-1f3fc-200d-1f4bc	-	-
office_worker_medium_light_skin_tone	1f9d1-1f3fc-200d-1f4bc	-	-
office_worker_tone3	1f9d1-1f3fd-200d-1f4bc	-	-
office_worker_medium_skin_tone	1f9d1-1f3fd-200d-1f4bc	-	-
office_worker_tone4	1f9d1-1f3fe-200d-1f4bc	-	-
office_worker_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f4bc	-	-
office_worker_tone5	1f9d1-1f3ff-200d-1f4bc	-	-
office_worker_dark_skin_tone	1f9d1-1f3ff-200d-1f4bc	-	-
woman_office_worker	1f469-200d-1f4bc	people	+
woman_office_worker_tone1	1f469-1f3fb-200d-1f4bc	-	+
woman_office_worker_light_skin_tone	1f469-1f3fb-200d-1f4bc	-	+
woman_office_worker_tone2	1f469-1f3fc-200d-1f4bc	-	+
woman_office_worker_medium_light_skin_tone	1f469-1f3fc-200d-1f4bc	-	+
woman_office_worker_tone3	1f469-1f3fd-200d-1f4bc	-	+
woman_office_worker_medium_skin_tone	1f469-1f3fd-200d-1f4bc	-	+
woman_office_worker_tone4	1f469-1f3fe-200d-1f4bc	-	+
woman_office_worker_medium_dark_skin_tone	1f469-1f3fe-200d-1f4bc	-	+
woman_office_worker_tone5	1f469-1f3ff-200d-1f4bc	-	+
woman_office_worker_dark_skin_tone	1f469-1f3ff-200d-1f4bc	-	+
man_office_worker	1f468-200d-1f4bc	people	+
man_office_worker_tone1	1f468-1f3fb-200d-1f4bc	-	+
man_office_worker_light_skin_tone	1f468-1f3fb-200d-1f4bc	-	+
man_office_worker_tone2	1f468-1f3fc-200d-1f4bc	-	+
man_office_worker_medium_light_skin_tone	1f468-1f3fc-200d-1f4bc	-	+
man_office_worker_tone3	1f468-1f3fd-200d-1f4bc	-	+
man_office_worker_medium_skin_tone	1f468-1f3fd-200d-1f4bc	-	+
man_office_worker_tone4	1f468-1f3fe-200d-1f4bc	-	+
man_office_worker_medium_dark_skin_tone	1f468-1f3fe-200d-1f4bc	-	+
man_office_worker_tone5	1f468-1f3ff-200d-1f4bc	-	+
man_office_worker_dark_skin_tone	1f468-1f3ff-200d-1f4bc	-	+
mechanic	1f9d1-200d-1f527	people	-
mechanic_tone1	1f9d1-1f3fb-200d-1f527	-	-
mechanic_light_skin_tone	1f9d1-1f3fb-200d-1f527	-	-
mechanic_tone2	1f9d1-1f3fc-200d-1f527	-	-
mechanic_medium_light_skin_tone	1f9d1-1f3fc-200d-1f527	-	-
mechanic_tone3	1f9d1-1f3fd-200d-1f527	-	-
mechanic_medium_skin_tone	1f9d1-1f3fd-200d-1f527	-	-
mechanic_tone4	1f9d1-1f3fe-200d-1f527	-	-
mechanic_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f527	-	-
mechanic_tone5	1f9d1-1f3ff-200d-1f527	-	-
mechanic_dark_skin_tone	1f9d1-1f3ff-200d-1f527	-	-
woman_mechanic	1f469-200d-1f527	people	+
woman_mechanic_tone1	1f469-1f3fb-200d-1f527	-	+
woman_mechanic_light_skin_tone	1f469-1f3fb-200d-1f527	-	+
woman_mechanic_tone2	1f469-1f3fc-200d-1f527	-	+
woman_mechanic_medium_light_skin_tone	1f469-1f3fc-200d-1f527	-	+
woman_mechanic_tone3	1f469-1f3fd-200d-1f527	-	+
woman_mechanic_medium_skin_tone	1f469-1f3fd-200d-1f527	-	+
woman_mechanic_tone4	1f469-1f3fe-200d-1f527	-	+
woman_mechanic_medium_dark_skin_tone	1f469-1f3fe-200d-1f527	-	+
woman_mechanic_tone5	1f469-1f3ff-200d-1f527	-	+
woman_mechanic_dark_skin_tone	1f469-1f3ff-200d-1f527	-	+
man_mechanic	1f468-200d-1f527	people	+
man_mechanic_tone1	1f468-1f3fb-200d-1f527	-	+
man_mechanic_light_skin_tone	1f468-1f3fb-200d-1f527	-	+
man_mechanic_tone2	1f468-1f3fc-200d-1f527	-	+
man_mechanic_medium_light_skin_tone	1f468-1f3fc-200d-1f527	-	+
man_mechanic_tone3	1f468-1f3fd-200d-1f527	-	+
man_mechanic_medium_skin_tone	1f468-1f3fd-200d-1f527	-	+
man_mechanic_tone4	1f468-1f3fe-200d-1f527	-	+
man_mechanic_medium_dark_skin_tone	1f468-1f3fe-200d-1f527	-	+
man_mechanic_tone5	1f468-1f3ff-200d-1f527	-	+
man_mechanic_dark_skin_tone	1f468-1f3ff-200d-1f527	-	+
scientist	1f9d1-200d-1f52c	people	-
scientist_tone1	1f9d1-1f3fb-200d-1f52c	-	-
scientist_light_skin_tone	1f9d1-1f3fb-200d-1f52c	-	-
scientist_tone2	1f9d1-1f3fc-200d-1f52c	-	-
scientist_medium_light_skin_tone	1f9d1-1f3fc-200d-1f52c	-	-
scientist_tone3	1f9d1-1f3fd-200d-1f52c	-	-
scientist_medium_skin_tone	1f9d1-1f3fd-200d-1f52c	-	-
scientist_tone4	1f9d1-1f3fe-200d-1f52c	-	-
scientist_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f52c	-	-
scientist_tone5	1f9d1-1f3ff-200d-1f52c	-	-
scientist_dark_skin_tone	1f9d1-1f3ff-200d-1f52c	-	-
woman_scientist	1f469-200d-1f52c	people	+
woman_scientist_tone1	1f469-1f3fb-200d-1f52c	-	+
woman_scientist_light_skin_tone	1f469-1f3fb-200d-1f52c	-	+
woman_scientist_tone2	1f469-1f3fc-200d-1f52c	-	+
woman_scientist_medium_light_skin_tone	1f469-1f3fc-200d-1f52c	-	+
woman_scientist_tone3	1f469-1f3fd-200d-1f52c	-	+
woman_scientist_medium_skin_tone	1f469-1f3fd-200d-1f52c	-	+
woman_scientist_tone4	1f469-1f3fe-200d-1f52c	-	+
woman_scientist_medium_dark_skin_tone	1f469-1f3fe-200d-1f52c	-	+
woman_scientist_tone5	1f469-1f3ff-200d-1f52c	-	+
woman_scientist_dark_skin_tone	1f469-1f3ff-200d-1f52c	-	+
man_scientist	1f468-200d-1f52c	people	+
man_scientist_tone1	1f468-1f3fb-200d-1f52c	-	+
man_scientist_light_skin_tone	1f468-1f3fb-200d-1f52c	-	+
man_scientist_tone2	1f468-1f3fc-200d-1f52c	-	+
man_scientist_medium_light_skin_tone	1f468-1f3fc-200d-1f52c	-	+
man_scientist_tone3	1f468-1f3fd-200d-1f52c	-	+
man_scientist_medium_skin_tone	1f468-1f3fd-200d-1f52c	-	+
man_scientist_tone4	1f468-1f3fe-200d-1f52c	-	+
man_scientist_medium_dark_skin_tone	1f468-1f3fe-200d-1f52c	-	+
man_scientist_tone5	1f468-1f3ff-200d-1f52c	-	+
man_scientist_dark_skin_tone	1f468-1f3ff-200d-1f52c	-	+
artist	1f9d1-200d-1f3a8	people	-
artist_tone1	1f9d1-1f3fb-200d-1f3a8	-	-
artist_light_skin_tone	1f9d1-1f3fb-200d-1f3a8	-	-
artist_tone2	1f9d1-1f3fc-200d-1f3a8	-	-
artist_medium_light_skin_tone	1f9d1-1f3fc-200d-1f3a8	-	-
artist_tone3	1f9d1-1f3fd-200d-1f3a8	-	-
artist_medium_skin_tone	1f9d1-1f3fd-200d-1f3a8	-	-
artist_tone4	1f9d1-1f3fe-200d-1f3a8	-	-
artist_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f3a8	-	-
artist_tone5	1f9d1-1f3ff-200d-1f3a8	-	-
artist_dark_skin_tone	1f9d1-1f3ff-200d-1f3a8	-	-
woman_artist	1f469-200d-1f3a8	people	+
woman_artist_tone1	1f469-1f3fb-200d-1f3a8	-	+
woman_artist_light_skin_tone	1f469-1f3fb-200d-1f3a8	-	+
woman_artist_tone2	1f469-1f3fc-200d-1f3a8	-	+
woman_artist_medium_light_skin_tone	1f469-1f3fc-200d-1f3a8	-	+
woman_artist_tone3	1f469-1f3fd-200d-1f3a8	-	+
woman_artist_medium_skin_tone	1f469-1f3fd-200d-1f3a8	-	+
woman_artist_tone4	1f469-1f3fe-200d-1f3a8	-	+
woman_artist_medium_dark_skin_tone	1f469-1f3fe-200d-1f3a8	-	+
woman_artist_tone5	1f469-1f3ff-200d-1f3a8	-	+
woman_artist_dark_skin_tone	1f469-1f3ff-200d-1f3a8	-	+
man_artist	1f468-200d-1f3a8	people	+
man_artist_tone1	1f468-1f3fb-200d-1f3a8	-	+
man_artist_light_skin_tone	1f468-1f3fb-200d-1f3a8	-	+
man_artist_tone2	1f468-1f3fc-200d-1f3a8	-	+
man_artist_medium_light_skin_tone	1f468-1f3fc-200d-1f3a8	-	+
man_artist_tone3	1f468-1f3fd-200d-1f3a8	-	+
man_artist_medium_skin_tone	1f468-1f3fd-200d-1f3a8	-	+
man_artist_tone4	1f468-1f3fe-200d-1f3a8	-	+
man_artist_medium_dark_skin_tone	1f468-1f3fe-200d-1f3a8	-	+
man_artist_tone5	1f468-1f3ff-200d-1f3a8	-	+
man_artist_dark_skin_tone	1f468-1f3ff-200d-1f3a8	-	+
firefighter	1f9d1-200d-1f692	people	-
firefighter_tone1	1f9d1-1f3fb-200d-1f692	-	-
firefighter_light_skin_tone	1f9d1-1f3fb-200d-1f692	-	-
firefighter_tone2	1f9d1-1f3fc-200d-1f692	-	-
firefighter_medium_light_skin_tone	1f9d1-1f3fc-200d-1f692	-	-
firefighter_tone3	1f9d1-1f3fd-200d-1f692	-	-
firefighter_medium_skin_tone	1f9d1-1f3fd-200d-1f692	-	-
firefighter_tone4	1f9d1-1f3fe-200d-1f692	-	-
firefighter_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f692	-	-
firefighter_tone5	1f9d1-1f3ff-200d-1f692	-	-
firefighter_dark_skin_tone	1f9d1-1f3ff-200d-1f692	-	-
woman_firefighter	1f469-200d-1f692	people	+
woman_firefighter_tone1	1f469-1f3fb-200d-1f692	-	+
woman_firefighter_light_skin_tone	1f469-1f3fb-200d-1f692	-	+
woman_firefighter_tone2	1f469-1f3fc-200d-1f692	-	+
woman_firefighter_medium_light_skin_tone	1f469-1f3fc-200d-1f692	-	+
woman_firefighter_tone3	1f469-1f3fd-200d-1f692	-	+
woman_firefighter_medium_skin_tone	1f469-1f3fd-200d-1f692	-	+
woman_firefighter_tone4	1f469-1f3fe-200d-1f692	-	+
woman_firefighter_medium_dark_skin_tone	1f469-1f3fe-200d-1f692	-	+
woman_firefighter_tone5	1f469-1f3ff-200d-1f692	-	+
woman_firefighter_dark_skin_tone	1f469-1f3ff-200d-1f692	-	+
man_firefighter	1f468-200d-1f692	people	+
man_firefighter_tone1	1f468-1f3fb-200d-1f692	-	+
man_firefighter_light_skin_tone	1f468-1f3fb-200d-1f692	-	+
man_firefighter_tone2	1f468-1f3fc-200d-1f692	-	+
man_firefighter_medium_light_skin_tone	1f468-1f3fc-200d-1f692	-	+
man_firefighter_tone3	1f468-1f3fd-200d-1f692	-	+
man_firefighter_medium_skin_tone	1f468-1f3fd-200d-1f692	-	+
man_firefighter_tone4	1f468-1f3fe-200d-1f692	-	+
man_firefighter_medium_dark_skin_tone	1f468-1f3fe-200d-1f692	-	+
man_firefighter_tone5	1f468-1f3ff-200d-1f692	-	+
man_firefighter_dark_skin_tone	1f468-1f3ff-200d-1f692	-	+
pilot	1f9d1-200d-2708-fe0f	people	-
pilot_tone1	1f9d1-1f3fb-200d-2708-fe0f	-	-
pilot_light_skin_tone	1f9d1-1f3fb-200d-2708-fe0f	-	-
pilot_tone2	1f9d1-1f3fc-200d-2708-fe0f	-	-
pilot_medium_light_skin_tone	1f9d1-1f3fc-200d-2708-fe0f	-	-
pilot_tone3	1f9d1-1f3fd-200d-2708-fe0f	-	-
pilot_medium_skin_tone	1f9d1-1f3fd-200d-2708-fe0f	-	-
pilot_tone4	1f9d1-1f3fe-200d-2708-fe0f	-	-
pilot_medium_dark_skin_tone	1f9d1-1f3fe-200d-2708-fe0f	-	-
pilot_tone5	1f9d1-1f3ff-200d-2708-fe0f	-	-
pilot_dark_skin_tone	1f9d1-1f3ff-200d-2708-fe0f	-	-
woman_pilot	1f469-200d-2708-fe0f	people	+
woman_pilot_tone1	1f469-1f3fb-200d-2708-fe0f	-	+
woman_pilot_light_skin_tone	1f469-1f3fb-200d-2708-fe0f	-	+
woman_pilot_tone2	1f469-1f3fc-200d-2708-fe0f	-	+
woman_pilot_medium_light_skin_tone	1f469-1f3fc-200d-2708-fe0f	-	+
woman_pilot_tone3	1f469-1f3fd-200d-2708-fe0f	-	+
woman_pilot_medium_skin_tone	1f469-1f3fd-200d-2708-fe0f	-	+
woman_pilot_tone4	1f469-1f3fe-200d-2708-fe0f	-	+
woman_pilot_medium_dark_skin_tone	1f469-1f3fe-200d-2708-fe0f	-	+
woman_pilot_tone5	1f469-1f3ff-200d-2708-fe0f	-	+
woman_pilot_dark_skin_tone	1f469-1f3ff-200d-2708-fe0f	-	+
man_pilot	1f468-200d-2708-fe0f	people	+
man_pilot_tone1	1f468-1f3fb-200d-2708-fe0f	-	+
man_pilot_light_skin_tone	1f468-1f3fb-200d-2708-fe0f	-	+
man_pilot_tone2	1f468-1f3fc-200d-2708-fe0f	-	+
man_pilot_medium_light_skin_tone	1f468-1f3fc-200d-2708-fe0f	-	+
man_pilot_tone3	1f468-1f3fd-200d-2708-fe0f	-	+
man_pilot_medium_skin_tone	1f468-1f3fd-200d-2708-fe0f	-	+
man_pilot_tone4	1f468-1f3fe-200d-2708-fe0f	-	+
man_pilot_medium_dark_skin_tone	1f468-1f3fe-200d-2708-fe0f	-	+
man_pilot_tone5	1f468-1f3ff-200d-2708-fe0f	-	+
man_pilot_dark_skin_tone	1f468-1f3ff-200d-2708-fe0f	-	+
astronaut	1f9d1-200d-1f680	people	-
astronaut_tone1	1f9d1-1f3fb-200d-1f680	-	-
astronaut_light_skin_tone	1f9d1-1f3fb-200d-1f680	-	-
astronaut_tone2	1f9d1-1f3fc-200d-1f680	-	-
astronaut_medium_light_skin_tone	1f9d1-1f3fc-200d-1f680	-	-
astronaut_tone3	1f9d1-1f3fd-200d-1f680	-	-
astronaut_medium_skin_tone	1f9d1-1f3fd-200d-1f680	-	-
astronaut_tone4	1f9d1-1f3fe-200d-1f680	-	-
astronaut_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f680	-	-
astronaut_tone5	1f9d1-1f3ff-200d-1f680	-	-
astronaut_dark_skin_tone	1f9d1-1f3ff-200d-1f680	-	-
woman_astronaut	1f469-200d-1f680	people	+
woman_astronaut_tone1	1f469-1f3fb-200d-1f680	-	+
woman_astronaut_light_skin_tone	1f469-1f3fb-200d-1f680	-	+
woman_astronaut_tone2	1f469-1f3fc-200d-1f680	-	+
woman_astronaut_medium_light_skin_tone	1f469-1f3fc-200d-1f680	-	+
woman_astronaut_tone3	1f469-1f3fd-200d-1f680	-	+
woman_astronaut_medium_skin_tone	1f469-1f3fd-200d-1f680	-	+
woman_astronaut_tone4	1f469-1f3fe-200d-1f680	-	+
woman_astronaut_medium_dark_skin_tone	1f469-1f3fe-200d-1f680	-	+
woman_astronaut_tone5	1f469-1f3ff-200d-1f680	-	+
woman_astronaut_dark_skin_tone	1f469-1f3ff-200d-1f680	-	+
man_astronaut	1f468-200d-1f680	people	+
man_astronaut_tone1	1f468-1f3fb-200d-1f680	-	+
man_astronaut_light_skin_tone	1f468-1f3fb-200d-1f680	-	+
man_astronaut_tone2	1f468-1f3fc-200d-1f680	-	+
man_astronaut_medium_light_skin_tone	1f468-1f3fc-200d-1f680	-	+
man_astronaut_tone3	1f468-1f3fd-200d-1f680	-	+
man_astronaut_medium_skin_tone	1f468-1f3fd-200d-1f680	-	+
man_astronaut_tone4	1f468-1f3fe-200d-1f680	-	+
man_astronaut_medium_dark_skin_tone	1f468-1f3fe-200d-1f680	-	+
man_astronaut_tone5	1f468-1f3ff-200d-1f680	-	+
man_astronaut_dark_skin_tone	1f468-1f3ff-200d-1f680	-	+
judge	1f9d1-200d-2696-fe0f	people	-
judge_tone1	1f9d1-1f3fb-200d-2696-fe0f	-	-
judge_light_skin_tone	1f9d1-1f3fb-200d-2696-fe0f	-	-
judge_tone2	1f9d1-1f3fc-200d-2696-fe0f	-	-
judge_medium_light_skin_tone	1f9d1-1f3fc-200d-2696-fe0f	-	-
judge_tone3	1f9d1-1f3fd-200d-2696-fe0f	-	-
judge_medium_skin_tone	1f9d1-1f3fd-200d-2696-fe0f	-	-
judge_tone4	1f9d1-1f3fe-200d-2696-fe0f	-	-
judge_medium_dark_skin_tone	1f9d1-1f3fe-200d-2696-fe0f	-	-
judge_tone5	1f9d1-1f3ff-200d-2696-fe0f	-	-
judge_dark_skin_tone	1f9d1-1f3ff-200d-2696-fe0f	-	-
woman_judge	1f469-200d-2696-fe0f	people	+
woman_judge_tone1	1f469-1f3fb-200d-2696-fe0f	-	+
woman_judge_light_skin_tone	1f469-1f3fb-200d-2696-fe0f	-	+
woman_judge_tone2	1f469-1f3fc-200d-2696-fe0f	-	+
woman_judge_medium_light_skin_tone	1f469-1f3fc-200d-2696-fe0f	-	+
woman_judge_tone3	1f469-1f3fd-200d-2696-fe0f	-	+
woman_judge_medium_skin_tone	1f469-1f3fd-200d-2696-fe0f	-	+
woman_judge_tone4	1f469-1f3fe-200d-2696-fe0f	-	+
woman_judge_medium_dark_skin_tone	1f469-1f3fe-200d-2696-fe0f	-	+
woman_judge_tone5	1f469-1f3ff-200d-2696-fe0f	-	+
woman_judge_dark_skin_tone	1f469-1f3ff-200d-2696-fe0f	-	+
man_judge	1f468-200d-2696-fe0f	people	+
man_judge_tone1	1f468-1f3fb-200d-2696-fe0f	-	+
man_judge_light_skin_tone	1f468-1f3fb-200d-2696-fe0f	-	+
man_judge_tone2	1f468-1f3fc-200d-2696-fe0f	-	+
man_judge_medium_light_skin_tone	1f468-1f3fc-200d-2696-fe0f	-	+
man_judge_tone3	1f468-1f3fd-200d-2696-fe0f	-	+
man_judge_medium_skin_tone	1f468-1f3fd-200d-2696-fe0f	-	+
man_judge_tone4	1f468-1f3fe-200d-2696-fe0f	-	+
man_judge_medium_dark_skin_tone	1f468-1f3fe-200d-2696-fe0f	-	+
man_judge_tone5	1f468-1f3ff-200d-2696-fe0f	-	+
man_judge_dark_skin_tone	1f468-1f3ff-200d-2696-fe0f	-	+
person_with_veil	1f470	people	-
person_with_veil_tone1	1f470-1f3fb	-	-
person_with_veil_tone2	1f470-1f3fc	-	-
person_with_veil_tone3	1f470-1f3fd	-	-
person_with_veil_tone4	1f470-1f3fe	-	-
person_with_veil_tone5	1f470-1f3ff	-	-
woman_with_veil	1f470-200d-2640-fe0f	people	-
woman_with_veil_tone1	1f470-1f3fb-200d-2640-fe0f	-	-
woman_with_veil_light_skin_tone	1f470-1f3fb-200d-2640-fe0f	-	-
woman_with_veil_tone2	1f470-1f3fc-200d-2640-fe0f	-	-
woman_with_veil_medium_light_skin_tone	1f470-1f3fc-200d-2640-fe0f	-	-
woman_with_veil_tone3	1f470-1f3fd-200d-2640-fe0f	-	-
woman_with_veil_medium_skin_tone	1f470-1f3fd-200d-2640-fe0f	-	-
woman_with_veil_tone4	1f470-1f3fe-200d-2640-fe0f	-	-
woman_with_veil_medium_dark_skin_tone	1f470-1f3fe-200d-2640-fe0f	-	-
woman_with_veil_tone5	1f470-1f3ff-200d-2640-fe0f	-	-
woman_with_veil_dark_skin_tone	1f470-1f3ff-200d-2640-fe0f	-	-
man_with_veil	1f470-200d-2642-fe0f	people	-
man_with_veil_tone1	1f470-1f3fb-200d-2642-fe0f	-	-
man_with_veil_light_skin_tone	1f470-1f3fb-200d-2642-fe0f	-	-
man_with_veil_tone2	1f470-1f3fc-200d-2642-fe0f	-	-
man_with_veil_medium_light_skin_tone	1f470-1f3fc-200d-2642-fe0f	-	-
man_with_veil_tone3	1f470-1f3fd-200d-2642-fe0f	-	-
man_with_veil_medium_skin_tone	1f470-1f3fd-200d-2642-fe0f	-	-
man_with_veil_tone4	1f470-1f3fe-200d-2642-fe0f	-	-
man_with_veil_medium_dark_skin_tone	1f470-1f3fe-200d-2642-fe0f	-	-
man_with_veil_tone5	1f470-1f3ff-200d-2642-fe0f	-	-
man_with_veil_dark_skin_tone	1f470-1f3ff-200d-2642-fe0f	-	-
person_in_tuxedo	1f935	people	-
person_in_tuxedo_tone1	1f935-1f3fb	-	-
tuxedo_tone1	1f935-1f3fb	-	+
person_in_tuxedo_tone2	1f935-1f3fc	-	-
tuxedo_tone2	1f935-1f3fc	-	+
person_in_tuxedo_tone3	1f935-1f3fd	-	-
tuxedo_tone3	1f935-1f3fd	-	+
person_in_tuxedo_tone4	1f935-1f3fe	-	-
tuxedo_tone4	1f935-1f3fe	-	+
person_in_tuxedo_tone5	1f935-1f3ff	-	-
tuxedo_tone5	1f935-1f3ff	-	+
woman_in_tuxedo	1f935-200d-2640-fe0f	people	-
woman_in_tuxedo_tone1	1f935-1f3fb-200d-2640-fe0f	-	-
woman_in_tuxedo_light_skin_tone	1f935-1f3fb-200d-2640-fe0f	-	-
woman_in_tuxedo_tone2	1f935-1f3fc-200d-2640-fe0f	-	-
woman_in_tuxedo_medium_light_skin_tone	1f935-1f3fc-200d-2640-fe0f	-	-
woman_in_tuxedo_tone3	1f935-1f3fd-200d-2640-fe0f	-	-
woman_in_tuxedo_medium_skin_tone	1f935-1f3fd-200d-2640-fe0f	-	-
woman_in_tuxedo_tone4	1f935-1f3fe-200d-2640-fe0f	-	-
woman_in_tuxedo_medium_dark_skin_tone	1f935-1f3fe-200d-2640-fe0f	-	-
woman_in_tuxedo_tone5	1f935-1f3ff-200d-2640-fe0f	-	-
woman_in_tuxedo_dark_skin_tone	1f935-1f3ff-200d-2640-fe0f	-	-
man_in_tuxedo	1f935-200d-2642-fe0f	people	+
man_in_tuxedo_tone1	1f935-1f3fb-200d-2642-fe0f	-	+
man_in_tuxedo_light_skin_tone	1f935-1f3fb-200d-2642-fe0f	-	-
man_in_tuxedo_tone2	1f935-1f3fc-200d-2642-fe0f	-	+
man_in_tuxedo_medium_light_skin_tone	1f935-1f3fc-200d-2642-fe0f	-	-
man_in_tuxedo_tone3	1f935-1f3fd-200d-2642-fe0f	-	+
man_in_tuxedo_medium_skin_tone	1f935-1f3fd-200d-2642-fe0f	-	-
man_in_tuxedo_tone4	1f935-1f3fe-200d-2642-fe0f	-	+
man_in_tuxedo_medium_dark_skin_tone	1f935-1f3fe-200d-2642-fe0f	-	-
man_in_tuxedo_tone5	1f935-1f3ff-200d-2642-fe0f	-	+
man_in_tuxedo_dark_skin_tone	1f935-1f3ff-200d-2642-fe0f	-	-
person_with_crown	1fac5	people	-
person_with_crown_tone1	1fac5-1f3fb	-	-
person_with_crown_light_skin_tone	1fac5-1f3fb	-	-
person_with_crown_tone2	1fac5-1f3fc	-	-
person_with_crown_medium_light_skin_tone	1fac5-1f3fc	-	-
person_with_crown_tone3	1fac5-1f3fd	-	-
person_with_crown_medium_skin_tone	1fac5-1f3fd	-	-
person_with_crown_tone4	1fac5-1f3fe	-	-
person_with_crown_medium_dark_skin_tone	1fac5-1f3fe	-	-
person_with_crown_tone5	1fac5-1f3ff	-	-
person_with_crown_dark_skin_tone	1fac5-1f3ff	-	-
princess	1f478	people	+
princess_tone1	1f478-1f3fb	-	+
princess_tone2	1f478-1f3fc	-	+
princess_tone3	1f478-1f3fd	-	+
princess_tone4	1f478-1f3fe	-	+
princess_tone5	1f478-1f3ff	-	+
prince	1f934	people	+
prince_tone1	1f934-1f3fb	-	+
prince_tone2	1f934-1f3fc	-	+
prince_tone3	1f934-1f3fd	-	+
prince_tone4	1f934-1f3fe	-	+
prince_tone5	1f934-1f3ff	-	+
superhero	1f9b8	people	+
superhero_tone1	1f9b8-1f3fb	-	+
superhero_light_skin_tone	1f9b8-1f3fb	-	+
superhero_tone2	1f9b8-1f3fc	-	+
superhero_medium_light_skin_tone	1f9b8-1f3fc	-	+
superhero_tone3	1f9b8-1f3fd	-	+
superhero_medium_skin_tone	1f9b8-1f3fd	-	+
superhero_tone4	1f9b8-1f3fe	-	+
superhero_medium_dark_skin_tone	1f9b8-1f3fe	-	+
superhero_tone5	1f9b8-1f3ff	-	+
superhero_dark_skin_tone	1f9b8-1f3ff	-	+
woman_superhero	1f9b8-200d-2640-fe0f	people	+
woman_superhero_tone1	1f9b8-1f3fb-200d-2640-fe0f	-	+
woman_superhero_light_skin_tone	1f9b8-1f3fb-200d-2640-fe0f	-	+
woman_superhero_tone2	1f9b8-1f3fc-200d-2640-fe0f	-	+
woman_superhero_medium_light_skin_tone	1f9b8-1f3fc-200d-2640-fe0f	-	+
woman_superhero_tone3	1f9b8-1f3fd-200d-2640-fe0f	-	+
woman_superhero_medium_skin_tone	1f9b8-1f3fd-200d-2640-fe0f	-	+
woman_superhero_tone4	1f9b8-1f3fe-200d-2640-fe0f	-	+
woman_superhero_medium_dark_skin_tone	1f9b8-1f3fe-200d-2640-fe0f	-	+
woman_superhero_tone5	1f9b8-1f3ff-200d-2640-fe0f	-	+
woman_superhero_dark_skin_tone	1f9b8-1f3ff-200d-2640-fe0f	-	+
man_superhero	1f9b8-200d-2642-fe0f	people	+
man_superhero_tone1	1f9b8-1f3fb-200d-2642-fe0f	-	+
man_superhero_light_skin_tone	1f9b8-1f3fb-200d-2642-fe0f	-	+
man_superhero_tone2	1f9b8-1f3fc-200d-2642-fe0f	-	+
man_superhero_medium_light_skin_tone	1f9b8-1f3fc-200d-2642-fe0f	-	+
man_superhero_tone3	1f9b8-1f3fd-200d-2642-fe0f	-	+
man_superhero_medium_skin_tone	1f9b8-1f3fd-200d-2642-fe0f	-	+
man_superhero_tone4	1f9b8-1f3fe-200d-2642-fe0f	-	+
man_superhero_medium_dark_skin_tone	1f9b8-1f3fe-200d-2642-fe0f	-	+
man_superhero_tone5	1f9b8-1f3ff-200d-2642-fe0f	-	+
man_superhero_dark_skin_tone	1f9b8-1f3ff-200d-2642-fe0f	-	+
supervillain	1f9b9	people	+
supervillain_tone1	1f9b9-1f3fb	-	+
supervillain_light_skin_tone	1f9b9-1f3fb	-	+
supervillain_tone2	1f9b9-1f3fc	-	+
supervillain_medium_light_skin_tone	1f9b9-1f3fc	-	+
supervillain_tone3	1f9b9-1f3fd	-	+
supervillain_medium_skin_tone	1f9b9-1f3fd	-	+
supervillain_tone4	1f9b9-1f3fe	-	+
supervillain_medium_dark_skin_tone	1f9b9-1f3fe	-	+
supervillain_tone5	1f9b9-1f3ff	-	+
supervillain_dark_skin_tone	1f9b9-1f3ff	-	+
woman_supervillain	1f9b9-200d-2640-fe0f	people	+
woman_supervillain_tone1	1f9b9-1f3fb-200d-2640-fe0f	-	+
woman_supervillain_light_skin_tone	1f9b9-1f3fb-200d-2640-fe0f	-	+
woman_supervillain_tone2	1f9b9-1f3fc-200d-2640-fe0f	-	+
woman_supervillain_medium_light_skin_tone	1f9b9-1f3fc-200d-2640-fe0f	-	+
woman_supervillain_tone3	1f9b9-1f3fd-200d-2640-fe0f	-	+
woman_supervillain_medium_skin_tone	1f9b9-1f3fd-200d-2640-fe0f	-	+
woman_supervillain_tone4	1f9b9-1f3fe-200d-2640-fe0f	-	+
woman_supervillain_medium_dark_skin_tone	1f9b9-1f3fe-200d-2640-fe0f	-	+
woman_supervillain_tone5	1f9b9-1f3ff-200d-2640-fe0f	-	+
woman_supervillain_dark_skin_tone	1f9b9-1f3ff-200d-2640-fe0f	-	+
man_supervillain	1f9b9-200d-2642-fe0f	people	+
man_supervillain_tone1	1f9b9-1f3fb-200d-2642-fe0f	-	+
man_supervillain_light_skin_tone	1f9b9-1f3fb-200d-2642-fe0f	-	+
man_supervillain_tone2	1f9b9-1f3fc-200d-2642-fe0f	-	+
man_supervillain_medium_light_skin_tone	1f9b9-1f3fc-200d-2642-fe0f	-	+
man_supervillain_tone3	1f9b9-1f3fd-200d-2642-fe0f	-	+
man_supervillain_medium_skin_tone	1f9b9-1f3fd-200d-2642-fe0f	-	+
man_supervillain_tone4	1f9b9-1f3fe-200d-2642-fe0f	-	+
man_supervillain_medium_dark_skin_tone	1f9b9-1f3fe-200d-2642-fe0f	-	+
man_supervillain_tone5	1f9b9-1f3ff-200d-2642-fe0f	-	+
man_supervillain_dark_skin_tone	1f9b9-1f3ff-200d-2642-fe0f	-	+
ninja	1f977	people	-
ninja_tone1	1f977-1f3fb	-	-
ninja_light_skin_tone	1f977-1f3fb	-	-
ninja_tone2	1f977-1f3fc	-	-
ninja_medium_light_skin_tone	1f977-1f3fc	-	-
ninja_tone3	1f977-1f3fd	-	-
ninja_medium_skin_tone	1f977-1f3fd	-	-
ninja_tone4	1f977-1f3fe	-	-
ninja_medium_dark_skin_tone	1f977-1f3fe	-	-
ninja_tone5	1f977-1f3ff	-	-
ninja_dark_skin_tone	1f977-1f3ff	-	-
mx_claus	1f9d1-200d-1f384	people	-
mx_claus_tone1	1f9d1-1f3fb-200d-1f384	-	-
mx_claus_light_skin_tone	1f9d1-1f3fb-200d-1f384	-	-
mx_claus_tone2	1f9d1-1f3fc-200d-1f384	-	-
mx_claus_medium_light_skin_tone	1f9d1-1f3fc-200d-1f384	-	-
mx_claus_tone3	1f9d1-1f3fd-200d-1f384	-	-
mx_claus_medium_skin_tone	1f9d1-1f3fd-200d-1f384	-	-
mx_claus_tone4	1f9d1-1f3fe-200d-1f384	-	-
mx_claus_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f384	-	-
mx_claus_tone5	1f9d1-1f3ff-200d-1f384	-	-
mx_claus_dark_skin_tone	1f9d1-1f3ff-200d-1f384	-	-
mrs_claus	1f936	people	+
mother_christmas	1f936	-	+
mrs_claus_tone1	1f936-1f3fb	-	+
mother_christmas_tone1	1f936-1f3fb	-	+
mrs_claus_tone2	1f936-1f3fc	-	+
mother_christmas_tone2	1f936-1f3fc	-	+
mrs_claus_tone3	1f936-1f3fd	-	+
mother_christmas_tone3	1f936-1f3fd	-	+
mrs_claus_tone4	1f936-1f3fe	-	+
mother_christmas_tone4	1f936-1f3fe	-	+
mrs_claus_tone5	1f936-1f3ff	-	+
mother_christmas_tone5	1f936-1f3ff	-	+
santa	1f385	people	+
santa_claus	1f385	-	-
santa_tone1	1f385-1f3fb	-	+
santa_tone2	1f385-1f3fc	-	+
santa_tone3	1f385-1f3fd	-	+
santa_tone4	1f385-1f3fe	-	+
santa_tone5	1f385-1f3ff	-	+
mage	1f9d9	people	+
mage_tone1	1f9d9-1f3fb	-	+
mage_light_skin_tone	1f9d9-1f3fb	-	+
mage_tone2	1f9d9-1f3fc	-	+
mage_medium_light_skin_tone	1f9d9-1f3fc	-	+
mage_tone3	1f9d9-1f3fd	-	+
mage_medium_skin_tone	1f9d9-1f3fd	-	+
mage_tone4	1f9d9-1f3fe	-	+
mage_medium_dark_skin_tone	1f9d9-1f3fe	-	+
mage_tone5	1f9d9-1f3ff	-	+
mage_dark_skin_tone	1f9d9-1f3ff	-	+
woman_mage	1f9d9-200d-2640-fe0f	people	+
woman_mage_tone1	1f9d9-1f3fb-200d-2640-fe0f	-	+
woman_mage_light_skin_tone	1f9d9-1f3fb-200d-2640-fe0f	-	+
woman_mage_tone2	1f9d9-1f3fc-200d-2640-fe0f	-	+
woman_mage_medium_light_skin_tone	1f9d9-1f3fc-200d-2640-fe0f	-	+
woman_mage_tone3	1f9d9-1f3fd-200d-2640-fe0f	-	+
woman_mage_medium_skin_tone	1f9d9-1f3fd-200d-2640-fe0f	-	+
woman_mage_tone4	1f9d9-1f3fe-200d-2640-fe0f	-	+
woman_mage_medium_dark_skin_tone	1f9d9-1f3fe-200d-2640-fe0f	-	+
woman_mage_tone5	1f9d9-1f3ff-200d-2640-fe0f	-	+
woman_mage_dark_skin_tone	1f9d9-1f3ff-200d-2640-fe0f	-	+
man_mage	1f9d9-200d-2642-fe0f	people	+
man_mage_tone1	1f9d9-1f3fb-200d-2642-fe0f	-	+
man_mage_light_skin_tone	1f9d9-1f3fb-200d-2642-fe0f	-	+
man_mage_tone2	1f9d9-1f3fc-200d-2642-fe0f	-	+
man_mage_medium_light_skin_tone	1f9d9-1f3fc-200d-2642-fe0f	-	+
man_mage_tone3	1f9d9-1f3fd-200d-2642-fe0f	-	+
man_mage_medium_skin_tone	1f9d9-1f3fd-200d-2642-fe0f	-	+
man_mage_tone4	1f9d9-1f3fe-200d-2642-fe0f	-	+
man_mage_medium_dark_skin_tone	1f9d9-1f3fe-200d-2642-fe0f	-	+
man_mage_tone5	1f9d9-1f3ff-200d-2642-fe0f	-	+
man_mage_dark_skin_tone	1f9d9-1f3ff-200d-2642-fe0f	-	+
elf	1f9dd	people	+
elf_tone1	1f9dd-1f3fb	-	+
elf_light_skin_tone	1f9dd-1f3fb	-	+
elf_tone2	1f9dd-1f3fc	-	+
elf_medium_light_skin_tone	1f9dd-1f3fc	-	+
elf_tone3	1f9dd-1f3fd	-	+
elf_medium_skin_tone	1f9dd-1f3fd	-	+
elf_tone4	1f9dd-1f3fe	-	+
elf_medium_dark_skin_tone	1f9dd-1f3fe	-	+
elf_tone5	1f9dd-1f3ff	-	+
elf_dark_skin_tone	1f9dd-1f3ff	-	+
woman_elf	1f9dd-200d-2640-fe0f	people	+
woman_elf_tone1	1f9dd-1f3fb-200d-2640-fe0f	-	+
woman_elf_light_skin_tone	1f9dd-1f3fb-200d-2640-fe0f	-	+
woman_elf_tone2	1f9dd-1f3fc-200d-2640-fe0f	-	+
woman_elf_medium_light_skin_tone	1f9dd-1f3fc-200d-2640-fe0f	-	+
woman_elf_tone3	1f9dd-1f3fd-200d-2640-fe0f	-	+
woman_elf_medium_skin_tone	1f9dd-1f3fd-200d-2640-fe0f	-	+
woman_elf_tone4	1f9dd-1f3fe-200d-2640-fe0f	-	+
woman_elf_medium_dark_skin_tone	1f9dd-1f3fe-200d-2640-fe0f	-	+
woman_elf_tone5	1f9dd-1f3ff-200d-2640-fe0f	-	+
woman_elf_dark_skin_tone	1f9dd-1f3ff-200d-2640-fe0f	-	+
man_elf	1f9dd-200d-2642-fe0f	people	+
man_elf_tone1	1f9dd-1f3fb-200d-2642-fe0f	-	+
man_elf_light_skin_tone	1f9dd-1f3fb-200d-2642-fe0f	-	+
man_elf_tone2	1f9dd-1f3fc-200d-2642-fe0f	-	+
man_elf_medium_light_skin_tone	1f9dd-1f3fc-200d-2642-fe0f	-	+
man_elf_tone3	1f9dd-1f3fd-200d-2642-fe0f	-	+
man_elf_medium_skin_tone	1f9dd-1f3fd-200d-2642-fe0f	-	+
man_elf_tone4	1f9dd-1f3fe-200d-2642-fe0f	-	+
man_elf_medium_dark_skin_tone	1f9dd-1f3fe-200d-2642-fe0f	-	+
man_elf_tone5	1f9dd-1f3ff-200d-2642-fe0f	-	+
man_elf_dark_skin_tone	1f9dd-1f3ff-200d-2642-fe0f	-	+
troll	1f9cc	people	-
vampire	1f9db	people	+
vampire_tone1	1f9db-1f3fb	-	+
vampire_light_skin_tone	1f9db-1f3fb	-	+
vampire_tone2	1f9db-1f3fc	-	+
vampire_medium_light_skin_tone	1f9db-1f3fc	-	+
vampire_tone3	1f9db-1f3fd	-	+
vampire_medium_skin_tone	1f9db-1f3fd	-	+
vampire_tone4	1f9db-1f3fe	-	+
vampire_medium_dark_skin_tone	1f9db-1f3fe	-	+
vampire_tone5	1f9db-1f3ff	-	+
vampire_dark_skin_tone	1f9db-1f3ff	-	+
woman_vampire	1f9db-200d-2640-fe0f	people	+
woman_vampire_tone1	1f9db-1f3fb-200d-2640-fe0f	-	+
woman_vampire_light_skin_tone	1f9db-1f3fb-200d-2640-fe0f	-	+
woman_vampire_tone2	1f9db-1f3fc-200d-2640-fe0f	-	+
woman_vampire_medium_light_skin_tone	1f9db-1f3fc-200d-2640-fe0f	-	+
woman_vampire_tone3	1f9db-1f3fd-200d-2640-fe0f	-	+
woman_vampire_medium_skin_tone	1f9db-1f3fd-200d-2640-fe0f	-	+
woman_vampire_tone4	1f9db-1f3fe-200d-2640-fe0f	-	+
woman_vampire_medium_dark_skin_tone	1f9db-1f3fe-200d-2640-fe0f	-	+
woman_vampire_tone5	1f9db-1f3ff-200d-2640-fe0f	-	+
woman_vampire_dark_skin_tone	1f9db-1f3ff-200d-2640-fe0f	-	+
man_vampire	1f9db-200d-2642-fe0f	people	+
man_vampire_tone1	1f9db-1f3fb-200d-2642-fe0f	-	+
man_vampire_light_skin_tone	1f9db-1f3fb-200d-2642-fe0f	-	+
man_vampire_tone2	1f9db-1f3fc-200d-2642-fe0f	-	+
man_vampire_medium_light_skin_tone	1f9db-1f3fc-200d-2642-fe0f	-	+
man_vampire_tone3	1f9db-1f3fd-200d-2642-fe0f	-	+
man_vampire_medium_skin_tone	1f9db-1f3fd-200d-2642-fe0f	-	+
man_vampire_tone4	1f9db-1f3fe-200d-2642-fe0f	-	+
man_vampire_medium_dark_skin_tone	1f9db-1f3fe-200d-2642-fe0f	-	+
man_vampire_tone5	1f9db-1f3ff-200d-2642-fe0f	-	+
man_vampire_dark_skin_tone	1f9db-1f3ff-200d-2642-fe0f	-	+
zombie	1f9df	people	+
woman_zombie	1f9df-200d-2640-fe0f	people	+
man_zombie	1f9df-200d-2642-fe0f	people	+
genie	1f9de	people	+
woman_genie	1f9de-200d-2640-fe0f	people	+
man_genie	1f9de-200d-2642-fe0f	people	+
merperson	1f9dc	people	+
merperson_tone1	1f9dc-1f3fb	-	+
merperson_light_skin_tone	1f9dc-1f3fb	-	+
merperson_tone2	1f9dc-1f3fc	-	+
merperson_medium_light_skin_tone	1f9dc-1f3fc	-	+
merperson_tone3	1f9dc-1f3fd	-	+
merperson_medium_skin_tone	1f9dc-1f3fd	-	+
merperson_tone4	1f9dc-1f3fe	-	+
merperson_medium_dark_skin_tone	1f9dc-1f3fe	-	+
merperson_tone5	1f9dc-1f3ff	-	+
merperson_dark_skin_tone	1f9dc-1f3ff	-	+
mermaid	1f9dc-200d-2640-fe0f	people	+
mermaid_tone1	1f9dc-1f3fb-200d-2640-fe0f	-	+
mermaid_light_skin_tone	1f9dc-1f3fb-200d-2640-fe0f	-	+
mermaid_tone2	1f9dc-1f3fc-200d-2640-fe0f	-	+
mermaid_medium_light_skin_tone	1f9dc-1f3fc-200d-2640-fe0f	-	+
mermaid_tone3	1f9dc-1f3fd-200d-2640-fe0f	-	+
mermaid_medium_skin_tone	1f9dc-1f3fd-200d-2640-fe0f	-	+
mermaid_tone4	1f9dc-1f3fe-200d-2640-fe0f	-	+
mermaid_medium_dark_skin_tone	1f9dc-1f3fe-200d-2640-fe0f	-	+
mermaid_tone5	1f9dc-1f3ff-200d-2640-fe0f	-	+
mermaid_dark_skin_tone	1f9dc-1f3ff-200d-2640-fe0f	-	+
merman	1f9dc-200d-2642-fe0f	people	+
merman_tone1	1f9dc-1f3fb-200d-2642-fe0f	-	+
merman_light_skin_tone	1f9dc-1f3fb-200d-2642-fe0f	-	+
merman_tone2	1f9dc-1f3fc-200d-2642-fe0f	-	+
merman_medium_light_skin_tone	1f9dc-1f3fc-200d-2642-fe0f	-	+
merman_tone3	1f9dc-1f3fd-200d-2642-fe0f	-	+
merman_medium_skin_tone	1f9dc-1f3fd-200d-2642-fe0f	-	+
merman_tone4	1f9dc-1f3fe-200d-2642-fe0f	-	+
merman_medium_dark_skin_tone	1f9dc-1f3fe-200d-2642-fe0f	-	+
merman_tone5	1f9dc-1f3ff-200d-2642-fe0f	-	+
merman_dark_skin_tone	1f9dc-1f3ff-200d-2642-fe0f	-	+
fairy	1f9da	people	+
fairy_tone1	1f9da-1f3fb	-	+
fairy_light_skin_tone	1f9da-1f3fb	-	+
fairy_tone2	1f9da-1f3fc	-	+
fairy_medium_light_skin_tone	1f9da-1f3fc	-	+
fairy_tone3	1f9da-1f3fd	-	+
fairy_medium_skin_tone	1f9da-1f3fd	-	+
fairy_tone4	1f9da-1f3fe	-	+
fairy_medium_dark_skin_tone	1f9da-1f3fe	-	+
fairy_tone5	1f9da-1f3ff	-	+
fairy_dark_skin_tone	1f9da-1f3ff	-	+
woman_fairy	1f9da-200d-2640-fe0f	people	+
woman_fairy_tone1	1f9da-1f3fb-200d-2640-fe0f	-	+
woman_fairy_light_skin_tone	1f9da-1f3fb-200d-2640-fe0f	-	+
woman_fairy_tone2	1f9da-1f3fc-200d-2640-fe0f	-	+
woman_fairy_medium_light_skin_tone	1f9da-1f3fc-200d-2640-fe0f	-	+
woman_fairy_tone3	1f9da-1f3fd-200d-2640-fe0f	-	+
woman_fairy_medium_skin_tone	1f9da-1f3fd-200d-2640-fe0f	-	+
woman_fairy_tone4	1f9da-1f3fe-200d-2640-fe0f	-	+
woman_fairy_medium_dark_skin_tone	1f9da-1f3fe-200d-2640-fe0f	-	+
woman_fairy_tone5	1f9da-1f3ff-200d-2640-fe0f	-	+
woman_fairy_dark_skin_tone	1f9da-1f3ff-200d-2640-fe0f	-	+
man_fairy	1f9da-200d-2642-fe0f	people	+
man_fairy_tone1	1f9da-1f3fb-200d-2642-fe0f	-	+
man_fairy_light_skin_tone	1f9da-1f3fb-200d-2642-fe0f	-	+
man_fairy_tone2	1f9da-1f3fc-200d-2642-fe0f	-	+
man_fairy_medium_light_skin_tone	1f9da-1f3fc-200d-2642-fe0f	-	+
man_fairy_tone3	1f9da-1f3fd-200d-2642-fe0f	-	+
man_fairy_medium_skin_tone	1f9da-1f3fd-200d-2642-fe0f	-	+
man_fairy_tone4	1f9da-1f3fe-200d-2642-fe0f	-	+
man_fairy_medium_dark_skin_tone	1f9da-1f3fe-200d-2642-fe0f	-	+
man_fairy_tone5	1f9da-1f3ff-200d-2642-fe0f	-	+
man_fairy_dark_skin_tone	1f9da-1f3ff-200d-2642-fe0f	-	+
angel	1f47c	people	+
baby_angel	1f47c	-	-
angel_tone1	1f47c-1f3fb	-	+
angel_tone2	1f47c-1f3fc	-	+
angel_tone3	1f47c-1f3fd	-	+
angel_tone4	1f47c-1f3fe	-	+
angel_tone5	1f47c-1f3ff	-	+
pregnant_person	1fac4	people	-
pregnant_person_tone1	1fac4-1f3fb	-	-
pregnant_person_light_skin_tone	1fac4-1f3fb	-	-
pregnant_person_tone2	1fac4-1f3fc	-	-
pregnant_person_medium_light_skin_tone	1fac4-1f3fc	-	-
pregnant_person_tone3	1fac4-1f3fd	-	-
pregnant_person_medium_skin_tone	1fac4-1f3fd	-	-
pregnant_person_tone4	1fac4-1f3fe	-	-
pregnant_person_medium_dark_skin_tone	1fac4-1f3fe	-	-
pregnant_person_tone5	1fac4-1f3ff	-	-
pregnant_person_dark_skin_tone	1fac4-1f3ff	-	-
pregnant_woman	1f930	people	+
expecting_woman	1f930	-	+
pregnant_woman_tone1	1f930-1f3fb	-	+
expecting_woman_tone1	1f930-1f3fb	-	+
pregnant_woman_tone2	1f930-1f3fc	-	+
expecting_woman_tone2	1f930-1f3fc	-	+
pregnant_woman_tone3	1f930-1f3fd	-	+
expecting_woman_tone3	1f930-1f3fd	-	+
pregnant_woman_tone4	1f930-1f3fe	-	+
expecting_woman_tone4	1f930-1f3fe	-	+
pregnant_woman_tone5	1f930-1f3ff	-	+
expecting_woman_tone5	1f930-1f3ff	-	+
pregnant_man	1fac3	people	-
pregnant_man_tone1	1fac3-1f3fb	-	-
pregnant_man_light_skin_tone	1fac3-1f3fb	-	-
pregnant_man_tone2	1fac3-1f3fc	-	-
pregnant_man_medium_light_skin_tone	1fac3-1f3fc	-	-
pregnant_man_tone3	1fac3-1f3fd	-	-
pregnant_man_medium_skin_tone	1fac3-1f3fd	-	-
pregnant_man_tone4	1fac3-1f3fe	-	-
pregnant_man_medium_dark_skin_tone	1fac3-1f3fe	-	-
pregnant_man_tone5	1fac3-1f3ff	-	-
pregnant_man_dark_skin_tone	1fac3-1f3ff	-	-
breast_feeding	1f931	people	+
breast_feeding_tone1	1f931-1f3fb	-	+
breast_feeding_light_skin_tone	1f931-1f3fb	-	+
breast_feeding_tone2	1f931-1f3fc	-	+
breast_feeding_medium_light_skin_tone	1f931-1f3fc	-	+
breast_feeding_tone3	1f931-1f3fd	-	+
breast_feeding_medium_skin_tone	1f931-1f3fd	-	+
breast_feeding_tone4	1f931-1f3fe	-	+
breast_feeding_medium_dark_skin_tone	1f931-1f3fe	-	+
breast_feeding_tone5	1f931-1f3ff	-	+
breast_feeding_dark_skin_tone	1f931-1f3ff	-	+
person_feeding_baby	1f9d1-200d-1f37c	people	-
person_feeding_baby_tone1	1f9d1-1f3fb-200d-1f37c	-	-
person_feeding_baby_light_skin_tone	1f9d1-1f3fb-200d-1f37c	-	-
person_feeding_baby_tone2	1f9d1-1f3fc-200d-1f37c	-	-
person_feeding_baby_medium_light_skin_tone	1f9d1-1f3fc-200d-1f37c	-	-
person_feeding_baby_tone3	1f9d1-1f3fd-200d-1f37c	-	-
person_feeding_baby_medium_skin_tone	1f9d1-1f3fd-200d-1f37c	-	-
person_feeding_baby_tone4	1f9d1-1f3fe-200d-1f37c	-	-
person_feeding_baby_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f37c	-	-
person_feeding_baby_tone5	1f9d1-1f3ff-200d-1f37c	-	-
person_feeding_baby_dark_skin_tone	1f9d1-1f3ff-200d-1f37c	-	-
woman_feeding_baby	1f469-200d-1f37c	people	-
woman_feeding_baby_tone1	1f469-1f3fb-200d-1f37c	-	-
woman_feeding_baby_light_skin_tone	1f469-1f3fb-200d-1f37c	-	-
woman_feeding_baby_tone2	1f469-1f3fc-200d-1f37c	-	-
woman_feeding_baby_medium_light_skin_tone	1f469-1f3fc-200d-1f37c	-	-
woman_feeding_baby_tone3	1f469-1f3fd-200d-1f37c	-	-
woman_feeding_baby_medium_skin_tone	1f469-1f3fd-200d-1f37c	-	-
woman_feeding_baby_tone4	1f469-1f3fe-200d-1f37c	-	-
woman_feeding_baby_medium_dark_skin_tone	1f469-1f3fe-200d-1f37c	-	-
woman_feeding_baby_tone5	1f469-1f3ff-200d-1f37c	-	-
woman_feeding_baby_dark_skin_tone	1f469-1f3ff-200d-1f37c	-	-
man_feeding_baby	1f468-200d-1f37c	people	-
man_feeding_baby_tone1	1f468-1f3fb-200d-1f37c	-	-
man_feeding_baby_light_skin_tone	1f468-1f3fb-200d-1f37c	-	-
man_feeding_baby_tone2	1f468-1f3fc-200d-1f37c	-	-
man_feeding_baby_medium_light_skin_tone	1f468-1f3fc-200d-1f37c	-	-
man_feeding_baby_tone3	1f468-1f3fd-200d-1f37c	-	-
man_feeding_baby_medium_skin_tone	1f468-1f3fd-200d-1f37c	-	-
man_feeding_baby_tone4	1f468-1f3fe-200d-1f37c	-	-
man_feeding_baby_medium_dark_skin_tone	1f468-1f3fe-200d-1f37c	-	-
man_feeding_baby_tone5	1f468-1f3ff-200d-1f37c	-	-
man_feeding_baby_dark_skin_tone	1f468-1f3ff-200d-1f37c	-	-
person_bowing	1f647	people	+
bow	1f647	-	+
person_bowing_tone1	1f647-1f3fb	-	+
bow_tone1	1f647-1f3fb	-	+
person_bowing_tone2	1f647-1f3fc	-	+
bow_tone2	1f647-1f3fc	-	+
person_bowing_tone3	1f647-1f3fd	-	+
bow_tone3	1f647-1f3fd	-	+
person_bowing_tone4	1f647-1f3fe	-	+
bow_tone4	1f647-1f3fe	-	+
person_bowing_tone5	1f647-1f3ff	-	+
bow_tone5	1f647-1f3ff	-	+
woman_bowing	1f647-200d-2640-fe0f	people	+
woman_bowing_tone1	1f647-1f3fb-200d-2640-fe0f	-	+
woman_bowing_light_skin_tone	1f647-1f3fb-200d-2640-fe0f	-	+
woman_bowing_tone2	1f647-1f3fc-200d-2640-fe0f	-	+
woman_bowing_medium_light_skin_tone	1f647-1f3fc-200d-2640-fe0f	-	+
woman_bowing_tone3	1f647-1f3fd-200d-2640-fe0f	-	+
woman_bowing_medium_skin_tone	1f647-1f3fd-200d-2640-fe0f	-	+
woman_bowing_tone4	1f647-1f3fe-200d-2640-fe0f	-	+
woman_bowing_medium_dark_skin_tone	1f647-1f3fe-200d-2640-fe0f	-	+
woman_bowing_tone5	1f647-1f3ff-200d-2640-fe0f	-	+
woman_bowing_dark_skin_tone	1f647-1f3ff-200d-2640-fe0f	-	+
man_bowing	1f647-200d-2642-fe0f	people	+
man_bowing_tone1	1f647-1f3fb-200d-2642-fe0f	-	+
man_bowing_light_skin_tone	1f647-1f3fb-200d-2642-fe0f	-	+
man_bowing_tone2	1f647-1f3fc-200d-2642-fe0f	-	+
man_bowing_medium_light_skin_tone	1f647-1f3fc-200d-2642-fe0f	-	+
man_bowing_tone3	1f647-1f3fd-200d-2642-fe0f	-	+
man_bowing_medium_skin_tone	1f647-1f3fd-200d-2642-fe0f	-	+
man_bowing_tone4	1f647-1f3fe-200d-2642-fe0f	-	+
man_bowing_medium_dark_skin_tone	1f647-1f3fe-200d-2642-fe0f	-	+
man_bowing_tone5	1f647-1f3ff-200d-2642-fe0f	-	+
man_bowing_dark_skin_tone	1f647-1f3ff-200d-2642-fe0f	-	+
person_tipping_hand	1f481	people	+
information_desk_person	1f481	-	+
person_tipping_hand_tone1	1f481-1f3fb	-	+
information_desk_person_tone1	1f481-1f3fb	-	+
person_tipping_hand_tone2	1f481-1f3fc	-	+
information_desk_person_tone2	1f481-1f3fc	-	+
person_tipping_hand_tone3	1f481-1f3fd	-	+
information_desk_person_tone3	1f481-1f3fd	-	+
person_tipping_hand_tone4	1f481-1f3fe	-	+
information_desk_person_tone4	1f481-1f3fe	-	+
person_tipping_hand_tone5	1f481-1f3ff	-	+
information_desk_person_tone5	1f481-1f3ff	-	+
woman_tipping_hand	1f481-200d-2640-fe0f	people	+
woman_tipping_hand_tone1	1f481-1f3fb-200d-2640-fe0f	-	+
woman_tipping_hand_light_skin_tone	1f481-1f3fb-200d-2640-fe0f	-	+
woman_tipping_hand_tone2	1f481-1f3fc-200d-2640-fe0f	-	+
woman_tipping_hand_medium_light_skin_tone	1f481-1f3fc-200d-2640-fe0f	-	+
woman_tipping_hand_tone3	1f481-1f3fd-200d-2640-fe0f	-	+
woman_tipping_hand_medium_skin_tone	1f481-1f3fd-200d-2640-fe0f	-	+
woman_tipping_hand_tone4	1f481-1f3fe-200d-2640-fe0f	-	+
woman_tipping_hand_medium_dark_skin_tone	1f481-1f3fe-200d-2640-fe0f	-	+
woman_tipping_hand_tone5	1f481-1f3ff-200d-2640-fe0f	-	+
woman_tipping_hand_dark_skin_tone	1f481-1f3ff-200d-2640-fe0f	-	+
man_tipping_hand	1f481-200d-2642-fe0f	people	+
man_tipping_hand_tone1	1f481-1f3fb-200d-2642-fe0f	-	+
man_tipping_hand_light_skin_tone	1f481-1f3fb-200d-2642-fe0f	-	+
man_tipping_hand_tone2	1f481-1f3fc-200d-2642-fe0f	-	+
man_tipping_hand_medium_light_skin_tone	1f481-1f3fc-200d-2642-fe0f	-	+
man_tipping_hand_tone3	1f481-1f3fd-200d-2642-fe0f	-	+
man_tipping_hand_medium_skin_tone	1f481-1f3fd-200d-2642-fe0f	-	+
man_tipping_hand_tone4	1f481-1f3fe-200d-2642-fe0f	-	+
man_tipping_hand_medium_dark_skin_tone	1f481-1f3fe-200d-2642-fe0f	-	+
man_tipping_hand_tone5	1f481-1f3ff-200d-2642-fe0f	-	+
man_tipping_hand_dark_skin_tone	1f481-1f3ff-200d-2642-fe0f	-	+
person_gesturing_no	1f645	people	+
no_good	1f645	-	+
person_gesturing_no_tone1	1f645-1f3fb	-	+
no_good_tone1	1f645-1f3fb	-	+
person_gesturing_no_tone2	1f645-1f3fc	-	+
no_good_tone2	1f645-1f3fc	-	+
person_gesturing_no_tone3	1f645-1f3fd	-	+
no_good_tone3	1f645-1f3fd	-	+
person_gesturing_no_tone4	1f645-1f3fe	-	+
no_good_tone4	1f645-1f3fe	-	+
person_gesturing_no_tone5	1f645-1f3ff	-	+
no_good_tone5	1f645-1f3ff	-	+
woman_gesturing_no	1f645-200d-2640-fe0f	people	+
woman_gesturing_no_tone1	1f645-1f3fb-200d-2640-fe0f	-	+
woman_gesturing_no_light_skin_tone	1f645-1f3fb-200d-2640-fe0f	-	+
woman_gesturing_no_tone2	1f645-1f3fc-200d-2640-fe0f	-	+
woman_gesturing_no_medium_light_skin_tone	1f645-1f3fc-200d-2640-fe0f	-	+
woman_gesturing_no_tone3	1f645-1f3fd-200d-2640-fe0f	-	+
woman_gesturing_no_medium_skin_tone	1f645-1f3fd-200d-2640-fe0f	-	+
woman_gesturing_no_tone4	1f645-1f3fe-200d-2640-fe0f	-	+
woman_gesturing_no_medium_dark_skin_tone	1f645-1f3fe-200d-2640-fe0f	-	+
woman_gesturing_no_tone5	1f645-1f3ff-200d-2640-fe0f	-	+
woman_gesturing_no_dark_skin_tone	1f645-1f3ff-200d-2640-fe0f	-	+
man_gesturing_no	1f645-200d-2642-fe0f	people	+
man_gesturing_no_tone1	1f645-1f3fb-200d-2642-fe0f	-	+
man_gesturing_no_light_skin_tone	1f645-1f3fb-200d-2642-fe0f	-	+
man_gesturing_no_tone2	1f645-1f3fc-200d-2642-fe0f	-	+
man_gesturing_no_medium_light_skin_tone	1f645-1f3fc-200d-2642-fe0f	-	+
man_gesturing_no_tone3	1f645-1f3fd-200d-2642-fe0f	-	+
man_gesturing_no_medium_skin_tone	1f645-1f3fd-200d-2642-fe0f	-	+
man_gesturing_no_tone4	1f645-1f3fe-200d-2642-fe0f	-	+
man_gesturing_no_medium_dark_skin_tone	1f645-1f3fe-200d-2642-fe0f	-	+
man_gesturing_no_tone5	1f645-1f3ff-200d-2642-fe0f	-	+
man_gesturing_no_dark_skin_tone	1f645-1f3ff-200d-2642-fe0f	-	+
person_gesturing_ok	1f646	people	+
ok_woman	1f646	-	+
person_gesturing_ok_tone1	1f646-1f3fb	-	+
ok_woman_tone1	1f646-1f3fb	-	+
person_gesturing_ok_tone2	1f646-1f3fc	-	+
ok_woman_tone2	1f646-1f3fc	-	+
person_gesturing_ok_tone3	1f646-1f3fd	-	+
ok_woman_tone3	1f646-1f3fd	-	+
person_gesturing_ok_tone4	1f646-1f3fe	-	+
ok_woman_tone4	1f646-1f3fe	-	+
person_gesturing_ok_tone5	1f646-1f3ff	-	+
ok_woman_tone5	1f646-1f3ff	-	+
woman_gesturing_ok	1f646-200d-2640-fe0f	people	+
woman_gesturing_ok_tone1	1f646-1f3fb-200d-2640-fe0f	-	+
woman_gesturing_ok_light_skin_tone	1f646-1f3fb-200d-2640-fe0f	-	+
woman_gesturing_ok_tone2	1f646-1f3fc-200d-2640-fe0f	-	+
woman_gesturing_ok_medium_light_skin_tone	1f646-1f3fc-200d-2640-fe0f	-	+
woman_gesturing_ok_tone3	1f646-1f3fd-200d-2640-fe0f	-	+
woman_gesturing_ok_medium_skin_tone	1f646-1f3fd-200d-2640-fe0f	-	+
woman_gesturing_ok_tone4	1f646-1f3fe-200d-2640-fe0f	-	+
woman_gesturing_ok_medium_dark_skin_tone	1f646-1f3fe-200d-2640-fe0f	-	+
woman_gesturing_ok_tone5	1f646-1f3ff-200d-2640-fe0f	-	+
woman_gesturing_ok_dark_skin_tone	1f646-1f3ff-200d-2640-fe0f	-	+
man_gesturing_ok	1f646-200d-2642-fe0f	people	+
man_gesturing_ok_tone1	1f646-1f3fb-200d-2642-fe0f	-	+
man_gesturing_ok_light_skin_tone	1f646-1f3fb-200d-2642-fe0f	-	+
man_gesturing_ok_tone2	1f646-1f3fc-200d-2642-fe0f	-	+
man_gesturing_ok_medium_light_skin_tone	1f646-1f3fc-200d-2642-fe0f	-	+
man_gesturing_ok_tone3	1f646-1f3fd-200d-2642-fe0f	-	+
man_gesturing_ok_medium_skin_tone	1f646-1f3fd-200d-2642-fe0f	-	+
man_gesturing_ok_tone4	1f646-1f3fe-200d-2642-fe0f	-	+
man_gesturing_ok_medium_dark_skin_tone	1f646-1f3fe-200d-2642-fe0f	-	+
man_gesturing_ok_tone5	1f646-1f3ff-200d-2642-fe0f	-	+
man_gesturing_ok_dark_skin_tone	1f646-1f3ff-200d-2642-fe0f	-	+
person_raising_hand	1f64b	people	+
raising_hand	1f64b	-	+
person_raising_hand_tone1	1f64b-1f3fb	-	+
raising_hand_tone1	1f64b-1f3fb	-	+
person_raising_hand_tone2	1f64b-1f3fc	-	+
raising_hand_tone2	1f64b-1f3fc	-	+
person_raising_hand_tone3	1f64b-1f3fd	-	+
raising_hand_tone3	1f64b-1f3fd	-	+
person_raising_hand_tone4	1f64b-1f3fe	-	+
raising_hand_tone4	1f64b-1f3fe	-	+
person_raising_hand_tone5	1f64b-1f3ff	-	+
raising_hand_tone5	1f64b-1f3ff	-	+
woman_raising_hand	1f64b-200d-2640-fe0f	people	+
woman_raising_hand_tone1	1f64b-1f3fb-200d-2640-fe0f	-	+
woman_raising_hand_light_skin_tone	1f64b-1f3fb-200d-2640-fe0f	-	+
woman_raising_hand_tone2	1f64b-1f3fc-200d-2640-fe0f	-	+
woman_raising_hand_medium_light_skin_tone	1f64b-1f3fc-200d-2640-fe0f	-	+
woman_raising_hand_tone3	1f64b-1f3fd-200d-2640-fe0f	-	+
woman_raising_hand_medium_skin_tone	1f64b-1f3fd-200d-2640-fe0f	-	+
woman_raising_hand_tone4	1f64b-1f3fe-200d-2640-fe0f	-	+
woman_raising_hand_medium_dark_skin_tone	1f64b-1f3fe-200d-2640-fe0f	-	+
woman_raising_hand_tone5	1f64b-1f3ff-200d-2640-fe0f	-	+
woman_raising_hand_dark_skin_tone	1f64b-1f3ff-200d-2640-fe0f	-	+
man_raising_hand	1f64b-200d-2642-fe0f	people	+
man_raising_hand_tone1	1f64b-1f3fb-200d-2642-fe0f	-	+
man_raising_hand_light_skin_tone	1f64b-1f3fb-200d-2642-fe0f	-	+
man_raising_hand_tone2	1f64b-1f3fc-200d-2642-fe0f	-	+
man_raising_hand_medium_light_skin_tone	1f64b-1f3fc-200d-2642-fe0f	-	+
man_raising_hand_tone3	1f64b-1f3fd-200d-2642-fe0f	-	+
man_raising_hand_medium_skin_tone	1f64b-1f3fd-200d-2642-fe0f	-	+
man_raising_hand_tone4	1f64b-1f3fe-200d-2642-fe0f	-	+
man_raising_hand_medium_dark_skin_tone	1f64b-1f3fe-200d-2642-fe0f	-	+
man_raising_hand_tone5	1f64b-1f3ff-200d-2642-fe0f	-	+
man_raising_hand_dark_skin_tone	1f64b-1f3ff-200d-2642-fe0f	-	+
deaf_person	1f9cf	people	-
deaf_person_tone1	1f9cf-1f3fb	-	-
deaf_person_light_skin_tone	1f9cf-1f3fb	-	-
deaf_person_tone2	1f9cf-1f3fc	-	-
deaf_person_medium_light_skin_tone	1f9cf-1f3fc	-	-
deaf_person_tone3	1f9cf-1f3fd	-	-
deaf_person_medium_skin_tone	1f9cf-1f3fd	-	-
deaf_person_tone4	1f9cf-1f3fe	-	-
deaf_person_medium_dark_skin_tone	1f9cf-1f3fe	-	-
deaf_person_tone5	1f9cf-1f3ff	-	-
deaf_person_dark_skin_tone	1f9cf-1f3ff	-	-
deaf_woman	1f9cf-200d-2640-fe0f	people	-
deaf_woman_tone1	1f9cf-1f3fb-200d-2640-fe0f	-	-
deaf_woman_light_skin_tone	1f9cf-1f3fb-200d-2640-fe0f	-	-
deaf_woman_tone2	1f9cf-1f3fc-200d-2640-fe0f	-	-
deaf_woman_medium_light_skin_tone	1f9cf-1f3fc-200d-2640-fe0f	-	-
deaf_woman_tone3	1f9cf-1f3fd-200d-2640-fe0f	-	-
deaf_woman_medium_skin_tone	1f9cf-1f3fd-200d-2640-fe0f	-	-
deaf_woman_tone4	1f9cf-1f3fe-200d-2640-fe0f	-	-
deaf_woman_medium_dark_skin_tone	1f9cf-1f3fe-200d-2640-fe0f	-	-
deaf_woman_tone5	1f9cf-1f3ff-200d-2640-fe0f	-	-
deaf_woman_dark_skin_tone	1f9cf-1f3ff-200d-2640-fe0f	-	-
deaf_man	1f9cf-200d-2642-fe0f	people	-
deaf_man_tone1	1f9cf-1f3fb-200d-2642-fe0f	-	-
deaf_man_light_skin_tone	1f9cf-1f3fb-200d-2642-fe0f	-	-
deaf_man_tone2	1f9cf-1f3fc-200d-2642-fe0f	-	-
deaf_man_medium_light_skin_tone	1f9cf-1f3fc-200d-2642-fe0f	-	-
deaf_man_tone3	1f9cf-1f3fd-200d-2642-fe0f	-	-
deaf_man_medium_skin_tone	1f9cf-1f3fd-200d-2642-fe0f	-	-
deaf_man_tone4	1f9cf-1f3fe-200d-2642-fe0f	-	-
deaf_man_medium_dark_skin_tone	1f9cf-1f3fe-200d-2642-fe0f	-	-
deaf_man_tone5	1f9cf-1f3ff-200d-2642-fe0f	-	-
deaf_man_dark_skin_tone	1f9cf-1f3ff-200d-2642-fe0f	-	-
person_facepalming	1f926	people	+
face_palm	1f926	-	+
facepalm	1f926	-	+
person_facepalming_tone1	1f926-1f3fb	-	+
face_palm_tone1	1f926-1f3fb	-	+
facepalm_tone1	1f926-1f3fb	-	+
person_facepalming_tone2	1f926-1f3fc	-	+
face_palm_tone2	1f926-1f3fc	-	+
facepalm_tone2	1f926-1f3fc	-	+
person_facepalming_tone3	1f926-1f3fd	-	+
face_palm_tone3	1f926-1f3fd	-	+
facepalm_tone3	1f926-1f3fd	-	+
person_facepalming_tone4	1f926-1f3fe	-	+
face_palm_tone4	1f926-1f3fe	-	+
facepalm_tone4	1f926-1f3fe	-	+
person_facepalming_tone5	1f926-1f3ff	-	+
face_palm_tone5	1f926-1f3ff	-	+
facepalm_tone5	1f926-1f3ff	-	+
woman_facepalming	1f926-200d-2640-fe0f	people	+
woman_facepalming_tone1	1f926-1f3fb-200d-2640-fe0f	-	+
woman_facepalming_light_skin_tone	1f926-1f3fb-200d-2640-fe0f	-	+
woman_facepalming_tone2	1f926-1f3fc-200d-2640-fe0f	-	+
woman_facepalming_medium_light_skin_tone	1f926-1f3fc-200d-2640-fe0f	-	+
woman_facepalming_tone3	1f926-1f3fd-200d-2640-fe0f	-	+
woman_facepalming_medium_skin_tone	1f926-1f3fd-200d-2640-fe0f	-	+
woman_facepalming_tone4	1f926-1f3fe-200d-2640-fe0f	-	+
woman_facepalming_medium_dark_skin_tone	1f926-1f3fe-200d-2640-fe0f	-	+
woman_facepalming_tone5	1f926-1f3ff-200d-2640-fe0f	-	+
woman_facepalming_dark_skin_tone	1f926-1f3ff-200d-2640-fe0f	-	+
man_facepalming	1f926-200d-2642-fe0f	people	+
man_facepalming_tone1	1f926-1f3fb-200d-2642-fe0f	-	+
man_facepalming_light_skin_tone	1f926-1f3fb-200d-2642-fe0f	-	+
man_facepalming_tone2	1f926-1f3fc-200d-2642-fe0f	-	+
man_facepalming_medium_light_skin_tone	1f926-1f3fc-200d-2642-fe0f	-	+
man_facepalming_tone3	1f926-1f3fd-200d-2642-fe0f	-	+
man_facepalming_medium_skin_tone	1f926-1f3fd-200d-2642-fe0f	-	+
man_facepalming_tone4	1f926-1f3fe-200d-2642-fe0f	-	+
man_facepalming_medium_dark_skin_tone	1f926-1f3fe-200d-2642-fe0f	-	+
man_facepalming_tone5	1f926-1f3ff-200d-2642-fe0f	-	+
man_facepalming_dark_skin_tone	1f926-1f3ff-200d-2642-fe0f	-	+
person_shrugging	1f937	people	+
shrug	1f937	-	+
person_shrugging_tone1	1f937-1f3fb	-	+
shrug_tone1	1f937-1f3fb	-	+
person_shrugging_tone2	1f937-1f3fc	-	+
shrug_tone2	1f937-1f3fc	-	+
person_shrugging_tone3	1f937-1f3fd	-	+
shrug_tone3	1f937-1f3fd	-	+
person_shrugging_tone4	1f937-1f3fe	-	+
shrug_tone4	1f937-1f3fe	-	+
person_shrugging_tone5	1f937-1f3ff	-	+
shrug_tone5	1f937-1f3ff	-	+
woman_shrugging	1f937-200d-2640-fe0f	people	+
woman_shrugging_tone1	1f937-1f3fb-200d-2640-fe0f	-	+
woman_shrugging_light_skin_tone	1f937-1f3fb-200d-2640-fe0f	-	+
woman_shrugging_tone2	1f937-1f3fc-200d-2640-fe0f	-	+
woman_shrugging_medium_light_skin_tone	1f937-1f3fc-200d-2640-fe0f	-	+
woman_shrugging_tone3	1f937-1f3fd-200d-2640-fe0f	-	+
woman_shrugging_medium_skin_tone	1f937-1f3fd-200d-2640-fe0f	-	+
woman_shrugging_tone4	1f937-1f3fe-200d-2640-fe0f	-	+
woman_shrugging_medium_dark_skin_tone	1f937-1f3fe-200d-2640-fe0f	-	+
woman_shrugging_tone5	1f937-1f3ff-200d-2640-fe0f	-	+
woman_shrugging_dark_skin_tone	1f937-1f3ff-200d-2640-fe0f	-	+
man_shrugging	1f937-200d-2642-fe0f	people	+
man_shrugging_tone1	1f937-1f3fb-200d-2642-fe0f	-	+
man_shrugging_light_skin_tone	1f937-1f3fb-200d-2642-fe0f	-	+
man_shrugging_tone2	1f937-1f3fc-200d-2642-fe0f	-	+
man_shrugging_medium_light_skin_tone	1f937-1f3fc-200d-2642-fe0f	-	+
man_shrugging_tone3	1f937-1f3fd-200d-2642-fe0f	-	+
man_shrugging_medium_skin_tone	1f937-1f3fd-200d-2642-fe0f	-	+
man_shrugging_tone4	1f937-1f3fe-200d-2642-fe0f	-	+
man_shrugging_medium_dark_skin_tone	1f937-1f3fe-200d-2642-fe0f	-	+
man_shrugging_tone5	1f937-1f3ff-200d-2642-fe0f	-	+
man_shrugging_dark_skin_tone	1f937-1f3ff-200d-2642-fe0f	-	+
person_pouting	1f64e	people	+
person_with_pouting_face	1f64e	-	+
person_pouting_tone1	1f64e-1f3fb	-	+
person_with_pouting_face_tone1	1f64e-1f3fb	-	+
person_pouting_tone2	1f64e-1f3fc	-	+
person_with_pouting_face_tone2	1f64e-1f3fc	-	+
person_pouting_tone3	1f64e-1f3fd	-	+
person_with_pouting_face_tone3	1f64e-1f3fd	-	+
person_pouting_tone4	1f64e-1f3fe	-	+
person_with_pouting_face_tone4	1f64e-1f3fe	-	+
person_pouting_tone5	1f64e-1f3ff	-	+
person_with_pouting_face_tone5	1f64e-1f3ff	-	+
woman_pouting	1f64e-200d-2640-fe0f	people	+
woman_pouting_tone1	1f64e-1f3fb-200d-2640-fe0f	-	+
woman_pouting_light_skin_tone	1f64e-1f3fb-200d-2640-fe0f	-	+
woman_pouting_tone2	1f64e-1f3fc-200d-2640-fe0f	-	+
woman_pouting_medium_light_skin_tone	1f64e-1f3fc-200d-2640-fe0f	-	+
woman_pouting_tone3	1f64e-1f3fd-200d-2640-fe0f	-	+
woman_pouting_medium_skin_tone	1f64e-1f3fd-200d-2640-fe0f	-	+
woman_pouting_tone4	1f64e-1f3fe-200d-2640-fe0f	-	+
woman_pouting_medium_dark_skin_tone	1f64e-1f3fe-200d-2640-fe0f	-	+
woman_pouting_tone5	1f64e-1f3ff-200d-2640-fe0f	-	+
woman_pouting_dark_skin_tone	1f64e-1f3ff-200d-2640-fe0f	-	+
man_pouting	1f64e-200d-2642-fe0f	people	+
man_pouting_tone1	1f64e-1f3fb-200d-2642-fe0f	-	+
man_pouting_light_skin_tone	1f64e-1f3fb-200d-2642-fe0f	-	+
man_pouting_tone2	1f64e-1f3fc-200d-2642-fe0f	-	+
man_pouting_medium_light_skin_tone	1f64e-1f3fc-200d-2642-fe0f	-	+
man_pouting_tone3	1f64e-1f3fd-200d-2642-fe0f	-	+
man_pouting_medium_skin_tone	1f64e-1f3fd-200d-2642-fe0f	-	+
man_pouting_tone4	1f64e-1f3fe-200d-2642-fe0f	-	+
man_pouting_medium_dark_skin_tone	1f64e-1f3fe-200d-2642-fe0f	-	+
man_pouting_tone5	1f64e-1f3ff-200d-2642-fe0f	-	+
man_pouting_dark_skin_tone	1f64e-1f3ff-200d-2642-fe0f	-	+
person_frowning	1f64d	people	+
person_frowning_tone1	1f64d-1f3fb	-	+
person_frowning_tone2	1f64d-1f3fc	-	+
person_frowning_tone3	1f64d-1f3fd	-	+
person_frowning_tone4	1f64d-1f3fe	-	+
person_frowning_tone5	1f64d-1f3ff	-	+
woman_frowning	1f64d-200d-2640-fe0f	people	+
woman_frowning_tone1	1f64d-1f3fb-200d-2640-fe0f	-	+
woman_frowning_light_skin_tone	1f64d-1f3fb-200d-2640-fe0f	-	+
woman_frowning_tone2	1f64d-1f3fc-200d-2640-fe0f	-	+
woman_frowning_medium_light_skin_tone	1f64d-1f3fc-200d-2640-fe0f	-	+
woman_frowning_tone3	1f64d-1f3fd-200d-2640-fe0f	-	+
woman_frowning_medium_skin_tone	1f64d-1f3fd-200d-2640-fe0f	-	+
woman_frowning_tone4	1f64d-1f3fe-200d-2640-fe0f	-	+
woman_frowning_medium_dark_skin_tone	1f64d-1f3fe-200d-2640-fe0f	-	+
woman_frowning_tone5	1f64d-1f3ff-200d-2640-fe0f	-	+
woman_frowning_dark_skin_tone	1f64d-1f3ff-200d-2640-fe0f	-	+
man_frowning	1f64d-200d-2642-fe0f	people	+
man_frowning_tone1	1f64d-1f3fb-200d-2642-fe0f	-	+
man_frowning_light_skin_tone	1f64d-1f3fb-200d-2642-fe0f	-	+
man_frowning_tone2	1f64d-1f3fc-200d-2642-fe0f	-	+
man_frowning_medium_light_skin_tone	1f64d-1f3fc-200d-2642-fe0f	-	+
man_frowning_tone3	1f64d-1f3fd-200d-2642-fe0f	-	+
man_frowning_medium_skin_tone	1f64d-1f3fd-200d-2642-fe0f	-	+
man_frowning_tone4	1f64d-1f3fe-200d-2642-fe0f	-	+
man_frowning_medium_dark_skin_tone	1f64d-1f3fe-200d-2642-fe0f	-	+
man_frowning_tone5	1f64d-1f3ff-200d-2642-fe0f	-	+
man_frowning_dark_skin_tone	1f64d-1f3ff-200d-2642-fe0f	-	+
person_getting_haircut	1f487	people	+
haircut	1f487	-	+
person_getting_haircut_tone1	1f487-1f3fb	-	+
haircut_tone1	1f487-1f3fb	-	+
person_getting_haircut_tone2	1f487-1f3fc	-	+
haircut_tone2	1f487-1f3fc	-	+
person_getting_haircut_tone3	1f487-1f3fd	-	+
haircut_tone3	1f487-1f3fd	-	+
person_getting_haircut_tone4	1f487-1f3fe	-	+
haircut_tone4	1f487-1f3fe	-	+
person_getting_haircut_tone5	1f487-1f3ff	-	+
haircut_tone5	1f487-1f3ff	-	+
woman_getting_haircut	1f487-200d-2640-fe0f	people	+
woman_getting_haircut_tone1	1f487-1f3fb-200d-2640-fe0f	-	+
woman_getting_haircut_light_skin_tone	1f487-1f3fb-200d-2640-fe0f	-	+
woman_getting_haircut_tone2	1f487-1f3fc-200d-2640-fe0f	-	+
woman_getting_haircut_medium_light_skin_tone	1f487-1f3fc-200d-2640-fe0f	-	+
woman_getting_haircut_tone3	1f487-1f3fd-200d-2640-fe0f	-	+
woman_getting_haircut_medium_skin_tone	1f487-1f3fd-200d-2640-fe0f	-	+
woman_getting_haircut_tone4	1f487-1f3fe-200d-2640-fe0f	-	+
woman_getting_haircut_medium_dark_skin_tone	1f487-1f3fe-200d-2640-fe0f	-	+
woman_getting_haircut_tone5	1f487-1f3ff-200d-2640-fe0f	-	+
woman_getting_haircut_dark_skin_tone	1f487-1f3ff-200d-2640-fe0f	-	+
man_getting_haircut	1f487-200d-2642-fe0f	people	+
man_getting_haircut_tone1	1f487-1f3fb-200d-2642-fe0f	-	+
man_getting_haircut_light_skin_tone	1f487-1f3fb-200d-2642-fe0f	-	+
man_getting_haircut_tone2	1f487-1f3fc-200d-2642-fe0f	-	+
man_getting_haircut_medium_light_skin_tone	1f487-1f3fc-200d-2642-fe0f	-	+
man_getting_haircut_tone3	1f487-1f3fd-200d-2642-fe0f	-	+
man_getting_haircut_medium_skin_tone	1f487-1f3fd-200d-2642-fe0f	-	+
man_getting_haircut_tone4	1f487-1f3fe-200d-2642-fe0f	-	+
man_getting_haircut_medium_dark_skin_tone	1f487-1f3fe-200d-2642-fe0f	-	+
man_getting_haircut_tone5	1f487-1f3ff-200d-2642-fe0f	-	+
man_getting_haircut_dark_skin_tone	1f487-1f3ff-200d-2642-fe0f	-	+
person_getting_massage	1f486	people	+
massage	1f486	-	+
person_getting_massage_tone1	1f486-1f3fb	-	+
massage_tone1	1f486-1f3fb	-	+
person_getting_massage_tone2	1f486-1f3fc	-	+
massage_tone2	1f486-1f3fc	-	+
person_getting_massage_tone3	1f486-1f3fd	-	+
massage_tone3	1f486-1f3fd	-	+
person_getting_massage_tone4	1f486-1f3fe	-	+
massage_tone4	1f486-1f3fe	-	+
person_getting_massage_tone5	1f486-1f3ff	-	+
massage_tone5	1f486-1f3ff	-	+
woman_getting_face_massage	1f486-200d-2640-fe0f	people	+
woman_getting_face_massage_tone1	1f486-1f3fb-200d-2640-fe0f	-	+
woman_getting_face_massage_light_skin_tone	1f486-1f3fb-200d-2640-fe0f	-	+
woman_getting_face_massage_tone2	1f486-1f3fc-200d-2640-fe0f	-	+
woman_getting_face_massage_medium_light_skin_tone	1f486-1f3fc-200d-2640-fe0f	-	+
woman_getting_face_massage_tone3	1f486-1f3fd-200d-2640-fe0f	-	+
woman_getting_face_massage_medium_skin_tone	1f486-1f3fd-200d-2640-fe0f	-	+
woman_getting_face_massage_tone4	1f486-1f3fe-200d-2640-fe0f	-	+
woman_getting_face_massage_medium_dark_skin_tone	1f486-1f3fe-200d-2640-fe0f	-	+
woman_getting_face_massage_tone5	1f486-1f3ff-200d-2640-fe0f	-	+
woman_getting_face_massage_dark_skin_tone	1f486-1f3ff-200d-2640-fe0f	-	+
man_getting_face_massage	1f486-200d-2642-fe0f	people	+
man_getting_face_massage_tone1	1f486-1f3fb-200d-2642-fe0f	-	+
man_getting_face_massage_light_skin_tone	1f486-1f3fb-200d-2642-fe0f	-	+
man_getting_face_massage_tone2	1f486-1f3fc-200d-2642-fe0f	-	+
man_getting_face_massage_medium_light_skin_tone	1f486-1f3fc-200d-2642-fe0f	-	+
man_getting_face_massage_tone3	1f486-1f3fd-200d-2642-fe0f	-	+
man_getting_face_massage_medium_skin_tone	1f486-1f3fd-200d-2642-fe0f	-	+
man_getting_face_massage_tone4	1f486-1f3fe-200d-2642-fe0f	-	+
man_getting_face_massage_medium_dark_skin_tone	1f486-1f3fe-200d-2642-fe0f	-	+
man_getting_face_massage_tone5	1f486-1f3ff-200d-2642-fe0f	-	+
man_getting_face_massage_dark_skin_tone	1f486-1f3ff-200d-2642-fe0f	-	+
person_in_steamy_room	1f9d6	people	+
person_in_steamy_room_tone1	1f9d6-1f3fb	-	+
person_in_steamy_room_light_skin_tone	1f9d6-1f3fb	-	+
person_in_steamy_room_tone2	1f9d6-1f3fc	-	+
person_in_steamy_room_medium_light_skin_tone	1f9d6-1f3fc	-	+
person_in_steamy_room_tone3	1f9d6-1f3fd	-	+
person_in_steamy_room_medium_skin_tone	1f9d6-1f3fd	-	+
person_in_steamy_room_tone4	1f9d6-1f3fe	-	+
person_in_steamy_room_medium_dark_skin_tone	1f9d6-1f3fe	-	+
person_in_steamy_room_tone5	1f9d6-1f3ff	-	+
person_in_steamy_room_dark_skin_tone	1f9d6-1f3ff	-	+
woman_in_steamy_room	1f9d6-200d-2640-fe0f	people	+
woman_in_steamy_room_tone1	1f9d6-1f3fb-200d-2640-fe0f	-	+
woman_in_steamy_room_light_skin_tone	1f9d6-1f3fb-200d-2640-fe0f	-	+
woman_in_steamy_room_tone2	1f9d6-1f3fc-200d-2640-fe0f	-	+
woman_in_steamy_room_medium_light_skin_tone	1f9d6-1f3fc-200d-2640-fe0f	-	+
woman_in_steamy_room_tone3	1f9d6-1f3fd-200d-2640-fe0f	-	+
woman_in_steamy_room_medium_skin_tone	1f9d6-1f3fd-200d-2640-fe0f	-	+
woman_in_steamy_room_tone4	1f9d6-1f3fe-200d-2640-fe0f	-	+
woman_in_steamy_room_medium_dark_skin_tone	1f9d6-1f3fe-200d-2640-fe0f	-	+
woman_in_steamy_room_tone5	1f9d6-1f3ff-200d-2640-fe0f	-	+
woman_in_steamy_room_dark_skin_tone	1f9d6-1f3ff-200d-2640-fe0f	-	+
man_in_steamy_room	1f9d6-200d-2642-fe0f	people	+
man_in_steamy_room_tone1	1f9d6-1f3fb-200d-2642-fe0f	-	+
man_in_steamy_room_light_skin_tone	1f9d6-1f3fb-200d-2642-fe0f	-	+
man_in_steamy_room_tone2	1f9d6-1f3fc-200d-2642-fe0f	-	+
man_in_steamy_room_medium_light_skin_tone	1f9d6-1f3fc-200d-2642-fe0f	-	+
man_in_steamy_room_tone3	1f9d6-1f3fd-200d-2642-fe0f	-	+
man_in_steamy_room_medium_skin_tone	1f9d6-1f3fd-200d-2642-fe0f	-	+
man_in_steamy_room_tone4	1f9d6-1f3fe-200d-2642-fe0f	-	+
man_in_steamy_room_medium_dark_skin_tone	1f9d6-1f3fe-200d-2642-fe0f	-	+
man_in_steamy_room_tone5	1f9d6-1f3ff-200d-2642-fe0f	-	+
man_in_steamy_room_dark_skin_tone	1f9d6-1f3ff-200d-2642-fe0f	-	+
nail_care	1f485	people	+
nail_polish	1f485	-	-
nail_care_tone1	1f485-1f3fb	-	+
nail_care_tone2	1f485-1f3fc	-	+
nail_care_tone3	1f485-1f3fd	-	+
nail_care_tone4	1f485-1f3fe	-	+
nail_care_tone5	1f485-1f3ff	-	+
selfie	1f933	people	+
selfie_tone1	1f933-1f3fb	-	+
selfie_tone2	1f933-1f3fc	-	+
selfie_tone3	1f933-1f3fd	-	+
selfie_tone4	1f933-1f3fe	-	+
selfie_tone5	1f933-1f3ff	-	+
dancer	1f483	people	+
woman_dancing	1f483	-	-
dancer_tone1	1f483-1f3fb	-	+
dancer_tone2	1f483-1f3fc	-	+
dancer_tone3	1f483-1f3fd	-	+
dancer_tone4	1f483-1f3fe	-	+
dancer_tone5	1f483-1f3ff	-	+
man_dancing	1f57a	people	+
male_dancer	1f57a	-	+
man_dancing_tone1	1f57a-1f3fb	-	+
male_dancer_tone1	1f57a-1f3fb	-	+
man_dancing_tone2	1f57a-1f3fc	-	+
male_dancer_tone2	1f57a-1f3fc	-	+
man_dancing_tone3	1f57a-1f3fd	-	+
male_dancer_tone3	1f57a-1f3fd	-	+
man_dancing_tone5	1f57a-1f3ff	-	+
male_dancer_tone5	1f57a-1f3ff	-	+
man_dancing_tone4	1f57a-1f3fe	-	+
male_dancer_tone4	1f57a-1f3fe	-	+
people_with_bunny_ears_partying	1f46f	people	+
dancers	1f46f	-	+
women_with_bunny_ears_partying	1f46f-200d-2640-fe0f	people	+
men_with_bunny_ears_partying	1f46f-200d-2642-fe0f	people	+
levitate	1f574-fe0f	people	+
man_in_business_suit_levitating	1f574-fe0f	-	+
levitate_tone1	1f574-1f3fb	-	+
man_in_business_suit_levitating_tone1	1f574-1f3fb	-	+
man_in_business_suit_levitating_light_skin_tone	1f574-1f3fb	-	+
levitate_tone2	1f574-1f3fc	-	+
man_in_business_suit_levitating_tone2	1f574-1f3fc	-	+
man_in_business_suit_levitating_medium_light_skin_tone	1f574-1f3fc	-	+
levitate_tone3	1f574-1f3fd	-	+
man_in_business_suit_levitating_tone3	1f574-1f3fd	-	+
man_in_business_suit_levitating_medium_skin_tone	1f574-1f3fd	-	+
levitate_tone4	1f574-1f3fe	-	+
man_in_business_suit_levitating_tone4	1f574-1f3fe	-	+
man_in_business_suit_levitating_medium_dark_skin_tone	1f574-1f3fe	-	+
levitate_tone5	1f574-1f3ff	-	+
man_in_business_suit_levitating_tone5	1f574-1f3ff	-	+
man_in_business_suit_levitating_dark_skin_tone	1f574-1f3ff	-	+
person_in_manual_wheelchair	1f9d1-200d-1f9bd	people	-
person_in_manual_wheelchair_tone1	1f9d1-1f3fb-200d-1f9bd	-	-
person_in_manual_wheelchair_light_skin_tone	1f9d1-1f3fb-200d-1f9bd	-	-
person_in_manual_wheelchair_tone2	1f9d1-1f3fc-200d-1f9bd	-	-
person_in_manual_wheelchair_medium_light_skin_tone	1f9d1-1f3fc-200d-1f9bd	-	-
person_in_manual_wheelchair_tone3	1f9d1-1f3fd-200d-1f9bd	-	-
person_in_manual_wheelchair_medium_skin_tone	1f9d1-1f3fd-200d-1f9bd	-	-
person_in_manual_wheelchair_tone4	1f9d1-1f3fe-200d-1f9bd	-	-
person_in_manual_wheelchair_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f9bd	-	-
person_in_manual_wheelchair_tone5	1f9d1-1f3ff-200d-1f9bd	-	-
person_in_manual_wheelchair_dark_skin_tone	1f9d1-1f3ff-200d-1f9bd	-	-
woman_in_manual_wheelchair	1f469-200d-1f9bd	people	-
woman_in_manual_wheelchair_tone1	1f469-1f3fb-200d-1f9bd	-	-
woman_in_manual_wheelchair_light_skin_tone	1f469-1f3fb-200d-1f9bd	-	-
woman_in_manual_wheelchair_tone2	1f469-1f3fc-200d-1f9bd	-	-
woman_in_manual_wheelchair_medium_light_skin_tone	1f469-1f3fc-200d-1f9bd	-	-
woman_in_manual_wheelchair_tone3	1f469-1f3fd-200d-1f9bd	-	-
woman_in_manual_wheelchair_medium_skin_tone	1f469-1f3fd-200d-1f9bd	-	-
woman_in_manual_wheelchair_tone4	1f469-1f3fe-200d-1f9bd	-	-
woman_in_manual_wheelchair_medium_dark_skin_tone	1f469-1f3fe-200d-1f9bd	-	-
woman_in_manual_wheelchair_tone5	1f469-1f3ff-200d-1f9bd	-	-
woman_in_manual_wheelchair_dark_skin_tone	1f469-1f3ff-200d-1f9bd	-	-
man_in_manual_wheelchair	1f468-200d-1f9bd	people	-
man_in_manual_wheelchair_tone1	1f468-1f3fb-200d-1f9bd	-	-
man_in_manual_wheelchair_light_skin_tone	1f468-1f3fb-200d-1f9bd	-	-
man_in_manual_wheelchair_tone2	1f468-1f3fc-200d-1f9bd	-	-
man_in_manual_wheelchair_medium_light_skin_tone	1f468-1f3fc-200d-1f9bd	-	-
man_in_manual_wheelchair_tone3	1f468-1f3fd-200d-1f9bd	-	-
man_in_manual_wheelchair_medium_skin_tone	1f468-1f3fd-200d-1f9bd	-	-
man_in_manual_wheelchair_tone4	1f468-1f3fe-200d-1f9bd	-	-
man_in_manual_wheelchair_medium_dark_skin_tone	1f468-1f3fe-200d-1f9bd	-	-
man_in_manual_wheelchair_tone5	1f468-1f3ff-200d-1f9bd	-	-
man_in_manual_wheelchair_dark_skin_tone	1f468-1f3ff-200d-1f9bd	-	-
person_in_manual_wheelchair_facing_right	1f9d1-200d-1f9bd-200d-27a1-fe0f	people	-
person_in_manual_wheelchair_facing_right_tone1	1f9d1-1f3fb-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_light_skin_tone	1f9d1-1f3fb-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_tone2	1f9d1-1f3fc-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_medium_light_skin_tone	1f9d1-1f3fc-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_tone3	1f9d1-1f3fd-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_medium_skin_tone	1f9d1-1f3fd-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_tone4	1f9d1-1f3fe-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_tone5	1f9d1-1f3ff-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_manual_wheelchair_facing_right_dark_skin_tone	1f9d1-1f3ff-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right	1f469-200d-1f9bd-200d-27a1-fe0f	people	-
woman_in_manual_wheelchair_facing_right_tone1	1f469-1f3fb-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_light_skin_tone	1f469-1f3fb-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_tone2	1f469-1f3fc-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_medium_light_skin_tone	1f469-1f3fc-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_tone3	1f469-1f3fd-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_medium_skin_tone	1f469-1f3fd-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_tone4	1f469-1f3fe-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_medium_dark_skin_tone	1f469-1f3fe-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_tone5	1f469-1f3ff-200d-1f9bd-200d-27a1-fe0f	-	-
woman_in_manual_wheelchair_facing_right_dark_skin_tone	1f469-1f3ff-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right	1f468-200d-1f9bd-200d-27a1-fe0f	people	-
man_in_manual_wheelchair_facing_right_tone2	1f468-1f3fc-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_medium_light_skin_tone	1f468-1f3fc-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_tone1	1f468-1f3fb-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_light_skin_tone	1f468-1f3fb-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_tone3	1f468-1f3fd-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_medium_skin_tone	1f468-1f3fd-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_tone4	1f468-1f3fe-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_medium_dark_skin_tone	1f468-1f3fe-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_tone5	1f468-1f3ff-200d-1f9bd-200d-27a1-fe0f	-	-
man_in_manual_wheelchair_facing_right_dark_skin_tone	1f468-1f3ff-200d-1f9bd-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair	1f9d1-200d-1f9bc	people	-
person_in_motorized_wheelchair_tone1	1f9d1-1f3fb-200d-1f9bc	-	-
person_in_motorized_wheelchair_light_skin_tone	1f9d1-1f3fb-200d-1f9bc	-	-
person_in_motorized_wheelchair_tone2	1f9d1-1f3fc-200d-1f9bc	-	-
person_in_motorized_wheelchair_medium_light_skin_tone	1f9d1-1f3fc-200d-1f9bc	-	-
person_in_motorized_wheelchair_tone3	1f9d1-1f3fd-200d-1f9bc	-	-
person_in_motorized_wheelchair_medium_skin_tone	1f9d1-1f3fd-200d-1f9bc	-	-
person_in_motorized_wheelchair_tone4	1f9d1-1f3fe-200d-1f9bc	-	-
person_in_motorized_wheelchair_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f9bc	-	-
person_in_motorized_wheelchair_tone5	1f9d1-1f3ff-200d-1f9bc	-	-
person_in_motorized_wheelchair_dark_skin_tone	1f9d1-1f3ff-200d-1f9bc	-	-
woman_in_motorized_wheelchair	1f469-200d-1f9bc	people	-
woman_in_motorized_wheelchair_tone1	1f469-1f3fb-200d-1f9bc	-	-
woman_in_motorized_wheelchair_light_skin_tone	1f469-1f3fb-200d-1f9bc	-	-
woman_in_motorized_wheelchair_tone2	1f469-1f3fc-200d-1f9bc	-	-
woman_in_motorized_wheelchair_medium_light_skin_tone	1f469-1f3fc-200d-1f9bc	-	-
woman_in_motorized_wheelchair_tone3	1f469-1f3fd-200d-1f9bc	-	-
woman_in_motorized_wheelchair_medium_skin_tone	1f469-1f3fd-200d-1f9bc	-	-
woman_in_motorized_wheelchair_tone4	1f469-1f3fe-200d-1f9bc	-	-
woman_in_motorized_wheelchair_medium_dark_skin_tone	1f469-1f3fe-200d-1f9bc	-	-
woman_in_motorized_wheelchair_tone5	1f469-1f3ff-200d-1f9bc	-	-
woman_in_motorized_wheelchair_dark_skin_tone	1f469-1f3ff-200d-1f9bc	-	-
man_in_motorized_wheelchair	1f468-200d-1f9bc	people	-
man_in_motorized_wheelchair_tone1	1f468-1f3fb-200d-1f9bc	-	-
man_in_motorized_wheelchair_light_skin_tone	1f468-1f3fb-200d-1f9bc	-	-
man_in_motorized_wheelchair_tone2	1f468-1f3fc-200d-1f9bc	-	-
man_in_motorized_wheelchair_medium_light_skin_tone	1f468-1f3fc-200d-1f9bc	-	-
man_in_motorized_wheelchair_tone3	1f468-1f3fd-200d-1f9bc	-	-
man_in_motorized_wheelchair_medium_skin_tone	1f468-1f3fd-200d-1f9bc	-	-
man_in_motorized_wheelchair_tone4	1f468-1f3fe-200d-1f9bc	-	-
man_in_motorized_wheelchair_medium_dark_skin_tone	1f468-1f3fe-200d-1f9bc	-	-
man_in_motorized_wheelchair_tone5	1f468-1f3ff-200d-1f9bc	-	-
man_in_motorized_wheelchair_dark_skin_tone	1f468-1f3ff-200d-1f9bc	-	-
person_in_motorized_wheelchair_facing_right	1f9d1-200d-1f9bc-200d-27a1-fe0f	people	-
person_in_motorized_wheelchair_facing_right_tone1	1f9d1-1f3fb-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_light_skin_tone	1f9d1-1f3fb-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_tone2	1f9d1-1f3fc-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_medium_light_skin_tone	1f9d1-1f3fc-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_tone3	1f9d1-1f3fd-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_medium_skin_tone	1f9d1-1f3fd-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_tone4	1f9d1-1f3fe-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_tone5	1f9d1-1f3ff-200d-1f9bc-200d-27a1-fe0f	-	-
person_in_motorized_wheelchair_facing_right_dark_skin_tone	1f9d1-1f3ff-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right	1f469-200d-1f9bc-200d-27a1-fe0f	people	-
woman_in_motorized_wheelchair_facing_right_tone1	1f469-1f3fb-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_light_skin_tone	1f469-1f3fb-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_tone2	1f469-1f3fc-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_medium_light_skin_tone	1f469-1f3fc-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_tone3	1f469-1f3fd-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_medium_skin_tone	1f469-1f3fd-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_tone4	1f469-1f3fe-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_medium_dark_skin_tone	1f469-1f3fe-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_tone5	1f469-1f3ff-200d-1f9bc-200d-27a1-fe0f	-	-
woman_in_motorized_wheelchair_facing_right_dark_skin_tone	1f469-1f3ff-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right	1f468-200d-1f9bc-200d-27a1-fe0f	people	-
man_in_motorized_wheelchair_facing_right_tone1	1f468-1f3fb-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_light_skin_tone	1f468-1f3fb-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_tone2	1f468-1f3fc-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_medium_light_skin_tone	1f468-1f3fc-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_tone3	1f468-1f3fd-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_medium_skin_tone	1f468-1f3fd-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_tone4	1f468-1f3fe-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_medium_dark_skin_tone	1f468-1f3fe-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_tone5	1f468-1f3ff-200d-1f9bc-200d-27a1-fe0f	-	-
man_in_motorized_wheelchair_facing_right_dark_skin_tone	1f468-1f3ff-200d-1f9bc-200d-27a1-fe0f	-	-
person_walking	1f6b6	people	+
walking	1f6b6	-	+
person_walking_tone1	1f6b6-1f3fb	-	+
walking_tone1	1f6b6-1f3fb	-	+
person_walking_tone2	1f6b6-1f3fc	-	+
walking_tone2	1f6b6-1f3fc	-	+
person_walking_tone3	1f6b6-1f3fd	-	+
walking_tone3	1f6b6-1f3fd	-	+
person_walking_tone4	1f6b6-1f3fe	-	+
walking_tone4	1f6b6-1f3fe	-	+
person_walking_tone5	1f6b6-1f3ff	-	+
walking_tone5	1f6b6-1f3ff	-	+
woman_walking	1f6b6-200d-2640-fe0f	people	+
woman_walking_tone1	1f6b6-1f3fb-200d-2640-fe0f	-	+
woman_walking_light_skin_tone	1f6b6-1f3fb-200d-2640-fe0f	-	+
woman_walking_tone2	1f6b6-1f3fc-200d-2640-fe0f	-	+
woman_walking_medium_light_skin_tone	1f6b6-1f3fc-200d-2640-fe0f	-	+
woman_walking_tone3	1f6b6-1f3fd-200d-2640-fe0f	-	+
woman_walking_medium_skin_tone	1f6b6-1f3fd-200d-2640-fe0f	-	+
woman_walking_tone4	1f6b6-1f3fe-200d-2640-fe0f	-	+
woman_walking_medium_dark_skin_tone	1f6b6-1f3fe-200d-2640-fe0f	-	+
woman_walking_tone5	1f6b6-1f3ff-200d-2640-fe0f	-	+
woman_walking_dark_skin_tone	1f6b6-1f3ff-200d-2640-fe0f	-	+
man_walking	1f6b6-200d-2642-fe0f	people	+
man_walking_tone1	1f6b6-1f3fb-200d-2642-fe0f	-	+
man_walking_light_skin_tone	1f6b6-1f3fb-200d-2642-fe0f	-	+
man_walking_tone2	1f6b6-1f3fc-200d-2642-fe0f	-	+
man_walking_medium_light_skin_tone	1f6b6-1f3fc-200d-2642-fe0f	-	+
man_walking_tone3	1f6b6-1f3fd-200d-2642-fe0f	-	+
man_walking_medium_skin_tone	1f6b6-1f3fd-200d-2642-fe0f	-	+
man_walking_tone4	1f6b6-1f3fe-200d-2642-fe0f	-	+
man_walking_medium_dark_skin_tone	1f6b6-1f3fe-200d-2642-fe0f	-	+
man_walking_tone5	1f6b6-1f3ff-200d-2642-fe0f	-	+
man_walking_dark_skin_tone	1f6b6-1f3ff-200d-2642-fe0f	-	+
person_walking_facing_right	1f6b6-200d-27a1-fe0f	people	-
person_walking_facing_right_tone1	1f6b6-1f3fb-200d-27a1-fe0f	-	-
person_walking_facing_right_light_skin_tone	1f6b6-1f3fb-200d-27a1-fe0f	-	-
person_walking_facing_right_tone2	1f6b6-1f3fc-200d-27a1-fe0f	-	-
person_walking_facing_right_medium_light_skin_tone	1f6b6-1f3fc-200d-27a1-fe0f	-	-
person_walking_facing_right_tone3	1f6b6-1f3fd-200d-27a1-fe0f	-	-
person_walking_facing_right_medium_skin_tone	1f6b6-1f3fd-200d-27a1-fe0f	-	-
person_walking_facing_right_tone4	1f6b6-1f3fe-200d-27a1-fe0f	-	-
person_walking_facing_right_medium_dark_skin_tone	1f6b6-1f3fe-200d-27a1-fe0f	-	-
person_walking_facing_right_tone5	1f6b6-1f3ff-200d-27a1-fe0f	-	-
person_walking_facing_right_dark_skin_tone	1f6b6-1f3ff-200d-27a1-fe0f	-	-
woman_walking_facing_right	1f6b6-200d-2640-fe0f-200d-27a1-fe0f	people	-
woman_walking_facing_right_tone1	1f6b6-1f3fb-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_light_skin_tone	1f6b6-1f3fb-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_tone2	1f6b6-1f3fc-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_medium_light_skin_tone	1f6b6-1f3fc-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_tone3	1f6b6-1f3fd-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_medium_skin_tone	1f6b6-1f3fd-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_tone4	1f6b6-1f3fe-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_medium_dark_skin_tone	1f6b6-1f3fe-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_tone5	1f6b6-1f3ff-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_walking_facing_right_dark_skin_tone	1f6b6-1f3ff-200d-2640-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right	1f6b6-200d-2642-fe0f-200d-27a1-fe0f	people	-
man_walking_facing_right_tone1	1f6b6-1f3fb-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_light_skin_tone	1f6b6-1f3fb-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_tone2	1f6b6-1f3fc-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_medium_light_skin_tone	1f6b6-1f3fc-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_tone3	1f6b6-1f3fd-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_medium_skin_tone	1f6b6-1f3fd-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_tone4	1f6b6-1f3fe-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_medium_dark_skin_tone	1f6b6-1f3fe-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_tone5	1f6b6-1f3ff-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_walking_facing_right_dark_skin_tone	1f6b6-1f3ff-200d-2642-fe0f-200d-27a1-fe0f	-	-
person_with_probing_cane	1f9d1-200d-1f9af	people	-
person_with_probing_cane_tone1	1f9d1-1f3fb-200d-1f9af	-	-
person_with_probing_cane_light_skin_tone	1f9d1-1f3fb-200d-1f9af	-	-
person_with_probing_cane_tone2	1f9d1-1f3fc-200d-1f9af	-	-
person_with_probing_cane_medium_light_skin_tone	1f9d1-1f3fc-200d-1f9af	-	-
person_with_probing_cane_tone3	1f9d1-1f3fd-200d-1f9af	-	-
person_with_probing_cane_medium_skin_tone	1f9d1-1f3fd-200d-1f9af	-	-
person_with_probing_cane_tone4	1f9d1-1f3fe-200d-1f9af	-	-
person_with_probing_cane_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f9af	-	-
person_with_probing_cane_tone5	1f9d1-1f3ff-200d-1f9af	-	-
person_with_probing_cane_dark_skin_tone	1f9d1-1f3ff-200d-1f9af	-	-
woman_with_probing_cane	1f469-200d-1f9af	people	-
woman_with_probing_cane_tone1	1f469-1f3fb-200d-1f9af	-	-
woman_with_probing_cane_light_skin_tone	1f469-1f3fb-200d-1f9af	-	-
woman_with_probing_cane_tone2	1f469-1f3fc-200d-1f9af	-	-
woman_with_probing_cane_medium_light_skin_tone	1f469-1f3fc-200d-1f9af	-	-
woman_with_probing_cane_tone3	1f469-1f3fd-200d-1f9af	-	-
woman_with_probing_cane_medium_skin_tone	1f469-1f3fd-200d-1f9af	-	-
woman_with_probing_cane_tone4	1f469-1f3fe-200d-1f9af	-	-
woman_with_probing_cane_medium_dark_skin_tone	1f469-1f3fe-200d-1f9af	-	-
woman_with_probing_cane_tone5	1f469-1f3ff-200d-1f9af	-	-
woman_with_probing_cane_dark_skin_tone	1f469-1f3ff-200d-1f9af	-	-
man_with_probing_cane	1f468-200d-1f9af	people	-
man_with_probing_cane_tone1	1f468-1f3fb-200d-1f9af	-	-
man_with_probing_cane_light_skin_tone	1f468-1f3fb-200d-1f9af	-	-
man_with_probing_cane_tone2	1f468-1f3fc-200d-1f9af	-	-
man_with_probing_cane_medium_light_skin_tone	1f468-1f3fc-200d-1f9af	-	-
man_with_probing_cane_tone3	1f468-1f3fd-200d-1f9af	-	-
man_with_probing_cane_medium_skin_tone	1f468-1f3fd-200d-1f9af	-	-
man_with_probing_cane_tone4	1f468-1f3fe-200d-1f9af	-	-
man_with_probing_cane_medium_dark_skin_tone	1f468-1f3fe-200d-1f9af	-	-
man_with_probing_cane_tone5	1f468-1f3ff-200d-1f9af	-	-
man_with_probing_cane_dark_skin_tone	1f468-1f3ff-200d-1f9af	-	-
person_with_white_cane_facing_right	1f9d1-200d-1f9af-200d-27a1-fe0f	people	-
person_with_white_cane_facing_right_tone1	1f9d1-1f3fb-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_light_skin_tone	1f9d1-1f3fb-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_tone2	1f9d1-1f3fc-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_medium_light_skin_tone	1f9d1-1f3fc-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_tone3	1f9d1-1f3fd-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_medium_skin_tone	1f9d1-1f3fd-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_tone4	1f9d1-1f3fe-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_tone5	1f9d1-1f3ff-200d-1f9af-200d-27a1-fe0f	-	-
person_with_white_cane_facing_right_dark_skin_tone	1f9d1-1f3ff-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right	1f469-200d-1f9af-200d-27a1-fe0f	people	-
woman_with_white_cane_facing_right_tone1	1f469-1f3fb-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_light_skin_tone	1f469-1f3fb-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_tone2	1f469-1f3fc-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_medium_light_skin_tone	1f469-1f3fc-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_tone3	1f469-1f3fd-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_medium_skin_tone	1f469-1f3fd-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_tone4	1f469-1f3fe-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_medium_dark_skin_tone	1f469-1f3fe-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_tone5	1f469-1f3ff-200d-1f9af-200d-27a1-fe0f	-	-
woman_with_white_cane_facing_right_dark_skin_tone	1f469-1f3ff-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right	1f468-200d-1f9af-200d-27a1-fe0f	people	-
man_with_white_cane_facing_right_tone1	1f468-1f3fb-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_light_skin_tone	1f468-1f3fb-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_tone2	1f468-1f3fc-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_medium_light_skin_tone	1f468-1f3fc-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_tone3	1f468-1f3fd-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_medium_skin_tone	1f468-1f3fd-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_tone4	1f468-1f3fe-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_medium_dark_skin_tone	1f468-1f3fe-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_tone5	1f468-1f3ff-200d-1f9af-200d-27a1-fe0f	-	-
man_with_white_cane_facing_right_dark_skin_tone	1f468-1f3ff-200d-1f9af-200d-27a1-fe0f	-	-
person_kneeling	1f9ce	people	-
person_kneeling_tone1	1f9ce-1f3fb	-	-
person_kneeling_light_skin_tone	1f9ce-1f3fb	-	-
person_kneeling_tone2	1f9ce-1f3fc	-	-
person_kneeling_medium_light_skin_tone	1f9ce-1f3fc	-	-
person_kneeling_tone3	1f9ce-1f3fd	-	-
person_kneeling_medium_skin_tone	1f9ce-1f3fd	-	-
person_kneeling_tone4	1f9ce-1f3fe	-	-
person_kneeling_medium_dark_skin_tone	1f9ce-1f3fe	-	-
person_kneeling_tone5	1f9ce-1f3ff	-	-
person_kneeling_dark_skin_tone	1f9ce-1f3ff	-	-
woman_kneeling	1f9ce-200d-2640-fe0f	people	-
woman_kneeling_tone1	1f9ce-1f3fb-200d-2640-fe0f	-	-
woman_kneeling_light_skin_tone	1f9ce-1f3fb-200d-2640-fe0f	-	-
woman_kneeling_tone2	1f9ce-1f3fc-200d-2640-fe0f	-	-
woman_kneeling_medium_light_skin_tone	1f9ce-1f3fc-200d-2640-fe0f	-	-
woman_kneeling_tone3	1f9ce-1f3fd-200d-2640-fe0f	-	-
woman_kneeling_medium_skin_tone	1f9ce-1f3fd-200d-2640-fe0f	-	-
woman_kneeling_tone4	1f9ce-1f3fe-200d-2640-fe0f	-	-
woman_kneeling_medium_dark_skin_tone	1f9ce-1f3fe-200d-2640-fe0f	-	-
woman_kneeling_tone5	1f9ce-1f3ff-200d-2640-fe0f	-	-
woman_kneeling_dark_skin_tone	1f9ce-1f3ff-200d-2640-fe0f	-	-
man_kneeling	1f9ce-200d-2642-fe0f	people	-
man_kneeling_tone1	1f9ce-1f3fb-200d-2642-fe0f	-	-
man_kneeling_light_skin_tone	1f9ce-1f3fb-200d-2642-fe0f	-	-
man_kneeling_tone2	1f9ce-1f3fc-200d-2642-fe0f	-	-
man_kneeling_medium_light_skin_tone	1f9ce-1f3fc-200d-2642-fe0f	-	-
man_kneeling_tone3	1f9ce-1f3fd-200d-2642-fe0f	-	-
man_kneeling_medium_skin_tone	1f9ce-1f3fd-200d-2642-fe0f	-	-
man_kneeling_tone4	1f9ce-1f3fe-200d-2642-fe0f	-	-
man_kneeling_medium_dark_skin_tone	1f9ce-1f3fe-200d-2642-fe0f	-	-
man_kneeling_tone5	1f9ce-1f3ff-200d-2642-fe0f	-	-
man_kneeling_dark_skin_tone	1f9ce-1f3ff-200d-2642-fe0f	-	-
person_kneeling_facing_right	1f9ce-200d-27a1-fe0f	people	-
person_kneeling_facing_right_tone1	1f9ce-1f3fb-200d-27a1-fe0f	-	-
person_kneeling_facing_right_light_skin_tone	1f9ce-1f3fb-200d-27a1-fe0f	-	-
person_kneeling_facing_right_tone2	1f9ce-1f3fc-200d-27a1-fe0f	-	-
person_kneeling_facing_right_medium_light_skin_tone	1f9ce-1f3fc-200d-27a1-fe0f	-	-
person_kneeling_facing_right_tone3	1f9ce-1f3fd-200d-27a1-fe0f	-	-
person_kneeling_facing_right_medium_skin_tone	1f9ce-1f3fd-200d-27a1-fe0f	-	-
person_kneeling_facing_right_tone4	1f9ce-1f3fe-200d-27a1-fe0f	-	-
person_kneeling_facing_right_medium_dark_skin_tone	1f9ce-1f3fe-200d-27a1-fe0f	-	-
person_kneeling_facing_right_tone5	1f9ce-1f3ff-200d-27a1-fe0f	-	-
person_kneeling_facing_right_dark_skin_tone	1f9ce-1f3ff-200d-27a1-fe0f	-	-
woman_kneeling_facing_right	1f9ce-200d-2640-fe0f-200d-27a1-fe0f	people	-
woman_kneeling_facing_right_tone1	1f9ce-1f3fb-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_light_skin_tone	1f9ce-1f3fb-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_tone2	1f9ce-1f3fc-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_medium_light_skin_tone	1f9ce-1f3fc-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_tone3	1f9ce-1f3fd-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_medium_skin_tone	1f9ce-1f3fd-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_tone4	1f9ce-1f3fe-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_medium_dark_skin_tone	1f9ce-1f3fe-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_tone5	1f9ce-1f3ff-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_kneeling_facing_right_dark_skin_tone	1f9ce-1f3ff-200d-2640-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right	1f9ce-200d-2642-fe0f-200d-27a1-fe0f	people	-
man_kneeling_facing_right_tone1	1f9ce-1f3fb-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_light_skin_tone	1f9ce-1f3fb-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_tone2	1f9ce-1f3fc-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_medium_light_skin_tone	1f9ce-1f3fc-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_tone3	1f9ce-1f3fd-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_medium_skin_tone	1f9ce-1f3fd-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_tone4	1f9ce-1f3fe-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_medium_dark_skin_tone	1f9ce-1f3fe-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_tone5	1f9ce-1f3ff-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_kneeling_facing_right_dark_skin_tone	1f9ce-1f3ff-200d-2642-fe0f-200d-27a1-fe0f	-	-
person_running	1f3c3	people	+
runner	1f3c3	-	+
person_running_tone1	1f3c3-1f3fb	-	+
runner_tone1	1f3c3-1f3fb	-	+
person_running_tone2	1f3c3-1f3fc	-	+
runner_tone2	1f3c3-1f3fc	-	+
person_running_tone3	1f3c3-1f3fd	-	+
runner_tone3	1f3c3-1f3fd	-	+
person_running_tone4	1f3c3-1f3fe	-	+
runner_tone4	1f3c3-1f3fe	-	+
person_running_tone5	1f3c3-1f3ff	-	+
runner_tone5	1f3c3-1f3ff	-	+
woman_running	1f3c3-200d-2640-fe0f	people	+
woman_running_tone1	1f3c3-1f3fb-200d-2640-fe0f	-	+
woman_running_light_skin_tone	1f3c3-1f3fb-200d-2640-fe0f	-	+
woman_running_tone2	1f3c3-1f3fc-200d-2640-fe0f	-	+
woman_running_medium_light_skin_tone	1f3c3-1f3fc-200d-2640-fe0f	-	+
woman_running_tone3	1f3c3-1f3fd-200d-2640-fe0f	-	+
woman_running_medium_skin_tone	1f3c3-1f3fd-200d-2640-fe0f	-	+
woman_running_tone4	1f3c3-1f3fe-200d-2640-fe0f	-	+
woman_running_medium_dark_skin_tone	1f3c3-1f3fe-200d-2640-fe0f	-	+
woman_running_tone5	1f3c3-1f3ff-200d-2640-fe0f	-	+
woman_running_dark_skin_tone	1f3c3-1f3ff-200d-2640-fe0f	-	+
man_running	1f3c3-200d-2642-fe0f	people	+
man_running_tone1	1f3c3-1f3fb-200d-2642-fe0f	-	+
man_running_light_skin_tone	1f3c3-1f3fb-200d-2642-fe0f	-	+
man_running_tone2	1f3c3-1f3fc-200d-2642-fe0f	-	+
man_running_medium_light_skin_tone	1f3c3-1f3fc-200d-2642-fe0f	-	+
man_running_tone3	1f3c3-1f3fd-200d-2642-fe0f	-	+
man_running_medium_skin_tone	1f3c3-1f3fd-200d-2642-fe0f	-	+
man_running_tone4	1f3c3-1f3fe-200d-2642-fe0f	-	+
man_running_medium_dark_skin_tone	1f3c3-1f3fe-200d-2642-fe0f	-	+
man_running_tone5	1f3c3-1f3ff-200d-2642-fe0f	-	+
man_running_dark_skin_tone	1f3c3-1f3ff-200d-2642-fe0f	-	+
person_running_facing_right	1f3c3-200d-27a1-fe0f	people	-
person_running_facing_right_tone1	1f3c3-1f3fb-200d-27a1-fe0f	-	-
person_running_facing_right_light_skin_tone	1f3c3-1f3fb-200d-27a1-fe0f	-	-
person_running_facing_right_tone2	1f3c3-1f3fc-200d-27a1-fe0f	-	-
person_running_facing_right_medium_light_skin_tone	1f3c3-1f3fc-200d-27a1-fe0f	-	-
person_running_facing_right_tone3	1f3c3-1f3fd-200d-27a1-fe0f	-	-
person_running_facing_right_medium_skin_tone	1f3c3-1f3fd-200d-27a1-fe0f	-	-
person_running_facing_right_tone4	1f3c3-1f3fe-200d-27a1-fe0f	-	-
person_running_facing_right_medium_dark_skin_tone	1f3c3-1f3fe-200d-27a1-fe0f	-	-
person_running_facing_right_tone5	1f3c3-1f3ff-200d-27a1-fe0f	-	-
person_running_facing_right_dark_skin_tone	1f3c3-1f3ff-200d-27a1-fe0f	-	-
woman_running_facing_right	1f3c3-200d-2640-fe0f-200d-27a1-fe0f	people	-
woman_running_facing_right_tone1	1f3c3-1f3fb-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_light_skin_tone	1f3c3-1f3fb-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_tone2	1f3c3-1f3fc-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_medium_light_skin_tone	1f3c3-1f3fc-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_tone3	1f3c3-1f3fd-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_medium_skin_tone	1f3c3-1f3fd-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_tone4	1f3c3-1f3fe-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_medium_dark_skin_tone	1f3c3-1f3fe-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_tone5	1f3c3-1f3ff-200d-2640-fe0f-200d-27a1-fe0f	-	-
woman_running_facing_right_dark_skin_tone	1f3c3-1f3ff-200d-2640-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right	1f3c3-200d-2642-fe0f-200d-27a1-fe0f	people	-
man_running_facing_right_tone1	1f3c3-1f3fb-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_light_skin_tone	1f3c3-1f3fb-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_tone2	1f3c3-1f3fc-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_medium_light_skin_tone	1f3c3-1f3fc-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_tone3	1f3c3-1f3fd-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_medium_skin_tone	1f3c3-1f3fd-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_tone4	1f3c3-1f3fe-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_medium_dark_skin_tone	1f3c3-1f3fe-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_tone5	1f3c3-1f3ff-200d-2642-fe0f-200d-27a1-fe0f	-	-
man_running_facing_right_dark_skin_tone	1f3c3-1f3ff-200d-2642-fe0f-200d-27a1-fe0f	-	-
person_standing	1f9cd	people	-
person_standing_tone1	1f9cd-1f3fb	-	-
person_standing_light_skin_tone	1f9cd-1f3fb	-	-
person_standing_tone2	1f9cd-1f3fc	-	-
person_standing_medium_light_skin_tone	1f9cd-1f3fc	-	-
person_standing_tone3	1f9cd-1f3fd	-	-
person_standing_medium_skin_tone	1f9cd-1f3fd	-	-
person_standing_tone4	1f9cd-1f3fe	-	-
person_standing_medium_dark_skin_tone	1f9cd-1f3fe	-	-
person_standing_tone5	1f9cd-1f3ff	-	-
person_standing_dark_skin_tone	1f9cd-1f3ff	-	-
woman_standing	1f9cd-200d-2640-fe0f	people	-
woman_standing_tone1	1f9cd-1f3fb-200d-2640-fe0f	-	-
woman_standing_light_skin_tone	1f9cd-1f3fb-200d-2640-fe0f	-	-
woman_standing_tone2	1f9cd-1f3fc-200d-2640-fe0f	-	-
woman_standing_medium_light_skin_tone	1f9cd-1f3fc-200d-2640-fe0f	-	-
woman_standing_tone3	1f9cd-1f3fd-200d-2640-fe0f	-	-
woman_standing_medium_skin_tone	1f9cd-1f3fd-200d-2640-fe0f	-	-
woman_standing_tone4	1f9cd-1f3fe-200d-2640-fe0f	-	-
woman_standing_medium_dark_skin_tone	1f9cd-1f3fe-200d-2640-fe0f	-	-
woman_standing_tone5	1f9cd-1f3ff-200d-2640-fe0f	-	-
woman_standing_dark_skin_tone	1f9cd-1f3ff-200d-2640-fe0f	-	-
man_standing	1f9cd-200d-2642-fe0f	people	-
man_standing_tone1	1f9cd-1f3fb-200d-2642-fe0f	-	-
man_standing_light_skin_tone	1f9cd-1f3fb-200d-2642-fe0f	-	-
man_standing_tone2	1f9cd-1f3fc-200d-2642-fe0f	-	-
man_standing_medium_light_skin_tone	1f9cd-1f3fc-200d-2642-fe0f	-	-
man_standing_tone3	1f9cd-1f3fd-200d-2642-fe0f	-	-
man_standing_medium_skin_tone	1f9cd-1f3fd-200d-2642-fe0f	-	-
man_standing_tone4	1f9cd-1f3fe-200d-2642-fe0f	-	-
man_standing_medium_dark_skin_tone	1f9cd-1f3fe-200d-2642-fe0f	-	-
man_standing_tone5	1f9cd-1f3ff-200d-2642-fe0f	-	-
man_standing_dark_skin_tone	1f9cd-1f3ff-200d-2642-fe0f	-	-
people_holding_hands	1f9d1-200d-1f91d-200d-1f9d1	people	-
people_holding_hands_tone1	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_light_skin_tone	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_tone1_tone2	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_light_skin_tone_medium_light_skin_tone	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_tone1_tone3	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_light_skin_tone_medium_skin_tone	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_tone1_tone4	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_light_skin_tone_medium_dark_skin_tone	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_tone1_tone5	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_light_skin_tone_dark_skin_tone	1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_tone2_tone1	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_medium_light_skin_tone_light_skin_tone	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_tone2	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_medium_light_skin_tone	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_tone2_tone3	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_medium_light_skin_tone_medium_skin_tone	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_tone2_tone4	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_medium_light_skin_tone_medium_dark_skin_tone	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_tone2_tone5	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_medium_light_skin_tone_dark_skin_tone	1f9d1-1f3fc-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_tone3_tone1	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_medium_skin_tone_light_skin_tone	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_tone3_tone2	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_medium_skin_tone_medium_light_skin_tone	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_tone3	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_medium_skin_tone	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_tone3_tone4	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_medium_skin_tone_medium_dark_skin_tone	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_tone3_tone5	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_medium_skin_tone_dark_skin_tone	1f9d1-1f3fd-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_tone4_tone1	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_medium_dark_skin_tone_light_skin_tone	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_tone4_tone2	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_medium_dark_skin_tone_medium_light_skin_tone	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_tone4_tone3	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_medium_dark_skin_tone_medium_skin_tone	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_tone4	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_medium_dark_skin_tone	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_tone4_tone5	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_medium_dark_skin_tone_dark_skin_tone	1f9d1-1f3fe-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_tone5_tone1	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_dark_skin_tone_light_skin_tone	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fb	-	-
people_holding_hands_tone5_tone2	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_dark_skin_tone_medium_light_skin_tone	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fc	-	-
people_holding_hands_tone5_tone3	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_dark_skin_tone_medium_skin_tone	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fd	-	-
people_holding_hands_tone5_tone4	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_dark_skin_tone_medium_dark_skin_tone	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3fe	-	-
people_holding_hands_tone5	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3ff	-	-
people_holding_hands_dark_skin_tone	1f9d1-1f3ff-200d-1f91d-200d-1f9d1-1f3ff	-	-
couple	1f46b	people	+
woman_and_man_holding_hands_tone1	1f46b-1f3fb	-	-
woman_and_man_holding_hands_light_skin_tone	1f46b-1f3fb	-	-
woman_and_man_holding_hands_tone1_tone2	1f469-1f3fb-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_light_skin_tone_medium_light_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_tone1_tone3	1f469-1f3fb-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_light_skin_tone_medium_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_tone1_tone4	1f469-1f3fb-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_light_skin_tone_medium_dark_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_tone1_tone5	1f469-1f3fb-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_light_skin_tone_dark_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_tone2_tone1	1f469-1f3fc-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_medium_light_skin_tone_light_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_tone2	1f46b-1f3fc	-	-
woman_and_man_holding_hands_medium_light_skin_tone	1f46b-1f3fc	-	-
woman_and_man_holding_hands_tone2_tone3	1f469-1f3fc-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_medium_light_skin_tone_medium_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_tone2_tone4	1f469-1f3fc-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_medium_light_skin_tone_medium_dark_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_tone2_tone5	1f469-1f3fc-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_medium_light_skin_tone_dark_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_tone3_tone1	1f469-1f3fd-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_medium_skin_tone_light_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_tone3_tone2	1f469-1f3fd-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_medium_skin_tone_medium_light_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_tone3	1f46b-1f3fd	-	-
woman_and_man_holding_hands_medium_skin_tone	1f46b-1f3fd	-	-
woman_and_man_holding_hands_tone3_tone4	1f469-1f3fd-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_medium_skin_tone_medium_dark_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_tone3_tone5	1f469-1f3fd-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_medium_skin_tone_dark_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_tone4_tone1	1f469-1f3fe-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_medium_dark_skin_tone_light_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_tone4_tone2	1f469-1f3fe-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_medium_dark_skin_tone_medium_light_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_tone4_tone3	1f469-1f3fe-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_medium_dark_skin_tone_medium_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_tone4	1f46b-1f3fe	-	-
woman_and_man_holding_hands_medium_dark_skin_tone	1f46b-1f3fe	-	-
woman_and_man_holding_hands_tone4_tone5	1f469-1f3fe-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_medium_dark_skin_tone_dark_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f468-1f3ff	-	-
woman_and_man_holding_hands_tone5_tone1	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_dark_skin_tone_light_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fb	-	-
woman_and_man_holding_hands_tone5_tone2	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_dark_skin_tone_medium_light_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fc	-	-
woman_and_man_holding_hands_tone5_tone3	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_dark_skin_tone_medium_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fd	-	-
woman_and_man_holding_hands_tone5_tone4	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_dark_skin_tone_medium_dark_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f468-1f3fe	-	-
woman_and_man_holding_hands_tone5	1f46b-1f3ff	-	-
woman_and_man_holding_hands_dark_skin_tone	1f46b-1f3ff	-	-
two_women_holding_hands	1f46d	people	+
women_holding_hands_tone1	1f46d-1f3fb	-	-
women_holding_hands_light_skin_tone	1f46d-1f3fb	-	-
women_holding_hands_tone1_tone2	1f469-1f3fb-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_light_skin_tone_medium_light_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_tone1_tone3	1f469-1f3fb-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_light_skin_tone_medium_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_tone1_tone4	1f469-1f3fb-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_light_skin_tone_medium_dark_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_tone1_tone5	1f469-1f3fb-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_light_skin_tone_dark_skin_tone	1f469-1f3fb-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_tone2_tone1	1f469-1f3fc-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_medium_light_skin_tone_light_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_tone2	1f46d-1f3fc	-	-
women_holding_hands_medium_light_skin_tone	1f46d-1f3fc	-	-
women_holding_hands_tone2_tone3	1f469-1f3fc-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_medium_light_skin_tone_medium_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_tone2_tone4	1f469-1f3fc-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_medium_light_skin_tone_medium_dark_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_tone2_tone5	1f469-1f3fc-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_medium_light_skin_tone_dark_skin_tone	1f469-1f3fc-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_tone3_tone1	1f469-1f3fd-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_medium_skin_tone_light_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_tone3_tone2	1f469-1f3fd-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_medium_skin_tone_medium_light_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_tone3	1f46d-1f3fd	-	-
women_holding_hands_medium_skin_tone	1f46d-1f3fd	-	-
women_holding_hands_tone3_tone4	1f469-1f3fd-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_medium_skin_tone_medium_dark_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_tone3_tone5	1f469-1f3fd-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_medium_skin_tone_dark_skin_tone	1f469-1f3fd-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_tone4_tone1	1f469-1f3fe-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_medium_dark_skin_tone_light_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_tone4_tone2	1f469-1f3fe-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_medium_dark_skin_tone_medium_light_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_tone4_tone3	1f469-1f3fe-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_medium_dark_skin_tone_medium_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_tone4	1f46d-1f3fe	-	-
women_holding_hands_medium_dark_skin_tone	1f46d-1f3fe	-	-
women_holding_hands_tone4_tone5	1f469-1f3fe-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_medium_dark_skin_tone_dark_skin_tone	1f469-1f3fe-200d-1f91d-200d-1f469-1f3ff	-	-
women_holding_hands_tone5_tone1	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_dark_skin_tone_light_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fb	-	-
women_holding_hands_tone5_tone2	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_dark_skin_tone_medium_light_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fc	-	-
women_holding_hands_tone5_tone3	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_dark_skin_tone_medium_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fd	-	-
women_holding_hands_tone5_tone4	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_dark_skin_tone_medium_dark_skin_tone	1f469-1f3ff-200d-1f91d-200d-1f469-1f3fe	-	-
women_holding_hands_tone5	1f46d-1f3ff	-	-
women_holding_hands_dark_skin_tone	1f46d-1f3ff	-	-
two_men_holding_hands	1f46c	people	+
men_holding_hands_tone1	1f46c-1f3fb	-	-
men_holding_hands_light_skin_tone	1f46c-1f3fb	-	-
men_holding_hands_tone1_tone2	1f468-1f3fb-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_light_skin_tone_medium_light_skin_tone	1f468-1f3fb-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_tone1_tone3	1f468-1f3fb-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_light_skin_tone_medium_skin_tone	1f468-1f3fb-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_tone1_tone4	1f468-1f3fb-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_light_skin_tone_medium_dark_skin_tone	1f468-1f3fb-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_tone1_tone5	1f468-1f3fb-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_light_skin_tone_dark_skin_tone	1f468-1f3fb-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_tone2_tone1	1f468-1f3fc-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_medium_light_skin_tone_light_skin_tone	1f468-1f3fc-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_tone2	1f46c-1f3fc	-	-
men_holding_hands_medium_light_skin_tone	1f46c-1f3fc	-	-
men_holding_hands_tone2_tone3	1f468-1f3fc-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_medium_light_skin_tone_medium_skin_tone	1f468-1f3fc-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_tone2_tone4	1f468-1f3fc-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_medium_light_skin_tone_medium_dark_skin_tone	1f468-1f3fc-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_tone2_tone5	1f468-1f3fc-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_medium_light_skin_tone_dark_skin_tone	1f468-1f3fc-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_tone3_tone1	1f468-1f3fd-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_medium_skin_tone_light_skin_tone	1f468-1f3fd-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_tone3_tone2	1f468-1f3fd-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_medium_skin_tone_medium_light_skin_tone	1f468-1f3fd-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_tone3	1f46c-1f3fd	-	-
men_holding_hands_medium_skin_tone	1f46c-1f3fd	-	-
men_holding_hands_tone3_tone4	1f468-1f3fd-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_medium_skin_tone_medium_dark_skin_tone	1f468-1f3fd-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_tone3_tone5	1f468-1f3fd-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_medium_skin_tone_dark_skin_tone	1f468-1f3fd-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_tone4_tone1	1f468-1f3fe-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_medium_dark_skin_tone_light_skin_tone	1f468-1f3fe-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_tone4_tone2	1f468-1f3fe-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_medium_dark_skin_tone_medium_light_skin_tone	1f468-1f3fe-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_tone4_tone3	1f468-1f3fe-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_medium_dark_skin_tone_medium_skin_tone	1f468-1f3fe-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_tone4	1f46c-1f3fe	-	-
men_holding_hands_medium_dark_skin_tone	1f46c-1f3fe	-	-
men_holding_hands_tone4_tone5	1f468-1f3fe-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_medium_dark_skin_tone_dark_skin_tone	1f468-1f3fe-200d-1f91d-200d-1f468-1f3ff	-	-
men_holding_hands_tone5_tone1	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_dark_skin_tone_light_skin_tone	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fb	-	-
men_holding_hands_tone5_tone2	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_dark_skin_tone_medium_light_skin_tone	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fc	-	-
men_holding_hands_tone5_tone3	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_dark_skin_tone_medium_skin_tone	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fd	-	-
men_holding_hands_tone5_tone4	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_dark_skin_tone_medium_dark_skin_tone	1f468-1f3ff-200d-1f91d-200d-1f468-1f3fe	-	-
men_holding_hands_tone5	1f46c-1f3ff	-	-
men_holding_hands_dark_skin_tone	1f46c-1f3ff	-	-
couple_with_heart	1f491	people	+
couple_with_heart_tone1	1f491-1f3fb	-	-
couple_with_heart_light_skin_tone	1f491-1f3fb	-	-
couple_with_heart_person_person_tone1_tone2	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_light_skin_tone_medium_light_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_tone1_tone3	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_light_skin_tone_medium_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_tone1_tone4	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_light_skin_tone_medium_dark_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_tone1_tone5	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_light_skin_tone_dark_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_tone2_tone1	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_medium_light_skin_tone_light_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_tone2	1f491-1f3fc	-	-
couple_with_heart_medium_light_skin_tone	1f491-1f3fc	-	-
couple_with_heart_person_person_tone2_tone3	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_medium_light_skin_tone_medium_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_tone2_tone4	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_medium_light_skin_tone_medium_dark_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_tone2_tone5	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_medium_light_skin_tone_dark_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_tone3_tone1	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_medium_skin_tone_light_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_tone3_tone2	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_medium_skin_tone_medium_light_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_tone3	1f491-1f3fd	-	-
couple_with_heart_medium_skin_tone	1f491-1f3fd	-	-
couple_with_heart_person_person_tone3_tone4	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_medium_skin_tone_medium_dark_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_tone3_tone5	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_medium_skin_tone_dark_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_tone4_tone1	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_medium_dark_skin_tone_light_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_tone4_tone2	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_medium_dark_skin_tone_medium_light_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_tone4_tone3	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_medium_dark_skin_tone_medium_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_tone4	1f491-1f3fe	-	-
couple_with_heart_medium_dark_skin_tone	1f491-1f3fe	-	-
couple_with_heart_person_person_tone4_tone5	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_medium_dark_skin_tone_dark_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f9d1-1f3ff	-	-
couple_with_heart_person_person_tone5_tone1	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_dark_skin_tone_light_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fb	-	-
couple_with_heart_person_person_tone5_tone2	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_dark_skin_tone_medium_light_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fc	-	-
couple_with_heart_person_person_tone5_tone3	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_dark_skin_tone_medium_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fd	-	-
couple_with_heart_person_person_tone5_tone4	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_person_person_dark_skin_tone_medium_dark_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f9d1-1f3fe	-	-
couple_with_heart_tone5	1f491-1f3ff	-	-
couple_with_heart_dark_skin_tone	1f491-1f3ff	-	-
couple_with_heart_woman_man	1f469-200d-2764-fe0f-200d-1f468	people	+
couple_with_heart_woman_man_tone1	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_tone1_tone2	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_light_skin_tone_medium_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_tone1_tone3	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_light_skin_tone_medium_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_tone1_tone4	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_light_skin_tone_medium_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_tone1_tone5	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_light_skin_tone_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_tone2_tone1	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_medium_light_skin_tone_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_tone2	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_medium_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_tone2_tone3	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_medium_light_skin_tone_medium_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_tone2_tone4	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_medium_light_skin_tone_medium_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_tone2_tone5	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_medium_light_skin_tone_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_tone3_tone1	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_medium_skin_tone_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_tone3_tone2	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_medium_skin_tone_medium_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_tone3	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_medium_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_tone3_tone4	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_medium_skin_tone_medium_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_tone3_tone5	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_medium_skin_tone_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_tone4_tone1	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_medium_dark_skin_tone_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_tone4_tone2	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_medium_dark_skin_tone_medium_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_tone4_tone3	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_medium_dark_skin_tone_medium_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_tone4	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_medium_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_tone4_tone5	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_medium_dark_skin_tone_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_tone5_tone1	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_dark_skin_tone_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_woman_man_tone5_tone2	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_dark_skin_tone_medium_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_woman_man_tone5_tone3	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_dark_skin_tone_medium_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_woman_man_tone5_tone4	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_dark_skin_tone_medium_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_woman_man_tone5	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_woman_man_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_ww	1f469-200d-2764-fe0f-200d-1f469	people	+
couple_with_heart_ww	1f469-200d-2764-fe0f-200d-1f469	-	+
couple_with_heart_woman_woman_tone1	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_tone1_tone2	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_light_skin_tone_medium_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_tone1_tone3	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_light_skin_tone_medium_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_tone1_tone4	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_light_skin_tone_medium_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_tone1_tone5	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_light_skin_tone_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_tone2_tone1	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_medium_light_skin_tone_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_tone2	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_medium_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_tone2_tone3	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_medium_light_skin_tone_medium_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_tone2_tone4	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_medium_light_skin_tone_medium_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_tone2_tone5	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_medium_light_skin_tone_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_tone3_tone1	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_medium_skin_tone_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_tone3_tone2	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_medium_skin_tone_medium_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_tone3	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_medium_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_tone3_tone4	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_medium_skin_tone_medium_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_tone3_tone5	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_medium_skin_tone_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_tone4_tone1	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_medium_dark_skin_tone_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_tone4_tone2	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_medium_dark_skin_tone_medium_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_tone4_tone3	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_medium_dark_skin_tone_medium_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_tone4	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_medium_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_tone4_tone5	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_medium_dark_skin_tone_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_tone5_tone1	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_dark_skin_tone_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fb	-	-
couple_with_heart_woman_woman_tone5_tone2	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_dark_skin_tone_medium_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fc	-	-
couple_with_heart_woman_woman_tone5_tone3	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_dark_skin_tone_medium_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fd	-	-
couple_with_heart_woman_woman_tone5_tone4	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_dark_skin_tone_medium_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3fe	-	-
couple_with_heart_woman_woman_tone5	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_with_heart_woman_woman_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f469-1f3ff	-	-
couple_mm	1f468-200d-2764-fe0f-200d-1f468	people	+
couple_with_heart_mm	1f468-200d-2764-fe0f-200d-1f468	-	+
couple_with_heart_man_man_tone1	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_light_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_tone1_tone2	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_light_skin_tone_medium_light_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_tone1_tone3	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_light_skin_tone_medium_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_tone1_tone4	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_light_skin_tone_medium_dark_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_tone1_tone5	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_light_skin_tone_dark_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_tone2_tone1	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_medium_light_skin_tone_light_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_tone2	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_medium_light_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_tone2_tone3	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_medium_light_skin_tone_medium_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_tone2_tone4	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_medium_light_skin_tone_medium_dark_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_tone2_tone5	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_medium_light_skin_tone_dark_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_tone3_tone1	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_medium_skin_tone_light_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_tone3_tone2	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_medium_skin_tone_medium_light_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_tone3	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_medium_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_tone3_tone4	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_medium_skin_tone_medium_dark_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_tone3_tone5	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_medium_skin_tone_dark_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_tone4_tone1	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_medium_dark_skin_tone_light_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_tone4_tone2	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_medium_dark_skin_tone_medium_light_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_tone4_tone3	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_medium_dark_skin_tone_medium_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_tone4	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_medium_dark_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_tone4_tone5	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_medium_dark_skin_tone_dark_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_tone5_tone1	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_dark_skin_tone_light_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fb	-	-
couple_with_heart_man_man_tone5_tone2	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_dark_skin_tone_medium_light_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fc	-	-
couple_with_heart_man_man_tone5_tone3	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_dark_skin_tone_medium_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fd	-	-
couple_with_heart_man_man_tone5_tone4	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_dark_skin_tone_medium_dark_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3fe	-	-
couple_with_heart_man_man_tone5	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couple_with_heart_man_man_dark_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f468-1f3ff	-	-
couplekiss	1f48f	people	+
kiss_tone1	1f48f-1f3fb	-	-
kiss_light_skin_tone	1f48f-1f3fb	-	-
kiss_person_person_tone1_tone2	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_light_skin_tone_medium_light_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_tone1_tone3	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_light_skin_tone_medium_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_tone1_tone4	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_light_skin_tone_medium_dark_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_tone1_tone5	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_light_skin_tone_dark_skin_tone	1f9d1-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_tone2_tone1	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_medium_light_skin_tone_light_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_tone2	1f48f-1f3fc	-	-
kiss_medium_light_skin_tone	1f48f-1f3fc	-	-
kiss_person_person_tone2_tone3	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_medium_light_skin_tone_medium_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_tone2_tone4	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_medium_light_skin_tone_medium_dark_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_tone2_tone5	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_medium_light_skin_tone_dark_skin_tone	1f9d1-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_tone3_tone1	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_medium_skin_tone_light_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_tone3_tone2	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_medium_skin_tone_medium_light_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_tone3	1f48f-1f3fd	-	-
kiss_medium_skin_tone	1f48f-1f3fd	-	-
kiss_person_person_tone3_tone4	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_medium_skin_tone_medium_dark_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_tone3_tone5	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_medium_skin_tone_dark_skin_tone	1f9d1-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_tone4_tone1	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_medium_dark_skin_tone_light_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_tone4_tone2	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_medium_dark_skin_tone_medium_light_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_tone4_tone3	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_medium_dark_skin_tone_medium_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_tone4	1f48f-1f3fe	-	-
kiss_medium_dark_skin_tone	1f48f-1f3fe	-	-
kiss_person_person_tone4_tone5	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_medium_dark_skin_tone_dark_skin_tone	1f9d1-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3ff	-	-
kiss_person_person_tone5_tone1	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_dark_skin_tone_light_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fb	-	-
kiss_person_person_tone5_tone2	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_dark_skin_tone_medium_light_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fc	-	-
kiss_person_person_tone5_tone3	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_dark_skin_tone_medium_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fd	-	-
kiss_person_person_tone5_tone4	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_person_person_dark_skin_tone_medium_dark_skin_tone	1f9d1-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f9d1-1f3fe	-	-
kiss_tone5	1f48f-1f3ff	-	-
kiss_dark_skin_tone	1f48f-1f3ff	-	-
kiss_woman_man	1f469-200d-2764-fe0f-200d-1f48b-200d-1f468	people	+
kiss_woman_man_tone1	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_tone1_tone2	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_light_skin_tone_medium_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_tone1_tone3	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_light_skin_tone_medium_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_tone1_tone4	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_light_skin_tone_medium_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_tone1_tone5	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_light_skin_tone_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_tone2_tone1	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_medium_light_skin_tone_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_tone2	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_medium_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_tone2_tone3	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_medium_light_skin_tone_medium_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_tone2_tone4	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_medium_light_skin_tone_medium_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_tone2_tone5	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_medium_light_skin_tone_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_tone3_tone1	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_medium_skin_tone_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_tone3_tone2	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_medium_skin_tone_medium_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_tone3	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_medium_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_tone3_tone4	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_medium_skin_tone_medium_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_tone3_tone5	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_medium_skin_tone_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_tone4_tone1	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_medium_dark_skin_tone_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_tone4_tone2	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_medium_dark_skin_tone_medium_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_tone4_tone3	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_medium_dark_skin_tone_medium_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_tone4	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_medium_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_tone4_tone5	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_medium_dark_skin_tone_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_tone5_tone1	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_dark_skin_tone_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_woman_man_tone5_tone2	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_dark_skin_tone_medium_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_woman_man_tone5_tone3	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_dark_skin_tone_medium_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_woman_man_tone5_tone4	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_dark_skin_tone_medium_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_woman_man_tone5	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_woman_man_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_ww	1f469-200d-2764-fe0f-200d-1f48b-200d-1f469	people	+
couplekiss_ww	1f469-200d-2764-fe0f-200d-1f48b-200d-1f469	-	+
kiss_woman_woman_tone1	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_tone1_tone2	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_light_skin_tone_medium_light_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_tone1_tone3	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_light_skin_tone_medium_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_tone1_tone4	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_light_skin_tone_medium_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_tone1_tone5	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_light_skin_tone_dark_skin_tone	1f469-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_tone2_tone1	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_medium_light_skin_tone_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_tone2	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_medium_light_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_tone2_tone3	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_medium_light_skin_tone_medium_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_tone2_tone4	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_medium_light_skin_tone_medium_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_tone2_tone5	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_medium_light_skin_tone_dark_skin_tone	1f469-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_tone3_tone1	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_medium_skin_tone_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_tone3_tone2	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_medium_skin_tone_medium_light_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_tone3	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_medium_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_tone3_tone4	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_medium_skin_tone_medium_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_tone3_tone5	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_medium_skin_tone_dark_skin_tone	1f469-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_tone4_tone1	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_medium_dark_skin_tone_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_tone4_tone2	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_medium_dark_skin_tone_medium_light_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_tone4_tone3	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_medium_dark_skin_tone_medium_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_tone4	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_medium_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_tone4_tone5	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_medium_dark_skin_tone_dark_skin_tone	1f469-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_tone5_tone1	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_dark_skin_tone_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fb	-	-
kiss_woman_woman_tone5_tone2	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_dark_skin_tone_medium_light_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fc	-	-
kiss_woman_woman_tone5_tone3	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_dark_skin_tone_medium_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fd	-	-
kiss_woman_woman_tone5_tone4	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_dark_skin_tone_medium_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3fe	-	-
kiss_woman_woman_tone5	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_woman_woman_dark_skin_tone	1f469-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f469-1f3ff	-	-
kiss_mm	1f468-200d-2764-fe0f-200d-1f48b-200d-1f468	people	+
couplekiss_mm	1f468-200d-2764-fe0f-200d-1f48b-200d-1f468	-	+
kiss_man_man	1f468-200d-2764-fe0f-200d-1f48b-200d-1f468	-	-
kiss_man_man_tone1	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_light_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_tone1_tone2	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_light_skin_tone_medium_light_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_tone1_tone3	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_light_skin_tone_medium_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_tone1_tone4	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_light_skin_tone_medium_dark_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_tone1_tone5	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_light_skin_tone_dark_skin_tone	1f468-1f3fb-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_tone2_tone1	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_medium_light_skin_tone_light_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_tone2	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_medium_light_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_tone2_tone3	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_medium_light_skin_tone_medium_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_tone2_tone4	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_medium_light_skin_tone_medium_dark_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_tone2_tone5	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_medium_light_skin_tone_dark_skin_tone	1f468-1f3fc-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_tone3_tone1	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_medium_skin_tone_light_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_tone3_tone2	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_medium_skin_tone_medium_light_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_tone3	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_medium_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_tone3_tone4	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_medium_skin_tone_medium_dark_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_tone3_tone5	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_medium_skin_tone_dark_skin_tone	1f468-1f3fd-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_tone4_tone1	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_medium_dark_skin_tone_light_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_tone4_tone2	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_medium_dark_skin_tone_medium_light_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_tone4_tone3	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_medium_dark_skin_tone_medium_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_tone4	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_medium_dark_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_tone4_tone5	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_medium_dark_skin_tone_dark_skin_tone	1f468-1f3fe-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_tone5_tone1	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_dark_skin_tone_light_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fb	-	-
kiss_man_man_tone5_tone2	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_dark_skin_tone_medium_light_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fc	-	-
kiss_man_man_tone5_tone3	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_dark_skin_tone_medium_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fd	-	-
kiss_man_man_tone5_tone4	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_dark_skin_tone_medium_dark_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3fe	-	-
kiss_man_man_tone5	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
kiss_man_man_dark_skin_tone	1f468-1f3ff-200d-2764-fe0f-200d-1f48b-200d-1f468-1f3ff	-	-
family_adult_adult_child	1f9d1-200d-1f9d1-200d-1f9d2	people	-
family_adult_adult_child_child	1f9d1-200d-1f9d1-200d-1f9d2-200d-1f9d2	people	-
family_adult_child_child	1f9d1-200d-1f9d2-200d-1f9d2	people	-
family_adult_child	1f9d1-200d-1f9d2	people	-
family	1f46a	people	+
family_man_woman_boy	1f468-200d-1f469-200d-1f466	people	+
family_mwg	1f468-200d-1f469-200d-1f467	people	+
family_mwgb	1f468-200d-1f469-200d-1f467-200d-1f466	people	+
family_mwbb	1f468-200d-1f469-200d-1f466-200d-1f466	people	+
family_mwgg	1f468-200d-1f469-200d-1f467-200d-1f467	people	+
family_wwb	1f469-200d-1f469-200d-1f466	people	+
family_wwg	1f469-200d-1f469-200d-1f467	people	+
family_wwgb	1f469-200d-1f469-200d-1f467-200d-1f466	people	+
family_wwbb	1f469-200d-1f469-200d-1f466-200d-1f466	people	+
family_wwgg	1f469-200d-1f469-200d-1f467-200d-1f467	people	+
family_mmb	1f468-200d-1f468-200d-1f466	people	+
family_mmg	1f468-200d-1f468-200d-1f467	people	+
family_mmgb	1f468-200d-1f468-200d-1f467-200d-1f466	people	+
family_mmbb	1f468-200d-1f468-200d-1f466-200d-1f466	people	+
family_mmgg	1f468-200d-1f468-200d-1f467-200d-1f467	people	+
family_woman_boy	1f469-200d-1f466	people	+
family_woman_girl	1f469-200d-1f467	people	+
family_woman_girl_boy	1f469-200d-1f467-200d-1f466	people	+
family_woman_boy_boy	1f469-200d-1f466-200d-1f466	people	+
family_woman_girl_girl	1f469-200d-1f467-200d-1f467	people	+
family_man_boy	1f468-200d-1f466	people	+
family_man_girl	1f468-200d-1f467	people	+
family_man_girl_boy	1f468-200d-1f467-200d-1f466	people	+
family_man_boy_boy	1f468-200d-1f466-200d-1f466	people	+
family_man_girl_girl	1f468-200d-1f467-200d-1f467	people	+
knot	1faa2	people	-
yarn	1f9f6	people	+
thread	1f9f5	people	+
sewing_needle	1faa1	people	-
coat	1f9e5	people	+
lab_coat	1f97c	people	+
safety_vest	1f9ba	people	-
womans_clothes	1f45a	people	+
shirt	1f455	people	+
t_shirt	1f455	-	-
jeans	1f456	people	+
briefs	1fa72	people	-
shorts	1fa73	people	-
necktie	1f454	people	+
dress	1f457	people	+
bikini	1f459	people	+
one_piece_swimsuit	1fa71	people	-
kimono	1f458	people	+
sari	1f97b	people	-
thong_sandal	1fa74	people	-
womans_flat_shoe	1f97f	people	+
flat_shoe	1f97f	-	-
high_heel	1f460	people	+
sandal	1f461	people	+
womans_sandal	1f461	-	-
boot	1f462	people	+
womans_boot	1f462	-	-
mans_shoe	1f45e	people	+
athletic_shoe	1f45f	people	+
running_shoe	1f45f	-	-
hiking_boot	1f97e	people	+
socks	1f9e6	people	+
gloves	1f9e4	people	+
scarf	1f9e3	people	+
tophat	1f3a9	people	+
top_hat	1f3a9	-	-
billed_cap	1f9e2	people	+
womans_hat	1f452	people	+
mortar_board	1f393	people	+
helmet_with_cross	26d1-fe0f	people	+
helmet_with_white_cross	26d1-fe0f	-	+
military_helmet	1fa96	people	-
crown	1f451	people	+
ring	1f48d	people	+
pouch	1f45d	people	+
clutch_bag	1f45d	-	-
purse	1f45b	people	+
handbag	1f45c	people	+
briefcase	1f4bc	people	+
school_satchel	1f392	people	+
backpack	1f392	-	-
luggage	1f9f3	people	+
eyeglasses	1f453	people	+
glasses	1f453	-	-
dark_sunglasses	1f576-fe0f	people	+
goggles	1f97d	people	+
closed_umbrella	1f302	people	+
dog	1f436	nature	+
dog_face	1f436	-	-
cat	1f431	nature	+
cat_face	1f431	-	-
mouse	1f42d	nature	+
mouse_face	1f42d	-	-
hamster	1f439	nature	+
rabbit	1f430	nature	+
rabbit_face	1f430	-	-
fox	1f98a	nature	+
fox_face	1f98a	-	+
bear	1f43b	nature	+
panda_face	1f43c	nature	+
panda	1f43c	-	-
polar_bear	1f43b-200d-2744-fe0f	nature	-
koala	1f428	nature	+
tiger	1f42f	nature	+
tiger_face	1f42f	-	-
lion_face	1f981	nature	+
lion	1f981	-	+
cow	1f42e	nature	+
cow_face	1f42e	-	-
pig	1f437	nature	+
pig_face	1f437	-	-
pig_nose	1f43d	nature	+
frog	1f438	nature	+
monkey_face	1f435	nature	+
see_no_evil	1f648	nature	+
hear_no_evil	1f649	nature	+
speak_no_evil	1f64a	nature	+
monkey	1f412	nature	+
chicken	1f414	nature	+
penguin	1f427	nature	+
bird	1f426	nature	+
baby_chick	1f424	nature	+
hatching_chick	1f423	nature	+
hatched_chick	1f425	nature	+
goose	1fabf	nature	-
duck	1f986	nature	+
black_bird	1f426-200d-2b1b	nature	-
eagle	1f985	nature	+
owl	1f989	nature	+
bat	1f987	nature	+
wolf	1f43a	nature	+
boar	1f417	nature	+
horse	1f434	nature	+
horse_face	1f434	-	-
unicorn	1f984	nature	+
unicorn_face	1f984	-	+
moose	1face	nature	-
bee	1f41d	nature	+
honeybee	1f41d	-	-
worm	1fab1	nature	-
bug	1f41b	nature	+
butterfly	1f98b	nature	+
snail	1f40c	nature	+
lady_beetle	1f41e	nature	-
ant	1f41c	nature	+
fly	1fab0	nature	-
beetle	1fab2	nature	+
cockroach	1fab3	nature	-
mosquito	1f99f	nature	+
cricket	1f997	nature	+
spider	1f577-fe0f	nature	+
spider_web	1f578-fe0f	nature	+
scorpion	1f982	nature	+
turtle	1f422	nature	+
snake	1f40d	nature	+
lizard	1f98e	nature	+
t_rex	1f996	nature	+
sauropod	1f995	nature	+
octopus	1f419	nature	+
squid	1f991	nature	+
jellyfish	1fabc	nature	-
shrimp	1f990	nature	+
lobster	1f99e	nature	+
crab	1f980	nature	+
blowfish	1f421	nature	+
tropical_fish	1f420	nature	+
fish	1f41f	nature	+
dolphin	1f42c	nature	+
whale	1f433	nature	+
whale2	1f40b	nature	+
shark	1f988	nature	+
seal	1f9ad	nature	-
crocodile	1f40a	nature	+
tiger2	1f405	nature	+
leopard	1f406	nature	+
zebra	1f993	nature	+
gorilla	1f98d	nature	+
orangutan	1f9a7	nature	-
mammoth	1f9a3	nature	-
elephant	1f418	nature	+
hippopotamus	1f99b	nature	+
rhino	1f98f	nature	+
rhinoceros	1f98f	-	+
dromedary_camel	1f42a	nature	+
camel	1f42b	nature	+
giraffe	1f992	nature	+
kangaroo	1f998	nature	+
bison	1f9ac	nature	-
water_buffalo	1f403	nature	+
ox	1f402	nature	+
cow2	1f404	nature	+
donkey	1facf	nature	-
racehorse	1f40e	nature	+
pig2	1f416	nature	+
ram	1f40f	nature	+
sheep	1f411	nature	+
ewe	1f411	-	-
llama	1f999	nature	+
goat	1f410	nature	+
deer	1f98c	nature	+
dog2	1f415	nature	+
poodle	1f429	nature	+
guide_dog	1f9ae	nature	-
service_dog	1f415-200d-1f9ba	nature	-
cat2	1f408	nature	+
black_cat	1f408-200d-2b1b	nature	-
feather	1fab6	nature	-
wing	1fabd	nature	-
rooster	1f413	nature	+
turkey	1f983	nature	+
dodo	1f9a4	nature	-
peacock	1f99a	nature	+
parrot	1f99c	nature	+
swan	1f9a2	nature	+
flamingo	1f9a9	nature	-
dove	1f54a-fe0f	nature	+
dove_of_peace	1f54a-fe0f	-	+
rabbit2	1f407	nature	+
raccoon	1f99d	nature	+
skunk	1f9a8	nature	-
badger	1f9a1	nature	+
beaver	1f9ab	nature	-
otter	1f9a6	nature	-
sloth	1f9a5	nature	-
mouse2	1f401	nature	+
rat	1f400	nature	+
chipmunk	1f43f-fe0f	nature	+
hedgehog	1f994	nature	+
feet	1f43e	nature	+
paw_prints	1f43e	-	+
dragon	1f409	nature	+
dragon_face	1f432	nature	+
phoenix	1f426-200d-1f525	nature	-
cactus	1f335	nature	+
christmas_tree	1f384	nature	+
evergreen_tree	1f332	nature	+
deciduous_tree	1f333	nature	+
palm_tree	1f334	nature	+
leafless_tree	1fabe	nature	-
wood	1fab5	nature	-
seedling	1f331	nature	+
herb	1f33f	nature	+
shamrock	2618-fe0f	nature	+
four_leaf_clover	1f340	nature	+
bamboo	1f38d	nature	+
potted_plant	1fab4	nature	-
tanabata_tree	1f38b	nature	+
leaves	1f343	nature	+
fallen_leaf	1f342	nature	+
maple_leaf	1f341	nature	+
nest_with_eggs	1faba	nature	-
empty_nest	1fab9	nature	-
mushroom	1f344	nature	+
brown_mushroom	1f344-200d-1f7eb	nature	-
shell	1f41a	nature	+
spiral_shell	1f41a	-	-
coral	1fab8	nature	-
rock	1faa8	nature	-
ear_of_rice	1f33e	nature	+
sheaf_of_rice	1f33e	-	-
bouquet	1f490	nature	+
tulip	1f337	nature	+
rose	1f339	nature	+
wilted_rose	1f940	nature	+
wilted_flower	1f940	-	+
hyacinth	1fabb	nature	-
lotus	1fab7	nature	-
hibiscus	1f33a	nature	+
cherry_blossom	1f338	nature	+
blossom	1f33c	nature	+
sunflower	1f33b	nature	+
sun_with_face	1f31e	nature	+
full_moon_with_face	1f31d	nature	+
first_quarter_moon_with_face	1f31b	nature	+
last_quarter_moon_with_face	1f31c	nature	+
new_moon_with_face	1f31a	nature	+
new_moon_face	1f31a	-	-
full_moon	1f315	nature	+
waning_gibbous_moon	1f316	nature	+
last_quarter_moon	1f317	nature	+
waning_crescent_moon	1f318	nature	+
new_moon	1f311	nature	+
waxing_crescent_moon	1f312	nature	+
first_quarter_moon	1f313	nature	+
waxing_gibbous_moon	1f314	nature	+
crescent_moon	1f319	nature	+
earth_americas	1f30e	nature	+
earth_africa	1f30d	nature	+
earth_asia	1f30f	nature	+
ringed_planet	1fa90	nature	-
dizzy	1f4ab	nature	+
star	2b50	nature	+
star2	1f31f	nature	+
glowing_star	1f31f	-	-
sparkles	2728	nature	+
zap	26a1-fe0f	nature	+
high_voltage	26a1-fe0f	-	-
comet	2604-fe0f	nature	+
boom	1f4a5	nature	+
collision	1f4a5	-	-
fire	1f525	nature	+
flame	1f525	-	+
cloud_tornado	1f32a-fe0f	nature	+
cloud_with_tornado	1f32a-fe0f	-	+
tornado	1f32a-fe0f	-	-
rainbow	1f308	nature	+
sunny	2600-fe0f	nature	+
sun	2600-fe0f	-	-
white_sun_small_cloud	1f324-fe0f	nature	+
white_sun_with_small_cloud	1f324-fe0f	-	+
partly_sunny	26c5	nature	+
white_sun_cloud	1f325-fe0f	nature	+
white_sun_behind_cloud	1f325-fe0f	-	+
cloud	2601-fe0f	nature	+
white_sun_rain_cloud	1f326-fe0f	nature	+
white_sun_behind_cloud_with_rain	1f326-fe0f	-	+
cloud_rain	1f327-fe0f	nature	+
cloud_with_rain	1f327-fe0f	-	+
thunder_cloud_rain	26c8-fe0f	nature	+
thunder_cloud_and_rain	26c8-fe0f	-	+
cloud_lightning	1f329-fe0f	nature	+
cloud_with_lightning	1f329-fe0f	-	+
cloud_snow	1f328-fe0f	nature	+
cloud_with_snow	1f328-fe0f	-	+
snowflake	2744-fe0f	nature	+
snowman2	2603-fe0f	nature	+
snowman	26c4	nature	+
wind_blowing_face	1f32c-fe0f	nature	+
wind_face	1f32c-fe0f	-	-
dash	1f4a8	nature	+
dashing_away	1f4a8	-	-
droplet	1f4a7	nature	+
sweat_drops	1f4a6	nature	+
bubbles	1fae7	nature	-
umbrella	2614	nature	+
umbrella2	2602-fe0f	nature	+
ocean	1f30a	nature	+
water_wave	1f30a	-	-
fog	1f32b-fe0f	nature	+
green_apple	1f34f	food	+
apple	1f34e	food	+
red_apple	1f34e	-	-
pear	1f350	food	+
tangerine	1f34a	food	+
lemon	1f34b	food	+
lime	1f34b-200d-1f7e9	food	-
banana	1f34c	food	+
watermelon	1f349	food	+
grapes	1f347	food	+
strawberry	1f353	food	+
blueberries	1fad0	food	-
melon	1f348	food	+
cherries	1f352	food	+
peach	1f351	food	+
mango	1f96d	food	+
pineapple	1f34d	food	+
coconut	1f965	food	+
kiwi	1f95d	food	+
kiwifruit	1f95d	-	+
kiwi_fruit	1f95d	-	-
tomato	1f345	food	+
eggplant	1f346	food	+
avocado	1f951	food	+
pea_pod	1fadb	food	-
broccoli	1f966	food	+
leafy_green	1f96c	food	+
cucumber	1f952	food	+
hot_pepper	1f336-fe0f	food	+
bell_pepper	1fad1	food	-
corn	1f33d	food	+
ear_of_corn	1f33d	-	-
carrot	1f955	food	+
olive	1fad2	food	-
garlic	1f9c4	food	-
onion	1f9c5	food	-
potato	1f954	food	+
root_vegetable	1fadc	food	-
sweet_potato	1f360	food	+
ginger_root	1fada	food	-
croissant	1f950	food	+
bagel	1f96f	food	+
bread	1f35e	food	+
french_bread	1f956	food	+
baguette_bread	1f956	-	+
pretzel	1f968	food	+
cheese	1f9c0	food	+
cheese_wedge	1f9c0	-	+
egg	1f95a	food	+
cooking	1f373	food	+
butter	1f9c8	food	-
pancakes	1f95e	food	+
waffle	1f9c7	food	-
bacon	1f953	food	+
cut_of_meat	1f969	food	+
poultry_leg	1f357	food	+
meat_on_bone	1f356	food	+
bone	1f9b4	food	+
hotdog	1f32d	food	+
hot_dog	1f32d	-	+
hamburger	1f354	food	+
fries	1f35f	food	+
french_fries	1f35f	-	-
pizza	1f355	food	+
flatbread	1fad3	food	-
sandwich	1f96a	food	+
stuffed_flatbread	1f959	food	+
stuffed_pita	1f959	-	+
falafel	1f9c6	food	-
taco	1f32e	food	+
burrito	1f32f	food	+
tamale	1fad4	food	-
salad	1f957	food	+
green_salad	1f957	-	+
shallow_pan_of_food	1f958	food	+
paella	1f958	-	+
fondue	1fad5	food	-
canned_food	1f96b	food	+
jar	1fad9	food	-
spaghetti	1f35d	food	+
ramen	1f35c	food	+
steaming_bowl	1f35c	-	-
stew	1f372	food	+
pot_of_food	1f372	-	-
curry	1f35b	food	+
curry_rice	1f35b	-	-
sushi	1f363	food	+
bento	1f371	food	+
bento_box	1f371	-	-
dumpling	1f95f	food	+
oyster	1f9aa	food	-
fried_shrimp	1f364	food	+
rice_ball	1f359	food	+
rice	1f35a	food	+
cooked_rice	1f35a	-	-
rice_cracker	1f358	food	+
fish_cake	1f365	food	+
fortune_cookie	1f960	food	+
moon_cake	1f96e	food	+
oden	1f362	food	+
dango	1f361	food	+
shaved_ice	1f367	food	+
ice_cream	1f368	food	+
icecream	1f366	food	+
pie	1f967	food	+
cupcake	1f9c1	food	+
cake	1f370	food	+
shortcake	1f370	-	-
birthday	1f382	food	+
birthday_cake	1f382	-	-
custard	1f36e	food	+
pudding	1f36e	-	+
flan	1f36e	-	+
lollipop	1f36d	food	+
candy	1f36c	food	+
chocolate_bar	1f36b	food	+
popcorn	1f37f	food	+
doughnut	1f369	food	+
cookie	1f36a	food	+
chestnut	1f330	food	+
peanuts	1f95c	food	+
shelled_peanut	1f95c	-	+
beans	1fad8	food	-
honey_pot	1f36f	food	+
milk	1f95b	food	+
glass_of_milk	1f95b	-	+
pouring_liquid	1fad7	food	-
baby_bottle	1f37c	food	+
teapot	1fad6	food	-
coffee	2615	food	+
hot_beverage	2615	-	-
tea	1f375	food	+
mate	1f9c9	food	-
beverage_box	1f9c3	food	-
cup_with_straw	1f964	food	+
bubble_tea	1f9cb	food	-
sake	1f376	food	+
beer	1f37a	food	+
beer_mug	1f37a	-	-
beers	1f37b	food	+
champagne_glass	1f942	food	+
clinking_glass	1f942	-	+
wine_glass	1f377	food	+
tumbler_glass	1f943	food	+
whisky	1f943	-	+
cocktail	1f378	food	+
tropical_drink	1f379	food	+
champagne	1f37e	food	+
bottle_with_popping_cork	1f37e	-	+
ice_cube	1f9ca	food	-
spoon	1f944	food	+
fork_and_knife	1f374	food	+
fork_knife_plate	1f37d-fe0f	food	+
fork_and_knife_with_plate	1f37d-fe0f	-	+
bowl_with_spoon	1f963	food	+
takeout_box	1f961	food	+
chopsticks	1f962	food	+
salt	1f9c2	food	+
soccer	26bd	activity	+
soccer_ball	26bd	-	-
basketball	1f3c0	activity	+
football	1f3c8	activity	+
baseball	26be	activity	+
softball	1f94e	activity	+
tennis	1f3be	activity	+
volleyball	1f3d0	activity	+
rugby_football	1f3c9	activity	+
flying_disc	1f94f	activity	+
8ball	1f3b1	activity	+
yo_yo	1fa80	activity	-
ping_pong	1f3d3	activity	+
table_tennis	1f3d3	-	+
badminton	1f3f8	activity	+
hockey	1f3d2	activity	+
ice_hockey	1f3d2	-	-
field_hockey	1f3d1	activity	+
lacrosse	1f94d	activity	+
cricket_game	1f3cf	activity	+
cricket_bat_ball	1f3cf	-	+
boomerang	1fa83	activity	-
goal	1f945	activity	+
goal_net	1f945	-	+
golf	26f3	activity	+
flag_in_hole	26f3	-	-
kite	1fa81	activity	-
playground_slide	1f6dd	activity	-
bow_and_arrow	1f3f9	activity	+
archery	1f3f9	-	+
fishing_pole_and_fish	1f3a3	activity	+
fishing_pole	1f3a3	-	-
diving_mask	1f93f	activity	-
boxing_glove	1f94a	activity	+
boxing_gloves	1f94a	-	+
martial_arts_uniform	1f94b	activity	+
karate_uniform	1f94b	-	+
running_shirt_with_sash	1f3bd	activity	+
running_shirt	1f3bd	-	-
skateboard	1f6f9	activity	+
roller_skate	1f6fc	activity	-
sled	1f6f7	activity	+
ice_skate	26f8-fe0f	activity	+
curling_stone	1f94c	activity	+
ski	1f3bf	activity	+
skis	1f3bf	-	-
skier	26f7-fe0f	activity	+
snowboarder	1f3c2	activity	+
snowboarder_tone1	1f3c2-1f3fb	-	+
snowboarder_light_skin_tone	1f3c2-1f3fb	-	+
snowboarder_tone2	1f3c2-1f3fc	-	+
snowboarder_medium_light_skin_tone	1f3c2-1f3fc	-	+
snowboarder_tone3	1f3c2-1f3fd	-	+
snowboarder_medium_skin_tone	1f3c2-1f3fd	-	+
snowboarder_tone4	1f3c2-1f3fe	-	+
snowboarder_medium_dark_skin_tone	1f3c2-1f3fe	-	+
snowboarder_tone5	1f3c2-1f3ff	-	+
snowboarder_dark_skin_tone	1f3c2-1f3ff	-	+
parachute	1fa82	activity	-
person_lifting_weights	1f3cb-fe0f	activity	+
lifter	1f3cb-fe0f	-	+
weight_lifter	1f3cb-fe0f	-	+
person_lifting_weights_tone1	1f3cb-1f3fb	-	+
lifter_tone1	1f3cb-1f3fb	-	+
weight_lifter_tone1	1f3cb-1f3fb	-	+
person_lifting_weights_tone2	1f3cb-1f3fc	-	+
lifter_tone2	1f3cb-1f3fc	-	+
weight_lifter_tone2	1f3cb-1f3fc	-	+
person_lifting_weights_tone3	1f3cb-1f3fd	-	+
lifter_tone3	1f3cb-1f3fd	-	+
weight_lifter_tone3	1f3cb-1f3fd	-	+
person_lifting_weights_tone4	1f3cb-1f3fe	-	+
lifter_tone4	1f3cb-1f3fe	-	+
weight_lifter_tone4	1f3cb-1f3fe	-	+
person_lifting_weights_tone5	1f3cb-1f3ff	-	+
lifter_tone5	1f3cb-1f3ff	-	+
weight_lifter_tone5	1f3cb-1f3ff	-	+
woman_lifting_weights	1f3cb-fe0f-200d-2640-fe0f	activity	+
woman_lifting_weights_tone1	1f3cb-1f3fb-200d-2640-fe0f	-	+
woman_lifting_weights_light_skin_tone	1f3cb-1f3fb-200d-2640-fe0f	-	+
woman_lifting_weights_tone2	1f3cb-1f3fc-200d-2640-fe0f	-	+
woman_lifting_weights_medium_light_skin_tone	1f3cb-1f3fc-200d-2640-fe0f	-	+
woman_lifting_weights_tone3	1f3cb-1f3fd-200d-2640-fe0f	-	+
woman_lifting_weights_medium_skin_tone	1f3cb-1f3fd-200d-2640-fe0f	-	+
woman_lifting_weights_tone4	1f3cb-1f3fe-200d-2640-fe0f	-	+
woman_lifting_weights_medium_dark_skin_tone	1f3cb-1f3fe-200d-2640-fe0f	-	+
woman_lifting_weights_tone5	1f3cb-1f3ff-200d-2640-fe0f	-	+
woman_lifting_weights_dark_skin_tone	1f3cb-1f3ff-200d-2640-fe0f	-	+
man_lifting_weights	1f3cb-fe0f-200d-2642-fe0f	activity	+
man_lifting_weights_tone1	1f3cb-1f3fb-200d-2642-fe0f	-	+
man_lifting_weights_light_skin_tone	1f3cb-1f3fb-200d-2642-fe0f	-	+
man_lifting_weights_tone2	1f3cb-1f3fc-200d-2642-fe0f	-	+
man_lifting_weights_medium_light_skin_tone	1f3cb-1f3fc-200d-2642-fe0f	-	+
man_lifting_weights_tone3	1f3cb-1f3fd-200d-2642-fe0f	-	+
man_lifting_weights_medium_skin_tone	1f3cb-1f3fd-200d-2642-fe0f	-	+
man_lifting_weights_tone4	1f3cb-1f3fe-200d-2642-fe0f	-	+
man_lifting_weights_medium_dark_skin_tone	1f3cb-1f3fe-200d-2642-fe0f	-	+
man_lifting_weights_tone5	1f3cb-1f3ff-200d-2642-fe0f	-	+
man_lifting_weights_dark_skin_tone	1f3cb-1f3ff-200d-2642-fe0f	-	+
people_wrestling	1f93c	activity	+
wrestlers	1f93c	-	+
wrestling	1f93c	-	+
women_wrestling	1f93c-200d-2640-fe0f	activity	+
men_wrestling	1f93c-200d-2642-fe0f	activity	+
person_doing_cartwheel	1f938	activity	+
cartwheel	1f938	-	+
person_doing_cartwheel_tone1	1f938-1f3fb	-	+
cartwheel_tone1	1f938-1f3fb	-	+
person_doing_cartwheel_tone2	1f938-1f3fc	-	+
cartwheel_tone2	1f938-1f3fc	-	+
person_doing_cartwheel_tone3	1f938-1f3fd	-	+
cartwheel_tone3	1f938-1f3fd	-	+
person_doing_cartwheel_tone4	1f938-1f3fe	-	+
cartwheel_tone4	1f938-1f3fe	-	+
person_doing_cartwheel_tone5	1f938-1f3ff	-	+
cartwheel_tone5	1f938-1f3ff	-	+
woman_cartwheeling	1f938-200d-2640-fe0f	activity	+
woman_cartwheeling_tone1	1f938-1f3fb-200d-2640-fe0f	-	+
woman_cartwheeling_light_skin_tone	1f938-1f3fb-200d-2640-fe0f	-	+
woman_cartwheeling_tone2	1f938-1f3fc-200d-2640-fe0f	-	+
woman_cartwheeling_medium_light_skin_tone	1f938-1f3fc-200d-2640-fe0f	-	+
woman_cartwheeling_tone3	1f938-1f3fd-200d-2640-fe0f	-	+
woman_cartwheeling_medium_skin_tone	1f938-1f3fd-200d-2640-fe0f	-	+
woman_cartwheeling_tone4	1f938-1f3fe-200d-2640-fe0f	-	+
woman_cartwheeling_medium_dark_skin_tone	1f938-1f3fe-200d-2640-fe0f	-	+
woman_cartwheeling_tone5	1f938-1f3ff-200d-2640-fe0f	-	+
woman_cartwheeling_dark_skin_tone	1f938-1f3ff-200d-2640-fe0f	-	+
man_cartwheeling	1f938-200d-2642-fe0f	activity	+
man_cartwheeling_tone1	1f938-1f3fb-200d-2642-fe0f	-	+
man_cartwheeling_light_skin_tone	1f938-1f3fb-200d-2642-fe0f	-	+
man_cartwheeling_tone2	1f938-1f3fc-200d-2642-fe0f	-	+
man_cartwheeling_medium_light_skin_tone	1f938-1f3fc-200d-2642-fe0f	-	+
man_cartwheeling_tone3	1f938-1f3fd-200d-2642-fe0f	-	+
man_cartwheeling_medium_skin_tone	1f938-1f3fd-200d-2642-fe0f	-	+
man_cartwheeling_tone4	1f938-1f3fe-200d-2642-fe0f	-	+
man_cartwheeling_medium_dark_skin_tone	1f938-1f3fe-200d-2642-fe0f	-	+
man_cartwheeling_tone5	1f938-1f3ff-200d-2642-fe0f	-	+
man_cartwheeling_dark_skin_tone	1f938-1f3ff-200d-2642-fe0f	-	+
person_bouncing_ball	26f9-fe0f	activity	+
basketball_player	26f9-fe0f	-	+
person_with_ball	26f9-fe0f	-	+
person_bouncing_ball_tone1	26f9-1f3fb	-	+
basketball_player_tone1	26f9-1f3fb	-	+
person_with_ball_tone1	26f9-1f3fb	-	+
person_bouncing_ball_tone2	26f9-1f3fc	-	+
basketball_player_tone2	26f9-1f3fc	-	+
person_with_ball_tone2	26f9-1f3fc	-	+
person_bouncing_ball_tone3	26f9-1f3fd	-	+
basketball_player_tone3	26f9-1f3fd	-	+
person_with_ball_tone3	26f9-1f3fd	-	+
person_bouncing_ball_tone4	26f9-1f3fe	-	+
basketball_player_tone4	26f9-1f3fe	-	+
person_with_ball_tone4	26f9-1f3fe	-	+
person_bouncing_ball_tone5	26f9-1f3ff	-	+
basketball_player_tone5	26f9-1f3ff	-	+
person_with_ball_tone5	26f9-1f3ff	-	+
woman_bouncing_ball	26f9-fe0f-200d-2640-fe0f	activity	+
woman_bouncing_ball_tone1	26f9-1f3fb-200d-2640-fe0f	-	+
woman_bouncing_ball_light_skin_tone	26f9-1f3fb-200d-2640-fe0f	-	+
woman_bouncing_ball_tone2	26f9-1f3fc-200d-2640-fe0f	-	+
woman_bouncing_ball_medium_light_skin_tone	26f9-1f3fc-200d-2640-fe0f	-	+
woman_bouncing_ball_tone3	26f9-1f3fd-200d-2640-fe0f	-	+
woman_bouncing_ball_medium_skin_tone	26f9-1f3fd-200d-2640-fe0f	-	+
woman_bouncing_ball_tone4	26f9-1f3fe-200d-2640-fe0f	-	+
woman_bouncing_ball_medium_dark_skin_tone	26f9-1f3fe-200d-2640-fe0f	-	+
woman_bouncing_ball_tone5	26f9-1f3ff-200d-2640-fe0f	-	+
woman_bouncing_ball_dark_skin_tone	26f9-1f3ff-200d-2640-fe0f	-	+
man_bouncing_ball	26f9-fe0f-200d-2642-fe0f	activity	+
man_bouncing_ball_tone1	26f9-1f3fb-200d-2642-fe0f	-	+
man_bouncing_ball_light_skin_tone	26f9-1f3fb-200d-2642-fe0f	-	+
man_bouncing_ball_tone2	26f9-1f3fc-200d-2642-fe0f	-	+
man_bouncing_ball_medium_light_skin_tone	26f9-1f3fc-200d-2642-fe0f	-	+
man_bouncing_ball_tone3	26f9-1f3fd-200d-2642-fe0f	-	+
man_bouncing_ball_medium_skin_tone	26f9-1f3fd-200d-2642-fe0f	-	+
man_bouncing_ball_tone4	26f9-1f3fe-200d-2642-fe0f	-	+
man_bouncing_ball_medium_dark_skin_tone	26f9-1f3fe-200d-2642-fe0f	-	+
man_bouncing_ball_tone5	26f9-1f3ff-200d-2642-fe0f	-	+
man_bouncing_ball_dark_skin_tone	26f9-1f3ff-200d-2642-fe0f	-	+
person_fencing	1f93a	activity	+
fencer	1f93a	-	+
fencing	1f93a	-	+
person_playing_handball	1f93e	activity	+
handball	1f93e	-	+
person_playing_handball_tone1	1f93e-1f3fb	-	+
handball_tone1	1f93e-1f3fb	-	+
person_playing_handball_tone2	1f93e-1f3fc	-	+
handball_tone2	1f93e-1f3fc	-	+
person_playing_handball_tone3	1f93e-1f3fd	-	+
handball_tone3	1f93e-1f3fd	-	+
person_playing_handball_tone4	1f93e-1f3fe	-	+
handball_tone4	1f93e-1f3fe	-	+
person_playing_handball_tone5	1f93e-1f3ff	-	+
handball_tone5	1f93e-1f3ff	-	+
woman_playing_handball	1f93e-200d-2640-fe0f	activity	+
woman_playing_handball_tone1	1f93e-1f3fb-200d-2640-fe0f	-	+
woman_playing_handball_light_skin_tone	1f93e-1f3fb-200d-2640-fe0f	-	+
woman_playing_handball_tone2	1f93e-1f3fc-200d-2640-fe0f	-	+
woman_playing_handball_medium_light_skin_tone	1f93e-1f3fc-200d-2640-fe0f	-	+
woman_playing_handball_tone3	1f93e-1f3fd-200d-2640-fe0f	-	+
woman_playing_handball_medium_skin_tone	1f93e-1f3fd-200d-2640-fe0f	-	+
woman_playing_handball_tone4	1f93e-1f3fe-200d-2640-fe0f	-	+
woman_playing_handball_medium_dark_skin_tone	1f93e-1f3fe-200d-2640-fe0f	-	+
woman_playing_handball_tone5	1f93e-1f3ff-200d-2640-fe0f	-	+
woman_playing_handball_dark_skin_tone	1f93e-1f3ff-200d-2640-fe0f	-	+
man_playing_handball	1f93e-200d-2642-fe0f	activity	+
man_playing_handball_tone1	1f93e-1f3fb-200d-2642-fe0f	-	+
man_playing_handball_light_skin_tone	1f93e-1f3fb-200d-2642-fe0f	-	+
man_playing_handball_tone2	1f93e-1f3fc-200d-2642-fe0f	-	+
man_playing_handball_medium_light_skin_tone	1f93e-1f3fc-200d-2642-fe0f	-	+
man_playing_handball_tone3	1f93e-1f3fd-200d-2642-fe0f	-	+
man_playing_handball_medium_skin_tone	1f93e-1f3fd-200d-2642-fe0f	-	+
man_playing_handball_tone4	1f93e-1f3fe-200d-2642-fe0f	-	+
man_playing_handball_medium_dark_skin_tone	1f93e-1f3fe-200d-2642-fe0f	-	+
man_playing_handball_tone5	1f93e-1f3ff-200d-2642-fe0f	-	+
man_playing_handball_dark_skin_tone	1f93e-1f3ff-200d-2642-fe0f	-	+
person_golfing	1f3cc-fe0f	activity	+
golfer	1f3cc-fe0f	-	+
person_golfing_tone1	1f3cc-1f3fb	-	+
person_golfing_light_skin_tone	1f3cc-1f3fb	-	+
person_golfing_tone2	1f3cc-1f3fc	-	+
person_golfing_medium_light_skin_tone	1f3cc-1f3fc	-	+
person_golfing_tone3	1f3cc-1f3fd	-	+
person_golfing_medium_skin_tone	1f3cc-1f3fd	-	+
person_golfing_tone4	1f3cc-1f3fe	-	+
person_golfing_medium_dark_skin_tone	1f3cc-1f3fe	-	+
person_golfing_tone5	1f3cc-1f3ff	-	+
person_golfing_dark_skin_tone	1f3cc-1f3ff	-	+
woman_golfing	1f3cc-fe0f-200d-2640-fe0f	activity	+
woman_golfing_tone1	1f3cc-1f3fb-200d-2640-fe0f	-	+
woman_golfing_light_skin_tone	1f3cc-1f3fb-200d-2640-fe0f	-	+
woman_golfing_tone2	1f3cc-1f3fc-200d-2640-fe0f	-	+
woman_golfing_medium_light_skin_tone	1f3cc-1f3fc-200d-2640-fe0f	-	+
woman_golfing_tone3	1f3cc-1f3fd-200d-2640-fe0f	-	+
woman_golfing_medium_skin_tone	1f3cc-1f3fd-200d-2640-fe0f	-	+
woman_golfing_tone4	1f3cc-1f3fe-200d-2640-fe0f	-	+
woman_golfing_medium_dark_skin_tone	1f3cc-1f3fe-200d-2640-fe0f	-	+
woman_golfing_tone5	1f3cc-1f3ff-200d-2640-fe0f	-	+
woman_golfing_dark_skin_tone	1f3cc-1f3ff-200d-2640-fe0f	-	+
man_golfing	1f3cc-fe0f-200d-2642-fe0f	activity	+
man_golfing_tone1	1f3cc-1f3fb-200d-2642-fe0f	-	+
man_golfing_light_skin_tone	1f3cc-1f3fb-200d-2642-fe0f	-	+
man_golfing_tone2	1f3cc-1f3fc-200d-2642-fe0f	-	+
man_golfing_medium_light_skin_tone	1f3cc-1f3fc-200d-2642-fe0f	-	+
man_golfing_tone3	1f3cc-1f3fd-200d-2642-fe0f	-	+
man_golfing_medium_skin_tone	1f3cc-1f3fd-200d-2642-fe0f	-	+
man_golfing_tone4	1f3cc-1f3fe-200d-2642-fe0f	-	+
man_golfing_medium_dark_skin_tone	1f3cc-1f3fe-200d-2642-fe0f	-	+
man_golfing_tone5	1f3cc-1f3ff-200d-2642-fe0f	-	+
man_golfing_dark_skin_tone	1f3cc-1f3ff-200d-2642-fe0f	-	+
horse_racing	1f3c7	activity	+
horse_racing_tone1	1f3c7-1f3fb	-	+
horse_racing_tone2	1f3c7-1f3fc	-	+
horse_racing_tone3	1f3c7-1f3fd	-	+
horse_racing_tone4	1f3c7-1f3fe	-	+
horse_racing_tone5	1f3c7-1f3ff	-	+
person_in_lotus_position	1f9d8	activity	+
person_in_lotus_position_tone1	1f9d8-1f3fb	-	+
person_in_lotus_position_light_skin_tone	1f9d8-1f3fb	-	+
person_in_lotus_position_tone2	1f9d8-1f3fc	-	+
person_in_lotus_position_medium_light_skin_tone	1f9d8-1f3fc	-	+
person_in_lotus_position_tone3	1f9d8-1f3fd	-	+
person_in_lotus_position_medium_skin_tone	1f9d8-1f3fd	-	+
person_in_lotus_position_tone4	1f9d8-1f3fe	-	+
person_in_lotus_position_medium_dark_skin_tone	1f9d8-1f3fe	-	+
person_in_lotus_position_tone5	1f9d8-1f3ff	-	+
person_in_lotus_position_dark_skin_tone	1f9d8-1f3ff	-	+
woman_in_lotus_position	1f9d8-200d-2640-fe0f	activity	+
woman_in_lotus_position_tone1	1f9d8-1f3fb-200d-2640-fe0f	-	+
woman_in_lotus_position_light_skin_tone	1f9d8-1f3fb-200d-2640-fe0f	-	+
woman_in_lotus_position_tone2	1f9d8-1f3fc-200d-2640-fe0f	-	+
woman_in_lotus_position_medium_light_skin_tone	1f9d8-1f3fc-200d-2640-fe0f	-	+
woman_in_lotus_position_tone3	1f9d8-1f3fd-200d-2640-fe0f	-	+
woman_in_lotus_position_medium_skin_tone	1f9d8-1f3fd-200d-2640-fe0f	-	+
woman_in_lotus_position_tone4	1f9d8-1f3fe-200d-2640-fe0f	-	+
woman_in_lotus_position_medium_dark_skin_tone	1f9d8-1f3fe-200d-2640-fe0f	-	+
woman_in_lotus_position_tone5	1f9d8-1f3ff-200d-2640-fe0f	-	+
woman_in_lotus_position_dark_skin_tone	1f9d8-1f3ff-200d-2640-fe0f	-	+
man_in_lotus_position	1f9d8-200d-2642-fe0f	activity	+
man_in_lotus_position_tone1	1f9d8-1f3fb-200d-2642-fe0f	-	+
man_in_lotus_position_light_skin_tone	1f9d8-1f3fb-200d-2642-fe0f	-	+
man_in_lotus_position_tone2	1f9d8-1f3fc-200d-2642-fe0f	-	+
man_in_lotus_position_medium_light_skin_tone	1f9d8-1f3fc-200d-2642-fe0f	-	+
man_in_lotus_position_tone3	1f9d8-1f3fd-200d-2642-fe0f	-	+
man_in_lotus_position_medium_skin_tone	1f9d8-1f3fd-200d-2642-fe0f	-	+
man_in_lotus_position_tone4	1f9d8-1f3fe-200d-2642-fe0f	-	+
man_in_lotus_position_medium_dark_skin_tone	1f9d8-1f3fe-200d-2642-fe0f	-	+
man_in_lotus_position_tone5	1f9d8-1f3ff-200d-2642-fe0f	-	+
man_in_lotus_position_dark_skin_tone	1f9d8-1f3ff-200d-2642-fe0f	-	+
person_surfing	1f3c4	activity	+
surfer	1f3c4	-	+
person_surfing_tone1	1f3c4-1f3fb	-	+
surfer_tone1	1f3c4-1f3fb	-	+
person_surfing_tone2	1f3c4-1f3fc	-	+
surfer_tone2	1f3c4-1f3fc	-	+
person_surfing_tone3	1f3c4-1f3fd	-	+
surfer_tone3	1f3c4-1f3fd	-	+
person_surfing_tone4	1f3c4-1f3fe	-	+
surfer_tone4	1f3c4-1f3fe	-	+
person_surfing_tone5	1f3c4-1f3ff	-	+
surfer_tone5	1f3c4-1f3ff	-	+
woman_surfing	1f3c4-200d-2640-fe0f	activity	+
woman_surfing_tone1	1f3c4-1f3fb-200d-2640-fe0f	-	+
woman_surfing_light_skin_tone	1f3c4-1f3fb-200d-2640-fe0f	-	+
woman_surfing_tone2	1f3c4-1f3fc-200d-2640-fe0f	-	+
woman_surfing_medium_light_skin_tone	1f3c4-1f3fc-200d-2640-fe0f	-	+
woman_surfing_tone3	1f3c4-1f3fd-200d-2640-fe0f	-	+
woman_surfing_medium_skin_tone	1f3c4-1f3fd-200d-2640-fe0f	-	+
woman_surfing_tone4	1f3c4-1f3fe-200d-2640-fe0f	-	+
woman_surfing_medium_dark_skin_tone	1f3c4-1f3fe-200d-2640-fe0f	-	+
woman_surfing_tone5	1f3c4-1f3ff-200d-2640-fe0f	-	+
woman_surfing_dark_skin_tone	1f3c4-1f3ff-200d-2640-fe0f	-	+
man_surfing	1f3c4-200d-2642-fe0f	activity	+
man_surfing_tone1	1f3c4-1f3fb-200d-2642-fe0f	-	+
man_surfing_light_skin_tone	1f3c4-1f3fb-200d-2642-fe0f	-	+
man_surfing_tone2	1f3c4-1f3fc-200d-2642-fe0f	-	+
man_surfing_medium_light_skin_tone	1f3c4-1f3fc-200d-2642-fe0f	-	+
man_surfing_tone3	1f3c4-1f3fd-200d-2642-fe0f	-	+
man_surfing_medium_skin_tone	1f3c4-1f3fd-200d-2642-fe0f	-	+
man_surfing_tone4	1f3c4-1f3fe-200d-2642-fe0f	-	+
man_surfing_medium_dark_skin_tone	1f3c4-1f3fe-200d-2642-fe0f	-	+
man_surfing_tone5	1f3c4-1f3ff-200d-2642-fe0f	-	+
man_surfing_dark_skin_tone	1f3c4-1f3ff-200d-2642-fe0f	-	+
person_swimming	1f3ca	activity	+
swimmer	1f3ca	-	+
person_swimming_tone1	1f3ca-1f3fb	-	+
swimmer_tone1	1f3ca-1f3fb	-	+
person_swimming_tone2	1f3ca-1f3fc	-	+
swimmer_tone2	1f3ca-1f3fc	-	+
person_swimming_tone3	1f3ca-1f3fd	-	+
swimmer_tone3	1f3ca-1f3fd	-	+
person_swimming_tone4	1f3ca-1f3fe	-	+
swimmer_tone4	1f3ca-1f3fe	-	+
person_swimming_tone5	1f3ca-1f3ff	-	+
swimmer_tone5	1f3ca-1f3ff	-	+
woman_swimming	1f3ca-200d-2640-fe0f	activity	+
woman_swimming_tone1	1f3ca-1f3fb-200d-2640-fe0f	-	+
woman_swimming_light_skin_tone	1f3ca-1f3fb-200d-2640-fe0f	-	+
woman_swimming_tone2	1f3ca-1f3fc-200d-2640-fe0f	-	+
woman_swimming_medium_light_skin_tone	1f3ca-1f3fc-200d-2640-fe0f	-	+
woman_swimming_tone3	1f3ca-1f3fd-200d-2640-fe0f	-	+
woman_swimming_medium_skin_tone	1f3ca-1f3fd-200d-2640-fe0f	-	+
woman_swimming_tone4	1f3ca-1f3fe-200d-2640-fe0f	-	+
woman_swimming_medium_dark_skin_tone	1f3ca-1f3fe-200d-2640-fe0f	-	+
woman_swimming_tone5	1f3ca-1f3ff-200d-2640-fe0f	-	+
woman_swimming_dark_skin_tone	1f3ca-1f3ff-200d-2640-fe0f	-	+
man_swimming	1f3ca-200d-2642-fe0f	activity	+
man_swimming_tone1	1f3ca-1f3fb-200d-2642-fe0f	-	+
man_swimming_light_skin_tone	1f3ca-1f3fb-200d-2642-fe0f	-	+
man_swimming_tone2	1f3ca-1f3fc-200d-2642-fe0f	-	+
man_swimming_medium_light_skin_tone	1f3ca-1f3fc-200d-2642-fe0f	-	+
man_swimming_tone3	1f3ca-1f3fd-200d-2642-fe0f	-	+
man_swimming_medium_skin_tone	1f3ca-1f3fd-200d-2642-fe0f	-	+
man_swimming_tone4	1f3ca-1f3fe-200d-2642-fe0f	-	+
man_swimming_medium_dark_skin_tone	1f3ca-1f3fe-200d-2642-fe0f	-	+
man_swimming_tone5	1f3ca-1f3ff-200d-2642-fe0f	-	+
man_swimming_dark_skin_tone	1f3ca-1f3ff-200d-2642-fe0f	-	+
person_playing_water_polo	1f93d	activity	+
water_polo	1f93d	-	+
person_playing_water_polo_tone1	1f93d-1f3fb	-	+
water_polo_tone1	1f93d-1f3fb	-	+
person_playing_water_polo_tone2	1f93d-1f3fc	-	+
water_polo_tone2	1f93d-1f3fc	-	+
person_playing_water_polo_tone3	1f93d-1f3fd	-	+
water_polo_tone3	1f93d-1f3fd	-	+
person_playing_water_polo_tone4	1f93d-1f3fe	-	+
water_polo_tone4	1f93d-1f3fe	-	+
person_playing_water_polo_tone5	1f93d-1f3ff	-	+
water_polo_tone5	1f93d-1f3ff	-	+
woman_playing_water_polo	1f93d-200d-2640-fe0f	activity	+
woman_playing_water_polo_tone1	1f93d-1f3fb-200d-2640-fe0f	-	+
woman_playing_water_polo_light_skin_tone	1f93d-1f3fb-200d-2640-fe0f	-	+
woman_playing_water_polo_tone2	1f93d-1f3fc-200d-2640-fe0f	-	+
woman_playing_water_polo_medium_light_skin_tone	1f93d-1f3fc-200d-2640-fe0f	-	+
woman_playing_water_polo_tone3	1f93d-1f3fd-200d-2640-fe0f	-	+
woman_playing_water_polo_medium_skin_tone	1f93d-1f3fd-200d-2640-fe0f	-	+
woman_playing_water_polo_tone4	1f93d-1f3fe-200d-2640-fe0f	-	+
woman_playing_water_polo_medium_dark_skin_tone	1f93d-1f3fe-200d-2640-fe0f	-	+
woman_playing_water_polo_tone5	1f93d-1f3ff-200d-2640-fe0f	-	+
woman_playing_water_polo_dark_skin_tone	1f93d-1f3ff-200d-2640-fe0f	-	+
man_playing_water_polo	1f93d-200d-2642-fe0f	activity	+
man_playing_water_polo_tone1	1f93d-1f3fb-200d-2642-fe0f	-	+
man_playing_water_polo_light_skin_tone	1f93d-1f3fb-200d-2642-fe0f	-	+
man_playing_water_polo_tone2	1f93d-1f3fc-200d-2642-fe0f	-	+
man_playing_water_polo_medium_light_skin_tone	1f93d-1f3fc-200d-2642-fe0f	-	+
man_playing_water_polo_tone3	1f93d-1f3fd-200d-2642-fe0f	-	+
man_playing_water_polo_medium_skin_tone	1f93d-1f3fd-200d-2642-fe0f	-	+
man_playing_water_polo_tone4	1f93d-1f3fe-200d-2642-fe0f	-	+
man_playing_water_polo_medium_dark_skin_tone	1f93d-1f3fe-200d-2642-fe0f	-	+
man_playing_water_polo_tone5	1f93d-1f3ff-200d-2642-fe0f	-	+
man_playing_water_polo_dark_skin_tone	1f93d-1f3ff-200d-2642-fe0f	-	+
person_rowing_boat	1f6a3	activity	+
rowboat	1f6a3	-	+
person_rowing_boat_tone1	1f6a3-1f3fb	-	+
rowboat_tone1	1f6a3-1f3fb	-	+
person_rowing_boat_tone2	1f6a3-1f3fc	-	+
rowboat_tone2	1f6a3-1f3fc	-	+
person_rowing_boat_tone3	1f6a3-1f3fd	-	+
rowboat_tone3	1f6a3-1f3fd	-	+
person_rowing_boat_tone4	1f6a3-1f3fe	-	+
rowboat_tone4	1f6a3-1f3fe	-	+
person_rowing_boat_tone5	1f6a3-1f3ff	-	+
rowboat_tone5	1f6a3-1f3ff	-	+
woman_rowing_boat	1f6a3-200d-2640-fe0f	activity	+
woman_rowing_boat_tone1	1f6a3-1f3fb-200d-2640-fe0f	-	+
woman_rowing_boat_light_skin_tone	1f6a3-1f3fb-200d-2640-fe0f	-	+
woman_rowing_boat_tone2	1f6a3-1f3fc-200d-2640-fe0f	-	+
woman_rowing_boat_medium_light_skin_tone	1f6a3-1f3fc-200d-2640-fe0f	-	+
woman_rowing_boat_tone3	1f6a3-1f3fd-200d-2640-fe0f	-	+
woman_rowing_boat_medium_skin_tone	1f6a3-1f3fd-200d-2640-fe0f	-	+
woman_rowing_boat_tone4	1f6a3-1f3fe-200d-2640-fe0f	-	+
woman_rowing_boat_medium_dark_skin_tone	1f6a3-1f3fe-200d-2640-fe0f	-	+
woman_rowing_boat_tone5	1f6a3-1f3ff-200d-2640-fe0f	-	+
woman_rowing_boat_dark_skin_tone	1f6a3-1f3ff-200d-2640-fe0f	-	+
man_rowing_boat	1f6a3-200d-2642-fe0f	activity	+
man_rowing_boat_tone1	1f6a3-1f3fb-200d-2642-fe0f	-	+
man_rowing_boat_light_skin_tone	1f6a3-1f3fb-200d-2642-fe0f	-	+
man_rowing_boat_tone2	1f6a3-1f3fc-200d-2642-fe0f	-	+
man_rowing_boat_medium_light_skin_tone	1f6a3-1f3fc-200d-2642-fe0f	-	+
man_rowing_boat_tone3	1f6a3-1f3fd-200d-2642-fe0f	-	+
man_rowing_boat_medium_skin_tone	1f6a3-1f3fd-200d-2642-fe0f	-	+
man_rowing_boat_tone4	1f6a3-1f3fe-200d-2642-fe0f	-	+
man_rowing_boat_medium_dark_skin_tone	1f6a3-1f3fe-200d-2642-fe0f	-	+
man_rowing_boat_tone5	1f6a3-1f3ff-200d-2642-fe0f	-	+
man_rowing_boat_dark_skin_tone	1f6a3-1f3ff-200d-2642-fe0f	-	+
person_climbing	1f9d7	activity	+
person_climbing_tone1	1f9d7-1f3fb	-	+
person_climbing_light_skin_tone	1f9d7-1f3fb	-	+
person_climbing_tone2	1f9d7-1f3fc	-	+
person_climbing_medium_light_skin_tone	1f9d7-1f3fc	-	+
person_climbing_tone3	1f9d7-1f3fd	-	+
person_climbing_medium_skin_tone	1f9d7-1f3fd	-	+
person_climbing_tone4	1f9d7-1f3fe	-	+
person_climbing_medium_dark_skin_tone	1f9d7-1f3fe	-	+
person_climbing_tone5	1f9d7-1f3ff	-	+
person_climbing_dark_skin_tone	1f9d7-1f3ff	-	+
woman_climbing	1f9d7-200d-2640-fe0f	activity	+
woman_climbing_tone1	1f9d7-1f3fb-200d-2640-fe0f	-	+
woman_climbing_light_skin_tone	1f9d7-1f3fb-200d-2640-fe0f	-	+
woman_climbing_tone2	1f9d7-1f3fc-200d-2640-fe0f	-	+
woman_climbing_medium_light_skin_tone	1f9d7-1f3fc-200d-2640-fe0f	-	+
woman_climbing_tone3	1f9d7-1f3fd-200d-2640-fe0f	-	+
woman_climbing_medium_skin_tone	1f9d7-1f3fd-200d-2640-fe0f	-	+
woman_climbing_tone4	1f9d7-1f3fe-200d-2640-fe0f	-	+
woman_climbing_medium_dark_skin_tone	1f9d7-1f3fe-200d-2640-fe0f	-	+
woman_climbing_tone5	1f9d7-1f3ff-200d-2640-fe0f	-	+
woman_climbing_dark_skin_tone	1f9d7-1f3ff-200d-2640-fe0f	-	+
man_climbing	1f9d7-200d-2642-fe0f	activity	+
man_climbing_tone1	1f9d7-1f3fb-200d-2642-fe0f	-	+
man_climbing_light_skin_tone	1f9d7-1f3fb-200d-2642-fe0f	-	+
man_climbing_tone2	1f9d7-1f3fc-200d-2642-fe0f	-	+
man_climbing_medium_light_skin_tone	1f9d7-1f3fc-200d-2642-fe0f	-	+
man_climbing_tone3	1f9d7-1f3fd-200d-2642-fe0f	-	+
man_climbing_medium_skin_tone	1f9d7-1f3fd-200d-2642-fe0f	-	+
man_climbing_tone4	1f9d7-1f3fe-200d-2642-fe0f	-	+
man_climbing_medium_dark_skin_tone	1f9d7-1f3fe-200d-2642-fe0f	-	+
man_climbing_tone5	1f9d7-1f3ff-200d-2642-fe0f	-	+
man_climbing_dark_skin_tone	1f9d7-1f3ff-200d-2642-fe0f	-	+
person_mountain_biking	1f6b5	activity	+
mountain_bicyclist	1f6b5	-	+
person_mountain_biking_tone1	1f6b5-1f3fb	-	+
mountain_bicyclist_tone1	1f6b5-1f3fb	-	+
person_mountain_biking_tone2	1f6b5-1f3fc	-	+
mountain_bicyclist_tone2	1f6b5-1f3fc	-	+
person_mountain_biking_tone3	1f6b5-1f3fd	-	+
mountain_bicyclist_tone3	1f6b5-1f3fd	-	+
person_mountain_biking_tone4	1f6b5-1f3fe	-	+
mountain_bicyclist_tone4	1f6b5-1f3fe	-	+
person_mountain_biking_tone5	1f6b5-1f3ff	-	+
mountain_bicyclist_tone5	1f6b5-1f3ff	-	+
woman_mountain_biking	1f6b5-200d-2640-fe0f	activity	+
woman_mountain_biking_tone1	1f6b5-1f3fb-200d-2640-fe0f	-	+
woman_mountain_biking_light_skin_tone	1f6b5-1f3fb-200d-2640-fe0f	-	+
woman_mountain_biking_tone2	1f6b5-1f3fc-200d-2640-fe0f	-	+
woman_mountain_biking_medium_light_skin_tone	1f6b5-1f3fc-200d-2640-fe0f	-	+
woman_mountain_biking_tone3	1f6b5-1f3fd-200d-2640-fe0f	-	+
woman_mountain_biking_medium_skin_tone	1f6b5-1f3fd-200d-2640-fe0f	-	+
woman_mountain_biking_tone4	1f6b5-1f3fe-200d-2640-fe0f	-	+
woman_mountain_biking_medium_dark_skin_tone	1f6b5-1f3fe-200d-2640-fe0f	-	+
woman_mountain_biking_tone5	1f6b5-1f3ff-200d-2640-fe0f	-	+
woman_mountain_biking_dark_skin_tone	1f6b5-1f3ff-200d-2640-fe0f	-	+
man_mountain_biking	1f6b5-200d-2642-fe0f	activity	+
man_mountain_biking_tone1	1f6b5-1f3fb-200d-2642-fe0f	-	+
man_mountain_biking_light_skin_tone	1f6b5-1f3fb-200d-2642-fe0f	-	+
man_mountain_biking_tone2	1f6b5-1f3fc-200d-2642-fe0f	-	+
man_mountain_biking_medium_light_skin_tone	1f6b5-1f3fc-200d-2642-fe0f	-	+
man_mountain_biking_tone3	1f6b5-1f3fd-200d-2642-fe0f	-	+
man_mountain_biking_medium_skin_tone	1f6b5-1f3fd-200d-2642-fe0f	-	+
man_mountain_biking_tone4	1f6b5-1f3fe-200d-2642-fe0f	-	+
man_mountain_biking_medium_dark_skin_tone	1f6b5-1f3fe-200d-2642-fe0f	-	+
man_mountain_biking_tone5	1f6b5-1f3ff-200d-2642-fe0f	-	+
man_mountain_biking_dark_skin_tone	1f6b5-1f3ff-200d-2642-fe0f	-	+
person_biking	1f6b4	activity	+
bicyclist	1f6b4	-	+
person_biking_tone1	1f6b4-1f3fb	-	+
bicyclist_tone1	1f6b4-1f3fb	-	+
person_biking_tone2	1f6b4-1f3fc	-	+
bicyclist_tone2	1f6b4-1f3fc	-	+
person_biking_tone3	1f6b4-1f3fd	-	+
bicyclist_tone3	1f6b4-1f3fd	-	+
person_biking_tone4	1f6b4-1f3fe	-	+
bicyclist_tone4	1f6b4-1f3fe	-	+
person_biking_tone5	1f6b4-1f3ff	-	+
bicyclist_tone5	1f6b4-1f3ff	-	+
woman_biking	1f6b4-200d-2640-fe0f	activity	+
woman_biking_tone1	1f6b4-1f3fb-200d-2640-fe0f	-	+
woman_biking_light_skin_tone	1f6b4-1f3fb-200d-2640-fe0f	-	+
woman_biking_tone2	1f6b4-1f3fc-200d-2640-fe0f	-	+
woman_biking_medium_light_skin_tone	1f6b4-1f3fc-200d-2640-fe0f	-	+
woman_biking_tone3	1f6b4-1f3fd-200d-2640-fe0f	-	+
woman_biking_medium_skin_tone	1f6b4-1f3fd-200d-2640-fe0f	-	+
woman_biking_tone4	1f6b4-1f3fe-200d-2640-fe0f	-	+
woman_biking_medium_dark_skin_tone	1f6b4-1f3fe-200d-2640-fe0f	-	+
woman_biking_tone5	1f6b4-1f3ff-200d-2640-fe0f	-	+
woman_biking_dark_skin_tone	1f6b4-1f3ff-200d-2640-fe0f	-	+
man_biking	1f6b4-200d-2642-fe0f	activity	+
man_biking_tone1	1f6b4-1f3fb-200d-2642-fe0f	-	+
man_biking_light_skin_tone	1f6b4-1f3fb-200d-2642-fe0f	-	+
man_biking_tone2	1f6b4-1f3fc-200d-2642-fe0f	-	+
man_biking_medium_light_skin_tone	1f6b4-1f3fc-200d-2642-fe0f	-	+
man_biking_tone3	1f6b4-1f3fd-200d-2642-fe0f	-	+
man_biking_medium_skin_tone	1f6b4-1f3fd-200d-2642-fe0f	-	+
man_biking_tone4	1f6b4-1f3fe-200d-2642-fe0f	-	+
man_biking_medium_dark_skin_tone	1f6b4-1f3fe-200d-2642-fe0f	-	+
man_biking_tone5	1f6b4-1f3ff-200d-2642-fe0f	-	+
man_biking_dark_skin_tone	1f6b4-1f3ff-200d-2642-fe0f	-	+
trophy	1f3c6	activity	+
first_place	1f947	activity	+
first_place_medal	1f947	-	+
second_place	1f948	activity	+
second_place_medal	1f948	-	+
third_place	1f949	activity	+
third_place_medal	1f949	-	+
medal	1f3c5	activity	+
sports_medal	1f3c5	-	+
military_medal	1f396-fe0f	activity	+
rosette	1f3f5-fe0f	activity	+
reminder_ribbon	1f397-fe0f	activity	+
ticket	1f3ab	activity	+
tickets	1f39f-fe0f	activity	+
admission_tickets	1f39f-fe0f	-	+
circus_tent	1f3aa	activity	+
person_juggling	1f939	activity	+
juggling	1f939	-	+
juggler	1f939	-	+
person_juggling_tone1	1f939-1f3fb	-	+
juggling_tone1	1f939-1f3fb	-	+
juggler_tone1	1f939-1f3fb	-	+
person_juggling_tone2	1f939-1f3fc	-	+
juggling_tone2	1f939-1f3fc	-	+
juggler_tone2	1f939-1f3fc	-	+
person_juggling_tone3	1f939-1f3fd	-	+
juggling_tone3	1f939-1f3fd	-	+
juggler_tone3	1f939-1f3fd	-	+
person_juggling_tone4	1f939-1f3fe	-	+
juggling_tone4	1f939-1f3fe	-	+
juggler_tone4	1f939-1f3fe	-	+
person_juggling_tone5	1f939-1f3ff	-	+
juggling_tone5	1f939-1f3ff	-	+
juggler_tone5	1f939-1f3ff	-	+
woman_juggling	1f939-200d-2640-fe0f	activity	+
woman_juggling_tone1	1f939-1f3fb-200d-2640-fe0f	-	+
woman_juggling_light_skin_tone	1f939-1f3fb-200d-2640-fe0f	-	+
woman_juggling_tone2	1f939-1f3fc-200d-2640-fe0f	-	+
woman_juggling_medium_light_skin_tone	1f939-1f3fc-200d-2640-fe0f	-	+
woman_juggling_tone3	1f939-1f3fd-200d-2640-fe0f	-	+
woman_juggling_medium_skin_tone	1f939-1f3fd-200d-2640-fe0f	-	+
woman_juggling_tone4	1f939-1f3fe-200d-2640-fe0f	-	+
woman_juggling_medium_dark_skin_tone	1f939-1f3fe-200d-2640-fe0f	-	+
woman_juggling_tone5	1f939-1f3ff-200d-2640-fe0f	-	+
woman_juggling_dark_skin_tone	1f939-1f3ff-200d-2640-fe0f	-	+
man_juggling	1f939-200d-2642-fe0f	activity	+
man_juggling_tone1	1f939-1f3fb-200d-2642-fe0f	-	+
man_juggling_light_skin_tone	1f939-1f3fb-200d-2642-fe0f	-	+
man_juggling_tone2	1f939-1f3fc-200d-2642-fe0f	-	+
man_juggling_medium_light_skin_tone	1f939-1f3fc-200d-2642-fe0f	-	+
man_juggling_tone3	1f939-1f3fd-200d-2642-fe0f	-	+
man_juggling_medium_skin_tone	1f939-1f3fd-200d-2642-fe0f	-	+
man_juggling_tone4	1f939-1f3fe-200d-2642-fe0f	-	+
man_juggling_medium_dark_skin_tone	1f939-1f3fe-200d-2642-fe0f	-	+
man_juggling_tone5	1f939-1f3ff-200d-2642-fe0f	-	+
man_juggling_dark_skin_tone	1f939-1f3ff-200d-2642-fe0f	-	+
performing_arts	1f3ad	activity	+
ballet_shoes	1fa70	activity	-
art	1f3a8	activity	+
splatter	1fadf	activity	-
clapper	1f3ac	activity	+
clapper_board	1f3ac	-	-
microphone	1f3a4	activity	+
headphones	1f3a7	activity	+
headphone	1f3a7	-	-
musical_score	1f3bc	activity	+
musical_keyboard	1f3b9	activity	+
maracas	1fa87	activity	-
drum	1f941	activity	+
drum_with_drumsticks	1f941	-	+
long_drum	1fa98	activity	-
saxophone	1f3b7	activity	+
trumpet	1f3ba	activity	+
accordion	1fa97	activity	-
guitar	1f3b8	activity	+
banjo	1fa95	activity	-
harp	1fa89	activity	-
violin	1f3bb	activity	+
flute	1fa88	activity	-
game_die	1f3b2	activity	+
chess_pawn	265f-fe0f	activity	+
dart	1f3af	activity	+
direct_hit	1f3af	-	-
bowling	1f3b3	activity	+
video_game	1f3ae	activity	+
slot_machine	1f3b0	activity	+
jigsaw	1f9e9	activity	+
puzzle_piece	1f9e9	-	-
red_car	1f697	travel	+
automobile	1f697	-	-
taxi	1f695	travel	+
blue_car	1f699	travel	+
pickup_truck	1f6fb	travel	-
minibus	1f690	travel	+
bus	1f68c	travel	+
trolleybus	1f68e	travel	+
race_car	1f3ce-fe0f	travel	+
racing_car	1f3ce-fe0f	-	+
police_car	1f693	travel	+
ambulance	1f691	travel	+
fire_engine	1f692	travel	+
truck	1f69a	travel	+
articulated_lorry	1f69b	travel	+
tractor	1f69c	travel	+
probing_cane	1f9af	travel	-
manual_wheelchair	1f9bd	travel	-
motorized_wheelchair	1f9bc	travel	-
crutch	1fa7c	travel	-
scooter	1f6f4	travel	+
kick_scooter	1f6f4	-	-
bike	1f6b2	travel	+
bicycle	1f6b2	-	-
motor_scooter	1f6f5	travel	+
motorbike	1f6f5	-	+
motorcycle	1f3cd-fe0f	travel	+
racing_motorcycle	1f3cd-fe0f	-	+
auto_rickshaw	1f6fa	travel	-
wheel	1f6de	travel	-
rotating_light	1f6a8	travel	+
oncoming_police_car	1f694	travel	+
oncoming_bus	1f68d	travel	+
oncoming_automobile	1f698	travel	+
oncoming_taxi	1f696	travel	+
aerial_tramway	1f6a1	travel	+
mountain_cableway	1f6a0	travel	+
suspension_railway	1f69f	travel	+
railway_car	1f683	travel	+
train	1f68b	travel	+
tram_car	1f68b	-	-
mountain_railway	1f69e	travel	+
monorail	1f69d	travel	+
bullettrain_side	1f684	travel	+
bullettrain_front	1f685	travel	+
bullet_train	1f685	-	-
light_rail	1f688	travel	+
steam_locomotive	1f682	travel	+
locomotive	1f682	-	-
train2	1f686	travel	+
metro	1f687	travel	+
tram	1f68a	travel	+
station	1f689	travel	+
airplane	2708-fe0f	travel	+
airplane_departure	1f6eb	travel	+
airplane_arriving	1f6ec	travel	+
airplane_small	1f6e9-fe0f	travel	+
small_airplane	1f6e9-fe0f	-	+
seat	1f4ba	travel	+
satellite_orbital	1f6f0-fe0f	travel	+
rocket	1f680	travel	+
flying_saucer	1f6f8	travel	+
helicopter	1f681	travel	+
canoe	1f6f6	travel	+
kayak	1f6f6	-	+
sailboat	26f5	travel	+
speedboat	1f6a4	travel	+
motorboat	1f6e5-fe0f	travel	+
motor_boat	1f6e5-fe0f	-	-
cruise_ship	1f6f3-fe0f	travel	+
passenger_ship	1f6f3-fe0f	-	+
ferry	26f4-fe0f	travel	+
ship	1f6a2	travel	+
ring_buoy	1f6df	travel	-
anchor	2693	travel	+
hook	1fa9d	travel	-
fuelpump	26fd	travel	+
fuel_pump	26fd	-	-
construction	1f6a7	travel	+
vertical_traffic_light	1f6a6	travel	+
traffic_light	1f6a5	travel	+
busstop	1f68f	travel	+
bus_stop	1f68f	-	-
map	1f5fa-fe0f	travel	+
world_map	1f5fa-fe0f	-	+
moyai	1f5ff	travel	+
moai	1f5ff	-	-
statue_of_liberty	1f5fd	travel	+
tokyo_tower	1f5fc	travel	+
european_castle	1f3f0	travel	+
castle	1f3f0	-	-
japanese_castle	1f3ef	travel	+
stadium	1f3df-fe0f	travel	+
ferris_wheel	1f3a1	travel	+
roller_coaster	1f3a2	travel	+
carousel_horse	1f3a0	travel	+
fountain	26f2	travel	+
beach_umbrella	26f1-fe0f	travel	+
umbrella_on_ground	26f1-fe0f	-	+
beach	1f3d6-fe0f	travel	+
beach_with_umbrella	1f3d6-fe0f	-	+
island	1f3dd-fe0f	travel	+
desert_island	1f3dd-fe0f	-	+
desert	1f3dc-fe0f	travel	+
volcano	1f30b	travel	+
mountain	26f0-fe0f	travel	+
mountain_snow	1f3d4-fe0f	travel	+
snow_capped_mountain	1f3d4-fe0f	-	+
mount_fuji	1f5fb	travel	+
camping	1f3d5-fe0f	travel	+
tent	26fa	travel	+
house	1f3e0	travel	+
house_with_garden	1f3e1	travel	+
homes	1f3d8-fe0f	travel	+
house_buildings	1f3d8-fe0f	-	+
houses	1f3d8-fe0f	-	-
house_abandoned	1f3da-fe0f	travel	+
derelict_house_building	1f3da-fe0f	-	+
hut	1f6d6	travel	-
construction_site	1f3d7-fe0f	travel	+
building_construction	1f3d7-fe0f	-	+
factory	1f3ed	travel	+
office	1f3e2	travel	+
department_store	1f3ec	travel	+
post_office	1f3e3	travel	+
european_post_office	1f3e4	travel	+
hospital	1f3e5	travel	+
bank	1f3e6	travel	+
hotel	1f3e8	travel	+
convenience_store	1f3ea	travel	+
school	1f3eb	travel	+
love_hotel	1f3e9	travel	+
wedding	1f492	travel	+
classical_building	1f3db-fe0f	travel	+
church	26ea	travel	+
mosque	1f54c	travel	+
synagogue	1f54d	travel	+
hindu_temple	1f6d5	travel	-
kaaba	1f54b	travel	+
shinto_shrine	26e9-fe0f	travel	+
railway_track	1f6e4-fe0f	travel	+
railroad_track	1f6e4-fe0f	-	+
motorway	1f6e3-fe0f	travel	+
japan	1f5fe	travel	+
map_of_japan	1f5fe	-	-
rice_scene	1f391	travel	+
park	1f3de-fe0f	travel	+
national_park	1f3de-fe0f	-	+
sunrise	1f305	travel	+
sunrise_over_mountains	1f304	travel	+
stars	1f320	travel	+
shooting_star	1f320	-	-
sparkler	1f387	travel	+
fireworks	1f386	travel	+
city_sunset	1f307	travel	+
city_sunrise	1f307	-	+
sunset	1f307	-	-
city_dusk	1f306	travel	+
cityscape	1f3d9-fe0f	travel	+
night_with_stars	1f303	travel	+
milky_way	1f30c	travel	+
bridge_at_night	1f309	travel	+
foggy	1f301	travel	+
watch	231a	objects	+
mobile_phone	1f4f1	objects	-
calling	1f4f2	objects	+
computer	1f4bb	objects	+
keyboard	2328-fe0f	objects	+
desktop	1f5a5-fe0f	objects	+
desktop_computer	1f5a5-fe0f	-	+
printer	1f5a8-fe0f	objects	+
mouse_three_button	1f5b1-fe0f	objects	+
three_button_mouse	1f5b1-fe0f	-	+
trackball	1f5b2-fe0f	objects	+
joystick	1f579-fe0f	objects	+
compression	1f5dc-fe0f	objects	+
clamp	1f5dc-fe0f	-	-
minidisc	1f4bd	objects	+
computer_disk	1f4bd	-	-
floppy_disk	1f4be	objects	+
cd	1f4bf	objects	+
optical_disk	1f4bf	-	-
dvd	1f4c0	objects	+
vhs	1f4fc	objects	+
videocassette	1f4fc	-	-
camera	1f4f7	objects	+
camera_with_flash	1f4f8	objects	+
video_camera	1f4f9	objects	+
movie_camera	1f3a5	objects	+
projector	1f4fd-fe0f	objects	+
film_projector	1f4fd-fe0f	-	+
film_frames	1f39e-fe0f	objects	+
telephone_receiver	1f4de	objects	+
telephone	260e-fe0f	objects	+
pager	1f4df	objects	+
fax	1f4e0	objects	+
fax_machine	1f4e0	-	-
tv	1f4fa	objects	+
television	1f4fa	-	-
radio	1f4fb	objects	+
microphone2	1f399-fe0f	objects	+
studio_microphone	1f399-fe0f	-	+
level_slider	1f39a-fe0f	objects	+
control_knobs	1f39b-fe0f	objects	+
compass	1f9ed	objects	+
stopwatch	23f1-fe0f	objects	+
timer	23f2-fe0f	objects	+
timer_clock	23f2-fe0f	-	+
alarm_clock	23f0	objects	+
clock	1f570-fe0f	objects	+
mantlepiece_clock	1f570-fe0f	-	+
hourglass	231b	objects	+
hourglass_flowing_sand	23f3	objects	+
satellite	1f4e1	objects	+
battery	1f50b	objects	+
low_battery	1faab	objects	-
electric_plug	1f50c	objects	+
bulb	1f4a1	objects	+
light_bulb	1f4a1	-	-
flashlight	1f526	objects	+
candle	1f56f-fe0f	objects	+
diya_lamp	1fa94	objects	-
fire_extinguisher	1f9ef	objects	+
oil	1f6e2-fe0f	objects	+
oil_drum	1f6e2-fe0f	-	+
money_with_wings	1f4b8	objects	+
dollar	1f4b5	objects	+
yen	1f4b4	objects	+
yen_banknote	1f4b4	-	-
euro	1f4b6	objects	+
euro_banknote	1f4b6	-	-
pound	1f4b7	objects	+
coin	1fa99	objects	-
moneybag	1f4b0	objects	+
money_bag	1f4b0	-	-
credit_card	1f4b3	objects	+
identification_card	1faaa	objects	-
gem	1f48e	objects	+
gem_stone	1f48e	-	-
scales	2696-fe0f	objects	+
balance_scale	2696-fe0f	-	-
ladder	1fa9c	objects	-
toolbox	1f9f0	objects	+
screwdriver	1fa9b	objects	-
wrench	1f527	objects	+
hammer	1f528	objects	+
hammer_pick	2692-fe0f	objects	+
hammer_and_pick	2692-fe0f	-	+
tools	1f6e0-fe0f	objects	+
hammer_and_wrench	1f6e0-fe0f	-	+
pick	26cf-fe0f	objects	+
shovel	1fa8f	objects	-
carpentry_saw	1fa9a	objects	-
nut_and_bolt	1f529	objects	+
gear	2699-fe0f	objects	+
mouse_trap	1faa4	objects	-
bricks	1f9f1	objects	+
brick	1f9f1	-	-
chains	26d3-fe0f	objects	+
broken_chain	26d3-fe0f-200d-1f4a5	objects	-
magnet	1f9f2	objects	+
gun	1f52b	objects	+
pistol	1f52b	-	-
bomb	1f4a3	objects	+
firecracker	1f9e8	objects	+
axe	1fa93	objects	-
knife	1f52a	objects	+
kitchen_knife	1f52a	-	-
dagger	1f5e1-fe0f	objects	+
dagger_knife	1f5e1-fe0f	-	+
crossed_swords	2694-fe0f	objects	+
shield	1f6e1-fe0f	objects	+
smoking	1f6ac	objects	+
cigarette	1f6ac	-	-
coffin	26b0-fe0f	objects	+
headstone	1faa6	objects	-
urn	26b1-fe0f	objects	+
funeral_urn	26b1-fe0f	-	+
amphora	1f3fa	objects	+
crystal_ball	1f52e	objects	+
prayer_beads	1f4ff	objects	+
nazar_amulet	1f9ff	objects	+
hamsa	1faac	objects	-
barber	1f488	objects	+
barber_pole	1f488	-	-
alembic	2697-fe0f	objects	+
telescope	1f52d	objects	+
microscope	1f52c	objects	+
hole	1f573-fe0f	objects	+
x_ray	1fa7b	objects	-
adhesive_bandage	1fa79	objects	-
stethoscope	1fa7a	objects	-
pill	1f48a	objects	+
syringe	1f489	objects	+
drop_of_blood	1fa78	objects	-
dna	1f9ec	objects	+
microbe	1f9a0	objects	+
petri_dish	1f9eb	objects	+
test_tube	1f9ea	objects	+
thermometer	1f321-fe0f	objects	+
broom	1f9f9	objects	+
plunger	1faa0	objects	-
basket	1f9fa	objects	+
roll_of_paper	1f9fb	objects	+
toilet	1f6bd	objects	+
potable_water	1f6b0	objects	+
shower	1f6bf	objects	+
bathtub	1f6c1	objects	+
bath	1f6c0	objects	+
bath_tone1	1f6c0-1f3fb	-	+
bath_tone2	1f6c0-1f3fc	-	+
bath_tone3	1f6c0-1f3fd	-	+
bath_tone4	1f6c0-1f3fe	-	+
bath_tone5	1f6c0-1f3ff	-	+
soap	1f9fc	objects	+
toothbrush	1faa5	objects	-
razor	1fa92	objects	-
hair_pick	1faae	objects	-
sponge	1f9fd	objects	+
bucket	1faa3	objects	-
squeeze_bottle	1f9f4	objects	+
lotion_bottle	1f9f4	-	-
bellhop	1f6ce-fe0f	objects	+
bellhop_bell	1f6ce-fe0f	-	+
key	1f511	objects	+
key2	1f5dd-fe0f	objects	+
old_key	1f5dd-fe0f	-	+
door	1f6aa	objects	+
chair	1fa91	objects	-
couch	1f6cb-fe0f	objects	+
couch_and_lamp	1f6cb-fe0f	-	+
bed	1f6cf-fe0f	objects	+
sleeping_accommodation	1f6cc	objects	+
person_in_bed	1f6cc	-	-
person_in_bed_tone1	1f6cc-1f3fb	-	+
person_in_bed_light_skin_tone	1f6cc-1f3fb	-	+
person_in_bed_tone2	1f6cc-1f3fc	-	+
person_in_bed_medium_light_skin_tone	1f6cc-1f3fc	-	+
person_in_bed_tone3	1f6cc-1f3fd	-	+
person_in_bed_medium_skin_tone	1f6cc-1f3fd	-	+
person_in_bed_tone4	1f6cc-1f3fe	-	+
person_in_bed_medium_dark_skin_tone	1f6cc-1f3fe	-	+
person_in_bed_tone5	1f6cc-1f3ff	-	+
person_in_bed_dark_skin_tone	1f6cc-1f3ff	-	+
teddy_bear	1f9f8	objects	+
nesting_dolls	1fa86	objects	-
frame_photo	1f5bc-fe0f	objects	+
frame_with_picture	1f5bc-fe0f	-	+
mirror	1fa9e	objects	-
window	1fa9f	objects	-
shopping_bags	1f6cd-fe0f	objects	+
shopping_cart	1f6d2	objects	+
shopping_trolley	1f6d2	-	+
gift	1f381	objects	+
wrapped_gift	1f381	-	-
balloon	1f388	objects	+
flags	1f38f	objects	+
carp_streamer	1f38f	-	-
ribbon	1f380	objects	+
magic_wand	1fa84	objects	-
piñata	1fa85	objects	-
confetti_ball	1f38a	objects	+
tada	1f389	objects	+
party_popper	1f389	-	-
dolls	1f38e	objects	+
folding_hand_fan	1faad	objects	-
izakaya_lantern	1f3ee	objects	+
wind_chime	1f390	objects	+
mirror_ball	1faa9	objects	-
red_envelope	1f9e7	objects	+
envelope	2709-fe0f	objects	+
envelope_with_arrow	1f4e9	objects	+
incoming_envelope	1f4e8	objects	+
e-mail	1f4e7	objects	+
email	1f4e7	-	+
e_mail	1f4e7	-	-
love_letter	1f48c	objects	+
inbox_tray	1f4e5	objects	+
outbox_tray	1f4e4	objects	+
package	1f4e6	objects	+
label	1f3f7-fe0f	objects	+
placard	1faa7	objects	-
mailbox_closed	1f4ea	objects	+
mailbox	1f4eb	objects	+
mailbox_with_mail	1f4ec	objects	+
mailbox_with_no_mail	1f4ed	objects	+
postbox	1f4ee	objects	+
postal_horn	1f4ef	objects	+
scroll	1f4dc	objects	+
page_with_curl	1f4c3	objects	+
page_facing_up	1f4c4	objects	+
bookmark_tabs	1f4d1	objects	+
receipt	1f9fe	objects	+
bar_chart	1f4ca	objects	+
chart_with_upwards_trend	1f4c8	objects	+
chart_with_downwards_trend	1f4c9	objects	+
notepad_spiral	1f5d2-fe0f	objects	+
spiral_note_pad	1f5d2-fe0f	-	+
calendar_spiral	1f5d3-fe0f	objects	+
spiral_calendar_pad	1f5d3-fe0f	-	+
calendar	1f4c6	objects	+
date	1f4c5	objects	+
wastebasket	1f5d1-fe0f	objects	+
card_index	1f4c7	objects	+
card_box	1f5c3-fe0f	objects	+
card_file_box	1f5c3-fe0f	-	+
ballot_box	1f5f3-fe0f	objects	+
ballot_box_with_ballot	1f5f3-fe0f	-	+
file_cabinet	1f5c4-fe0f	objects	+
clipboard	1f4cb	objects	+
file_folder	1f4c1	objects	+
open_file_folder	1f4c2	objects	+
dividers	1f5c2-fe0f	objects	+
card_index_dividers	1f5c2-fe0f	-	+
newspaper2	1f5de-fe0f	objects	+
rolled_up_newspaper	1f5de-fe0f	-	+
newspaper	1f4f0	objects	+
notebook	1f4d3	objects	+
notebook_with_decorative_cover	1f4d4	objects	+
ledger	1f4d2	objects	+
closed_book	1f4d5	objects	+
green_book	1f4d7	objects	+
blue_book	1f4d8	objects	+
orange_book	1f4d9	objects	+
books	1f4da	objects	+
book	1f4d6	objects	+
open_book	1f4d6	-	-
bookmark	1f516	objects	+
safety_pin	1f9f7	objects	+
link	1f517	objects	+
paperclip	1f4ce	objects	+
paperclips	1f587-fe0f	objects	+
linked_paperclips	1f587-fe0f	-	+
triangular_ruler	1f4d0	objects	+
straight_ruler	1f4cf	objects	+
abacus	1f9ee	objects	+
pushpin	1f4cc	objects	+
round_pushpin	1f4cd	objects	+
scissors	2702-fe0f	objects	+
pen_ballpoint	1f58a-fe0f	objects	+
lower_left_ballpoint_pen	1f58a-fe0f	-	+
pen	1f58a-fe0f	-	-
pen_fountain	1f58b-fe0f	objects	+
lower_left_fountain_pen	1f58b-fe0f	-	+
fountain_pen	1f58b-fe0f	-	-
black_nib	2712-fe0f	objects	+
paintbrush	1f58c-fe0f	objects	+
lower_left_paintbrush	1f58c-fe0f	-	+
crayon	1f58d-fe0f	objects	+
lower_left_crayon	1f58d-fe0f	-	+
pencil	1f4dd	objects	+
memo	1f4dd	-	+
pencil2	270f-fe0f	objects	+
mag	1f50d	objects	+
mag_right	1f50e	objects	+
lock_with_ink_pen	1f50f	objects	+
closed_lock_with_key	1f510	objects	+
lock	1f512	objects	+
locked	1f512	-	-
unlock	1f513	objects	+
unlocked	1f513	-	-
pink_heart	1fa77	symbols	-
heart	2764-fe0f	symbols	+
red_heart	2764-fe0f	-	-
orange_heart	1f9e1	symbols	+
yellow_heart	1f49b	symbols	+
green_heart	1f49a	symbols	+
light_blue_heart	1fa75	symbols	-
blue_heart	1f499	symbols	+
purple_heart	1f49c	symbols	+
black_heart	1f5a4	symbols	+
grey_heart	1fa76	symbols	-
white_heart	1f90d	symbols	-
brown_heart	1f90e	symbols	-
broken_heart	1f494	symbols	+
heart_exclamation	2763-fe0f	symbols	+
heavy_heart_exclamation_mark_ornament	2763-fe0f	-	+
two_hearts	1f495	symbols	+
revolving_hearts	1f49e	symbols	+
heartbeat	1f493	symbols	+
beating_heart	1f493	-	-
heartpulse	1f497	symbols	+
growing_heart	1f497	-	-
sparkling_heart	1f496	symbols	+
cupid	1f498	symbols	+
gift_heart	1f49d	symbols	+
mending_heart	2764-fe0f-200d-1fa79	symbols	-
heart_on_fire	2764-fe0f-200d-1f525	symbols	-
heart_decoration	1f49f	symbols	+
peace	262e-fe0f	symbols	+
peace_symbol	262e-fe0f	-	+
cross	271d-fe0f	symbols	+
latin_cross	271d-fe0f	-	+
star_and_crescent	262a-fe0f	symbols	+
om_symbol	1f549-fe0f	symbols	+
wheel_of_dharma	2638-fe0f	symbols	+
khanda	1faaf	symbols	-
star_of_david	2721-fe0f	symbols	+
six_pointed_star	1f52f	symbols	+
menorah	1f54e	symbols	+
yin_yang	262f-fe0f	symbols	+
orthodox_cross	2626-fe0f	symbols	+
place_of_worship	1f6d0	symbols	+
worship_symbol	1f6d0	-	+
ophiuchus	26ce	symbols	+
aries	2648	symbols	+
taurus	2649	symbols	+
gemini	264a	symbols	+
cancer	264b	symbols	+
leo	264c	symbols	+
virgo	264d	symbols	+
libra	264e	symbols	+
scorpius	264f	symbols	+
scorpio	264f	-	-
sagittarius	2650	symbols	+
capricorn	2651	symbols	+
aquarius	2652	symbols	+
pisces	2653	symbols	+
id	1f194	symbols	+
atom	269b-fe0f	symbols	+
atom_symbol	269b-fe0f	-	+
accept	1f251	symbols	+
radioactive	2622-fe0f	symbols	+
radioactive_sign	2622-fe0f	-	+
biohazard	2623-fe0f	symbols	+
biohazard_sign	2623-fe0f	-	+
mobile_phone_off	1f4f4	symbols	+
vibration_mode	1f4f3	symbols	+
u6709	1f236	symbols	+
u7121	1f21a	symbols	+
u7533	1f238	symbols	+
u55b6	1f23a	symbols	+
u6708	1f237-fe0f	symbols	+
eight_pointed_black_star	2734-fe0f	symbols	+
vs	1f19a	symbols	+
white_flower	1f4ae	symbols	+
ideograph_advantage	1f250	symbols	+
secret	3299-fe0f	symbols	+
congratulations	3297-fe0f	symbols	+
u5408	1f234	symbols	+
u6e80	1f235	symbols	+
u5272	1f239	symbols	+
u7981	1f232	symbols	+
a	1f170-fe0f	symbols	+
b	1f171-fe0f	symbols	+
ab	1f18e	symbols	+
cl	1f191	symbols	+
o2	1f17e-fe0f	symbols	+
sos	1f198	symbols	+
x	274c	symbols	+
cross_mark	274c	-	-
o	2b55	symbols	+
octagonal_sign	1f6d1	symbols	+
stop_sign	1f6d1	-	+
no_entry	26d4	symbols	+
name_badge	1f4db	symbols	+
no_entry_sign	1f6ab	symbols	+
prohibited	1f6ab	-	-
100	1f4af	symbols	+
anger	1f4a2	symbols	+
hotsprings	2668-fe0f	symbols	+
hot_springs	2668-fe0f	-	-
no_pedestrians	1f6b7	symbols	+
do_not_litter	1f6af	symbols	+
no_littering	1f6af	-	-
no_bicycles	1f6b3	symbols	+
non-potable_water	1f6b1	symbols	+
underage	1f51e	symbols	+
no_mobile_phones	1f4f5	symbols	+
no_smoking	1f6ad	symbols	+
exclamation	2757	symbols	+
grey_exclamation	2755	symbols	+
question	2753	symbols	+
question_mark	2753	-	-
grey_question	2754	symbols	+
bangbang	203c-fe0f	symbols	+
interrobang	2049-fe0f	symbols	+
low_brightness	1f505	symbols	+
high_brightness	1f506	symbols	+
part_alternation_mark	303d-fe0f	symbols	+
warning	26a0-fe0f	symbols	+
children_crossing	1f6b8	symbols	+
trident	1f531	symbols	+
fleur-de-lis	269c-fe0f	symbols	+
fleur_de_lis	269c-fe0f	-	-
beginner	1f530	symbols	+
recycle	267b-fe0f	symbols	+
white_check_mark	2705	symbols	+
u6307	1f22f	symbols	+
chart	1f4b9	symbols	+
sparkle	2747-fe0f	symbols	+
eight_spoked_asterisk	2733-fe0f	symbols	+
negative_squared_cross_mark	274e	symbols	+
globe_with_meridians	1f310	symbols	+
diamond_shape_with_a_dot_inside	1f4a0	symbols	+
m	24c2-fe0f	symbols	+
circled_m	24c2-fe0f	-	-
cyclone	1f300	symbols	+
zzz	1f4a4	symbols	+
atm	1f3e7	symbols	+
wc	1f6be	symbols	+
water_closet	1f6be	-	-
wheelchair	267f	symbols	+
parking	1f17f-fe0f	symbols	+
elevator	1f6d7	symbols	-
u7a7a	1f233	symbols	+
sa	1f202-fe0f	symbols	+
passport_control	1f6c2	symbols	+
customs	1f6c3	symbols	+
baggage_claim	1f6c4	symbols	+
left_luggage	1f6c5	symbols	+
wireless	1f6dc	symbols	-
mens	1f6b9	symbols	+
mens_room	1f6b9	-	-
womens	1f6ba	symbols	+
womens_room	1f6ba	-	-
baby_symbol	1f6bc	symbols	+
restroom	1f6bb	symbols	+
put_litter_in_its_place	1f6ae	symbols	+
cinema	1f3a6	symbols	+
signal_strength	1f4f6	symbols	+
antenna_bars	1f4f6	-	-
koko	1f201	symbols	+
symbols	1f523	symbols	+
input_symbols	1f523	-	-
information_source	2139-fe0f	symbols	+
information	2139-fe0f	-	-
abc	1f524	symbols	+
abcd	1f521	symbols	+
capital_abcd	1f520	symbols	+
ng	1f196	symbols	+
ok	1f197	symbols	+
up	1f199	symbols	+
cool	1f192	symbols	+
new	1f195	symbols	+
free	1f193	symbols	+
zero	0030-fe0f-20e3	symbols	+
one	0031-fe0f-20e3	symbols	+
two	0032-fe0f-20e3	symbols	+
three	0033-fe0f-20e3	symbols	+
four	0034-fe0f-20e3	symbols	+
five	0035-fe0f-20e3	symbols	+
six	0036-fe0f-20e3	symbols	+
seven	0037-fe0f-20e3	symbols	+
eight	0038-fe0f-20e3	symbols	+
nine	0039-fe0f-20e3	symbols	+
keycap_ten	1f51f	symbols	+
1234	1f522	symbols	+
input_numbers	1f522	-	-
hash	0023-fe0f-20e3	symbols	+
asterisk	002a-fe0f-20e3	symbols	+
keycap_asterisk	002a-fe0f-20e3	-	+
eject	23cf-fe0f	symbols	+
eject_symbol	23cf-fe0f	-	+
arrow_forward	25b6-fe0f	symbols	+
pause_button	23f8-fe0f	symbols	+
double_vertical_bar	23f8-fe0f	-	+
play_pause	23ef-fe0f	symbols	+
stop_button	23f9-fe0f	symbols	+
record_button	23fa-fe0f	symbols	+
track_next	23ed-fe0f	symbols	+
next_track	23ed-fe0f	-	+
track_previous	23ee-fe0f	symbols	+
previous_track	23ee-fe0f	-	+
fast_forward	23e9	symbols	+
rewind	23ea	symbols	+
arrow_double_up	23eb	symbols	+
arrow_double_down	23ec	symbols	+
arrow_backward	25c0-fe0f	symbols	+
arrow_up_small	1f53c	symbols	+
arrow_down_small	1f53d	symbols	+
arrow_right	27a1-fe0f	symbols	+
right_arrow	27a1-fe0f	-	-
arrow_left	2b05-fe0f	symbols	+
left_arrow	2b05-fe0f	-	-
arrow_up	2b06-fe0f	symbols	+
up_arrow	2b06-fe0f	-	-
arrow_down	2b07-fe0f	symbols	+
down_arrow	2b07-fe0f	-	-
arrow_upper_right	2197-fe0f	symbols	+
arrow_lower_right	2198-fe0f	symbols	+
arrow_lower_left	2199-fe0f	symbols	+
arrow_upper_left	2196-fe0f	symbols	+
up_left_arrow	2196-fe0f	-	-
arrow_up_down	2195-fe0f	symbols	+
up_down_arrow	2195-fe0f	-	-
left_right_arrow	2194-fe0f	symbols	+
arrow_right_hook	21aa-fe0f	symbols	+
leftwards_arrow_with_hook	21a9-fe0f	symbols	+
arrow_heading_up	2934-fe0f	symbols	+
arrow_heading_down	2935-fe0f	symbols	+
twisted_rightwards_arrows	1f500	symbols	+
repeat	1f501	symbols	+
repeat_one	1f502	symbols	+
arrows_counterclockwise	1f504	symbols	+
arrows_clockwise	1f503	symbols	+
musical_note	1f3b5	symbols	+
notes	1f3b6	symbols	+
musical_notes	1f3b6	-	-
heavy_plus_sign	2795	symbols	+
heavy_minus_sign	2796	symbols	+
heavy_division_sign	2797	symbols	+
heavy_multiplication_x	2716-fe0f	symbols	+
heavy_equals_sign	1f7f0	symbols	-
infinity	267e-fe0f	symbols	+
heavy_dollar_sign	1f4b2	symbols	+
currency_exchange	1f4b1	symbols	+
tm	2122-fe0f	symbols	+
trade_mark	2122-fe0f	-	-
copyright	00a9-fe0f	symbols	+
registered	00ae-fe0f	symbols	+
wavy_dash	3030-fe0f	symbols	+
curly_loop	27b0	symbols	+
loop	27bf	symbols	+
end	1f51a	symbols	+
end_arrow	1f51a	-	-
back	1f519	symbols	+
back_arrow	1f519	-	-
on	1f51b	symbols	+
on_arrow	1f51b	-	-
top	1f51d	symbols	+
top_arrow	1f51d	-	-
soon	1f51c	symbols	+
soon_arrow	1f51c	-	-
heavy_check_mark	2714-fe0f	symbols	+
check_mark	2714-fe0f	-	-
ballot_box_with_check	2611-fe0f	symbols	+
radio_button	1f518	symbols	+
white_circle	26aa	symbols	+
black_circle	26ab	symbols	+
red_circle	1f534	symbols	+
blue_circle	1f535	symbols	+
brown_circle	1f7e4	symbols	-
purple_circle	1f7e3	symbols	-
green_circle	1f7e2	symbols	-
yellow_circle	1f7e1	symbols	-
orange_circle	1f7e0	symbols	-
small_red_triangle	1f53a	symbols	+
small_red_triangle_down	1f53b	symbols	+
small_orange_diamond	1f538	symbols	+
small_blue_diamond	1f539	symbols	+
large_orange_diamond	1f536	symbols	+
large_blue_diamond	1f537	symbols	+
white_square_button	1f533	symbols	+
black_square_button	1f532	symbols	+
black_small_square	25aa-fe0f	symbols	+
white_small_square	25ab-fe0f	symbols	+
black_medium_small_square	25fe	symbols	+
white_medium_small_square	25fd	symbols	+
black_medium_square	25fc-fe0f	symbols	+
white_medium_square	25fb-fe0f	symbols	+
black_large_square	2b1b	symbols	+
white_large_square	2b1c	symbols	+
orange_square	1f7e7	symbols	-
blue_square	1f7e6	symbols	-
red_square	1f7e5	symbols	-
brown_square	1f7eb	symbols	-
purple_square	1f7ea	symbols	-
green_square	1f7e9	symbols	-
yellow_square	1f7e8	symbols	-
speaker	1f508	symbols	+
mute	1f507	symbols	+
muted_speaker	1f507	-	-
sound	1f509	symbols	+
loud_sound	1f50a	symbols	+
bell	1f514	symbols	+
no_bell	1f515	symbols	+
mega	1f4e3	symbols	+
megaphone	1f4e3	-	-
loudspeaker	1f4e2	symbols	+
speech_left	1f5e8-fe0f	symbols	+
left_speech_bubble	1f5e8-fe0f	-	+
eye_in_speech_bubble	1f441-fe0f-200d-1f5e8-fe0f	symbols	+
speech_balloon	1f4ac	symbols	+
thought_balloon	1f4ad	symbols	+
anger_right	1f5ef-fe0f	symbols	+
right_anger_bubble	1f5ef-fe0f	-	+
spades	2660-fe0f	symbols	+
spade_suit	2660-fe0f	-	-
clubs	2663-fe0f	symbols	+
club_suit	2663-fe0f	-	-
hearts	2665-fe0f	symbols	+
heart_suit	2665-fe0f	-	-
diamonds	2666-fe0f	symbols	+
diamond_suit	2666-fe0f	-	-
black_joker	1f0cf	symbols	+
joker	1f0cf	-	-
flower_playing_cards	1f3b4	symbols	+
mahjong	1f004	symbols	+
clock1	1f550	symbols	+
one_oclock	1f550	-	-
clock2	1f551	symbols	+
two_oclock	1f551	-	-
clock3	1f552	symbols	+
three_oclock	1f552	-	-
clock4	1f553	symbols	+
four_oclock	1f553	-	-
clock5	1f554	symbols	+
five_oclock	1f554	-	-
clock6	1f555	symbols	+
six_oclock	1f555	-	-
clock7	1f556	symbols	+
seven_oclock	1f556	-	-
clock8	1f557	symbols	+
eight_oclock	1f557	-	-
clock9	1f558	symbols	+
nine_oclock	1f558	-	-
clock10	1f559	symbols	+
ten_oclock	1f559	-	-
clock11	1f55a	symbols	+
eleven_oclock	1f55a	-	-
clock12	1f55b	symbols	+
twelve_oclock	1f55b	-	-
clock130	1f55c	symbols	+
one_thirty	1f55c	-	-
clock230	1f55d	symbols	+
two_thirty	1f55d	-	-
clock330	1f55e	symbols	+
three_thirty	1f55e	-	-
clock430	1f55f	symbols	+
four_thirty	1f55f	-	-
clock530	1f560	symbols	+
five_thirty	1f560	-	-
clock630	1f561	symbols	+
six_thirty	1f561	-	-
clock730	1f562	symbols	+
seven_thirty	1f562	-	-
clock830	1f563	symbols	+
eight_thirty	1f563	-	-
clock930	1f564	symbols	+
nine_thirty	1f564	-	-
clock1030	1f565	symbols	+
ten_thirty	1f565	-	-
clock1130	1f566	symbols	+
eleven_thirty	1f566	-	-
clock1230	1f567	symbols	+
twelve_thirty	1f567	-	-
digit_zero	0030-fe0f	symbols	+
digit_one	0031-fe0f	symbols	+
digit_two	0032-fe0f	symbols	+
digit_three	0033-fe0f	symbols	+
digit_four	0034-fe0f	symbols	+
digit_five	0035-fe0f	symbols	+
digit_six	0036-fe0f	symbols	+
digit_seven	0037-fe0f	symbols	+
digit_eight	0038-fe0f	symbols	+
digit_nine	0039-fe0f	symbols	+
pound_symbol	0023-fe0f	symbols	+
asterisk_symbol	002a-fe0f	symbols	+
female_sign	2640-fe0f	symbols	+
male_sign	2642-fe0f	symbols	+
transgender_symbol	26a7	symbols	-
medical_symbol	2695-fe0f	symbols	+
flag_white	1f3f3-fe0f	flags	+
waving_white_flag	1f3f3-fe0f	-	+
white_flag	1f3f3-fe0f	-	-
flag_black	1f3f4	flags	+
waving_black_flag	1f3f4	-	+
black_flag	1f3f4	-	-
pirate_flag	1f3f4-200d-2620-fe0f	flags	+
checkered_flag	1f3c1	flags	+
triangular_flag_on_post	1f6a9	flags	+
rainbow_flag	1f3f3-fe0f-200d-1f308	flags	+
gay_pride_flag	1f3f3-fe0f-200d-1f308	-	+
transgender_flag	1f3f3-fe0f-200d-26a7-fe0f	flags	-
united_nations	1f1fa-1f1f3	flags	+
flag_af	1f1e6-1f1eb	flags	+
af	1f1e6-1f1eb	-	+
flag_ax	1f1e6-1f1fd	flags	+
ax	1f1e6-1f1fd	-	+
flag_al	1f1e6-1f1f1	flags	+
al	1f1e6-1f1f1	-	+
flag_dz	1f1e9-1f1ff	flags	+
dz	1f1e9-1f1ff	-	+
flag_as	1f1e6-1f1f8	flags	+
as	1f1e6-1f1f8	-	+
flag_ad	1f1e6-1f1e9	flags	+
ad	1f1e6-1f1e9	-	+
flag_ao	1f1e6-1f1f4	flags	+
ao	1f1e6-1f1f4	-	+
flag_ai	1f1e6-1f1ee	flags	+
ai	1f1e6-1f1ee	-	+
flag_aq	1f1e6-1f1f6	flags	+
aq	1f1e6-1f1f6	-	+
flag_ag	1f1e6-1f1ec	flags	+
ag	1f1e6-1f1ec	-	+
flag_ar	1f1e6-1f1f7	flags	+
ar	1f1e6-1f1f7	-	+
flag_am	1f1e6-1f1f2	flags	+
am	1f1e6-1f1f2	-	+
flag_aw	1f1e6-1f1fc	flags	+
aw	1f1e6-1f1fc	-	+
flag_au	1f1e6-1f1fa	flags	+
au	1f1e6-1f1fa	-	+
flag_at	1f1e6-1f1f9	flags	+
at	1f1e6-1f1f9	-	+
flag_az	1f1e6-1f1ff	flags	+
az	1f1e6-1f1ff	-	+
flag_bs	1f1e7-1f1f8	flags	+
bs	1f1e7-1f1f8	-	+
flag_bh	1f1e7-1f1ed	flags	+
bh	1f1e7-1f1ed	-	+
flag_bd	1f1e7-1f1e9	flags	+
bd	1f1e7-1f1e9	-	+
flag_bb	1f1e7-1f1e7	flags	+
bb	1f1e7-1f1e7	-	+
flag_by	1f1e7-1f1fe	flags	+
by	1f1e7-1f1fe	-	+
flag_be	1f1e7-1f1ea	flags	+
be	1f1e7-1f1ea	-	+
flag_bz	1f1e7-1f1ff	flags	+
bz	1f1e7-1f1ff	-	+
flag_bj	1f1e7-1f1ef	flags	+
bj	1f1e7-1f1ef	-	+
flag_bm	1f1e7-1f1f2	flags	+
bm	1f1e7-1f1f2	-	+
flag_bt	1f1e7-1f1f9	flags	+
bt	1f1e7-1f1f9	-	+
flag_bo	1f1e7-1f1f4	flags	+
bo	1f1e7-1f1f4	-	+
flag_ba	1f1e7-1f1e6	flags	+
ba	1f1e7-1f1e6	-	+
flag_bw	1f1e7-1f1fc	flags	+
bw	1f1e7-1f1fc	-	+
flag_br	1f1e7-1f1f7	flags	+
br	1f1e7-1f1f7	-	+
flag_io	1f1ee-1f1f4	flags	+
io	1f1ee-1f1f4	-	+
flag_vg	1f1fb-1f1ec	flags	+
vg	1f1fb-1f1ec	-	+
flag_bn	1f1e7-1f1f3	flags	+
bn	1f1e7-1f1f3	-	+
flag_bg	1f1e7-1f1ec	flags	+
bg	1f1e7-1f1ec	-	+
flag_bf	1f1e7-1f1eb	flags	+
bf	1f1e7-1f1eb	-	+
flag_bi	1f1e7-1f1ee	flags	+
bi	1f1e7-1f1ee	-	+
flag_kh	1f1f0-1f1ed	flags	+
kh	1f1f0-1f1ed	-	+
flag_cm	1f1e8-1f1f2	flags	+
cm	1f1e8-1f1f2	-	+
flag_ca	1f1e8-1f1e6	flags	+
ca	1f1e8-1f1e6	-	+
flag_ic	1f1ee-1f1e8	flags	+
ic	1f1ee-1f1e8	-	+
flag_cv	1f1e8-1f1fb	flags	+
cv	1f1e8-1f1fb	-	+
flag_bq	1f1e7-1f1f6	flags	+
bq	1f1e7-1f1f6	-	+
flag_ky	1f1f0-1f1fe	flags	+
ky	1f1f0-1f1fe	-	+
flag_cf	1f1e8-1f1eb	flags	+
cf	1f1e8-1f1eb	-	+
flag_td	1f1f9-1f1e9	flags	+
td	1f1f9-1f1e9	-	+
flag_cl	1f1e8-1f1f1	flags	+
chile	1f1e8-1f1f1	-	+
flag_cn	1f1e8-1f1f3	flags	+
cn	1f1e8-1f1f3	-	+
flag_cx	1f1e8-1f1fd	flags	+
cx	1f1e8-1f1fd	-	+
flag_cc	1f1e8-1f1e8	flags	+
cc	1f1e8-1f1e8	-	+
flag_co	1f1e8-1f1f4	flags	+
co	1f1e8-1f1f4	-	+
flag_km	1f1f0-1f1f2	flags	+
km	1f1f0-1f1f2	-	+
flag_cg	1f1e8-1f1ec	flags	+
cg	1f1e8-1f1ec	-	+
flag_cd	1f1e8-1f1e9	flags	+
congo	1f1e8-1f1e9	-	+
flag_ck	1f1e8-1f1f0	flags	+
ck	1f1e8-1f1f0	-	+
flag_cr	1f1e8-1f1f7	flags	+
cr	1f1e8-1f1f7	-	+
flag_ci	1f1e8-1f1ee	flags	+
ci	1f1e8-1f1ee	-	+
flag_hr	1f1ed-1f1f7	flags	+
hr	1f1ed-1f1f7	-	+
flag_cu	1f1e8-1f1fa	flags	+
cu	1f1e8-1f1fa	-	+
flag_cw	1f1e8-1f1fc	flags	+
cw	1f1e8-1f1fc	-	+
flag_cy	1f1e8-1f1fe	flags	+
cy	1f1e8-1f1fe	-	+
flag_cz	1f1e8-1f1ff	flags	+
cz	1f1e8-1f1ff	-	+
flag_dk	1f1e9-1f1f0	flags	+
dk	1f1e9-1f1f0	-	+
flag_dj	1f1e9-1f1ef	flags	+
dj	1f1e9-1f1ef	-	+
flag_dm	1f1e9-1f1f2	flags	+
dm	1f1e9-1f1f2	-	+
flag_do	1f1e9-1f1f4	flags	+
do	1f1e9-1f1f4	-	+
flag_ec	1f1ea-1f1e8	flags	+
ec	1f1ea-1f1e8	-	+
flag_eg	1f1ea-1f1ec	flags	+
eg	1f1ea-1f1ec	-	+
flag_sv	1f1f8-1f1fb	flags	+
sv	1f1f8-1f1fb	-	+
flag_gq	1f1ec-1f1f6	flags	+
gq	1f1ec-1f1f6	-	+
flag_er	1f1ea-1f1f7	flags	+
er	1f1ea-1f1f7	-	+
flag_ee	1f1ea-1f1ea	flags	+
ee	1f1ea-1f1ea	-	+
flag_et	1f1ea-1f1f9	flags	+
et	1f1ea-1f1f9	-	+
flag_eu	1f1ea-1f1fa	flags	+
eu	1f1ea-1f1fa	-	+
flag_fk	1f1eb-1f1f0	flags	+
fk	1f1eb-1f1f0	-	+
flag_fo	1f1eb-1f1f4	flags	+
fo	1f1eb-1f1f4	-	+
flag_fj	1f1eb-1f1ef	flags	+
fj	1f1eb-1f1ef	-	+
flag_fi	1f1eb-1f1ee	flags	+
fi	1f1eb-1f1ee	-	+
flag_fr	1f1eb-1f1f7	flags	+
fr	1f1eb-1f1f7	-	+
flag_gf	1f1ec-1f1eb	flags	+
gf	1f1ec-1f1eb	-	+
flag_pf	1f1f5-1f1eb	flags	+
pf	1f1f5-1f1eb	-	+
flag_tf	1f1f9-1f1eb	flags	+
tf	1f1f9-1f1eb	-	+
flag_ga	1f1ec-1f1e6	flags	+
ga	1f1ec-1f1e6	-	+
flag_gm	1f1ec-1f1f2	flags	+
gm	1f1ec-1f1f2	-	+
flag_ge	1f1ec-1f1ea	flags	+
ge	1f1ec-1f1ea	-	+
flag_de	1f1e9-1f1ea	flags	+
de	1f1e9-1f1ea	-	+
flag_gh	1f1ec-1f1ed	flags	+
gh	1f1ec-1f1ed	-	+
flag_gi	1f1ec-1f1ee	flags	+
gi	1f1ec-1f1ee	-	+
flag_gr	1f1ec-1f1f7	flags	+
gr	1f1ec-1f1f7	-	+
flag_gl	1f1ec-1f1f1	flags	+
gl	1f1ec-1f1f1	-	+
flag_gd	1f1ec-1f1e9	flags	+
gd	1f1ec-1f1e9	-	+
flag_gp	1f1ec-1f1f5	flags	+
gp	1f1ec-1f1f5	-	+
flag_gu	1f1ec-1f1fa	flags	+
gu	1f1ec-1f1fa	-	+
flag_gt	1f1ec-1f1f9	flags	+
gt	1f1ec-1f1f9	-	+
flag_gg	1f1ec-1f1ec	flags	+
gg	1f1ec-1f1ec	-	+
flag_gn	1f1ec-1f1f3	flags	+
gn	1f1ec-1f1f3	-	+
flag_gw	1f1ec-1f1fc	flags	+
gw	1f1ec-1f1fc	-	+
flag_gy	1f1ec-1f1fe	flags	+
gy	1f1ec-1f1fe	-	+
flag_ht	1f1ed-1f1f9	flags	+
ht	1f1ed-1f1f9	-	+
flag_hn	1f1ed-1f1f3	flags	+
hn	1f1ed-1f1f3	-	+
flag_hk	1f1ed-1f1f0	flags	+
hk	1f1ed-1f1f0	-	+
flag_hu	1f1ed-1f1fa	flags	+
hu	1f1ed-1f1fa	-	+
flag_is	1f1ee-1f1f8	flags	+
is	1f1ee-1f1f8	-	+
flag_in	1f1ee-1f1f3	flags	+
in	1f1ee-1f1f3	-	+
flag_id	1f1ee-1f1e9	flags	+
indonesia	1f1ee-1f1e9	-	+
flag_ir	1f1ee-1f1f7	flags	+
ir	1f1ee-1f1f7	-	+
flag_iq	1f1ee-1f1f6	flags	+
iq	1f1ee-1f1f6	-	+
flag_ie	1f1ee-1f1ea	flags	+
ie	1f1ee-1f1ea	-	+
flag_im	1f1ee-1f1f2	flags	+
im	1f1ee-1f1f2	-	+
flag_il	1f1ee-1f1f1	flags	+
il	1f1ee-1f1f1	-	+
flag_it	1f1ee-1f1f9	flags	+
it	1f1ee-1f1f9	-	+
flag_jm	1f1ef-1f1f2	flags	+
jm	1f1ef-1f1f2	-	+
flag_jp	1f1ef-1f1f5	flags	+
jp	1f1ef-1f1f5	-	+
crossed_flags	1f38c	flags	+
flag_je	1f1ef-1f1ea	flags	+
je	1f1ef-1f1ea	-	+
flag_jo	1f1ef-1f1f4	flags	+
jo	1f1ef-1f1f4	-	+
flag_kz	1f1f0-1f1ff	flags	+
kz	1f1f0-1f1ff	-	+
flag_ke	1f1f0-1f1ea	flags	+
ke	1f1f0-1f1ea	-	+
flag_ki	1f1f0-1f1ee	flags	+
ki	1f1f0-1f1ee	-	+
flag_xk	1f1fd-1f1f0	flags	+
xk	1f1fd-1f1f0	-	+
flag_kw	1f1f0-1f1fc	flags	+
kw	1f1f0-1f1fc	-	+
flag_kg	1f1f0-1f1ec	flags	+
kg	1f1f0-1f1ec	-	+
flag_la	1f1f1-1f1e6	flags	+
la	1f1f1-1f1e6	-	+
flag_lv	1f1f1-1f1fb	flags	+
lv	1f1f1-1f1fb	-	+
flag_lb	1f1f1-1f1e7	flags	+
lb	1f1f1-1f1e7	-	+
flag_ls	1f1f1-1f1f8	flags	+
ls	1f1f1-1f1f8	-	+
flag_lr	1f1f1-1f1f7	flags	+
lr	1f1f1-1f1f7	-	+
flag_ly	1f1f1-1f1fe	flags	+
ly	1f1f1-1f1fe	-	+
flag_li	1f1f1-1f1ee	flags	+
li	1f1f1-1f1ee	-	+
flag_lt	1f1f1-1f1f9	flags	+
lt	1f1f1-1f1f9	-	+
flag_lu	1f1f1-1f1fa	flags	+
lu	1f1f1-1f1fa	-	+
flag_mo	1f1f2-1f1f4	flags	+
mo	1f1f2-1f1f4	-	+
flag_mk	1f1f2-1f1f0	flags	+
mk	1f1f2-1f1f0	-	+
flag_mg	1f1f2-1f1ec	flags	+
mg	1f1f2-1f1ec	-	+
flag_mw	1f1f2-1f1fc	flags	+
mw	1f1f2-1f1fc	-	+
flag_my	1f1f2-1f1fe	flags	+
my	1f1f2-1f1fe	-	+
flag_mv	1f1f2-1f1fb	flags	+
mv	1f1f2-1f1fb	-	+
flag_ml	1f1f2-1f1f1	flags	+
ml	1f1f2-1f1f1	-	+
flag_mt	1f1f2-1f1f9	flags	+
mt	1f1f2-1f1f9	-	+
flag_mh	1f1f2-1f1ed	flags	+
mh	1f1f2-1f1ed	-	+
flag_mq	1f1f2-1f1f6	flags	+
mq	1f1f2-1f1f6	-	+
flag_mr	1f1f2-1f1f7	flags	+
mr	1f1f2-1f1f7	-	+
flag_mu	1f1f2-1f1fa	flags	+
mu	1f1f2-1f1fa	-	+
flag_yt	1f1fe-1f1f9	flags	+
yt	1f1fe-1f1f9	-	+
flag_mx	1f1f2-1f1fd	flags	+
mx	1f1f2-1f1fd	-	+
flag_fm	1f1eb-1f1f2	flags	+
fm	1f1eb-1f1f2	-	+
flag_md	1f1f2-1f1e9	flags	+
md	1f1f2-1f1e9	-	+
flag_mc	1f1f2-1f1e8	flags	+
mc	1f1f2-1f1e8	-	+
flag_mn	1f1f2-1f1f3	flags	+
mn	1f1f2-1f1f3	-	+
flag_me	1f1f2-1f1ea	flags	+
me	1f1f2-1f1ea	-	+
flag_ms	1f1f2-1f1f8	flags	+
ms	1f1f2-1f1f8	-	+
flag_ma	1f1f2-1f1e6	flags	+
ma	1f1f2-1f1e6	-	+
flag_mz	1f1f2-1f1ff	flags	+
mz	1f1f2-1f1ff	-	+
flag_mm	1f1f2-1f1f2	flags	+
mm	1f1f2-1f1f2	-	+
flag_na	1f1f3-1f1e6	flags	+
na	1f1f3-1f1e6	-	+
flag_nr	1f1f3-1f1f7	flags	+
nr	1f1f3-1f1f7	-	+
flag_np	1f1f3-1f1f5	flags	+
np	1f1f3-1f1f5	-	+
flag_nl	1f1f3-1f1f1	flags	+
nl	1f1f3-1f1f1	-	+
flag_nc	1f1f3-1f1e8	flags	+
nc	1f1f3-1f1e8	-	+
flag_nz	1f1f3-1f1ff	flags	+
nz	1f1f3-1f1ff	-	+
flag_ni	1f1f3-1f1ee	flags	+
ni	1f1f3-1f1ee	-	+
flag_ne	1f1f3-1f1ea	flags	+
ne	1f1f3-1f1ea	-	+
flag_ng	1f1f3-1f1ec	flags	+
nigeria	1f1f3-1f1ec	-	+
flag_nu	1f1f3-1f1fa	flags	+
nu	1f1f3-1f1fa	-	+
flag_nf	1f1f3-1f1eb	flags	+
nf	1f1f3-1f1eb	-	+
flag_kp	1f1f0-1f1f5	flags	+
kp	1f1f0-1f1f5	-	+
flag_mp	1f1f2-1f1f5	flags	+
mp	1f1f2-1f1f5	-	+
flag_no	1f1f3-1f1f4	flags	+
no	1f1f3-1f1f4	-	+
flag_om	1f1f4-1f1f2	flags	+
om	1f1f4-1f1f2	-	+
flag_pk	1f1f5-1f1f0	flags	+
pk	1f1f5-1f1f0	-	+
flag_pw	1f1f5-1f1fc	flags	+
pw	1f1f5-1f1fc	-	+
flag_ps	1f1f5-1f1f8	flags	+
ps	1f1f5-1f1f8	-	+
flag_pa	1f1f5-1f1e6	flags	+
pa	1f1f5-1f1e6	-	+
flag_pg	1f1f5-1f1ec	flags	+
pg	1f1f5-1f1ec	-	+
flag_py	1f1f5-1f1fe	flags	+
py	1f1f5-1f1fe	-	+
flag_pe	1f1f5-1f1ea	flags	+
pe	1f1f5-1f1ea	-	+
flag_ph	1f1f5-1f1ed	flags	+
ph	1f1f5-1f1ed	-	+
flag_pn	1f1f5-1f1f3	flags	+
pn	1f1f5-1f1f3	-	+
flag_pl	1f1f5-1f1f1	flags	+
pl	1f1f5-1f1f1	-	+
flag_pt	1f1f5-1f1f9	flags	+
pt	1f1f5-1f1f9	-	+
flag_pr	1f1f5-1f1f7	flags	+
pr	1f1f5-1f1f7	-	+
flag_qa	1f1f6-1f1e6	flags	+
qa	1f1f6-1f1e6	-	+
flag_re	1f1f7-1f1ea	flags	+
re	1f1f7-1f1ea	-	+
flag_ro	1f1f7-1f1f4	flags	+
ro	1f1f7-1f1f4	-	+
flag_ru	1f1f7-1f1fa	flags	+
ru	1f1f7-1f1fa	-	+
flag_rw	1f1f7-1f1fc	flags	+
rw	1f1f7-1f1fc	-	+
flag_ws	1f1fc-1f1f8	flags	+
ws	1f1fc-1f1f8	-	+
flag_sm	1f1f8-1f1f2	flags	+
sm	1f1f8-1f1f2	-	+
flag_st	1f1f8-1f1f9	flags	+
st	1f1f8-1f1f9	-	+
flag_sark	1f1e8-1f1f6	flags	-
flag_sa	1f1f8-1f1e6	flags	+
saudiarabia	1f1f8-1f1e6	-	+
saudi	1f1f8-1f1e6	-	+
flag_sn	1f1f8-1f1f3	flags	+
sn	1f1f8-1f1f3	-	+
flag_rs	1f1f7-1f1f8	flags	+
rs	1f1f7-1f1f8	-	+
flag_sc	1f1f8-1f1e8	flags	+
sc	1f1f8-1f1e8	-	+
flag_sl	1f1f8-1f1f1	flags	+
sl	1f1f8-1f1f1	-	+
flag_sg	1f1f8-1f1ec	flags	+
sg	1f1f8-1f1ec	-	+
flag_sx	1f1f8-1f1fd	flags	+
sx	1f1f8-1f1fd	-	+
flag_sk	1f1f8-1f1f0	flags	+
sk	1f1f8-1f1f0	-	+
flag_si	1f1f8-1f1ee	flags	+
si	1f1f8-1f1ee	-	+
flag_gs	1f1ec-1f1f8	flags	+
gs	1f1ec-1f1f8	-	+
flag_sb	1f1f8-1f1e7	flags	+
sb	1f1f8-1f1e7	-	+
flag_so	1f1f8-1f1f4	flags	+
so	1f1f8-1f1f4	-	+
flag_za	1f1ff-1f1e6	flags	+
za	1f1ff-1f1e6	-	+
flag_kr	1f1f0-1f1f7	flags	+
kr	1f1f0-1f1f7	-	+
flag_ss	1f1f8-1f1f8	flags	+
ss	1f1f8-1f1f8	-	+
flag_es	1f1ea-1f1f8	flags	+
es	1f1ea-1f1f8	-	+
flag_lk	1f1f1-1f1f0	flags	+
lk	1f1f1-1f1f0	-	+
flag_bl	1f1e7-1f1f1	flags	+
bl	1f1e7-1f1f1	-	+
flag_sh	1f1f8-1f1ed	flags	+
sh	1f1f8-1f1ed	-	+
flag_kn	1f1f0-1f1f3	flags	+
kn	1f1f0-1f1f3	-	+
flag_lc	1f1f1-1f1e8	flags	+
lc	1f1f1-1f1e8	-	+
flag_pm	1f1f5-1f1f2	flags	+
pm	1f1f5-1f1f2	-	+
flag_vc	1f1fb-1f1e8	flags	+
vc	1f1fb-1f1e8	-	+
flag_sd	1f1f8-1f1e9	flags	+
sd	1f1f8-1f1e9	-	+
flag_sr	1f1f8-1f1f7	flags	+
sr	1f1f8-1f1f7	-	+
flag_sz	1f1f8-1f1ff	flags	+
sz	1f1f8-1f1ff	-	+
flag_se	1f1f8-1f1ea	flags	+
se	1f1f8-1f1ea	-	+
flag_ch	1f1e8-1f1ed	flags	+
ch	1f1e8-1f1ed	-	+
flag_sy	1f1f8-1f1fe	flags	+
sy	1f1f8-1f1fe	-	+
flag_tw	1f1f9-1f1fc	flags	+
tw	1f1f9-1f1fc	-	+
flag_tj	1f1f9-1f1ef	flags	+
tj	1f1f9-1f1ef	-	+
flag_tz	1f1f9-1f1ff	flags	+
tz	1f1f9-1f1ff	-	+
flag_th	1f1f9-1f1ed	flags	+
th	1f1f9-1f1ed	-	+
flag_tl	1f1f9-1f1f1	flags	+
tl	1f1f9-1f1f1	-	+
flag_tg	1f1f9-1f1ec	flags	+
tg	1f1f9-1f1ec	-	+
flag_tk	1f1f9-1f1f0	flags	+
tk	1f1f9-1f1f0	-	+
flag_to	1f1f9-1f1f4	flags	+
to	1f1f9-1f1f4	-	+
flag_tt	1f1f9-1f1f9	flags	+
tt	1f1f9-1f1f9	-	+
flag_tn	1f1f9-1f1f3	flags	+
tn	1f1f9-1f1f3	-	+
flag_tr	1f1f9-1f1f7	flags	+
tr	1f1f9-1f1f7	-	+
flag_tm	1f1f9-1f1f2	flags	+
turkmenistan	1f1f9-1f1f2	-	+
flag_tc	1f1f9-1f1e8	flags	+
tc	1f1f9-1f1e8	-	+
flag_vi	1f1fb-1f1ee	flags	+
vi	1f1fb-1f1ee	-	+
flag_tv	1f1f9-1f1fb	flags	+
tuvalu	1f1f9-1f1fb	-	+
flag_ug	1f1fa-1f1ec	flags	+
ug	1f1fa-1f1ec	-	+
flag_ua	1f1fa-1f1e6	flags	+
ua	1f1fa-1f1e6	-	+
flag_ae	1f1e6-1f1ea	flags	+
ae	1f1e6-1f1ea	-	+
flag_gb	1f1ec-1f1e7	flags	+
gb	1f1ec-1f1e7	-	+
england	1f3f4-e0067-e0062-e0065-e006e-e0067-e007f	flags	+
scotland	1f3f4-e0067-e0062-e0073-e0063-e0074-e007f	flags	+
wales	1f3f4-e0067-e0062-e0077-e006c-e0073-e007f	flags	+
flag_us	1f1fa-1f1f8	flags	+
us	1f1fa-1f1f8	-	+
flag_uy	1f1fa-1f1fe	flags	+
uy	1f1fa-1f1fe	-	+
flag_uz	1f1fa-1f1ff	flags	+
uz	1f1fa-1f1ff	-	+
flag_vu	1f1fb-1f1fa	flags	+
vu	1f1fb-1f1fa	-	+
flag_va	1f1fb-1f1e6	flags	+
va	1f1fb-1f1e6	-	+
flag_ve	1f1fb-1f1ea	flags	+
ve	1f1fb-1f1ea	-	+
flag_vn	1f1fb-1f1f3	flags	+
vn	1f1fb-1f1f3	-	+
flag_wf	1f1fc-1f1eb	flags	+
wf	1f1fc-1f1eb	-	+
flag_eh	1f1ea-1f1ed	flags	+
eh	1f1ea-1f1ed	-	+
flag_ye	1f1fe-1f1ea	flags	+
ye	1f1fe-1f1ea	-	+
flag_zm	1f1ff-1f1f2	flags	+
zm	1f1ff-1f1f2	-	+
flag_zw	1f1ff-1f1fc	flags	+
zw	1f1ff-1f1fc	-	+
flag_ac	1f1e6-1f1e8	flags	+
ac	1f1e6-1f1e8	-	+
flag_bv	1f1e7-1f1fb	flags	+
bv	1f1e7-1f1fb	-	+
flag_cp	1f1e8-1f1f5	flags	+
cp	1f1e8-1f1f5	-	+
flag_ea	1f1ea-1f1e6	flags	+
ea	1f1ea-1f1e6	-	+
flag_dg	1f1e9-1f1ec	flags	+
dg	1f1e9-1f1ec	-	+
flag_hm	1f1ed-1f1f2	flags	+
hm	1f1ed-1f1f2	-	+
flag_mf	1f1f2-1f1eb	flags	+
mf	1f1f2-1f1eb	-	+
flag_sj	1f1f8-1f1ef	flags	+
sj	1f1f8-1f1ef	-	+
flag_ta	1f1f9-1f1e6	flags	+
ta	1f1f9-1f1e6	-	+
flag_um	1f1fa-1f1f2	flags	+
um	1f1fa-1f1f2	-	+
tone1	1f3fb	-	+
tone2	1f3fc	-	+
tone3	1f3fd	-	+
tone4	1f3fe	-	+
tone5	1f3ff	-	+
regional_indicator_z	1f1ff	-	+
regional_indicator_y	1f1fe	-	+
regional_indicator_x	1f1fd	-	+
regional_indicator_w	1f1fc	-	+
regional_indicator_v	1f1fb	-	+
regional_indicator_u	1f1fa	-	+
regional_indicator_t	1f1f9	-	+
regional_indicator_s	1f1f8	-	+
regional_indicator_r	1f1f7	-	+
regional_indicator_q	1f1f6	-	+
regional_indicator_p	1f1f5	-	+
regional_indicator_o	1f1f4	-	+
regional_indicator_n	1f1f3	-	+
regional_indicator_m	1f1f2	-	+
regional_indicator_l	1f1f1	-	+
regional_indicator_k	1f1f0	-	+
regional_indicator_j	1f1ef	-	+
regional_indicator_i	1f1ee	-	+
regional_indicator_h	1f1ed	-	+
regional_indicator_g	1f1ec	-	+
regional_indicator_f	1f1eb	-	+
regional_indicator_e	1f1ea	-	+
regional_indicator_d	1f1e9	-	+
regional_indicator_c	1f1e8	-	+
regional_indicator_b	1f1e7	-	+
regional_indicator_a	1f1e6	-	+
`,ie={100:`100`,1234:`1234`,"-1":`thumbsdown`,"-1_tone1":`thumbsdown_tone1`,"-1_tone2":`thumbsdown_tone2`,"-1_tone3":`thumbsdown_tone3`,"-1_tone4":`thumbsdown_tone4`,"-1_tone5":`thumbsdown_tone5`,"+1":`thumbsup`,"+1_tone1":`thumbsup_tone1`,"+1_tone2":`thumbsup_tone2`,"+1_tone3":`thumbsup_tone3`,"+1_tone4":`thumbsup_tone4`,"+1_tone5":`thumbsup_tone5`,"8ball":`8ball`,a:`a`,ab:`ab`,abacus:`abacus`,abc:`abc`,abcd:`abcd`,ac:`flag_ac`,accept:`accept`,accordion:`accordion`,ad:`flag_ad`,adhesive_bandage:`adhesive_bandage`,admission_tickets:`tickets`,adult:`adult`,adult_dark_skin_tone:`adult_tone5`,adult_light_skin_tone:`adult_tone1`,adult_medium_dark_skin_tone:`adult_tone4`,adult_medium_light_skin_tone:`adult_tone2`,adult_medium_skin_tone:`adult_tone3`,adult_tone1:`adult_tone1`,adult_tone2:`adult_tone2`,adult_tone3:`adult_tone3`,adult_tone4:`adult_tone4`,adult_tone5:`adult_tone5`,ae:`flag_ae`,aerial_tramway:`aerial_tramway`,af:`flag_af`,ag:`flag_ag`,ai:`flag_ai`,airplane:`airplane`,airplane_arriving:`airplane_arriving`,airplane_departure:`airplane_departure`,airplane_small:`airplane_small`,al:`flag_al`,alarm_clock:`alarm_clock`,alembic:`alembic`,alien:`alien`,alien_monster:`space_invader`,am:`flag_am`,ambulance:`ambulance`,amphora:`amphora`,anatomical_heart:`anatomical_heart`,anchor:`anchor`,angel:`angel`,angel_tone1:`angel_tone1`,angel_tone2:`angel_tone2`,angel_tone3:`angel_tone3`,angel_tone4:`angel_tone4`,angel_tone5:`angel_tone5`,anger:`anger`,anger_right:`anger_right`,angry:`angry`,angry_face:`angry`,anguished:`anguished`,ant:`ant`,antenna_bars:`signal_strength`,ao:`flag_ao`,apple:`apple`,aq:`flag_aq`,aquarius:`aquarius`,ar:`flag_ar`,archery:`bow_and_arrow`,aries:`aries`,arrow_backward:`arrow_backward`,arrow_double_down:`arrow_double_down`,arrow_double_up:`arrow_double_up`,arrow_down:`arrow_down`,arrow_down_small:`arrow_down_small`,arrow_forward:`arrow_forward`,arrow_heading_down:`arrow_heading_down`,arrow_heading_up:`arrow_heading_up`,arrow_left:`arrow_left`,arrow_lower_left:`arrow_lower_left`,arrow_lower_right:`arrow_lower_right`,arrow_right:`arrow_right`,arrow_right_hook:`arrow_right_hook`,arrow_up:`arrow_up`,arrow_up_down:`arrow_up_down`,arrow_up_small:`arrow_up_small`,arrow_upper_left:`arrow_upper_left`,arrow_upper_right:`arrow_upper_right`,arrows_clockwise:`arrows_clockwise`,arrows_counterclockwise:`arrows_counterclockwise`,art:`art`,articulated_lorry:`articulated_lorry`,artist:`artist`,artist_dark_skin_tone:`artist_tone5`,artist_light_skin_tone:`artist_tone1`,artist_medium_dark_skin_tone:`artist_tone4`,artist_medium_light_skin_tone:`artist_tone2`,artist_medium_skin_tone:`artist_tone3`,artist_tone1:`artist_tone1`,artist_tone2:`artist_tone2`,artist_tone3:`artist_tone3`,artist_tone4:`artist_tone4`,artist_tone5:`artist_tone5`,as:`flag_as`,asterisk:`asterisk`,asterisk_symbol:`asterisk_symbol`,astonished:`astonished`,astronaut:`astronaut`,astronaut_dark_skin_tone:`astronaut_tone5`,astronaut_light_skin_tone:`astronaut_tone1`,astronaut_medium_dark_skin_tone:`astronaut_tone4`,astronaut_medium_light_skin_tone:`astronaut_tone2`,astronaut_medium_skin_tone:`astronaut_tone3`,astronaut_tone1:`astronaut_tone1`,astronaut_tone2:`astronaut_tone2`,astronaut_tone3:`astronaut_tone3`,astronaut_tone4:`astronaut_tone4`,astronaut_tone5:`astronaut_tone5`,at:`flag_at`,athletic_shoe:`athletic_shoe`,atm:`atm`,atom:`atom`,atom_symbol:`atom`,au:`flag_au`,auto_rickshaw:`auto_rickshaw`,automobile:`red_car`,avocado:`avocado`,aw:`flag_aw`,ax:`flag_ax`,axe:`axe`,az:`flag_az`,b:`b`,ba:`flag_ba`,baby:`baby`,baby_angel:`angel`,baby_bottle:`baby_bottle`,baby_chick:`baby_chick`,baby_symbol:`baby_symbol`,baby_tone1:`baby_tone1`,baby_tone2:`baby_tone2`,baby_tone3:`baby_tone3`,baby_tone4:`baby_tone4`,baby_tone5:`baby_tone5`,back:`back`,back_arrow:`back`,back_of_hand:`raised_back_of_hand`,back_of_hand_tone1:`raised_back_of_hand_tone1`,back_of_hand_tone2:`raised_back_of_hand_tone2`,back_of_hand_tone3:`raised_back_of_hand_tone3`,back_of_hand_tone4:`raised_back_of_hand_tone4`,back_of_hand_tone5:`raised_back_of_hand_tone5`,backpack:`school_satchel`,bacon:`bacon`,badger:`badger`,badminton:`badminton`,bagel:`bagel`,baggage_claim:`baggage_claim`,baguette_bread:`french_bread`,balance_scale:`scales`,ballet_shoes:`ballet_shoes`,balloon:`balloon`,ballot_box:`ballot_box`,ballot_box_with_ballot:`ballot_box`,ballot_box_with_check:`ballot_box_with_check`,bamboo:`bamboo`,banana:`banana`,bangbang:`bangbang`,banjo:`banjo`,bank:`bank`,bar_chart:`bar_chart`,barber:`barber`,barber_pole:`barber`,baseball:`baseball`,basket:`basket`,basketball:`basketball`,basketball_player:`person_bouncing_ball`,basketball_player_tone1:`person_bouncing_ball_tone1`,basketball_player_tone2:`person_bouncing_ball_tone2`,basketball_player_tone3:`person_bouncing_ball_tone3`,basketball_player_tone4:`person_bouncing_ball_tone4`,basketball_player_tone5:`person_bouncing_ball_tone5`,bat:`bat`,bath:`bath`,bath_tone1:`bath_tone1`,bath_tone2:`bath_tone2`,bath_tone3:`bath_tone3`,bath_tone4:`bath_tone4`,bath_tone5:`bath_tone5`,bathtub:`bathtub`,battery:`battery`,bb:`flag_bb`,bd:`flag_bd`,be:`flag_be`,beach:`beach`,beach_umbrella:`beach_umbrella`,beach_with_umbrella:`beach`,beans:`beans`,bear:`bear`,bearded_person:`bearded_person`,bearded_person_dark_skin_tone:`bearded_person_tone5`,bearded_person_light_skin_tone:`bearded_person_tone1`,bearded_person_medium_dark_skin_tone:`bearded_person_tone4`,bearded_person_medium_light_skin_tone:`bearded_person_tone2`,bearded_person_medium_skin_tone:`bearded_person_tone3`,bearded_person_tone1:`bearded_person_tone1`,bearded_person_tone2:`bearded_person_tone2`,bearded_person_tone3:`bearded_person_tone3`,bearded_person_tone4:`bearded_person_tone4`,bearded_person_tone5:`bearded_person_tone5`,beating_heart:`heartbeat`,beaver:`beaver`,bed:`bed`,bee:`bee`,beer:`beer`,beer_mug:`beer`,beers:`beers`,beetle:`beetle`,beginner:`beginner`,bell:`bell`,bell_pepper:`bell_pepper`,bellhop:`bellhop`,bellhop_bell:`bellhop`,bento:`bento`,bento_box:`bento`,beverage_box:`beverage_box`,bf:`flag_bf`,bg:`flag_bg`,bh:`flag_bh`,bi:`flag_bi`,bicycle:`bike`,bicyclist:`person_biking`,bicyclist_tone1:`person_biking_tone1`,bicyclist_tone2:`person_biking_tone2`,bicyclist_tone3:`person_biking_tone3`,bicyclist_tone4:`person_biking_tone4`,bicyclist_tone5:`person_biking_tone5`,bike:`bike`,bikini:`bikini`,billed_cap:`billed_cap`,biohazard:`biohazard`,biohazard_sign:`biohazard`,bird:`bird`,birthday:`birthday`,birthday_cake:`birthday`,bison:`bison`,biting_lip:`biting_lip`,bj:`flag_bj`,bl:`flag_bl`,black_bird:`black_bird`,black_cat:`black_cat`,black_circle:`black_circle`,black_flag:`flag_black`,black_heart:`black_heart`,black_joker:`black_joker`,black_large_square:`black_large_square`,black_medium_small_square:`black_medium_small_square`,black_medium_square:`black_medium_square`,black_nib:`black_nib`,black_small_square:`black_small_square`,black_square_button:`black_square_button`,blond_haired_person:`blond_haired_person`,blond_haired_person_tone1:`blond_haired_person_tone1`,blond_haired_person_tone2:`blond_haired_person_tone2`,blond_haired_person_tone3:`blond_haired_person_tone3`,blond_haired_person_tone4:`blond_haired_person_tone4`,blond_haired_person_tone5:`blond_haired_person_tone5`,"blond-haired_man":`blond-haired_man`,"blond-haired_man_dark_skin_tone":`blond-haired_man_tone5`,"blond-haired_man_light_skin_tone":`blond-haired_man_tone1`,"blond-haired_man_medium_dark_skin_tone":`blond-haired_man_tone4`,"blond-haired_man_medium_light_skin_tone":`blond-haired_man_tone2`,"blond-haired_man_medium_skin_tone":`blond-haired_man_tone3`,"blond-haired_man_tone1":`blond-haired_man_tone1`,"blond-haired_man_tone2":`blond-haired_man_tone2`,"blond-haired_man_tone3":`blond-haired_man_tone3`,"blond-haired_man_tone4":`blond-haired_man_tone4`,"blond-haired_man_tone5":`blond-haired_man_tone5`,"blond-haired_woman":`blond-haired_woman`,"blond-haired_woman_dark_skin_tone":`blond-haired_woman_tone5`,"blond-haired_woman_light_skin_tone":`blond-haired_woman_tone1`,"blond-haired_woman_medium_dark_skin_tone":`blond-haired_woman_tone4`,"blond-haired_woman_medium_light_skin_tone":`blond-haired_woman_tone2`,"blond-haired_woman_medium_skin_tone":`blond-haired_woman_tone3`,"blond-haired_woman_tone1":`blond-haired_woman_tone1`,"blond-haired_woman_tone2":`blond-haired_woman_tone2`,"blond-haired_woman_tone3":`blond-haired_woman_tone3`,"blond-haired_woman_tone4":`blond-haired_woman_tone4`,"blond-haired_woman_tone5":`blond-haired_woman_tone5`,blossom:`blossom`,blowfish:`blowfish`,blue_book:`blue_book`,blue_car:`blue_car`,blue_circle:`blue_circle`,blue_heart:`blue_heart`,blue_square:`blue_square`,blueberries:`blueberries`,blush:`blush`,bm:`flag_bm`,bn:`flag_bn`,bo:`flag_bo`,boar:`boar`,bomb:`bomb`,bone:`bone`,book:`book`,bookmark:`bookmark`,bookmark_tabs:`bookmark_tabs`,books:`books`,boom:`boom`,boomerang:`boomerang`,boot:`boot`,bottle_with_popping_cork:`champagne`,bouquet:`bouquet`,bow:`person_bowing`,bow_and_arrow:`bow_and_arrow`,bow_tone1:`person_bowing_tone1`,bow_tone2:`person_bowing_tone2`,bow_tone3:`person_bowing_tone3`,bow_tone4:`person_bowing_tone4`,bow_tone5:`person_bowing_tone5`,bowl_with_spoon:`bowl_with_spoon`,bowling:`bowling`,boxing_glove:`boxing_glove`,boxing_gloves:`boxing_glove`,boy:`boy`,boy_tone1:`boy_tone1`,boy_tone2:`boy_tone2`,boy_tone3:`boy_tone3`,boy_tone4:`boy_tone4`,boy_tone5:`boy_tone5`,bq:`flag_bq`,br:`flag_br`,brain:`brain`,bread:`bread`,breast_feeding:`breast_feeding`,breast_feeding_dark_skin_tone:`breast_feeding_tone5`,breast_feeding_light_skin_tone:`breast_feeding_tone1`,breast_feeding_medium_dark_skin_tone:`breast_feeding_tone4`,breast_feeding_medium_light_skin_tone:`breast_feeding_tone2`,breast_feeding_medium_skin_tone:`breast_feeding_tone3`,breast_feeding_tone1:`breast_feeding_tone1`,breast_feeding_tone2:`breast_feeding_tone2`,breast_feeding_tone3:`breast_feeding_tone3`,breast_feeding_tone4:`breast_feeding_tone4`,breast_feeding_tone5:`breast_feeding_tone5`,brick:`bricks`,bricks:`bricks`,bridge_at_night:`bridge_at_night`,briefcase:`briefcase`,briefs:`briefs`,broccoli:`broccoli`,broken_chain:`broken_chain`,broken_heart:`broken_heart`,broom:`broom`,brown_circle:`brown_circle`,brown_heart:`brown_heart`,brown_mushroom:`brown_mushroom`,brown_square:`brown_square`,bs:`flag_bs`,bt:`flag_bt`,bubble_tea:`bubble_tea`,bubbles:`bubbles`,bucket:`bucket`,bug:`bug`,building_construction:`construction_site`,bulb:`bulb`,bullet_train:`bullettrain_front`,bullettrain_front:`bullettrain_front`,bullettrain_side:`bullettrain_side`,burrito:`burrito`,bus:`bus`,bus_stop:`busstop`,busstop:`busstop`,bust_in_silhouette:`bust_in_silhouette`,busts_in_silhouette:`busts_in_silhouette`,butter:`butter`,butterfly:`butterfly`,bv:`flag_bv`,bw:`flag_bw`,by:`flag_by`,bz:`flag_bz`,ca:`flag_ca`,cactus:`cactus`,cake:`cake`,calendar:`calendar`,calendar_spiral:`calendar_spiral`,call_me:`call_me`,call_me_hand:`call_me`,call_me_hand_tone1:`call_me_tone1`,call_me_hand_tone2:`call_me_tone2`,call_me_hand_tone3:`call_me_tone3`,call_me_hand_tone4:`call_me_tone4`,call_me_hand_tone5:`call_me_tone5`,call_me_tone1:`call_me_tone1`,call_me_tone2:`call_me_tone2`,call_me_tone3:`call_me_tone3`,call_me_tone4:`call_me_tone4`,call_me_tone5:`call_me_tone5`,calling:`calling`,camel:`camel`,camera:`camera`,camera_with_flash:`camera_with_flash`,camping:`camping`,cancer:`cancer`,candle:`candle`,candy:`candy`,canned_food:`canned_food`,canoe:`canoe`,capital_abcd:`capital_abcd`,capricorn:`capricorn`,card_box:`card_box`,card_file_box:`card_box`,card_index:`card_index`,card_index_dividers:`dividers`,carousel_horse:`carousel_horse`,carp_streamer:`flags`,carpentry_saw:`carpentry_saw`,carrot:`carrot`,cartwheel:`person_doing_cartwheel`,cartwheel_tone1:`person_doing_cartwheel_tone1`,cartwheel_tone2:`person_doing_cartwheel_tone2`,cartwheel_tone3:`person_doing_cartwheel_tone3`,cartwheel_tone4:`person_doing_cartwheel_tone4`,cartwheel_tone5:`person_doing_cartwheel_tone5`,castle:`european_castle`,cat:`cat`,cat_face:`cat`,cat2:`cat2`,cc:`flag_cc`,cd:`cd`,cf:`flag_cf`,cg:`flag_cg`,ch:`flag_ch`,chains:`chains`,chair:`chair`,champagne:`champagne`,champagne_glass:`champagne_glass`,chart:`chart`,chart_with_downwards_trend:`chart_with_downwards_trend`,chart_with_upwards_trend:`chart_with_upwards_trend`,check_mark:`heavy_check_mark`,checkered_flag:`checkered_flag`,cheese:`cheese`,cheese_wedge:`cheese`,cherries:`cherries`,cherry_blossom:`cherry_blossom`,chess_pawn:`chess_pawn`,chestnut:`chestnut`,chicken:`chicken`,child:`child`,child_dark_skin_tone:`child_tone5`,child_light_skin_tone:`child_tone1`,child_medium_dark_skin_tone:`child_tone4`,child_medium_light_skin_tone:`child_tone2`,child_medium_skin_tone:`child_tone3`,child_tone1:`child_tone1`,child_tone2:`child_tone2`,child_tone3:`child_tone3`,child_tone4:`child_tone4`,child_tone5:`child_tone5`,children_crossing:`children_crossing`,chile:`flag_cl`,chipmunk:`chipmunk`,chocolate_bar:`chocolate_bar`,chopsticks:`chopsticks`,christmas_tree:`christmas_tree`,church:`church`,ci:`flag_ci`,cigarette:`smoking`,cinema:`cinema`,circled_m:`m`,circus_tent:`circus_tent`,city_dusk:`city_dusk`,city_sunrise:`city_sunset`,city_sunset:`city_sunset`,cityscape:`cityscape`,ck:`flag_ck`,cl:`cl`,clamp:`compression`,clap:`clap`,clap_tone1:`clap_tone1`,clap_tone2:`clap_tone2`,clap_tone3:`clap_tone3`,clap_tone4:`clap_tone4`,clap_tone5:`clap_tone5`,clapper:`clapper`,clapper_board:`clapper`,classical_building:`classical_building`,clinking_glass:`champagne_glass`,clipboard:`clipboard`,clock:`clock`,clock1:`clock1`,clock10:`clock10`,clock1030:`clock1030`,clock11:`clock11`,clock1130:`clock1130`,clock12:`clock12`,clock1230:`clock1230`,clock130:`clock130`,clock2:`clock2`,clock230:`clock230`,clock3:`clock3`,clock330:`clock330`,clock4:`clock4`,clock430:`clock430`,clock5:`clock5`,clock530:`clock530`,clock6:`clock6`,clock630:`clock630`,clock7:`clock7`,clock730:`clock730`,clock8:`clock8`,clock830:`clock830`,clock9:`clock9`,clock930:`clock930`,closed_book:`closed_book`,closed_lock_with_key:`closed_lock_with_key`,closed_umbrella:`closed_umbrella`,cloud:`cloud`,cloud_lightning:`cloud_lightning`,cloud_rain:`cloud_rain`,cloud_snow:`cloud_snow`,cloud_tornado:`cloud_tornado`,cloud_with_lightning:`cloud_lightning`,cloud_with_rain:`cloud_rain`,cloud_with_snow:`cloud_snow`,cloud_with_tornado:`cloud_tornado`,clown:`clown`,clown_face:`clown`,club_suit:`clubs`,clubs:`clubs`,clutch_bag:`pouch`,cm:`flag_cm`,cn:`flag_cn`,co:`flag_co`,coat:`coat`,cockroach:`cockroach`,cocktail:`cocktail`,coconut:`coconut`,coffee:`coffee`,coffin:`coffin`,coin:`coin`,cold_face:`cold_face`,cold_sweat:`cold_sweat`,collision:`boom`,comet:`comet`,compass:`compass`,compression:`compression`,computer:`computer`,computer_disk:`minidisc`,confetti_ball:`confetti_ball`,confounded:`confounded`,confused:`confused`,confused_face:`confused`,congo:`flag_cd`,congratulations:`congratulations`,construction:`construction`,construction_site:`construction_site`,construction_worker:`construction_worker`,construction_worker_tone1:`construction_worker_tone1`,construction_worker_tone2:`construction_worker_tone2`,construction_worker_tone3:`construction_worker_tone3`,construction_worker_tone4:`construction_worker_tone4`,construction_worker_tone5:`construction_worker_tone5`,control_knobs:`control_knobs`,convenience_store:`convenience_store`,cook:`cook`,cook_dark_skin_tone:`cook_tone5`,cook_light_skin_tone:`cook_tone1`,cook_medium_dark_skin_tone:`cook_tone4`,cook_medium_light_skin_tone:`cook_tone2`,cook_medium_skin_tone:`cook_tone3`,cook_tone1:`cook_tone1`,cook_tone2:`cook_tone2`,cook_tone3:`cook_tone3`,cook_tone4:`cook_tone4`,cook_tone5:`cook_tone5`,cooked_rice:`rice`,cookie:`cookie`,cooking:`cooking`,cool:`cool`,cop:`police_officer`,cop_tone1:`police_officer_tone1`,cop_tone2:`police_officer_tone2`,cop_tone3:`police_officer_tone3`,cop_tone4:`police_officer_tone4`,cop_tone5:`police_officer_tone5`,copyright:`copyright`,coral:`coral`,corn:`corn`,couch:`couch`,couch_and_lamp:`couch`,couple:`couple`,couple_mm:`couple_mm`,couple_with_heart:`couple_with_heart`,couple_with_heart_dark_skin_tone:`couple_with_heart_tone5`,couple_with_heart_light_skin_tone:`couple_with_heart_tone1`,couple_with_heart_man_man_dark_skin_tone:`couple_with_heart_man_man_tone5`,couple_with_heart_man_man_dark_skin_tone_light_skin_tone:`couple_with_heart_man_man_tone5_tone1`,couple_with_heart_man_man_dark_skin_tone_medium_dark_skin_tone:`couple_with_heart_man_man_tone5_tone4`,couple_with_heart_man_man_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_man_man_tone5_tone2`,couple_with_heart_man_man_dark_skin_tone_medium_skin_tone:`couple_with_heart_man_man_tone5_tone3`,couple_with_heart_man_man_light_skin_tone:`couple_with_heart_man_man_tone1`,couple_with_heart_man_man_light_skin_tone_dark_skin_tone:`couple_with_heart_man_man_tone1_tone5`,couple_with_heart_man_man_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_man_man_tone1_tone4`,couple_with_heart_man_man_light_skin_tone_medium_light_skin_tone:`couple_with_heart_man_man_tone1_tone2`,couple_with_heart_man_man_light_skin_tone_medium_skin_tone:`couple_with_heart_man_man_tone1_tone3`,couple_with_heart_man_man_medium_dark_skin_tone:`couple_with_heart_man_man_tone4`,couple_with_heart_man_man_medium_dark_skin_tone_dark_skin_tone:`couple_with_heart_man_man_tone4_tone5`,couple_with_heart_man_man_medium_dark_skin_tone_light_skin_tone:`couple_with_heart_man_man_tone4_tone1`,couple_with_heart_man_man_medium_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_man_man_tone4_tone2`,couple_with_heart_man_man_medium_dark_skin_tone_medium_skin_tone:`couple_with_heart_man_man_tone4_tone3`,couple_with_heart_man_man_medium_light_skin_tone:`couple_with_heart_man_man_tone2`,couple_with_heart_man_man_medium_light_skin_tone_dark_skin_tone:`couple_with_heart_man_man_tone2_tone5`,couple_with_heart_man_man_medium_light_skin_tone_light_skin_tone:`couple_with_heart_man_man_tone2_tone1`,couple_with_heart_man_man_medium_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_man_man_tone2_tone4`,couple_with_heart_man_man_medium_light_skin_tone_medium_skin_tone:`couple_with_heart_man_man_tone2_tone3`,couple_with_heart_man_man_medium_skin_tone:`couple_with_heart_man_man_tone3`,couple_with_heart_man_man_medium_skin_tone_dark_skin_tone:`couple_with_heart_man_man_tone3_tone5`,couple_with_heart_man_man_medium_skin_tone_light_skin_tone:`couple_with_heart_man_man_tone3_tone1`,couple_with_heart_man_man_medium_skin_tone_medium_dark_skin_tone:`couple_with_heart_man_man_tone3_tone4`,couple_with_heart_man_man_medium_skin_tone_medium_light_skin_tone:`couple_with_heart_man_man_tone3_tone2`,couple_with_heart_man_man_tone1:`couple_with_heart_man_man_tone1`,couple_with_heart_man_man_tone1_tone2:`couple_with_heart_man_man_tone1_tone2`,couple_with_heart_man_man_tone1_tone3:`couple_with_heart_man_man_tone1_tone3`,couple_with_heart_man_man_tone1_tone4:`couple_with_heart_man_man_tone1_tone4`,couple_with_heart_man_man_tone1_tone5:`couple_with_heart_man_man_tone1_tone5`,couple_with_heart_man_man_tone2:`couple_with_heart_man_man_tone2`,couple_with_heart_man_man_tone2_tone1:`couple_with_heart_man_man_tone2_tone1`,couple_with_heart_man_man_tone2_tone3:`couple_with_heart_man_man_tone2_tone3`,couple_with_heart_man_man_tone2_tone4:`couple_with_heart_man_man_tone2_tone4`,couple_with_heart_man_man_tone2_tone5:`couple_with_heart_man_man_tone2_tone5`,couple_with_heart_man_man_tone3:`couple_with_heart_man_man_tone3`,couple_with_heart_man_man_tone3_tone1:`couple_with_heart_man_man_tone3_tone1`,couple_with_heart_man_man_tone3_tone2:`couple_with_heart_man_man_tone3_tone2`,couple_with_heart_man_man_tone3_tone4:`couple_with_heart_man_man_tone3_tone4`,couple_with_heart_man_man_tone3_tone5:`couple_with_heart_man_man_tone3_tone5`,couple_with_heart_man_man_tone4:`couple_with_heart_man_man_tone4`,couple_with_heart_man_man_tone4_tone1:`couple_with_heart_man_man_tone4_tone1`,couple_with_heart_man_man_tone4_tone2:`couple_with_heart_man_man_tone4_tone2`,couple_with_heart_man_man_tone4_tone3:`couple_with_heart_man_man_tone4_tone3`,couple_with_heart_man_man_tone4_tone5:`couple_with_heart_man_man_tone4_tone5`,couple_with_heart_man_man_tone5:`couple_with_heart_man_man_tone5`,couple_with_heart_man_man_tone5_tone1:`couple_with_heart_man_man_tone5_tone1`,couple_with_heart_man_man_tone5_tone2:`couple_with_heart_man_man_tone5_tone2`,couple_with_heart_man_man_tone5_tone3:`couple_with_heart_man_man_tone5_tone3`,couple_with_heart_man_man_tone5_tone4:`couple_with_heart_man_man_tone5_tone4`,couple_with_heart_medium_dark_skin_tone:`couple_with_heart_tone4`,couple_with_heart_medium_light_skin_tone:`couple_with_heart_tone2`,couple_with_heart_medium_skin_tone:`couple_with_heart_tone3`,couple_with_heart_mm:`couple_mm`,couple_with_heart_person_person_dark_skin_tone_light_skin_tone:`couple_with_heart_person_person_tone5_tone1`,couple_with_heart_person_person_dark_skin_tone_medium_dark_skin_tone:`couple_with_heart_person_person_tone5_tone4`,couple_with_heart_person_person_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_person_person_tone5_tone2`,couple_with_heart_person_person_dark_skin_tone_medium_skin_tone:`couple_with_heart_person_person_tone5_tone3`,couple_with_heart_person_person_light_skin_tone_dark_skin_tone:`couple_with_heart_person_person_tone1_tone5`,couple_with_heart_person_person_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_person_person_tone1_tone4`,couple_with_heart_person_person_light_skin_tone_medium_light_skin_tone:`couple_with_heart_person_person_tone1_tone2`,couple_with_heart_person_person_light_skin_tone_medium_skin_tone:`couple_with_heart_person_person_tone1_tone3`,couple_with_heart_person_person_medium_dark_skin_tone_dark_skin_tone:`couple_with_heart_person_person_tone4_tone5`,couple_with_heart_person_person_medium_dark_skin_tone_light_skin_tone:`couple_with_heart_person_person_tone4_tone1`,couple_with_heart_person_person_medium_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_person_person_tone4_tone2`,couple_with_heart_person_person_medium_dark_skin_tone_medium_skin_tone:`couple_with_heart_person_person_tone4_tone3`,couple_with_heart_person_person_medium_light_skin_tone_dark_skin_tone:`couple_with_heart_person_person_tone2_tone5`,couple_with_heart_person_person_medium_light_skin_tone_light_skin_tone:`couple_with_heart_person_person_tone2_tone1`,couple_with_heart_person_person_medium_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_person_person_tone2_tone4`,couple_with_heart_person_person_medium_light_skin_tone_medium_skin_tone:`couple_with_heart_person_person_tone2_tone3`,couple_with_heart_person_person_medium_skin_tone_dark_skin_tone:`couple_with_heart_person_person_tone3_tone5`,couple_with_heart_person_person_medium_skin_tone_light_skin_tone:`couple_with_heart_person_person_tone3_tone1`,couple_with_heart_person_person_medium_skin_tone_medium_dark_skin_tone:`couple_with_heart_person_person_tone3_tone4`,couple_with_heart_person_person_medium_skin_tone_medium_light_skin_tone:`couple_with_heart_person_person_tone3_tone2`,couple_with_heart_person_person_tone1_tone2:`couple_with_heart_person_person_tone1_tone2`,couple_with_heart_person_person_tone1_tone3:`couple_with_heart_person_person_tone1_tone3`,couple_with_heart_person_person_tone1_tone4:`couple_with_heart_person_person_tone1_tone4`,couple_with_heart_person_person_tone1_tone5:`couple_with_heart_person_person_tone1_tone5`,couple_with_heart_person_person_tone2_tone1:`couple_with_heart_person_person_tone2_tone1`,couple_with_heart_person_person_tone2_tone3:`couple_with_heart_person_person_tone2_tone3`,couple_with_heart_person_person_tone2_tone4:`couple_with_heart_person_person_tone2_tone4`,couple_with_heart_person_person_tone2_tone5:`couple_with_heart_person_person_tone2_tone5`,couple_with_heart_person_person_tone3_tone1:`couple_with_heart_person_person_tone3_tone1`,couple_with_heart_person_person_tone3_tone2:`couple_with_heart_person_person_tone3_tone2`,couple_with_heart_person_person_tone3_tone4:`couple_with_heart_person_person_tone3_tone4`,couple_with_heart_person_person_tone3_tone5:`couple_with_heart_person_person_tone3_tone5`,couple_with_heart_person_person_tone4_tone1:`couple_with_heart_person_person_tone4_tone1`,couple_with_heart_person_person_tone4_tone2:`couple_with_heart_person_person_tone4_tone2`,couple_with_heart_person_person_tone4_tone3:`couple_with_heart_person_person_tone4_tone3`,couple_with_heart_person_person_tone4_tone5:`couple_with_heart_person_person_tone4_tone5`,couple_with_heart_person_person_tone5_tone1:`couple_with_heart_person_person_tone5_tone1`,couple_with_heart_person_person_tone5_tone2:`couple_with_heart_person_person_tone5_tone2`,couple_with_heart_person_person_tone5_tone3:`couple_with_heart_person_person_tone5_tone3`,couple_with_heart_person_person_tone5_tone4:`couple_with_heart_person_person_tone5_tone4`,couple_with_heart_tone1:`couple_with_heart_tone1`,couple_with_heart_tone2:`couple_with_heart_tone2`,couple_with_heart_tone3:`couple_with_heart_tone3`,couple_with_heart_tone4:`couple_with_heart_tone4`,couple_with_heart_tone5:`couple_with_heart_tone5`,couple_with_heart_woman_man:`couple_with_heart_woman_man`,couple_with_heart_woman_man_dark_skin_tone:`couple_with_heart_woman_man_tone5`,couple_with_heart_woman_man_dark_skin_tone_light_skin_tone:`couple_with_heart_woman_man_tone5_tone1`,couple_with_heart_woman_man_dark_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_man_tone5_tone4`,couple_with_heart_woman_man_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_man_tone5_tone2`,couple_with_heart_woman_man_dark_skin_tone_medium_skin_tone:`couple_with_heart_woman_man_tone5_tone3`,couple_with_heart_woman_man_light_skin_tone:`couple_with_heart_woman_man_tone1`,couple_with_heart_woman_man_light_skin_tone_dark_skin_tone:`couple_with_heart_woman_man_tone1_tone5`,couple_with_heart_woman_man_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_man_tone1_tone4`,couple_with_heart_woman_man_light_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_man_tone1_tone2`,couple_with_heart_woman_man_light_skin_tone_medium_skin_tone:`couple_with_heart_woman_man_tone1_tone3`,couple_with_heart_woman_man_medium_dark_skin_tone:`couple_with_heart_woman_man_tone4`,couple_with_heart_woman_man_medium_dark_skin_tone_dark_skin_tone:`couple_with_heart_woman_man_tone4_tone5`,couple_with_heart_woman_man_medium_dark_skin_tone_light_skin_tone:`couple_with_heart_woman_man_tone4_tone1`,couple_with_heart_woman_man_medium_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_man_tone4_tone2`,couple_with_heart_woman_man_medium_dark_skin_tone_medium_skin_tone:`couple_with_heart_woman_man_tone4_tone3`,couple_with_heart_woman_man_medium_light_skin_tone:`couple_with_heart_woman_man_tone2`,couple_with_heart_woman_man_medium_light_skin_tone_dark_skin_tone:`couple_with_heart_woman_man_tone2_tone5`,couple_with_heart_woman_man_medium_light_skin_tone_light_skin_tone:`couple_with_heart_woman_man_tone2_tone1`,couple_with_heart_woman_man_medium_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_man_tone2_tone4`,couple_with_heart_woman_man_medium_light_skin_tone_medium_skin_tone:`couple_with_heart_woman_man_tone2_tone3`,couple_with_heart_woman_man_medium_skin_tone:`couple_with_heart_woman_man_tone3`,couple_with_heart_woman_man_medium_skin_tone_dark_skin_tone:`couple_with_heart_woman_man_tone3_tone5`,couple_with_heart_woman_man_medium_skin_tone_light_skin_tone:`couple_with_heart_woman_man_tone3_tone1`,couple_with_heart_woman_man_medium_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_man_tone3_tone4`,couple_with_heart_woman_man_medium_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_man_tone3_tone2`,couple_with_heart_woman_man_tone1:`couple_with_heart_woman_man_tone1`,couple_with_heart_woman_man_tone1_tone2:`couple_with_heart_woman_man_tone1_tone2`,couple_with_heart_woman_man_tone1_tone3:`couple_with_heart_woman_man_tone1_tone3`,couple_with_heart_woman_man_tone1_tone4:`couple_with_heart_woman_man_tone1_tone4`,couple_with_heart_woman_man_tone1_tone5:`couple_with_heart_woman_man_tone1_tone5`,couple_with_heart_woman_man_tone2:`couple_with_heart_woman_man_tone2`,couple_with_heart_woman_man_tone2_tone1:`couple_with_heart_woman_man_tone2_tone1`,couple_with_heart_woman_man_tone2_tone3:`couple_with_heart_woman_man_tone2_tone3`,couple_with_heart_woman_man_tone2_tone4:`couple_with_heart_woman_man_tone2_tone4`,couple_with_heart_woman_man_tone2_tone5:`couple_with_heart_woman_man_tone2_tone5`,couple_with_heart_woman_man_tone3:`couple_with_heart_woman_man_tone3`,couple_with_heart_woman_man_tone3_tone1:`couple_with_heart_woman_man_tone3_tone1`,couple_with_heart_woman_man_tone3_tone2:`couple_with_heart_woman_man_tone3_tone2`,couple_with_heart_woman_man_tone3_tone4:`couple_with_heart_woman_man_tone3_tone4`,couple_with_heart_woman_man_tone3_tone5:`couple_with_heart_woman_man_tone3_tone5`,couple_with_heart_woman_man_tone4:`couple_with_heart_woman_man_tone4`,couple_with_heart_woman_man_tone4_tone1:`couple_with_heart_woman_man_tone4_tone1`,couple_with_heart_woman_man_tone4_tone2:`couple_with_heart_woman_man_tone4_tone2`,couple_with_heart_woman_man_tone4_tone3:`couple_with_heart_woman_man_tone4_tone3`,couple_with_heart_woman_man_tone4_tone5:`couple_with_heart_woman_man_tone4_tone5`,couple_with_heart_woman_man_tone5:`couple_with_heart_woman_man_tone5`,couple_with_heart_woman_man_tone5_tone1:`couple_with_heart_woman_man_tone5_tone1`,couple_with_heart_woman_man_tone5_tone2:`couple_with_heart_woman_man_tone5_tone2`,couple_with_heart_woman_man_tone5_tone3:`couple_with_heart_woman_man_tone5_tone3`,couple_with_heart_woman_man_tone5_tone4:`couple_with_heart_woman_man_tone5_tone4`,couple_with_heart_woman_woman_dark_skin_tone:`couple_with_heart_woman_woman_tone5`,couple_with_heart_woman_woman_dark_skin_tone_light_skin_tone:`couple_with_heart_woman_woman_tone5_tone1`,couple_with_heart_woman_woman_dark_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_woman_tone5_tone4`,couple_with_heart_woman_woman_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_woman_tone5_tone2`,couple_with_heart_woman_woman_dark_skin_tone_medium_skin_tone:`couple_with_heart_woman_woman_tone5_tone3`,couple_with_heart_woman_woman_light_skin_tone:`couple_with_heart_woman_woman_tone1`,couple_with_heart_woman_woman_light_skin_tone_dark_skin_tone:`couple_with_heart_woman_woman_tone1_tone5`,couple_with_heart_woman_woman_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_woman_tone1_tone4`,couple_with_heart_woman_woman_light_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_woman_tone1_tone2`,couple_with_heart_woman_woman_light_skin_tone_medium_skin_tone:`couple_with_heart_woman_woman_tone1_tone3`,couple_with_heart_woman_woman_medium_dark_skin_tone:`couple_with_heart_woman_woman_tone4`,couple_with_heart_woman_woman_medium_dark_skin_tone_dark_skin_tone:`couple_with_heart_woman_woman_tone4_tone5`,couple_with_heart_woman_woman_medium_dark_skin_tone_light_skin_tone:`couple_with_heart_woman_woman_tone4_tone1`,couple_with_heart_woman_woman_medium_dark_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_woman_tone4_tone2`,couple_with_heart_woman_woman_medium_dark_skin_tone_medium_skin_tone:`couple_with_heart_woman_woman_tone4_tone3`,couple_with_heart_woman_woman_medium_light_skin_tone:`couple_with_heart_woman_woman_tone2`,couple_with_heart_woman_woman_medium_light_skin_tone_dark_skin_tone:`couple_with_heart_woman_woman_tone2_tone5`,couple_with_heart_woman_woman_medium_light_skin_tone_light_skin_tone:`couple_with_heart_woman_woman_tone2_tone1`,couple_with_heart_woman_woman_medium_light_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_woman_tone2_tone4`,couple_with_heart_woman_woman_medium_light_skin_tone_medium_skin_tone:`couple_with_heart_woman_woman_tone2_tone3`,couple_with_heart_woman_woman_medium_skin_tone:`couple_with_heart_woman_woman_tone3`,couple_with_heart_woman_woman_medium_skin_tone_dark_skin_tone:`couple_with_heart_woman_woman_tone3_tone5`,couple_with_heart_woman_woman_medium_skin_tone_light_skin_tone:`couple_with_heart_woman_woman_tone3_tone1`,couple_with_heart_woman_woman_medium_skin_tone_medium_dark_skin_tone:`couple_with_heart_woman_woman_tone3_tone4`,couple_with_heart_woman_woman_medium_skin_tone_medium_light_skin_tone:`couple_with_heart_woman_woman_tone3_tone2`,couple_with_heart_woman_woman_tone1:`couple_with_heart_woman_woman_tone1`,couple_with_heart_woman_woman_tone1_tone2:`couple_with_heart_woman_woman_tone1_tone2`,couple_with_heart_woman_woman_tone1_tone3:`couple_with_heart_woman_woman_tone1_tone3`,couple_with_heart_woman_woman_tone1_tone4:`couple_with_heart_woman_woman_tone1_tone4`,couple_with_heart_woman_woman_tone1_tone5:`couple_with_heart_woman_woman_tone1_tone5`,couple_with_heart_woman_woman_tone2:`couple_with_heart_woman_woman_tone2`,couple_with_heart_woman_woman_tone2_tone1:`couple_with_heart_woman_woman_tone2_tone1`,couple_with_heart_woman_woman_tone2_tone3:`couple_with_heart_woman_woman_tone2_tone3`,couple_with_heart_woman_woman_tone2_tone4:`couple_with_heart_woman_woman_tone2_tone4`,couple_with_heart_woman_woman_tone2_tone5:`couple_with_heart_woman_woman_tone2_tone5`,couple_with_heart_woman_woman_tone3:`couple_with_heart_woman_woman_tone3`,couple_with_heart_woman_woman_tone3_tone1:`couple_with_heart_woman_woman_tone3_tone1`,couple_with_heart_woman_woman_tone3_tone2:`couple_with_heart_woman_woman_tone3_tone2`,couple_with_heart_woman_woman_tone3_tone4:`couple_with_heart_woman_woman_tone3_tone4`,couple_with_heart_woman_woman_tone3_tone5:`couple_with_heart_woman_woman_tone3_tone5`,couple_with_heart_woman_woman_tone4:`couple_with_heart_woman_woman_tone4`,couple_with_heart_woman_woman_tone4_tone1:`couple_with_heart_woman_woman_tone4_tone1`,couple_with_heart_woman_woman_tone4_tone2:`couple_with_heart_woman_woman_tone4_tone2`,couple_with_heart_woman_woman_tone4_tone3:`couple_with_heart_woman_woman_tone4_tone3`,couple_with_heart_woman_woman_tone4_tone5:`couple_with_heart_woman_woman_tone4_tone5`,couple_with_heart_woman_woman_tone5:`couple_with_heart_woman_woman_tone5`,couple_with_heart_woman_woman_tone5_tone1:`couple_with_heart_woman_woman_tone5_tone1`,couple_with_heart_woman_woman_tone5_tone2:`couple_with_heart_woman_woman_tone5_tone2`,couple_with_heart_woman_woman_tone5_tone3:`couple_with_heart_woman_woman_tone5_tone3`,couple_with_heart_woman_woman_tone5_tone4:`couple_with_heart_woman_woman_tone5_tone4`,couple_with_heart_ww:`couple_ww`,couple_ww:`couple_ww`,couplekiss:`couplekiss`,couplekiss_mm:`kiss_mm`,couplekiss_ww:`kiss_ww`,cow:`cow`,cow_face:`cow`,cow2:`cow2`,cowboy:`cowboy`,cp:`flag_cp`,cr:`flag_cr`,crab:`crab`,crayon:`crayon`,credit_card:`credit_card`,crescent_moon:`crescent_moon`,cricket:`cricket`,cricket_bat_ball:`cricket_game`,cricket_game:`cricket_game`,crocodile:`crocodile`,croissant:`croissant`,cross:`cross`,cross_mark:`x`,crossed_flags:`crossed_flags`,crossed_swords:`crossed_swords`,crown:`crown`,cruise_ship:`cruise_ship`,crutch:`crutch`,cry:`cry`,crying_cat:`crying_cat_face`,crying_cat_face:`crying_cat_face`,crying_face:`cry`,crystal_ball:`crystal_ball`,cu:`flag_cu`,cucumber:`cucumber`,cup_with_straw:`cup_with_straw`,cupcake:`cupcake`,cupid:`cupid`,curling_stone:`curling_stone`,curly_loop:`curly_loop`,currency_exchange:`currency_exchange`,curry:`curry`,curry_rice:`curry`,custard:`custard`,customs:`customs`,cut_of_meat:`cut_of_meat`,cv:`flag_cv`,cw:`flag_cw`,cx:`flag_cx`,cy:`flag_cy`,cyclone:`cyclone`,cz:`flag_cz`,dagger:`dagger`,dagger_knife:`dagger`,dancer:`dancer`,dancer_tone1:`dancer_tone1`,dancer_tone2:`dancer_tone2`,dancer_tone3:`dancer_tone3`,dancer_tone4:`dancer_tone4`,dancer_tone5:`dancer_tone5`,dancers:`people_with_bunny_ears_partying`,dango:`dango`,dark_sunglasses:`dark_sunglasses`,dart:`dart`,dash:`dash`,dashing_away:`dash`,date:`date`,de:`flag_de`,deaf_man:`deaf_man`,deaf_man_dark_skin_tone:`deaf_man_tone5`,deaf_man_light_skin_tone:`deaf_man_tone1`,deaf_man_medium_dark_skin_tone:`deaf_man_tone4`,deaf_man_medium_light_skin_tone:`deaf_man_tone2`,deaf_man_medium_skin_tone:`deaf_man_tone3`,deaf_man_tone1:`deaf_man_tone1`,deaf_man_tone2:`deaf_man_tone2`,deaf_man_tone3:`deaf_man_tone3`,deaf_man_tone4:`deaf_man_tone4`,deaf_man_tone5:`deaf_man_tone5`,deaf_person:`deaf_person`,deaf_person_dark_skin_tone:`deaf_person_tone5`,deaf_person_light_skin_tone:`deaf_person_tone1`,deaf_person_medium_dark_skin_tone:`deaf_person_tone4`,deaf_person_medium_light_skin_tone:`deaf_person_tone2`,deaf_person_medium_skin_tone:`deaf_person_tone3`,deaf_person_tone1:`deaf_person_tone1`,deaf_person_tone2:`deaf_person_tone2`,deaf_person_tone3:`deaf_person_tone3`,deaf_person_tone4:`deaf_person_tone4`,deaf_person_tone5:`deaf_person_tone5`,deaf_woman:`deaf_woman`,deaf_woman_dark_skin_tone:`deaf_woman_tone5`,deaf_woman_light_skin_tone:`deaf_woman_tone1`,deaf_woman_medium_dark_skin_tone:`deaf_woman_tone4`,deaf_woman_medium_light_skin_tone:`deaf_woman_tone2`,deaf_woman_medium_skin_tone:`deaf_woman_tone3`,deaf_woman_tone1:`deaf_woman_tone1`,deaf_woman_tone2:`deaf_woman_tone2`,deaf_woman_tone3:`deaf_woman_tone3`,deaf_woman_tone4:`deaf_woman_tone4`,deaf_woman_tone5:`deaf_woman_tone5`,deciduous_tree:`deciduous_tree`,deer:`deer`,department_store:`department_store`,derelict_house_building:`house_abandoned`,desert:`desert`,desert_island:`island`,desktop:`desktop`,desktop_computer:`desktop`,detective:`detective`,detective_tone1:`detective_tone1`,detective_tone2:`detective_tone2`,detective_tone3:`detective_tone3`,detective_tone4:`detective_tone4`,detective_tone5:`detective_tone5`,dg:`flag_dg`,diamond_shape_with_a_dot_inside:`diamond_shape_with_a_dot_inside`,diamond_suit:`diamonds`,diamonds:`diamonds`,digit_eight:`digit_eight`,digit_five:`digit_five`,digit_four:`digit_four`,digit_nine:`digit_nine`,digit_one:`digit_one`,digit_seven:`digit_seven`,digit_six:`digit_six`,digit_three:`digit_three`,digit_two:`digit_two`,digit_zero:`digit_zero`,direct_hit:`dart`,disappointed:`disappointed`,disappointed_relieved:`disappointed_relieved`,disguised_face:`disguised_face`,dividers:`dividers`,diving_mask:`diving_mask`,diya_lamp:`diya_lamp`,dizzy:`dizzy`,dizzy_face:`dizzy_face`,dj:`flag_dj`,dk:`flag_dk`,dm:`flag_dm`,dna:`dna`,do:`flag_do`,do_not_litter:`do_not_litter`,dodo:`dodo`,dog:`dog`,dog_face:`dog`,dog2:`dog2`,dollar:`dollar`,dolls:`dolls`,dolphin:`dolphin`,donkey:`donkey`,door:`door`,dotted_line_face:`dotted_line_face`,double_vertical_bar:`pause_button`,doughnut:`doughnut`,dove:`dove`,dove_of_peace:`dove`,down_arrow:`arrow_down`,dragon:`dragon`,dragon_face:`dragon_face`,dress:`dress`,dromedary_camel:`dromedary_camel`,drool:`drooling_face`,drooling_face:`drooling_face`,drop_of_blood:`drop_of_blood`,droplet:`droplet`,drum:`drum`,drum_with_drumsticks:`drum`,duck:`duck`,dumpling:`dumpling`,dvd:`dvd`,dz:`flag_dz`,e_mail:`e-mail`,"e-mail":`e-mail`,ea:`flag_ea`,eagle:`eagle`,ear:`ear`,ear_of_corn:`corn`,ear_of_rice:`ear_of_rice`,ear_tone1:`ear_tone1`,ear_tone2:`ear_tone2`,ear_tone3:`ear_tone3`,ear_tone4:`ear_tone4`,ear_tone5:`ear_tone5`,ear_with_hearing_aid:`ear_with_hearing_aid`,ear_with_hearing_aid_dark_skin_tone:`ear_with_hearing_aid_tone5`,ear_with_hearing_aid_light_skin_tone:`ear_with_hearing_aid_tone1`,ear_with_hearing_aid_medium_dark_skin_tone:`ear_with_hearing_aid_tone4`,ear_with_hearing_aid_medium_light_skin_tone:`ear_with_hearing_aid_tone2`,ear_with_hearing_aid_medium_skin_tone:`ear_with_hearing_aid_tone3`,ear_with_hearing_aid_tone1:`ear_with_hearing_aid_tone1`,ear_with_hearing_aid_tone2:`ear_with_hearing_aid_tone2`,ear_with_hearing_aid_tone3:`ear_with_hearing_aid_tone3`,ear_with_hearing_aid_tone4:`ear_with_hearing_aid_tone4`,ear_with_hearing_aid_tone5:`ear_with_hearing_aid_tone5`,earth_africa:`earth_africa`,earth_americas:`earth_americas`,earth_asia:`earth_asia`,ec:`flag_ec`,ee:`flag_ee`,eg:`flag_eg`,egg:`egg`,eggplant:`eggplant`,eh:`flag_eh`,eight:`eight`,eight_oclock:`clock8`,eight_pointed_black_star:`eight_pointed_black_star`,eight_spoked_asterisk:`eight_spoked_asterisk`,eight_thirty:`clock830`,eject:`eject`,eject_symbol:`eject`,electric_plug:`electric_plug`,elephant:`elephant`,elevator:`elevator`,eleven_oclock:`clock11`,eleven_thirty:`clock1130`,elf:`elf`,elf_dark_skin_tone:`elf_tone5`,elf_light_skin_tone:`elf_tone1`,elf_medium_dark_skin_tone:`elf_tone4`,elf_medium_light_skin_tone:`elf_tone2`,elf_medium_skin_tone:`elf_tone3`,elf_tone1:`elf_tone1`,elf_tone2:`elf_tone2`,elf_tone3:`elf_tone3`,elf_tone4:`elf_tone4`,elf_tone5:`elf_tone5`,email:`e-mail`,empty_nest:`empty_nest`,end:`end`,end_arrow:`end`,england:`england`,envelope:`envelope`,envelope_with_arrow:`envelope_with_arrow`,er:`flag_er`,es:`flag_es`,et:`flag_et`,eu:`flag_eu`,euro:`euro`,euro_banknote:`euro`,european_castle:`european_castle`,european_post_office:`european_post_office`,evergreen_tree:`evergreen_tree`,ewe:`sheep`,exclamation:`exclamation`,expecting_woman:`pregnant_woman`,expecting_woman_tone1:`pregnant_woman_tone1`,expecting_woman_tone2:`pregnant_woman_tone2`,expecting_woman_tone3:`pregnant_woman_tone3`,expecting_woman_tone4:`pregnant_woman_tone4`,expecting_woman_tone5:`pregnant_woman_tone5`,exploding_head:`exploding_head`,expressionless:`expressionless`,eye:`eye`,eye_in_speech_bubble:`eye_in_speech_bubble`,eyeglasses:`eyeglasses`,eyes:`eyes`,face_exhaling:`face_exhaling`,face_holding_back_tears:`face_holding_back_tears`,face_in_clouds:`face_in_clouds`,face_palm:`person_facepalming`,face_palm_tone1:`person_facepalming_tone1`,face_palm_tone2:`person_facepalming_tone2`,face_palm_tone3:`person_facepalming_tone3`,face_palm_tone4:`person_facepalming_tone4`,face_palm_tone5:`person_facepalming_tone5`,face_vomiting:`face_vomiting`,face_with_bags_under_eyes:`face_with_bags_under_eyes`,face_with_cowboy_hat:`cowboy`,face_with_diagonal_mouth:`face_with_diagonal_mouth`,face_with_hand_over_mouth:`face_with_hand_over_mouth`,face_with_head_bandage:`head_bandage`,face_with_monocle:`face_with_monocle`,face_with_open_eyes_and_hand_over_mouth:`face_with_open_eyes_and_hand_over_mouth`,face_with_peeking_eye:`face_with_peeking_eye`,face_with_raised_eyebrow:`face_with_raised_eyebrow`,face_with_rolling_eyes:`rolling_eyes`,face_with_spiral_eyes:`face_with_spiral_eyes`,face_with_symbols_over_mouth:`face_with_symbols_over_mouth`,face_with_thermometer:`thermometer_face`,facepalm:`person_facepalming`,facepalm_tone1:`person_facepalming_tone1`,facepalm_tone2:`person_facepalming_tone2`,facepalm_tone3:`person_facepalming_tone3`,facepalm_tone4:`person_facepalming_tone4`,facepalm_tone5:`person_facepalming_tone5`,factory:`factory`,factory_worker:`factory_worker`,factory_worker_dark_skin_tone:`factory_worker_tone5`,factory_worker_light_skin_tone:`factory_worker_tone1`,factory_worker_medium_dark_skin_tone:`factory_worker_tone4`,factory_worker_medium_light_skin_tone:`factory_worker_tone2`,factory_worker_medium_skin_tone:`factory_worker_tone3`,factory_worker_tone1:`factory_worker_tone1`,factory_worker_tone2:`factory_worker_tone2`,factory_worker_tone3:`factory_worker_tone3`,factory_worker_tone4:`factory_worker_tone4`,factory_worker_tone5:`factory_worker_tone5`,fairy:`fairy`,fairy_dark_skin_tone:`fairy_tone5`,fairy_light_skin_tone:`fairy_tone1`,fairy_medium_dark_skin_tone:`fairy_tone4`,fairy_medium_light_skin_tone:`fairy_tone2`,fairy_medium_skin_tone:`fairy_tone3`,fairy_tone1:`fairy_tone1`,fairy_tone2:`fairy_tone2`,fairy_tone3:`fairy_tone3`,fairy_tone4:`fairy_tone4`,fairy_tone5:`fairy_tone5`,falafel:`falafel`,fallen_leaf:`fallen_leaf`,family:`family`,family_adult_adult_child:`family_adult_adult_child`,family_adult_adult_child_child:`family_adult_adult_child_child`,family_adult_child:`family_adult_child`,family_adult_child_child:`family_adult_child_child`,family_man_boy:`family_man_boy`,family_man_boy_boy:`family_man_boy_boy`,family_man_girl:`family_man_girl`,family_man_girl_boy:`family_man_girl_boy`,family_man_girl_girl:`family_man_girl_girl`,family_man_woman_boy:`family_man_woman_boy`,family_mmb:`family_mmb`,family_mmbb:`family_mmbb`,family_mmg:`family_mmg`,family_mmgb:`family_mmgb`,family_mmgg:`family_mmgg`,family_mwbb:`family_mwbb`,family_mwg:`family_mwg`,family_mwgb:`family_mwgb`,family_mwgg:`family_mwgg`,family_woman_boy:`family_woman_boy`,family_woman_boy_boy:`family_woman_boy_boy`,family_woman_girl:`family_woman_girl`,family_woman_girl_boy:`family_woman_girl_boy`,family_woman_girl_girl:`family_woman_girl_girl`,family_wwb:`family_wwb`,family_wwbb:`family_wwbb`,family_wwg:`family_wwg`,family_wwgb:`family_wwgb`,family_wwgg:`family_wwgg`,farmer:`farmer`,farmer_dark_skin_tone:`farmer_tone5`,farmer_light_skin_tone:`farmer_tone1`,farmer_medium_dark_skin_tone:`farmer_tone4`,farmer_medium_light_skin_tone:`farmer_tone2`,farmer_medium_skin_tone:`farmer_tone3`,farmer_tone1:`farmer_tone1`,farmer_tone2:`farmer_tone2`,farmer_tone3:`farmer_tone3`,farmer_tone4:`farmer_tone4`,farmer_tone5:`farmer_tone5`,fast_forward:`fast_forward`,fax:`fax`,fax_machine:`fax`,fearful:`fearful`,fearful_face:`fearful`,feather:`feather`,feet:`feet`,female_sign:`female_sign`,fencer:`person_fencing`,fencing:`person_fencing`,ferris_wheel:`ferris_wheel`,ferry:`ferry`,fi:`flag_fi`,field_hockey:`field_hockey`,file_cabinet:`file_cabinet`,file_folder:`file_folder`,film_frames:`film_frames`,film_projector:`projector`,fingerprint:`fingerprint`,fingers_crossed:`fingers_crossed`,fingers_crossed_tone1:`fingers_crossed_tone1`,fingers_crossed_tone2:`fingers_crossed_tone2`,fingers_crossed_tone3:`fingers_crossed_tone3`,fingers_crossed_tone4:`fingers_crossed_tone4`,fingers_crossed_tone5:`fingers_crossed_tone5`,fire:`fire`,fire_engine:`fire_engine`,fire_extinguisher:`fire_extinguisher`,firecracker:`firecracker`,firefighter:`firefighter`,firefighter_dark_skin_tone:`firefighter_tone5`,firefighter_light_skin_tone:`firefighter_tone1`,firefighter_medium_dark_skin_tone:`firefighter_tone4`,firefighter_medium_light_skin_tone:`firefighter_tone2`,firefighter_medium_skin_tone:`firefighter_tone3`,firefighter_tone1:`firefighter_tone1`,firefighter_tone2:`firefighter_tone2`,firefighter_tone3:`firefighter_tone3`,firefighter_tone4:`firefighter_tone4`,firefighter_tone5:`firefighter_tone5`,fireworks:`fireworks`,first_place:`first_place`,first_place_medal:`first_place`,first_quarter_moon:`first_quarter_moon`,first_quarter_moon_with_face:`first_quarter_moon_with_face`,fish:`fish`,fish_cake:`fish_cake`,fishing_pole:`fishing_pole_and_fish`,fishing_pole_and_fish:`fishing_pole_and_fish`,fist:`fist`,fist_tone1:`fist_tone1`,fist_tone2:`fist_tone2`,fist_tone3:`fist_tone3`,fist_tone4:`fist_tone4`,fist_tone5:`fist_tone5`,five:`five`,five_oclock:`clock5`,five_thirty:`clock530`,fj:`flag_fj`,fk:`flag_fk`,flag_ac:`flag_ac`,flag_ad:`flag_ad`,flag_ae:`flag_ae`,flag_af:`flag_af`,flag_ag:`flag_ag`,flag_ai:`flag_ai`,flag_al:`flag_al`,flag_am:`flag_am`,flag_ao:`flag_ao`,flag_aq:`flag_aq`,flag_ar:`flag_ar`,flag_as:`flag_as`,flag_at:`flag_at`,flag_au:`flag_au`,flag_aw:`flag_aw`,flag_ax:`flag_ax`,flag_az:`flag_az`,flag_ba:`flag_ba`,flag_bb:`flag_bb`,flag_bd:`flag_bd`,flag_be:`flag_be`,flag_bf:`flag_bf`,flag_bg:`flag_bg`,flag_bh:`flag_bh`,flag_bi:`flag_bi`,flag_bj:`flag_bj`,flag_bl:`flag_bl`,flag_black:`flag_black`,flag_bm:`flag_bm`,flag_bn:`flag_bn`,flag_bo:`flag_bo`,flag_bq:`flag_bq`,flag_br:`flag_br`,flag_bs:`flag_bs`,flag_bt:`flag_bt`,flag_bv:`flag_bv`,flag_bw:`flag_bw`,flag_by:`flag_by`,flag_bz:`flag_bz`,flag_ca:`flag_ca`,flag_cc:`flag_cc`,flag_cd:`flag_cd`,flag_cf:`flag_cf`,flag_cg:`flag_cg`,flag_ch:`flag_ch`,flag_ci:`flag_ci`,flag_ck:`flag_ck`,flag_cl:`flag_cl`,flag_cm:`flag_cm`,flag_cn:`flag_cn`,flag_co:`flag_co`,flag_cp:`flag_cp`,flag_cr:`flag_cr`,flag_cu:`flag_cu`,flag_cv:`flag_cv`,flag_cw:`flag_cw`,flag_cx:`flag_cx`,flag_cy:`flag_cy`,flag_cz:`flag_cz`,flag_de:`flag_de`,flag_dg:`flag_dg`,flag_dj:`flag_dj`,flag_dk:`flag_dk`,flag_dm:`flag_dm`,flag_do:`flag_do`,flag_dz:`flag_dz`,flag_ea:`flag_ea`,flag_ec:`flag_ec`,flag_ee:`flag_ee`,flag_eg:`flag_eg`,flag_eh:`flag_eh`,flag_er:`flag_er`,flag_es:`flag_es`,flag_et:`flag_et`,flag_eu:`flag_eu`,flag_fi:`flag_fi`,flag_fj:`flag_fj`,flag_fk:`flag_fk`,flag_fm:`flag_fm`,flag_fo:`flag_fo`,flag_fr:`flag_fr`,flag_ga:`flag_ga`,flag_gb:`flag_gb`,flag_gd:`flag_gd`,flag_ge:`flag_ge`,flag_gf:`flag_gf`,flag_gg:`flag_gg`,flag_gh:`flag_gh`,flag_gi:`flag_gi`,flag_gl:`flag_gl`,flag_gm:`flag_gm`,flag_gn:`flag_gn`,flag_gp:`flag_gp`,flag_gq:`flag_gq`,flag_gr:`flag_gr`,flag_gs:`flag_gs`,flag_gt:`flag_gt`,flag_gu:`flag_gu`,flag_gw:`flag_gw`,flag_gy:`flag_gy`,flag_hk:`flag_hk`,flag_hm:`flag_hm`,flag_hn:`flag_hn`,flag_hr:`flag_hr`,flag_ht:`flag_ht`,flag_hu:`flag_hu`,flag_ic:`flag_ic`,flag_id:`flag_id`,flag_ie:`flag_ie`,flag_il:`flag_il`,flag_im:`flag_im`,flag_in:`flag_in`,flag_in_hole:`golf`,flag_io:`flag_io`,flag_iq:`flag_iq`,flag_ir:`flag_ir`,flag_is:`flag_is`,flag_it:`flag_it`,flag_je:`flag_je`,flag_jm:`flag_jm`,flag_jo:`flag_jo`,flag_jp:`flag_jp`,flag_ke:`flag_ke`,flag_kg:`flag_kg`,flag_kh:`flag_kh`,flag_ki:`flag_ki`,flag_km:`flag_km`,flag_kn:`flag_kn`,flag_kp:`flag_kp`,flag_kr:`flag_kr`,flag_kw:`flag_kw`,flag_ky:`flag_ky`,flag_kz:`flag_kz`,flag_la:`flag_la`,flag_lb:`flag_lb`,flag_lc:`flag_lc`,flag_li:`flag_li`,flag_lk:`flag_lk`,flag_lr:`flag_lr`,flag_ls:`flag_ls`,flag_lt:`flag_lt`,flag_lu:`flag_lu`,flag_lv:`flag_lv`,flag_ly:`flag_ly`,flag_ma:`flag_ma`,flag_mc:`flag_mc`,flag_md:`flag_md`,flag_me:`flag_me`,flag_mf:`flag_mf`,flag_mg:`flag_mg`,flag_mh:`flag_mh`,flag_mk:`flag_mk`,flag_ml:`flag_ml`,flag_mm:`flag_mm`,flag_mn:`flag_mn`,flag_mo:`flag_mo`,flag_mp:`flag_mp`,flag_mq:`flag_mq`,flag_mr:`flag_mr`,flag_ms:`flag_ms`,flag_mt:`flag_mt`,flag_mu:`flag_mu`,flag_mv:`flag_mv`,flag_mw:`flag_mw`,flag_mx:`flag_mx`,flag_my:`flag_my`,flag_mz:`flag_mz`,flag_na:`flag_na`,flag_nc:`flag_nc`,flag_ne:`flag_ne`,flag_nf:`flag_nf`,flag_ng:`flag_ng`,flag_ni:`flag_ni`,flag_nl:`flag_nl`,flag_no:`flag_no`,flag_np:`flag_np`,flag_nr:`flag_nr`,flag_nu:`flag_nu`,flag_nz:`flag_nz`,flag_om:`flag_om`,flag_pa:`flag_pa`,flag_pe:`flag_pe`,flag_pf:`flag_pf`,flag_pg:`flag_pg`,flag_ph:`flag_ph`,flag_pk:`flag_pk`,flag_pl:`flag_pl`,flag_pm:`flag_pm`,flag_pn:`flag_pn`,flag_pr:`flag_pr`,flag_ps:`flag_ps`,flag_pt:`flag_pt`,flag_pw:`flag_pw`,flag_py:`flag_py`,flag_qa:`flag_qa`,flag_re:`flag_re`,flag_ro:`flag_ro`,flag_rs:`flag_rs`,flag_ru:`flag_ru`,flag_rw:`flag_rw`,flag_sa:`flag_sa`,flag_sark:`flag_sark`,flag_sb:`flag_sb`,flag_sc:`flag_sc`,flag_sd:`flag_sd`,flag_se:`flag_se`,flag_sg:`flag_sg`,flag_sh:`flag_sh`,flag_si:`flag_si`,flag_sj:`flag_sj`,flag_sk:`flag_sk`,flag_sl:`flag_sl`,flag_sm:`flag_sm`,flag_sn:`flag_sn`,flag_so:`flag_so`,flag_sr:`flag_sr`,flag_ss:`flag_ss`,flag_st:`flag_st`,flag_sv:`flag_sv`,flag_sx:`flag_sx`,flag_sy:`flag_sy`,flag_sz:`flag_sz`,flag_ta:`flag_ta`,flag_tc:`flag_tc`,flag_td:`flag_td`,flag_tf:`flag_tf`,flag_tg:`flag_tg`,flag_th:`flag_th`,flag_tj:`flag_tj`,flag_tk:`flag_tk`,flag_tl:`flag_tl`,flag_tm:`flag_tm`,flag_tn:`flag_tn`,flag_to:`flag_to`,flag_tr:`flag_tr`,flag_tt:`flag_tt`,flag_tv:`flag_tv`,flag_tw:`flag_tw`,flag_tz:`flag_tz`,flag_ua:`flag_ua`,flag_ug:`flag_ug`,flag_um:`flag_um`,flag_us:`flag_us`,flag_uy:`flag_uy`,flag_uz:`flag_uz`,flag_va:`flag_va`,flag_vc:`flag_vc`,flag_ve:`flag_ve`,flag_vg:`flag_vg`,flag_vi:`flag_vi`,flag_vn:`flag_vn`,flag_vu:`flag_vu`,flag_wf:`flag_wf`,flag_white:`flag_white`,flag_ws:`flag_ws`,flag_xk:`flag_xk`,flag_ye:`flag_ye`,flag_yt:`flag_yt`,flag_za:`flag_za`,flag_zm:`flag_zm`,flag_zw:`flag_zw`,flags:`flags`,flame:`fire`,flamingo:`flamingo`,flan:`custard`,flashlight:`flashlight`,flat_shoe:`womans_flat_shoe`,flatbread:`flatbread`,fleur_de_lis:`fleur-de-lis`,"fleur-de-lis":`fleur-de-lis`,flexed_biceps:`muscle`,floppy_disk:`floppy_disk`,flower_playing_cards:`flower_playing_cards`,flushed:`flushed`,flushed_face:`flushed`,flute:`flute`,fly:`fly`,flying_disc:`flying_disc`,flying_saucer:`flying_saucer`,fm:`flag_fm`,fo:`flag_fo`,fog:`fog`,foggy:`foggy`,folded_hands:`pray`,folding_hand_fan:`folding_hand_fan`,fondue:`fondue`,foot:`foot`,foot_dark_skin_tone:`foot_tone5`,foot_light_skin_tone:`foot_tone1`,foot_medium_dark_skin_tone:`foot_tone4`,foot_medium_light_skin_tone:`foot_tone2`,foot_medium_skin_tone:`foot_tone3`,foot_tone1:`foot_tone1`,foot_tone2:`foot_tone2`,foot_tone3:`foot_tone3`,foot_tone4:`foot_tone4`,foot_tone5:`foot_tone5`,football:`football`,footprints:`footprints`,fork_and_knife:`fork_and_knife`,fork_and_knife_with_plate:`fork_knife_plate`,fork_knife_plate:`fork_knife_plate`,fortune_cookie:`fortune_cookie`,fountain:`fountain`,fountain_pen:`pen_fountain`,four:`four`,four_leaf_clover:`four_leaf_clover`,four_oclock:`clock4`,four_thirty:`clock430`,fox:`fox`,fox_face:`fox`,fr:`flag_fr`,frame_photo:`frame_photo`,frame_with_picture:`frame_photo`,free:`free`,french_bread:`french_bread`,french_fries:`fries`,fried_shrimp:`fried_shrimp`,fries:`fries`,frog:`frog`,frowning:`frowning`,frowning_face:`frowning2`,frowning2:`frowning2`,fuel_pump:`fuelpump`,fuelpump:`fuelpump`,full_moon:`full_moon`,full_moon_with_face:`full_moon_with_face`,funeral_urn:`urn`,ga:`flag_ga`,game_die:`game_die`,garlic:`garlic`,gay_pride_flag:`rainbow_flag`,gb:`flag_gb`,gd:`flag_gd`,ge:`flag_ge`,gear:`gear`,gem:`gem`,gem_stone:`gem`,gemini:`gemini`,genie:`genie`,gf:`flag_gf`,gg:`flag_gg`,gh:`flag_gh`,ghost:`ghost`,gi:`flag_gi`,gift:`gift`,gift_heart:`gift_heart`,ginger_root:`ginger_root`,giraffe:`giraffe`,girl:`girl`,girl_tone1:`girl_tone1`,girl_tone2:`girl_tone2`,girl_tone3:`girl_tone3`,girl_tone4:`girl_tone4`,girl_tone5:`girl_tone5`,gl:`flag_gl`,glass_of_milk:`milk`,glasses:`eyeglasses`,globe_with_meridians:`globe_with_meridians`,gloves:`gloves`,glowing_star:`star2`,gm:`flag_gm`,gn:`flag_gn`,goal:`goal`,goal_net:`goal`,goat:`goat`,goblin:`japanese_goblin`,goggles:`goggles`,golf:`golf`,golfer:`person_golfing`,goose:`goose`,gorilla:`gorilla`,gp:`flag_gp`,gq:`flag_gq`,gr:`flag_gr`,grandma:`older_woman`,grandma_tone1:`older_woman_tone1`,grandma_tone2:`older_woman_tone2`,grandma_tone3:`older_woman_tone3`,grandma_tone4:`older_woman_tone4`,grandma_tone5:`older_woman_tone5`,grapes:`grapes`,green_apple:`green_apple`,green_book:`green_book`,green_circle:`green_circle`,green_heart:`green_heart`,green_salad:`salad`,green_square:`green_square`,grey_exclamation:`grey_exclamation`,grey_heart:`grey_heart`,grey_question:`grey_question`,grimacing:`grimacing`,grin:`grin`,grinning:`grinning`,grinning_cat:`smiley_cat`,grinning_face:`grinning`,growing_heart:`heartpulse`,gs:`flag_gs`,gt:`flag_gt`,gu:`flag_gu`,guard:`guard`,guard_tone1:`guard_tone1`,guard_tone2:`guard_tone2`,guard_tone3:`guard_tone3`,guard_tone4:`guard_tone4`,guard_tone5:`guard_tone5`,guardsman:`guard`,guardsman_tone1:`guard_tone1`,guardsman_tone2:`guard_tone2`,guardsman_tone3:`guard_tone3`,guardsman_tone4:`guard_tone4`,guardsman_tone5:`guard_tone5`,guide_dog:`guide_dog`,guitar:`guitar`,gun:`gun`,gw:`flag_gw`,gy:`flag_gy`,hair_pick:`hair_pick`,haircut:`person_getting_haircut`,haircut_tone1:`person_getting_haircut_tone1`,haircut_tone2:`person_getting_haircut_tone2`,haircut_tone3:`person_getting_haircut_tone3`,haircut_tone4:`person_getting_haircut_tone4`,haircut_tone5:`person_getting_haircut_tone5`,hamburger:`hamburger`,hammer:`hammer`,hammer_and_pick:`hammer_pick`,hammer_and_wrench:`tools`,hammer_pick:`hammer_pick`,hamsa:`hamsa`,hamster:`hamster`,hand_splayed:`hand_splayed`,hand_splayed_tone1:`hand_splayed_tone1`,hand_splayed_tone2:`hand_splayed_tone2`,hand_splayed_tone3:`hand_splayed_tone3`,hand_splayed_tone4:`hand_splayed_tone4`,hand_splayed_tone5:`hand_splayed_tone5`,hand_with_index_and_middle_finger_crossed:`fingers_crossed`,hand_with_index_and_middle_fingers_crossed_tone1:`fingers_crossed_tone1`,hand_with_index_and_middle_fingers_crossed_tone2:`fingers_crossed_tone2`,hand_with_index_and_middle_fingers_crossed_tone3:`fingers_crossed_tone3`,hand_with_index_and_middle_fingers_crossed_tone4:`fingers_crossed_tone4`,hand_with_index_and_middle_fingers_crossed_tone5:`fingers_crossed_tone5`,hand_with_index_finger_and_thumb_crossed:`hand_with_index_finger_and_thumb_crossed`,hand_with_index_finger_and_thumb_crossed_dark_skin_tone:`hand_with_index_finger_and_thumb_crossed_tone5`,hand_with_index_finger_and_thumb_crossed_light_skin_tone:`hand_with_index_finger_and_thumb_crossed_tone1`,hand_with_index_finger_and_thumb_crossed_medium_dark_skin_tone:`hand_with_index_finger_and_thumb_crossed_tone4`,hand_with_index_finger_and_thumb_crossed_medium_light_skin_tone:`hand_with_index_finger_and_thumb_crossed_tone2`,hand_with_index_finger_and_thumb_crossed_medium_skin_tone:`hand_with_index_finger_and_thumb_crossed_tone3`,hand_with_index_finger_and_thumb_crossed_tone1:`hand_with_index_finger_and_thumb_crossed_tone1`,hand_with_index_finger_and_thumb_crossed_tone2:`hand_with_index_finger_and_thumb_crossed_tone2`,hand_with_index_finger_and_thumb_crossed_tone3:`hand_with_index_finger_and_thumb_crossed_tone3`,hand_with_index_finger_and_thumb_crossed_tone4:`hand_with_index_finger_and_thumb_crossed_tone4`,hand_with_index_finger_and_thumb_crossed_tone5:`hand_with_index_finger_and_thumb_crossed_tone5`,handbag:`handbag`,handball:`person_playing_handball`,handball_tone1:`person_playing_handball_tone1`,handball_tone2:`person_playing_handball_tone2`,handball_tone3:`person_playing_handball_tone3`,handball_tone4:`person_playing_handball_tone4`,handball_tone5:`person_playing_handball_tone5`,handshake:`handshake`,handshake_dark_skin_tone:`handshake_tone5`,handshake_dark_skin_tone_light_skin_tone:`handshake_tone5_tone1`,handshake_dark_skin_tone_medium_dark_skin_tone:`handshake_tone5_tone4`,handshake_dark_skin_tone_medium_light_skin_tone:`handshake_tone5_tone2`,handshake_dark_skin_tone_medium_skin_tone:`handshake_tone5_tone3`,handshake_light_skin_tone:`handshake_tone1`,handshake_light_skin_tone_dark_skin_tone:`handshake_tone1_tone5`,handshake_light_skin_tone_medium_dark_skin_tone:`handshake_tone1_tone4`,handshake_light_skin_tone_medium_light_skin_tone:`handshake_tone1_tone2`,handshake_light_skin_tone_medium_skin_tone:`handshake_tone1_tone3`,handshake_medium_dark_skin_tone:`handshake_tone4`,handshake_medium_dark_skin_tone_dark_skin_tone:`handshake_tone4_tone5`,handshake_medium_dark_skin_tone_light_skin_tone:`handshake_tone4_tone1`,handshake_medium_dark_skin_tone_medium_light_skin_tone:`handshake_tone4_tone2`,handshake_medium_dark_skin_tone_medium_skin_tone:`handshake_tone4_tone3`,handshake_medium_light_skin_tone:`handshake_tone2`,handshake_medium_light_skin_tone_dark_skin_tone:`handshake_tone2_tone5`,handshake_medium_light_skin_tone_light_skin_tone:`handshake_tone2_tone1`,handshake_medium_light_skin_tone_medium_dark_skin_tone:`handshake_tone2_tone4`,handshake_medium_light_skin_tone_medium_skin_tone:`handshake_tone2_tone3`,handshake_medium_skin_tone:`handshake_tone3`,handshake_medium_skin_tone_dark_skin_tone:`handshake_tone3_tone5`,handshake_medium_skin_tone_light_skin_tone:`handshake_tone3_tone1`,handshake_medium_skin_tone_medium_dark_skin_tone:`handshake_tone3_tone4`,handshake_medium_skin_tone_medium_light_skin_tone:`handshake_tone3_tone2`,handshake_tone1:`handshake_tone1`,handshake_tone1_tone2:`handshake_tone1_tone2`,handshake_tone1_tone3:`handshake_tone1_tone3`,handshake_tone1_tone4:`handshake_tone1_tone4`,handshake_tone1_tone5:`handshake_tone1_tone5`,handshake_tone2:`handshake_tone2`,handshake_tone2_tone1:`handshake_tone2_tone1`,handshake_tone2_tone3:`handshake_tone2_tone3`,handshake_tone2_tone4:`handshake_tone2_tone4`,handshake_tone2_tone5:`handshake_tone2_tone5`,handshake_tone3:`handshake_tone3`,handshake_tone3_tone1:`handshake_tone3_tone1`,handshake_tone3_tone2:`handshake_tone3_tone2`,handshake_tone3_tone4:`handshake_tone3_tone4`,handshake_tone3_tone5:`handshake_tone3_tone5`,handshake_tone4:`handshake_tone4`,handshake_tone4_tone1:`handshake_tone4_tone1`,handshake_tone4_tone2:`handshake_tone4_tone2`,handshake_tone4_tone3:`handshake_tone4_tone3`,handshake_tone4_tone5:`handshake_tone4_tone5`,handshake_tone5:`handshake_tone5`,handshake_tone5_tone1:`handshake_tone5_tone1`,handshake_tone5_tone2:`handshake_tone5_tone2`,handshake_tone5_tone3:`handshake_tone5_tone3`,handshake_tone5_tone4:`handshake_tone5_tone4`,hankey:`poop`,harp:`harp`,hash:`hash`,hatched_chick:`hatched_chick`,hatching_chick:`hatching_chick`,head_bandage:`head_bandage`,head_shaking_horizontally:`head_shaking_horizontally`,head_shaking_vertically:`head_shaking_vertically`,headphone:`headphones`,headphones:`headphones`,headstone:`headstone`,health_worker:`health_worker`,health_worker_dark_skin_tone:`health_worker_tone5`,health_worker_light_skin_tone:`health_worker_tone1`,health_worker_medium_dark_skin_tone:`health_worker_tone4`,health_worker_medium_light_skin_tone:`health_worker_tone2`,health_worker_medium_skin_tone:`health_worker_tone3`,health_worker_tone1:`health_worker_tone1`,health_worker_tone2:`health_worker_tone2`,health_worker_tone3:`health_worker_tone3`,health_worker_tone4:`health_worker_tone4`,health_worker_tone5:`health_worker_tone5`,hear_no_evil:`hear_no_evil`,heart:`heart`,heart_decoration:`heart_decoration`,heart_exclamation:`heart_exclamation`,heart_eyes:`heart_eyes`,heart_eyes_cat:`heart_eyes_cat`,heart_hands:`heart_hands`,heart_hands_dark_skin_tone:`heart_hands_tone5`,heart_hands_light_skin_tone:`heart_hands_tone1`,heart_hands_medium_dark_skin_tone:`heart_hands_tone4`,heart_hands_medium_light_skin_tone:`heart_hands_tone2`,heart_hands_medium_skin_tone:`heart_hands_tone3`,heart_hands_tone1:`heart_hands_tone1`,heart_hands_tone2:`heart_hands_tone2`,heart_hands_tone3:`heart_hands_tone3`,heart_hands_tone4:`heart_hands_tone4`,heart_hands_tone5:`heart_hands_tone5`,heart_on_fire:`heart_on_fire`,heart_suit:`hearts`,heartbeat:`heartbeat`,heartpulse:`heartpulse`,hearts:`hearts`,heavy_check_mark:`heavy_check_mark`,heavy_division_sign:`heavy_division_sign`,heavy_dollar_sign:`heavy_dollar_sign`,heavy_equals_sign:`heavy_equals_sign`,heavy_heart_exclamation_mark_ornament:`heart_exclamation`,heavy_minus_sign:`heavy_minus_sign`,heavy_multiplication_x:`heavy_multiplication_x`,heavy_plus_sign:`heavy_plus_sign`,hedgehog:`hedgehog`,helicopter:`helicopter`,helmet_with_cross:`helmet_with_cross`,helmet_with_white_cross:`helmet_with_cross`,herb:`herb`,hibiscus:`hibiscus`,high_brightness:`high_brightness`,high_heel:`high_heel`,high_voltage:`zap`,hiking_boot:`hiking_boot`,hindu_temple:`hindu_temple`,hippopotamus:`hippopotamus`,hk:`flag_hk`,hm:`flag_hm`,hn:`flag_hn`,hockey:`hockey`,hole:`hole`,homes:`homes`,honey_pot:`honey_pot`,honeybee:`bee`,hook:`hook`,horse:`horse`,horse_face:`horse`,horse_racing:`horse_racing`,horse_racing_tone1:`horse_racing_tone1`,horse_racing_tone2:`horse_racing_tone2`,horse_racing_tone3:`horse_racing_tone3`,horse_racing_tone4:`horse_racing_tone4`,horse_racing_tone5:`horse_racing_tone5`,hospital:`hospital`,hot_beverage:`coffee`,hot_dog:`hotdog`,hot_face:`hot_face`,hot_pepper:`hot_pepper`,hot_springs:`hotsprings`,hotdog:`hotdog`,hotel:`hotel`,hotsprings:`hotsprings`,hourglass:`hourglass`,hourglass_flowing_sand:`hourglass_flowing_sand`,house:`house`,house_abandoned:`house_abandoned`,house_buildings:`homes`,house_with_garden:`house_with_garden`,houses:`homes`,hr:`flag_hr`,ht:`flag_ht`,hu:`flag_hu`,hugging:`hugging`,hugging_face:`hugging`,hushed:`hushed`,hushed_face:`hushed`,hut:`hut`,hyacinth:`hyacinth`,ic:`flag_ic`,ice_cream:`ice_cream`,ice_cube:`ice_cube`,ice_hockey:`hockey`,ice_skate:`ice_skate`,icecream:`icecream`,id:`id`,identification_card:`identification_card`,ideograph_advantage:`ideograph_advantage`,ie:`flag_ie`,il:`flag_il`,im:`flag_im`,imp:`imp`,in:`flag_in`,inbox_tray:`inbox_tray`,incoming_envelope:`incoming_envelope`,index_pointing_at_the_viewer:`index_pointing_at_the_viewer`,index_pointing_at_the_viewer_dark_skin_tone:`index_pointing_at_the_viewer_tone5`,index_pointing_at_the_viewer_light_skin_tone:`index_pointing_at_the_viewer_tone1`,index_pointing_at_the_viewer_medium_dark_skin_tone:`index_pointing_at_the_viewer_tone4`,index_pointing_at_the_viewer_medium_light_skin_tone:`index_pointing_at_the_viewer_tone2`,index_pointing_at_the_viewer_medium_skin_tone:`index_pointing_at_the_viewer_tone3`,index_pointing_at_the_viewer_tone1:`index_pointing_at_the_viewer_tone1`,index_pointing_at_the_viewer_tone2:`index_pointing_at_the_viewer_tone2`,index_pointing_at_the_viewer_tone3:`index_pointing_at_the_viewer_tone3`,index_pointing_at_the_viewer_tone4:`index_pointing_at_the_viewer_tone4`,index_pointing_at_the_viewer_tone5:`index_pointing_at_the_viewer_tone5`,indonesia:`flag_id`,infinity:`infinity`,information:`information_source`,information_desk_person:`person_tipping_hand`,information_desk_person_tone1:`person_tipping_hand_tone1`,information_desk_person_tone2:`person_tipping_hand_tone2`,information_desk_person_tone3:`person_tipping_hand_tone3`,information_desk_person_tone4:`person_tipping_hand_tone4`,information_desk_person_tone5:`person_tipping_hand_tone5`,information_source:`information_source`,innocent:`innocent`,input_numbers:`1234`,input_symbols:`symbols`,interrobang:`interrobang`,io:`flag_io`,iq:`flag_iq`,ir:`flag_ir`,is:`flag_is`,island:`island`,it:`flag_it`,izakaya_lantern:`izakaya_lantern`,jack_o_lantern:`jack_o_lantern`,japan:`japan`,japanese_castle:`japanese_castle`,japanese_goblin:`japanese_goblin`,japanese_ogre:`japanese_ogre`,jar:`jar`,je:`flag_je`,jeans:`jeans`,jellyfish:`jellyfish`,jigsaw:`jigsaw`,jm:`flag_jm`,jo:`flag_jo`,joker:`black_joker`,joy:`joy`,joy_cat:`joy_cat`,joystick:`joystick`,jp:`flag_jp`,judge:`judge`,judge_dark_skin_tone:`judge_tone5`,judge_light_skin_tone:`judge_tone1`,judge_medium_dark_skin_tone:`judge_tone4`,judge_medium_light_skin_tone:`judge_tone2`,judge_medium_skin_tone:`judge_tone3`,judge_tone1:`judge_tone1`,judge_tone2:`judge_tone2`,judge_tone3:`judge_tone3`,judge_tone4:`judge_tone4`,judge_tone5:`judge_tone5`,juggler:`person_juggling`,juggler_tone1:`person_juggling_tone1`,juggler_tone2:`person_juggling_tone2`,juggler_tone3:`person_juggling_tone3`,juggler_tone4:`person_juggling_tone4`,juggler_tone5:`person_juggling_tone5`,juggling:`person_juggling`,juggling_tone1:`person_juggling_tone1`,juggling_tone2:`person_juggling_tone2`,juggling_tone3:`person_juggling_tone3`,juggling_tone4:`person_juggling_tone4`,juggling_tone5:`person_juggling_tone5`,kaaba:`kaaba`,kangaroo:`kangaroo`,karate_uniform:`martial_arts_uniform`,kayak:`canoe`,ke:`flag_ke`,key:`key`,key2:`key2`,keyboard:`keyboard`,keycap_asterisk:`asterisk`,keycap_ten:`keycap_ten`,kg:`flag_kg`,kh:`flag_kh`,khanda:`khanda`,ki:`flag_ki`,kick_scooter:`scooter`,kimono:`kimono`,kiss:`kiss`,kiss_dark_skin_tone:`kiss_tone5`,kiss_light_skin_tone:`kiss_tone1`,kiss_man_man:`kiss_mm`,kiss_man_man_dark_skin_tone:`kiss_man_man_tone5`,kiss_man_man_dark_skin_tone_light_skin_tone:`kiss_man_man_tone5_tone1`,kiss_man_man_dark_skin_tone_medium_dark_skin_tone:`kiss_man_man_tone5_tone4`,kiss_man_man_dark_skin_tone_medium_light_skin_tone:`kiss_man_man_tone5_tone2`,kiss_man_man_dark_skin_tone_medium_skin_tone:`kiss_man_man_tone5_tone3`,kiss_man_man_light_skin_tone:`kiss_man_man_tone1`,kiss_man_man_light_skin_tone_dark_skin_tone:`kiss_man_man_tone1_tone5`,kiss_man_man_light_skin_tone_medium_dark_skin_tone:`kiss_man_man_tone1_tone4`,kiss_man_man_light_skin_tone_medium_light_skin_tone:`kiss_man_man_tone1_tone2`,kiss_man_man_light_skin_tone_medium_skin_tone:`kiss_man_man_tone1_tone3`,kiss_man_man_medium_dark_skin_tone:`kiss_man_man_tone4`,kiss_man_man_medium_dark_skin_tone_dark_skin_tone:`kiss_man_man_tone4_tone5`,kiss_man_man_medium_dark_skin_tone_light_skin_tone:`kiss_man_man_tone4_tone1`,kiss_man_man_medium_dark_skin_tone_medium_light_skin_tone:`kiss_man_man_tone4_tone2`,kiss_man_man_medium_dark_skin_tone_medium_skin_tone:`kiss_man_man_tone4_tone3`,kiss_man_man_medium_light_skin_tone:`kiss_man_man_tone2`,kiss_man_man_medium_light_skin_tone_dark_skin_tone:`kiss_man_man_tone2_tone5`,kiss_man_man_medium_light_skin_tone_light_skin_tone:`kiss_man_man_tone2_tone1`,kiss_man_man_medium_light_skin_tone_medium_dark_skin_tone:`kiss_man_man_tone2_tone4`,kiss_man_man_medium_light_skin_tone_medium_skin_tone:`kiss_man_man_tone2_tone3`,kiss_man_man_medium_skin_tone:`kiss_man_man_tone3`,kiss_man_man_medium_skin_tone_dark_skin_tone:`kiss_man_man_tone3_tone5`,kiss_man_man_medium_skin_tone_light_skin_tone:`kiss_man_man_tone3_tone1`,kiss_man_man_medium_skin_tone_medium_dark_skin_tone:`kiss_man_man_tone3_tone4`,kiss_man_man_medium_skin_tone_medium_light_skin_tone:`kiss_man_man_tone3_tone2`,kiss_man_man_tone1:`kiss_man_man_tone1`,kiss_man_man_tone1_tone2:`kiss_man_man_tone1_tone2`,kiss_man_man_tone1_tone3:`kiss_man_man_tone1_tone3`,kiss_man_man_tone1_tone4:`kiss_man_man_tone1_tone4`,kiss_man_man_tone1_tone5:`kiss_man_man_tone1_tone5`,kiss_man_man_tone2:`kiss_man_man_tone2`,kiss_man_man_tone2_tone1:`kiss_man_man_tone2_tone1`,kiss_man_man_tone2_tone3:`kiss_man_man_tone2_tone3`,kiss_man_man_tone2_tone4:`kiss_man_man_tone2_tone4`,kiss_man_man_tone2_tone5:`kiss_man_man_tone2_tone5`,kiss_man_man_tone3:`kiss_man_man_tone3`,kiss_man_man_tone3_tone1:`kiss_man_man_tone3_tone1`,kiss_man_man_tone3_tone2:`kiss_man_man_tone3_tone2`,kiss_man_man_tone3_tone4:`kiss_man_man_tone3_tone4`,kiss_man_man_tone3_tone5:`kiss_man_man_tone3_tone5`,kiss_man_man_tone4:`kiss_man_man_tone4`,kiss_man_man_tone4_tone1:`kiss_man_man_tone4_tone1`,kiss_man_man_tone4_tone2:`kiss_man_man_tone4_tone2`,kiss_man_man_tone4_tone3:`kiss_man_man_tone4_tone3`,kiss_man_man_tone4_tone5:`kiss_man_man_tone4_tone5`,kiss_man_man_tone5:`kiss_man_man_tone5`,kiss_man_man_tone5_tone1:`kiss_man_man_tone5_tone1`,kiss_man_man_tone5_tone2:`kiss_man_man_tone5_tone2`,kiss_man_man_tone5_tone3:`kiss_man_man_tone5_tone3`,kiss_man_man_tone5_tone4:`kiss_man_man_tone5_tone4`,kiss_mark:`kiss`,kiss_medium_dark_skin_tone:`kiss_tone4`,kiss_medium_light_skin_tone:`kiss_tone2`,kiss_medium_skin_tone:`kiss_tone3`,kiss_mm:`kiss_mm`,kiss_person_person_dark_skin_tone_light_skin_tone:`kiss_person_person_tone5_tone1`,kiss_person_person_dark_skin_tone_medium_dark_skin_tone:`kiss_person_person_tone5_tone4`,kiss_person_person_dark_skin_tone_medium_light_skin_tone:`kiss_person_person_tone5_tone2`,kiss_person_person_dark_skin_tone_medium_skin_tone:`kiss_person_person_tone5_tone3`,kiss_person_person_light_skin_tone_dark_skin_tone:`kiss_person_person_tone1_tone5`,kiss_person_person_light_skin_tone_medium_dark_skin_tone:`kiss_person_person_tone1_tone4`,kiss_person_person_light_skin_tone_medium_light_skin_tone:`kiss_person_person_tone1_tone2`,kiss_person_person_light_skin_tone_medium_skin_tone:`kiss_person_person_tone1_tone3`,kiss_person_person_medium_dark_skin_tone_dark_skin_tone:`kiss_person_person_tone4_tone5`,kiss_person_person_medium_dark_skin_tone_light_skin_tone:`kiss_person_person_tone4_tone1`,kiss_person_person_medium_dark_skin_tone_medium_light_skin_tone:`kiss_person_person_tone4_tone2`,kiss_person_person_medium_dark_skin_tone_medium_skin_tone:`kiss_person_person_tone4_tone3`,kiss_person_person_medium_light_skin_tone_dark_skin_tone:`kiss_person_person_tone2_tone5`,kiss_person_person_medium_light_skin_tone_light_skin_tone:`kiss_person_person_tone2_tone1`,kiss_person_person_medium_light_skin_tone_medium_dark_skin_tone:`kiss_person_person_tone2_tone4`,kiss_person_person_medium_light_skin_tone_medium_skin_tone:`kiss_person_person_tone2_tone3`,kiss_person_person_medium_skin_tone_dark_skin_tone:`kiss_person_person_tone3_tone5`,kiss_person_person_medium_skin_tone_light_skin_tone:`kiss_person_person_tone3_tone1`,kiss_person_person_medium_skin_tone_medium_dark_skin_tone:`kiss_person_person_tone3_tone4`,kiss_person_person_medium_skin_tone_medium_light_skin_tone:`kiss_person_person_tone3_tone2`,kiss_person_person_tone1_tone2:`kiss_person_person_tone1_tone2`,kiss_person_person_tone1_tone3:`kiss_person_person_tone1_tone3`,kiss_person_person_tone1_tone4:`kiss_person_person_tone1_tone4`,kiss_person_person_tone1_tone5:`kiss_person_person_tone1_tone5`,kiss_person_person_tone2_tone1:`kiss_person_person_tone2_tone1`,kiss_person_person_tone2_tone3:`kiss_person_person_tone2_tone3`,kiss_person_person_tone2_tone4:`kiss_person_person_tone2_tone4`,kiss_person_person_tone2_tone5:`kiss_person_person_tone2_tone5`,kiss_person_person_tone3_tone1:`kiss_person_person_tone3_tone1`,kiss_person_person_tone3_tone2:`kiss_person_person_tone3_tone2`,kiss_person_person_tone3_tone4:`kiss_person_person_tone3_tone4`,kiss_person_person_tone3_tone5:`kiss_person_person_tone3_tone5`,kiss_person_person_tone4_tone1:`kiss_person_person_tone4_tone1`,kiss_person_person_tone4_tone2:`kiss_person_person_tone4_tone2`,kiss_person_person_tone4_tone3:`kiss_person_person_tone4_tone3`,kiss_person_person_tone4_tone5:`kiss_person_person_tone4_tone5`,kiss_person_person_tone5_tone1:`kiss_person_person_tone5_tone1`,kiss_person_person_tone5_tone2:`kiss_person_person_tone5_tone2`,kiss_person_person_tone5_tone3:`kiss_person_person_tone5_tone3`,kiss_person_person_tone5_tone4:`kiss_person_person_tone5_tone4`,kiss_tone1:`kiss_tone1`,kiss_tone2:`kiss_tone2`,kiss_tone3:`kiss_tone3`,kiss_tone4:`kiss_tone4`,kiss_tone5:`kiss_tone5`,kiss_woman_man:`kiss_woman_man`,kiss_woman_man_dark_skin_tone:`kiss_woman_man_tone5`,kiss_woman_man_dark_skin_tone_light_skin_tone:`kiss_woman_man_tone5_tone1`,kiss_woman_man_dark_skin_tone_medium_dark_skin_tone:`kiss_woman_man_tone5_tone4`,kiss_woman_man_dark_skin_tone_medium_light_skin_tone:`kiss_woman_man_tone5_tone2`,kiss_woman_man_dark_skin_tone_medium_skin_tone:`kiss_woman_man_tone5_tone3`,kiss_woman_man_light_skin_tone:`kiss_woman_man_tone1`,kiss_woman_man_light_skin_tone_dark_skin_tone:`kiss_woman_man_tone1_tone5`,kiss_woman_man_light_skin_tone_medium_dark_skin_tone:`kiss_woman_man_tone1_tone4`,kiss_woman_man_light_skin_tone_medium_light_skin_tone:`kiss_woman_man_tone1_tone2`,kiss_woman_man_light_skin_tone_medium_skin_tone:`kiss_woman_man_tone1_tone3`,kiss_woman_man_medium_dark_skin_tone:`kiss_woman_man_tone4`,kiss_woman_man_medium_dark_skin_tone_dark_skin_tone:`kiss_woman_man_tone4_tone5`,kiss_woman_man_medium_dark_skin_tone_light_skin_tone:`kiss_woman_man_tone4_tone1`,kiss_woman_man_medium_dark_skin_tone_medium_light_skin_tone:`kiss_woman_man_tone4_tone2`,kiss_woman_man_medium_dark_skin_tone_medium_skin_tone:`kiss_woman_man_tone4_tone3`,kiss_woman_man_medium_light_skin_tone:`kiss_woman_man_tone2`,kiss_woman_man_medium_light_skin_tone_dark_skin_tone:`kiss_woman_man_tone2_tone5`,kiss_woman_man_medium_light_skin_tone_light_skin_tone:`kiss_woman_man_tone2_tone1`,kiss_woman_man_medium_light_skin_tone_medium_dark_skin_tone:`kiss_woman_man_tone2_tone4`,kiss_woman_man_medium_light_skin_tone_medium_skin_tone:`kiss_woman_man_tone2_tone3`,kiss_woman_man_medium_skin_tone:`kiss_woman_man_tone3`,kiss_woman_man_medium_skin_tone_dark_skin_tone:`kiss_woman_man_tone3_tone5`,kiss_woman_man_medium_skin_tone_light_skin_tone:`kiss_woman_man_tone3_tone1`,kiss_woman_man_medium_skin_tone_medium_dark_skin_tone:`kiss_woman_man_tone3_tone4`,kiss_woman_man_medium_skin_tone_medium_light_skin_tone:`kiss_woman_man_tone3_tone2`,kiss_woman_man_tone1:`kiss_woman_man_tone1`,kiss_woman_man_tone1_tone2:`kiss_woman_man_tone1_tone2`,kiss_woman_man_tone1_tone3:`kiss_woman_man_tone1_tone3`,kiss_woman_man_tone1_tone4:`kiss_woman_man_tone1_tone4`,kiss_woman_man_tone1_tone5:`kiss_woman_man_tone1_tone5`,kiss_woman_man_tone2:`kiss_woman_man_tone2`,kiss_woman_man_tone2_tone1:`kiss_woman_man_tone2_tone1`,kiss_woman_man_tone2_tone3:`kiss_woman_man_tone2_tone3`,kiss_woman_man_tone2_tone4:`kiss_woman_man_tone2_tone4`,kiss_woman_man_tone2_tone5:`kiss_woman_man_tone2_tone5`,kiss_woman_man_tone3:`kiss_woman_man_tone3`,kiss_woman_man_tone3_tone1:`kiss_woman_man_tone3_tone1`,kiss_woman_man_tone3_tone2:`kiss_woman_man_tone3_tone2`,kiss_woman_man_tone3_tone4:`kiss_woman_man_tone3_tone4`,kiss_woman_man_tone3_tone5:`kiss_woman_man_tone3_tone5`,kiss_woman_man_tone4:`kiss_woman_man_tone4`,kiss_woman_man_tone4_tone1:`kiss_woman_man_tone4_tone1`,kiss_woman_man_tone4_tone2:`kiss_woman_man_tone4_tone2`,kiss_woman_man_tone4_tone3:`kiss_woman_man_tone4_tone3`,kiss_woman_man_tone4_tone5:`kiss_woman_man_tone4_tone5`,kiss_woman_man_tone5:`kiss_woman_man_tone5`,kiss_woman_man_tone5_tone1:`kiss_woman_man_tone5_tone1`,kiss_woman_man_tone5_tone2:`kiss_woman_man_tone5_tone2`,kiss_woman_man_tone5_tone3:`kiss_woman_man_tone5_tone3`,kiss_woman_man_tone5_tone4:`kiss_woman_man_tone5_tone4`,kiss_woman_woman_dark_skin_tone:`kiss_woman_woman_tone5`,kiss_woman_woman_dark_skin_tone_light_skin_tone:`kiss_woman_woman_tone5_tone1`,kiss_woman_woman_dark_skin_tone_medium_dark_skin_tone:`kiss_woman_woman_tone5_tone4`,kiss_woman_woman_dark_skin_tone_medium_light_skin_tone:`kiss_woman_woman_tone5_tone2`,kiss_woman_woman_dark_skin_tone_medium_skin_tone:`kiss_woman_woman_tone5_tone3`,kiss_woman_woman_light_skin_tone:`kiss_woman_woman_tone1`,kiss_woman_woman_light_skin_tone_dark_skin_tone:`kiss_woman_woman_tone1_tone5`,kiss_woman_woman_light_skin_tone_medium_dark_skin_tone:`kiss_woman_woman_tone1_tone4`,kiss_woman_woman_light_skin_tone_medium_light_skin_tone:`kiss_woman_woman_tone1_tone2`,kiss_woman_woman_light_skin_tone_medium_skin_tone:`kiss_woman_woman_tone1_tone3`,kiss_woman_woman_medium_dark_skin_tone:`kiss_woman_woman_tone4`,kiss_woman_woman_medium_dark_skin_tone_dark_skin_tone:`kiss_woman_woman_tone4_tone5`,kiss_woman_woman_medium_dark_skin_tone_light_skin_tone:`kiss_woman_woman_tone4_tone1`,kiss_woman_woman_medium_dark_skin_tone_medium_light_skin_tone:`kiss_woman_woman_tone4_tone2`,kiss_woman_woman_medium_dark_skin_tone_medium_skin_tone:`kiss_woman_woman_tone4_tone3`,kiss_woman_woman_medium_light_skin_tone:`kiss_woman_woman_tone2`,kiss_woman_woman_medium_light_skin_tone_dark_skin_tone:`kiss_woman_woman_tone2_tone5`,kiss_woman_woman_medium_light_skin_tone_light_skin_tone:`kiss_woman_woman_tone2_tone1`,kiss_woman_woman_medium_light_skin_tone_medium_dark_skin_tone:`kiss_woman_woman_tone2_tone4`,kiss_woman_woman_medium_light_skin_tone_medium_skin_tone:`kiss_woman_woman_tone2_tone3`,kiss_woman_woman_medium_skin_tone:`kiss_woman_woman_tone3`,kiss_woman_woman_medium_skin_tone_dark_skin_tone:`kiss_woman_woman_tone3_tone5`,kiss_woman_woman_medium_skin_tone_light_skin_tone:`kiss_woman_woman_tone3_tone1`,kiss_woman_woman_medium_skin_tone_medium_dark_skin_tone:`kiss_woman_woman_tone3_tone4`,kiss_woman_woman_medium_skin_tone_medium_light_skin_tone:`kiss_woman_woman_tone3_tone2`,kiss_woman_woman_tone1:`kiss_woman_woman_tone1`,kiss_woman_woman_tone1_tone2:`kiss_woman_woman_tone1_tone2`,kiss_woman_woman_tone1_tone3:`kiss_woman_woman_tone1_tone3`,kiss_woman_woman_tone1_tone4:`kiss_woman_woman_tone1_tone4`,kiss_woman_woman_tone1_tone5:`kiss_woman_woman_tone1_tone5`,kiss_woman_woman_tone2:`kiss_woman_woman_tone2`,kiss_woman_woman_tone2_tone1:`kiss_woman_woman_tone2_tone1`,kiss_woman_woman_tone2_tone3:`kiss_woman_woman_tone2_tone3`,kiss_woman_woman_tone2_tone4:`kiss_woman_woman_tone2_tone4`,kiss_woman_woman_tone2_tone5:`kiss_woman_woman_tone2_tone5`,kiss_woman_woman_tone3:`kiss_woman_woman_tone3`,kiss_woman_woman_tone3_tone1:`kiss_woman_woman_tone3_tone1`,kiss_woman_woman_tone3_tone2:`kiss_woman_woman_tone3_tone2`,kiss_woman_woman_tone3_tone4:`kiss_woman_woman_tone3_tone4`,kiss_woman_woman_tone3_tone5:`kiss_woman_woman_tone3_tone5`,kiss_woman_woman_tone4:`kiss_woman_woman_tone4`,kiss_woman_woman_tone4_tone1:`kiss_woman_woman_tone4_tone1`,kiss_woman_woman_tone4_tone2:`kiss_woman_woman_tone4_tone2`,kiss_woman_woman_tone4_tone3:`kiss_woman_woman_tone4_tone3`,kiss_woman_woman_tone4_tone5:`kiss_woman_woman_tone4_tone5`,kiss_woman_woman_tone5:`kiss_woman_woman_tone5`,kiss_woman_woman_tone5_tone1:`kiss_woman_woman_tone5_tone1`,kiss_woman_woman_tone5_tone2:`kiss_woman_woman_tone5_tone2`,kiss_woman_woman_tone5_tone3:`kiss_woman_woman_tone5_tone3`,kiss_woman_woman_tone5_tone4:`kiss_woman_woman_tone5_tone4`,kiss_ww:`kiss_ww`,kissing:`kissing`,kissing_cat:`kissing_cat`,kissing_closed_eyes:`kissing_closed_eyes`,kissing_face:`kissing`,kissing_heart:`kissing_heart`,kissing_smiling_eyes:`kissing_smiling_eyes`,kitchen_knife:`knife`,kite:`kite`,kiwi:`kiwi`,kiwi_fruit:`kiwi`,kiwifruit:`kiwi`,km:`flag_km`,kn:`flag_kn`,knife:`knife`,knot:`knot`,koala:`koala`,koko:`koko`,kp:`flag_kp`,kr:`flag_kr`,kw:`flag_kw`,ky:`flag_ky`,kz:`flag_kz`,la:`flag_la`,lab_coat:`lab_coat`,label:`label`,lacrosse:`lacrosse`,ladder:`ladder`,lady_beetle:`lady_beetle`,large_blue_diamond:`large_blue_diamond`,large_orange_diamond:`large_orange_diamond`,last_quarter_moon:`last_quarter_moon`,last_quarter_moon_with_face:`last_quarter_moon_with_face`,latin_cross:`cross`,laughing:`laughing`,lb:`flag_lb`,lc:`flag_lc`,leafless_tree:`leafless_tree`,leafy_green:`leafy_green`,leaves:`leaves`,ledger:`ledger`,left_arrow:`arrow_left`,left_facing_fist:`left_facing_fist`,left_facing_fist_tone1:`left_facing_fist_tone1`,left_facing_fist_tone2:`left_facing_fist_tone2`,left_facing_fist_tone3:`left_facing_fist_tone3`,left_facing_fist_tone4:`left_facing_fist_tone4`,left_facing_fist_tone5:`left_facing_fist_tone5`,left_fist:`left_facing_fist`,left_fist_tone1:`left_facing_fist_tone1`,left_fist_tone2:`left_facing_fist_tone2`,left_fist_tone3:`left_facing_fist_tone3`,left_fist_tone4:`left_facing_fist_tone4`,left_fist_tone5:`left_facing_fist_tone5`,left_luggage:`left_luggage`,left_right_arrow:`left_right_arrow`,left_speech_bubble:`speech_left`,leftwards_arrow_with_hook:`leftwards_arrow_with_hook`,leftwards_hand:`leftwards_hand`,leftwards_hand_dark_skin_tone:`leftwards_hand_tone5`,leftwards_hand_light_skin_tone:`leftwards_hand_tone1`,leftwards_hand_medium_dark_skin_tone:`leftwards_hand_tone4`,leftwards_hand_medium_light_skin_tone:`leftwards_hand_tone2`,leftwards_hand_medium_skin_tone:`leftwards_hand_tone3`,leftwards_hand_tone1:`leftwards_hand_tone1`,leftwards_hand_tone2:`leftwards_hand_tone2`,leftwards_hand_tone3:`leftwards_hand_tone3`,leftwards_hand_tone4:`leftwards_hand_tone4`,leftwards_hand_tone5:`leftwards_hand_tone5`,leftwards_pushing_hand:`leftwards_pushing_hand`,leftwards_pushing_hand_dark_skin_tone:`leftwards_pushing_hand_tone5`,leftwards_pushing_hand_light_skin_tone:`leftwards_pushing_hand_tone1`,leftwards_pushing_hand_medium_dark_skin_tone:`leftwards_pushing_hand_tone4`,leftwards_pushing_hand_medium_light_skin_tone:`leftwards_pushing_hand_tone2`,leftwards_pushing_hand_medium_skin_tone:`leftwards_pushing_hand_tone3`,leftwards_pushing_hand_tone1:`leftwards_pushing_hand_tone1`,leftwards_pushing_hand_tone2:`leftwards_pushing_hand_tone2`,leftwards_pushing_hand_tone3:`leftwards_pushing_hand_tone3`,leftwards_pushing_hand_tone4:`leftwards_pushing_hand_tone4`,leftwards_pushing_hand_tone5:`leftwards_pushing_hand_tone5`,leg:`leg`,leg_dark_skin_tone:`leg_tone5`,leg_light_skin_tone:`leg_tone1`,leg_medium_dark_skin_tone:`leg_tone4`,leg_medium_light_skin_tone:`leg_tone2`,leg_medium_skin_tone:`leg_tone3`,leg_tone1:`leg_tone1`,leg_tone2:`leg_tone2`,leg_tone3:`leg_tone3`,leg_tone4:`leg_tone4`,leg_tone5:`leg_tone5`,lemon:`lemon`,leo:`leo`,leopard:`leopard`,level_slider:`level_slider`,levitate:`levitate`,levitate_tone1:`levitate_tone1`,levitate_tone2:`levitate_tone2`,levitate_tone3:`levitate_tone3`,levitate_tone4:`levitate_tone4`,levitate_tone5:`levitate_tone5`,li:`flag_li`,liar:`lying_face`,libra:`libra`,lifter:`person_lifting_weights`,lifter_tone1:`person_lifting_weights_tone1`,lifter_tone2:`person_lifting_weights_tone2`,lifter_tone3:`person_lifting_weights_tone3`,lifter_tone4:`person_lifting_weights_tone4`,lifter_tone5:`person_lifting_weights_tone5`,light_blue_heart:`light_blue_heart`,light_bulb:`bulb`,light_rail:`light_rail`,lime:`lime`,link:`link`,linked_paperclips:`paperclips`,lion:`lion_face`,lion_face:`lion_face`,lips:`lips`,lipstick:`lipstick`,lizard:`lizard`,lk:`flag_lk`,llama:`llama`,lobster:`lobster`,lock:`lock`,lock_with_ink_pen:`lock_with_ink_pen`,locked:`lock`,locomotive:`steam_locomotive`,lollipop:`lollipop`,long_drum:`long_drum`,loop:`loop`,lotion_bottle:`squeeze_bottle`,lotus:`lotus`,loud_sound:`loud_sound`,loudspeaker:`loudspeaker`,love_hotel:`love_hotel`,love_letter:`love_letter`,love_you_gesture:`love_you_gesture`,love_you_gesture_dark_skin_tone:`love_you_gesture_tone5`,love_you_gesture_light_skin_tone:`love_you_gesture_tone1`,love_you_gesture_medium_dark_skin_tone:`love_you_gesture_tone4`,love_you_gesture_medium_light_skin_tone:`love_you_gesture_tone2`,love_you_gesture_medium_skin_tone:`love_you_gesture_tone3`,love_you_gesture_tone1:`love_you_gesture_tone1`,love_you_gesture_tone2:`love_you_gesture_tone2`,love_you_gesture_tone3:`love_you_gesture_tone3`,love_you_gesture_tone4:`love_you_gesture_tone4`,love_you_gesture_tone5:`love_you_gesture_tone5`,low_battery:`low_battery`,low_brightness:`low_brightness`,lower_left_ballpoint_pen:`pen_ballpoint`,lower_left_crayon:`crayon`,lower_left_fountain_pen:`pen_fountain`,lower_left_paintbrush:`paintbrush`,lr:`flag_lr`,ls:`flag_ls`,lt:`flag_lt`,lu:`flag_lu`,luggage:`luggage`,lungs:`lungs`,lv:`flag_lv`,ly:`flag_ly`,lying_face:`lying_face`,m:`m`,ma:`flag_ma`,mag:`mag`,mag_right:`mag_right`,mage:`mage`,mage_dark_skin_tone:`mage_tone5`,mage_light_skin_tone:`mage_tone1`,mage_medium_dark_skin_tone:`mage_tone4`,mage_medium_light_skin_tone:`mage_tone2`,mage_medium_skin_tone:`mage_tone3`,mage_tone1:`mage_tone1`,mage_tone2:`mage_tone2`,mage_tone3:`mage_tone3`,mage_tone4:`mage_tone4`,mage_tone5:`mage_tone5`,magic_wand:`magic_wand`,magnet:`magnet`,mahjong:`mahjong`,mailbox:`mailbox`,mailbox_closed:`mailbox_closed`,mailbox_with_mail:`mailbox_with_mail`,mailbox_with_no_mail:`mailbox_with_no_mail`,male_dancer:`man_dancing`,male_dancer_tone1:`man_dancing_tone1`,male_dancer_tone2:`man_dancing_tone2`,male_dancer_tone3:`man_dancing_tone3`,male_dancer_tone4:`man_dancing_tone4`,male_dancer_tone5:`man_dancing_tone5`,male_sign:`male_sign`,mammoth:`mammoth`,man:`man`,man_artist:`man_artist`,man_artist_dark_skin_tone:`man_artist_tone5`,man_artist_light_skin_tone:`man_artist_tone1`,man_artist_medium_dark_skin_tone:`man_artist_tone4`,man_artist_medium_light_skin_tone:`man_artist_tone2`,man_artist_medium_skin_tone:`man_artist_tone3`,man_artist_tone1:`man_artist_tone1`,man_artist_tone2:`man_artist_tone2`,man_artist_tone3:`man_artist_tone3`,man_artist_tone4:`man_artist_tone4`,man_artist_tone5:`man_artist_tone5`,man_astronaut:`man_astronaut`,man_astronaut_dark_skin_tone:`man_astronaut_tone5`,man_astronaut_light_skin_tone:`man_astronaut_tone1`,man_astronaut_medium_dark_skin_tone:`man_astronaut_tone4`,man_astronaut_medium_light_skin_tone:`man_astronaut_tone2`,man_astronaut_medium_skin_tone:`man_astronaut_tone3`,man_astronaut_tone1:`man_astronaut_tone1`,man_astronaut_tone2:`man_astronaut_tone2`,man_astronaut_tone3:`man_astronaut_tone3`,man_astronaut_tone4:`man_astronaut_tone4`,man_astronaut_tone5:`man_astronaut_tone5`,man_bald:`man_bald`,man_bald_dark_skin_tone:`man_bald_tone5`,man_bald_light_skin_tone:`man_bald_tone1`,man_bald_medium_dark_skin_tone:`man_bald_tone4`,man_bald_medium_light_skin_tone:`man_bald_tone2`,man_bald_medium_skin_tone:`man_bald_tone3`,man_bald_tone1:`man_bald_tone1`,man_bald_tone2:`man_bald_tone2`,man_bald_tone3:`man_bald_tone3`,man_bald_tone4:`man_bald_tone4`,man_bald_tone5:`man_bald_tone5`,man_beard:`man_beard`,man_biking:`man_biking`,man_biking_dark_skin_tone:`man_biking_tone5`,man_biking_light_skin_tone:`man_biking_tone1`,man_biking_medium_dark_skin_tone:`man_biking_tone4`,man_biking_medium_light_skin_tone:`man_biking_tone2`,man_biking_medium_skin_tone:`man_biking_tone3`,man_biking_tone1:`man_biking_tone1`,man_biking_tone2:`man_biking_tone2`,man_biking_tone3:`man_biking_tone3`,man_biking_tone4:`man_biking_tone4`,man_biking_tone5:`man_biking_tone5`,man_bouncing_ball:`man_bouncing_ball`,man_bouncing_ball_dark_skin_tone:`man_bouncing_ball_tone5`,man_bouncing_ball_light_skin_tone:`man_bouncing_ball_tone1`,man_bouncing_ball_medium_dark_skin_tone:`man_bouncing_ball_tone4`,man_bouncing_ball_medium_light_skin_tone:`man_bouncing_ball_tone2`,man_bouncing_ball_medium_skin_tone:`man_bouncing_ball_tone3`,man_bouncing_ball_tone1:`man_bouncing_ball_tone1`,man_bouncing_ball_tone2:`man_bouncing_ball_tone2`,man_bouncing_ball_tone3:`man_bouncing_ball_tone3`,man_bouncing_ball_tone4:`man_bouncing_ball_tone4`,man_bouncing_ball_tone5:`man_bouncing_ball_tone5`,man_bowing:`man_bowing`,man_bowing_dark_skin_tone:`man_bowing_tone5`,man_bowing_light_skin_tone:`man_bowing_tone1`,man_bowing_medium_dark_skin_tone:`man_bowing_tone4`,man_bowing_medium_light_skin_tone:`man_bowing_tone2`,man_bowing_medium_skin_tone:`man_bowing_tone3`,man_bowing_tone1:`man_bowing_tone1`,man_bowing_tone2:`man_bowing_tone2`,man_bowing_tone3:`man_bowing_tone3`,man_bowing_tone4:`man_bowing_tone4`,man_bowing_tone5:`man_bowing_tone5`,man_cartwheeling:`man_cartwheeling`,man_cartwheeling_dark_skin_tone:`man_cartwheeling_tone5`,man_cartwheeling_light_skin_tone:`man_cartwheeling_tone1`,man_cartwheeling_medium_dark_skin_tone:`man_cartwheeling_tone4`,man_cartwheeling_medium_light_skin_tone:`man_cartwheeling_tone2`,man_cartwheeling_medium_skin_tone:`man_cartwheeling_tone3`,man_cartwheeling_tone1:`man_cartwheeling_tone1`,man_cartwheeling_tone2:`man_cartwheeling_tone2`,man_cartwheeling_tone3:`man_cartwheeling_tone3`,man_cartwheeling_tone4:`man_cartwheeling_tone4`,man_cartwheeling_tone5:`man_cartwheeling_tone5`,man_climbing:`man_climbing`,man_climbing_dark_skin_tone:`man_climbing_tone5`,man_climbing_light_skin_tone:`man_climbing_tone1`,man_climbing_medium_dark_skin_tone:`man_climbing_tone4`,man_climbing_medium_light_skin_tone:`man_climbing_tone2`,man_climbing_medium_skin_tone:`man_climbing_tone3`,man_climbing_tone1:`man_climbing_tone1`,man_climbing_tone2:`man_climbing_tone2`,man_climbing_tone3:`man_climbing_tone3`,man_climbing_tone4:`man_climbing_tone4`,man_climbing_tone5:`man_climbing_tone5`,man_construction_worker:`man_construction_worker`,man_construction_worker_dark_skin_tone:`man_construction_worker_tone5`,man_construction_worker_light_skin_tone:`man_construction_worker_tone1`,man_construction_worker_medium_dark_skin_tone:`man_construction_worker_tone4`,man_construction_worker_medium_light_skin_tone:`man_construction_worker_tone2`,man_construction_worker_medium_skin_tone:`man_construction_worker_tone3`,man_construction_worker_tone1:`man_construction_worker_tone1`,man_construction_worker_tone2:`man_construction_worker_tone2`,man_construction_worker_tone3:`man_construction_worker_tone3`,man_construction_worker_tone4:`man_construction_worker_tone4`,man_construction_worker_tone5:`man_construction_worker_tone5`,man_cook:`man_cook`,man_cook_dark_skin_tone:`man_cook_tone5`,man_cook_light_skin_tone:`man_cook_tone1`,man_cook_medium_dark_skin_tone:`man_cook_tone4`,man_cook_medium_light_skin_tone:`man_cook_tone2`,man_cook_medium_skin_tone:`man_cook_tone3`,man_cook_tone1:`man_cook_tone1`,man_cook_tone2:`man_cook_tone2`,man_cook_tone3:`man_cook_tone3`,man_cook_tone4:`man_cook_tone4`,man_cook_tone5:`man_cook_tone5`,man_curly_haired:`man_curly_haired`,man_curly_haired_dark_skin_tone:`man_curly_haired_tone5`,man_curly_haired_light_skin_tone:`man_curly_haired_tone1`,man_curly_haired_medium_dark_skin_tone:`man_curly_haired_tone4`,man_curly_haired_medium_light_skin_tone:`man_curly_haired_tone2`,man_curly_haired_medium_skin_tone:`man_curly_haired_tone3`,man_curly_haired_tone1:`man_curly_haired_tone1`,man_curly_haired_tone2:`man_curly_haired_tone2`,man_curly_haired_tone3:`man_curly_haired_tone3`,man_curly_haired_tone4:`man_curly_haired_tone4`,man_curly_haired_tone5:`man_curly_haired_tone5`,man_dancing:`man_dancing`,man_dancing_tone1:`man_dancing_tone1`,man_dancing_tone2:`man_dancing_tone2`,man_dancing_tone3:`man_dancing_tone3`,man_dancing_tone4:`man_dancing_tone4`,man_dancing_tone5:`man_dancing_tone5`,man_dark_skin_tone_beard:`man_tone5_beard`,man_detective:`man_detective`,man_detective_dark_skin_tone:`man_detective_tone5`,man_detective_light_skin_tone:`man_detective_tone1`,man_detective_medium_dark_skin_tone:`man_detective_tone4`,man_detective_medium_light_skin_tone:`man_detective_tone2`,man_detective_medium_skin_tone:`man_detective_tone3`,man_detective_tone1:`man_detective_tone1`,man_detective_tone2:`man_detective_tone2`,man_detective_tone3:`man_detective_tone3`,man_detective_tone4:`man_detective_tone4`,man_detective_tone5:`man_detective_tone5`,man_elf:`man_elf`,man_elf_dark_skin_tone:`man_elf_tone5`,man_elf_light_skin_tone:`man_elf_tone1`,man_elf_medium_dark_skin_tone:`man_elf_tone4`,man_elf_medium_light_skin_tone:`man_elf_tone2`,man_elf_medium_skin_tone:`man_elf_tone3`,man_elf_tone1:`man_elf_tone1`,man_elf_tone2:`man_elf_tone2`,man_elf_tone3:`man_elf_tone3`,man_elf_tone4:`man_elf_tone4`,man_elf_tone5:`man_elf_tone5`,man_facepalming:`man_facepalming`,man_facepalming_dark_skin_tone:`man_facepalming_tone5`,man_facepalming_light_skin_tone:`man_facepalming_tone1`,man_facepalming_medium_dark_skin_tone:`man_facepalming_tone4`,man_facepalming_medium_light_skin_tone:`man_facepalming_tone2`,man_facepalming_medium_skin_tone:`man_facepalming_tone3`,man_facepalming_tone1:`man_facepalming_tone1`,man_facepalming_tone2:`man_facepalming_tone2`,man_facepalming_tone3:`man_facepalming_tone3`,man_facepalming_tone4:`man_facepalming_tone4`,man_facepalming_tone5:`man_facepalming_tone5`,man_factory_worker:`man_factory_worker`,man_factory_worker_dark_skin_tone:`man_factory_worker_tone5`,man_factory_worker_light_skin_tone:`man_factory_worker_tone1`,man_factory_worker_medium_dark_skin_tone:`man_factory_worker_tone4`,man_factory_worker_medium_light_skin_tone:`man_factory_worker_tone2`,man_factory_worker_medium_skin_tone:`man_factory_worker_tone3`,man_factory_worker_tone1:`man_factory_worker_tone1`,man_factory_worker_tone2:`man_factory_worker_tone2`,man_factory_worker_tone3:`man_factory_worker_tone3`,man_factory_worker_tone4:`man_factory_worker_tone4`,man_factory_worker_tone5:`man_factory_worker_tone5`,man_fairy:`man_fairy`,man_fairy_dark_skin_tone:`man_fairy_tone5`,man_fairy_light_skin_tone:`man_fairy_tone1`,man_fairy_medium_dark_skin_tone:`man_fairy_tone4`,man_fairy_medium_light_skin_tone:`man_fairy_tone2`,man_fairy_medium_skin_tone:`man_fairy_tone3`,man_fairy_tone1:`man_fairy_tone1`,man_fairy_tone2:`man_fairy_tone2`,man_fairy_tone3:`man_fairy_tone3`,man_fairy_tone4:`man_fairy_tone4`,man_fairy_tone5:`man_fairy_tone5`,man_farmer:`man_farmer`,man_farmer_dark_skin_tone:`man_farmer_tone5`,man_farmer_light_skin_tone:`man_farmer_tone1`,man_farmer_medium_dark_skin_tone:`man_farmer_tone4`,man_farmer_medium_light_skin_tone:`man_farmer_tone2`,man_farmer_medium_skin_tone:`man_farmer_tone3`,man_farmer_tone1:`man_farmer_tone1`,man_farmer_tone2:`man_farmer_tone2`,man_farmer_tone3:`man_farmer_tone3`,man_farmer_tone4:`man_farmer_tone4`,man_farmer_tone5:`man_farmer_tone5`,man_feeding_baby:`man_feeding_baby`,man_feeding_baby_dark_skin_tone:`man_feeding_baby_tone5`,man_feeding_baby_light_skin_tone:`man_feeding_baby_tone1`,man_feeding_baby_medium_dark_skin_tone:`man_feeding_baby_tone4`,man_feeding_baby_medium_light_skin_tone:`man_feeding_baby_tone2`,man_feeding_baby_medium_skin_tone:`man_feeding_baby_tone3`,man_feeding_baby_tone1:`man_feeding_baby_tone1`,man_feeding_baby_tone2:`man_feeding_baby_tone2`,man_feeding_baby_tone3:`man_feeding_baby_tone3`,man_feeding_baby_tone4:`man_feeding_baby_tone4`,man_feeding_baby_tone5:`man_feeding_baby_tone5`,man_firefighter:`man_firefighter`,man_firefighter_dark_skin_tone:`man_firefighter_tone5`,man_firefighter_light_skin_tone:`man_firefighter_tone1`,man_firefighter_medium_dark_skin_tone:`man_firefighter_tone4`,man_firefighter_medium_light_skin_tone:`man_firefighter_tone2`,man_firefighter_medium_skin_tone:`man_firefighter_tone3`,man_firefighter_tone1:`man_firefighter_tone1`,man_firefighter_tone2:`man_firefighter_tone2`,man_firefighter_tone3:`man_firefighter_tone3`,man_firefighter_tone4:`man_firefighter_tone4`,man_firefighter_tone5:`man_firefighter_tone5`,man_frowning:`man_frowning`,man_frowning_dark_skin_tone:`man_frowning_tone5`,man_frowning_light_skin_tone:`man_frowning_tone1`,man_frowning_medium_dark_skin_tone:`man_frowning_tone4`,man_frowning_medium_light_skin_tone:`man_frowning_tone2`,man_frowning_medium_skin_tone:`man_frowning_tone3`,man_frowning_tone1:`man_frowning_tone1`,man_frowning_tone2:`man_frowning_tone2`,man_frowning_tone3:`man_frowning_tone3`,man_frowning_tone4:`man_frowning_tone4`,man_frowning_tone5:`man_frowning_tone5`,man_genie:`man_genie`,man_gesturing_no:`man_gesturing_no`,man_gesturing_no_dark_skin_tone:`man_gesturing_no_tone5`,man_gesturing_no_light_skin_tone:`man_gesturing_no_tone1`,man_gesturing_no_medium_dark_skin_tone:`man_gesturing_no_tone4`,man_gesturing_no_medium_light_skin_tone:`man_gesturing_no_tone2`,man_gesturing_no_medium_skin_tone:`man_gesturing_no_tone3`,man_gesturing_no_tone1:`man_gesturing_no_tone1`,man_gesturing_no_tone2:`man_gesturing_no_tone2`,man_gesturing_no_tone3:`man_gesturing_no_tone3`,man_gesturing_no_tone4:`man_gesturing_no_tone4`,man_gesturing_no_tone5:`man_gesturing_no_tone5`,man_gesturing_ok:`man_gesturing_ok`,man_gesturing_ok_dark_skin_tone:`man_gesturing_ok_tone5`,man_gesturing_ok_light_skin_tone:`man_gesturing_ok_tone1`,man_gesturing_ok_medium_dark_skin_tone:`man_gesturing_ok_tone4`,man_gesturing_ok_medium_light_skin_tone:`man_gesturing_ok_tone2`,man_gesturing_ok_medium_skin_tone:`man_gesturing_ok_tone3`,man_gesturing_ok_tone1:`man_gesturing_ok_tone1`,man_gesturing_ok_tone2:`man_gesturing_ok_tone2`,man_gesturing_ok_tone3:`man_gesturing_ok_tone3`,man_gesturing_ok_tone4:`man_gesturing_ok_tone4`,man_gesturing_ok_tone5:`man_gesturing_ok_tone5`,man_getting_face_massage:`man_getting_face_massage`,man_getting_face_massage_dark_skin_tone:`man_getting_face_massage_tone5`,man_getting_face_massage_light_skin_tone:`man_getting_face_massage_tone1`,man_getting_face_massage_medium_dark_skin_tone:`man_getting_face_massage_tone4`,man_getting_face_massage_medium_light_skin_tone:`man_getting_face_massage_tone2`,man_getting_face_massage_medium_skin_tone:`man_getting_face_massage_tone3`,man_getting_face_massage_tone1:`man_getting_face_massage_tone1`,man_getting_face_massage_tone2:`man_getting_face_massage_tone2`,man_getting_face_massage_tone3:`man_getting_face_massage_tone3`,man_getting_face_massage_tone4:`man_getting_face_massage_tone4`,man_getting_face_massage_tone5:`man_getting_face_massage_tone5`,man_getting_haircut:`man_getting_haircut`,man_getting_haircut_dark_skin_tone:`man_getting_haircut_tone5`,man_getting_haircut_light_skin_tone:`man_getting_haircut_tone1`,man_getting_haircut_medium_dark_skin_tone:`man_getting_haircut_tone4`,man_getting_haircut_medium_light_skin_tone:`man_getting_haircut_tone2`,man_getting_haircut_medium_skin_tone:`man_getting_haircut_tone3`,man_getting_haircut_tone1:`man_getting_haircut_tone1`,man_getting_haircut_tone2:`man_getting_haircut_tone2`,man_getting_haircut_tone3:`man_getting_haircut_tone3`,man_getting_haircut_tone4:`man_getting_haircut_tone4`,man_getting_haircut_tone5:`man_getting_haircut_tone5`,man_golfing:`man_golfing`,man_golfing_dark_skin_tone:`man_golfing_tone5`,man_golfing_light_skin_tone:`man_golfing_tone1`,man_golfing_medium_dark_skin_tone:`man_golfing_tone4`,man_golfing_medium_light_skin_tone:`man_golfing_tone2`,man_golfing_medium_skin_tone:`man_golfing_tone3`,man_golfing_tone1:`man_golfing_tone1`,man_golfing_tone2:`man_golfing_tone2`,man_golfing_tone3:`man_golfing_tone3`,man_golfing_tone4:`man_golfing_tone4`,man_golfing_tone5:`man_golfing_tone5`,man_guard:`man_guard`,man_guard_dark_skin_tone:`man_guard_tone5`,man_guard_light_skin_tone:`man_guard_tone1`,man_guard_medium_dark_skin_tone:`man_guard_tone4`,man_guard_medium_light_skin_tone:`man_guard_tone2`,man_guard_medium_skin_tone:`man_guard_tone3`,man_guard_tone1:`man_guard_tone1`,man_guard_tone2:`man_guard_tone2`,man_guard_tone3:`man_guard_tone3`,man_guard_tone4:`man_guard_tone4`,man_guard_tone5:`man_guard_tone5`,man_health_worker:`man_health_worker`,man_health_worker_dark_skin_tone:`man_health_worker_tone5`,man_health_worker_light_skin_tone:`man_health_worker_tone1`,man_health_worker_medium_dark_skin_tone:`man_health_worker_tone4`,man_health_worker_medium_light_skin_tone:`man_health_worker_tone2`,man_health_worker_medium_skin_tone:`man_health_worker_tone3`,man_health_worker_tone1:`man_health_worker_tone1`,man_health_worker_tone2:`man_health_worker_tone2`,man_health_worker_tone3:`man_health_worker_tone3`,man_health_worker_tone4:`man_health_worker_tone4`,man_health_worker_tone5:`man_health_worker_tone5`,man_in_business_suit_levitating:`levitate`,man_in_business_suit_levitating_dark_skin_tone:`levitate_tone5`,man_in_business_suit_levitating_light_skin_tone:`levitate_tone1`,man_in_business_suit_levitating_medium_dark_skin_tone:`levitate_tone4`,man_in_business_suit_levitating_medium_light_skin_tone:`levitate_tone2`,man_in_business_suit_levitating_medium_skin_tone:`levitate_tone3`,man_in_business_suit_levitating_tone1:`levitate_tone1`,man_in_business_suit_levitating_tone2:`levitate_tone2`,man_in_business_suit_levitating_tone3:`levitate_tone3`,man_in_business_suit_levitating_tone4:`levitate_tone4`,man_in_business_suit_levitating_tone5:`levitate_tone5`,man_in_lotus_position:`man_in_lotus_position`,man_in_lotus_position_dark_skin_tone:`man_in_lotus_position_tone5`,man_in_lotus_position_light_skin_tone:`man_in_lotus_position_tone1`,man_in_lotus_position_medium_dark_skin_tone:`man_in_lotus_position_tone4`,man_in_lotus_position_medium_light_skin_tone:`man_in_lotus_position_tone2`,man_in_lotus_position_medium_skin_tone:`man_in_lotus_position_tone3`,man_in_lotus_position_tone1:`man_in_lotus_position_tone1`,man_in_lotus_position_tone2:`man_in_lotus_position_tone2`,man_in_lotus_position_tone3:`man_in_lotus_position_tone3`,man_in_lotus_position_tone4:`man_in_lotus_position_tone4`,man_in_lotus_position_tone5:`man_in_lotus_position_tone5`,man_in_manual_wheelchair:`man_in_manual_wheelchair`,man_in_manual_wheelchair_dark_skin_tone:`man_in_manual_wheelchair_tone5`,man_in_manual_wheelchair_facing_right:`man_in_manual_wheelchair_facing_right`,man_in_manual_wheelchair_facing_right_dark_skin_tone:`man_in_manual_wheelchair_facing_right_tone5`,man_in_manual_wheelchair_facing_right_light_skin_tone:`man_in_manual_wheelchair_facing_right_tone1`,man_in_manual_wheelchair_facing_right_medium_dark_skin_tone:`man_in_manual_wheelchair_facing_right_tone4`,man_in_manual_wheelchair_facing_right_medium_light_skin_tone:`man_in_manual_wheelchair_facing_right_tone2`,man_in_manual_wheelchair_facing_right_medium_skin_tone:`man_in_manual_wheelchair_facing_right_tone3`,man_in_manual_wheelchair_facing_right_tone1:`man_in_manual_wheelchair_facing_right_tone1`,man_in_manual_wheelchair_facing_right_tone2:`man_in_manual_wheelchair_facing_right_tone2`,man_in_manual_wheelchair_facing_right_tone3:`man_in_manual_wheelchair_facing_right_tone3`,man_in_manual_wheelchair_facing_right_tone4:`man_in_manual_wheelchair_facing_right_tone4`,man_in_manual_wheelchair_facing_right_tone5:`man_in_manual_wheelchair_facing_right_tone5`,man_in_manual_wheelchair_light_skin_tone:`man_in_manual_wheelchair_tone1`,man_in_manual_wheelchair_medium_dark_skin_tone:`man_in_manual_wheelchair_tone4`,man_in_manual_wheelchair_medium_light_skin_tone:`man_in_manual_wheelchair_tone2`,man_in_manual_wheelchair_medium_skin_tone:`man_in_manual_wheelchair_tone3`,man_in_manual_wheelchair_tone1:`man_in_manual_wheelchair_tone1`,man_in_manual_wheelchair_tone2:`man_in_manual_wheelchair_tone2`,man_in_manual_wheelchair_tone3:`man_in_manual_wheelchair_tone3`,man_in_manual_wheelchair_tone4:`man_in_manual_wheelchair_tone4`,man_in_manual_wheelchair_tone5:`man_in_manual_wheelchair_tone5`,man_in_motorized_wheelchair:`man_in_motorized_wheelchair`,man_in_motorized_wheelchair_dark_skin_tone:`man_in_motorized_wheelchair_tone5`,man_in_motorized_wheelchair_facing_right:`man_in_motorized_wheelchair_facing_right`,man_in_motorized_wheelchair_facing_right_dark_skin_tone:`man_in_motorized_wheelchair_facing_right_tone5`,man_in_motorized_wheelchair_facing_right_light_skin_tone:`man_in_motorized_wheelchair_facing_right_tone1`,man_in_motorized_wheelchair_facing_right_medium_dark_skin_tone:`man_in_motorized_wheelchair_facing_right_tone4`,man_in_motorized_wheelchair_facing_right_medium_light_skin_tone:`man_in_motorized_wheelchair_facing_right_tone2`,man_in_motorized_wheelchair_facing_right_medium_skin_tone:`man_in_motorized_wheelchair_facing_right_tone3`,man_in_motorized_wheelchair_facing_right_tone1:`man_in_motorized_wheelchair_facing_right_tone1`,man_in_motorized_wheelchair_facing_right_tone2:`man_in_motorized_wheelchair_facing_right_tone2`,man_in_motorized_wheelchair_facing_right_tone3:`man_in_motorized_wheelchair_facing_right_tone3`,man_in_motorized_wheelchair_facing_right_tone4:`man_in_motorized_wheelchair_facing_right_tone4`,man_in_motorized_wheelchair_facing_right_tone5:`man_in_motorized_wheelchair_facing_right_tone5`,man_in_motorized_wheelchair_light_skin_tone:`man_in_motorized_wheelchair_tone1`,man_in_motorized_wheelchair_medium_dark_skin_tone:`man_in_motorized_wheelchair_tone4`,man_in_motorized_wheelchair_medium_light_skin_tone:`man_in_motorized_wheelchair_tone2`,man_in_motorized_wheelchair_medium_skin_tone:`man_in_motorized_wheelchair_tone3`,man_in_motorized_wheelchair_tone1:`man_in_motorized_wheelchair_tone1`,man_in_motorized_wheelchair_tone2:`man_in_motorized_wheelchair_tone2`,man_in_motorized_wheelchair_tone3:`man_in_motorized_wheelchair_tone3`,man_in_motorized_wheelchair_tone4:`man_in_motorized_wheelchair_tone4`,man_in_motorized_wheelchair_tone5:`man_in_motorized_wheelchair_tone5`,man_in_steamy_room:`man_in_steamy_room`,man_in_steamy_room_dark_skin_tone:`man_in_steamy_room_tone5`,man_in_steamy_room_light_skin_tone:`man_in_steamy_room_tone1`,man_in_steamy_room_medium_dark_skin_tone:`man_in_steamy_room_tone4`,man_in_steamy_room_medium_light_skin_tone:`man_in_steamy_room_tone2`,man_in_steamy_room_medium_skin_tone:`man_in_steamy_room_tone3`,man_in_steamy_room_tone1:`man_in_steamy_room_tone1`,man_in_steamy_room_tone2:`man_in_steamy_room_tone2`,man_in_steamy_room_tone3:`man_in_steamy_room_tone3`,man_in_steamy_room_tone4:`man_in_steamy_room_tone4`,man_in_steamy_room_tone5:`man_in_steamy_room_tone5`,man_in_tuxedo:`man_in_tuxedo`,man_in_tuxedo_dark_skin_tone:`man_in_tuxedo_tone5`,man_in_tuxedo_light_skin_tone:`man_in_tuxedo_tone1`,man_in_tuxedo_medium_dark_skin_tone:`man_in_tuxedo_tone4`,man_in_tuxedo_medium_light_skin_tone:`man_in_tuxedo_tone2`,man_in_tuxedo_medium_skin_tone:`man_in_tuxedo_tone3`,man_in_tuxedo_tone1:`man_in_tuxedo_tone1`,man_in_tuxedo_tone2:`man_in_tuxedo_tone2`,man_in_tuxedo_tone3:`man_in_tuxedo_tone3`,man_in_tuxedo_tone4:`man_in_tuxedo_tone4`,man_in_tuxedo_tone5:`man_in_tuxedo_tone5`,man_judge:`man_judge`,man_judge_dark_skin_tone:`man_judge_tone5`,man_judge_light_skin_tone:`man_judge_tone1`,man_judge_medium_dark_skin_tone:`man_judge_tone4`,man_judge_medium_light_skin_tone:`man_judge_tone2`,man_judge_medium_skin_tone:`man_judge_tone3`,man_judge_tone1:`man_judge_tone1`,man_judge_tone2:`man_judge_tone2`,man_judge_tone3:`man_judge_tone3`,man_judge_tone4:`man_judge_tone4`,man_judge_tone5:`man_judge_tone5`,man_juggling:`man_juggling`,man_juggling_dark_skin_tone:`man_juggling_tone5`,man_juggling_light_skin_tone:`man_juggling_tone1`,man_juggling_medium_dark_skin_tone:`man_juggling_tone4`,man_juggling_medium_light_skin_tone:`man_juggling_tone2`,man_juggling_medium_skin_tone:`man_juggling_tone3`,man_juggling_tone1:`man_juggling_tone1`,man_juggling_tone2:`man_juggling_tone2`,man_juggling_tone3:`man_juggling_tone3`,man_juggling_tone4:`man_juggling_tone4`,man_juggling_tone5:`man_juggling_tone5`,man_kneeling:`man_kneeling`,man_kneeling_dark_skin_tone:`man_kneeling_tone5`,man_kneeling_facing_right:`man_kneeling_facing_right`,man_kneeling_facing_right_dark_skin_tone:`man_kneeling_facing_right_tone5`,man_kneeling_facing_right_light_skin_tone:`man_kneeling_facing_right_tone1`,man_kneeling_facing_right_medium_dark_skin_tone:`man_kneeling_facing_right_tone4`,man_kneeling_facing_right_medium_light_skin_tone:`man_kneeling_facing_right_tone2`,man_kneeling_facing_right_medium_skin_tone:`man_kneeling_facing_right_tone3`,man_kneeling_facing_right_tone1:`man_kneeling_facing_right_tone1`,man_kneeling_facing_right_tone2:`man_kneeling_facing_right_tone2`,man_kneeling_facing_right_tone3:`man_kneeling_facing_right_tone3`,man_kneeling_facing_right_tone4:`man_kneeling_facing_right_tone4`,man_kneeling_facing_right_tone5:`man_kneeling_facing_right_tone5`,man_kneeling_light_skin_tone:`man_kneeling_tone1`,man_kneeling_medium_dark_skin_tone:`man_kneeling_tone4`,man_kneeling_medium_light_skin_tone:`man_kneeling_tone2`,man_kneeling_medium_skin_tone:`man_kneeling_tone3`,man_kneeling_tone1:`man_kneeling_tone1`,man_kneeling_tone2:`man_kneeling_tone2`,man_kneeling_tone3:`man_kneeling_tone3`,man_kneeling_tone4:`man_kneeling_tone4`,man_kneeling_tone5:`man_kneeling_tone5`,man_lifting_weights:`man_lifting_weights`,man_lifting_weights_dark_skin_tone:`man_lifting_weights_tone5`,man_lifting_weights_light_skin_tone:`man_lifting_weights_tone1`,man_lifting_weights_medium_dark_skin_tone:`man_lifting_weights_tone4`,man_lifting_weights_medium_light_skin_tone:`man_lifting_weights_tone2`,man_lifting_weights_medium_skin_tone:`man_lifting_weights_tone3`,man_lifting_weights_tone1:`man_lifting_weights_tone1`,man_lifting_weights_tone2:`man_lifting_weights_tone2`,man_lifting_weights_tone3:`man_lifting_weights_tone3`,man_lifting_weights_tone4:`man_lifting_weights_tone4`,man_lifting_weights_tone5:`man_lifting_weights_tone5`,man_light_skin_tone_beard:`man_tone1_beard`,man_mage:`man_mage`,man_mage_dark_skin_tone:`man_mage_tone5`,man_mage_light_skin_tone:`man_mage_tone1`,man_mage_medium_dark_skin_tone:`man_mage_tone4`,man_mage_medium_light_skin_tone:`man_mage_tone2`,man_mage_medium_skin_tone:`man_mage_tone3`,man_mage_tone1:`man_mage_tone1`,man_mage_tone2:`man_mage_tone2`,man_mage_tone3:`man_mage_tone3`,man_mage_tone4:`man_mage_tone4`,man_mage_tone5:`man_mage_tone5`,man_mechanic:`man_mechanic`,man_mechanic_dark_skin_tone:`man_mechanic_tone5`,man_mechanic_light_skin_tone:`man_mechanic_tone1`,man_mechanic_medium_dark_skin_tone:`man_mechanic_tone4`,man_mechanic_medium_light_skin_tone:`man_mechanic_tone2`,man_mechanic_medium_skin_tone:`man_mechanic_tone3`,man_mechanic_tone1:`man_mechanic_tone1`,man_mechanic_tone2:`man_mechanic_tone2`,man_mechanic_tone3:`man_mechanic_tone3`,man_mechanic_tone4:`man_mechanic_tone4`,man_mechanic_tone5:`man_mechanic_tone5`,man_medium_dark_skin_tone_beard:`man_tone4_beard`,man_medium_light_skin_tone_beard:`man_tone2_beard`,man_medium_skin_tone_beard:`man_tone3_beard`,man_mountain_biking:`man_mountain_biking`,man_mountain_biking_dark_skin_tone:`man_mountain_biking_tone5`,man_mountain_biking_light_skin_tone:`man_mountain_biking_tone1`,man_mountain_biking_medium_dark_skin_tone:`man_mountain_biking_tone4`,man_mountain_biking_medium_light_skin_tone:`man_mountain_biking_tone2`,man_mountain_biking_medium_skin_tone:`man_mountain_biking_tone3`,man_mountain_biking_tone1:`man_mountain_biking_tone1`,man_mountain_biking_tone2:`man_mountain_biking_tone2`,man_mountain_biking_tone3:`man_mountain_biking_tone3`,man_mountain_biking_tone4:`man_mountain_biking_tone4`,man_mountain_biking_tone5:`man_mountain_biking_tone5`,man_office_worker:`man_office_worker`,man_office_worker_dark_skin_tone:`man_office_worker_tone5`,man_office_worker_light_skin_tone:`man_office_worker_tone1`,man_office_worker_medium_dark_skin_tone:`man_office_worker_tone4`,man_office_worker_medium_light_skin_tone:`man_office_worker_tone2`,man_office_worker_medium_skin_tone:`man_office_worker_tone3`,man_office_worker_tone1:`man_office_worker_tone1`,man_office_worker_tone2:`man_office_worker_tone2`,man_office_worker_tone3:`man_office_worker_tone3`,man_office_worker_tone4:`man_office_worker_tone4`,man_office_worker_tone5:`man_office_worker_tone5`,man_pilot:`man_pilot`,man_pilot_dark_skin_tone:`man_pilot_tone5`,man_pilot_light_skin_tone:`man_pilot_tone1`,man_pilot_medium_dark_skin_tone:`man_pilot_tone4`,man_pilot_medium_light_skin_tone:`man_pilot_tone2`,man_pilot_medium_skin_tone:`man_pilot_tone3`,man_pilot_tone1:`man_pilot_tone1`,man_pilot_tone2:`man_pilot_tone2`,man_pilot_tone3:`man_pilot_tone3`,man_pilot_tone4:`man_pilot_tone4`,man_pilot_tone5:`man_pilot_tone5`,man_playing_handball:`man_playing_handball`,man_playing_handball_dark_skin_tone:`man_playing_handball_tone5`,man_playing_handball_light_skin_tone:`man_playing_handball_tone1`,man_playing_handball_medium_dark_skin_tone:`man_playing_handball_tone4`,man_playing_handball_medium_light_skin_tone:`man_playing_handball_tone2`,man_playing_handball_medium_skin_tone:`man_playing_handball_tone3`,man_playing_handball_tone1:`man_playing_handball_tone1`,man_playing_handball_tone2:`man_playing_handball_tone2`,man_playing_handball_tone3:`man_playing_handball_tone3`,man_playing_handball_tone4:`man_playing_handball_tone4`,man_playing_handball_tone5:`man_playing_handball_tone5`,man_playing_water_polo:`man_playing_water_polo`,man_playing_water_polo_dark_skin_tone:`man_playing_water_polo_tone5`,man_playing_water_polo_light_skin_tone:`man_playing_water_polo_tone1`,man_playing_water_polo_medium_dark_skin_tone:`man_playing_water_polo_tone4`,man_playing_water_polo_medium_light_skin_tone:`man_playing_water_polo_tone2`,man_playing_water_polo_medium_skin_tone:`man_playing_water_polo_tone3`,man_playing_water_polo_tone1:`man_playing_water_polo_tone1`,man_playing_water_polo_tone2:`man_playing_water_polo_tone2`,man_playing_water_polo_tone3:`man_playing_water_polo_tone3`,man_playing_water_polo_tone4:`man_playing_water_polo_tone4`,man_playing_water_polo_tone5:`man_playing_water_polo_tone5`,man_police_officer:`man_police_officer`,man_police_officer_dark_skin_tone:`man_police_officer_tone5`,man_police_officer_light_skin_tone:`man_police_officer_tone1`,man_police_officer_medium_dark_skin_tone:`man_police_officer_tone4`,man_police_officer_medium_light_skin_tone:`man_police_officer_tone2`,man_police_officer_medium_skin_tone:`man_police_officer_tone3`,man_police_officer_tone1:`man_police_officer_tone1`,man_police_officer_tone2:`man_police_officer_tone2`,man_police_officer_tone3:`man_police_officer_tone3`,man_police_officer_tone4:`man_police_officer_tone4`,man_police_officer_tone5:`man_police_officer_tone5`,man_pouting:`man_pouting`,man_pouting_dark_skin_tone:`man_pouting_tone5`,man_pouting_light_skin_tone:`man_pouting_tone1`,man_pouting_medium_dark_skin_tone:`man_pouting_tone4`,man_pouting_medium_light_skin_tone:`man_pouting_tone2`,man_pouting_medium_skin_tone:`man_pouting_tone3`,man_pouting_tone1:`man_pouting_tone1`,man_pouting_tone2:`man_pouting_tone2`,man_pouting_tone3:`man_pouting_tone3`,man_pouting_tone4:`man_pouting_tone4`,man_pouting_tone5:`man_pouting_tone5`,man_raising_hand:`man_raising_hand`,man_raising_hand_dark_skin_tone:`man_raising_hand_tone5`,man_raising_hand_light_skin_tone:`man_raising_hand_tone1`,man_raising_hand_medium_dark_skin_tone:`man_raising_hand_tone4`,man_raising_hand_medium_light_skin_tone:`man_raising_hand_tone2`,man_raising_hand_medium_skin_tone:`man_raising_hand_tone3`,man_raising_hand_tone1:`man_raising_hand_tone1`,man_raising_hand_tone2:`man_raising_hand_tone2`,man_raising_hand_tone3:`man_raising_hand_tone3`,man_raising_hand_tone4:`man_raising_hand_tone4`,man_raising_hand_tone5:`man_raising_hand_tone5`,man_red_hair:`man_red_haired`,man_red_haired:`man_red_haired`,man_red_haired_dark_skin_tone:`man_red_haired_tone5`,man_red_haired_light_skin_tone:`man_red_haired_tone1`,man_red_haired_medium_dark_skin_tone:`man_red_haired_tone4`,man_red_haired_medium_light_skin_tone:`man_red_haired_tone2`,man_red_haired_medium_skin_tone:`man_red_haired_tone3`,man_red_haired_tone1:`man_red_haired_tone1`,man_red_haired_tone2:`man_red_haired_tone2`,man_red_haired_tone3:`man_red_haired_tone3`,man_red_haired_tone4:`man_red_haired_tone4`,man_red_haired_tone5:`man_red_haired_tone5`,man_rowing_boat:`man_rowing_boat`,man_rowing_boat_dark_skin_tone:`man_rowing_boat_tone5`,man_rowing_boat_light_skin_tone:`man_rowing_boat_tone1`,man_rowing_boat_medium_dark_skin_tone:`man_rowing_boat_tone4`,man_rowing_boat_medium_light_skin_tone:`man_rowing_boat_tone2`,man_rowing_boat_medium_skin_tone:`man_rowing_boat_tone3`,man_rowing_boat_tone1:`man_rowing_boat_tone1`,man_rowing_boat_tone2:`man_rowing_boat_tone2`,man_rowing_boat_tone3:`man_rowing_boat_tone3`,man_rowing_boat_tone4:`man_rowing_boat_tone4`,man_rowing_boat_tone5:`man_rowing_boat_tone5`,man_running:`man_running`,man_running_dark_skin_tone:`man_running_tone5`,man_running_facing_right:`man_running_facing_right`,man_running_facing_right_dark_skin_tone:`man_running_facing_right_tone5`,man_running_facing_right_light_skin_tone:`man_running_facing_right_tone1`,man_running_facing_right_medium_dark_skin_tone:`man_running_facing_right_tone4`,man_running_facing_right_medium_light_skin_tone:`man_running_facing_right_tone2`,man_running_facing_right_medium_skin_tone:`man_running_facing_right_tone3`,man_running_facing_right_tone1:`man_running_facing_right_tone1`,man_running_facing_right_tone2:`man_running_facing_right_tone2`,man_running_facing_right_tone3:`man_running_facing_right_tone3`,man_running_facing_right_tone4:`man_running_facing_right_tone4`,man_running_facing_right_tone5:`man_running_facing_right_tone5`,man_running_light_skin_tone:`man_running_tone1`,man_running_medium_dark_skin_tone:`man_running_tone4`,man_running_medium_light_skin_tone:`man_running_tone2`,man_running_medium_skin_tone:`man_running_tone3`,man_running_tone1:`man_running_tone1`,man_running_tone2:`man_running_tone2`,man_running_tone3:`man_running_tone3`,man_running_tone4:`man_running_tone4`,man_running_tone5:`man_running_tone5`,man_scientist:`man_scientist`,man_scientist_dark_skin_tone:`man_scientist_tone5`,man_scientist_light_skin_tone:`man_scientist_tone1`,man_scientist_medium_dark_skin_tone:`man_scientist_tone4`,man_scientist_medium_light_skin_tone:`man_scientist_tone2`,man_scientist_medium_skin_tone:`man_scientist_tone3`,man_scientist_tone1:`man_scientist_tone1`,man_scientist_tone2:`man_scientist_tone2`,man_scientist_tone3:`man_scientist_tone3`,man_scientist_tone4:`man_scientist_tone4`,man_scientist_tone5:`man_scientist_tone5`,man_shrugging:`man_shrugging`,man_shrugging_dark_skin_tone:`man_shrugging_tone5`,man_shrugging_light_skin_tone:`man_shrugging_tone1`,man_shrugging_medium_dark_skin_tone:`man_shrugging_tone4`,man_shrugging_medium_light_skin_tone:`man_shrugging_tone2`,man_shrugging_medium_skin_tone:`man_shrugging_tone3`,man_shrugging_tone1:`man_shrugging_tone1`,man_shrugging_tone2:`man_shrugging_tone2`,man_shrugging_tone3:`man_shrugging_tone3`,man_shrugging_tone4:`man_shrugging_tone4`,man_shrugging_tone5:`man_shrugging_tone5`,man_singer:`man_singer`,man_singer_dark_skin_tone:`man_singer_tone5`,man_singer_light_skin_tone:`man_singer_tone1`,man_singer_medium_dark_skin_tone:`man_singer_tone4`,man_singer_medium_light_skin_tone:`man_singer_tone2`,man_singer_medium_skin_tone:`man_singer_tone3`,man_singer_tone1:`man_singer_tone1`,man_singer_tone2:`man_singer_tone2`,man_singer_tone3:`man_singer_tone3`,man_singer_tone4:`man_singer_tone4`,man_singer_tone5:`man_singer_tone5`,man_standing:`man_standing`,man_standing_dark_skin_tone:`man_standing_tone5`,man_standing_light_skin_tone:`man_standing_tone1`,man_standing_medium_dark_skin_tone:`man_standing_tone4`,man_standing_medium_light_skin_tone:`man_standing_tone2`,man_standing_medium_skin_tone:`man_standing_tone3`,man_standing_tone1:`man_standing_tone1`,man_standing_tone2:`man_standing_tone2`,man_standing_tone3:`man_standing_tone3`,man_standing_tone4:`man_standing_tone4`,man_standing_tone5:`man_standing_tone5`,man_student:`man_student`,man_student_dark_skin_tone:`man_student_tone5`,man_student_light_skin_tone:`man_student_tone1`,man_student_medium_dark_skin_tone:`man_student_tone4`,man_student_medium_light_skin_tone:`man_student_tone2`,man_student_medium_skin_tone:`man_student_tone3`,man_student_tone1:`man_student_tone1`,man_student_tone2:`man_student_tone2`,man_student_tone3:`man_student_tone3`,man_student_tone4:`man_student_tone4`,man_student_tone5:`man_student_tone5`,man_superhero:`man_superhero`,man_superhero_dark_skin_tone:`man_superhero_tone5`,man_superhero_light_skin_tone:`man_superhero_tone1`,man_superhero_medium_dark_skin_tone:`man_superhero_tone4`,man_superhero_medium_light_skin_tone:`man_superhero_tone2`,man_superhero_medium_skin_tone:`man_superhero_tone3`,man_superhero_tone1:`man_superhero_tone1`,man_superhero_tone2:`man_superhero_tone2`,man_superhero_tone3:`man_superhero_tone3`,man_superhero_tone4:`man_superhero_tone4`,man_superhero_tone5:`man_superhero_tone5`,man_supervillain:`man_supervillain`,man_supervillain_dark_skin_tone:`man_supervillain_tone5`,man_supervillain_light_skin_tone:`man_supervillain_tone1`,man_supervillain_medium_dark_skin_tone:`man_supervillain_tone4`,man_supervillain_medium_light_skin_tone:`man_supervillain_tone2`,man_supervillain_medium_skin_tone:`man_supervillain_tone3`,man_supervillain_tone1:`man_supervillain_tone1`,man_supervillain_tone2:`man_supervillain_tone2`,man_supervillain_tone3:`man_supervillain_tone3`,man_supervillain_tone4:`man_supervillain_tone4`,man_supervillain_tone5:`man_supervillain_tone5`,man_surfing:`man_surfing`,man_surfing_dark_skin_tone:`man_surfing_tone5`,man_surfing_light_skin_tone:`man_surfing_tone1`,man_surfing_medium_dark_skin_tone:`man_surfing_tone4`,man_surfing_medium_light_skin_tone:`man_surfing_tone2`,man_surfing_medium_skin_tone:`man_surfing_tone3`,man_surfing_tone1:`man_surfing_tone1`,man_surfing_tone2:`man_surfing_tone2`,man_surfing_tone3:`man_surfing_tone3`,man_surfing_tone4:`man_surfing_tone4`,man_surfing_tone5:`man_surfing_tone5`,man_swimming:`man_swimming`,man_swimming_dark_skin_tone:`man_swimming_tone5`,man_swimming_light_skin_tone:`man_swimming_tone1`,man_swimming_medium_dark_skin_tone:`man_swimming_tone4`,man_swimming_medium_light_skin_tone:`man_swimming_tone2`,man_swimming_medium_skin_tone:`man_swimming_tone3`,man_swimming_tone1:`man_swimming_tone1`,man_swimming_tone2:`man_swimming_tone2`,man_swimming_tone3:`man_swimming_tone3`,man_swimming_tone4:`man_swimming_tone4`,man_swimming_tone5:`man_swimming_tone5`,man_teacher:`man_teacher`,man_teacher_dark_skin_tone:`man_teacher_tone5`,man_teacher_light_skin_tone:`man_teacher_tone1`,man_teacher_medium_dark_skin_tone:`man_teacher_tone4`,man_teacher_medium_light_skin_tone:`man_teacher_tone2`,man_teacher_medium_skin_tone:`man_teacher_tone3`,man_teacher_tone1:`man_teacher_tone1`,man_teacher_tone2:`man_teacher_tone2`,man_teacher_tone3:`man_teacher_tone3`,man_teacher_tone4:`man_teacher_tone4`,man_teacher_tone5:`man_teacher_tone5`,man_technologist:`man_technologist`,man_technologist_dark_skin_tone:`man_technologist_tone5`,man_technologist_light_skin_tone:`man_technologist_tone1`,man_technologist_medium_dark_skin_tone:`man_technologist_tone4`,man_technologist_medium_light_skin_tone:`man_technologist_tone2`,man_technologist_medium_skin_tone:`man_technologist_tone3`,man_technologist_tone1:`man_technologist_tone1`,man_technologist_tone2:`man_technologist_tone2`,man_technologist_tone3:`man_technologist_tone3`,man_technologist_tone4:`man_technologist_tone4`,man_technologist_tone5:`man_technologist_tone5`,man_tipping_hand:`man_tipping_hand`,man_tipping_hand_dark_skin_tone:`man_tipping_hand_tone5`,man_tipping_hand_light_skin_tone:`man_tipping_hand_tone1`,man_tipping_hand_medium_dark_skin_tone:`man_tipping_hand_tone4`,man_tipping_hand_medium_light_skin_tone:`man_tipping_hand_tone2`,man_tipping_hand_medium_skin_tone:`man_tipping_hand_tone3`,man_tipping_hand_tone1:`man_tipping_hand_tone1`,man_tipping_hand_tone2:`man_tipping_hand_tone2`,man_tipping_hand_tone3:`man_tipping_hand_tone3`,man_tipping_hand_tone4:`man_tipping_hand_tone4`,man_tipping_hand_tone5:`man_tipping_hand_tone5`,man_tone1:`man_tone1`,man_tone1_beard:`man_tone1_beard`,man_tone2:`man_tone2`,man_tone2_beard:`man_tone2_beard`,man_tone3:`man_tone3`,man_tone3_beard:`man_tone3_beard`,man_tone4:`man_tone4`,man_tone4_beard:`man_tone4_beard`,man_tone5:`man_tone5`,man_tone5_beard:`man_tone5_beard`,man_vampire:`man_vampire`,man_vampire_dark_skin_tone:`man_vampire_tone5`,man_vampire_light_skin_tone:`man_vampire_tone1`,man_vampire_medium_dark_skin_tone:`man_vampire_tone4`,man_vampire_medium_light_skin_tone:`man_vampire_tone2`,man_vampire_medium_skin_tone:`man_vampire_tone3`,man_vampire_tone1:`man_vampire_tone1`,man_vampire_tone2:`man_vampire_tone2`,man_vampire_tone3:`man_vampire_tone3`,man_vampire_tone4:`man_vampire_tone4`,man_vampire_tone5:`man_vampire_tone5`,man_walking:`man_walking`,man_walking_dark_skin_tone:`man_walking_tone5`,man_walking_facing_right:`man_walking_facing_right`,man_walking_facing_right_dark_skin_tone:`man_walking_facing_right_tone5`,man_walking_facing_right_light_skin_tone:`man_walking_facing_right_tone1`,man_walking_facing_right_medium_dark_skin_tone:`man_walking_facing_right_tone4`,man_walking_facing_right_medium_light_skin_tone:`man_walking_facing_right_tone2`,man_walking_facing_right_medium_skin_tone:`man_walking_facing_right_tone3`,man_walking_facing_right_tone1:`man_walking_facing_right_tone1`,man_walking_facing_right_tone2:`man_walking_facing_right_tone2`,man_walking_facing_right_tone3:`man_walking_facing_right_tone3`,man_walking_facing_right_tone4:`man_walking_facing_right_tone4`,man_walking_facing_right_tone5:`man_walking_facing_right_tone5`,man_walking_light_skin_tone:`man_walking_tone1`,man_walking_medium_dark_skin_tone:`man_walking_tone4`,man_walking_medium_light_skin_tone:`man_walking_tone2`,man_walking_medium_skin_tone:`man_walking_tone3`,man_walking_tone1:`man_walking_tone1`,man_walking_tone2:`man_walking_tone2`,man_walking_tone3:`man_walking_tone3`,man_walking_tone4:`man_walking_tone4`,man_walking_tone5:`man_walking_tone5`,man_wearing_turban:`man_wearing_turban`,man_wearing_turban_dark_skin_tone:`man_wearing_turban_tone5`,man_wearing_turban_light_skin_tone:`man_wearing_turban_tone1`,man_wearing_turban_medium_dark_skin_tone:`man_wearing_turban_tone4`,man_wearing_turban_medium_light_skin_tone:`man_wearing_turban_tone2`,man_wearing_turban_medium_skin_tone:`man_wearing_turban_tone3`,man_wearing_turban_tone1:`man_wearing_turban_tone1`,man_wearing_turban_tone2:`man_wearing_turban_tone2`,man_wearing_turban_tone3:`man_wearing_turban_tone3`,man_wearing_turban_tone4:`man_wearing_turban_tone4`,man_wearing_turban_tone5:`man_wearing_turban_tone5`,man_white_haired:`man_white_haired`,man_white_haired_dark_skin_tone:`man_white_haired_tone5`,man_white_haired_light_skin_tone:`man_white_haired_tone1`,man_white_haired_medium_dark_skin_tone:`man_white_haired_tone4`,man_white_haired_medium_light_skin_tone:`man_white_haired_tone2`,man_white_haired_medium_skin_tone:`man_white_haired_tone3`,man_white_haired_tone1:`man_white_haired_tone1`,man_white_haired_tone2:`man_white_haired_tone2`,man_white_haired_tone3:`man_white_haired_tone3`,man_white_haired_tone4:`man_white_haired_tone4`,man_white_haired_tone5:`man_white_haired_tone5`,man_with_chinese_cap:`man_with_chinese_cap`,man_with_chinese_cap_tone1:`man_with_chinese_cap_tone1`,man_with_chinese_cap_tone2:`man_with_chinese_cap_tone2`,man_with_chinese_cap_tone3:`man_with_chinese_cap_tone3`,man_with_chinese_cap_tone4:`man_with_chinese_cap_tone4`,man_with_chinese_cap_tone5:`man_with_chinese_cap_tone5`,man_with_gua_pi_mao:`man_with_chinese_cap`,man_with_gua_pi_mao_tone1:`man_with_chinese_cap_tone1`,man_with_gua_pi_mao_tone2:`man_with_chinese_cap_tone2`,man_with_gua_pi_mao_tone3:`man_with_chinese_cap_tone3`,man_with_gua_pi_mao_tone4:`man_with_chinese_cap_tone4`,man_with_gua_pi_mao_tone5:`man_with_chinese_cap_tone5`,man_with_probing_cane:`man_with_probing_cane`,man_with_probing_cane_dark_skin_tone:`man_with_probing_cane_tone5`,man_with_probing_cane_light_skin_tone:`man_with_probing_cane_tone1`,man_with_probing_cane_medium_dark_skin_tone:`man_with_probing_cane_tone4`,man_with_probing_cane_medium_light_skin_tone:`man_with_probing_cane_tone2`,man_with_probing_cane_medium_skin_tone:`man_with_probing_cane_tone3`,man_with_probing_cane_tone1:`man_with_probing_cane_tone1`,man_with_probing_cane_tone2:`man_with_probing_cane_tone2`,man_with_probing_cane_tone3:`man_with_probing_cane_tone3`,man_with_probing_cane_tone4:`man_with_probing_cane_tone4`,man_with_probing_cane_tone5:`man_with_probing_cane_tone5`,man_with_turban:`person_wearing_turban`,man_with_turban_tone1:`person_wearing_turban_tone1`,man_with_turban_tone2:`person_wearing_turban_tone2`,man_with_turban_tone3:`person_wearing_turban_tone3`,man_with_turban_tone4:`person_wearing_turban_tone4`,man_with_turban_tone5:`person_wearing_turban_tone5`,man_with_veil:`man_with_veil`,man_with_veil_dark_skin_tone:`man_with_veil_tone5`,man_with_veil_light_skin_tone:`man_with_veil_tone1`,man_with_veil_medium_dark_skin_tone:`man_with_veil_tone4`,man_with_veil_medium_light_skin_tone:`man_with_veil_tone2`,man_with_veil_medium_skin_tone:`man_with_veil_tone3`,man_with_veil_tone1:`man_with_veil_tone1`,man_with_veil_tone2:`man_with_veil_tone2`,man_with_veil_tone3:`man_with_veil_tone3`,man_with_veil_tone4:`man_with_veil_tone4`,man_with_veil_tone5:`man_with_veil_tone5`,man_with_white_cane_facing_right:`man_with_white_cane_facing_right`,man_with_white_cane_facing_right_dark_skin_tone:`man_with_white_cane_facing_right_tone5`,man_with_white_cane_facing_right_light_skin_tone:`man_with_white_cane_facing_right_tone1`,man_with_white_cane_facing_right_medium_dark_skin_tone:`man_with_white_cane_facing_right_tone4`,man_with_white_cane_facing_right_medium_light_skin_tone:`man_with_white_cane_facing_right_tone2`,man_with_white_cane_facing_right_medium_skin_tone:`man_with_white_cane_facing_right_tone3`,man_with_white_cane_facing_right_tone1:`man_with_white_cane_facing_right_tone1`,man_with_white_cane_facing_right_tone2:`man_with_white_cane_facing_right_tone2`,man_with_white_cane_facing_right_tone3:`man_with_white_cane_facing_right_tone3`,man_with_white_cane_facing_right_tone4:`man_with_white_cane_facing_right_tone4`,man_with_white_cane_facing_right_tone5:`man_with_white_cane_facing_right_tone5`,man_zombie:`man_zombie`,mango:`mango`,mans_shoe:`mans_shoe`,mantlepiece_clock:`clock`,manual_wheelchair:`manual_wheelchair`,map:`map`,map_of_japan:`japan`,maple_leaf:`maple_leaf`,maracas:`maracas`,martial_arts_uniform:`martial_arts_uniform`,mask:`mask`,massage:`person_getting_massage`,massage_tone1:`person_getting_massage_tone1`,massage_tone2:`person_getting_massage_tone2`,massage_tone3:`person_getting_massage_tone3`,massage_tone4:`person_getting_massage_tone4`,massage_tone5:`person_getting_massage_tone5`,mate:`mate`,mc:`flag_mc`,md:`flag_md`,me:`flag_me`,meat_on_bone:`meat_on_bone`,mechanic:`mechanic`,mechanic_dark_skin_tone:`mechanic_tone5`,mechanic_light_skin_tone:`mechanic_tone1`,mechanic_medium_dark_skin_tone:`mechanic_tone4`,mechanic_medium_light_skin_tone:`mechanic_tone2`,mechanic_medium_skin_tone:`mechanic_tone3`,mechanic_tone1:`mechanic_tone1`,mechanic_tone2:`mechanic_tone2`,mechanic_tone3:`mechanic_tone3`,mechanic_tone4:`mechanic_tone4`,mechanic_tone5:`mechanic_tone5`,mechanical_arm:`mechanical_arm`,mechanical_leg:`mechanical_leg`,medal:`medal`,medical_symbol:`medical_symbol`,mega:`mega`,megaphone:`mega`,melon:`melon`,melting_face:`melting_face`,memo:`pencil`,men_holding_hands_dark_skin_tone:`men_holding_hands_tone5`,men_holding_hands_dark_skin_tone_light_skin_tone:`men_holding_hands_tone5_tone1`,men_holding_hands_dark_skin_tone_medium_dark_skin_tone:`men_holding_hands_tone5_tone4`,men_holding_hands_dark_skin_tone_medium_light_skin_tone:`men_holding_hands_tone5_tone2`,men_holding_hands_dark_skin_tone_medium_skin_tone:`men_holding_hands_tone5_tone3`,men_holding_hands_light_skin_tone:`men_holding_hands_tone1`,men_holding_hands_light_skin_tone_dark_skin_tone:`men_holding_hands_tone1_tone5`,men_holding_hands_light_skin_tone_medium_dark_skin_tone:`men_holding_hands_tone1_tone4`,men_holding_hands_light_skin_tone_medium_light_skin_tone:`men_holding_hands_tone1_tone2`,men_holding_hands_light_skin_tone_medium_skin_tone:`men_holding_hands_tone1_tone3`,men_holding_hands_medium_dark_skin_tone:`men_holding_hands_tone4`,men_holding_hands_medium_dark_skin_tone_dark_skin_tone:`men_holding_hands_tone4_tone5`,men_holding_hands_medium_dark_skin_tone_light_skin_tone:`men_holding_hands_tone4_tone1`,men_holding_hands_medium_dark_skin_tone_medium_light_skin_tone:`men_holding_hands_tone4_tone2`,men_holding_hands_medium_dark_skin_tone_medium_skin_tone:`men_holding_hands_tone4_tone3`,men_holding_hands_medium_light_skin_tone:`men_holding_hands_tone2`,men_holding_hands_medium_light_skin_tone_dark_skin_tone:`men_holding_hands_tone2_tone5`,men_holding_hands_medium_light_skin_tone_light_skin_tone:`men_holding_hands_tone2_tone1`,men_holding_hands_medium_light_skin_tone_medium_dark_skin_tone:`men_holding_hands_tone2_tone4`,men_holding_hands_medium_light_skin_tone_medium_skin_tone:`men_holding_hands_tone2_tone3`,men_holding_hands_medium_skin_tone:`men_holding_hands_tone3`,men_holding_hands_medium_skin_tone_dark_skin_tone:`men_holding_hands_tone3_tone5`,men_holding_hands_medium_skin_tone_light_skin_tone:`men_holding_hands_tone3_tone1`,men_holding_hands_medium_skin_tone_medium_dark_skin_tone:`men_holding_hands_tone3_tone4`,men_holding_hands_medium_skin_tone_medium_light_skin_tone:`men_holding_hands_tone3_tone2`,men_holding_hands_tone1:`men_holding_hands_tone1`,men_holding_hands_tone1_tone2:`men_holding_hands_tone1_tone2`,men_holding_hands_tone1_tone3:`men_holding_hands_tone1_tone3`,men_holding_hands_tone1_tone4:`men_holding_hands_tone1_tone4`,men_holding_hands_tone1_tone5:`men_holding_hands_tone1_tone5`,men_holding_hands_tone2:`men_holding_hands_tone2`,men_holding_hands_tone2_tone1:`men_holding_hands_tone2_tone1`,men_holding_hands_tone2_tone3:`men_holding_hands_tone2_tone3`,men_holding_hands_tone2_tone4:`men_holding_hands_tone2_tone4`,men_holding_hands_tone2_tone5:`men_holding_hands_tone2_tone5`,men_holding_hands_tone3:`men_holding_hands_tone3`,men_holding_hands_tone3_tone1:`men_holding_hands_tone3_tone1`,men_holding_hands_tone3_tone2:`men_holding_hands_tone3_tone2`,men_holding_hands_tone3_tone4:`men_holding_hands_tone3_tone4`,men_holding_hands_tone3_tone5:`men_holding_hands_tone3_tone5`,men_holding_hands_tone4:`men_holding_hands_tone4`,men_holding_hands_tone4_tone1:`men_holding_hands_tone4_tone1`,men_holding_hands_tone4_tone2:`men_holding_hands_tone4_tone2`,men_holding_hands_tone4_tone3:`men_holding_hands_tone4_tone3`,men_holding_hands_tone4_tone5:`men_holding_hands_tone4_tone5`,men_holding_hands_tone5:`men_holding_hands_tone5`,men_holding_hands_tone5_tone1:`men_holding_hands_tone5_tone1`,men_holding_hands_tone5_tone2:`men_holding_hands_tone5_tone2`,men_holding_hands_tone5_tone3:`men_holding_hands_tone5_tone3`,men_holding_hands_tone5_tone4:`men_holding_hands_tone5_tone4`,men_with_bunny_ears_partying:`men_with_bunny_ears_partying`,men_wrestling:`men_wrestling`,mending_heart:`mending_heart`,menorah:`menorah`,mens:`mens`,mens_room:`mens`,mermaid:`mermaid`,mermaid_dark_skin_tone:`mermaid_tone5`,mermaid_light_skin_tone:`mermaid_tone1`,mermaid_medium_dark_skin_tone:`mermaid_tone4`,mermaid_medium_light_skin_tone:`mermaid_tone2`,mermaid_medium_skin_tone:`mermaid_tone3`,mermaid_tone1:`mermaid_tone1`,mermaid_tone2:`mermaid_tone2`,mermaid_tone3:`mermaid_tone3`,mermaid_tone4:`mermaid_tone4`,mermaid_tone5:`mermaid_tone5`,merman:`merman`,merman_dark_skin_tone:`merman_tone5`,merman_light_skin_tone:`merman_tone1`,merman_medium_dark_skin_tone:`merman_tone4`,merman_medium_light_skin_tone:`merman_tone2`,merman_medium_skin_tone:`merman_tone3`,merman_tone1:`merman_tone1`,merman_tone2:`merman_tone2`,merman_tone3:`merman_tone3`,merman_tone4:`merman_tone4`,merman_tone5:`merman_tone5`,merperson:`merperson`,merperson_dark_skin_tone:`merperson_tone5`,merperson_light_skin_tone:`merperson_tone1`,merperson_medium_dark_skin_tone:`merperson_tone4`,merperson_medium_light_skin_tone:`merperson_tone2`,merperson_medium_skin_tone:`merperson_tone3`,merperson_tone1:`merperson_tone1`,merperson_tone2:`merperson_tone2`,merperson_tone3:`merperson_tone3`,merperson_tone4:`merperson_tone4`,merperson_tone5:`merperson_tone5`,metal:`metal`,metal_tone1:`metal_tone1`,metal_tone2:`metal_tone2`,metal_tone3:`metal_tone3`,metal_tone4:`metal_tone4`,metal_tone5:`metal_tone5`,metro:`metro`,mf:`flag_mf`,mg:`flag_mg`,mh:`flag_mh`,microbe:`microbe`,microphone:`microphone`,microphone2:`microphone2`,microscope:`microscope`,middle_finger:`middle_finger`,middle_finger_tone1:`middle_finger_tone1`,middle_finger_tone2:`middle_finger_tone2`,middle_finger_tone3:`middle_finger_tone3`,middle_finger_tone4:`middle_finger_tone4`,middle_finger_tone5:`middle_finger_tone5`,military_helmet:`military_helmet`,military_medal:`military_medal`,milk:`milk`,milky_way:`milky_way`,minibus:`minibus`,minidisc:`minidisc`,mirror:`mirror`,mirror_ball:`mirror_ball`,mk:`flag_mk`,ml:`flag_ml`,mm:`flag_mm`,mn:`flag_mn`,mo:`flag_mo`,moai:`moyai`,mobile_phone:`mobile_phone`,mobile_phone_off:`mobile_phone_off`,money_bag:`moneybag`,money_mouth:`money_mouth`,money_mouth_face:`money_mouth`,money_with_wings:`money_with_wings`,moneybag:`moneybag`,monkey:`monkey`,monkey_face:`monkey_face`,monorail:`monorail`,moon_cake:`moon_cake`,moose:`moose`,mortar_board:`mortar_board`,mosque:`mosque`,mosquito:`mosquito`,mother_christmas:`mrs_claus`,mother_christmas_tone1:`mrs_claus_tone1`,mother_christmas_tone2:`mrs_claus_tone2`,mother_christmas_tone3:`mrs_claus_tone3`,mother_christmas_tone4:`mrs_claus_tone4`,mother_christmas_tone5:`mrs_claus_tone5`,motor_boat:`motorboat`,motor_scooter:`motor_scooter`,motorbike:`motor_scooter`,motorboat:`motorboat`,motorcycle:`motorcycle`,motorized_wheelchair:`motorized_wheelchair`,motorway:`motorway`,mount_fuji:`mount_fuji`,mountain:`mountain`,mountain_bicyclist:`person_mountain_biking`,mountain_bicyclist_tone1:`person_mountain_biking_tone1`,mountain_bicyclist_tone2:`person_mountain_biking_tone2`,mountain_bicyclist_tone3:`person_mountain_biking_tone3`,mountain_bicyclist_tone4:`person_mountain_biking_tone4`,mountain_bicyclist_tone5:`person_mountain_biking_tone5`,mountain_cableway:`mountain_cableway`,mountain_railway:`mountain_railway`,mountain_snow:`mountain_snow`,mouse:`mouse`,mouse_face:`mouse`,mouse_three_button:`mouse_three_button`,mouse_trap:`mouse_trap`,mouse2:`mouse2`,mouth:`lips`,movie_camera:`movie_camera`,moyai:`moyai`,mp:`flag_mp`,mq:`flag_mq`,mr:`flag_mr`,mrs_claus:`mrs_claus`,mrs_claus_tone1:`mrs_claus_tone1`,mrs_claus_tone2:`mrs_claus_tone2`,mrs_claus_tone3:`mrs_claus_tone3`,mrs_claus_tone4:`mrs_claus_tone4`,mrs_claus_tone5:`mrs_claus_tone5`,ms:`flag_ms`,mt:`flag_mt`,mu:`flag_mu`,muscle:`muscle`,muscle_tone1:`muscle_tone1`,muscle_tone2:`muscle_tone2`,muscle_tone3:`muscle_tone3`,muscle_tone4:`muscle_tone4`,muscle_tone5:`muscle_tone5`,mushroom:`mushroom`,musical_keyboard:`musical_keyboard`,musical_note:`musical_note`,musical_notes:`notes`,musical_score:`musical_score`,mute:`mute`,muted_speaker:`mute`,mv:`flag_mv`,mw:`flag_mw`,mx:`flag_mx`,mx_claus:`mx_claus`,mx_claus_dark_skin_tone:`mx_claus_tone5`,mx_claus_light_skin_tone:`mx_claus_tone1`,mx_claus_medium_dark_skin_tone:`mx_claus_tone4`,mx_claus_medium_light_skin_tone:`mx_claus_tone2`,mx_claus_medium_skin_tone:`mx_claus_tone3`,mx_claus_tone1:`mx_claus_tone1`,mx_claus_tone2:`mx_claus_tone2`,mx_claus_tone3:`mx_claus_tone3`,mx_claus_tone4:`mx_claus_tone4`,mx_claus_tone5:`mx_claus_tone5`,my:`flag_my`,mz:`flag_mz`,na:`flag_na`,nail_care:`nail_care`,nail_care_tone1:`nail_care_tone1`,nail_care_tone2:`nail_care_tone2`,nail_care_tone3:`nail_care_tone3`,nail_care_tone4:`nail_care_tone4`,nail_care_tone5:`nail_care_tone5`,nail_polish:`nail_care`,name_badge:`name_badge`,national_park:`park`,nauseated_face:`nauseated_face`,nazar_amulet:`nazar_amulet`,nc:`flag_nc`,ne:`flag_ne`,necktie:`necktie`,negative_squared_cross_mark:`negative_squared_cross_mark`,nerd:`nerd`,nerd_face:`nerd`,nest_with_eggs:`nest_with_eggs`,nesting_dolls:`nesting_dolls`,neutral_face:`neutral_face`,new:`new`,new_moon:`new_moon`,new_moon_face:`new_moon_with_face`,new_moon_with_face:`new_moon_with_face`,newspaper:`newspaper`,newspaper2:`newspaper2`,next_track:`track_next`,nf:`flag_nf`,ng:`ng`,ni:`flag_ni`,nigeria:`flag_ng`,night_with_stars:`night_with_stars`,nine:`nine`,nine_oclock:`clock9`,nine_thirty:`clock930`,ninja:`ninja`,ninja_dark_skin_tone:`ninja_tone5`,ninja_light_skin_tone:`ninja_tone1`,ninja_medium_dark_skin_tone:`ninja_tone4`,ninja_medium_light_skin_tone:`ninja_tone2`,ninja_medium_skin_tone:`ninja_tone3`,ninja_tone1:`ninja_tone1`,ninja_tone2:`ninja_tone2`,ninja_tone3:`ninja_tone3`,ninja_tone4:`ninja_tone4`,ninja_tone5:`ninja_tone5`,nl:`flag_nl`,no:`flag_no`,no_bell:`no_bell`,no_bicycles:`no_bicycles`,no_entry:`no_entry`,no_entry_sign:`no_entry_sign`,no_good:`person_gesturing_no`,no_good_tone1:`person_gesturing_no_tone1`,no_good_tone2:`person_gesturing_no_tone2`,no_good_tone3:`person_gesturing_no_tone3`,no_good_tone4:`person_gesturing_no_tone4`,no_good_tone5:`person_gesturing_no_tone5`,no_littering:`do_not_litter`,no_mobile_phones:`no_mobile_phones`,no_mouth:`no_mouth`,no_pedestrians:`no_pedestrians`,no_smoking:`no_smoking`,"non-potable_water":`non-potable_water`,nose:`nose`,nose_tone1:`nose_tone1`,nose_tone2:`nose_tone2`,nose_tone3:`nose_tone3`,nose_tone4:`nose_tone4`,nose_tone5:`nose_tone5`,notebook:`notebook`,notebook_with_decorative_cover:`notebook_with_decorative_cover`,notepad_spiral:`notepad_spiral`,notes:`notes`,np:`flag_np`,nr:`flag_nr`,nu:`flag_nu`,nut_and_bolt:`nut_and_bolt`,nz:`flag_nz`,o:`o`,o2:`o2`,ocean:`ocean`,octagonal_sign:`octagonal_sign`,octopus:`octopus`,oden:`oden`,office:`office`,office_worker:`office_worker`,office_worker_dark_skin_tone:`office_worker_tone5`,office_worker_light_skin_tone:`office_worker_tone1`,office_worker_medium_dark_skin_tone:`office_worker_tone4`,office_worker_medium_light_skin_tone:`office_worker_tone2`,office_worker_medium_skin_tone:`office_worker_tone3`,office_worker_tone1:`office_worker_tone1`,office_worker_tone2:`office_worker_tone2`,office_worker_tone3:`office_worker_tone3`,office_worker_tone4:`office_worker_tone4`,office_worker_tone5:`office_worker_tone5`,ogre:`japanese_ogre`,oil:`oil`,oil_drum:`oil`,ok:`ok`,ok_hand:`ok_hand`,ok_hand_tone1:`ok_hand_tone1`,ok_hand_tone2:`ok_hand_tone2`,ok_hand_tone3:`ok_hand_tone3`,ok_hand_tone4:`ok_hand_tone4`,ok_hand_tone5:`ok_hand_tone5`,ok_woman:`person_gesturing_ok`,ok_woman_tone1:`person_gesturing_ok_tone1`,ok_woman_tone2:`person_gesturing_ok_tone2`,ok_woman_tone3:`person_gesturing_ok_tone3`,ok_woman_tone4:`person_gesturing_ok_tone4`,ok_woman_tone5:`person_gesturing_ok_tone5`,old_key:`key2`,old_man:`older_man`,old_woman:`older_woman`,older_adult:`older_adult`,older_adult_dark_skin_tone:`older_adult_tone5`,older_adult_light_skin_tone:`older_adult_tone1`,older_adult_medium_dark_skin_tone:`older_adult_tone4`,older_adult_medium_light_skin_tone:`older_adult_tone2`,older_adult_medium_skin_tone:`older_adult_tone3`,older_adult_tone1:`older_adult_tone1`,older_adult_tone2:`older_adult_tone2`,older_adult_tone3:`older_adult_tone3`,older_adult_tone4:`older_adult_tone4`,older_adult_tone5:`older_adult_tone5`,older_man:`older_man`,older_man_tone1:`older_man_tone1`,older_man_tone2:`older_man_tone2`,older_man_tone3:`older_man_tone3`,older_man_tone4:`older_man_tone4`,older_man_tone5:`older_man_tone5`,older_person:`older_adult`,older_woman:`older_woman`,older_woman_tone1:`older_woman_tone1`,older_woman_tone2:`older_woman_tone2`,older_woman_tone3:`older_woman_tone3`,older_woman_tone4:`older_woman_tone4`,older_woman_tone5:`older_woman_tone5`,olive:`olive`,om:`flag_om`,om_symbol:`om_symbol`,on:`on`,on_arrow:`on`,oncoming_automobile:`oncoming_automobile`,oncoming_bus:`oncoming_bus`,oncoming_fist:`punch`,oncoming_police_car:`oncoming_police_car`,oncoming_taxi:`oncoming_taxi`,one:`one`,one_oclock:`clock1`,one_piece_swimsuit:`one_piece_swimsuit`,one_thirty:`clock130`,onion:`onion`,open_book:`book`,open_file_folder:`open_file_folder`,open_hands:`open_hands`,open_hands_tone1:`open_hands_tone1`,open_hands_tone2:`open_hands_tone2`,open_hands_tone3:`open_hands_tone3`,open_hands_tone4:`open_hands_tone4`,open_hands_tone5:`open_hands_tone5`,open_mouth:`open_mouth`,ophiuchus:`ophiuchus`,optical_disk:`cd`,orange_book:`orange_book`,orange_circle:`orange_circle`,orange_heart:`orange_heart`,orange_square:`orange_square`,orangutan:`orangutan`,orthodox_cross:`orthodox_cross`,otter:`otter`,outbox_tray:`outbox_tray`,owl:`owl`,ox:`ox`,oyster:`oyster`,pa:`flag_pa`,package:`package`,paella:`shallow_pan_of_food`,page_facing_up:`page_facing_up`,page_with_curl:`page_with_curl`,pager:`pager`,paintbrush:`paintbrush`,palm_down_hand:`palm_down_hand`,palm_down_hand_dark_skin_tone:`palm_down_hand_tone5`,palm_down_hand_light_skin_tone:`palm_down_hand_tone1`,palm_down_hand_medium_dark_skin_tone:`palm_down_hand_tone4`,palm_down_hand_medium_light_skin_tone:`palm_down_hand_tone2`,palm_down_hand_medium_skin_tone:`palm_down_hand_tone3`,palm_down_hand_tone1:`palm_down_hand_tone1`,palm_down_hand_tone2:`palm_down_hand_tone2`,palm_down_hand_tone3:`palm_down_hand_tone3`,palm_down_hand_tone4:`palm_down_hand_tone4`,palm_down_hand_tone5:`palm_down_hand_tone5`,palm_tree:`palm_tree`,palm_up_hand:`palm_up_hand`,palm_up_hand_dark_skin_tone:`palm_up_hand_tone5`,palm_up_hand_light_skin_tone:`palm_up_hand_tone1`,palm_up_hand_medium_dark_skin_tone:`palm_up_hand_tone4`,palm_up_hand_medium_light_skin_tone:`palm_up_hand_tone2`,palm_up_hand_medium_skin_tone:`palm_up_hand_tone3`,palm_up_hand_tone1:`palm_up_hand_tone1`,palm_up_hand_tone2:`palm_up_hand_tone2`,palm_up_hand_tone3:`palm_up_hand_tone3`,palm_up_hand_tone4:`palm_up_hand_tone4`,palm_up_hand_tone5:`palm_up_hand_tone5`,palms_up_together:`palms_up_together`,palms_up_together_dark_skin_tone:`palms_up_together_tone5`,palms_up_together_light_skin_tone:`palms_up_together_tone1`,palms_up_together_medium_dark_skin_tone:`palms_up_together_tone4`,palms_up_together_medium_light_skin_tone:`palms_up_together_tone2`,palms_up_together_medium_skin_tone:`palms_up_together_tone3`,palms_up_together_tone1:`palms_up_together_tone1`,palms_up_together_tone2:`palms_up_together_tone2`,palms_up_together_tone3:`palms_up_together_tone3`,palms_up_together_tone4:`palms_up_together_tone4`,palms_up_together_tone5:`palms_up_together_tone5`,pancakes:`pancakes`,panda:`panda_face`,panda_face:`panda_face`,paperclip:`paperclip`,paperclips:`paperclips`,parachute:`parachute`,park:`park`,parking:`parking`,parrot:`parrot`,part_alternation_mark:`part_alternation_mark`,partly_sunny:`partly_sunny`,party_popper:`tada`,partying_face:`partying_face`,passenger_ship:`cruise_ship`,passport_control:`passport_control`,pause_button:`pause_button`,paw_prints:`feet`,pe:`flag_pe`,pea_pod:`pea_pod`,peace:`peace`,peace_symbol:`peace`,peach:`peach`,peacock:`peacock`,peanuts:`peanuts`,pear:`pear`,pen:`pen_ballpoint`,pen_ballpoint:`pen_ballpoint`,pen_fountain:`pen_fountain`,pencil:`pencil`,pencil2:`pencil2`,penguin:`penguin`,pensive:`pensive`,pensive_face:`pensive`,people_holding_hands:`people_holding_hands`,people_holding_hands_dark_skin_tone:`people_holding_hands_tone5`,people_holding_hands_dark_skin_tone_light_skin_tone:`people_holding_hands_tone5_tone1`,people_holding_hands_dark_skin_tone_medium_dark_skin_tone:`people_holding_hands_tone5_tone4`,people_holding_hands_dark_skin_tone_medium_light_skin_tone:`people_holding_hands_tone5_tone2`,people_holding_hands_dark_skin_tone_medium_skin_tone:`people_holding_hands_tone5_tone3`,people_holding_hands_light_skin_tone:`people_holding_hands_tone1`,people_holding_hands_light_skin_tone_dark_skin_tone:`people_holding_hands_tone1_tone5`,people_holding_hands_light_skin_tone_medium_dark_skin_tone:`people_holding_hands_tone1_tone4`,people_holding_hands_light_skin_tone_medium_light_skin_tone:`people_holding_hands_tone1_tone2`,people_holding_hands_light_skin_tone_medium_skin_tone:`people_holding_hands_tone1_tone3`,people_holding_hands_medium_dark_skin_tone:`people_holding_hands_tone4`,people_holding_hands_medium_dark_skin_tone_dark_skin_tone:`people_holding_hands_tone4_tone5`,people_holding_hands_medium_dark_skin_tone_light_skin_tone:`people_holding_hands_tone4_tone1`,people_holding_hands_medium_dark_skin_tone_medium_light_skin_tone:`people_holding_hands_tone4_tone2`,people_holding_hands_medium_dark_skin_tone_medium_skin_tone:`people_holding_hands_tone4_tone3`,people_holding_hands_medium_light_skin_tone:`people_holding_hands_tone2`,people_holding_hands_medium_light_skin_tone_dark_skin_tone:`people_holding_hands_tone2_tone5`,people_holding_hands_medium_light_skin_tone_light_skin_tone:`people_holding_hands_tone2_tone1`,people_holding_hands_medium_light_skin_tone_medium_dark_skin_tone:`people_holding_hands_tone2_tone4`,people_holding_hands_medium_light_skin_tone_medium_skin_tone:`people_holding_hands_tone2_tone3`,people_holding_hands_medium_skin_tone:`people_holding_hands_tone3`,people_holding_hands_medium_skin_tone_dark_skin_tone:`people_holding_hands_tone3_tone5`,people_holding_hands_medium_skin_tone_light_skin_tone:`people_holding_hands_tone3_tone1`,people_holding_hands_medium_skin_tone_medium_dark_skin_tone:`people_holding_hands_tone3_tone4`,people_holding_hands_medium_skin_tone_medium_light_skin_tone:`people_holding_hands_tone3_tone2`,people_holding_hands_tone1:`people_holding_hands_tone1`,people_holding_hands_tone1_tone2:`people_holding_hands_tone1_tone2`,people_holding_hands_tone1_tone3:`people_holding_hands_tone1_tone3`,people_holding_hands_tone1_tone4:`people_holding_hands_tone1_tone4`,people_holding_hands_tone1_tone5:`people_holding_hands_tone1_tone5`,people_holding_hands_tone2:`people_holding_hands_tone2`,people_holding_hands_tone2_tone1:`people_holding_hands_tone2_tone1`,people_holding_hands_tone2_tone3:`people_holding_hands_tone2_tone3`,people_holding_hands_tone2_tone4:`people_holding_hands_tone2_tone4`,people_holding_hands_tone2_tone5:`people_holding_hands_tone2_tone5`,people_holding_hands_tone3:`people_holding_hands_tone3`,people_holding_hands_tone3_tone1:`people_holding_hands_tone3_tone1`,people_holding_hands_tone3_tone2:`people_holding_hands_tone3_tone2`,people_holding_hands_tone3_tone4:`people_holding_hands_tone3_tone4`,people_holding_hands_tone3_tone5:`people_holding_hands_tone3_tone5`,people_holding_hands_tone4:`people_holding_hands_tone4`,people_holding_hands_tone4_tone1:`people_holding_hands_tone4_tone1`,people_holding_hands_tone4_tone2:`people_holding_hands_tone4_tone2`,people_holding_hands_tone4_tone3:`people_holding_hands_tone4_tone3`,people_holding_hands_tone4_tone5:`people_holding_hands_tone4_tone5`,people_holding_hands_tone5:`people_holding_hands_tone5`,people_holding_hands_tone5_tone1:`people_holding_hands_tone5_tone1`,people_holding_hands_tone5_tone2:`people_holding_hands_tone5_tone2`,people_holding_hands_tone5_tone3:`people_holding_hands_tone5_tone3`,people_holding_hands_tone5_tone4:`people_holding_hands_tone5_tone4`,people_hugging:`people_hugging`,people_with_bunny_ears_partying:`people_with_bunny_ears_partying`,people_wrestling:`people_wrestling`,performing_arts:`performing_arts`,persevere:`persevere`,person:`adult`,person_bald:`person_bald`,person_beard:`bearded_person`,person_biking:`person_biking`,person_biking_tone1:`person_biking_tone1`,person_biking_tone2:`person_biking_tone2`,person_biking_tone3:`person_biking_tone3`,person_biking_tone4:`person_biking_tone4`,person_biking_tone5:`person_biking_tone5`,person_bouncing_ball:`person_bouncing_ball`,person_bouncing_ball_tone1:`person_bouncing_ball_tone1`,person_bouncing_ball_tone2:`person_bouncing_ball_tone2`,person_bouncing_ball_tone3:`person_bouncing_ball_tone3`,person_bouncing_ball_tone4:`person_bouncing_ball_tone4`,person_bouncing_ball_tone5:`person_bouncing_ball_tone5`,person_bowing:`person_bowing`,person_bowing_tone1:`person_bowing_tone1`,person_bowing_tone2:`person_bowing_tone2`,person_bowing_tone3:`person_bowing_tone3`,person_bowing_tone4:`person_bowing_tone4`,person_bowing_tone5:`person_bowing_tone5`,person_climbing:`person_climbing`,person_climbing_dark_skin_tone:`person_climbing_tone5`,person_climbing_light_skin_tone:`person_climbing_tone1`,person_climbing_medium_dark_skin_tone:`person_climbing_tone4`,person_climbing_medium_light_skin_tone:`person_climbing_tone2`,person_climbing_medium_skin_tone:`person_climbing_tone3`,person_climbing_tone1:`person_climbing_tone1`,person_climbing_tone2:`person_climbing_tone2`,person_climbing_tone3:`person_climbing_tone3`,person_climbing_tone4:`person_climbing_tone4`,person_climbing_tone5:`person_climbing_tone5`,person_curly_hair:`person_curly_hair`,person_dark_skin_tone_bald:`person_tone5_bald`,person_dark_skin_tone_curly_hair:`person_tone5_curly_hair`,person_dark_skin_tone_red_hair:`person_tone5_red_hair`,person_dark_skin_tone_white_hair:`person_tone5_white_hair`,person_doing_cartwheel:`person_doing_cartwheel`,person_doing_cartwheel_tone1:`person_doing_cartwheel_tone1`,person_doing_cartwheel_tone2:`person_doing_cartwheel_tone2`,person_doing_cartwheel_tone3:`person_doing_cartwheel_tone3`,person_doing_cartwheel_tone4:`person_doing_cartwheel_tone4`,person_doing_cartwheel_tone5:`person_doing_cartwheel_tone5`,person_facepalming:`person_facepalming`,person_facepalming_tone1:`person_facepalming_tone1`,person_facepalming_tone2:`person_facepalming_tone2`,person_facepalming_tone3:`person_facepalming_tone3`,person_facepalming_tone4:`person_facepalming_tone4`,person_facepalming_tone5:`person_facepalming_tone5`,person_feeding_baby:`person_feeding_baby`,person_feeding_baby_dark_skin_tone:`person_feeding_baby_tone5`,person_feeding_baby_light_skin_tone:`person_feeding_baby_tone1`,person_feeding_baby_medium_dark_skin_tone:`person_feeding_baby_tone4`,person_feeding_baby_medium_light_skin_tone:`person_feeding_baby_tone2`,person_feeding_baby_medium_skin_tone:`person_feeding_baby_tone3`,person_feeding_baby_tone1:`person_feeding_baby_tone1`,person_feeding_baby_tone2:`person_feeding_baby_tone2`,person_feeding_baby_tone3:`person_feeding_baby_tone3`,person_feeding_baby_tone4:`person_feeding_baby_tone4`,person_feeding_baby_tone5:`person_feeding_baby_tone5`,person_fencing:`person_fencing`,person_frowning:`person_frowning`,person_frowning_tone1:`person_frowning_tone1`,person_frowning_tone2:`person_frowning_tone2`,person_frowning_tone3:`person_frowning_tone3`,person_frowning_tone4:`person_frowning_tone4`,person_frowning_tone5:`person_frowning_tone5`,person_gesturing_no:`person_gesturing_no`,person_gesturing_no_tone1:`person_gesturing_no_tone1`,person_gesturing_no_tone2:`person_gesturing_no_tone2`,person_gesturing_no_tone3:`person_gesturing_no_tone3`,person_gesturing_no_tone4:`person_gesturing_no_tone4`,person_gesturing_no_tone5:`person_gesturing_no_tone5`,person_gesturing_ok:`person_gesturing_ok`,person_gesturing_ok_tone1:`person_gesturing_ok_tone1`,person_gesturing_ok_tone2:`person_gesturing_ok_tone2`,person_gesturing_ok_tone3:`person_gesturing_ok_tone3`,person_gesturing_ok_tone4:`person_gesturing_ok_tone4`,person_gesturing_ok_tone5:`person_gesturing_ok_tone5`,person_getting_haircut:`person_getting_haircut`,person_getting_haircut_tone1:`person_getting_haircut_tone1`,person_getting_haircut_tone2:`person_getting_haircut_tone2`,person_getting_haircut_tone3:`person_getting_haircut_tone3`,person_getting_haircut_tone4:`person_getting_haircut_tone4`,person_getting_haircut_tone5:`person_getting_haircut_tone5`,person_getting_massage:`person_getting_massage`,person_getting_massage_tone1:`person_getting_massage_tone1`,person_getting_massage_tone2:`person_getting_massage_tone2`,person_getting_massage_tone3:`person_getting_massage_tone3`,person_getting_massage_tone4:`person_getting_massage_tone4`,person_getting_massage_tone5:`person_getting_massage_tone5`,person_golfing:`person_golfing`,person_golfing_dark_skin_tone:`person_golfing_tone5`,person_golfing_light_skin_tone:`person_golfing_tone1`,person_golfing_medium_dark_skin_tone:`person_golfing_tone4`,person_golfing_medium_light_skin_tone:`person_golfing_tone2`,person_golfing_medium_skin_tone:`person_golfing_tone3`,person_golfing_tone1:`person_golfing_tone1`,person_golfing_tone2:`person_golfing_tone2`,person_golfing_tone3:`person_golfing_tone3`,person_golfing_tone4:`person_golfing_tone4`,person_golfing_tone5:`person_golfing_tone5`,person_in_bed:`sleeping_accommodation`,person_in_bed_dark_skin_tone:`person_in_bed_tone5`,person_in_bed_light_skin_tone:`person_in_bed_tone1`,person_in_bed_medium_dark_skin_tone:`person_in_bed_tone4`,person_in_bed_medium_light_skin_tone:`person_in_bed_tone2`,person_in_bed_medium_skin_tone:`person_in_bed_tone3`,person_in_bed_tone1:`person_in_bed_tone1`,person_in_bed_tone2:`person_in_bed_tone2`,person_in_bed_tone3:`person_in_bed_tone3`,person_in_bed_tone4:`person_in_bed_tone4`,person_in_bed_tone5:`person_in_bed_tone5`,person_in_lotus_position:`person_in_lotus_position`,person_in_lotus_position_dark_skin_tone:`person_in_lotus_position_tone5`,person_in_lotus_position_light_skin_tone:`person_in_lotus_position_tone1`,person_in_lotus_position_medium_dark_skin_tone:`person_in_lotus_position_tone4`,person_in_lotus_position_medium_light_skin_tone:`person_in_lotus_position_tone2`,person_in_lotus_position_medium_skin_tone:`person_in_lotus_position_tone3`,person_in_lotus_position_tone1:`person_in_lotus_position_tone1`,person_in_lotus_position_tone2:`person_in_lotus_position_tone2`,person_in_lotus_position_tone3:`person_in_lotus_position_tone3`,person_in_lotus_position_tone4:`person_in_lotus_position_tone4`,person_in_lotus_position_tone5:`person_in_lotus_position_tone5`,person_in_manual_wheelchair:`person_in_manual_wheelchair`,person_in_manual_wheelchair_dark_skin_tone:`person_in_manual_wheelchair_tone5`,person_in_manual_wheelchair_facing_right:`person_in_manual_wheelchair_facing_right`,person_in_manual_wheelchair_facing_right_dark_skin_tone:`person_in_manual_wheelchair_facing_right_tone5`,person_in_manual_wheelchair_facing_right_light_skin_tone:`person_in_manual_wheelchair_facing_right_tone1`,person_in_manual_wheelchair_facing_right_medium_dark_skin_tone:`person_in_manual_wheelchair_facing_right_tone4`,person_in_manual_wheelchair_facing_right_medium_light_skin_tone:`person_in_manual_wheelchair_facing_right_tone2`,person_in_manual_wheelchair_facing_right_medium_skin_tone:`person_in_manual_wheelchair_facing_right_tone3`,person_in_manual_wheelchair_facing_right_tone1:`person_in_manual_wheelchair_facing_right_tone1`,person_in_manual_wheelchair_facing_right_tone2:`person_in_manual_wheelchair_facing_right_tone2`,person_in_manual_wheelchair_facing_right_tone3:`person_in_manual_wheelchair_facing_right_tone3`,person_in_manual_wheelchair_facing_right_tone4:`person_in_manual_wheelchair_facing_right_tone4`,person_in_manual_wheelchair_facing_right_tone5:`person_in_manual_wheelchair_facing_right_tone5`,person_in_manual_wheelchair_light_skin_tone:`person_in_manual_wheelchair_tone1`,person_in_manual_wheelchair_medium_dark_skin_tone:`person_in_manual_wheelchair_tone4`,person_in_manual_wheelchair_medium_light_skin_tone:`person_in_manual_wheelchair_tone2`,person_in_manual_wheelchair_medium_skin_tone:`person_in_manual_wheelchair_tone3`,person_in_manual_wheelchair_tone1:`person_in_manual_wheelchair_tone1`,person_in_manual_wheelchair_tone2:`person_in_manual_wheelchair_tone2`,person_in_manual_wheelchair_tone3:`person_in_manual_wheelchair_tone3`,person_in_manual_wheelchair_tone4:`person_in_manual_wheelchair_tone4`,person_in_manual_wheelchair_tone5:`person_in_manual_wheelchair_tone5`,person_in_motorized_wheelchair:`person_in_motorized_wheelchair`,person_in_motorized_wheelchair_dark_skin_tone:`person_in_motorized_wheelchair_tone5`,person_in_motorized_wheelchair_facing_right:`person_in_motorized_wheelchair_facing_right`,person_in_motorized_wheelchair_facing_right_dark_skin_tone:`person_in_motorized_wheelchair_facing_right_tone5`,person_in_motorized_wheelchair_facing_right_light_skin_tone:`person_in_motorized_wheelchair_facing_right_tone1`,person_in_motorized_wheelchair_facing_right_medium_dark_skin_tone:`person_in_motorized_wheelchair_facing_right_tone4`,person_in_motorized_wheelchair_facing_right_medium_light_skin_tone:`person_in_motorized_wheelchair_facing_right_tone2`,person_in_motorized_wheelchair_facing_right_medium_skin_tone:`person_in_motorized_wheelchair_facing_right_tone3`,person_in_motorized_wheelchair_facing_right_tone1:`person_in_motorized_wheelchair_facing_right_tone1`,person_in_motorized_wheelchair_facing_right_tone2:`person_in_motorized_wheelchair_facing_right_tone2`,person_in_motorized_wheelchair_facing_right_tone3:`person_in_motorized_wheelchair_facing_right_tone3`,person_in_motorized_wheelchair_facing_right_tone4:`person_in_motorized_wheelchair_facing_right_tone4`,person_in_motorized_wheelchair_facing_right_tone5:`person_in_motorized_wheelchair_facing_right_tone5`,person_in_motorized_wheelchair_light_skin_tone:`person_in_motorized_wheelchair_tone1`,person_in_motorized_wheelchair_medium_dark_skin_tone:`person_in_motorized_wheelchair_tone4`,person_in_motorized_wheelchair_medium_light_skin_tone:`person_in_motorized_wheelchair_tone2`,person_in_motorized_wheelchair_medium_skin_tone:`person_in_motorized_wheelchair_tone3`,person_in_motorized_wheelchair_tone1:`person_in_motorized_wheelchair_tone1`,person_in_motorized_wheelchair_tone2:`person_in_motorized_wheelchair_tone2`,person_in_motorized_wheelchair_tone3:`person_in_motorized_wheelchair_tone3`,person_in_motorized_wheelchair_tone4:`person_in_motorized_wheelchair_tone4`,person_in_motorized_wheelchair_tone5:`person_in_motorized_wheelchair_tone5`,person_in_steamy_room:`person_in_steamy_room`,person_in_steamy_room_dark_skin_tone:`person_in_steamy_room_tone5`,person_in_steamy_room_light_skin_tone:`person_in_steamy_room_tone1`,person_in_steamy_room_medium_dark_skin_tone:`person_in_steamy_room_tone4`,person_in_steamy_room_medium_light_skin_tone:`person_in_steamy_room_tone2`,person_in_steamy_room_medium_skin_tone:`person_in_steamy_room_tone3`,person_in_steamy_room_tone1:`person_in_steamy_room_tone1`,person_in_steamy_room_tone2:`person_in_steamy_room_tone2`,person_in_steamy_room_tone3:`person_in_steamy_room_tone3`,person_in_steamy_room_tone4:`person_in_steamy_room_tone4`,person_in_steamy_room_tone5:`person_in_steamy_room_tone5`,person_in_tuxedo:`person_in_tuxedo`,person_in_tuxedo_tone1:`person_in_tuxedo_tone1`,person_in_tuxedo_tone2:`person_in_tuxedo_tone2`,person_in_tuxedo_tone3:`person_in_tuxedo_tone3`,person_in_tuxedo_tone4:`person_in_tuxedo_tone4`,person_in_tuxedo_tone5:`person_in_tuxedo_tone5`,person_juggling:`person_juggling`,person_juggling_tone1:`person_juggling_tone1`,person_juggling_tone2:`person_juggling_tone2`,person_juggling_tone3:`person_juggling_tone3`,person_juggling_tone4:`person_juggling_tone4`,person_juggling_tone5:`person_juggling_tone5`,person_kneeling:`person_kneeling`,person_kneeling_dark_skin_tone:`person_kneeling_tone5`,person_kneeling_facing_right:`person_kneeling_facing_right`,person_kneeling_facing_right_dark_skin_tone:`person_kneeling_facing_right_tone5`,person_kneeling_facing_right_light_skin_tone:`person_kneeling_facing_right_tone1`,person_kneeling_facing_right_medium_dark_skin_tone:`person_kneeling_facing_right_tone4`,person_kneeling_facing_right_medium_light_skin_tone:`person_kneeling_facing_right_tone2`,person_kneeling_facing_right_medium_skin_tone:`person_kneeling_facing_right_tone3`,person_kneeling_facing_right_tone1:`person_kneeling_facing_right_tone1`,person_kneeling_facing_right_tone2:`person_kneeling_facing_right_tone2`,person_kneeling_facing_right_tone3:`person_kneeling_facing_right_tone3`,person_kneeling_facing_right_tone4:`person_kneeling_facing_right_tone4`,person_kneeling_facing_right_tone5:`person_kneeling_facing_right_tone5`,person_kneeling_light_skin_tone:`person_kneeling_tone1`,person_kneeling_medium_dark_skin_tone:`person_kneeling_tone4`,person_kneeling_medium_light_skin_tone:`person_kneeling_tone2`,person_kneeling_medium_skin_tone:`person_kneeling_tone3`,person_kneeling_tone1:`person_kneeling_tone1`,person_kneeling_tone2:`person_kneeling_tone2`,person_kneeling_tone3:`person_kneeling_tone3`,person_kneeling_tone4:`person_kneeling_tone4`,person_kneeling_tone5:`person_kneeling_tone5`,person_lifting_weights:`person_lifting_weights`,person_lifting_weights_tone1:`person_lifting_weights_tone1`,person_lifting_weights_tone2:`person_lifting_weights_tone2`,person_lifting_weights_tone3:`person_lifting_weights_tone3`,person_lifting_weights_tone4:`person_lifting_weights_tone4`,person_lifting_weights_tone5:`person_lifting_weights_tone5`,person_light_skin_tone_bald:`person_tone1_bald`,person_light_skin_tone_curly_hair:`person_tone1_curly_hair`,person_light_skin_tone_red_hair:`person_tone1_red_hair`,person_light_skin_tone_white_hair:`person_tone1_white_hair`,person_medium_dark_skin_tone_bald:`person_tone4_bald`,person_medium_dark_skin_tone_curly_hair:`person_tone4_curly_hair`,person_medium_dark_skin_tone_red_hair:`person_tone4_red_hair`,person_medium_dark_skin_tone_white_hair:`person_tone4_white_hair`,person_medium_light_skin_tone_bald:`person_tone2_bald`,person_medium_light_skin_tone_curly_hair:`person_tone2_curly_hair`,person_medium_light_skin_tone_red_hair:`person_tone2_red_hair`,person_medium_light_skin_tone_white_hair:`person_tone2_white_hair`,person_medium_skin_tone_bald:`person_tone3_bald`,person_medium_skin_tone_curly_hair:`person_tone3_curly_hair`,person_medium_skin_tone_red_hair:`person_tone3_red_hair`,person_medium_skin_tone_white_hair:`person_tone3_white_hair`,person_mountain_biking:`person_mountain_biking`,person_mountain_biking_tone1:`person_mountain_biking_tone1`,person_mountain_biking_tone2:`person_mountain_biking_tone2`,person_mountain_biking_tone3:`person_mountain_biking_tone3`,person_mountain_biking_tone4:`person_mountain_biking_tone4`,person_mountain_biking_tone5:`person_mountain_biking_tone5`,person_playing_handball:`person_playing_handball`,person_playing_handball_tone1:`person_playing_handball_tone1`,person_playing_handball_tone2:`person_playing_handball_tone2`,person_playing_handball_tone3:`person_playing_handball_tone3`,person_playing_handball_tone4:`person_playing_handball_tone4`,person_playing_handball_tone5:`person_playing_handball_tone5`,person_playing_water_polo:`person_playing_water_polo`,person_playing_water_polo_tone1:`person_playing_water_polo_tone1`,person_playing_water_polo_tone2:`person_playing_water_polo_tone2`,person_playing_water_polo_tone3:`person_playing_water_polo_tone3`,person_playing_water_polo_tone4:`person_playing_water_polo_tone4`,person_playing_water_polo_tone5:`person_playing_water_polo_tone5`,person_pouting:`person_pouting`,person_pouting_tone1:`person_pouting_tone1`,person_pouting_tone2:`person_pouting_tone2`,person_pouting_tone3:`person_pouting_tone3`,person_pouting_tone4:`person_pouting_tone4`,person_pouting_tone5:`person_pouting_tone5`,person_raising_hand:`person_raising_hand`,person_raising_hand_tone1:`person_raising_hand_tone1`,person_raising_hand_tone2:`person_raising_hand_tone2`,person_raising_hand_tone3:`person_raising_hand_tone3`,person_raising_hand_tone4:`person_raising_hand_tone4`,person_raising_hand_tone5:`person_raising_hand_tone5`,person_red_hair:`person_red_hair`,person_rowing_boat:`person_rowing_boat`,person_rowing_boat_tone1:`person_rowing_boat_tone1`,person_rowing_boat_tone2:`person_rowing_boat_tone2`,person_rowing_boat_tone3:`person_rowing_boat_tone3`,person_rowing_boat_tone4:`person_rowing_boat_tone4`,person_rowing_boat_tone5:`person_rowing_boat_tone5`,person_running:`person_running`,person_running_facing_right:`person_running_facing_right`,person_running_facing_right_dark_skin_tone:`person_running_facing_right_tone5`,person_running_facing_right_light_skin_tone:`person_running_facing_right_tone1`,person_running_facing_right_medium_dark_skin_tone:`person_running_facing_right_tone4`,person_running_facing_right_medium_light_skin_tone:`person_running_facing_right_tone2`,person_running_facing_right_medium_skin_tone:`person_running_facing_right_tone3`,person_running_facing_right_tone1:`person_running_facing_right_tone1`,person_running_facing_right_tone2:`person_running_facing_right_tone2`,person_running_facing_right_tone3:`person_running_facing_right_tone3`,person_running_facing_right_tone4:`person_running_facing_right_tone4`,person_running_facing_right_tone5:`person_running_facing_right_tone5`,person_running_tone1:`person_running_tone1`,person_running_tone2:`person_running_tone2`,person_running_tone3:`person_running_tone3`,person_running_tone4:`person_running_tone4`,person_running_tone5:`person_running_tone5`,person_shrugging:`person_shrugging`,person_shrugging_tone1:`person_shrugging_tone1`,person_shrugging_tone2:`person_shrugging_tone2`,person_shrugging_tone3:`person_shrugging_tone3`,person_shrugging_tone4:`person_shrugging_tone4`,person_shrugging_tone5:`person_shrugging_tone5`,person_standing:`person_standing`,person_standing_dark_skin_tone:`person_standing_tone5`,person_standing_light_skin_tone:`person_standing_tone1`,person_standing_medium_dark_skin_tone:`person_standing_tone4`,person_standing_medium_light_skin_tone:`person_standing_tone2`,person_standing_medium_skin_tone:`person_standing_tone3`,person_standing_tone1:`person_standing_tone1`,person_standing_tone2:`person_standing_tone2`,person_standing_tone3:`person_standing_tone3`,person_standing_tone4:`person_standing_tone4`,person_standing_tone5:`person_standing_tone5`,person_surfing:`person_surfing`,person_surfing_tone1:`person_surfing_tone1`,person_surfing_tone2:`person_surfing_tone2`,person_surfing_tone3:`person_surfing_tone3`,person_surfing_tone4:`person_surfing_tone4`,person_surfing_tone5:`person_surfing_tone5`,person_swimming:`person_swimming`,person_swimming_tone1:`person_swimming_tone1`,person_swimming_tone2:`person_swimming_tone2`,person_swimming_tone3:`person_swimming_tone3`,person_swimming_tone4:`person_swimming_tone4`,person_swimming_tone5:`person_swimming_tone5`,person_tipping_hand:`person_tipping_hand`,person_tipping_hand_tone1:`person_tipping_hand_tone1`,person_tipping_hand_tone2:`person_tipping_hand_tone2`,person_tipping_hand_tone3:`person_tipping_hand_tone3`,person_tipping_hand_tone4:`person_tipping_hand_tone4`,person_tipping_hand_tone5:`person_tipping_hand_tone5`,person_tone1_bald:`person_tone1_bald`,person_tone1_curly_hair:`person_tone1_curly_hair`,person_tone1_red_hair:`person_tone1_red_hair`,person_tone1_white_hair:`person_tone1_white_hair`,person_tone2_bald:`person_tone2_bald`,person_tone2_curly_hair:`person_tone2_curly_hair`,person_tone2_red_hair:`person_tone2_red_hair`,person_tone2_white_hair:`person_tone2_white_hair`,person_tone3_bald:`person_tone3_bald`,person_tone3_curly_hair:`person_tone3_curly_hair`,person_tone3_red_hair:`person_tone3_red_hair`,person_tone3_white_hair:`person_tone3_white_hair`,person_tone4_bald:`person_tone4_bald`,person_tone4_curly_hair:`person_tone4_curly_hair`,person_tone4_red_hair:`person_tone4_red_hair`,person_tone4_white_hair:`person_tone4_white_hair`,person_tone5_bald:`person_tone5_bald`,person_tone5_curly_hair:`person_tone5_curly_hair`,person_tone5_red_hair:`person_tone5_red_hair`,person_tone5_white_hair:`person_tone5_white_hair`,person_walking:`person_walking`,person_walking_facing_right:`person_walking_facing_right`,person_walking_facing_right_dark_skin_tone:`person_walking_facing_right_tone5`,person_walking_facing_right_light_skin_tone:`person_walking_facing_right_tone1`,person_walking_facing_right_medium_dark_skin_tone:`person_walking_facing_right_tone4`,person_walking_facing_right_medium_light_skin_tone:`person_walking_facing_right_tone2`,person_walking_facing_right_medium_skin_tone:`person_walking_facing_right_tone3`,person_walking_facing_right_tone1:`person_walking_facing_right_tone1`,person_walking_facing_right_tone2:`person_walking_facing_right_tone2`,person_walking_facing_right_tone3:`person_walking_facing_right_tone3`,person_walking_facing_right_tone4:`person_walking_facing_right_tone4`,person_walking_facing_right_tone5:`person_walking_facing_right_tone5`,person_walking_tone1:`person_walking_tone1`,person_walking_tone2:`person_walking_tone2`,person_walking_tone3:`person_walking_tone3`,person_walking_tone4:`person_walking_tone4`,person_walking_tone5:`person_walking_tone5`,person_wearing_turban:`person_wearing_turban`,person_wearing_turban_tone1:`person_wearing_turban_tone1`,person_wearing_turban_tone2:`person_wearing_turban_tone2`,person_wearing_turban_tone3:`person_wearing_turban_tone3`,person_wearing_turban_tone4:`person_wearing_turban_tone4`,person_wearing_turban_tone5:`person_wearing_turban_tone5`,person_white_hair:`person_white_hair`,person_with_ball:`person_bouncing_ball`,person_with_ball_tone1:`person_bouncing_ball_tone1`,person_with_ball_tone2:`person_bouncing_ball_tone2`,person_with_ball_tone3:`person_bouncing_ball_tone3`,person_with_ball_tone4:`person_bouncing_ball_tone4`,person_with_ball_tone5:`person_bouncing_ball_tone5`,person_with_blond_hair:`blond_haired_person`,person_with_blond_hair_tone1:`blond_haired_person_tone1`,person_with_blond_hair_tone2:`blond_haired_person_tone2`,person_with_blond_hair_tone3:`blond_haired_person_tone3`,person_with_blond_hair_tone4:`blond_haired_person_tone4`,person_with_blond_hair_tone5:`blond_haired_person_tone5`,person_with_crown:`person_with_crown`,person_with_crown_dark_skin_tone:`person_with_crown_tone5`,person_with_crown_light_skin_tone:`person_with_crown_tone1`,person_with_crown_medium_dark_skin_tone:`person_with_crown_tone4`,person_with_crown_medium_light_skin_tone:`person_with_crown_tone2`,person_with_crown_medium_skin_tone:`person_with_crown_tone3`,person_with_crown_tone1:`person_with_crown_tone1`,person_with_crown_tone2:`person_with_crown_tone2`,person_with_crown_tone3:`person_with_crown_tone3`,person_with_crown_tone4:`person_with_crown_tone4`,person_with_crown_tone5:`person_with_crown_tone5`,person_with_pouting_face:`person_pouting`,person_with_pouting_face_tone1:`person_pouting_tone1`,person_with_pouting_face_tone2:`person_pouting_tone2`,person_with_pouting_face_tone3:`person_pouting_tone3`,person_with_pouting_face_tone4:`person_pouting_tone4`,person_with_pouting_face_tone5:`person_pouting_tone5`,person_with_probing_cane:`person_with_probing_cane`,person_with_probing_cane_dark_skin_tone:`person_with_probing_cane_tone5`,person_with_probing_cane_light_skin_tone:`person_with_probing_cane_tone1`,person_with_probing_cane_medium_dark_skin_tone:`person_with_probing_cane_tone4`,person_with_probing_cane_medium_light_skin_tone:`person_with_probing_cane_tone2`,person_with_probing_cane_medium_skin_tone:`person_with_probing_cane_tone3`,person_with_probing_cane_tone1:`person_with_probing_cane_tone1`,person_with_probing_cane_tone2:`person_with_probing_cane_tone2`,person_with_probing_cane_tone3:`person_with_probing_cane_tone3`,person_with_probing_cane_tone4:`person_with_probing_cane_tone4`,person_with_probing_cane_tone5:`person_with_probing_cane_tone5`,person_with_veil:`person_with_veil`,person_with_veil_tone1:`person_with_veil_tone1`,person_with_veil_tone2:`person_with_veil_tone2`,person_with_veil_tone3:`person_with_veil_tone3`,person_with_veil_tone4:`person_with_veil_tone4`,person_with_veil_tone5:`person_with_veil_tone5`,person_with_white_cane_facing_right:`person_with_white_cane_facing_right`,person_with_white_cane_facing_right_dark_skin_tone:`person_with_white_cane_facing_right_tone5`,person_with_white_cane_facing_right_light_skin_tone:`person_with_white_cane_facing_right_tone1`,person_with_white_cane_facing_right_medium_dark_skin_tone:`person_with_white_cane_facing_right_tone4`,person_with_white_cane_facing_right_medium_light_skin_tone:`person_with_white_cane_facing_right_tone2`,person_with_white_cane_facing_right_medium_skin_tone:`person_with_white_cane_facing_right_tone3`,person_with_white_cane_facing_right_tone1:`person_with_white_cane_facing_right_tone1`,person_with_white_cane_facing_right_tone2:`person_with_white_cane_facing_right_tone2`,person_with_white_cane_facing_right_tone3:`person_with_white_cane_facing_right_tone3`,person_with_white_cane_facing_right_tone4:`person_with_white_cane_facing_right_tone4`,person_with_white_cane_facing_right_tone5:`person_with_white_cane_facing_right_tone5`,petri_dish:`petri_dish`,pf:`flag_pf`,pg:`flag_pg`,ph:`flag_ph`,phoenix:`phoenix`,pick:`pick`,pickup_truck:`pickup_truck`,pie:`pie`,pig:`pig`,pig_face:`pig`,pig_nose:`pig_nose`,pig2:`pig2`,pile_of_poo:`poop`,pill:`pill`,pilot:`pilot`,pilot_dark_skin_tone:`pilot_tone5`,pilot_light_skin_tone:`pilot_tone1`,pilot_medium_dark_skin_tone:`pilot_tone4`,pilot_medium_light_skin_tone:`pilot_tone2`,pilot_medium_skin_tone:`pilot_tone3`,pilot_tone1:`pilot_tone1`,pilot_tone2:`pilot_tone2`,pilot_tone3:`pilot_tone3`,pilot_tone4:`pilot_tone4`,pilot_tone5:`pilot_tone5`,piñata:`piñata`,pinched_fingers:`pinched_fingers`,pinched_fingers_dark_skin_tone:`pinched_fingers_tone5`,pinched_fingers_light_skin_tone:`pinched_fingers_tone1`,pinched_fingers_medium_dark_skin_tone:`pinched_fingers_tone4`,pinched_fingers_medium_light_skin_tone:`pinched_fingers_tone2`,pinched_fingers_medium_skin_tone:`pinched_fingers_tone3`,pinched_fingers_tone1:`pinched_fingers_tone1`,pinched_fingers_tone2:`pinched_fingers_tone2`,pinched_fingers_tone3:`pinched_fingers_tone3`,pinched_fingers_tone4:`pinched_fingers_tone4`,pinched_fingers_tone5:`pinched_fingers_tone5`,pinching_hand:`pinching_hand`,pinching_hand_dark_skin_tone:`pinching_hand_tone5`,pinching_hand_light_skin_tone:`pinching_hand_tone1`,pinching_hand_medium_dark_skin_tone:`pinching_hand_tone4`,pinching_hand_medium_light_skin_tone:`pinching_hand_tone2`,pinching_hand_medium_skin_tone:`pinching_hand_tone3`,pinching_hand_tone1:`pinching_hand_tone1`,pinching_hand_tone2:`pinching_hand_tone2`,pinching_hand_tone3:`pinching_hand_tone3`,pinching_hand_tone4:`pinching_hand_tone4`,pinching_hand_tone5:`pinching_hand_tone5`,pineapple:`pineapple`,ping_pong:`ping_pong`,pink_heart:`pink_heart`,pirate_flag:`pirate_flag`,pisces:`pisces`,pistol:`gun`,pizza:`pizza`,pk:`flag_pk`,pl:`flag_pl`,placard:`placard`,place_of_worship:`place_of_worship`,play_pause:`play_pause`,playground_slide:`playground_slide`,pleading_face:`pleading_face`,plunger:`plunger`,pm:`flag_pm`,pn:`flag_pn`,point_down:`point_down`,point_down_tone1:`point_down_tone1`,point_down_tone2:`point_down_tone2`,point_down_tone3:`point_down_tone3`,point_down_tone4:`point_down_tone4`,point_down_tone5:`point_down_tone5`,point_left:`point_left`,point_left_tone1:`point_left_tone1`,point_left_tone2:`point_left_tone2`,point_left_tone3:`point_left_tone3`,point_left_tone4:`point_left_tone4`,point_left_tone5:`point_left_tone5`,point_right:`point_right`,point_right_tone1:`point_right_tone1`,point_right_tone2:`point_right_tone2`,point_right_tone3:`point_right_tone3`,point_right_tone4:`point_right_tone4`,point_right_tone5:`point_right_tone5`,point_up:`point_up`,point_up_2:`point_up_2`,point_up_2_tone1:`point_up_2_tone1`,point_up_2_tone2:`point_up_2_tone2`,point_up_2_tone3:`point_up_2_tone3`,point_up_2_tone4:`point_up_2_tone4`,point_up_2_tone5:`point_up_2_tone5`,point_up_tone1:`point_up_tone1`,point_up_tone2:`point_up_tone2`,point_up_tone3:`point_up_tone3`,point_up_tone4:`point_up_tone4`,point_up_tone5:`point_up_tone5`,polar_bear:`polar_bear`,police_car:`police_car`,police_officer:`police_officer`,police_officer_tone1:`police_officer_tone1`,police_officer_tone2:`police_officer_tone2`,police_officer_tone3:`police_officer_tone3`,police_officer_tone4:`police_officer_tone4`,police_officer_tone5:`police_officer_tone5`,poo:`poop`,poodle:`poodle`,poop:`poop`,popcorn:`popcorn`,post_office:`post_office`,postal_horn:`postal_horn`,postbox:`postbox`,pot_of_food:`stew`,potable_water:`potable_water`,potato:`potato`,potted_plant:`potted_plant`,pouch:`pouch`,poultry_leg:`poultry_leg`,pound:`pound`,pound_symbol:`pound_symbol`,pouring_liquid:`pouring_liquid`,pouting_cat:`pouting_cat`,pouting_face:`rage`,pr:`flag_pr`,pray:`pray`,pray_tone1:`pray_tone1`,pray_tone2:`pray_tone2`,pray_tone3:`pray_tone3`,pray_tone4:`pray_tone4`,pray_tone5:`pray_tone5`,prayer_beads:`prayer_beads`,pregnant_man:`pregnant_man`,pregnant_man_dark_skin_tone:`pregnant_man_tone5`,pregnant_man_light_skin_tone:`pregnant_man_tone1`,pregnant_man_medium_dark_skin_tone:`pregnant_man_tone4`,pregnant_man_medium_light_skin_tone:`pregnant_man_tone2`,pregnant_man_medium_skin_tone:`pregnant_man_tone3`,pregnant_man_tone1:`pregnant_man_tone1`,pregnant_man_tone2:`pregnant_man_tone2`,pregnant_man_tone3:`pregnant_man_tone3`,pregnant_man_tone4:`pregnant_man_tone4`,pregnant_man_tone5:`pregnant_man_tone5`,pregnant_person:`pregnant_person`,pregnant_person_dark_skin_tone:`pregnant_person_tone5`,pregnant_person_light_skin_tone:`pregnant_person_tone1`,pregnant_person_medium_dark_skin_tone:`pregnant_person_tone4`,pregnant_person_medium_light_skin_tone:`pregnant_person_tone2`,pregnant_person_medium_skin_tone:`pregnant_person_tone3`,pregnant_person_tone1:`pregnant_person_tone1`,pregnant_person_tone2:`pregnant_person_tone2`,pregnant_person_tone3:`pregnant_person_tone3`,pregnant_person_tone4:`pregnant_person_tone4`,pregnant_person_tone5:`pregnant_person_tone5`,pregnant_woman:`pregnant_woman`,pregnant_woman_tone1:`pregnant_woman_tone1`,pregnant_woman_tone2:`pregnant_woman_tone2`,pregnant_woman_tone3:`pregnant_woman_tone3`,pregnant_woman_tone4:`pregnant_woman_tone4`,pregnant_woman_tone5:`pregnant_woman_tone5`,pretzel:`pretzel`,previous_track:`track_previous`,prince:`prince`,prince_tone1:`prince_tone1`,prince_tone2:`prince_tone2`,prince_tone3:`prince_tone3`,prince_tone4:`prince_tone4`,prince_tone5:`prince_tone5`,princess:`princess`,princess_tone1:`princess_tone1`,princess_tone2:`princess_tone2`,princess_tone3:`princess_tone3`,princess_tone4:`princess_tone4`,princess_tone5:`princess_tone5`,printer:`printer`,probing_cane:`probing_cane`,prohibited:`no_entry_sign`,projector:`projector`,ps:`flag_ps`,pt:`flag_pt`,pudding:`custard`,punch:`punch`,punch_tone1:`punch_tone1`,punch_tone2:`punch_tone2`,punch_tone3:`punch_tone3`,punch_tone4:`punch_tone4`,punch_tone5:`punch_tone5`,purple_circle:`purple_circle`,purple_heart:`purple_heart`,purple_square:`purple_square`,purse:`purse`,pushpin:`pushpin`,put_litter_in_its_place:`put_litter_in_its_place`,puzzle_piece:`jigsaw`,pw:`flag_pw`,py:`flag_py`,qa:`flag_qa`,question:`question`,question_mark:`question`,rabbit:`rabbit`,rabbit_face:`rabbit`,rabbit2:`rabbit2`,raccoon:`raccoon`,race_car:`race_car`,racehorse:`racehorse`,racing_car:`race_car`,racing_motorcycle:`motorcycle`,radio:`radio`,radio_button:`radio_button`,radioactive:`radioactive`,radioactive_sign:`radioactive`,rage:`rage`,railroad_track:`railway_track`,railway_car:`railway_car`,railway_track:`railway_track`,rainbow:`rainbow`,rainbow_flag:`rainbow_flag`,raised_back_of_hand:`raised_back_of_hand`,raised_back_of_hand_tone1:`raised_back_of_hand_tone1`,raised_back_of_hand_tone2:`raised_back_of_hand_tone2`,raised_back_of_hand_tone3:`raised_back_of_hand_tone3`,raised_back_of_hand_tone4:`raised_back_of_hand_tone4`,raised_back_of_hand_tone5:`raised_back_of_hand_tone5`,raised_fist:`fist`,raised_hand:`raised_hand`,raised_hand_tone1:`raised_hand_tone1`,raised_hand_tone2:`raised_hand_tone2`,raised_hand_tone3:`raised_hand_tone3`,raised_hand_tone4:`raised_hand_tone4`,raised_hand_tone5:`raised_hand_tone5`,raised_hand_with_fingers_splayed:`hand_splayed`,raised_hand_with_fingers_splayed_tone1:`hand_splayed_tone1`,raised_hand_with_fingers_splayed_tone2:`hand_splayed_tone2`,raised_hand_with_fingers_splayed_tone3:`hand_splayed_tone3`,raised_hand_with_fingers_splayed_tone4:`hand_splayed_tone4`,raised_hand_with_fingers_splayed_tone5:`hand_splayed_tone5`,raised_hand_with_part_between_middle_and_ring_fingers:`vulcan`,raised_hand_with_part_between_middle_and_ring_fingers_tone1:`vulcan_tone1`,raised_hand_with_part_between_middle_and_ring_fingers_tone2:`vulcan_tone2`,raised_hand_with_part_between_middle_and_ring_fingers_tone3:`vulcan_tone3`,raised_hand_with_part_between_middle_and_ring_fingers_tone4:`vulcan_tone4`,raised_hand_with_part_between_middle_and_ring_fingers_tone5:`vulcan_tone5`,raised_hands:`raised_hands`,raised_hands_tone1:`raised_hands_tone1`,raised_hands_tone2:`raised_hands_tone2`,raised_hands_tone3:`raised_hands_tone3`,raised_hands_tone4:`raised_hands_tone4`,raised_hands_tone5:`raised_hands_tone5`,raising_hand:`person_raising_hand`,raising_hand_tone1:`person_raising_hand_tone1`,raising_hand_tone2:`person_raising_hand_tone2`,raising_hand_tone3:`person_raising_hand_tone3`,raising_hand_tone4:`person_raising_hand_tone4`,raising_hand_tone5:`person_raising_hand_tone5`,raising_hands:`raised_hands`,ram:`ram`,ramen:`ramen`,rat:`rat`,razor:`razor`,re:`flag_re`,receipt:`receipt`,record_button:`record_button`,recycle:`recycle`,red_apple:`apple`,red_car:`red_car`,red_circle:`red_circle`,red_envelope:`red_envelope`,red_heart:`heart`,red_square:`red_square`,regional_indicator_a:`regional_indicator_a`,regional_indicator_b:`regional_indicator_b`,regional_indicator_c:`regional_indicator_c`,regional_indicator_d:`regional_indicator_d`,regional_indicator_e:`regional_indicator_e`,regional_indicator_f:`regional_indicator_f`,regional_indicator_g:`regional_indicator_g`,regional_indicator_h:`regional_indicator_h`,regional_indicator_i:`regional_indicator_i`,regional_indicator_j:`regional_indicator_j`,regional_indicator_k:`regional_indicator_k`,regional_indicator_l:`regional_indicator_l`,regional_indicator_m:`regional_indicator_m`,regional_indicator_n:`regional_indicator_n`,regional_indicator_o:`regional_indicator_o`,regional_indicator_p:`regional_indicator_p`,regional_indicator_q:`regional_indicator_q`,regional_indicator_r:`regional_indicator_r`,regional_indicator_s:`regional_indicator_s`,regional_indicator_t:`regional_indicator_t`,regional_indicator_u:`regional_indicator_u`,regional_indicator_v:`regional_indicator_v`,regional_indicator_w:`regional_indicator_w`,regional_indicator_x:`regional_indicator_x`,regional_indicator_y:`regional_indicator_y`,regional_indicator_z:`regional_indicator_z`,registered:`registered`,relaxed:`relaxed`,relieved:`relieved`,relieved_face:`relieved`,reminder_ribbon:`reminder_ribbon`,repeat:`repeat`,repeat_one:`repeat_one`,restroom:`restroom`,reversed_hand_with_middle_finger_extended:`middle_finger`,reversed_hand_with_middle_finger_extended_tone1:`middle_finger_tone1`,reversed_hand_with_middle_finger_extended_tone2:`middle_finger_tone2`,reversed_hand_with_middle_finger_extended_tone3:`middle_finger_tone3`,reversed_hand_with_middle_finger_extended_tone4:`middle_finger_tone4`,reversed_hand_with_middle_finger_extended_tone5:`middle_finger_tone5`,revolving_hearts:`revolving_hearts`,rewind:`rewind`,rhino:`rhino`,rhinoceros:`rhino`,ribbon:`ribbon`,rice:`rice`,rice_ball:`rice_ball`,rice_cracker:`rice_cracker`,rice_scene:`rice_scene`,right_anger_bubble:`anger_right`,right_arrow:`arrow_right`,right_facing_fist:`right_facing_fist`,right_facing_fist_tone1:`right_facing_fist_tone1`,right_facing_fist_tone2:`right_facing_fist_tone2`,right_facing_fist_tone3:`right_facing_fist_tone3`,right_facing_fist_tone4:`right_facing_fist_tone4`,right_facing_fist_tone5:`right_facing_fist_tone5`,right_fist:`right_facing_fist`,right_fist_tone1:`right_facing_fist_tone1`,right_fist_tone2:`right_facing_fist_tone2`,right_fist_tone3:`right_facing_fist_tone3`,right_fist_tone4:`right_facing_fist_tone4`,right_fist_tone5:`right_facing_fist_tone5`,rightwards_hand:`rightwards_hand`,rightwards_hand_dark_skin_tone:`rightwards_hand_tone5`,rightwards_hand_light_skin_tone:`rightwards_hand_tone1`,rightwards_hand_medium_dark_skin_tone:`rightwards_hand_tone4`,rightwards_hand_medium_light_skin_tone:`rightwards_hand_tone2`,rightwards_hand_medium_skin_tone:`rightwards_hand_tone3`,rightwards_hand_tone1:`rightwards_hand_tone1`,rightwards_hand_tone2:`rightwards_hand_tone2`,rightwards_hand_tone3:`rightwards_hand_tone3`,rightwards_hand_tone4:`rightwards_hand_tone4`,rightwards_hand_tone5:`rightwards_hand_tone5`,rightwards_pushing_hand:`rightwards_pushing_hand`,rightwards_pushing_hand_dark_skin_tone:`rightwards_pushing_hand_tone5`,rightwards_pushing_hand_light_skin_tone:`rightwards_pushing_hand_tone1`,rightwards_pushing_hand_medium_dark_skin_tone:`rightwards_pushing_hand_tone4`,rightwards_pushing_hand_medium_light_skin_tone:`rightwards_pushing_hand_tone2`,rightwards_pushing_hand_medium_skin_tone:`rightwards_pushing_hand_tone3`,rightwards_pushing_hand_tone1:`rightwards_pushing_hand_tone1`,rightwards_pushing_hand_tone2:`rightwards_pushing_hand_tone2`,rightwards_pushing_hand_tone3:`rightwards_pushing_hand_tone3`,rightwards_pushing_hand_tone4:`rightwards_pushing_hand_tone4`,rightwards_pushing_hand_tone5:`rightwards_pushing_hand_tone5`,ring:`ring`,ring_buoy:`ring_buoy`,ringed_planet:`ringed_planet`,ro:`flag_ro`,robot:`robot`,robot_face:`robot`,rock:`rock`,rocket:`rocket`,rofl:`rofl`,roll_of_paper:`roll_of_paper`,rolled_up_newspaper:`newspaper2`,roller_coaster:`roller_coaster`,roller_skate:`roller_skate`,rolling_eyes:`rolling_eyes`,rolling_on_the_floor_laughing:`rofl`,rooster:`rooster`,root_vegetable:`root_vegetable`,rose:`rose`,rosette:`rosette`,rotating_light:`rotating_light`,round_pushpin:`round_pushpin`,rowboat:`person_rowing_boat`,rowboat_tone1:`person_rowing_boat_tone1`,rowboat_tone2:`person_rowing_boat_tone2`,rowboat_tone3:`person_rowing_boat_tone3`,rowboat_tone4:`person_rowing_boat_tone4`,rowboat_tone5:`person_rowing_boat_tone5`,rs:`flag_rs`,ru:`flag_ru`,rugby_football:`rugby_football`,runner:`person_running`,runner_tone1:`person_running_tone1`,runner_tone2:`person_running_tone2`,runner_tone3:`person_running_tone3`,runner_tone4:`person_running_tone4`,runner_tone5:`person_running_tone5`,running_shirt:`running_shirt_with_sash`,running_shirt_with_sash:`running_shirt_with_sash`,running_shoe:`athletic_shoe`,rw:`flag_rw`,sa:`sa`,safety_pin:`safety_pin`,safety_vest:`safety_vest`,sagittarius:`sagittarius`,sailboat:`sailboat`,sake:`sake`,salad:`salad`,salt:`salt`,saluting_face:`saluting_face`,sandal:`sandal`,sandwich:`sandwich`,santa:`santa`,santa_claus:`santa`,santa_tone1:`santa_tone1`,santa_tone2:`santa_tone2`,santa_tone3:`santa_tone3`,santa_tone4:`santa_tone4`,santa_tone5:`santa_tone5`,sari:`sari`,satellite:`satellite`,satellite_orbital:`satellite_orbital`,satisfied:`laughing`,saudi:`flag_sa`,saudiarabia:`flag_sa`,sauropod:`sauropod`,saxophone:`saxophone`,sb:`flag_sb`,sc:`flag_sc`,scales:`scales`,scarf:`scarf`,school:`school`,school_satchel:`school_satchel`,scientist:`scientist`,scientist_dark_skin_tone:`scientist_tone5`,scientist_light_skin_tone:`scientist_tone1`,scientist_medium_dark_skin_tone:`scientist_tone4`,scientist_medium_light_skin_tone:`scientist_tone2`,scientist_medium_skin_tone:`scientist_tone3`,scientist_tone1:`scientist_tone1`,scientist_tone2:`scientist_tone2`,scientist_tone3:`scientist_tone3`,scientist_tone4:`scientist_tone4`,scientist_tone5:`scientist_tone5`,scissors:`scissors`,scooter:`scooter`,scorpio:`scorpius`,scorpion:`scorpion`,scorpius:`scorpius`,scotland:`scotland`,scream:`scream`,scream_cat:`scream_cat`,screwdriver:`screwdriver`,scroll:`scroll`,sd:`flag_sd`,se:`flag_se`,seal:`seal`,seat:`seat`,second_place:`second_place`,second_place_medal:`second_place`,secret:`secret`,see_no_evil:`see_no_evil`,seedling:`seedling`,selfie:`selfie`,selfie_tone1:`selfie_tone1`,selfie_tone2:`selfie_tone2`,selfie_tone3:`selfie_tone3`,selfie_tone4:`selfie_tone4`,selfie_tone5:`selfie_tone5`,service_dog:`service_dog`,seven:`seven`,seven_oclock:`clock7`,seven_thirty:`clock730`,sewing_needle:`sewing_needle`,sg:`flag_sg`,sh:`flag_sh`,shaking_face:`shaking_face`,shaking_hands:`handshake`,shallow_pan_of_food:`shallow_pan_of_food`,shamrock:`shamrock`,shark:`shark`,shaved_ice:`shaved_ice`,sheaf_of_rice:`ear_of_rice`,sheep:`sheep`,shell:`shell`,shelled_peanut:`peanuts`,shield:`shield`,shinto_shrine:`shinto_shrine`,ship:`ship`,shirt:`shirt`,shit:`poop`,shooting_star:`stars`,shopping_bags:`shopping_bags`,shopping_cart:`shopping_cart`,shopping_trolley:`shopping_cart`,shortcake:`cake`,shorts:`shorts`,shovel:`shovel`,shower:`shower`,shrimp:`shrimp`,shrug:`person_shrugging`,shrug_tone1:`person_shrugging_tone1`,shrug_tone2:`person_shrugging_tone2`,shrug_tone3:`person_shrugging_tone3`,shrug_tone4:`person_shrugging_tone4`,shrug_tone5:`person_shrugging_tone5`,shushing_face:`shushing_face`,si:`flag_si`,sick:`nauseated_face`,sign_of_the_horns:`metal`,sign_of_the_horns_tone1:`metal_tone1`,sign_of_the_horns_tone2:`metal_tone2`,sign_of_the_horns_tone3:`metal_tone3`,sign_of_the_horns_tone4:`metal_tone4`,sign_of_the_horns_tone5:`metal_tone5`,signal_strength:`signal_strength`,singer:`singer`,singer_dark_skin_tone:`singer_tone5`,singer_light_skin_tone:`singer_tone1`,singer_medium_dark_skin_tone:`singer_tone4`,singer_medium_light_skin_tone:`singer_tone2`,singer_medium_skin_tone:`singer_tone3`,singer_tone1:`singer_tone1`,singer_tone2:`singer_tone2`,singer_tone3:`singer_tone3`,singer_tone4:`singer_tone4`,singer_tone5:`singer_tone5`,six:`six`,six_oclock:`clock6`,six_pointed_star:`six_pointed_star`,six_thirty:`clock630`,sj:`flag_sj`,sk:`flag_sk`,skateboard:`skateboard`,skeleton:`skull`,ski:`ski`,skier:`skier`,skis:`ski`,skull:`skull`,skull_and_crossbones:`skull_crossbones`,skull_crossbones:`skull_crossbones`,skunk:`skunk`,sl:`flag_sl`,sled:`sled`,sleeping:`sleeping`,sleeping_accommodation:`sleeping_accommodation`,sleeping_face:`sleeping`,sleepy:`sleepy`,sleepy_face:`sleepy`,sleuth_or_spy:`detective`,sleuth_or_spy_tone1:`detective_tone1`,sleuth_or_spy_tone2:`detective_tone2`,sleuth_or_spy_tone3:`detective_tone3`,sleuth_or_spy_tone4:`detective_tone4`,sleuth_or_spy_tone5:`detective_tone5`,slight_frown:`slight_frown`,slight_smile:`slight_smile`,slightly_frowning_face:`slight_frown`,slightly_smiling_face:`slight_smile`,slot_machine:`slot_machine`,sloth:`sloth`,sm:`flag_sm`,small_airplane:`airplane_small`,small_blue_diamond:`small_blue_diamond`,small_orange_diamond:`small_orange_diamond`,small_red_triangle:`small_red_triangle`,small_red_triangle_down:`small_red_triangle_down`,smile:`smile`,smile_cat:`smile_cat`,smiley:`smiley`,smiley_cat:`smiley_cat`,smiling_face:`relaxed`,smiling_face_with_3_hearts:`smiling_face_with_3_hearts`,smiling_face_with_tear:`smiling_face_with_tear`,smiling_imp:`smiling_imp`,smirk:`smirk`,smirk_cat:`smirk_cat`,smirking_face:`smirk`,smoking:`smoking`,sn:`flag_sn`,snail:`snail`,snake:`snake`,sneeze:`sneezing_face`,sneezing_face:`sneezing_face`,snow_capped_mountain:`mountain_snow`,snowboarder:`snowboarder`,snowboarder_dark_skin_tone:`snowboarder_tone5`,snowboarder_light_skin_tone:`snowboarder_tone1`,snowboarder_medium_dark_skin_tone:`snowboarder_tone4`,snowboarder_medium_light_skin_tone:`snowboarder_tone2`,snowboarder_medium_skin_tone:`snowboarder_tone3`,snowboarder_tone1:`snowboarder_tone1`,snowboarder_tone2:`snowboarder_tone2`,snowboarder_tone3:`snowboarder_tone3`,snowboarder_tone4:`snowboarder_tone4`,snowboarder_tone5:`snowboarder_tone5`,snowflake:`snowflake`,snowman:`snowman`,snowman2:`snowman2`,so:`flag_so`,soap:`soap`,sob:`sob`,soccer:`soccer`,soccer_ball:`soccer`,socks:`socks`,softball:`softball`,soon:`soon`,soon_arrow:`soon`,sos:`sos`,sound:`sound`,space_invader:`space_invader`,spade_suit:`spades`,spades:`spades`,spaghetti:`spaghetti`,sparkle:`sparkle`,sparkler:`sparkler`,sparkles:`sparkles`,sparkling_heart:`sparkling_heart`,speak_no_evil:`speak_no_evil`,speaker:`speaker`,speaking_head:`speaking_head`,speaking_head_in_silhouette:`speaking_head`,speech_balloon:`speech_balloon`,speech_left:`speech_left`,speedboat:`speedboat`,spider:`spider`,spider_web:`spider_web`,spiral_calendar_pad:`calendar_spiral`,spiral_note_pad:`notepad_spiral`,spiral_shell:`shell`,splatter:`splatter`,sponge:`sponge`,spoon:`spoon`,sports_medal:`medal`,spy:`detective`,spy_tone1:`detective_tone1`,spy_tone2:`detective_tone2`,spy_tone3:`detective_tone3`,spy_tone4:`detective_tone4`,spy_tone5:`detective_tone5`,squeeze_bottle:`squeeze_bottle`,squid:`squid`,sr:`flag_sr`,ss:`flag_ss`,st:`flag_st`,stadium:`stadium`,star:`star`,star_and_crescent:`star_and_crescent`,star_of_david:`star_of_david`,star_struck:`star_struck`,star2:`star2`,stars:`stars`,station:`station`,statue_of_liberty:`statue_of_liberty`,steam_locomotive:`steam_locomotive`,steaming_bowl:`ramen`,stethoscope:`stethoscope`,stew:`stew`,stop_button:`stop_button`,stop_sign:`octagonal_sign`,stopwatch:`stopwatch`,straight_ruler:`straight_ruler`,strawberry:`strawberry`,stuck_out_tongue:`stuck_out_tongue`,stuck_out_tongue_closed_eyes:`stuck_out_tongue_closed_eyes`,stuck_out_tongue_winking_eye:`stuck_out_tongue_winking_eye`,student:`student`,student_dark_skin_tone:`student_tone5`,student_light_skin_tone:`student_tone1`,student_medium_dark_skin_tone:`student_tone4`,student_medium_light_skin_tone:`student_tone2`,student_medium_skin_tone:`student_tone3`,student_tone1:`student_tone1`,student_tone2:`student_tone2`,student_tone3:`student_tone3`,student_tone4:`student_tone4`,student_tone5:`student_tone5`,studio_microphone:`microphone2`,stuffed_flatbread:`stuffed_flatbread`,stuffed_pita:`stuffed_flatbread`,sun:`sunny`,sun_with_face:`sun_with_face`,sunflower:`sunflower`,sunglasses:`sunglasses`,sunny:`sunny`,sunrise:`sunrise`,sunrise_over_mountains:`sunrise_over_mountains`,sunset:`city_sunset`,superhero:`superhero`,superhero_dark_skin_tone:`superhero_tone5`,superhero_light_skin_tone:`superhero_tone1`,superhero_medium_dark_skin_tone:`superhero_tone4`,superhero_medium_light_skin_tone:`superhero_tone2`,superhero_medium_skin_tone:`superhero_tone3`,superhero_tone1:`superhero_tone1`,superhero_tone2:`superhero_tone2`,superhero_tone3:`superhero_tone3`,superhero_tone4:`superhero_tone4`,superhero_tone5:`superhero_tone5`,supervillain:`supervillain`,supervillain_dark_skin_tone:`supervillain_tone5`,supervillain_light_skin_tone:`supervillain_tone1`,supervillain_medium_dark_skin_tone:`supervillain_tone4`,supervillain_medium_light_skin_tone:`supervillain_tone2`,supervillain_medium_skin_tone:`supervillain_tone3`,supervillain_tone1:`supervillain_tone1`,supervillain_tone2:`supervillain_tone2`,supervillain_tone3:`supervillain_tone3`,supervillain_tone4:`supervillain_tone4`,supervillain_tone5:`supervillain_tone5`,surfer:`person_surfing`,surfer_tone1:`person_surfing_tone1`,surfer_tone2:`person_surfing_tone2`,surfer_tone3:`person_surfing_tone3`,surfer_tone4:`person_surfing_tone4`,surfer_tone5:`person_surfing_tone5`,sushi:`sushi`,suspension_railway:`suspension_railway`,sv:`flag_sv`,swan:`swan`,sweat:`sweat`,sweat_drops:`sweat_drops`,sweat_smile:`sweat_smile`,sweet_potato:`sweet_potato`,swimmer:`person_swimming`,swimmer_tone1:`person_swimming_tone1`,swimmer_tone2:`person_swimming_tone2`,swimmer_tone3:`person_swimming_tone3`,swimmer_tone4:`person_swimming_tone4`,swimmer_tone5:`person_swimming_tone5`,sx:`flag_sx`,sy:`flag_sy`,symbols:`symbols`,synagogue:`synagogue`,syringe:`syringe`,sz:`flag_sz`,t_rex:`t_rex`,t_shirt:`shirt`,ta:`flag_ta`,table_tennis:`ping_pong`,taco:`taco`,tada:`tada`,takeout_box:`takeout_box`,tamale:`tamale`,tanabata_tree:`tanabata_tree`,tangerine:`tangerine`,taurus:`taurus`,taxi:`taxi`,tc:`flag_tc`,td:`flag_td`,tea:`tea`,teacher:`teacher`,teacher_dark_skin_tone:`teacher_tone5`,teacher_light_skin_tone:`teacher_tone1`,teacher_medium_dark_skin_tone:`teacher_tone4`,teacher_medium_light_skin_tone:`teacher_tone2`,teacher_medium_skin_tone:`teacher_tone3`,teacher_tone1:`teacher_tone1`,teacher_tone2:`teacher_tone2`,teacher_tone3:`teacher_tone3`,teacher_tone4:`teacher_tone4`,teacher_tone5:`teacher_tone5`,teapot:`teapot`,technologist:`technologist`,technologist_dark_skin_tone:`technologist_tone5`,technologist_light_skin_tone:`technologist_tone1`,technologist_medium_dark_skin_tone:`technologist_tone4`,technologist_medium_light_skin_tone:`technologist_tone2`,technologist_medium_skin_tone:`technologist_tone3`,technologist_tone1:`technologist_tone1`,technologist_tone2:`technologist_tone2`,technologist_tone3:`technologist_tone3`,technologist_tone4:`technologist_tone4`,technologist_tone5:`technologist_tone5`,teddy_bear:`teddy_bear`,telephone:`telephone`,telephone_receiver:`telephone_receiver`,telescope:`telescope`,television:`tv`,ten_oclock:`clock10`,ten_thirty:`clock1030`,tennis:`tennis`,tent:`tent`,test_tube:`test_tube`,tf:`flag_tf`,tg:`flag_tg`,th:`flag_th`,thermometer:`thermometer`,thermometer_face:`thermometer_face`,thinking:`thinking`,thinking_face:`thinking`,third_place:`third_place`,third_place_medal:`third_place`,thong_sandal:`thong_sandal`,thought_balloon:`thought_balloon`,thread:`thread`,three:`three`,three_button_mouse:`mouse_three_button`,three_oclock:`clock3`,three_thirty:`clock330`,thumbdown:`thumbsdown`,thumbdown_tone1:`thumbsdown_tone1`,thumbdown_tone2:`thumbsdown_tone2`,thumbdown_tone3:`thumbsdown_tone3`,thumbdown_tone4:`thumbsdown_tone4`,thumbdown_tone5:`thumbsdown_tone5`,thumbs_down:`thumbsdown`,thumbs_up:`thumbsup`,thumbsdown:`thumbsdown`,thumbsdown_tone1:`thumbsdown_tone1`,thumbsdown_tone2:`thumbsdown_tone2`,thumbsdown_tone3:`thumbsdown_tone3`,thumbsdown_tone4:`thumbsdown_tone4`,thumbsdown_tone5:`thumbsdown_tone5`,thumbsup:`thumbsup`,thumbsup_tone1:`thumbsup_tone1`,thumbsup_tone2:`thumbsup_tone2`,thumbsup_tone3:`thumbsup_tone3`,thumbsup_tone4:`thumbsup_tone4`,thumbsup_tone5:`thumbsup_tone5`,thumbup:`thumbsup`,thumbup_tone1:`thumbsup_tone1`,thumbup_tone2:`thumbsup_tone2`,thumbup_tone3:`thumbsup_tone3`,thumbup_tone4:`thumbsup_tone4`,thumbup_tone5:`thumbsup_tone5`,thunder_cloud_and_rain:`thunder_cloud_rain`,thunder_cloud_rain:`thunder_cloud_rain`,ticket:`ticket`,tickets:`tickets`,tiger:`tiger`,tiger_face:`tiger`,tiger2:`tiger2`,timer:`timer`,timer_clock:`timer`,tired_face:`tired_face`,tj:`flag_tj`,tk:`flag_tk`,tl:`flag_tl`,tm:`tm`,tn:`flag_tn`,to:`flag_to`,toilet:`toilet`,tokyo_tower:`tokyo_tower`,tomato:`tomato`,tone1:`tone1`,tone2:`tone2`,tone3:`tone3`,tone4:`tone4`,tone5:`tone5`,tongue:`tongue`,toolbox:`toolbox`,tools:`tools`,tooth:`tooth`,toothbrush:`toothbrush`,top:`top`,top_arrow:`top`,top_hat:`tophat`,tophat:`tophat`,tornado:`cloud_tornado`,tr:`flag_tr`,track_next:`track_next`,track_previous:`track_previous`,trackball:`trackball`,tractor:`tractor`,trade_mark:`tm`,traffic_light:`traffic_light`,train:`train`,train2:`train2`,tram:`tram`,tram_car:`train`,transgender_flag:`transgender_flag`,transgender_symbol:`transgender_symbol`,triangular_flag_on_post:`triangular_flag_on_post`,triangular_ruler:`triangular_ruler`,trident:`trident`,triumph:`triumph`,troll:`troll`,trolleybus:`trolleybus`,trophy:`trophy`,tropical_drink:`tropical_drink`,tropical_fish:`tropical_fish`,truck:`truck`,trumpet:`trumpet`,tt:`flag_tt`,tulip:`tulip`,tumbler_glass:`tumbler_glass`,turkey:`turkey`,turkmenistan:`flag_tm`,turtle:`turtle`,tuvalu:`flag_tv`,tuxedo_tone1:`person_in_tuxedo_tone1`,tuxedo_tone2:`person_in_tuxedo_tone2`,tuxedo_tone3:`person_in_tuxedo_tone3`,tuxedo_tone4:`person_in_tuxedo_tone4`,tuxedo_tone5:`person_in_tuxedo_tone5`,tv:`tv`,tw:`flag_tw`,twelve_oclock:`clock12`,twelve_thirty:`clock1230`,twisted_rightwards_arrows:`twisted_rightwards_arrows`,two:`two`,two_hearts:`two_hearts`,two_men_holding_hands:`two_men_holding_hands`,two_oclock:`clock2`,two_thirty:`clock230`,two_women_holding_hands:`two_women_holding_hands`,tz:`flag_tz`,u5272:`u5272`,u5408:`u5408`,u55b6:`u55b6`,u6307:`u6307`,u6708:`u6708`,u6709:`u6709`,u6e80:`u6e80`,u7121:`u7121`,u7533:`u7533`,u7981:`u7981`,u7a7a:`u7a7a`,ua:`flag_ua`,ug:`flag_ug`,um:`flag_um`,umbrella:`umbrella`,umbrella_on_ground:`beach_umbrella`,umbrella2:`umbrella2`,unamused:`unamused`,unamused_face:`unamused`,underage:`underage`,unicorn:`unicorn`,unicorn_face:`unicorn`,united_nations:`united_nations`,unlock:`unlock`,unlocked:`unlock`,up:`up`,up_arrow:`arrow_up`,up_down_arrow:`arrow_up_down`,up_left_arrow:`arrow_upper_left`,upside_down:`upside_down`,upside_down_face:`upside_down`,urn:`urn`,us:`flag_us`,uy:`flag_uy`,uz:`flag_uz`,v:`v`,v_tone1:`v_tone1`,v_tone2:`v_tone2`,v_tone3:`v_tone3`,v_tone4:`v_tone4`,v_tone5:`v_tone5`,va:`flag_va`,vampire:`vampire`,vampire_dark_skin_tone:`vampire_tone5`,vampire_light_skin_tone:`vampire_tone1`,vampire_medium_dark_skin_tone:`vampire_tone4`,vampire_medium_light_skin_tone:`vampire_tone2`,vampire_medium_skin_tone:`vampire_tone3`,vampire_tone1:`vampire_tone1`,vampire_tone2:`vampire_tone2`,vampire_tone3:`vampire_tone3`,vampire_tone4:`vampire_tone4`,vampire_tone5:`vampire_tone5`,vc:`flag_vc`,ve:`flag_ve`,vertical_traffic_light:`vertical_traffic_light`,vg:`flag_vg`,vhs:`vhs`,vi:`flag_vi`,vibration_mode:`vibration_mode`,victory_hand:`v`,video_camera:`video_camera`,video_game:`video_game`,videocassette:`vhs`,violin:`violin`,virgo:`virgo`,vn:`flag_vn`,volcano:`volcano`,volleyball:`volleyball`,vs:`vs`,vu:`flag_vu`,vulcan:`vulcan`,vulcan_salute:`vulcan`,vulcan_tone1:`vulcan_tone1`,vulcan_tone2:`vulcan_tone2`,vulcan_tone3:`vulcan_tone3`,vulcan_tone4:`vulcan_tone4`,vulcan_tone5:`vulcan_tone5`,waffle:`waffle`,wales:`wales`,walking:`person_walking`,walking_tone1:`person_walking_tone1`,walking_tone2:`person_walking_tone2`,walking_tone3:`person_walking_tone3`,walking_tone4:`person_walking_tone4`,walking_tone5:`person_walking_tone5`,waning_crescent_moon:`waning_crescent_moon`,waning_gibbous_moon:`waning_gibbous_moon`,warning:`warning`,wastebasket:`wastebasket`,watch:`watch`,water_buffalo:`water_buffalo`,water_closet:`wc`,water_polo:`person_playing_water_polo`,water_polo_tone1:`person_playing_water_polo_tone1`,water_polo_tone2:`person_playing_water_polo_tone2`,water_polo_tone3:`person_playing_water_polo_tone3`,water_polo_tone4:`person_playing_water_polo_tone4`,water_polo_tone5:`person_playing_water_polo_tone5`,water_wave:`ocean`,watermelon:`watermelon`,wave:`wave`,wave_tone1:`wave_tone1`,wave_tone2:`wave_tone2`,wave_tone3:`wave_tone3`,wave_tone4:`wave_tone4`,wave_tone5:`wave_tone5`,waving_black_flag:`flag_black`,waving_hand:`wave`,waving_white_flag:`flag_white`,wavy_dash:`wavy_dash`,waxing_crescent_moon:`waxing_crescent_moon`,waxing_gibbous_moon:`waxing_gibbous_moon`,wc:`wc`,weary:`weary`,weary_cat:`scream_cat`,weary_face:`weary`,wedding:`wedding`,weight_lifter:`person_lifting_weights`,weight_lifter_tone1:`person_lifting_weights_tone1`,weight_lifter_tone2:`person_lifting_weights_tone2`,weight_lifter_tone3:`person_lifting_weights_tone3`,weight_lifter_tone4:`person_lifting_weights_tone4`,weight_lifter_tone5:`person_lifting_weights_tone5`,wf:`flag_wf`,whale:`whale`,whale2:`whale2`,wheel:`wheel`,wheel_of_dharma:`wheel_of_dharma`,wheelchair:`wheelchair`,whisky:`tumbler_glass`,white_check_mark:`white_check_mark`,white_circle:`white_circle`,white_flag:`flag_white`,white_flower:`white_flower`,white_frowning_face:`frowning2`,white_heart:`white_heart`,white_large_square:`white_large_square`,white_medium_small_square:`white_medium_small_square`,white_medium_square:`white_medium_square`,white_small_square:`white_small_square`,white_square_button:`white_square_button`,white_sun_behind_cloud:`white_sun_cloud`,white_sun_behind_cloud_with_rain:`white_sun_rain_cloud`,white_sun_cloud:`white_sun_cloud`,white_sun_rain_cloud:`white_sun_rain_cloud`,white_sun_small_cloud:`white_sun_small_cloud`,white_sun_with_small_cloud:`white_sun_small_cloud`,wilted_flower:`wilted_rose`,wilted_rose:`wilted_rose`,wind_blowing_face:`wind_blowing_face`,wind_chime:`wind_chime`,wind_face:`wind_blowing_face`,window:`window`,wine_glass:`wine_glass`,wing:`wing`,wink:`wink`,winking_face:`wink`,wireless:`wireless`,wolf:`wolf`,woman:`woman`,woman_and_man_holding_hands_dark_skin_tone:`woman_and_man_holding_hands_tone5`,woman_and_man_holding_hands_dark_skin_tone_light_skin_tone:`woman_and_man_holding_hands_tone5_tone1`,woman_and_man_holding_hands_dark_skin_tone_medium_dark_skin_tone:`woman_and_man_holding_hands_tone5_tone4`,woman_and_man_holding_hands_dark_skin_tone_medium_light_skin_tone:`woman_and_man_holding_hands_tone5_tone2`,woman_and_man_holding_hands_dark_skin_tone_medium_skin_tone:`woman_and_man_holding_hands_tone5_tone3`,woman_and_man_holding_hands_light_skin_tone:`woman_and_man_holding_hands_tone1`,woman_and_man_holding_hands_light_skin_tone_dark_skin_tone:`woman_and_man_holding_hands_tone1_tone5`,woman_and_man_holding_hands_light_skin_tone_medium_dark_skin_tone:`woman_and_man_holding_hands_tone1_tone4`,woman_and_man_holding_hands_light_skin_tone_medium_light_skin_tone:`woman_and_man_holding_hands_tone1_tone2`,woman_and_man_holding_hands_light_skin_tone_medium_skin_tone:`woman_and_man_holding_hands_tone1_tone3`,woman_and_man_holding_hands_medium_dark_skin_tone:`woman_and_man_holding_hands_tone4`,woman_and_man_holding_hands_medium_dark_skin_tone_dark_skin_tone:`woman_and_man_holding_hands_tone4_tone5`,woman_and_man_holding_hands_medium_dark_skin_tone_light_skin_tone:`woman_and_man_holding_hands_tone4_tone1`,woman_and_man_holding_hands_medium_dark_skin_tone_medium_light_skin_tone:`woman_and_man_holding_hands_tone4_tone2`,woman_and_man_holding_hands_medium_dark_skin_tone_medium_skin_tone:`woman_and_man_holding_hands_tone4_tone3`,woman_and_man_holding_hands_medium_light_skin_tone:`woman_and_man_holding_hands_tone2`,woman_and_man_holding_hands_medium_light_skin_tone_dark_skin_tone:`woman_and_man_holding_hands_tone2_tone5`,woman_and_man_holding_hands_medium_light_skin_tone_light_skin_tone:`woman_and_man_holding_hands_tone2_tone1`,woman_and_man_holding_hands_medium_light_skin_tone_medium_dark_skin_tone:`woman_and_man_holding_hands_tone2_tone4`,woman_and_man_holding_hands_medium_light_skin_tone_medium_skin_tone:`woman_and_man_holding_hands_tone2_tone3`,woman_and_man_holding_hands_medium_skin_tone:`woman_and_man_holding_hands_tone3`,woman_and_man_holding_hands_medium_skin_tone_dark_skin_tone:`woman_and_man_holding_hands_tone3_tone5`,woman_and_man_holding_hands_medium_skin_tone_light_skin_tone:`woman_and_man_holding_hands_tone3_tone1`,woman_and_man_holding_hands_medium_skin_tone_medium_dark_skin_tone:`woman_and_man_holding_hands_tone3_tone4`,woman_and_man_holding_hands_medium_skin_tone_medium_light_skin_tone:`woman_and_man_holding_hands_tone3_tone2`,woman_and_man_holding_hands_tone1:`woman_and_man_holding_hands_tone1`,woman_and_man_holding_hands_tone1_tone2:`woman_and_man_holding_hands_tone1_tone2`,woman_and_man_holding_hands_tone1_tone3:`woman_and_man_holding_hands_tone1_tone3`,woman_and_man_holding_hands_tone1_tone4:`woman_and_man_holding_hands_tone1_tone4`,woman_and_man_holding_hands_tone1_tone5:`woman_and_man_holding_hands_tone1_tone5`,woman_and_man_holding_hands_tone2:`woman_and_man_holding_hands_tone2`,woman_and_man_holding_hands_tone2_tone1:`woman_and_man_holding_hands_tone2_tone1`,woman_and_man_holding_hands_tone2_tone3:`woman_and_man_holding_hands_tone2_tone3`,woman_and_man_holding_hands_tone2_tone4:`woman_and_man_holding_hands_tone2_tone4`,woman_and_man_holding_hands_tone2_tone5:`woman_and_man_holding_hands_tone2_tone5`,woman_and_man_holding_hands_tone3:`woman_and_man_holding_hands_tone3`,woman_and_man_holding_hands_tone3_tone1:`woman_and_man_holding_hands_tone3_tone1`,woman_and_man_holding_hands_tone3_tone2:`woman_and_man_holding_hands_tone3_tone2`,woman_and_man_holding_hands_tone3_tone4:`woman_and_man_holding_hands_tone3_tone4`,woman_and_man_holding_hands_tone3_tone5:`woman_and_man_holding_hands_tone3_tone5`,woman_and_man_holding_hands_tone4:`woman_and_man_holding_hands_tone4`,woman_and_man_holding_hands_tone4_tone1:`woman_and_man_holding_hands_tone4_tone1`,woman_and_man_holding_hands_tone4_tone2:`woman_and_man_holding_hands_tone4_tone2`,woman_and_man_holding_hands_tone4_tone3:`woman_and_man_holding_hands_tone4_tone3`,woman_and_man_holding_hands_tone4_tone5:`woman_and_man_holding_hands_tone4_tone5`,woman_and_man_holding_hands_tone5:`woman_and_man_holding_hands_tone5`,woman_and_man_holding_hands_tone5_tone1:`woman_and_man_holding_hands_tone5_tone1`,woman_and_man_holding_hands_tone5_tone2:`woman_and_man_holding_hands_tone5_tone2`,woman_and_man_holding_hands_tone5_tone3:`woman_and_man_holding_hands_tone5_tone3`,woman_and_man_holding_hands_tone5_tone4:`woman_and_man_holding_hands_tone5_tone4`,woman_artist:`woman_artist`,woman_artist_dark_skin_tone:`woman_artist_tone5`,woman_artist_light_skin_tone:`woman_artist_tone1`,woman_artist_medium_dark_skin_tone:`woman_artist_tone4`,woman_artist_medium_light_skin_tone:`woman_artist_tone2`,woman_artist_medium_skin_tone:`woman_artist_tone3`,woman_artist_tone1:`woman_artist_tone1`,woman_artist_tone2:`woman_artist_tone2`,woman_artist_tone3:`woman_artist_tone3`,woman_artist_tone4:`woman_artist_tone4`,woman_artist_tone5:`woman_artist_tone5`,woman_astronaut:`woman_astronaut`,woman_astronaut_dark_skin_tone:`woman_astronaut_tone5`,woman_astronaut_light_skin_tone:`woman_astronaut_tone1`,woman_astronaut_medium_dark_skin_tone:`woman_astronaut_tone4`,woman_astronaut_medium_light_skin_tone:`woman_astronaut_tone2`,woman_astronaut_medium_skin_tone:`woman_astronaut_tone3`,woman_astronaut_tone1:`woman_astronaut_tone1`,woman_astronaut_tone2:`woman_astronaut_tone2`,woman_astronaut_tone3:`woman_astronaut_tone3`,woman_astronaut_tone4:`woman_astronaut_tone4`,woman_astronaut_tone5:`woman_astronaut_tone5`,woman_bald:`woman_bald`,woman_bald_dark_skin_tone:`woman_bald_tone5`,woman_bald_light_skin_tone:`woman_bald_tone1`,woman_bald_medium_dark_skin_tone:`woman_bald_tone4`,woman_bald_medium_light_skin_tone:`woman_bald_tone2`,woman_bald_medium_skin_tone:`woman_bald_tone3`,woman_bald_tone1:`woman_bald_tone1`,woman_bald_tone2:`woman_bald_tone2`,woman_bald_tone3:`woman_bald_tone3`,woman_bald_tone4:`woman_bald_tone4`,woman_bald_tone5:`woman_bald_tone5`,woman_beard:`woman_beard`,woman_biking:`woman_biking`,woman_biking_dark_skin_tone:`woman_biking_tone5`,woman_biking_light_skin_tone:`woman_biking_tone1`,woman_biking_medium_dark_skin_tone:`woman_biking_tone4`,woman_biking_medium_light_skin_tone:`woman_biking_tone2`,woman_biking_medium_skin_tone:`woman_biking_tone3`,woman_biking_tone1:`woman_biking_tone1`,woman_biking_tone2:`woman_biking_tone2`,woman_biking_tone3:`woman_biking_tone3`,woman_biking_tone4:`woman_biking_tone4`,woman_biking_tone5:`woman_biking_tone5`,woman_bouncing_ball:`woman_bouncing_ball`,woman_bouncing_ball_dark_skin_tone:`woman_bouncing_ball_tone5`,woman_bouncing_ball_light_skin_tone:`woman_bouncing_ball_tone1`,woman_bouncing_ball_medium_dark_skin_tone:`woman_bouncing_ball_tone4`,woman_bouncing_ball_medium_light_skin_tone:`woman_bouncing_ball_tone2`,woman_bouncing_ball_medium_skin_tone:`woman_bouncing_ball_tone3`,woman_bouncing_ball_tone1:`woman_bouncing_ball_tone1`,woman_bouncing_ball_tone2:`woman_bouncing_ball_tone2`,woman_bouncing_ball_tone3:`woman_bouncing_ball_tone3`,woman_bouncing_ball_tone4:`woman_bouncing_ball_tone4`,woman_bouncing_ball_tone5:`woman_bouncing_ball_tone5`,woman_bowing:`woman_bowing`,woman_bowing_dark_skin_tone:`woman_bowing_tone5`,woman_bowing_light_skin_tone:`woman_bowing_tone1`,woman_bowing_medium_dark_skin_tone:`woman_bowing_tone4`,woman_bowing_medium_light_skin_tone:`woman_bowing_tone2`,woman_bowing_medium_skin_tone:`woman_bowing_tone3`,woman_bowing_tone1:`woman_bowing_tone1`,woman_bowing_tone2:`woman_bowing_tone2`,woman_bowing_tone3:`woman_bowing_tone3`,woman_bowing_tone4:`woman_bowing_tone4`,woman_bowing_tone5:`woman_bowing_tone5`,woman_cartwheeling:`woman_cartwheeling`,woman_cartwheeling_dark_skin_tone:`woman_cartwheeling_tone5`,woman_cartwheeling_light_skin_tone:`woman_cartwheeling_tone1`,woman_cartwheeling_medium_dark_skin_tone:`woman_cartwheeling_tone4`,woman_cartwheeling_medium_light_skin_tone:`woman_cartwheeling_tone2`,woman_cartwheeling_medium_skin_tone:`woman_cartwheeling_tone3`,woman_cartwheeling_tone1:`woman_cartwheeling_tone1`,woman_cartwheeling_tone2:`woman_cartwheeling_tone2`,woman_cartwheeling_tone3:`woman_cartwheeling_tone3`,woman_cartwheeling_tone4:`woman_cartwheeling_tone4`,woman_cartwheeling_tone5:`woman_cartwheeling_tone5`,woman_climbing:`woman_climbing`,woman_climbing_dark_skin_tone:`woman_climbing_tone5`,woman_climbing_light_skin_tone:`woman_climbing_tone1`,woman_climbing_medium_dark_skin_tone:`woman_climbing_tone4`,woman_climbing_medium_light_skin_tone:`woman_climbing_tone2`,woman_climbing_medium_skin_tone:`woman_climbing_tone3`,woman_climbing_tone1:`woman_climbing_tone1`,woman_climbing_tone2:`woman_climbing_tone2`,woman_climbing_tone3:`woman_climbing_tone3`,woman_climbing_tone4:`woman_climbing_tone4`,woman_climbing_tone5:`woman_climbing_tone5`,woman_construction_worker:`woman_construction_worker`,woman_construction_worker_dark_skin_tone:`woman_construction_worker_tone5`,woman_construction_worker_light_skin_tone:`woman_construction_worker_tone1`,woman_construction_worker_medium_dark_skin_tone:`woman_construction_worker_tone4`,woman_construction_worker_medium_light_skin_tone:`woman_construction_worker_tone2`,woman_construction_worker_medium_skin_tone:`woman_construction_worker_tone3`,woman_construction_worker_tone1:`woman_construction_worker_tone1`,woman_construction_worker_tone2:`woman_construction_worker_tone2`,woman_construction_worker_tone3:`woman_construction_worker_tone3`,woman_construction_worker_tone4:`woman_construction_worker_tone4`,woman_construction_worker_tone5:`woman_construction_worker_tone5`,woman_cook:`woman_cook`,woman_cook_dark_skin_tone:`woman_cook_tone5`,woman_cook_light_skin_tone:`woman_cook_tone1`,woman_cook_medium_dark_skin_tone:`woman_cook_tone4`,woman_cook_medium_light_skin_tone:`woman_cook_tone2`,woman_cook_medium_skin_tone:`woman_cook_tone3`,woman_cook_tone1:`woman_cook_tone1`,woman_cook_tone2:`woman_cook_tone2`,woman_cook_tone3:`woman_cook_tone3`,woman_cook_tone4:`woman_cook_tone4`,woman_cook_tone5:`woman_cook_tone5`,woman_curly_haired:`woman_curly_haired`,woman_curly_haired_dark_skin_tone:`woman_curly_haired_tone5`,woman_curly_haired_light_skin_tone:`woman_curly_haired_tone1`,woman_curly_haired_medium_dark_skin_tone:`woman_curly_haired_tone4`,woman_curly_haired_medium_light_skin_tone:`woman_curly_haired_tone2`,woman_curly_haired_medium_skin_tone:`woman_curly_haired_tone3`,woman_curly_haired_tone1:`woman_curly_haired_tone1`,woman_curly_haired_tone2:`woman_curly_haired_tone2`,woman_curly_haired_tone3:`woman_curly_haired_tone3`,woman_curly_haired_tone4:`woman_curly_haired_tone4`,woman_curly_haired_tone5:`woman_curly_haired_tone5`,woman_dancing:`dancer`,woman_dark_skin_tone_beard:`woman_tone5_beard`,woman_detective:`woman_detective`,woman_detective_dark_skin_tone:`woman_detective_tone5`,woman_detective_light_skin_tone:`woman_detective_tone1`,woman_detective_medium_dark_skin_tone:`woman_detective_tone4`,woman_detective_medium_light_skin_tone:`woman_detective_tone2`,woman_detective_medium_skin_tone:`woman_detective_tone3`,woman_detective_tone1:`woman_detective_tone1`,woman_detective_tone2:`woman_detective_tone2`,woman_detective_tone3:`woman_detective_tone3`,woman_detective_tone4:`woman_detective_tone4`,woman_detective_tone5:`woman_detective_tone5`,woman_elf:`woman_elf`,woman_elf_dark_skin_tone:`woman_elf_tone5`,woman_elf_light_skin_tone:`woman_elf_tone1`,woman_elf_medium_dark_skin_tone:`woman_elf_tone4`,woman_elf_medium_light_skin_tone:`woman_elf_tone2`,woman_elf_medium_skin_tone:`woman_elf_tone3`,woman_elf_tone1:`woman_elf_tone1`,woman_elf_tone2:`woman_elf_tone2`,woman_elf_tone3:`woman_elf_tone3`,woman_elf_tone4:`woman_elf_tone4`,woman_elf_tone5:`woman_elf_tone5`,woman_facepalming:`woman_facepalming`,woman_facepalming_dark_skin_tone:`woman_facepalming_tone5`,woman_facepalming_light_skin_tone:`woman_facepalming_tone1`,woman_facepalming_medium_dark_skin_tone:`woman_facepalming_tone4`,woman_facepalming_medium_light_skin_tone:`woman_facepalming_tone2`,woman_facepalming_medium_skin_tone:`woman_facepalming_tone3`,woman_facepalming_tone1:`woman_facepalming_tone1`,woman_facepalming_tone2:`woman_facepalming_tone2`,woman_facepalming_tone3:`woman_facepalming_tone3`,woman_facepalming_tone4:`woman_facepalming_tone4`,woman_facepalming_tone5:`woman_facepalming_tone5`,woman_factory_worker:`woman_factory_worker`,woman_factory_worker_dark_skin_tone:`woman_factory_worker_tone5`,woman_factory_worker_light_skin_tone:`woman_factory_worker_tone1`,woman_factory_worker_medium_dark_skin_tone:`woman_factory_worker_tone4`,woman_factory_worker_medium_light_skin_tone:`woman_factory_worker_tone2`,woman_factory_worker_medium_skin_tone:`woman_factory_worker_tone3`,woman_factory_worker_tone1:`woman_factory_worker_tone1`,woman_factory_worker_tone2:`woman_factory_worker_tone2`,woman_factory_worker_tone3:`woman_factory_worker_tone3`,woman_factory_worker_tone4:`woman_factory_worker_tone4`,woman_factory_worker_tone5:`woman_factory_worker_tone5`,woman_fairy:`woman_fairy`,woman_fairy_dark_skin_tone:`woman_fairy_tone5`,woman_fairy_light_skin_tone:`woman_fairy_tone1`,woman_fairy_medium_dark_skin_tone:`woman_fairy_tone4`,woman_fairy_medium_light_skin_tone:`woman_fairy_tone2`,woman_fairy_medium_skin_tone:`woman_fairy_tone3`,woman_fairy_tone1:`woman_fairy_tone1`,woman_fairy_tone2:`woman_fairy_tone2`,woman_fairy_tone3:`woman_fairy_tone3`,woman_fairy_tone4:`woman_fairy_tone4`,woman_fairy_tone5:`woman_fairy_tone5`,woman_farmer:`woman_farmer`,woman_farmer_dark_skin_tone:`woman_farmer_tone5`,woman_farmer_light_skin_tone:`woman_farmer_tone1`,woman_farmer_medium_dark_skin_tone:`woman_farmer_tone4`,woman_farmer_medium_light_skin_tone:`woman_farmer_tone2`,woman_farmer_medium_skin_tone:`woman_farmer_tone3`,woman_farmer_tone1:`woman_farmer_tone1`,woman_farmer_tone2:`woman_farmer_tone2`,woman_farmer_tone3:`woman_farmer_tone3`,woman_farmer_tone4:`woman_farmer_tone4`,woman_farmer_tone5:`woman_farmer_tone5`,woman_feeding_baby:`woman_feeding_baby`,woman_feeding_baby_dark_skin_tone:`woman_feeding_baby_tone5`,woman_feeding_baby_light_skin_tone:`woman_feeding_baby_tone1`,woman_feeding_baby_medium_dark_skin_tone:`woman_feeding_baby_tone4`,woman_feeding_baby_medium_light_skin_tone:`woman_feeding_baby_tone2`,woman_feeding_baby_medium_skin_tone:`woman_feeding_baby_tone3`,woman_feeding_baby_tone1:`woman_feeding_baby_tone1`,woman_feeding_baby_tone2:`woman_feeding_baby_tone2`,woman_feeding_baby_tone3:`woman_feeding_baby_tone3`,woman_feeding_baby_tone4:`woman_feeding_baby_tone4`,woman_feeding_baby_tone5:`woman_feeding_baby_tone5`,woman_firefighter:`woman_firefighter`,woman_firefighter_dark_skin_tone:`woman_firefighter_tone5`,woman_firefighter_light_skin_tone:`woman_firefighter_tone1`,woman_firefighter_medium_dark_skin_tone:`woman_firefighter_tone4`,woman_firefighter_medium_light_skin_tone:`woman_firefighter_tone2`,woman_firefighter_medium_skin_tone:`woman_firefighter_tone3`,woman_firefighter_tone1:`woman_firefighter_tone1`,woman_firefighter_tone2:`woman_firefighter_tone2`,woman_firefighter_tone3:`woman_firefighter_tone3`,woman_firefighter_tone4:`woman_firefighter_tone4`,woman_firefighter_tone5:`woman_firefighter_tone5`,woman_frowning:`woman_frowning`,woman_frowning_dark_skin_tone:`woman_frowning_tone5`,woman_frowning_light_skin_tone:`woman_frowning_tone1`,woman_frowning_medium_dark_skin_tone:`woman_frowning_tone4`,woman_frowning_medium_light_skin_tone:`woman_frowning_tone2`,woman_frowning_medium_skin_tone:`woman_frowning_tone3`,woman_frowning_tone1:`woman_frowning_tone1`,woman_frowning_tone2:`woman_frowning_tone2`,woman_frowning_tone3:`woman_frowning_tone3`,woman_frowning_tone4:`woman_frowning_tone4`,woman_frowning_tone5:`woman_frowning_tone5`,woman_genie:`woman_genie`,woman_gesturing_no:`woman_gesturing_no`,woman_gesturing_no_dark_skin_tone:`woman_gesturing_no_tone5`,woman_gesturing_no_light_skin_tone:`woman_gesturing_no_tone1`,woman_gesturing_no_medium_dark_skin_tone:`woman_gesturing_no_tone4`,woman_gesturing_no_medium_light_skin_tone:`woman_gesturing_no_tone2`,woman_gesturing_no_medium_skin_tone:`woman_gesturing_no_tone3`,woman_gesturing_no_tone1:`woman_gesturing_no_tone1`,woman_gesturing_no_tone2:`woman_gesturing_no_tone2`,woman_gesturing_no_tone3:`woman_gesturing_no_tone3`,woman_gesturing_no_tone4:`woman_gesturing_no_tone4`,woman_gesturing_no_tone5:`woman_gesturing_no_tone5`,woman_gesturing_ok:`woman_gesturing_ok`,woman_gesturing_ok_dark_skin_tone:`woman_gesturing_ok_tone5`,woman_gesturing_ok_light_skin_tone:`woman_gesturing_ok_tone1`,woman_gesturing_ok_medium_dark_skin_tone:`woman_gesturing_ok_tone4`,woman_gesturing_ok_medium_light_skin_tone:`woman_gesturing_ok_tone2`,woman_gesturing_ok_medium_skin_tone:`woman_gesturing_ok_tone3`,woman_gesturing_ok_tone1:`woman_gesturing_ok_tone1`,woman_gesturing_ok_tone2:`woman_gesturing_ok_tone2`,woman_gesturing_ok_tone3:`woman_gesturing_ok_tone3`,woman_gesturing_ok_tone4:`woman_gesturing_ok_tone4`,woman_gesturing_ok_tone5:`woman_gesturing_ok_tone5`,woman_getting_face_massage:`woman_getting_face_massage`,woman_getting_face_massage_dark_skin_tone:`woman_getting_face_massage_tone5`,woman_getting_face_massage_light_skin_tone:`woman_getting_face_massage_tone1`,woman_getting_face_massage_medium_dark_skin_tone:`woman_getting_face_massage_tone4`,woman_getting_face_massage_medium_light_skin_tone:`woman_getting_face_massage_tone2`,woman_getting_face_massage_medium_skin_tone:`woman_getting_face_massage_tone3`,woman_getting_face_massage_tone1:`woman_getting_face_massage_tone1`,woman_getting_face_massage_tone2:`woman_getting_face_massage_tone2`,woman_getting_face_massage_tone3:`woman_getting_face_massage_tone3`,woman_getting_face_massage_tone4:`woman_getting_face_massage_tone4`,woman_getting_face_massage_tone5:`woman_getting_face_massage_tone5`,woman_getting_haircut:`woman_getting_haircut`,woman_getting_haircut_dark_skin_tone:`woman_getting_haircut_tone5`,woman_getting_haircut_light_skin_tone:`woman_getting_haircut_tone1`,woman_getting_haircut_medium_dark_skin_tone:`woman_getting_haircut_tone4`,woman_getting_haircut_medium_light_skin_tone:`woman_getting_haircut_tone2`,woman_getting_haircut_medium_skin_tone:`woman_getting_haircut_tone3`,woman_getting_haircut_tone1:`woman_getting_haircut_tone1`,woman_getting_haircut_tone2:`woman_getting_haircut_tone2`,woman_getting_haircut_tone3:`woman_getting_haircut_tone3`,woman_getting_haircut_tone4:`woman_getting_haircut_tone4`,woman_getting_haircut_tone5:`woman_getting_haircut_tone5`,woman_golfing:`woman_golfing`,woman_golfing_dark_skin_tone:`woman_golfing_tone5`,woman_golfing_light_skin_tone:`woman_golfing_tone1`,woman_golfing_medium_dark_skin_tone:`woman_golfing_tone4`,woman_golfing_medium_light_skin_tone:`woman_golfing_tone2`,woman_golfing_medium_skin_tone:`woman_golfing_tone3`,woman_golfing_tone1:`woman_golfing_tone1`,woman_golfing_tone2:`woman_golfing_tone2`,woman_golfing_tone3:`woman_golfing_tone3`,woman_golfing_tone4:`woman_golfing_tone4`,woman_golfing_tone5:`woman_golfing_tone5`,woman_guard:`woman_guard`,woman_guard_dark_skin_tone:`woman_guard_tone5`,woman_guard_light_skin_tone:`woman_guard_tone1`,woman_guard_medium_dark_skin_tone:`woman_guard_tone4`,woman_guard_medium_light_skin_tone:`woman_guard_tone2`,woman_guard_medium_skin_tone:`woman_guard_tone3`,woman_guard_tone1:`woman_guard_tone1`,woman_guard_tone2:`woman_guard_tone2`,woman_guard_tone3:`woman_guard_tone3`,woman_guard_tone4:`woman_guard_tone4`,woman_guard_tone5:`woman_guard_tone5`,woman_health_worker:`woman_health_worker`,woman_health_worker_dark_skin_tone:`woman_health_worker_tone5`,woman_health_worker_light_skin_tone:`woman_health_worker_tone1`,woman_health_worker_medium_dark_skin_tone:`woman_health_worker_tone4`,woman_health_worker_medium_light_skin_tone:`woman_health_worker_tone2`,woman_health_worker_medium_skin_tone:`woman_health_worker_tone3`,woman_health_worker_tone1:`woman_health_worker_tone1`,woman_health_worker_tone2:`woman_health_worker_tone2`,woman_health_worker_tone3:`woman_health_worker_tone3`,woman_health_worker_tone4:`woman_health_worker_tone4`,woman_health_worker_tone5:`woman_health_worker_tone5`,woman_in_lotus_position:`woman_in_lotus_position`,woman_in_lotus_position_dark_skin_tone:`woman_in_lotus_position_tone5`,woman_in_lotus_position_light_skin_tone:`woman_in_lotus_position_tone1`,woman_in_lotus_position_medium_dark_skin_tone:`woman_in_lotus_position_tone4`,woman_in_lotus_position_medium_light_skin_tone:`woman_in_lotus_position_tone2`,woman_in_lotus_position_medium_skin_tone:`woman_in_lotus_position_tone3`,woman_in_lotus_position_tone1:`woman_in_lotus_position_tone1`,woman_in_lotus_position_tone2:`woman_in_lotus_position_tone2`,woman_in_lotus_position_tone3:`woman_in_lotus_position_tone3`,woman_in_lotus_position_tone4:`woman_in_lotus_position_tone4`,woman_in_lotus_position_tone5:`woman_in_lotus_position_tone5`,woman_in_manual_wheelchair:`woman_in_manual_wheelchair`,woman_in_manual_wheelchair_dark_skin_tone:`woman_in_manual_wheelchair_tone5`,woman_in_manual_wheelchair_facing_right:`woman_in_manual_wheelchair_facing_right`,woman_in_manual_wheelchair_facing_right_dark_skin_tone:`woman_in_manual_wheelchair_facing_right_tone5`,woman_in_manual_wheelchair_facing_right_light_skin_tone:`woman_in_manual_wheelchair_facing_right_tone1`,woman_in_manual_wheelchair_facing_right_medium_dark_skin_tone:`woman_in_manual_wheelchair_facing_right_tone4`,woman_in_manual_wheelchair_facing_right_medium_light_skin_tone:`woman_in_manual_wheelchair_facing_right_tone2`,woman_in_manual_wheelchair_facing_right_medium_skin_tone:`woman_in_manual_wheelchair_facing_right_tone3`,woman_in_manual_wheelchair_facing_right_tone1:`woman_in_manual_wheelchair_facing_right_tone1`,woman_in_manual_wheelchair_facing_right_tone2:`woman_in_manual_wheelchair_facing_right_tone2`,woman_in_manual_wheelchair_facing_right_tone3:`woman_in_manual_wheelchair_facing_right_tone3`,woman_in_manual_wheelchair_facing_right_tone4:`woman_in_manual_wheelchair_facing_right_tone4`,woman_in_manual_wheelchair_facing_right_tone5:`woman_in_manual_wheelchair_facing_right_tone5`,woman_in_manual_wheelchair_light_skin_tone:`woman_in_manual_wheelchair_tone1`,woman_in_manual_wheelchair_medium_dark_skin_tone:`woman_in_manual_wheelchair_tone4`,woman_in_manual_wheelchair_medium_light_skin_tone:`woman_in_manual_wheelchair_tone2`,woman_in_manual_wheelchair_medium_skin_tone:`woman_in_manual_wheelchair_tone3`,woman_in_manual_wheelchair_tone1:`woman_in_manual_wheelchair_tone1`,woman_in_manual_wheelchair_tone2:`woman_in_manual_wheelchair_tone2`,woman_in_manual_wheelchair_tone3:`woman_in_manual_wheelchair_tone3`,woman_in_manual_wheelchair_tone4:`woman_in_manual_wheelchair_tone4`,woman_in_manual_wheelchair_tone5:`woman_in_manual_wheelchair_tone5`,woman_in_motorized_wheelchair:`woman_in_motorized_wheelchair`,woman_in_motorized_wheelchair_dark_skin_tone:`woman_in_motorized_wheelchair_tone5`,woman_in_motorized_wheelchair_facing_right:`woman_in_motorized_wheelchair_facing_right`,woman_in_motorized_wheelchair_facing_right_dark_skin_tone:`woman_in_motorized_wheelchair_facing_right_tone5`,woman_in_motorized_wheelchair_facing_right_light_skin_tone:`woman_in_motorized_wheelchair_facing_right_tone1`,woman_in_motorized_wheelchair_facing_right_medium_dark_skin_tone:`woman_in_motorized_wheelchair_facing_right_tone4`,woman_in_motorized_wheelchair_facing_right_medium_light_skin_tone:`woman_in_motorized_wheelchair_facing_right_tone2`,woman_in_motorized_wheelchair_facing_right_medium_skin_tone:`woman_in_motorized_wheelchair_facing_right_tone3`,woman_in_motorized_wheelchair_facing_right_tone1:`woman_in_motorized_wheelchair_facing_right_tone1`,woman_in_motorized_wheelchair_facing_right_tone2:`woman_in_motorized_wheelchair_facing_right_tone2`,woman_in_motorized_wheelchair_facing_right_tone3:`woman_in_motorized_wheelchair_facing_right_tone3`,woman_in_motorized_wheelchair_facing_right_tone4:`woman_in_motorized_wheelchair_facing_right_tone4`,woman_in_motorized_wheelchair_facing_right_tone5:`woman_in_motorized_wheelchair_facing_right_tone5`,woman_in_motorized_wheelchair_light_skin_tone:`woman_in_motorized_wheelchair_tone1`,woman_in_motorized_wheelchair_medium_dark_skin_tone:`woman_in_motorized_wheelchair_tone4`,woman_in_motorized_wheelchair_medium_light_skin_tone:`woman_in_motorized_wheelchair_tone2`,woman_in_motorized_wheelchair_medium_skin_tone:`woman_in_motorized_wheelchair_tone3`,woman_in_motorized_wheelchair_tone1:`woman_in_motorized_wheelchair_tone1`,woman_in_motorized_wheelchair_tone2:`woman_in_motorized_wheelchair_tone2`,woman_in_motorized_wheelchair_tone3:`woman_in_motorized_wheelchair_tone3`,woman_in_motorized_wheelchair_tone4:`woman_in_motorized_wheelchair_tone4`,woman_in_motorized_wheelchair_tone5:`woman_in_motorized_wheelchair_tone5`,woman_in_steamy_room:`woman_in_steamy_room`,woman_in_steamy_room_dark_skin_tone:`woman_in_steamy_room_tone5`,woman_in_steamy_room_light_skin_tone:`woman_in_steamy_room_tone1`,woman_in_steamy_room_medium_dark_skin_tone:`woman_in_steamy_room_tone4`,woman_in_steamy_room_medium_light_skin_tone:`woman_in_steamy_room_tone2`,woman_in_steamy_room_medium_skin_tone:`woman_in_steamy_room_tone3`,woman_in_steamy_room_tone1:`woman_in_steamy_room_tone1`,woman_in_steamy_room_tone2:`woman_in_steamy_room_tone2`,woman_in_steamy_room_tone3:`woman_in_steamy_room_tone3`,woman_in_steamy_room_tone4:`woman_in_steamy_room_tone4`,woman_in_steamy_room_tone5:`woman_in_steamy_room_tone5`,woman_in_tuxedo:`woman_in_tuxedo`,woman_in_tuxedo_dark_skin_tone:`woman_in_tuxedo_tone5`,woman_in_tuxedo_light_skin_tone:`woman_in_tuxedo_tone1`,woman_in_tuxedo_medium_dark_skin_tone:`woman_in_tuxedo_tone4`,woman_in_tuxedo_medium_light_skin_tone:`woman_in_tuxedo_tone2`,woman_in_tuxedo_medium_skin_tone:`woman_in_tuxedo_tone3`,woman_in_tuxedo_tone1:`woman_in_tuxedo_tone1`,woman_in_tuxedo_tone2:`woman_in_tuxedo_tone2`,woman_in_tuxedo_tone3:`woman_in_tuxedo_tone3`,woman_in_tuxedo_tone4:`woman_in_tuxedo_tone4`,woman_in_tuxedo_tone5:`woman_in_tuxedo_tone5`,woman_judge:`woman_judge`,woman_judge_dark_skin_tone:`woman_judge_tone5`,woman_judge_light_skin_tone:`woman_judge_tone1`,woman_judge_medium_dark_skin_tone:`woman_judge_tone4`,woman_judge_medium_light_skin_tone:`woman_judge_tone2`,woman_judge_medium_skin_tone:`woman_judge_tone3`,woman_judge_tone1:`woman_judge_tone1`,woman_judge_tone2:`woman_judge_tone2`,woman_judge_tone3:`woman_judge_tone3`,woman_judge_tone4:`woman_judge_tone4`,woman_judge_tone5:`woman_judge_tone5`,woman_juggling:`woman_juggling`,woman_juggling_dark_skin_tone:`woman_juggling_tone5`,woman_juggling_light_skin_tone:`woman_juggling_tone1`,woman_juggling_medium_dark_skin_tone:`woman_juggling_tone4`,woman_juggling_medium_light_skin_tone:`woman_juggling_tone2`,woman_juggling_medium_skin_tone:`woman_juggling_tone3`,woman_juggling_tone1:`woman_juggling_tone1`,woman_juggling_tone2:`woman_juggling_tone2`,woman_juggling_tone3:`woman_juggling_tone3`,woman_juggling_tone4:`woman_juggling_tone4`,woman_juggling_tone5:`woman_juggling_tone5`,woman_kneeling:`woman_kneeling`,woman_kneeling_dark_skin_tone:`woman_kneeling_tone5`,woman_kneeling_facing_right:`woman_kneeling_facing_right`,woman_kneeling_facing_right_dark_skin_tone:`woman_kneeling_facing_right_tone5`,woman_kneeling_facing_right_light_skin_tone:`woman_kneeling_facing_right_tone1`,woman_kneeling_facing_right_medium_dark_skin_tone:`woman_kneeling_facing_right_tone4`,woman_kneeling_facing_right_medium_light_skin_tone:`woman_kneeling_facing_right_tone2`,woman_kneeling_facing_right_medium_skin_tone:`woman_kneeling_facing_right_tone3`,woman_kneeling_facing_right_tone1:`woman_kneeling_facing_right_tone1`,woman_kneeling_facing_right_tone2:`woman_kneeling_facing_right_tone2`,woman_kneeling_facing_right_tone3:`woman_kneeling_facing_right_tone3`,woman_kneeling_facing_right_tone4:`woman_kneeling_facing_right_tone4`,woman_kneeling_facing_right_tone5:`woman_kneeling_facing_right_tone5`,woman_kneeling_light_skin_tone:`woman_kneeling_tone1`,woman_kneeling_medium_dark_skin_tone:`woman_kneeling_tone4`,woman_kneeling_medium_light_skin_tone:`woman_kneeling_tone2`,woman_kneeling_medium_skin_tone:`woman_kneeling_tone3`,woman_kneeling_tone1:`woman_kneeling_tone1`,woman_kneeling_tone2:`woman_kneeling_tone2`,woman_kneeling_tone3:`woman_kneeling_tone3`,woman_kneeling_tone4:`woman_kneeling_tone4`,woman_kneeling_tone5:`woman_kneeling_tone5`,woman_lifting_weights:`woman_lifting_weights`,woman_lifting_weights_dark_skin_tone:`woman_lifting_weights_tone5`,woman_lifting_weights_light_skin_tone:`woman_lifting_weights_tone1`,woman_lifting_weights_medium_dark_skin_tone:`woman_lifting_weights_tone4`,woman_lifting_weights_medium_light_skin_tone:`woman_lifting_weights_tone2`,woman_lifting_weights_medium_skin_tone:`woman_lifting_weights_tone3`,woman_lifting_weights_tone1:`woman_lifting_weights_tone1`,woman_lifting_weights_tone2:`woman_lifting_weights_tone2`,woman_lifting_weights_tone3:`woman_lifting_weights_tone3`,woman_lifting_weights_tone4:`woman_lifting_weights_tone4`,woman_lifting_weights_tone5:`woman_lifting_weights_tone5`,woman_light_skin_tone_beard:`woman_tone1_beard`,woman_mage:`woman_mage`,woman_mage_dark_skin_tone:`woman_mage_tone5`,woman_mage_light_skin_tone:`woman_mage_tone1`,woman_mage_medium_dark_skin_tone:`woman_mage_tone4`,woman_mage_medium_light_skin_tone:`woman_mage_tone2`,woman_mage_medium_skin_tone:`woman_mage_tone3`,woman_mage_tone1:`woman_mage_tone1`,woman_mage_tone2:`woman_mage_tone2`,woman_mage_tone3:`woman_mage_tone3`,woman_mage_tone4:`woman_mage_tone4`,woman_mage_tone5:`woman_mage_tone5`,woman_mechanic:`woman_mechanic`,woman_mechanic_dark_skin_tone:`woman_mechanic_tone5`,woman_mechanic_light_skin_tone:`woman_mechanic_tone1`,woman_mechanic_medium_dark_skin_tone:`woman_mechanic_tone4`,woman_mechanic_medium_light_skin_tone:`woman_mechanic_tone2`,woman_mechanic_medium_skin_tone:`woman_mechanic_tone3`,woman_mechanic_tone1:`woman_mechanic_tone1`,woman_mechanic_tone2:`woman_mechanic_tone2`,woman_mechanic_tone3:`woman_mechanic_tone3`,woman_mechanic_tone4:`woman_mechanic_tone4`,woman_mechanic_tone5:`woman_mechanic_tone5`,woman_medium_dark_skin_tone_beard:`woman_tone4_beard`,woman_medium_light_skin_tone_beard:`woman_tone2_beard`,woman_medium_skin_tone_beard:`woman_tone3_beard`,woman_mountain_biking:`woman_mountain_biking`,woman_mountain_biking_dark_skin_tone:`woman_mountain_biking_tone5`,woman_mountain_biking_light_skin_tone:`woman_mountain_biking_tone1`,woman_mountain_biking_medium_dark_skin_tone:`woman_mountain_biking_tone4`,woman_mountain_biking_medium_light_skin_tone:`woman_mountain_biking_tone2`,woman_mountain_biking_medium_skin_tone:`woman_mountain_biking_tone3`,woman_mountain_biking_tone1:`woman_mountain_biking_tone1`,woman_mountain_biking_tone2:`woman_mountain_biking_tone2`,woman_mountain_biking_tone3:`woman_mountain_biking_tone3`,woman_mountain_biking_tone4:`woman_mountain_biking_tone4`,woman_mountain_biking_tone5:`woman_mountain_biking_tone5`,woman_office_worker:`woman_office_worker`,woman_office_worker_dark_skin_tone:`woman_office_worker_tone5`,woman_office_worker_light_skin_tone:`woman_office_worker_tone1`,woman_office_worker_medium_dark_skin_tone:`woman_office_worker_tone4`,woman_office_worker_medium_light_skin_tone:`woman_office_worker_tone2`,woman_office_worker_medium_skin_tone:`woman_office_worker_tone3`,woman_office_worker_tone1:`woman_office_worker_tone1`,woman_office_worker_tone2:`woman_office_worker_tone2`,woman_office_worker_tone3:`woman_office_worker_tone3`,woman_office_worker_tone4:`woman_office_worker_tone4`,woman_office_worker_tone5:`woman_office_worker_tone5`,woman_pilot:`woman_pilot`,woman_pilot_dark_skin_tone:`woman_pilot_tone5`,woman_pilot_light_skin_tone:`woman_pilot_tone1`,woman_pilot_medium_dark_skin_tone:`woman_pilot_tone4`,woman_pilot_medium_light_skin_tone:`woman_pilot_tone2`,woman_pilot_medium_skin_tone:`woman_pilot_tone3`,woman_pilot_tone1:`woman_pilot_tone1`,woman_pilot_tone2:`woman_pilot_tone2`,woman_pilot_tone3:`woman_pilot_tone3`,woman_pilot_tone4:`woman_pilot_tone4`,woman_pilot_tone5:`woman_pilot_tone5`,woman_playing_handball:`woman_playing_handball`,woman_playing_handball_dark_skin_tone:`woman_playing_handball_tone5`,woman_playing_handball_light_skin_tone:`woman_playing_handball_tone1`,woman_playing_handball_medium_dark_skin_tone:`woman_playing_handball_tone4`,woman_playing_handball_medium_light_skin_tone:`woman_playing_handball_tone2`,woman_playing_handball_medium_skin_tone:`woman_playing_handball_tone3`,woman_playing_handball_tone1:`woman_playing_handball_tone1`,woman_playing_handball_tone2:`woman_playing_handball_tone2`,woman_playing_handball_tone3:`woman_playing_handball_tone3`,woman_playing_handball_tone4:`woman_playing_handball_tone4`,woman_playing_handball_tone5:`woman_playing_handball_tone5`,woman_playing_water_polo:`woman_playing_water_polo`,woman_playing_water_polo_dark_skin_tone:`woman_playing_water_polo_tone5`,woman_playing_water_polo_light_skin_tone:`woman_playing_water_polo_tone1`,woman_playing_water_polo_medium_dark_skin_tone:`woman_playing_water_polo_tone4`,woman_playing_water_polo_medium_light_skin_tone:`woman_playing_water_polo_tone2`,woman_playing_water_polo_medium_skin_tone:`woman_playing_water_polo_tone3`,woman_playing_water_polo_tone1:`woman_playing_water_polo_tone1`,woman_playing_water_polo_tone2:`woman_playing_water_polo_tone2`,woman_playing_water_polo_tone3:`woman_playing_water_polo_tone3`,woman_playing_water_polo_tone4:`woman_playing_water_polo_tone4`,woman_playing_water_polo_tone5:`woman_playing_water_polo_tone5`,woman_police_officer:`woman_police_officer`,woman_police_officer_dark_skin_tone:`woman_police_officer_tone5`,woman_police_officer_light_skin_tone:`woman_police_officer_tone1`,woman_police_officer_medium_dark_skin_tone:`woman_police_officer_tone4`,woman_police_officer_medium_light_skin_tone:`woman_police_officer_tone2`,woman_police_officer_medium_skin_tone:`woman_police_officer_tone3`,woman_police_officer_tone1:`woman_police_officer_tone1`,woman_police_officer_tone2:`woman_police_officer_tone2`,woman_police_officer_tone3:`woman_police_officer_tone3`,woman_police_officer_tone4:`woman_police_officer_tone4`,woman_police_officer_tone5:`woman_police_officer_tone5`,woman_pouting:`woman_pouting`,woman_pouting_dark_skin_tone:`woman_pouting_tone5`,woman_pouting_light_skin_tone:`woman_pouting_tone1`,woman_pouting_medium_dark_skin_tone:`woman_pouting_tone4`,woman_pouting_medium_light_skin_tone:`woman_pouting_tone2`,woman_pouting_medium_skin_tone:`woman_pouting_tone3`,woman_pouting_tone1:`woman_pouting_tone1`,woman_pouting_tone2:`woman_pouting_tone2`,woman_pouting_tone3:`woman_pouting_tone3`,woman_pouting_tone4:`woman_pouting_tone4`,woman_pouting_tone5:`woman_pouting_tone5`,woman_raising_hand:`woman_raising_hand`,woman_raising_hand_dark_skin_tone:`woman_raising_hand_tone5`,woman_raising_hand_light_skin_tone:`woman_raising_hand_tone1`,woman_raising_hand_medium_dark_skin_tone:`woman_raising_hand_tone4`,woman_raising_hand_medium_light_skin_tone:`woman_raising_hand_tone2`,woman_raising_hand_medium_skin_tone:`woman_raising_hand_tone3`,woman_raising_hand_tone1:`woman_raising_hand_tone1`,woman_raising_hand_tone2:`woman_raising_hand_tone2`,woman_raising_hand_tone3:`woman_raising_hand_tone3`,woman_raising_hand_tone4:`woman_raising_hand_tone4`,woman_raising_hand_tone5:`woman_raising_hand_tone5`,woman_red_haired:`woman_red_haired`,woman_red_haired_dark_skin_tone:`woman_red_haired_tone5`,woman_red_haired_light_skin_tone:`woman_red_haired_tone1`,woman_red_haired_medium_dark_skin_tone:`woman_red_haired_tone4`,woman_red_haired_medium_light_skin_tone:`woman_red_haired_tone2`,woman_red_haired_medium_skin_tone:`woman_red_haired_tone3`,woman_red_haired_tone1:`woman_red_haired_tone1`,woman_red_haired_tone2:`woman_red_haired_tone2`,woman_red_haired_tone3:`woman_red_haired_tone3`,woman_red_haired_tone4:`woman_red_haired_tone4`,woman_red_haired_tone5:`woman_red_haired_tone5`,woman_rowing_boat:`woman_rowing_boat`,woman_rowing_boat_dark_skin_tone:`woman_rowing_boat_tone5`,woman_rowing_boat_light_skin_tone:`woman_rowing_boat_tone1`,woman_rowing_boat_medium_dark_skin_tone:`woman_rowing_boat_tone4`,woman_rowing_boat_medium_light_skin_tone:`woman_rowing_boat_tone2`,woman_rowing_boat_medium_skin_tone:`woman_rowing_boat_tone3`,woman_rowing_boat_tone1:`woman_rowing_boat_tone1`,woman_rowing_boat_tone2:`woman_rowing_boat_tone2`,woman_rowing_boat_tone3:`woman_rowing_boat_tone3`,woman_rowing_boat_tone4:`woman_rowing_boat_tone4`,woman_rowing_boat_tone5:`woman_rowing_boat_tone5`,woman_running:`woman_running`,woman_running_dark_skin_tone:`woman_running_tone5`,woman_running_facing_right:`woman_running_facing_right`,woman_running_facing_right_dark_skin_tone:`woman_running_facing_right_tone5`,woman_running_facing_right_light_skin_tone:`woman_running_facing_right_tone1`,woman_running_facing_right_medium_dark_skin_tone:`woman_running_facing_right_tone4`,woman_running_facing_right_medium_light_skin_tone:`woman_running_facing_right_tone2`,woman_running_facing_right_medium_skin_tone:`woman_running_facing_right_tone3`,woman_running_facing_right_tone1:`woman_running_facing_right_tone1`,woman_running_facing_right_tone2:`woman_running_facing_right_tone2`,woman_running_facing_right_tone3:`woman_running_facing_right_tone3`,woman_running_facing_right_tone4:`woman_running_facing_right_tone4`,woman_running_facing_right_tone5:`woman_running_facing_right_tone5`,woman_running_light_skin_tone:`woman_running_tone1`,woman_running_medium_dark_skin_tone:`woman_running_tone4`,woman_running_medium_light_skin_tone:`woman_running_tone2`,woman_running_medium_skin_tone:`woman_running_tone3`,woman_running_tone1:`woman_running_tone1`,woman_running_tone2:`woman_running_tone2`,woman_running_tone3:`woman_running_tone3`,woman_running_tone4:`woman_running_tone4`,woman_running_tone5:`woman_running_tone5`,woman_scientist:`woman_scientist`,woman_scientist_dark_skin_tone:`woman_scientist_tone5`,woman_scientist_light_skin_tone:`woman_scientist_tone1`,woman_scientist_medium_dark_skin_tone:`woman_scientist_tone4`,woman_scientist_medium_light_skin_tone:`woman_scientist_tone2`,woman_scientist_medium_skin_tone:`woman_scientist_tone3`,woman_scientist_tone1:`woman_scientist_tone1`,woman_scientist_tone2:`woman_scientist_tone2`,woman_scientist_tone3:`woman_scientist_tone3`,woman_scientist_tone4:`woman_scientist_tone4`,woman_scientist_tone5:`woman_scientist_tone5`,woman_shrugging:`woman_shrugging`,woman_shrugging_dark_skin_tone:`woman_shrugging_tone5`,woman_shrugging_light_skin_tone:`woman_shrugging_tone1`,woman_shrugging_medium_dark_skin_tone:`woman_shrugging_tone4`,woman_shrugging_medium_light_skin_tone:`woman_shrugging_tone2`,woman_shrugging_medium_skin_tone:`woman_shrugging_tone3`,woman_shrugging_tone1:`woman_shrugging_tone1`,woman_shrugging_tone2:`woman_shrugging_tone2`,woman_shrugging_tone3:`woman_shrugging_tone3`,woman_shrugging_tone4:`woman_shrugging_tone4`,woman_shrugging_tone5:`woman_shrugging_tone5`,woman_singer:`woman_singer`,woman_singer_dark_skin_tone:`woman_singer_tone5`,woman_singer_light_skin_tone:`woman_singer_tone1`,woman_singer_medium_dark_skin_tone:`woman_singer_tone4`,woman_singer_medium_light_skin_tone:`woman_singer_tone2`,woman_singer_medium_skin_tone:`woman_singer_tone3`,woman_singer_tone1:`woman_singer_tone1`,woman_singer_tone2:`woman_singer_tone2`,woman_singer_tone3:`woman_singer_tone3`,woman_singer_tone4:`woman_singer_tone4`,woman_singer_tone5:`woman_singer_tone5`,woman_standing:`woman_standing`,woman_standing_dark_skin_tone:`woman_standing_tone5`,woman_standing_light_skin_tone:`woman_standing_tone1`,woman_standing_medium_dark_skin_tone:`woman_standing_tone4`,woman_standing_medium_light_skin_tone:`woman_standing_tone2`,woman_standing_medium_skin_tone:`woman_standing_tone3`,woman_standing_tone1:`woman_standing_tone1`,woman_standing_tone2:`woman_standing_tone2`,woman_standing_tone3:`woman_standing_tone3`,woman_standing_tone4:`woman_standing_tone4`,woman_standing_tone5:`woman_standing_tone5`,woman_student:`woman_student`,woman_student_dark_skin_tone:`woman_student_tone5`,woman_student_light_skin_tone:`woman_student_tone1`,woman_student_medium_dark_skin_tone:`woman_student_tone4`,woman_student_medium_light_skin_tone:`woman_student_tone2`,woman_student_medium_skin_tone:`woman_student_tone3`,woman_student_tone1:`woman_student_tone1`,woman_student_tone2:`woman_student_tone2`,woman_student_tone3:`woman_student_tone3`,woman_student_tone4:`woman_student_tone4`,woman_student_tone5:`woman_student_tone5`,woman_superhero:`woman_superhero`,woman_superhero_dark_skin_tone:`woman_superhero_tone5`,woman_superhero_light_skin_tone:`woman_superhero_tone1`,woman_superhero_medium_dark_skin_tone:`woman_superhero_tone4`,woman_superhero_medium_light_skin_tone:`woman_superhero_tone2`,woman_superhero_medium_skin_tone:`woman_superhero_tone3`,woman_superhero_tone1:`woman_superhero_tone1`,woman_superhero_tone2:`woman_superhero_tone2`,woman_superhero_tone3:`woman_superhero_tone3`,woman_superhero_tone4:`woman_superhero_tone4`,woman_superhero_tone5:`woman_superhero_tone5`,woman_supervillain:`woman_supervillain`,woman_supervillain_dark_skin_tone:`woman_supervillain_tone5`,woman_supervillain_light_skin_tone:`woman_supervillain_tone1`,woman_supervillain_medium_dark_skin_tone:`woman_supervillain_tone4`,woman_supervillain_medium_light_skin_tone:`woman_supervillain_tone2`,woman_supervillain_medium_skin_tone:`woman_supervillain_tone3`,woman_supervillain_tone1:`woman_supervillain_tone1`,woman_supervillain_tone2:`woman_supervillain_tone2`,woman_supervillain_tone3:`woman_supervillain_tone3`,woman_supervillain_tone4:`woman_supervillain_tone4`,woman_supervillain_tone5:`woman_supervillain_tone5`,woman_surfing:`woman_surfing`,woman_surfing_dark_skin_tone:`woman_surfing_tone5`,woman_surfing_light_skin_tone:`woman_surfing_tone1`,woman_surfing_medium_dark_skin_tone:`woman_surfing_tone4`,woman_surfing_medium_light_skin_tone:`woman_surfing_tone2`,woman_surfing_medium_skin_tone:`woman_surfing_tone3`,woman_surfing_tone1:`woman_surfing_tone1`,woman_surfing_tone2:`woman_surfing_tone2`,woman_surfing_tone3:`woman_surfing_tone3`,woman_surfing_tone4:`woman_surfing_tone4`,woman_surfing_tone5:`woman_surfing_tone5`,woman_swimming:`woman_swimming`,woman_swimming_dark_skin_tone:`woman_swimming_tone5`,woman_swimming_light_skin_tone:`woman_swimming_tone1`,woman_swimming_medium_dark_skin_tone:`woman_swimming_tone4`,woman_swimming_medium_light_skin_tone:`woman_swimming_tone2`,woman_swimming_medium_skin_tone:`woman_swimming_tone3`,woman_swimming_tone1:`woman_swimming_tone1`,woman_swimming_tone2:`woman_swimming_tone2`,woman_swimming_tone3:`woman_swimming_tone3`,woman_swimming_tone4:`woman_swimming_tone4`,woman_swimming_tone5:`woman_swimming_tone5`,woman_teacher:`woman_teacher`,woman_teacher_dark_skin_tone:`woman_teacher_tone5`,woman_teacher_light_skin_tone:`woman_teacher_tone1`,woman_teacher_medium_dark_skin_tone:`woman_teacher_tone4`,woman_teacher_medium_light_skin_tone:`woman_teacher_tone2`,woman_teacher_medium_skin_tone:`woman_teacher_tone3`,woman_teacher_tone1:`woman_teacher_tone1`,woman_teacher_tone2:`woman_teacher_tone2`,woman_teacher_tone3:`woman_teacher_tone3`,woman_teacher_tone4:`woman_teacher_tone4`,woman_teacher_tone5:`woman_teacher_tone5`,woman_technologist:`woman_technologist`,woman_technologist_dark_skin_tone:`woman_technologist_tone5`,woman_technologist_light_skin_tone:`woman_technologist_tone1`,woman_technologist_medium_dark_skin_tone:`woman_technologist_tone4`,woman_technologist_medium_light_skin_tone:`woman_technologist_tone2`,woman_technologist_medium_skin_tone:`woman_technologist_tone3`,woman_technologist_tone1:`woman_technologist_tone1`,woman_technologist_tone2:`woman_technologist_tone2`,woman_technologist_tone3:`woman_technologist_tone3`,woman_technologist_tone4:`woman_technologist_tone4`,woman_technologist_tone5:`woman_technologist_tone5`,woman_tipping_hand:`woman_tipping_hand`,woman_tipping_hand_dark_skin_tone:`woman_tipping_hand_tone5`,woman_tipping_hand_light_skin_tone:`woman_tipping_hand_tone1`,woman_tipping_hand_medium_dark_skin_tone:`woman_tipping_hand_tone4`,woman_tipping_hand_medium_light_skin_tone:`woman_tipping_hand_tone2`,woman_tipping_hand_medium_skin_tone:`woman_tipping_hand_tone3`,woman_tipping_hand_tone1:`woman_tipping_hand_tone1`,woman_tipping_hand_tone2:`woman_tipping_hand_tone2`,woman_tipping_hand_tone3:`woman_tipping_hand_tone3`,woman_tipping_hand_tone4:`woman_tipping_hand_tone4`,woman_tipping_hand_tone5:`woman_tipping_hand_tone5`,woman_tone1:`woman_tone1`,woman_tone1_beard:`woman_tone1_beard`,woman_tone2:`woman_tone2`,woman_tone2_beard:`woman_tone2_beard`,woman_tone3:`woman_tone3`,woman_tone3_beard:`woman_tone3_beard`,woman_tone4:`woman_tone4`,woman_tone4_beard:`woman_tone4_beard`,woman_tone5:`woman_tone5`,woman_tone5_beard:`woman_tone5_beard`,woman_vampire:`woman_vampire`,woman_vampire_dark_skin_tone:`woman_vampire_tone5`,woman_vampire_light_skin_tone:`woman_vampire_tone1`,woman_vampire_medium_dark_skin_tone:`woman_vampire_tone4`,woman_vampire_medium_light_skin_tone:`woman_vampire_tone2`,woman_vampire_medium_skin_tone:`woman_vampire_tone3`,woman_vampire_tone1:`woman_vampire_tone1`,woman_vampire_tone2:`woman_vampire_tone2`,woman_vampire_tone3:`woman_vampire_tone3`,woman_vampire_tone4:`woman_vampire_tone4`,woman_vampire_tone5:`woman_vampire_tone5`,woman_walking:`woman_walking`,woman_walking_dark_skin_tone:`woman_walking_tone5`,woman_walking_facing_right:`woman_walking_facing_right`,woman_walking_facing_right_dark_skin_tone:`woman_walking_facing_right_tone5`,woman_walking_facing_right_light_skin_tone:`woman_walking_facing_right_tone1`,woman_walking_facing_right_medium_dark_skin_tone:`woman_walking_facing_right_tone4`,woman_walking_facing_right_medium_light_skin_tone:`woman_walking_facing_right_tone2`,woman_walking_facing_right_medium_skin_tone:`woman_walking_facing_right_tone3`,woman_walking_facing_right_tone1:`woman_walking_facing_right_tone1`,woman_walking_facing_right_tone2:`woman_walking_facing_right_tone2`,woman_walking_facing_right_tone3:`woman_walking_facing_right_tone3`,woman_walking_facing_right_tone4:`woman_walking_facing_right_tone4`,woman_walking_facing_right_tone5:`woman_walking_facing_right_tone5`,woman_walking_light_skin_tone:`woman_walking_tone1`,woman_walking_medium_dark_skin_tone:`woman_walking_tone4`,woman_walking_medium_light_skin_tone:`woman_walking_tone2`,woman_walking_medium_skin_tone:`woman_walking_tone3`,woman_walking_tone1:`woman_walking_tone1`,woman_walking_tone2:`woman_walking_tone2`,woman_walking_tone3:`woman_walking_tone3`,woman_walking_tone4:`woman_walking_tone4`,woman_walking_tone5:`woman_walking_tone5`,woman_wearing_turban:`woman_wearing_turban`,woman_wearing_turban_dark_skin_tone:`woman_wearing_turban_tone5`,woman_wearing_turban_light_skin_tone:`woman_wearing_turban_tone1`,woman_wearing_turban_medium_dark_skin_tone:`woman_wearing_turban_tone4`,woman_wearing_turban_medium_light_skin_tone:`woman_wearing_turban_tone2`,woman_wearing_turban_medium_skin_tone:`woman_wearing_turban_tone3`,woman_wearing_turban_tone1:`woman_wearing_turban_tone1`,woman_wearing_turban_tone2:`woman_wearing_turban_tone2`,woman_wearing_turban_tone3:`woman_wearing_turban_tone3`,woman_wearing_turban_tone4:`woman_wearing_turban_tone4`,woman_wearing_turban_tone5:`woman_wearing_turban_tone5`,woman_white_haired:`woman_white_haired`,woman_white_haired_dark_skin_tone:`woman_white_haired_tone5`,woman_white_haired_light_skin_tone:`woman_white_haired_tone1`,woman_white_haired_medium_dark_skin_tone:`woman_white_haired_tone4`,woman_white_haired_medium_light_skin_tone:`woman_white_haired_tone2`,woman_white_haired_medium_skin_tone:`woman_white_haired_tone3`,woman_white_haired_tone1:`woman_white_haired_tone1`,woman_white_haired_tone2:`woman_white_haired_tone2`,woman_white_haired_tone3:`woman_white_haired_tone3`,woman_white_haired_tone4:`woman_white_haired_tone4`,woman_white_haired_tone5:`woman_white_haired_tone5`,woman_with_headscarf:`woman_with_headscarf`,woman_with_headscarf_dark_skin_tone:`woman_with_headscarf_tone5`,woman_with_headscarf_light_skin_tone:`woman_with_headscarf_tone1`,woman_with_headscarf_medium_dark_skin_tone:`woman_with_headscarf_tone4`,woman_with_headscarf_medium_light_skin_tone:`woman_with_headscarf_tone2`,woman_with_headscarf_medium_skin_tone:`woman_with_headscarf_tone3`,woman_with_headscarf_tone1:`woman_with_headscarf_tone1`,woman_with_headscarf_tone2:`woman_with_headscarf_tone2`,woman_with_headscarf_tone3:`woman_with_headscarf_tone3`,woman_with_headscarf_tone4:`woman_with_headscarf_tone4`,woman_with_headscarf_tone5:`woman_with_headscarf_tone5`,woman_with_probing_cane:`woman_with_probing_cane`,woman_with_probing_cane_dark_skin_tone:`woman_with_probing_cane_tone5`,woman_with_probing_cane_light_skin_tone:`woman_with_probing_cane_tone1`,woman_with_probing_cane_medium_dark_skin_tone:`woman_with_probing_cane_tone4`,woman_with_probing_cane_medium_light_skin_tone:`woman_with_probing_cane_tone2`,woman_with_probing_cane_medium_skin_tone:`woman_with_probing_cane_tone3`,woman_with_probing_cane_tone1:`woman_with_probing_cane_tone1`,woman_with_probing_cane_tone2:`woman_with_probing_cane_tone2`,woman_with_probing_cane_tone3:`woman_with_probing_cane_tone3`,woman_with_probing_cane_tone4:`woman_with_probing_cane_tone4`,woman_with_probing_cane_tone5:`woman_with_probing_cane_tone5`,woman_with_veil:`woman_with_veil`,woman_with_veil_dark_skin_tone:`woman_with_veil_tone5`,woman_with_veil_light_skin_tone:`woman_with_veil_tone1`,woman_with_veil_medium_dark_skin_tone:`woman_with_veil_tone4`,woman_with_veil_medium_light_skin_tone:`woman_with_veil_tone2`,woman_with_veil_medium_skin_tone:`woman_with_veil_tone3`,woman_with_veil_tone1:`woman_with_veil_tone1`,woman_with_veil_tone2:`woman_with_veil_tone2`,woman_with_veil_tone3:`woman_with_veil_tone3`,woman_with_veil_tone4:`woman_with_veil_tone4`,woman_with_veil_tone5:`woman_with_veil_tone5`,woman_with_white_cane_facing_right:`woman_with_white_cane_facing_right`,woman_with_white_cane_facing_right_dark_skin_tone:`woman_with_white_cane_facing_right_tone5`,woman_with_white_cane_facing_right_light_skin_tone:`woman_with_white_cane_facing_right_tone1`,woman_with_white_cane_facing_right_medium_dark_skin_tone:`woman_with_white_cane_facing_right_tone4`,woman_with_white_cane_facing_right_medium_light_skin_tone:`woman_with_white_cane_facing_right_tone2`,woman_with_white_cane_facing_right_medium_skin_tone:`woman_with_white_cane_facing_right_tone3`,woman_with_white_cane_facing_right_tone1:`woman_with_white_cane_facing_right_tone1`,woman_with_white_cane_facing_right_tone2:`woman_with_white_cane_facing_right_tone2`,woman_with_white_cane_facing_right_tone3:`woman_with_white_cane_facing_right_tone3`,woman_with_white_cane_facing_right_tone4:`woman_with_white_cane_facing_right_tone4`,woman_with_white_cane_facing_right_tone5:`woman_with_white_cane_facing_right_tone5`,woman_zombie:`woman_zombie`,womans_boot:`boot`,womans_clothes:`womans_clothes`,womans_flat_shoe:`womans_flat_shoe`,womans_hat:`womans_hat`,womans_sandal:`sandal`,women_holding_hands_dark_skin_tone:`women_holding_hands_tone5`,women_holding_hands_dark_skin_tone_light_skin_tone:`women_holding_hands_tone5_tone1`,women_holding_hands_dark_skin_tone_medium_dark_skin_tone:`women_holding_hands_tone5_tone4`,women_holding_hands_dark_skin_tone_medium_light_skin_tone:`women_holding_hands_tone5_tone2`,women_holding_hands_dark_skin_tone_medium_skin_tone:`women_holding_hands_tone5_tone3`,women_holding_hands_light_skin_tone:`women_holding_hands_tone1`,women_holding_hands_light_skin_tone_dark_skin_tone:`women_holding_hands_tone1_tone5`,women_holding_hands_light_skin_tone_medium_dark_skin_tone:`women_holding_hands_tone1_tone4`,women_holding_hands_light_skin_tone_medium_light_skin_tone:`women_holding_hands_tone1_tone2`,women_holding_hands_light_skin_tone_medium_skin_tone:`women_holding_hands_tone1_tone3`,women_holding_hands_medium_dark_skin_tone:`women_holding_hands_tone4`,women_holding_hands_medium_dark_skin_tone_dark_skin_tone:`women_holding_hands_tone4_tone5`,women_holding_hands_medium_dark_skin_tone_light_skin_tone:`women_holding_hands_tone4_tone1`,women_holding_hands_medium_dark_skin_tone_medium_light_skin_tone:`women_holding_hands_tone4_tone2`,women_holding_hands_medium_dark_skin_tone_medium_skin_tone:`women_holding_hands_tone4_tone3`,women_holding_hands_medium_light_skin_tone:`women_holding_hands_tone2`,women_holding_hands_medium_light_skin_tone_dark_skin_tone:`women_holding_hands_tone2_tone5`,women_holding_hands_medium_light_skin_tone_light_skin_tone:`women_holding_hands_tone2_tone1`,women_holding_hands_medium_light_skin_tone_medium_dark_skin_tone:`women_holding_hands_tone2_tone4`,women_holding_hands_medium_light_skin_tone_medium_skin_tone:`women_holding_hands_tone2_tone3`,women_holding_hands_medium_skin_tone:`women_holding_hands_tone3`,women_holding_hands_medium_skin_tone_dark_skin_tone:`women_holding_hands_tone3_tone5`,women_holding_hands_medium_skin_tone_light_skin_tone:`women_holding_hands_tone3_tone1`,women_holding_hands_medium_skin_tone_medium_dark_skin_tone:`women_holding_hands_tone3_tone4`,women_holding_hands_medium_skin_tone_medium_light_skin_tone:`women_holding_hands_tone3_tone2`,women_holding_hands_tone1:`women_holding_hands_tone1`,women_holding_hands_tone1_tone2:`women_holding_hands_tone1_tone2`,women_holding_hands_tone1_tone3:`women_holding_hands_tone1_tone3`,women_holding_hands_tone1_tone4:`women_holding_hands_tone1_tone4`,women_holding_hands_tone1_tone5:`women_holding_hands_tone1_tone5`,women_holding_hands_tone2:`women_holding_hands_tone2`,women_holding_hands_tone2_tone1:`women_holding_hands_tone2_tone1`,women_holding_hands_tone2_tone3:`women_holding_hands_tone2_tone3`,women_holding_hands_tone2_tone4:`women_holding_hands_tone2_tone4`,women_holding_hands_tone2_tone5:`women_holding_hands_tone2_tone5`,women_holding_hands_tone3:`women_holding_hands_tone3`,women_holding_hands_tone3_tone1:`women_holding_hands_tone3_tone1`,women_holding_hands_tone3_tone2:`women_holding_hands_tone3_tone2`,women_holding_hands_tone3_tone4:`women_holding_hands_tone3_tone4`,women_holding_hands_tone3_tone5:`women_holding_hands_tone3_tone5`,women_holding_hands_tone4:`women_holding_hands_tone4`,women_holding_hands_tone4_tone1:`women_holding_hands_tone4_tone1`,women_holding_hands_tone4_tone2:`women_holding_hands_tone4_tone2`,women_holding_hands_tone4_tone3:`women_holding_hands_tone4_tone3`,women_holding_hands_tone4_tone5:`women_holding_hands_tone4_tone5`,women_holding_hands_tone5:`women_holding_hands_tone5`,women_holding_hands_tone5_tone1:`women_holding_hands_tone5_tone1`,women_holding_hands_tone5_tone2:`women_holding_hands_tone5_tone2`,women_holding_hands_tone5_tone3:`women_holding_hands_tone5_tone3`,women_holding_hands_tone5_tone4:`women_holding_hands_tone5_tone4`,women_with_bunny_ears_partying:`women_with_bunny_ears_partying`,women_wrestling:`women_wrestling`,womens:`womens`,womens_room:`womens`,wood:`wood`,woozy_face:`woozy_face`,world_map:`map`,worm:`worm`,worried:`worried`,worried_face:`worried`,worship_symbol:`place_of_worship`,wrapped_gift:`gift`,wrench:`wrench`,wrestlers:`people_wrestling`,wrestling:`people_wrestling`,writing_hand:`writing_hand`,writing_hand_tone1:`writing_hand_tone1`,writing_hand_tone2:`writing_hand_tone2`,writing_hand_tone3:`writing_hand_tone3`,writing_hand_tone4:`writing_hand_tone4`,writing_hand_tone5:`writing_hand_tone5`,ws:`flag_ws`,x:`x`,x_ray:`x_ray`,xk:`flag_xk`,yarn:`yarn`,yawning_face:`yawning_face`,ye:`flag_ye`,yellow_circle:`yellow_circle`,yellow_heart:`yellow_heart`,yellow_square:`yellow_square`,yen:`yen`,yen_banknote:`yen`,yin_yang:`yin_yang`,yo_yo:`yo_yo`,yt:`flag_yt`,yum:`yum`,za:`flag_za`,zany_face:`zany_face`,zap:`zap`,zebra:`zebra`,zero:`zero`,zipper_mouth:`zipper_mouth`,zipper_mouth_face:`zipper_mouth`,zm:`flag_zm`,zombie:`zombie`,zw:`flag_zw`,zzz:`zzz`},j=new Map,M=new Map,N=new Map;for(let e of re.trim().split(/\r?\n/)){let[t,n,r]=e.split(`	`);if(!t||!n)continue;let i=String.fromCodePoint(...n.split(`-`).map(e=>Number.parseInt(e,16)));if(j.set(t,i),M.has(i)||M.set(i,t),r!==`-`){let e=N.get(r)||[];e.push(t),N.set(r,e)}}function P(e){let t=M.get(e)||(e.startsWith(`:`)&&e.endsWith(`:`)?e.slice(1,-1):e);return ie[t]||t}var F=e=>j.get(e)||j.get(P(e))||`:`+e+`:`;function ae(e){let t=new URL(e),n;if([`youtube.com`,`www.youtube.com`,`m.youtube.com`,`youtu.be`].includes(t.hostname)&&(n=t.hostname===`youtu.be`?t.pathname.slice(1):t.pathname.startsWith(`/shorts/`)?t.pathname.slice(8):t.searchParams.get(`v`)||void 0,n&&/^[a-zA-Z0-9_-]{11}$/.test(n)))return`https://www.youtube-nocookie.com/embed/`+n;if([`vimeo.com`,`www.vimeo.com`].includes(t.hostname)&&(n=t.pathname.slice(1),/^[0-9]{1,16}$/.test(n)))return`https://player.vimeo.com/video/`+n;if([`dailymotion.com`,`www.dailymotion.com`,`dai.ly`].includes(t.hostname)&&(n=t.hostname===`dai.ly`?t.pathname.slice(1):t.pathname.split(`/video/`)[1]?.split(`_`)[0],n&&/^[a-zA-Z0-9]{1,20}$/.test(n)))return`https://www.dailymotion.com/embed/video/`+n}function oe(e){let t=ae(e);if(!t)return;let n=h(`div`,`link-card video-card`);return n.append(g(E===`fr`?`Lire la vidéo`:`Play video`,()=>{let e=h(`iframe`,`video-player`);e.src=t,e.title=E===`fr`?`Vidéo`:`Video`,e.referrerPolicy=`no-referrer`,e.allow=`autoplay; fullscreen; picture-in-picture`,e.allowFullscreen=!0,e.setAttribute(`sandbox`,`allow-scripts allow-same-origin allow-presentation`),n.replaceChildren(e)})),n}function I(e){try{let t=new URL(e,location.origin);return[`https:`,`http:`,`mailto:`].includes(t.protocol)?t.href:void 0}catch{return}}function L(e,t=0,n){let r=document.createDocumentFragment();if(t>32)return r;for(let i of e){let e;switch(i.kind){case`text`:r.append(document.createTextNode(i.text));continue;case`break`:r.append(h(`br`));continue;case`rule`:r.append(h(`hr`));continue;case`mention`:e=h(`span`,`mention`,`@`+i.name),n?.mention(i.name,e);break;case`room_mention`:e=h(`span`,`mention`,`#`+i.name);break;case`emoji`:e=h(`span`,`emoji`,F(i.shortcode)),n?.emoji(i.shortcode,e);break;case`inline_code`:e=h(`code`,``,i.text);break;case`code_block`:e=h(`pre`,`md-code`),e.append(h(`code`,``,i.text));break;case`heading`:e=h(`h`+Math.max(1,Math.min(4,i.level)),`md-h`+i.level);break;case`bold`:e=h(`strong`);break;case`italic`:e=h(`em`);break;case`strike`:e=h(`s`);break;case`quote`:e=h(`blockquote`,`md-quote`);break;case`list`:e=i.start?h(`ol`):h(`ul`),e instanceof HTMLOListElement&&i.start&&(e.start=i.start);break;case`list_item`:e=h(`li`),i.checked!=null&&e.append(h(`span`,``,i.checked?`☑ `:`☐ `));break;case`link`:{let a=I(i.href);if(!a){r.append(L(i.children,t+1,n));continue}let o=h(`a`);o.href=a,o.rel=`noopener noreferrer`,o.target=`_blank`,e=o;break}default:e=h(`p`)}`children`in i&&e.append(L(i.children,t+1,n)),r.append(e)}return r}function R(e,t,n,r=!1){let i=h(`article`,`message`+(r?` grouped`:``));if(i.dataset.id=e.id,i.dataset.stamp=JSON.stringify(e),e.system)return i.className=`system-message message-system`,i.textContent=k(e),i;let a=h(`div`,`message-gutter`);if(r)a.append(h(`span`,`gutter-time`,new Date(e.created_at).toLocaleTimeString(E,{hour:`2-digit`,minute:`2-digit`,hour12:!1})));else{let t=x(e.author.username);n.avatar(e.author,t),a.append(t)}let o=h(`div`,`message-column`);if(!r){let n=h(`div`,`message-heading`);n.append(h(`span`,`author`+(e.author.id===t?` mine`:``),e.author.display_name||e.author.username),h(`time`,`message-time`,new Date(e.created_at).toLocaleTimeString(E,{hour:`2-digit`,minute:`2-digit`,hour12:!1}))),o.append(n)}for(let t of e.quotes||[]){let e=h(`blockquote`,`quote-card`);e.append(h(`div`,`quote-author`,t.excerpt?.author.display_name||``),h(`div`,``,t.excerpt?.text||`…`)),o.append(e)}let s=h(`div`,`message-body`);e.body?s.append(L(e.body.nodes,0,n)):s.textContent=e.text,o.append(s),e.edited_at&&o.append(h(`span`,`message-note`,E===`fr`?`modifié`:`edited`));for(let t of e.files||[]){let e=h(`div`,`file-card`);e.dataset.fileId=t.id,e.dataset.fileHash=t.sha256,e.append(h(`div`,`file-title`,t.filename||t.media_type),h(`div`,`file-detail`,Number(t.bytes).toLocaleString(E)+` bytes`),g(O(`download`),()=>n.file(t,e),`file-action`)),o.append(e),!t.encrypted&&t.media_type.startsWith(`image/`)&&Number(t.bytes)<10485760&&n.file(t,e).catch(()=>{})}let c=new Set;for(let e of s.querySelectorAll(`a[href]`)){let t=oe(e.href);t&&!c.has(e.href)&&(c.add(e.href),o.append(t))}for(let t of e.previews||[]){let r=I(t.url);if(!r)continue;let i=h(`a`,`link-card`);i.href=r,i.target=`_blank`,i.rel=`noopener noreferrer`,i.append(h(`div`,`link-title`,t.title||t.url),h(`div`,`link-description`,t.description||``)),o.append(i),t.image&&BigInt(t.image.bytes)<10n*1024n*1024n&&n.previewImage(e,t.image,i).catch(()=>{})}for(let t of e.cards||[]){let e=h(`div`,`integration-card file-card`);if(t.color&&/^#[0-9a-f]{6}$/i.test(t.color)&&(e.style.borderLeftColor=t.color),t.author&&e.append(h(`div`,`quote-author`,t.author)),t.title){let n=h(`div`,`file-title`,t.title);if(t.url){let e=I(t.url);if(e){let r=h(`a`,``,t.title);r.href=e,r.rel=`noopener noreferrer`,r.target=`_blank`,n.replaceChildren(r)}}e.append(n)}t.text&&e.append(h(`div`,`message-body`,t.text));let n=h(`div`,`card-fields`);for(let e of t.fields||[]){let t=h(`div`,`card-field`+(e.short?` short`:``));t.append(h(`strong`,``,e.title),h(`div`,``,e.value)),n.append(t)}e.append(n),o.append(e)}let l=h(`div`,`reactions`);for(let r of e.reactions||[]){let i=g(F(r.emoji)+` `+r.users.length,()=>n.reaction(e,r.emoji),`reaction`+(r.users.some(e=>e.id===t)?` mine`:``)),a=h(`span`,`emoji`,F(r.emoji));n.emoji(r.emoji,a),i.replaceChildren(a,document.createTextNode(` `+r.users.length)),i.title=r.users.map(e=>e.display_name||e.username).join(`, `),l.append(i)}o.append(l),e.thread&&Number(e.thread.replies)>0&&o.append(g(e.thread.replies+` `+O(`thread`),()=>n.thread(e),`thread-chip`));let u=g(`•••`,()=>n.menu(e,u),`row-more`);return u.setAttribute(`aria-label`,O(`details`)),i.append(a,o,u),i}async function z(e,t,n,i=``,a,o){if(n.size<=0||n.size>104857600)throw Error(`File size must be between 1 byte and 100 MiB`);let s=r(),c={id:s,account:e.key,room:t,file:n,caption:i,root:a,membership:o,complete:r()};await u(`uploads`,e.key+`:`+s,c)}async function B(t){if(!t.account||t.uploading||!navigator.onLine)return;t.uploading=!0;let r=t.account.key,i=t.generation,a=()=>r===t.account?.key&&i===t.generation,o=async()=>{for(let i of(await d(`uploads`)).filter(e=>e.account===r)){if(!a())return;try{if(!t.model.rooms.has(i.room)||t.model.rooms.get(i.room)?.encrypted||i.membership!==t.model.rooms.get(i.room)?.read_state?.membership_version)throw Error(`Conversation access changed. Attach this file again.`);let e;if(i.slot)e=await t.api.request(`/api/v1/uploads/`+n(i.slot));else{let n=Array.from(new Uint8Array(await crypto.subtle.digest(`SHA-256`,await i.file.arrayBuffer())),e=>e.toString(16).padStart(2,`0`)).join(``);if(!a()||(e=await t.api.request(`/api/v1/uploads`,`POST`,{operation_id:i.id,room_id:i.room,bytes:String(i.file.size),sha256:n,media_type:i.file.type.split(`;`)[0].trim().toLowerCase()||`application/octet-stream`,filename:i.file.name,encrypted:!1}),!a()))return;i.slot=e.id,await u(`uploads`,r+`:`+i.id,i)}if(!a())return;if(e.state===`expired`||e.state===`cancelled`)throw Error(`Upload expired`);if(e.state===`prepared`&&await t.api.upload(`/api/v1/uploads/`+n(e.id)+`/bytes`,i.file,e=>{a()&&(t.uploadProgress.set(i.id,e),t.renderUploads())}),!a())return;let o=await t.api.request(`/api/v1/uploads/`+n(e.id)+`/complete`,`POST`,{operation_id:i.complete,content:{kind:`plain`,markdown:i.caption,mentions:[],quotes:[],files:[e.id]},reply_to:i.root||null});if(!a())return;await u(`uploads`,r+`:`+i.id),t.model.put(o),t.refresh()}catch(t){if(!a())return;if(i.error=t instanceof Error?t.message:String(t),await u(`uploads`,r+`:`+i.id,i),!(t instanceof e)||t.status===429||t.status>=500)break}}};try{navigator.locks?await navigator.locks.request(`rv-uploads:`+r,o):await o()}finally{t.uploading=!1,t.uploadProgress.clear(),a()&&await t.loadUploads()}}var se={ringtone:`/assets/ringtone-BJS6bYjD.ogg`,ringback:`/assets/ringback-B5tbZIZJ.ogg`,join:`/assets/cue-join-xgNC4jwo.ogg`,leave:`/assets/cue-leave-DVXW9D-K.ogg`,mute:`/assets/cue-mute-4QEtROfH.ogg`,unmute:`/assets/cue-unmute-BWSe_5VY.ogg`,missed:`/assets/cue-missed-CTnauKK-.ogg`};function V(e,t=!1){let n=new Audio(se[e]);return n.loop=t,n.volume=.5,n.play().catch(()=>{}),n}var ce=`modulepreload`,le=function(e){return`/`+e},ue={},de=function(e){return e.pathname.endsWith(`.css`)},fe=function(e,t,n){if(t in e)return e[t];let r=n();if(!r){e[t]=void 0;return}let i=r.then(()=>{e[t]=void 0},n=>{throw e[t]=void 0,n});return e[t]=i,i},pe=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e,i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?new URL(import.meta.resolve(e)):new URL(e,import.meta.url)}r=o(t.map(t=>{t=le(t,n);let r=s(t),i=de(r);return fe(ue,r.href,()=>{if(e===void 0){e={all:new Set,styles:new Set};let t=document.getElementsByTagName(`link`);for(let n=t.length-1;n>=0;n--){let r=t[n];e.all.add(r.href),r.rel===`stylesheet`&&e.styles.add(r.href)}}if((i?e.styles:e.all).has(r.href))return;let t=document.createElement(`link`);if(t.rel=i?`stylesheet`:ce,i||(t.as=`script`),t.crossOrigin=``,t.href=r.href,a&&t.setAttribute(`nonce`,a),document.head.appendChild(t),i)return new Promise((e,n)=>{t.addEventListener(`load`,e),t.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${r}`)))})})}).filter(e=>e!==void 0))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})},me=class{app;current;room;busy=!1;cancelled=!1;ringDialogs=new Map;bar=h(`div`,`voice-bar`);stage=h(`div`,`voice-stage`);muted=!1;camera=!1;sharing=!1;deafened=!1;cards=new Map;loop;tracks=new Map;dialog;constructor(e){this.app=e,this.stage.addEventListener(`dblclick`,e=>{let t=e.target.closest(`video`);t&&t.requestFullscreen().catch(v)})}async join(e=this.app.room){if(!e||!this.app.account||!this.app.info||this.app.model.rooms.get(e)?.encrypted||this.busy)return;if(this.current===e&&this.room){this.show();return}await this.leave(),this.busy=!0,this.cancelled=!1;let t=this.app.account.key;try{let r=this.app.model.rooms.get(e),i=r?.read_state?.membership_version;if(!i)return;let a=await this.app.api.request(`/api/v1/rooms/`+n(e)+`/voice/join`,`POST`,{data_epoch:this.app.account.epoch,membership_version:i,e2ee:!1,ring:r?.kind===`direct`});if(t!==this.app.account?.key)return;if(a.e2ee)throw Error(O(`encryptedHint`));if(this.current=e,this.bar.replaceChildren(h(`span`,``,r?.name||``),h(`span`,`dim`,E===`fr`?`Appel…`:`Calling…`),T(`close`,O(`close`),()=>this.leave())),this.app.sidebar.insertBefore(this.bar,this.app.sidebar.lastElementChild),a.ring){for(this.loop=V(`ringback`,!0);a.ring.state===`ringing`&&!this.cancelled;)await new Promise(e=>setTimeout(e,700)),a.ring=await this.app.api.request(`/api/v1/voice/rings/`+n(a.ring.id));if(a.ring.state!==`answered`||this.cancelled){await this.leave();return}}t===this.app.account?.key&&!this.cancelled&&await this.connect(a)}catch(e){throw await this.leave(),e}finally{this.busy=!1}}async connect(e){if(!this.app.account)return;if(e.e2ee)throw Error(O(`encryptedHint`));this.loop?.pause(),this.loop=void 0;let t=new URL(e.url);if(![`wss:`,`https:`].includes(t.protocol)&&!([`ws:`,`http:`].includes(t.protocol)&&[`localhost`,`127.0.0.1`].includes(t.hostname)))throw Error(`Invalid voice service origin`);let n=this.app.account?.key,{Room:r,RoomEvent:i,Track:a}=await pe(async()=>{let{Room:e,RoomEvent:t,Track:n}=await import(`./livekit-client.esm-B_zFazHw.js`);return{Room:e,RoomEvent:t,Track:n}},[]),o=new r({adaptiveStream:!0,dynacast:!0,audioCaptureDefaults:{echoCancellation:!0,noiseSuppression:localStorage.getItem(`rv-voice-noise`)!==`false`,autoGainControl:!0,deviceId:localStorage.getItem(`rv-audioinput`)||void 0},videoCaptureDefaults:{deviceId:localStorage.getItem(`rv-videoinput`)||void 0}});if(this.room=o,this.current=e.room_id,o.on(i.ParticipantConnected,e=>this.card(e.identity,e.name||e.identity)),o.on(i.ParticipantDisconnected,e=>{this.cards.get(e.identity)?.remove(),this.cards.delete(e.identity)}),o.on(i.ActiveSpeakersChanged,e=>{let t=new Set(e.map(e=>e.identity));for(let[e,n]of this.cards)n.classList.toggle(`voice-speaking`,t.has(e))}),o.on(i.TrackSubscribed,(e,t,n)=>{let r=e.attach();r.setAttribute(`autoplay`,``),r instanceof HTMLAudioElement&&(r.muted=this.deafened,r.classList.add(`voice-audio`)),r instanceof HTMLVideoElement&&(r.playsInline=!0,r.classList.add(`voice-camera`)),this.card(n.identity,n.name||n.identity).append(r),e.sid&&this.tracks.set(e.sid,r)}),o.on(i.TrackUnsubscribed,e=>{for(let t of e.detach())t.remove();e.sid&&(this.tracks.get(e.sid)?.remove(),this.tracks.delete(e.sid))}),o.on(i.LocalTrackPublished,e=>{let t=e.track;if(!t||t.kind!==a.Kind.Video)return;let n=t.attach();n.muted=!0,n.classList.add(`voice-camera`),n instanceof HTMLVideoElement&&(n.playsInline=!0),this.card(o.localParticipant.identity,this.app.account?.session.user.display_name||``).append(n),t.sid&&this.tracks.set(t.sid,n)}),o.on(i.LocalTrackUnpublished,e=>{e.trackSid&&(this.tracks.get(e.trackSid)?.remove(),this.tracks.delete(e.trackSid)),e.source===a.Source.ScreenShare&&this.sharing&&(this.sharing=!1,this.app.api.request(`/api/v1/voice/screen`,`DELETE`).catch(()=>{}))}),o.on(i.Disconnected,()=>{this.room===o&&(this.room=void 0,this.current=void 0,this.bar.remove(),this.stage.remove())}),await o.connect(e.url,e.token),n!==this.app.account?.key||this.cancelled){await o.disconnect();return}this.card(o.localParticipant.identity,this.app.account?.session.user.display_name||``);for(let e of o.remoteParticipants.values())this.card(e.identity,e.name||e.identity);e.can_publish&&await o.localParticipant.setMicrophoneEnabled(!0),V(`join`);let s=T(`mic`,`Microphone`,async()=>{this.muted=!this.muted,V(this.muted?`mute`:`unmute`),await o.localParticipant.setMicrophoneEnabled(!this.muted),s.classList.toggle(`muted`,this.muted)});s.disabled=!e.can_publish;let c=T(`video`,E===`fr`?`Caméra`:`Camera`,async()=>{this.camera=!this.camera,await o.localParticipant.setCameraEnabled(this.camera)});c.disabled=!e.can_publish;let l=g(E===`fr`?`Partager l’écran`:`Share screen`,async()=>{if(this.sharing)await o.localParticipant.setScreenShareEnabled(!1),await this.app.api.request(`/api/v1/voice/screen`,`DELETE`),this.sharing=!1;else{await this.app.api.request(`/api/v1/voice/screen`,`POST`,null);try{await o.localParticipant.setScreenShareEnabled(!0),this.sharing=!0}catch(e){throw await this.app.api.request(`/api/v1/voice/screen`,`DELETE`),e}}});l.disabled=!e.can_publish;let u=g(E===`fr`?`Écoute`:`Listen`,async()=>{this.deafened=!this.deafened;for(let e of this.stage.querySelectorAll(`audio`))e.muted=this.deafened;await o.localParticipant.setAttributes({"rv.deafened":String(this.deafened)}),u.classList.toggle(`muted`,this.deafened)});this.bar.replaceChildren(g(this.app.model.rooms.get(e.room_id)?.name||O(`voice`),()=>this.show()),s,u,c,T(`close`,O(`close`),()=>this.leave())),this.stage.prepend(h(`div`,`voice-controls`)),this.stage.querySelector(`.voice-controls`).append(l,g(`Audio`,()=>o.startAudio())),this.app.sidebar.insertBefore(this.bar,this.app.sidebar.lastElementChild),this.show()}card(e,t){let n=this.cards.get(e);if(!n){n=h(`div`,`voice-card`),n.dataset.participant=e;let r=x(t,`profile`);r.classList.add(`voice-avatar`),n.append(r,h(`span`,`voice-card-name`,t)),this.cards.set(e,n),this.stage.append(n)}return n}async settings(e){let t=async()=>{let t=await navigator.mediaDevices.enumerateDevices();for(let[n,r]of[[`audioinput`,`Microphone`],[`audiooutput`,E===`fr`?`Sortie audio`:`Audio output`],[`videoinput`,E===`fr`?`Caméra`:`Camera`]]){let i=h(`select`,`pill-entry`),a=h(`label`,`field`);a.append(h(`span`,`pill-caption`,r),i);for(let e of t.filter(e=>e.kind===n)){let t=h(`option`,``,e.label||r);t.value=e.deviceId,i.append(t)}i.value=localStorage.getItem(`rv-`+n)||`default`,i.addEventListener(`change`,()=>{localStorage.setItem(`rv-`+n,i.value),this.room?.switchActiveDevice(n,i.value).catch(v)}),e.append(a)}let n=h(`label`,`toggle`),r=h(`input`);r.type=`checkbox`,r.checked=localStorage.getItem(`rv-voice-noise`)!==`false`,r.addEventListener(`change`,()=>localStorage.setItem(`rv-voice-noise`,String(r.checked))),n.append(r,h(`span`,``,E===`fr`?`Réduction du bruit au prochain appel`:`Noise suppression on the next call`)),e.append(n)};e.append(g(E===`fr`?`Autoriser le micro et la caméra`:`Allow microphone and camera`,async()=>{(await navigator.mediaDevices.getUserMedia({audio:!0,video:!0})).getTracks().forEach(e=>e.stop()),e.querySelectorAll(`label`).forEach(e=>e.remove()),await t()})),await t()}show(){if(!this.current)return;this.dialog?.close();let[e,t]=y(this.app.model.rooms.get(this.current)?.name||O(`voice`));this.dialog=e,e.classList.add(`voice-dialog`),t.append(this.stage)}async leave(e=!0){this.cancelled=!0,this.loop?.pause(),this.loop=void 0,this.cards.clear(),this.dialog?.close(),this.dialog=void 0;let t=this.current||this.room,n=this.room;if(this.room=void 0,this.current=void 0,this.bar.remove(),this.stage.remove(),this.stage.replaceChildren(),this.tracks.clear(),this.muted=!1,this.camera=!1,this.sharing=!1,this.deafened=!1,n&&(await n.disconnect(!0),V(`leave`)),t&&e)try{await this.app.api.request(`/api/v1/voice/leave`,`POST`,null)}catch{}}observe(e){for(let[t,n]of this.ringDialogs)e.rings?.some(e=>e.id===t&&e.state===`ringing`)||(n.close(),this.ringDialogs.delete(t));for(let t of e.rings||[]){if(t.state!==`ringing`||t.callee.id!==this.app.account?.session.user.id||this.ringDialogs.has(t.id)||this.app.model.rooms.get(t.room_id)?.encrypted)continue;let[e,r]=y(E===`fr`?`Appel entrant`:`Incoming call`),i=V(`ringtone`,!0);e.addEventListener(`close`,()=>i.pause()),this.ringDialogs.set(t.id,e),r.append(x(t.caller.username,`profile`),h(`h2`,`details-name`,t.caller.display_name||t.caller.username),g(O(`join`),async()=>{let r=this.app.model.rooms.get(t.room_id)?.read_state?.membership_version;if(!r||!this.app.account)return;await this.leave();let i=await this.app.api.request(`/api/v1/voice/rings/`+n(t.id)+`/accept`,`POST`,{data_epoch:this.app.account.epoch,membership_version:r,e2ee:!1});e.close(),this.cancelled=!1,await this.connect(i)},`cta`),g(O(`cancel`),async()=>{await this.app.api.request(`/api/v1/voice/rings/`+n(t.id)+`/decline`,`POST`,null),e.close()},`destructive`))}}},H=(e,t)=>E===`fr`?t:e;async function he(e,t){if(!e.account)return;let n=e.account.key,a=n+`:email-verify`,o=await e.api.request(`/api/v1/me/email`),[s,c]=_(O(`email`),o.address||``,`email`);t.append(h(`h3`,``,O(`email`)),s);let d=async()=>{n===e.account?.key&&(t.replaceChildren(h(`h2`,``,O(`security`))),await K(e,t))};async function f(){let t=await e.api.request(`/api/v1/me/email`);await e.api.request(`/api/v1/me/email/verification/retire`,`POST`,{context:t.context,expected_version:t.version,verification_version:t.verification_version}),await u(`operations`,a)}async function p(t,n=!1){let r=await e.api.request(`/api/v1/me/email/verification/`+(n?`start`:`resume`),`POST`,n?t:{context:t.context,operation_id:t.operation_id,verification_id:t.verification_id});if(r.state===`verified`){await u(`operations`,a),await d();return}let[i,o]=y(O(`email`));o.append(h(`p`,``,r.address),h(`p`,`dim`,H(`Enter the code in your email.`,`Saisissez le code reçu par email.`)));let[s,c]=_(O(`code`));c.autocomplete=`one-time-code`;let l=t.operation_id;o.append(s,g(O(`verify`),async()=>{await W(e),await e.api.request(`/api/v1/me/email/verification/confirm`,`POST`,{context:t.context,operation_id:l,verification_id:t.verification_id,code:c.value}),c.value=``,await u(`operations`,a),i.close(),await d()},`cta`),g(O(`retry`),async()=>{i.close(),await p(t)}),g(O(`cancel`),async()=>{await f(),i.close(),await d()}))}let m=await l(`operations`,a);if(m&&JSON.stringify(m.context)===JSON.stringify(o.context)&&t.append(g(H(`Continue email verification`,`Continuer la vérification de l’email`),()=>p(m)),g(O(`cancel`),async()=>{await f(),await d()})),e.info?.capabilities.email_verification&&t.append(g(O(`save`),async()=>{if(await W(e),m){await p(m);return}let t={address:c.value.trim(),context:o.context,expected_version:o.version,verification_version:o.verification_version,operation_id:r(),verification_id:i()};await u(`operations`,a,t),await p(t,!0)})),o.address&&e.info?.capabilities.email_removal&&t.append(g(H(`Remove email address`,`Supprimer l’adresse email`),()=>{let[t,i]=y(O(`email`));i.append(h(`p`,``,o.address),g(O(`delete`),async()=>{await W(e);let i=n+`:email-remove`,s=await l(`operations`,i);s||(s={context:o.context,expected_version:o.version,verification_version:o.verification_version,operation_id:r()},await u(`operations`,i,s)),await e.api.request(`/api/v1/me/email/removal/start`,`POST`,s),await u(`operations`,i),await u(`operations`,a),t.close(),await d()},`destructive`))},`destructive`)),o.address&&e.info?.capabilities.email_factors){let i=await e.api.request(`/api/v1/me/factors`);t.append(g(i.email?H(`Disable email authentication`,`Désactiver l’authentification par email`):H(`Enable email authentication`,`Activer l’authentification par email`),async()=>{await W(e);let t=n+`:email-factor`,a=await l(`operations`,t);a||(a={context:o.context,email_version:o.version,factor_version:i.factor_version,operation_id:r()},await u(`operations`,t,a));let s=await e.api.request(`/api/v1/me/factors/email/`+(i.email?`disable`:`enable`),`POST`,a);await u(`operations`,t),s.codes.length&&G(s),await d()}))}}var U=(e,t)=>E===`fr`?t:e;async function W(e){let t=await e.api.request(`/api/v1/me/reauth`);t.recent||await new Promise((n,a)=>{let[o,s]=y(O(`security`)),[c,l]=_(O(`password`),``,`password`);l.autocomplete=`current-password`;let u={operation_id:r(),challenge_id:i(),proof_version:t.proof_version},d=!1;s.append(c,g(O(`verify`),async()=>{let t=await e.api.request(`/api/v1/me/reauth/start`,`POST`,{...u,password:l.value});if(l.value=``,t.kind===`granted`){d=!0,o.close(),n();return}let a=h(`select`,`pill-entry`);for(let e of t.challenge.methods){let t=h(`option`,``,O(e));t.value=e,a.append(t)}let[c,f]=_(O(`code`));f.autocomplete=`one-time-code`;let p=r();s.replaceChildren(a,c,g(O(`verify`),async()=>{await e.api.request(`/api/v1/me/reauth/finish`,`POST`,{operation_id:p,challenge_id:t.challenge.challenge_id,method:a.value,code:f.value}),f.value=``,d=!0,o.close(),n()},`cta`)),t.challenge.methods.includes(`email`)&&s.append(g(O(`email`),()=>e.api.request(`/api/v1/me/reauth/email/start`,`POST`,{challenge_id:t.challenge.challenge_id,operation_id:r(),delivery_id:i()}).then(()=>{})))},`cta`)),o.addEventListener(`close`,()=>{d||a(Error(O(`cancel`)))}),l.focus()})}function G(e){let[t,n]=y(O(`recoveryCode`));n.append(h(`p`,`dim`,U(`Keep these codes somewhere safe. Each code works once.`,`Conservez ces codes dans un endroit sûr. Chaque code fonctionne une fois.`)));let r=h(`pre`,`backup-codes`,e.codes.join(`
`));n.append(r,g(O(`copy`),()=>navigator.clipboard.writeText(e.codes.join(`
`))),g(O(`save`),()=>{let t=URL.createObjectURL(new Blob([e.codes.join(`
`)+`
`],{type:`text/plain`})),n=h(`a`);n.href=t,n.download=`rocket-vibe-recovery-codes.txt`,n.click(),setTimeout(()=>URL.revokeObjectURL(t),1e3)}),g(O(`close`),()=>t.close()))}async function K(e,t){let n=await e.api.request(`/api/v1/me/factors`);t.append(h(`p`,``,O(`totp`)+`: `+(n.totp?`✓`:`—`)),h(`p`,``,O(`email`)+`: `+(n.email?`✓`:`—`)),h(`p`,``,O(`recoveryCode`)+`: `+n.backup_codes_remaining)),await he(e,t),e.info?.capabilities.second_factors&&(n.totp?t.append(g(U(`Disable authenticator`,`Désactiver l’authentification`),async()=>{let[r,i]=y(O(`security`));i.append(h(`p`,``,U(`Disable the authenticator for this account?`,`Désactiver l’authentification pour ce compte ?`)),g(O(`verify`),async()=>{await W(e),await e.api.request(`/api/v1/me/factors/totp/disable`,`POST`,{factor_version:n.factor_version}),r.close(),t.replaceChildren(h(`h2`,``,O(`security`))),await K(e,t)},`destructive`))},`destructive`)):t.append(g(U(`Set up authenticator`,`Configurer l’authentification`),async()=>{await W(e);let n=await e.api.request(`/api/v1/me/factors/totp/setup`,`POST`,{operation_id:r()}),[i,a]=y(O(`totp`));a.append(h(`p`,`dim`,U(`Add this key to your authenticator, then enter its verification code.`,`Ajoutez cette clé dans votre application d’authentification, puis saisissez son code.`)));let o=h(`code`,`totp-secret`,n.secret);o.dataset.secret=n.secret;let s=h(`a`,``,U(`Open authenticator`,`Ouvrir l’application d’authentification`));s.href=n.provisioning_uri;let[c,l]=_(O(`code`));l.autocomplete=`one-time-code`;let u=r();a.append(o,s,c,g(O(`verify`),async()=>{let r=await e.api.request(`/api/v1/me/factors/totp/enable`,`POST`,{operation_id:u,setup_id:n.setup_id,code:l.value});l.value=``,i.close(),G(r),t.replaceChildren(h(`h2`,``,O(`security`))),await K(e,t)},`cta`))},`cta`)),n.factor_version&&t.append(g(U(`Replace recovery codes`,`Remplacer les codes de récupération`),async()=>{await W(e),G(await e.api.request(`/api/v1/me/factors/recovery/regenerate`,`POST`,{operation_id:r(),factor_version:n.factor_version})),t.replaceChildren(h(`h2`,``,O(`security`))),await K(e,t)})))}var q={name:`rocket-vibe-web`,version:`0.1.0`,private:!0,type:`module`,scripts:{dev:`vite --host 127.0.0.1`,check:`tsc --noEmit`,build:`node scripts/sync-design.mjs && node scripts/licenses.mjs && npm run check && vite build && node scripts/build-shell.mjs`,test:`node --experimental-strip-types --test tests/*.test.ts`,"test:browser":`node tests/browser.mjs`,"test:voice":`node tests/voice.mjs`,"test:security":`node tests/security.mjs`,"test:features":`node tests/features.mjs`,"test:sessions":`node tests/sessions.mjs`,"test:locked":`node tests/locked.mjs`,"test:composer":`node tests/composer.mjs`,format:`prettier --write src scripts tests *.js *.json index.html`,"format:check":`prettier --check src scripts tests *.js *.json index.html`},devDependencies:{playwright:`^1.64.0`,prettier:`3.9.9`,typescript:`^6.0.0`,vite:`^8.0.0`},dependencies:{"livekit-client":`^2.22.3`}},ge=[[`Nunito`,`Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`],[`Baloo 2`,`﻿Copyright 2019 The Baloo 2 Project Authors (https://github.com/EkType/Baloo2)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`],[`Noto Color Emoji`,`Copyright 2013 Google LLC

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`],[`Noto build tools`,`Copyright 2013 Google LLC

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
`],[`Adwaita`,`This work is licenced under the terms of either the GNU LGPL v3 or
Creative Commons Attribution-Share Alike 3.0 United States License.

To view a copy of the CC-BY-SA licence, visit
http://creativecommons.org/licenses/by-sa/3.0/ or send a letter to Creative
Commons, 171 Second Street, Suite 300, San Francisco, California 94105, USA.

When attributing the artwork, using "GNOME Project" is enough.
Please link to http://www.gnome.org where available.

`],[`Adwaita CC BY-SA`,`This work is licenced under the Creative Commons Attribution-Share Alike 3.0
United States License. To view a copy of this licence, visit
http://creativecommons.org/licenses/by-sa/3.0/ or send a letter to Creative
Commons, 171 Second Street, Suite 300, San Francisco, California 94105, USA.

When attributing the artwork, using "GNOME Project" is enough. 
Please link to http://www.gnome.org where available.
`],[`Adwaita LGPL`,`                   GNU LESSER GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <http://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.


  This version of the GNU Lesser General Public License incorporates
the terms and conditions of version 3 of the GNU General Public
License, supplemented by the additional permissions listed below.

  0. Additional Definitions.

  As used herein, "this License" refers to version 3 of the GNU Lesser
General Public License, and the "GNU GPL" refers to version 3 of the GNU
General Public License.

  "The Library" refers to a covered work governed by this License,
other than an Application or a Combined Work as defined below.

  An "Application" is any work that makes use of an interface provided
by the Library, but which is not otherwise based on the Library.
Defining a subclass of a class defined by the Library is deemed a mode
of using an interface provided by the Library.

  A "Combined Work" is a work produced by combining or linking an
Application with the Library.  The particular version of the Library
with which the Combined Work was made is also called the "Linked
Version".

  The "Minimal Corresponding Source" for a Combined Work means the
Corresponding Source for the Combined Work, excluding any source code
for portions of the Combined Work that, considered in isolation, are
based on the Application, and not on the Linked Version.

  The "Corresponding Application Code" for a Combined Work means the
object code and/or source code for the Application, including any data
and utility programs needed for reproducing the Combined Work from the
Application, but excluding the System Libraries of the Combined Work.

  1. Exception to Section 3 of the GNU GPL.

  You may convey a covered work under sections 3 and 4 of this License
without being bound by section 3 of the GNU GPL.

  2. Conveying Modified Versions.

  If you modify a copy of the Library, and, in your modifications, a
facility refers to a function or data to be supplied by an Application
that uses the facility (other than as an argument passed when the
facility is invoked), then you may convey a copy of the modified
version:

   a) under this License, provided that you make a good faith effort to
   ensure that, in the event an Application does not supply the
   function or data, the facility still operates, and performs
   whatever part of its purpose remains meaningful, or

   b) under the GNU GPL, with none of the additional permissions of
   this License applicable to that copy.

  3. Object Code Incorporating Material from Library Header Files.

  The object code form of an Application may incorporate material from
a header file that is part of the Library.  You may convey such object
code under terms of your choice, provided that, if the incorporated
material is not limited to numerical parameters, data structure
layouts and accessors, or small macros, inline functions and templates
(ten or fewer lines in length), you do both of the following:

   a) Give prominent notice with each copy of the object code that the
   Library is used in it and that the Library and its use are
   covered by this License.

   b) Accompany the object code with a copy of the GNU GPL and this license
   document.

  4. Combined Works.

  You may convey a Combined Work under terms of your choice that,
taken together, effectively do not restrict modification of the
portions of the Library contained in the Combined Work and reverse
engineering for debugging such modifications, if you also do each of
the following:

   a) Give prominent notice with each copy of the Combined Work that
   the Library is used in it and that the Library and its use are
   covered by this License.

   b) Accompany the Combined Work with a copy of the GNU GPL and this license
   document.

   c) For a Combined Work that displays copyright notices during
   execution, include the copyright notice for the Library among
   these notices, as well as a reference directing the user to the
   copies of the GNU GPL and this license document.

   d) Do one of the following:

       0) Convey the Minimal Corresponding Source under the terms of this
       License, and the Corresponding Application Code in a form
       suitable for, and under terms that permit, the user to
       recombine or relink the Application with a modified version of
       the Linked Version to produce a modified Combined Work, in the
       manner specified by section 6 of the GNU GPL for conveying
       Corresponding Source.

       1) Use a suitable shared library mechanism for linking with the
       Library.  A suitable mechanism is one that (a) uses at run time
       a copy of the Library already present on the user's computer
       system, and (b) will operate properly with a modified version
       of the Library that is interface-compatible with the Linked
       Version.

   e) Provide Installation Information, but only if you would otherwise
   be required to provide such information under section 6 of the
   GNU GPL, and only to the extent that such information is
   necessary to install and execute a modified version of the
   Combined Work produced by recombining or relinking the
   Application with a modified version of the Linked Version. (If
   you use option 4d0, the Installation Information must accompany
   the Minimal Corresponding Source and Corresponding Application
   Code. If you use option 4d1, you must provide the Installation
   Information in the manner specified by section 6 of the GNU GPL
   for conveying Corresponding Source.)

  5. Combined Libraries.

  You may place library facilities that are a work based on the
Library side by side in a single library together with other library
facilities that are not Applications and are not covered by this
License, and convey such a combined library under terms of your
choice, if you do both of the following:

   a) Accompany the combined library with a copy of the same work based
   on the Library, uncombined with any other library facilities,
   conveyed under the terms of this License.

   b) Give prominent notice with the combined library that part of it
   is a work based on the Library, and explaining where to find the
   accompanying uncombined form of the same work.

  6. Revised Versions of the GNU Lesser General Public License.

  The Free Software Foundation may publish revised and/or new versions
of the GNU Lesser General Public License from time to time. Such new
versions will be similar in spirit to the present version, but may
differ in detail to address new problems or concerns.

  Each version is given a distinguishing version number. If the
Library as you received it specifies that a certain numbered version
of the GNU Lesser General Public License "or any later version"
applies to it, you have the option of following the terms and
conditions either of that published version or of any later version
published by the Free Software Foundation. If the Library as you
received it does not specify a version number of the GNU Lesser
General Public License, you may choose any version of the GNU Lesser
General Public License ever published by the Free Software Foundation.

  If the Library as you received it specifies that a proxy can decide
whether future versions of the GNU Lesser General Public License shall
apply, that proxy's public statement of acceptance of any version is
permanent authorization for you to choose that version for the
Library.
`],[`JavaScript dependencies`,`@bufbuild/protobuf 1.10.1 ((Apache-2.0 AND BSD-3-Clause))



@livekit/mutex 1.1.1 (Apache-2.0)


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.


@livekit/protocol 1.50.4 (Apache-2.0)


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.


events 3.3.0 (MIT)

MIT

Copyright Joyent, Inc. and other Node contributors.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.


jose 6.2.12 (MIT)

The MIT License (MIT)

Copyright (c) 2018 Filip Skokan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


livekit-client 2.22.3 (Apache-2.0)


                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.


loglevel 1.9.2 (MIT)



machina 7.0.1 (MIT)

Copyright (c) 2011-2023 Jim Cowart (MIT License)

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

See http://opensource.org/licenses/MIT for more details.

--------------------------------------------------------------------
Also available under GPL 2.0
Copyright (c) 2011-2015 Jim Cowart (GPL-2.0 License)

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or (at
your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details.

See http://opensource.org/licenses/GPL-2.0 for more details

--------------------------------------------------------------------

The extend function included in machina was very heavily borrowed
from the backbone.js project, which can be found at http://backbonejs.org.
Due to its origin, the backbone license is included below as well.

Copyright (c) 2010-2012 Jeremy Ashkenas, DocumentCloud

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.


sdp 3.2.2 (MIT)

Copyright (c) 2017 Philipp Hancke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


sdp-transform 2.15.0 (MIT)

(The MIT License)

Copyright (c) 2013 Eirik Albrigtsen

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


tslib 2.8.1 (0BSD)

Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

typed-emitter 2.1.0 (MIT)

The MIT License (MIT)

Copyright (c) 2018 Andy Wermke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.


webrtc-adapter 9.0.6 (BSD-3-Clause)

Copyright (c) 2014, The WebRTC project authors. All rights reserved.
Copyright (c) 2018, The adapter.js project authors. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in
    the documentation and/or other materials provided with the
    distribution.

  * Neither the name of Google nor the names of its contributors may
    be used to endorse or promote products derived from this software
    without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`]].map(([e,t])=>e+`

`+t).join(`

`);async function _e(e){let[t,i]=y(O(`new`)),[a,o]=_(O(`search`));i.append(a);let s=h(`div`,`tabs`),c=h(`div`,`spotlight`);i.append(s,c);let l=`people`,u=0,d=async()=>{let r=++u;if(c.replaceChildren(h(`p`,``,O(`loading`))),l===`people`){let n=await e.api.request(`/api/v1/users`);if(r!==u||!t.open)return;c.replaceChildren();for(let r of n.filter(t=>t.id!==e.account?.session.user.id&&(t.username+` `+t.display_name).toLowerCase().includes(o.value.toLowerCase()))){let n=g(``,async()=>{let n=await e.api.request(`/api/v1/direct-messages`,`POST`,{user_id:r.id});e.model.rooms.set(n.id,n),await e.openRoom(n.id),t.close()},`spotlight-row`);n.append(x(r.username),h(`span`,``,r.display_name||r.username)),c.append(n)}}else{let i=await e.api.request(`/api/v1/rooms/public?q=`+n(o.value));if(r!==u||!t.open)return;c.replaceChildren();for(let r of i.rooms){let i=g(``,async()=>{let i=r.joined?r.room:await e.api.request(`/api/v1/rooms/`+n(r.room.id)+`/join`,`POST`,null);e.model.rooms.set(i.id,i),await e.openRoom(i.id),t.close()},`spotlight-row`);i.append(x(r.room.name,`message`,`#`),h(`span`,``,r.room.name),h(`span`,`dim`,r.joined?``:O(`join`))),c.append(i)}}c.children.length||c.append(h(`p`,`dim`,O(`noResults`)))};s.append(g(O(`people`),()=>(l=`people`,d())),g(O(`rooms`),()=>(l=`rooms`,d())),g(O(`create`),()=>{let[n,i]=y(O(`create`)),[a,o]=_(O(`name`)),s=h(`label`,`toggle`),c=h(`input`);c.type=`checkbox`,s.append(c,h(`span`,``,O(`private`)));let l=h(`input`);l.type=`checkbox`;let u=h(`label`,`toggle`);u.append(l,h(`span`,``,E===`fr`?`Salon vocal`:`Voice channel`)),e.info?.capabilities.voice&&i.append(u),i.append(a,s,g(O(`create`),async()=>{let i=await e.api.request(`/api/v1/rooms`,`POST`,{name:o.value,private:c.checked,voice:l.checked,operation_id:r()});e.model.rooms.set(i.id,i),n.close(),t.close(),await e.openRoom(i.id)},`cta`))}));let f;o.addEventListener(`input`,()=>{clearTimeout(f),f=setTimeout(()=>void d().catch(v),200)}),await d(),o.focus()}async function ve(e){if(!e.room)return;let t=e.room,[r,i]=y(O(`search`)),[a,o]=_(O(`search`));o.type=`search`;let s=h(`div`,`search-results`);i.append(a,s);let c=0,l=async()=>{if(!o.value.trim()){s.replaceChildren();return}let i=++c,a=await e.api.request(`/api/v1/rooms/`+n(t)+`/messages/search?q=`+n(o.value));if(i===c&&r.open){s.replaceChildren();for(let t of a.messages){let n=R(t,e.account.session.user.id,e);n.append(g(O(`join`),async()=>{e.model.put(t),await e.jumpTo(t),r.close()})),s.append(n)}a.messages.length||s.append(h(`p`,`dim`,O(`noResults`)))}},u;o.addEventListener(`input`,()=>{clearTimeout(u),u=setTimeout(()=>void l().catch(v),250)}),o.addEventListener(`keydown`,e=>{e.key===`Enter`&&l().catch(v)}),o.focus()}async function ye(e){if(!e.room)return;let t=e.room,[r,i]=y(O(`pins`)),a=h(`div`,`tabs`),o=h(`div`),s=`pins`;i.append(a,o);let c=async()=>{let i=await e.api.request(`/api/v1/rooms/`+n(t)+`/`+s);if(r.open){o.replaceChildren();for(let t of i.messages){let n=R(t,e.account.session.user.id,e);n.append(g(E===`fr`?`Ouvrir le message`:`Open message`,async()=>{await e.jumpTo(t),r.close()})),o.append(n)}i.messages.length||o.append(h(`p`,`dim`,O(`noResults`)))}};a.append(g(O(`pins`),()=>(s=`pins`,c())),g(O(`stars`),()=>(s=`stars`,c()))),await c()}async function J(e,t){let r=e.generation,i=await e.api.request(`/api/v1/users/`+n(t));if(r!==e.generation)return;let[a,o]=y(O(`profile`)),s=x(i.user.username,`profile`);if(o.append(s,h(`h2`,`details-name`,i.user.display_name||i.user.username),h(`p`,`details-sub`,`@`+i.user.username),h(`p`,``,i.bio),h(`p`,`dim`,i.status_text)),i.avatar_file_id){let t=await e.api.blob(`/api/v1/avatars/`+n(i.avatar_file_id));if(a.open&&r===e.generation){let n=URL.createObjectURL(t);e.urls.add(n);let r=h(`img`,`avatar-image`);r.src=n,r.alt=i.user.display_name,s.replaceChildren(r)}}t!==e.account?.session.user.id&&e.info?.capabilities.voice&&o.append(g(E===`fr`?`Appeler`:`Call`,async()=>{let n=await e.api.request(`/api/v1/direct-messages`,`POST`,{user_id:t});e.model.rooms.set(n.id,n),a.close(),await e.openRoom(n.id),await e.voice.join(n.id)})),t!==e.account?.session.user.id&&e.info?.capabilities.reports&&o.append(g(O(`reports`),()=>Se(e,`users`,t))),t!==e.account?.session.user.id&&o.append(g(O(`direct`),async()=>{let n=await e.api.request(`/api/v1/direct-messages`,`POST`,{user_id:t});e.model.rooms.set(n.id,n),a.close(),await e.openRoom(n.id)},`cta`))}async function be(e){if(!e.room)return;let t=e.room,i=await e.api.request(`/api/v1/rooms/`+n(t)),[a,o]=y(O(`roomInfo`));o.append(x(i.room.name,`profile`,i.room.kind===`direct`?void 0:`#`),h(`h2`,`details-name`,i.room.name));let s=h(`div`,`details-form`);o.append(s);let c=new Map;for(let[e,t,n]of[[`name`,O(`name`),i.room.name],[`topic`,O(`topic`),i.topic],[`description`,O(`description`),i.description],[`announcement`,O(`announcement`),i.announcement]]){let[r,a]=_(t,n);a.readOnly=!i.permissions.change_settings,c.set(e,a),s.append(r)}let l=h(`input`);l.type=`checkbox`,l.checked=i.read_only,l.disabled=!i.permissions.change_settings;let u=h(`label`,`toggle`);u.append(l,h(`span`,``,E===`fr`?`Lecture seule`:`Read-only`)),s.append(u);let d=h(`input`);d.type=`checkbox`,d.checked=!!i.voice,d.disabled=!i.permissions.change_settings;let f=h(`label`,`toggle`);f.append(d,h(`span`,``,E===`fr`?`Salon vocal`:`Voice channel`)),e.info?.capabilities.voice&&i.room.kind!==`direct`&&s.append(f),i.permissions.change_settings&&s.append(g(O(`save`),async()=>{await e.api.request(`/api/v1/rooms/`+n(t),`PATCH`,{operation_id:r(),expected_revision:i.revision,name:c.get(`name`).value,private:i.room.kind===`private`,topic:c.get(`topic`).value,description:c.get(`description`).value,announcement:c.get(`announcement`).value,read_only:l.checked,voice:e.info?.capabilities.voice?d.checked:void 0}),i=await e.api.request(`/api/v1/rooms/`+n(t)),e.model.rooms.set(t,i.room),e.roomPermissions.set(t,i.permissions),e.refresh()},`cta`)),o.append(g(i.room.read_state?.favorite?O(`unstar`):O(`star`),()=>e.favorite(i.room)));let p=h(`div`,`members`);o.append(h(`h3`,`details-section`,O(`members`)),p);let m=async()=>{let o=await e.api.request(`/api/v1/rooms/`+n(t)+`/members`);if(a.open){p.replaceChildren();for(let a of o.members){let s=h(`div`,`member-row`);if(s.append(x(a.user.username),g(a.user.display_name||a.user.username,()=>J(e,a.user.id)),h(`span`,`role-chip`,a.role)),i.permissions.role===`owner`&&a.user.id!==e.account?.session.user.id){let i=h(`select`,`pill-entry`);for(let e of[`member`,`moderator`,`owner`]){let t=h(`option`,``,e);t.value=e,i.append(t)}i.value=a.role,i.addEventListener(`change`,()=>void e.api.request(`/api/v1/rooms/`+n(t)+`/members/`+n(a.user.id)+`/role`,`PUT`,{operation_id:r(),expected_revision:o.revision,role:i.value}).then(m).catch(v)),s.append(i)}i.permissions.remove_member&&a.user.id!==e.account?.session.user.id&&s.append(g(O(`delete`),async()=>{await e.api.request(`/api/v1/rooms/`+n(t)+`/members/`+n(a.user.id),`DELETE`,{operation_id:r(),expected_revision:o.revision}),await m()},`destructive`)),p.append(s)}}};if(await m(),i.permissions.invite){let[r,i]=_(O(`username`));o.append(r,g(O(`add`),async()=>{let r=(await e.api.request(`/api/v1/users`)).find(e=>e.username===i.value);if(!r)throw Error(O(`noResults`));await e.api.request(`/api/v1/rooms/`+n(t)+`/members/`+n(r.id),`POST`,null),await m()}))}o.append(g(O(`leave`),()=>{let[o,s]=y(O(`leave`));s.append(h(`p`,``,i.room.name),g(O(`leave`),async()=>{await e.api.request(`/api/v1/rooms/`+n(t)+`/leave`,`POST`,{operation_id:r(),expected_revision:i.revision}),e.model.rooms.delete(t),e.refresh(),o.close(),a.close()},`destructive`))},`destructive`))}async function xe(e){let t=await e.api.request(`/api/v1/me/profile`),[i,a]=y(O(`settings`));i.classList.add(`sidebar-dialog`);let o=h(`nav`,`sidebar-categories`),s=h(`section`,`preferences-page`);a.replaceChildren(o,s);let c=(e,t)=>{o.append(g(e,async()=>{s.replaceChildren(h(`h2`,``,e)),await t()},`category`))},l=()=>{let a=new Map;for(let[e,n,r]of[[`username`,O(`username`),t.profile.user.username],[`display_name`,O(`name`),t.profile.user.display_name],[`bio`,O(`bio`),t.profile.bio],[`status_text`,O(`statusText`),t.profile.status_text]]){let[t,i]=_(n,r);a.set(e,i),s.append(t)}let o=h(`select`,`pill-entry`);for(let e of[`online`,`away`,`busy`,`offline`]){let t=h(`option`,``,e);t.value=e,o.append(t)}o.value=t.profile.status||`online`,s.append(o),s.append(g(O(`save`),async()=>{await e.api.request(`/api/v1/me`,`PATCH`,{operation_id:r(),expected_revision:t.profile.revision,username:a.get(`username`).value,display_name:a.get(`display_name`).value,bio:a.get(`bio`).value,status_text:a.get(`status_text`).value,status:o.value}),i.close(),await e.reconnect()},`cta`));let c=h(`input`,`pill-entry`);c.type=`file`,c.accept=`image/png,image/jpeg`,c.addEventListener(`change`,()=>{let a=c.files?.[0];a&&e.api.request(`/api/v1/me/avatar?operation_id=`+r()+`&expected_revision=`+n(t.profile.revision),`PUT`,a).then(()=>i.close()).catch(v)}),s.append(c,g(E===`fr`?`Supprimer la photo`:`Remove photo`,()=>e.api.request(`/api/v1/me/avatar?operation_id=`+r()+`&expected_revision=`+n(t.profile.revision),`DELETE`).then(()=>{i.close(),e.profiles.delete(t.profile.user.id),e.refresh()}),`destructive`))};c(O(`profile`),l),c(`App`,()=>{s.append(h(`p`,``,q.name+` `+q.version),h(`p`,`dim`,location.origin),g(E===`fr`?`Licences`:`Licenses`,()=>{let[e,t]=y(E===`fr`?`Licences`:`Licenses`);t.append(h(`pre`,`license-text`,ge)),e.classList.add(`licenses-dialog`)}))}),c(O(`appearance`),()=>{let n=h(`select`,`pill-entry`);for(let[e,t]of[[`fr`,`Français`],[`en`,`English`]]){let r=h(`option`,``,t);r.value=e,n.append(r)}n.value=E,n.addEventListener(`change`,()=>{D(n.value),i.close(),e.build()}),s.append(h(`h3`,``,O(`language`)),n);let a=h(`input`);a.type=`range`,a.min=`80`,a.max=`150`,a.value=localStorage.getItem(`rv-text-size`)||`100`,a.addEventListener(`input`,()=>{document.documentElement.style.setProperty(`--text-scale`,String(Number(a.value)/100)),localStorage.setItem(`rv-text-size`,a.value)}),s.append(h(`h3`,``,O(`size`)),a);let o=h(`label`,`toggle`),c=h(`input`);c.type=`checkbox`,c.checked=t.preferences.clock_24h,o.append(c,h(`span`,``,O(`clock`))),s.append(o,g(O(`save`),async()=>{await e.api.request(`/api/v1/me/preferences`,`PATCH`,{...t.preferences,operation_id:r(),expected_revision:t.preferences.revision,revision:void 0,language:n.value,clock_24h:c.checked}),e.preferences={...t.preferences,language:n.value,clock_24h:c.checked},i.close(),e.refresh()},`cta`))}),c(O(`notifications`),()=>{let n=h(`select`,`pill-entry`);for(let[e,t]of[[`default`,E===`fr`?`Messages directs et mentions`:`Direct messages and mentions`],[`all`,O(`all`)],[`mention`,O(`mention`)],[`nothing`,O(`nothing`)]]){let r=h(`option`,``,t);r.value=e,n.append(r)}n.value=t.preferences.desktop_notifications||`default`,s.append(n,g(O(`notificationsEnable`),async()=>{`Notification`in window&&await Notification.requestPermission()}),g(O(`save`),async()=>{await e.api.request(`/api/v1/me/preferences`,`PATCH`,{...t.preferences,operation_id:r(),expected_revision:t.preferences.revision,revision:void 0,desktop_notifications:n.value}),e.preferences={...t.preferences,desktop_notifications:n.value},i.close()},`cta`))}),c(O(`sessions`),async()=>{let t=await e.api.request(`/api/v1/me/sessions`);for(let r of t){let t=h(`div`,`preference-row`);t.append(h(`div`,``,r.label),h(`small`,`dim`,new Date(r.last_seen_at).toLocaleString(E))),r.current||t.append(g(O(`delete`),async()=>{await W(e),await e.api.request(`/api/v1/me/sessions/`+n(r.id),`DELETE`),t.remove()},`destructive`)),s.append(t)}}),e.info?.capabilities.voice&&c(E===`fr`?`Audio et vidéo`:`Audio and video`,()=>e.voice.settings(s)),c(O(`security`),()=>K(e,s));let u=await e.api.request(`/api/v1/me/permissions`);(u.manage_accounts||u.manage_instance)&&c(O(`admin`),()=>Ce(e,s)),s.append(h(`h2`,``,O(`profile`))),l()}var Y=(e,t)=>E===`fr`?t:e;function Se(e,t,i){let[a,o]=y(O(`reports`)),[s,c]=_(Y(`Reason`,`Motif`));c.maxLength=1e3,c.required=!0,o.append(s,g(O(`send`),async()=>{c.value.trim()&&(await e.api.request(`/api/v1/`+t+`/`+n(i)+`/report`,`POST`,{operation_id:r(),reason:c.value.trim()}),a.close())},`cta`))}async function X(e,t){let[n,r]=y(e);r.append(h(`p`,``,e+`?`),g(O(`cancel`),()=>n.close()),g(O(`verify`),async()=>{await t(),n.close()},`destructive`))}async function Ce(e,t){let i=await e.api.request(`/api/v1/admin/overview`),a=h(`div`,`stats`);for(let[e,t]of[[O(`people`),i.users.total],[O(`rooms`),i.rooms.total],[`Messages`,i.messages.total],[`Uploads`,i.uploads.count],[O(`reports`),i.reports.messages+i.reports.users]])a.append(h(`div`,`stat`,e+` · `+t));let o=h(`div`,`tabs`),s=h(`div`);t.append(h(`p`,`dim`,`RocketVibe `+i.server_version+` · PostgreSQL `+i.postgres_version),a,o,s);async function c(t=``){let i=await e.api.request(`/api/v1/admin/users`+(t?`?after=`+n(t):``));t||s.replaceChildren();for(let t of i.items){let i=h(`div`,`preference-row`);if(i.append(x(t.username),h(`span`,``,t.display_name||t.username),h(`span`,`dim`,t.disabled?Y(`Deactivated`,`Désactivé`):t.admin?Y(`Administrator`,`Administrateur`):O(`profile`))),t.id!==e.account?.session.user.id){let a=h(`div`,`admin-actions`),o=async i=>{await e.api.request(`/api/v1/admin/users/`+n(t.id),`PATCH`,{operation_id:r(),revision:t.revision,...i}),await c()};a.append(g(t.disabled?Y(`Activate`,`Activer`):Y(`Deactivate`,`Désactiver`),()=>X(t.username,()=>o({disabled:!t.disabled}))),g(t.admin?Y(`Remove administrator`,`Retirer le rôle administrateur`):Y(`Make administrator`,`Rendre administrateur`),()=>X(t.username,()=>o({admin:!t.admin}))),g(O(`delete`),()=>X(O(`delete`)+` `+t.username,async()=>{await e.api.request(`/api/v1/admin/users/`+n(t.id)+`/delete`,`POST`,{operation_id:r(),revision:t.revision}),await c()}),`destructive`)),i.append(a)}s.append(i)}i.next&&s.append(g(O(`older`),()=>c(i.next)))}async function l(t=``){let r=await e.api.request(`/api/v1/admin/rooms`+(t?`?after=`+n(t):``));t||s.replaceChildren();for(let t of r.items){let n=h(`div`,`preference-row`);n.append(h(`span`,``,t.name+` · `+t.member_count),h(`span`,`dim`,t.kind)),e.model.rooms.has(t.id)&&n.append(g(O(`roomInfo`),async()=>{await e.openRoom(t.id),await be(e)})),s.append(n)}r.next&&s.append(g(O(`older`),()=>l(r.next)))}async function u(t,i=``){i||s.replaceChildren();let a=`/api/v1/admin/reports/`+t;if(t===`messages`){let o=await e.api.request(a+(i?`?after=`+n(i):``));for(let i of o.items){let o=h(`div`,`file-card`);o.append(h(`strong`,``,i.room_name+` · `+i.author.username),h(`p`,`message-body`,i.deleted?Y(`Deleted`,`Supprimé`):i.text));for(let e of i.reports)o.append(h(`p`,`dim`,e.reason));o.append(g(Y(`Dismiss`,`Clore`),()=>X(O(`reports`),async()=>{await e.api.request(a+`/`+n(i.message_id)+`/dismiss`,`POST`,{operation_id:r()}),await u(t)})),g(O(`delete`),()=>X(O(`delete`),async()=>{await e.api.request(a+`/`+n(i.message_id)+`/delete`,`POST`,{operation_id:r()}),await u(t)}),`destructive`)),s.append(o)}o.next&&s.append(g(O(`older`),()=>u(t,o.next)))}else{let o=await e.api.request(a+(i?`?after=`+n(i):``));for(let i of o.items){let o=h(`div`,`file-card`);o.append(h(`strong`,``,i.user.display_name||i.user.username));for(let e of i.reports)o.append(h(`p`,`dim`,e.reason));o.append(g(Y(`Dismiss`,`Clore`),()=>X(O(`reports`),async()=>{await e.api.request(a+`/`+n(i.user.id)+`/dismiss`,`POST`,{operation_id:r()}),await u(t)}))),s.append(o)}o.next&&s.append(g(O(`older`),()=>u(t,o.next)))}s.children.length||s.append(h(`p`,`dim`,O(`noResults`)))}o.append(g(O(`people`),()=>c()),g(O(`rooms`),()=>l()),g(O(`reports`),()=>u(`messages`)),g(O(`profile`),()=>u(`users`))),await c()}async function we(n){if(!n.account||!n.info?.capabilities.session_rotation)return;let a=n.account.key,o=n.generation,s=a+`:renew`,c=()=>o===n.generation&&a===n.account?.key,d=async()=>{let o=await l(`accounts`,a);if(!o||!c())return;n.account=o,n.api.token=o.session.token;let d=await l(`operations`,s);if(!d&&Date.parse(o.session.expires_at)-Date.now()>36e5)return;let f=new t,p;if(d){f.token=d.next_token;try{let e=await f.request(`/api/v1/me`),t=(await f.request(`/api/v1/me/sessions`)).filter(e=>e.current);if(e.id!==o.session.user.id||t.length!==1||!Number.isFinite(Date.parse(t[0].expires_at)))throw Error(`Invalid recovered session`);p={token:d.next_token,user:e,expires_at:t[0].expires_at}}catch(t){if(!(t instanceof e&&t.status===401&&t.code===`session_rejected`))throw t}}else d={operation_id:r(),next_token:i()},await u(`operations`,s,d);if(!c())return;if(!p){f.token=o.session.token;try{p=await f.request(`/api/v1/auth/renew`,`POST`,d)}catch(t){throw t instanceof e&&t.status===401&&t.code===`session_rejected`&&c()&&(await u(`operations`,s),await n.expire()),t}}if(p.token!==d.next_token||p.user.id!==o.session.user.id||!Number.isFinite(Date.parse(p.expires_at)))throw Error(`Invalid renewed session`);let m=await f.request(`/.well-known/rocketvibe`,`GET`,void 0,!0);if(m.instance_id!==o.instance||m.data_epoch!==o.epoch)throw Error(`Server identity changed`);c()&&(n.account={...o,session:p},await u(`accounts`,a,n.account),n.api.token=p.token,await u(`operations`,s),n.channel.postMessage({rotated:a}))};navigator.locks?await navigator.locks.request(`rv-session:`+a,d):await d()}var Te=[[.08,.12,5,1,1,1,.5],[.83,.18,6,1,.83,.31,.7],[.16,.33,4.5,.2,.88,.82,.6],[.9,.43,5.5,1,1,1,.4],[.07,.62,5,.65,.55,.98,.55],[.77,.74,4.5,.2,.88,.82,.4],[.3,.85,4,1,1,1,.35],[.62,.08,4.5,.65,.55,.98,.5],[.4,.22,3.5,1,1,1,.35],[.95,.88,5,1,.83,.31,.6],[.22,.95,4.5,.65,.55,.98,.5],[.68,.55,3.5,1,1,1,.3]];function Ee(){let e=h(`div`,`stars`);for(let[t,n,r,i,a,o,s]of Te){let c=document.createElementNS(`http://www.w3.org/2000/svg`,`svg`);c.classList.add(`sparkle`),c.setAttribute(`viewBox`,`-1 -1 2 2`),c.style.left=t*100+`%`,c.style.top=n*100+`%`,c.style.width=c.style.height=2*r*1.4+`px`;let l=document.createElementNS(c.namespaceURI,`path`);l.setAttribute(`d`,`M0 -1 C.18 -.18 .18 -.18 1 0 C.18 .18 .18 .18 0 1 C-.18 .18 -.18 .18 -1 0 C-.18 -.18 -.18 -.18 0 -1 Z`),l.setAttribute(`fill`,`rgba(`+[i*255,a*255,o*255,s].join(`,`)+`)`),c.append(l),e.append(c)}return e}function De(e,t){let n=e.lastIndexOf(`
`,t-1)+1,r=e.slice(n,t),i=/^(\s*)([-*+]|[0-9]+\.) (.*)$/.exec(r);if(!i)return;if(!i[3])return{text:e.slice(0,n)+e.slice(t),cursor:n};let a=/^[0-9]/.test(i[2])?String(Number.parseInt(i[2],10)+1)+`.`:i[2],o=`
`+i[1]+a+` `;return{text:e.slice(0,t)+o+e.slice(t),cursor:t+o.length}}function Oe(e){let t=[],n=(r,i,a=0)=>{if(!(a>32))for(let o=r;o<i;o++){let r=e[o],s=r===`*`&&e[o+1]===`*`?2:1;if(!"* _ ~ `".split(` `).includes(r)||o+s>=i||/\s/.test(e[o+s]))continue;let c=r.repeat(s),l=o+s+1;for(;l+s<=i&&(e.slice(l,l+s)!==c||/\s/.test(e[l-1]));)l++;l+s>i||(t.push({start:o,end:o+s,style:`marker`},{start:o+s,end:l,style:r===`*`?`bold`:r===`_`?`italic`:r===`~`?`strike`:`code`},{start:l,end:l+s,style:`marker`}),r!=="`"&&n(o+s,l,a+1),o=l+s-1)}},r=0,i=!1;for(let a of e.split(`
`)){let e=r+a.length;if(a.trimStart().startsWith("```"))t.push({start:r,end:e,style:`marker`}),i=!i;else if(i)t.push({start:r,end:e,style:`codeblock`});else{let i=/^(# |> |[-*] |\d+\. )/.exec(a)?.[0],o=r;i&&(o+=i.length,t.push({start:r,end:o,style:`marker`}),i===`# `&&t.push({start:o,end:e,style:`heading`}),i===`> `&&t.push({start:r,end:e,style:`quote`})),n(o,e)}r=e+1}return t}function Z(e){if(e instanceof HTMLElement&&e.classList.contains(`rich-composer`)&&e.textContent===``)return``;if(e.nodeType===Node.TEXT_NODE)return e.textContent||``;if(e instanceof HTMLBRElement)return e.hasAttribute(`data-sentinel`)?``:`
`;let t=``;for(let n of e.childNodes)n instanceof HTMLElement&&[`DIV`,`P`].includes(n.tagName)&&t&&!t.endsWith(`
`)&&(t+=`
`),t+=Z(n);return t}function Q(){let e=h(`div`,`composer-input rich-composer`);e.contentEditable=`true`,e.role=`textbox`,e.setAttribute(`aria-multiline`,`true`),e.spellcheck=!0;let t=``,n=0,r=0,i=!1,a=!1,o=-1,s=[],c=[],l=e=>t.slice(0,e).split(`
`).length-1,u=()=>{let t=getSelection();if(!t?.rangeCount)return;let i=t.getRangeAt(0);if(!e.contains(i.startContainer)||!e.contains(i.endContainer))return;let a=document.createRange();a.selectNodeContents(e),a.setEnd(i.startContainer,i.startOffset),n=Z(a.cloneContents()).length,a.setEnd(i.endContainer,i.endOffset),r=Z(a.cloneContents()).length},d=(i,a)=>{if(n=Math.max(0,Math.min(i,t.length)),r=Math.max(n,Math.min(a,t.length)),document.activeElement!==e)return;let o=t=>{let n=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),r=n.nextNode(),i=t;for(;r;){let e=r.textContent?.length||0;if(i<=e)return[r,i];i-=e,r=n.nextNode()}return[e,e.childNodes.length]},s=document.createRange();s.setStart(...o(n)),s.setEnd(...o(r)),getSelection()?.removeAllRanges(),getSelection()?.addRange(s)},f=()=>{let i=e.scrollTop,a=document.createDocumentFragment(),s=Oe(t),c=[...new Set([0,t.length,...s.flatMap(e=>[e.start,e.end])])].sort((e,t)=>e-t),u=l(r);o=u;for(let e=0;e<c.length-1;e++){let n=c[e],r=c[e+1],i=s.filter(e=>e.start<=n&&e.end>=r).map(e=>e.style);if(!i.length){a.append(document.createTextNode(t.slice(n,r)));continue}let o=h(`span`,i.map(e=>`draft-`+e).join(` `),t.slice(n,r)),d=t.slice(n,r),f=/^(?:\x60\x60\x60|[-*] |\d+\. )/.test(d);i.includes(`marker`)&&!f&&l(n)!==u&&(o.hidden=!0),a.append(o)}if(!t||t.endsWith(`
`)){let e=h(`br`);e.setAttribute(`data-sentinel`,``),a.append(e)}e.replaceChildren(a),d(n,r),e.scrollTop=i},p=()=>{u(),s.push({text:t,start:n,end:r}),s.length>100&&s.shift(),c.length=0},m=()=>e.dispatchEvent(new InputEvent(`input`,{bubbles:!0,inputType:`insertText`})),g=(e,i,a,o=`end`)=>{p(),t=t.slice(0,i)+e+t.slice(a);let s=o===`start`||o===`select`?i:i+e.length,c=o===`select`?i+e.length:s;n=s,r=c,f(),m()},_=e=>{u();let i=e?s:c,a=e?c:s,o=i.pop();o&&(a.push({text:t,start:n,end:r}),t=o.text,n=o.start,r=o.end,f(),m())};Object.defineProperties(e,{value:{get:()=>Z(e),set:e=>{t=e,n=r=t.length,s.length=c.length=0,f()}},selectionStart:{get:()=>(u(),n)},selectionEnd:{get:()=>(u(),r)},disabled:{get:()=>i,set:t=>{i=t,e.contentEditable=String(!t),e.setAttribute(`aria-disabled`,String(t))}},placeholder:{get:()=>e.dataset.placeholder||``,set:t=>{e.dataset.placeholder=t}}}),e.setSelectionRange=(e,t)=>{d(e,t),f()},e.setRangeText=(e,t,n,r)=>g(e,t,n,r),e.addEventListener(`beforeinput`,e=>{i?e.preventDefault():e.inputType===`insertParagraph`||e.inputType===`insertLineBreak`?(e.preventDefault(),u(),g(`
`,n,r)):e.inputType===`historyUndo`||e.inputType===`historyRedo`?(e.preventDefault(),_(e.inputType===`historyUndo`)):a||p()}),e.addEventListener(`keydown`,e=>{(e.ctrlKey||e.metaKey)&&e.key.toLowerCase()===`z`&&(e.preventDefault(),_(!e.shiftKey))}),e.addEventListener(`paste`,e=>{e.clipboardData?.files.length||(e.preventDefault(),u(),g(e.clipboardData?.getData(`text/plain`)||``,n,r))}),e.addEventListener(`compositionstart`,()=>{p(),a=!0}),e.addEventListener(`compositionend`,()=>{a=!1,t=Z(e),u(),f()}),e.addEventListener(`input`,()=>{t=Z(e),u(),a||f()});let v;return e.addEventListener(`focus`,()=>{d(n,r),v?.abort(),v=new AbortController,document.addEventListener(`selectionchange`,()=>{u(),!a&&l(r)!==o&&f()},{signal:v.signal})}),e.addEventListener(`blur`,()=>v?.abort()),f(),e}async function ke(e,t){return(await l(`media`,e+`:`+t))?.blob}async function Ae(e,t,n,r){await u(`media`,e+`:`+t,{account:e,room:r,path:t,blob:n,at:Date.now()});let i=(await d(`media`)).filter(t=>t.account===e).sort((e,t)=>e.at-t.at),a=i.reduce((e,t)=>e+t.blob.size,0);for(let t of i){if(a<=262144e3)break;await u(`media`,e+`:`+t.path),a-=t.blob.size}}function $(e=`header`){return h(`span`,`brand brand-`+e,`rocket-vibe`)}var je=class{api=new t;model=new o;account;info;room;root;firstUnread;newPill=g(``,()=>{this.timeline.querySelector(`.new-marker`)?.scrollIntoView({block:`center`}),this.newPill.hidden=!0},`new-pill`);threadOlder=!1;threadLoading=!1;threadRead=new Map;jump=g(`↓`,()=>{this.timeline.scrollTop=this.timeline.scrollHeight},`jump-latest`);generation=0;socket;timer;live;liveTimer;flushing=!1;pending=[];staged=[];jobs=[];uploading=!1;profiles=new Map;assetURLs=new Map;assetRooms=new Map;roomURLs=new Map;emojis=new Map;emojiRevision=``;preferences;roomPermissions=new Map;uploadProgress=new Map;typingAt=0;notifications=new Map;completion=h(`div`,`completion`);urls=new Set;connection=`offline`;quote;recorder;main=h(`main`,`shell`);sidebar=h(`aside`,`sidebar`);rooms=h(`div`,`rooms`);roomPane=h(`section`,`room-content`);header=h(`header`,`headerbar`);timeline=h(`div`,`timeline`);composer=Q();pendingRows=h(`div`,`pending-rows`);typing=h(`div`,`typing`);strip=h(`div`,`upload-strip`);replyBar=h(`div`,`reply-bar`);threadPane=h(`aside`,`thread-pane`);threadTimeline=h(`div`,`timeline`);threadComposer=Q();status=h(`span`,`status-dot offline`);comet=h(`div`,`comet`);hasOlder=new Map;loading=!1;voice=new me(this);channel=new BroadcastChannel(`rocket-vibe-web`);mount=document.querySelector(`#app`);constructor(){this.api.expired=()=>{this.expire()},this.channel.onmessage=e=>{let t=e.data;t&&typeof t==`object`&&`rotated`in t&&t.rotated===this.account?.key?this.reconnect():t&&typeof t==`object`&&`purged`in t&&t.purged===this.account?.key?this.stop(!0):this.account&&this.loadPending().then(()=>{t&&typeof t==`object`&&`outbox`in t&&this.flush()})},setInterval(()=>{this.account&&new Date(this.account.session.expires_at).getTime()-Date.now()<36e5&&this.reconnect()},6e4),window.addEventListener(`online`,()=>void this.reconnect()),window.addEventListener(`offline`,()=>this.setConnection(`offline`)),window.addEventListener(`focus`,()=>void this.markRead()),window.addEventListener(`popstate`,()=>{let e=location.pathname.startsWith(`/room/`)?decodeURIComponent(location.pathname.slice(6)):void 0;e&&this.model.rooms.has(e)&&this.openRoom(e,!1)}),document.addEventListener(`keydown`,e=>{!e.defaultPrevented&&this.account&&((e.ctrlKey||e.metaKey)&&e.key===`k`&&(e.preventDefault(),_e(this)),e.key===`Escape`&&this.root&&this.closeThread())})}async init(){D(E);let e=await d(`accounts`),t=localStorage.getItem(`rv-active`),n=e.find(e=>e.key===t)||e[0];if(n){for(let t of e)t.key!==n.key&&await p(t.key);await this.activate(n)}else this.login()}login(){this.mount.replaceChildren();let e=h(`div`,`login-page`),t=Ee(),n=h(`form`,`login-form`),i=h(`div`,`hero`);i.append(h(`div`,`unicorn-hero`,`🦄`));let a=h(`div`,`rainbow`);for(let e of[`pink`,`yellow`,`cyan`,`violet`])a.append(h(`i`,`rainbow-bar rainbow-`+e));i.append(a,$(`hero`),h(`div`,`slogan`,O(`slogan`)));let o=_(O(`server`),location.origin)[0],s=o.querySelector(`input`);s.readOnly=!0;let[c,l]=_(O(`username`));l.autocomplete=`username`,l.required=!0;let[u,d]=_(O(`password`),``,`password`);d.autocomplete=`current-password`,d.required=!0;let f=h(`div`,`login-error`);f.setAttribute(`role`,`alert`);let p=h(`button`,`cta`,O(`login`));p.type=`submit`;let m=g(E===`fr`?`English`:`Français`,()=>{D(E===`fr`?`en`:`fr`),this.login()}),y=`login`,b=h(`div`),x=e=>{if(y=e,b.replaceChildren(),d.autocomplete=e===`signup`?`new-password`:`current-password`,e!==`login`){let[t]=_(O(e===`signup`?`invitation`:`recoveryCode`));b.append(t,g(O(`login`),()=>x(`login`))),e===`recovery`&&b.append(g(E===`fr`?`Recevoir un code par email`:`Email me a recovery code`,async()=>{let e=await this.api.request(`/.well-known/rocketvibe`,`GET`,void 0,!0);e.capabilities.email_recovery&&(await this.api.request(`/api/v1/auth/recovery/email/start`,`POST`,{operation_id:r(),username:l.value,instance_id:e.instance_id,data_epoch:e.data_epoch},!0),v(E===`fr`?`Si une adresse vérifiée est disponible, le code vous sera envoyé.`:`If a verified address is available, a recovery code will be sent.`))}))}p.textContent=O(e===`signup`?`signup`:e===`recovery`?`recovery`:`login`)},S=h(`div`,`login-links`);S.append(g(O(`signup`),()=>x(`signup`)),g(O(`recovery`),()=>x(`recovery`))),n.append(i,o,c,u,b,f,p,S,m),this.account&&n.append(g(O(`cancel`),()=>this.build())),n.addEventListener(`submit`,e=>{e.preventDefault(),p.disabled=!0,f.textContent=``,(async()=>{let e=await this.api.request(`/.well-known/rocketvibe`,`GET`,void 0,!0);if(!e.protocol_versions.includes(1))throw Error(`Unsupported protocol`);if(y===`login`){let t=await this.api.request(`/api/v1/auth/start`,`POST`,{username:l.value,password:d.value},!0);d.value=``,t.kind===`challenge`?this.challenge(t.challenge,e):await this.accept(t.session,e)}else{let t=b.querySelector(`input`).value,n=await this.api.request(y===`signup`?`/api/v1/auth/invitations/accept`:`/api/v1/auth/recovery`,`POST`,y===`signup`?{username:l.value,password:d.value,token:t}:{username:l.value,token:t,new_password:d.value},!0);d.value=``,await this.accept(n,e)}})().catch(e=>{f.textContent=e instanceof Error?e.message:String(e),p.disabled=!1})}),e.append(t,n),this.mount.append(e),l.focus()}challenge(e,t){let[n,a]=y(O(`code`)),o=h(`form`),s=h(`select`,`pill-entry`);for(let t of e.methods){let e=h(`option`,``,O(t));e.value=t,s.append(e)}let[c,d]=_(O(`code`));d.autocomplete=`one-time-code`;let f=h(`div`,`login-error`),p=h(`button`,`cta`,O(`verify`));p.type=`submit`,o.append(s,c,f,p),a.append(o),n.addEventListener(`close`,()=>{this.account||this.login()}),e.methods.includes(`email`)&&a.append(g(`Email`,async()=>{await this.api.request(`/api/v1/auth/factors/email/start`,`POST`,{challenge_id:e.challenge_id,operation_id:r(),delivery_id:i()},!0)})),o.addEventListener(`submit`,a=>{a.preventDefault(),p.disabled=!0,(async()=>{let a=`factor:`+e.challenge_id,o=await l(`operations`,a);o||(o={operation_id:r(),next_token:i()},await u(`operations`,a,o));let c=await this.api.request(`/api/v1/auth/factors/verify`,`POST`,{...o,challenge_id:e.challenge_id,method:s.value,code:d.value},!0);d.value=``,await this.accept(c,t),await u(`operations`,a),n.close()})().catch(e=>{f.textContent=e instanceof Error?e.message:String(e),p.disabled=!1})}),d.focus()}async accept(e,t){let n={key:t.instance_id+`:`+t.data_epoch+`:`+e.user.id,session:e,instance:t.instance_id,epoch:t.data_epoch};for(let e of await d(`accounts`))e.key!==n.key&&await p(e.key);await u(`accounts`,n.key,n),this.info=t,await this.activate(n)}async activate(e){await this.stop(),this.account=e,this.api.token=e.session.token,localStorage.setItem(`rv-active`,e.key);let t=await l(`cache`,e.key);t&&this.model.replace(t),this.build(),await this.loadPending(),await this.loadUploads(),this.reconnect()}async stop(e=!1){this.generation++,await this.voice.leave(!e),clearTimeout(this.timer),clearTimeout(this.liveTimer),this.socket&&=(this.socket.onclose=null,this.socket.close(),void 0),this.recorder?.state===`recording`&&this.recorder.stop(),this.recorder?.stream.getTracks().forEach(e=>e.stop()),this.recorder=void 0;for(let e of this.notifications.values())e.close();this.notifications.clear(),document.querySelectorAll(`.actions-menu`).forEach(e=>e.remove());for(let e of this.urls)URL.revokeObjectURL(e);this.urls.clear(),this.roomURLs.clear(),this.assetRooms.clear(),this.profiles.clear(),this.assetURLs.clear(),this.emojis.clear(),this.emojiRevision=``,this.model=new o,this.root=void 0,this.room=void 0,this.quote=void 0,this.live=void 0,this.pending=[],this.staged=[],this.jobs=[],this.roomPermissions.clear(),this.uploadProgress.clear(),this.hasOlder.clear(),m(this.main);for(let e of document.querySelectorAll(`dialog`))e.close();e&&(this.account=void 0,this.api.token=``,localStorage.removeItem(`rv-active`),history.replaceState(null,``,`/`),this.login())}async expire(){let e=this.account?.key;if(!e)return;let t=await l(`accounts`,e);t&&t.session.token!==this.api.token?(this.account=t,this.api.token=t.session.token,this.reconnect()):await l(`operations`,e+`:renew`)?(this.setConnection(`offline`),this.reconnect()):(await this.stop(!0),await p(e),this.channel.postMessage({purged:e}),v(`Session expired`))}async logout(){let t=this.account?.key;if(t){try{await this.api.request(`/api/v1/auth/logout`,`POST`)}catch(t){t instanceof e&&t.status===401||v(O(`offline`))}await this.stop(!0),await p(t),this.channel.postMessage({purged:t})}}setConnection(e){this.connection=e,this.status.className=`status-dot `+e,this.status.title=O(e===`online`?`online`:e===`connecting`?`connecting`:`offline`),this.comet.classList.toggle(`active`,e===`connecting`)}async reconnect(){if(!this.account)return;clearTimeout(this.timer);let t=++this.generation;this.socket?.close(),this.setConnection(`connecting`);try{let r=await this.api.request(`/.well-known/rocketvibe`);if(t!==this.generation)return;if(r.instance_id!==this.account.instance||r.data_epoch!==this.account.epoch){await this.expire();return}let i=new Map([...this.model.rooms].map(([e,t])=>[e,t.read_state?.membership_version]));if(this.info=r,await we(this),t!==this.generation)return;if(this.loadEmojis().catch(()=>{}),this.preferences=(await this.api.request(`/api/v1/me/profile`)).preferences,!this.model.cursor)this.model.replace(await this.api.snapshot(r));else try{let e=!0;for(;e;){let r=await this.api.request(`/api/v1/sync/changes?cursor=`+n(this.model.cursor));if(t!==this.generation)return;this.model.batch(r),e=r.has_more}}catch(t){if(t instanceof e&&t.status===409)this.model.replace(await this.api.snapshot(r));else throw t}if(t!==this.generation)return;for(let[e,t]of i)(!this.model.rooms.has(e)||this.model.rooms.get(e)?.read_state?.membership_version!==t)&&await this.forgetRoom(e);if(await this.loadPending(),await this.loadUploads(),await u(`cache`,this.account.key,this.model.snapshot()),this.refresh(),this.room)await this.refreshPermissions(this.room);else if(location.pathname.startsWith(`/room/`)){let e=decodeURIComponent(location.pathname.slice(6));this.model.rooms.has(e)&&await this.openRoom(e,!1)}let a=await this.api.request(`/api/v1/sync/ticket`,`POST`,null);if(t!==this.generation)return;let o=new URL(`/api/v1/sync/socket`,location.origin);o.protocol=location.protocol===`https:`?`wss:`:`ws:`,o.searchParams.set(`ticket`,a.ticket),o.searchParams.set(`cursor`,this.model.cursor),o.searchParams.set(`live`,`true`);let s=new WebSocket(o);this.socket=s;let c=Promise.resolve();s.onopen=()=>{t===this.generation&&(this.setConnection(`online`),this.flush(),B(this))},s.onmessage=e=>{c=c.then(async()=>{if(t!==this.generation)return;let n=JSON.parse(String(e.data));if(`type`in n){this.live=n.data,this.voice.observe(n.data),clearTimeout(this.liveTimer),this.liveTimer=setTimeout(()=>{this.live=void 0,this.renderTyping()},n.data.ttl_ms),this.renderTyping(),this.observeProfiles(n.data),n.data.emoji_catalog_revision!==this.emojiRevision&&this.loadEmojis().catch(()=>{}),this.renderRooms();return}if(!Array.isArray(n.changes)||n.changes.length>1e4)throw Error(`Invalid sync`);let r=this.room?this.model.rooms.get(this.room)?.revision:void 0,i=new Map([...this.model.rooms].map(([e,t])=>[e,t.read_state?.membership_version])),a=n.changes.flatMap(e=>e.type===`message_upsert`&&!this.model.messages.has(e.data.id)?[e.data]:[]);if(this.model.batch(n),this.room&&r!==this.model.rooms.get(this.room)?.revision){let e=this.roomPermissions.get(this.room);e&&this.roomPermissions.set(this.room,{...e,send:!1,upload:!1}),this.refreshPermissions(this.room).catch(()=>{})}this.notify(a);for(let e of n.changes)e.type===`room_removed`&&(this.notifications.get(e.data.room_id)?.close(),await this.forgetRoom(e.data.room_id),this.room===e.data.room_id&&(this.composer.value=``,this.staged=[]));for(let[e,t]of i)this.model.rooms.has(e)&&this.model.rooms.get(e)?.read_state?.membership_version!==t&&(await this.forgetRoom(e),this.room===e&&(this.composer.value=``,this.staged=[]));await this.loadPending(),await this.loadUploads(),await u(`cache`,this.account.key,this.model.snapshot()),t===this.generation&&this.refresh()}).catch(e=>{v(e),s.close()})},s.onclose=()=>{t===this.generation&&(this.setConnection(`offline`),this.timer=setTimeout(()=>void this.reconnect(),3e3))}}catch(n){if(t!==this.generation)return;this.setConnection(`offline`),n instanceof TypeError||v(n),this.timer=setTimeout(()=>void this.reconnect(),Math.max(3e3,n instanceof e?n.retryAfter*1e3:3e3))}}build(){if(!this.account){this.login();return}this.mount.replaceChildren(),this.main=h(`main`,`shell`),this.sidebar=h(`aside`,`sidebar`),this.rooms=h(`div`,`rooms`);let e=h(`header`,`sidebar-header headerbar`);this.status=h(`span`,`status-dot `+this.connection);let t=g(``,()=>this.reconnect());t.append(this.status);let r=h(`div`,`brand-wrap`);r.append(h(`span`,`unicorn-header`,`🦄`),$()),e.append(t,r,T(`plus`,O(`new`),()=>_e(this)),T(`logout`,O(`logout`),()=>this.logout()));let i=g(``,()=>xe(this),`account`);i.setAttribute(`aria-label`,O(`settings`));let a=x(this.account.session.user.username,`message`);this.avatar(this.account.session.user,a),i.append(a);let o=h(`div`);o.append(h(`div`,`account-name`,this.account.session.user.display_name||this.account.session.user.username),h(`div`,`account-host`,location.host)),i.append(o,w(`settings`)),this.sidebar.append(e,this.rooms,i),this.roomPane=h(`section`,`room-content`),this.header=h(`header`,`headerbar room-header`),this.timeline=h(`div`,`timeline`),this.timeline.setAttribute(`aria-label`,O(`message`)),this.timeline.tabIndex=0,this.pendingRows=h(`div`,`pending-rows`),this.timeline.addEventListener(`scroll`,()=>{this.jump.hidden=this.timeline.scrollHeight-this.timeline.scrollTop-this.timeline.clientHeight<100;let e=this.timeline.querySelector(`.new-marker`);e&&(this.newPill.hidden=e.getBoundingClientRect().bottom>=this.timeline.getBoundingClientRect().top),this.timeline.scrollTop<100&&this.older(),this.markRead()}),this.comet=h(`div`,`comet`),this.typing=h(`div`,`typing`),this.strip=h(`div`,`upload-strip`),this.replyBar=h(`div`,`reply-bar`),this.replyBar.hidden=!0,this.composer=Q();for(let e of this.roomPane.querySelectorAll(`.composer,.format-bar,.upload-strip`))e.hidden=this.composer.disabled;this.composer.placeholder=O(`message`),this.composer.setAttribute(`aria-label`,O(`message`)),this.roomPane.addEventListener(`dragover`,e=>{e.dataTransfer?.types.includes(`Files`)&&(e.preventDefault(),this.roomPane.classList.add(`drag-active`))}),this.roomPane.addEventListener(`dragleave`,()=>this.roomPane.classList.remove(`drag-active`)),this.roomPane.addEventListener(`drop`,e=>{e.preventDefault(),this.roomPane.classList.remove(`drag-active`),e.dataTransfer&&this.stage([...e.dataTransfer.files]).catch(v)}),this.composer.addEventListener(`paste`,e=>{let t=[...e.clipboardData?.files||[]];t.length&&(e.preventDefault(),this.stage(t).catch(v))}),this.composer.addEventListener(`input`,()=>{this.saveDraft(),this.setTyping(!0),this.complete().catch(v),this.composer.style.height=`auto`,this.composer.style.height=Math.min(180,this.composer.scrollHeight)+`px`}),this.composer.addEventListener(`keydown`,e=>{if(e.key===`Enter`&&e.shiftKey&&!e.isComposing&&this.composer.selectionStart===this.composer.selectionEnd){let t=De(this.composer.value,this.composer.selectionStart);if(t){e.preventDefault(),this.composer.value=t.text,this.composer.setSelectionRange(t.cursor,t.cursor),this.saveDraft();return}}if((e.ctrlKey||e.metaKey)&&[`b`,`i`,`k`,`e`].includes(e.key.toLowerCase())){e.preventDefault(),e.stopPropagation();let t=e.key.toLowerCase();t===`b`?this.format(`**`,`**`):t===`i`?this.format(`_`,`_`):t===`k`?this.formatLink():this.format(e.shiftKey?"```\n":"`",e.shiftKey?"\n```":"`");return}if(e.key===`ArrowUp`&&!this.composer.value&&this.room){let t=this.model.timeline(this.room).findLast(e=>e.author.id===this.account?.session.user.id&&!e.system);if(t){e.preventDefault(),this.api.request(`/api/v1/messages/`+n(t.id)+`/permissions`).then(e=>{e.edit&&this.editMessage(t,e.revision)}).catch(v);return}}let t=[...this.completion.querySelectorAll(`button`)];if(t.length&&[`ArrowDown`,`ArrowUp`,`Tab`,`Enter`,`Escape`].includes(e.key)){if(e.preventDefault(),e.key===`Escape`){this.completion.replaceChildren();return}let n=t.findIndex(e=>e.classList.contains(`chosen`));if(e.key===`Enter`||e.key===`Tab`){t[Math.max(0,n)].click();return}let r=(n+(e.key===`ArrowDown`?1:-1)+t.length)%t.length;t.forEach((e,t)=>e.classList.toggle(`chosen`,t===r))}else e.key===`Enter`&&!e.shiftKey&&!e.isComposing&&(e.preventDefault(),this.send().catch(v))});let s=h(`div`,`composer-pill`);s.append(T(`attach`,O(`attach`),()=>this.pickFile(),`attach-button`),this.composer,T(`smile`,O(`react`),()=>this.emojiPicker(),`attach-button`),T(`mic`,O(`voice`),()=>this.record(),`attach-button`));let c=h(`div`,`composer`);c.append(s,T(`send`,O(`send`),()=>this.send(),`send`));let l=h(`div`,`format-bar`),u=(e,t,n,r=``)=>{let i=g(e,n,`format-button `+r);i.title=t,i.setAttribute(`aria-label`,t),l.append(i)};u(`B`,`Bold`,()=>this.format(`**`,`**`),`bold`),u(`I`,`Italic`,()=>this.format(`_`,`_`),`italic`),u(`S`,`Strike`,()=>this.format(`~`,`~`),`strike`),u(`H`,`Heading`,()=>this.formatLines(`# `)),l.append(T(`attach`,`Link`,()=>this.formatLink(),`format-button`)),u(`</>`,`Inline code`,()=>this.format("`","`")),u(`{ }`,`Code block`,()=>this.format("```\n","\n```")),u(`“`,`Quote`,()=>this.formatLines(`> `)),u(`☷`,`Bullets`,()=>this.formatLines(`- `)),u(`≡`,`Numbers`,()=>this.formatLines(`numbered`)),this.completion=h(`div`,`completion`),this.completion.hidden=!1,this.roomPane.append(this.comet,this.header,this.timeline,this.pendingRows,this.strip,this.typing,this.replyBar,this.completion,c,l,this.jump,this.newPill),this.jump.hidden=!0,this.newPill.hidden=!0,this.jump.setAttribute(`aria-label`,E===`fr`?`Derniers messages`:`Latest messages`),this.threadPane=h(`aside`,`thread-pane`),this.threadPane.hidden=!0,this.main.append(this.sidebar,this.roomPane,this.threadPane),this.mount.append(this.main),this.refresh();let d=location.pathname.startsWith(`/room/`)?decodeURIComponent(location.pathname.slice(6)):void 0;d&&this.model.rooms.has(d)&&this.openRoom(d,!1)}refresh(){this.renderRooms(),this.room&&!this.model.rooms.has(this.room)&&(this.room=void 0,this.root=void 0,this.threadPane.hidden=!0,m(this.timeline),this.timeline.replaceChildren(),this.composer.value=``,this.quote=void 0),this.room&&this.model.rooms.get(this.room)?.encrypted&&this.timeline.replaceChildren(h(`div`,`e2e-banner`,O(`encryptedHint`))),this.voice.current&&(!this.model.rooms.has(this.voice.current)||this.model.rooms.get(this.voice.current)?.encrypted)&&this.voice.leave(),this.renderHeader(),this.renderTimeline(),this.renderPending(),this.renderTyping(),this.root&&this.renderThread()}renderRooms(){this.rooms.replaceChildren();let e=[...this.model.rooms.values()],t=e=>this.model.timeline(e.id).at(-1);e.sort((e,n)=>(t(n)?.created_at||``).localeCompare(t(e)?.created_at||``));let n=e=>Number(e.read_state?.unread_roots||0)+Number(e.read_state?.unread_replies||0),r=[[O(`unread`),e.filter(e=>n(e)>0)],[O(`favorites`),e.filter(e=>e.read_state?.favorite&&n(e)===0)],[O(`channels`),e.filter(e=>e.kind!==`direct`&&!e.read_state?.favorite&&n(e)===0)],[O(`direct`),e.filter(e=>e.kind===`direct`&&!e.read_state?.favorite&&n(e)===0)]],i=0;for(let t of e)i+=n(t);document.title=(i?`(`+i+`) `:``)+`rocket-vibe`;for(let[e,i]of r){if(!i.length)continue;let r=localStorage.getItem(`rv-fold:`+e)===`true`,a=g((r?`› `:`⌄ `)+e+(r?` `+i.length:``),()=>{localStorage.setItem(`rv-fold:`+e,String(!r)),this.renderRooms()},`section-header`);if(this.rooms.append(a),!r)for(let e of i){let r=t(e),i=g(``,()=>this.openRoom(e.id),`room-row`+(e.id===this.room?` selected`:``));if(i.dataset.room=e.id,i.append(x(e.name,`room`,e.encrypted?`🔒`:e.kind===`direct`?void 0:`#`)),e.kind===`direct`){let t=this.live?.rooms.find(t=>t.room_id===e.id)?.direct_peer;t&&this.avatar(t,i.querySelector(`.tile`));let n=this.live?.presence.find(n=>t?n.user.id===t.id:n.user.username===e.name||n.user.display_name===e.name);if(n){let e=h(`span`,`presence-dot `+n.status);e.title=n.status,i.querySelector(`.tile`)?.append(e)}}let a=h(`div`,`room-column`),o=h(`div`,`room-top`);o.append(h(`span`,`room-name`+(n(e)>0?` unread`:``),e.name)),r&&o.append(h(`span`,`room-time`,new Date(r.created_at).toLocaleTimeString(E,{hour:`2-digit`,minute:`2-digit`,hour12:this.preferences?.clock_24h===!1}))),a.append(o,h(`div`,`room-preview`,e.encrypted?O(`encrypted`):r?te(r):``)),i.append(a),n(e)&&i.append(h(`span`,`badge badge-unread`,String(n(e)))),Number(e.read_state?.mentions)&&i.append(h(`span`,`badge badge-mention`,`@`+e.read_state?.mentions)),i.addEventListener(`contextmenu`,t=>{t.preventDefault(),this.favorite(e).catch(v)}),this.rooms.append(i)}}}renderHeader(){this.header.replaceChildren();let e=this.room?this.model.rooms.get(this.room):void 0;this.main.classList.toggle(`room-open`,!!e),this.composer.disabled=!e||!!e.encrypted||this.roomPermissions.get(e.id)?.send===!1;for(let e of this.roomPane.querySelectorAll(`.composer,.format-bar,.upload-strip`))e.hidden=this.composer.disabled;if(this.composer.placeholder=e&&this.roomPermissions.get(e.id)?.send===!1?O(`readOnly`):O(`message`),!e){if(this.header.append($()),!this.timeline.children.length){let e=h(`div`,`empty-state`);e.append(h(`div`,`unicorn-hero`,`🦄`),h(`h2`,`empty-title`,O(`empty`)),h(`p`,`empty-hint`,O(`emptyHint`))),this.timeline.append(e)}return}let t=g(``,()=>be(this));t.className=`room-heading flat`;let n=x(e.name,`header`,e.kind===`direct`?void 0:`#`),r=this.live?.rooms.find(t=>t.room_id===e.id)?.direct_peer;r&&this.avatar(r,n),t.append(n,h(`span`,`room-title`,e.name)),this.header.append(T(`back`,O(`close`),()=>{this.room=void 0,history.pushState(null,``,`/`),m(this.timeline),this.timeline.replaceChildren(),this.refresh()},`mobile-back flat`),t,T(`pin`,O(`pins`),()=>ye(this)),T(`search`,O(`search`),()=>ve(this))),this.info?.capabilities.voice&&!e.encrypted&&this.header.append(T(`video`,E===`fr`?`Rejoindre l’appel`:`Join call`,()=>this.voice.join()))}async refreshPermissions(e){let t=this.account?.key,r=this.generation;if(!t||!this.model.rooms.has(e))return;let i=this.model.rooms.get(e)?.revision,a=this.model.rooms.get(e)?.read_state?.membership_version,o=await this.api.request(`/api/v1/rooms/`+n(e));r===this.generation&&t===this.account?.key&&this.model.rooms.has(e)&&i===this.model.rooms.get(e)?.revision&&a===this.model.rooms.get(e)?.read_state?.membership_version&&(this.roomPermissions.set(e,o.permissions),this.room===e&&this.renderHeader())}async openRoom(e,t=!0,r=!0){let i=this.account?.key;if(!i)return;this.room=e,this.firstUnread=void 0,this.newPill.hidden=!0,this.root=void 0,this.quote=void 0,this.threadPane.hidden=!0,this.replyBar.hidden=!0,m(this.timeline),this.timeline.replaceChildren(),t&&history.pushState(null,``,`/room/`+n(e)),this.refresh();let a=await l(`drafts`,i+`:`+e)||``,o=await l(`staged`,i+`:`+e)||[];if(i===this.account?.key&&e===this.room){if(this.composer.value=a,this.staged=o,this.renderUploads(),this.composer.focus(),this.model.rooms.get(e)?.encrypted)this.timeline.replaceChildren(h(`div`,`e2e-banner`,O(`encryptedHint`)));else if(this.connection!==`online`)this.renderTimeline();else try{let[t,a]=await Promise.all([this.api.request(`/api/v1/rooms/`+n(e)+`/messages`),this.api.request(`/api/v1/rooms/`+n(e))]);if(i!==this.account?.key||e!==this.room||(this.roomPermissions.set(e,a.permissions),this.renderHeader(),i!==this.account?.key||e!==this.room))return;for(let e of t.messages)this.model.put(e);this.hasOlder.set(e,t.has_more);let o=BigInt(this.model.rooms.get(e)?.read_state?.root_position||`0`);Number(this.model.rooms.get(e)?.read_state?.unread_roots||`0`)>0&&(this.firstUnread=this.model.timeline(e).find(e=>BigInt(e.position)>o)?.id),this.newPill.textContent=O(`newMessages`),this.renderTimeline(),this.timeline.scrollTop=r?this.timeline.scrollHeight:0,r&&await this.markRead(),this.model.rooms.get(e)?.voice&&this.voice.current!==e&&this.voice.join(e).catch(v)}catch(e){v(e)}}}renderTimeline(){this.room&&!this.model.rooms.get(this.room)?.encrypted&&(this.patchRows(this.timeline,this.model.timeline(this.room)),this.renderPending())}patchRows(e,t){let n=e.scrollHeight-e.scrollTop-e.clientHeight<100,r=e.scrollTop,i=e.scrollHeight,a=new Map([...e.querySelectorAll(`[data-id]`)].map(e=>[e.dataset.id,e])),o=[],s,c=``;for(let n of t){let t=new Date(n.created_at),r=new Date,i=new Date;i.setDate(i.getDate()-1);let l=t.toDateString()===r.toDateString()?O(`today`):t.toDateString()===i.toDateString()?O(`yesterday`):t.toLocaleDateString(E,{weekday:`long`,day:`numeric`,month:`long`});l!==c&&(o.push(h(`div`,`day-separator`,l)),c=l),e===this.timeline&&n.id===this.firstUnread&&o.push(h(`div`,`new-marker unread-divider`,O(`newMessages`)));let u=!!s&&s.author.id===n.author.id&&new Date(n.created_at).getTime()-new Date(s.created_at).getTime()<3e5&&new Date(s.created_at).toDateString()===new Date(n.created_at).toDateString(),d=a.get(n.id),f=d&&(d.dataset.editing===`true`||d.dataset.stamp===JSON.stringify(n)&&d.classList.contains(`grouped`)===u)?d:R(n,this.account.session.user.id,this,u);if(d&&d!==f){for(let e of d.querySelectorAll(`[data-file-id]`)){let t=[...f.querySelectorAll(`[data-file-id]`)].find(t=>t.dataset.fileId===e.dataset.fileId&&t.dataset.fileHash===e.dataset.fileHash);t&&t.replaceWith(e)}m(d)}o.push(f),s=n.system?void 0:n}for(let e of a.values())o.includes(e)||m(e);for(let t=0;t<o.length;t++)e.children[t]!==o[t]&&e.insertBefore(o[t],e.children[t]||null);for(;e.children.length>o.length;)e.lastElementChild.remove();e.scrollTop=n?e.scrollHeight:r<100?r+e.scrollHeight-i:r}async jumpTo(e){await this.openRoom(e.room_id,!0,!1);let t=this.account?.key;if(e.reply_to)await this.thread(e),this.model.put(e),this.renderThread();else{let r=await this.api.request(`/api/v1/rooms/`+n(e.room_id)+`/messages?before=`+String(BigInt(e.position)+1n));if(t!==this.account?.key||this.room!==e.room_id)return;r.messages.forEach(e=>this.model.put(e)),this.model.put(e),this.renderTimeline()}let r=this.main.querySelector(`[data-id="`+e.id+`"]`);r?.scrollIntoView({block:`center`}),r?.classList.add(`jump-highlight`),setTimeout(()=>r?.classList.remove(`jump-highlight`),2200)}async older(){if(!this.room||this.loading||this.hasOlder.get(this.room)!==!0)return;let e=this.room,t=this.account?.key,r=this.model.timeline(e)[0]?.position;if(r){this.loading=!0;try{let i=await this.api.request(`/api/v1/rooms/`+n(e)+`/messages?before=`+r);if(e!==this.room||t!==this.account?.key)return;for(let e of i.messages)this.model.put(e);this.hasOlder.set(e,i.has_more);let a=BigInt(this.model.rooms.get(e)?.read_state?.root_position||`0`);Number(this.model.rooms.get(e)?.read_state?.unread_roots||`0`)>0&&(this.firstUnread=this.model.timeline(e).find(e=>BigInt(e.position)>a)?.id),this.newPill.textContent=O(`newMessages`),this.renderTimeline()}catch(e){v(e)}finally{this.loading=!1}}}async saveDraft(){this.account&&this.room&&await u(`drafts`,this.account.key+`:`+this.room,this.composer.value)}async send(e=this.composer.value,t){if(!this.account||!this.room||!e.trim()&&!this.staged.length||this.model.rooms.get(this.room)?.encrypted||this.roomPermissions.get(this.room)?.send===!1)return;if(this.staged.length){for(let n of this.staged)await z(this.account,this.room,n,e,t,this.model.rooms.get(this.room)?.read_state?.membership_version);this.staged=[],await u(`staged`,this.account.key+`:`+this.room),t?this.threadComposer.value=``:this.composer.value=``,await this.saveDraft(),await this.loadUploads(),await B(this);return}if(e.trim().startsWith(`/`)){let t=ne(e);if(t===void 0){let t=/^\/(\w+)(?:\s+([\s\S]*))?$/.exec(e.trim());if(t){await this.api.request(`/api/v1/commands/run`,`POST`,{room_id:this.room,command:t[1],params:(t[2]||``).trim()}),this.composer.value=``,await this.saveDraft();return}}else if(e=t,!e)return}let n=r(),i={operation_id:n,text:e};t&&(i.reply_to=t),this.quote&&(i.quotes=[{room_id:this.quote.room_id,message_id:this.quote.id,revision:this.quote.revision}]);let a={id:n,account:this.account.key,room:this.room,payload:i,membership:this.model.rooms.get(this.room)?.read_state?.membership_version,created:new Date().toISOString()};await u(`outbox`,this.account.key+`:`+n,a),t?(this.threadComposer.value=``,await u(`drafts`,this.account.key+`:`+this.room+`:thread:`+t)):(this.composer.value=``,await this.saveDraft()),this.quote=void 0,this.replyBar.hidden=!0,await this.loadPending(),this.channel.postMessage({outbox:!0}),await this.flush()}async loadPending(){this.pending=(await d(`outbox`)).filter(e=>e.account===this.account?.key),this.renderPending(),this.root&&this.renderThread()}renderPending(){this.pendingRows.replaceChildren();for(let e of this.pending.filter(e=>e.room===this.room&&!e.payload.reply_to)){let t=h(`div`,`pending-row`);t.append(h(`span`,`message-body pending`,e.payload.text),h(`span`,`message-note`,e.error?O(`failed`):O(`pending`))),e.error&&t.append(g(O(`retry`),()=>this.flush()),g(O(`cancel`),async()=>{await u(`outbox`,e.account+`:`+e.id),await this.loadPending()})),this.pendingRows.append(t)}}async flush(){if(!this.account||this.flushing||!navigator.onLine)return;this.flushing=!0;let t=this.account.key,r=this.generation,i=async()=>{for(let i of(await d(`outbox`)).filter(e=>e.account===t)){if(r!==this.generation||t!==this.account?.key)return;if(!this.model.rooms.has(i.room)||this.model.rooms.get(i.room)?.encrypted||i.membership!==this.model.rooms.get(i.room)?.read_state?.membership_version)i.error=`Conversation access changed. Copy this message to send it again.`,await u(`outbox`,t+`:`+i.id,i);else try{let e=await this.api.request(`/api/v1/rooms/`+n(i.room)+`/messages`,`POST`,i.payload);if(r!==this.generation)return;this.model.put(e),await u(`outbox`,t+`:`+i.id),this.refresh()}catch(n){if(r!==this.generation)return;if(i.error=n instanceof Error?n.message:String(n),await u(`outbox`,t+`:`+i.id,i),n instanceof e&&n.status>=400&&n.status<500&&n.status!==429)continue;break}}};try{navigator.locks?await navigator.locks.request(`rv-outbox:`+t,i):await i(),await this.loadPending(),this.channel.postMessage({changed:!0})}finally{this.flushing=!1}}async markRead(){if(!this.room||!document.hasFocus()||document.hidden||this.timeline.scrollHeight-this.timeline.scrollTop-this.timeline.clientHeight>100)return;let e=this.model.rooms.get(this.room),t=this.model.timeline(this.room).at(-1)?.position;if(!e||!t||BigInt(e.read_state?.root_position||`0`)>=BigInt(t))return;let r=this.room,i=this.account?.key;try{let a=await this.api.request(`/api/v1/rooms/`+n(r)+`/read`,`POST`,{root_position:t,reply_position:e.read_state?.reply_position||`0`});i===this.account?.key&&this.model.rooms.has(r)&&(this.model.rooms.get(r).read_state=a,this.renderRooms())}catch{}}async favorite(e){await this.api.request(`/api/v1/rooms/`+n(e.id)+`/favorite`,`PUT`,{operation_id:r(),expected_revision:e.read_state?.favorite_revision||`0`,present:!e.read_state?.favorite}),e.read_state=await this.api.request(`/api/v1/rooms/`+n(e.id)+`/read`),this.renderRooms()}async setTyping(e){if(e&&Date.now()-this.typingAt<3e3)return;this.typingAt=Date.now();let t=this.room?this.model.rooms.get(this.room):void 0;if(t?.read_state?.membership_version&&this.info?.capabilities.typing)try{await this.api.request(`/api/v1/rooms/`+n(t.id)+`/typing`,`PUT`,{active:e,membership_version:t.read_state.membership_version})}catch{}}renderTyping(){let e=this.live?.rooms.find(e=>e.room_id===this.room)?.typing.filter(e=>e.user.id!==this.account?.session.user.id).map(e=>e.user.display_name||e.user.username)||[];this.typing.textContent=e.length?e.join(`, `)+(E===`fr`?` écrit…`:` is typing…`):``}async thread(e){let t=this.generation,r=e.reply_to||e.id,i=await this.api.request(`/api/v1/messages/`+n(r)+`/thread`);if(t!==this.generation)return;this.root=r,this.model.put(i.root);for(let e of i.messages)this.model.put(e);this.threadPane.hidden=!1,this.threadPane.replaceChildren();let a=h(`header`,`headerbar`);a.append(h(`span`,`room-title`,O(`thread`)),T(`close`,O(`close`),()=>this.closeThread())),this.threadTimeline=h(`div`,`timeline`),this.threadComposer=Q(),this.threadComposer.placeholder=O(`message`),this.threadComposer.setAttribute(`aria-label`,O(`thread`)),this.threadComposer.addEventListener(`keydown`,e=>{e.key===`Enter`&&!e.shiftKey&&!e.isComposing&&(e.preventDefault(),this.send(this.threadComposer.value,this.root).catch(v))});let o=h(`div`,`composer`);o.append(T(`attach`,O(`attach`),()=>this.pickFile()),this.threadComposer,T(`mic`,O(`voice`),()=>this.record()),T(`send`,O(`send`),()=>this.send(this.threadComposer.value,this.root),`send`)),this.threadOlder=i.has_more,this.threadTimeline.addEventListener(`scroll`,()=>{this.threadTimeline.scrollTop<100&&this.olderThread(),this.markThread()}),this.threadComposer.addEventListener(`input`,()=>{this.account&&this.root&&u(`drafts`,this.account.key+`:`+this.room+`:thread:`+this.root,this.threadComposer.value)}),this.threadComposer.value=await l(`drafts`,this.account.key+`:`+this.room+`:thread:`+r)||``,this.threadPane.append(a,this.threadTimeline,o),this.renderThread(),this.threadTimeline.scrollTop=this.threadTimeline.scrollHeight,this.threadComposer.focus()}closeThread(){this.root=void 0,this.threadPane.hidden=!0,m(this.threadTimeline)}renderThread(){if(!this.root||!this.room)return;let e=this.model.messages.get(this.root);this.patchRows(this.threadTimeline,[...e?[e]:[],...this.model.timeline(this.room,this.root)]);let t=h(`div`,`pending-rows`);for(let e of this.pending.filter(e=>e.payload.reply_to===this.root)){let n=h(`div`,`pending-row`);n.append(h(`span`,`message-body pending`,e.payload.text),h(`span`,`message-note`,e.error?O(`failed`):O(`pending`))),t.append(n)}this.threadTimeline.append(t),this.markThread()}async olderThread(){if(!this.root||!this.room||!this.threadOlder||this.threadLoading)return;let e=this.root,t=this.account?.key,r=this.model.timeline(this.room,e)[0]?.position;if(r){this.threadLoading=!0;try{let i=await this.api.request(`/api/v1/messages/`+n(e)+`/thread?before=`+r);if(e!==this.root||t!==this.account?.key)return;i.messages.forEach(e=>this.model.put(e)),this.threadOlder=i.has_more,this.renderThread()}catch(e){v(e)}finally{this.threadLoading=!1}}}async markThread(){if(!this.root||!this.room||document.hidden||!document.hasFocus()||this.threadTimeline.scrollHeight-this.threadTimeline.scrollTop-this.threadTimeline.clientHeight>100)return;let e=this.root,t=this.model.timeline(this.room,e).at(-1)?.position;if(!(!t||BigInt(this.threadRead.get(e)||`0`)>=BigInt(t))){this.threadRead.set(e,t);try{await this.api.request(`/api/v1/messages/`+n(e)+`/thread/read`,`POST`,{position:t})}catch{this.threadRead.delete(e)}}}async menu(e,t){let i=this.generation,a=await this.api.request(`/api/v1/messages/`+n(e.id)+`/permissions`);if(i!==this.generation||!this.model.messages.has(e.id))return;let o=t.isConnected?t:this.main.querySelector(`[data-id="`+e.id+`"] .row-more`);if(!o)return;let s=h(`div`,`actions-menu`);s.popover=`auto`;let c=h(`div`);s.append(c),document.body.append(s);let u=o.getBoundingClientRect();s.style.left=Math.max(10,Math.min(innerWidth-268,u.right-250))+`px`,s.style.top=Math.max(10,Math.min(innerHeight-420,u.bottom+4))+`px`,s.addEventListener(`toggle`,()=>{s.matches(`:popover-open`)||s.remove()});let d=()=>{s.hidePopover(),s.remove()},f=await l(`operations`,this.account.key+`:emoji-frequency`)||{},p=[...new Set([...Object.keys(f),...[`thumbsup`,`heart`,`joy`,`tada`,`open_mouth`].map(P)])].sort((e,t)=>(f[t]||0)-(f[e]||0)).slice(0,5),m=h(`div`,`quick-reactions`);if(a.react)for(let t of p.map(F))m.append(g(t,async()=>{await this.reaction(e,t),d()},`quick-reaction`));c.append(m),a.react&&c.append(g(O(`react`),()=>{d(),this.emojiPicker(e)},`menu-action`));let _=(e,t)=>c.append(g(e,async()=>{await t(),d()},`menu-action`));_(O(`reply`),()=>this.thread(e)),_(O(`quote`),()=>{this.quote=e,this.replyBar.replaceChildren(h(`span`,`reply-title`,e.author.display_name||e.author.username),h(`span`,`reply-preview`,e.text),T(`close`,O(`cancel`),()=>{this.quote=void 0,this.replyBar.hidden=!0})),this.replyBar.hidden=!1,this.composer.focus()}),this.info?.capabilities.reports&&e.author.id!==this.account?.session.user.id&&this.model.rooms.get(e.room_id)?.kind===`public`&&_(O(`reports`),()=>Se(this,`messages`,e.id)),_(O(`copy`),()=>navigator.clipboard.writeText(e.text)),_(O(`profile`),()=>J(this,e.author.id)),a.star&&_(e.personal_star?.present?O(`unstar`):O(`star`),async()=>{this.model.put(await this.api.request(`/api/v1/messages/`+n(e.id)+`/star`,`PUT`,{operation_id:r(),present:!e.personal_star?.present})),this.refresh()}),a.pin&&_(e.pinned?O(`unpin`):O(`pin`),async()=>{this.model.put(await this.api.request(`/api/v1/messages/`+n(e.id)+`/pin`,`PUT`,{operation_id:r(),present:!e.pinned})),this.refresh()}),a.edit&&_(O(`edit`),()=>this.editMessage(e,a.revision)),a.delete&&_(O(`delete`),()=>{let[t,i]=y(O(`delete`));i.append(h(`p`,``,e.text),g(O(`delete`),async()=>{this.model.put(await this.api.request(`/api/v1/messages/`+n(e.id),`DELETE`,{operation_id:r(),expected_revision:a.revision})),this.refresh(),t.close()},`destructive`))}),s.showPopover()}editMessage(e,t){let i=this.main.querySelector(`[data-id="`+e.id+`"]`);if(!i)return;let a=i.querySelector(`.message-body`);if(!a)return;i.dataset.editing=`true`;let o=h(`div`,`edit-field`),s=h(`textarea`,`composer-input`);s.value=e.text,s.rows=3;let c=r();o.append(s,g(O(`cancel`),()=>{a.textContent=e.text,delete i.dataset.editing,i.dataset.stamp=``,this.refresh()},`edit-button`),g(O(`save`),async()=>{let r=await this.api.request(`/api/v1/messages/`+n(e.id),`PATCH`,{operation_id:c,expected_revision:t,content:{kind:`plain`,markdown:s.value,mentions:[],quotes:(e.quotes||[]).map(e=>e.reference),files:(e.files||[]).map(e=>e.id)}});this.model.put(r),delete i.dataset.editing,i.dataset.stamp=``,this.refresh()},`edit-button save`)),a.replaceChildren(o),s.focus()}notify(e){if(!(`Notification`in window)||Notification.permission!==`granted`||!this.account)return;let t=this.preferences?.desktop_notifications||`default`;if(t!==`nothing`)for(let n of e){let e=this.model.rooms.get(n.room_id);if(!e||e.encrypted||n.deleted||n.system||n.author.id===this.account.session.user.id||t!==`all`&&!n.personal_mention&&(t!=="default"||e.kind!==`direct`)||n.room_id===this.room&&document.hasFocus()&&!document.hidden&&this.timeline.scrollHeight-this.timeline.scrollTop-this.timeline.clientHeight<100)continue;this.notifications.get(e.id)?.close();let r=new Notification(e.name,{body:te(n),tag:`rv:`+e.id});this.notifications.set(e.id,r),r.onclick=()=>{window.focus(),this.openRoom(e.id),r.close()}}}async complete(){if(this.completion.replaceChildren(),!this.room)return;let e=this.composer.value.slice(0,this.composer.selectionStart),t=/(?:^|\\s):([a-z0-9_+-]*)$/.exec(e),n=/^\/([a-z]*)$/.exec(e),r=/(?:^|\s)@([\w.-]*)$/.exec(e);if(t)for(let e of[...new Set([...j.keys(),...this.emojis.keys()])].filter(e=>e.startsWith(t[1])).slice(0,8)){let n=g(`:`+e+`:`,()=>{let n=this.composer.selectionStart;this.composer.setRangeText(`:`+e+`: `,n-t[1].length-1,n,`end`),this.completion.replaceChildren(),this.composer.focus(),this.saveDraft()},`completion-item`);this.completion.append(n)}else if(n&&this.info?.capabilities.slash_commands){let t=await this.api.request(`/api/v1/commands`);if(e!==this.composer.value.slice(0,this.composer.selectionStart))return;for(let e of t.commands.filter(e=>e.command.startsWith(n[1])).slice(0,8))this.completion.append(g(`/`+e.command+` `+e.params,()=>{this.composer.value=`/`+e.command+` `,this.completion.replaceChildren(),this.composer.focus(),this.saveDraft()},`completion-item`))}else if(r){let t=await this.api.request(`/api/v1/users`);if(e!==this.composer.value.slice(0,this.composer.selectionStart))return;for(let e of[{id:`all`,username:`all`,display_name:``},{id:`here`,username:`here`,display_name:``},...t].filter(e=>e.username.toLowerCase().startsWith(r[1].toLowerCase())).slice(0,8))this.completion.append(g(`@`+e.username,()=>{let t=this.composer.selectionStart;this.composer.setRangeText(`@`+e.username+` `,t-r[1].length-1,t,`end`),this.completion.replaceChildren(),this.composer.focus(),this.saveDraft()},`completion-item`))}}async reaction(e,t){if(!this.account)return;t=this.emojis.get(t)?.name||P(t);let i=this.account.key,a=this.generation,o=!e.reactions?.find(e=>e.emoji===t)?.users.some(e=>e.id===this.account?.session.user.id),s=await this.api.request(`/api/v1/messages/`+n(e.id)+`/reactions`,`PUT`,{operation_id:r(),emoji:t,present:o});if(a===this.generation){if(this.model.put(s),o){let e=await l(`operations`,i+`:emoji-frequency`)||{};e[t]=(e[t]||0)+1,await u(`operations`,i+`:emoji-frequency`,e)}this.refresh()}}mention(e,t){if(t.classList.toggle(`mention-me`,e===this.account?.session.user.username||e===`all`||e===`here`),e===`all`||e===`here`)return;t.tabIndex=0,t.setAttribute(`role`,`button`);let r=async()=>{let t=await this.api.request(`/api/v1/users/lookup?username=`+n(e));await J(this,t.user.id)};t.addEventListener(`click`,()=>void r().catch(v)),t.addEventListener(`keydown`,e=>{e.key===`Enter`&&r().catch(v)})}async previewImage(e,t,r){let i=this.generation,a=await this.asset(`/api/v1/messages/`+n(e.id)+`/previews/`+n(t.file_id),t.sha256,e.room_id);if(i!==this.generation||!r.isConnected)return;let o=h(`img`,`link-preview-image`);o.src=a,o.alt=``,r.prepend(o)}async file(e,t){if(e.encrypted)throw Error(O(`encryptedHint`));if(!this.account||!this.model.rooms.has(e.room_id))throw Error(`Conversation no longer available`);if(t.dataset.loaded)return;let r=this.generation,i=this.account.key,a=`/api/v1/files/`+n(e.id),o=await ke(i,a)||await this.api.blob(a);if(r!==this.generation)return;if(Array.from(new Uint8Array(await crypto.subtle.digest(`SHA-256`,await o.arrayBuffer())),e=>e.toString(16).padStart(2,`0`)).join(``)!==e.sha256||BigInt(o.size)!==BigInt(e.bytes))throw Error(`File integrity check failed`);if(r!==this.generation||(await Ae(i,a,o,e.room_id).catch(()=>{}),r!==this.generation||!t.isConnected))return;let s=URL.createObjectURL(o);this.urls.add(s);let c=this.roomURLs.get(e.room_id)||new Set;if(c.add(s),this.roomURLs.set(e.room_id,c),t.dataset.loaded=`true`,e.media_type.startsWith(`image/`)){let n=h(`img`,`image-attachment`);n.src=s,n.alt=e.filename||``,n.addEventListener(`click`,()=>{let[t,r]=y(e.filename||``),i=h(`img`,`image-viewer`);i.src=s,i.alt=n.alt,r.append(i),t.classList.add(`image-dialog`)}),t.prepend(n)}else if(e.media_type.startsWith(`audio/`)||e.media_type.startsWith(`video/`)){let n=e.media_type.startsWith(`audio/`)?h(`audio`):h(`video`);n.controls=!0,n.src=s,t.prepend(n)}let l=h(`a`,`file-action`,O(`download`));l.href=s,l.download=e.filename||e.id,t.append(l)}async forgetRoom(e){if(this.account){for(let t of this.roomURLs.get(e)||[])URL.revokeObjectURL(t),this.urls.delete(t);this.roomURLs.delete(e);for(let[t,n]of this.assetRooms)if(n===e){let e=this.assetURLs.get(t);e&&e.then(e=>{URL.revokeObjectURL(e),this.urls.delete(e)}).catch(()=>{}),this.assetURLs.delete(t),this.assetRooms.delete(t)}await f(this.account.key,e)}}async asset(e,t,n){if(!this.account)throw Error(`No active session`);let r=this.account.key,i=this.generation,a=this.assetURLs.get(e);return a||(a=(async()=>{let a=await ke(r,e)||await this.api.blob(e);if(t&&Array.from(new Uint8Array(await crypto.subtle.digest(`SHA-256`,await a.arrayBuffer())),e=>e.toString(16).padStart(2,`0`)).join(``)!==t)throw Error(`Image integrity check failed`);if(i!==this.generation||(await Ae(r,e,a,n).catch(()=>{}),i!==this.generation))throw Error(`Session changed`);let o=URL.createObjectURL(a);if(this.urls.add(o),n){this.assetRooms.set(e,n);let t=this.roomURLs.get(n)||new Set;t.add(o),this.roomURLs.set(n,t)}return o})(),this.assetURLs.set(e,a),a.catch(()=>this.assetURLs.delete(e))),a}avatar(e,t){t.dataset.avatarUser=e.id,t.title=e.display_name||e.username;let r=this.generation,i=this.profiles.get(e.id);if(!i){if(this.connection!==`online`)return;i=this.api.request(`/api/v1/users/`+n(e.id)),this.profiles.set(e.id,i),i.catch(()=>this.profiles.delete(e.id))}i.then(async i=>{if(!i.avatar_file_id)return;let a=await this.asset(`/api/v1/avatars/`+n(i.avatar_file_id));if(r!==this.generation||!t.isConnected)return;let o=h(`img`,`avatar-image`);o.src=a,o.alt=e.display_name||e.username,t.replaceChildren(o)}).catch(()=>{})}observeProfiles(e){for(let t of e.profiles||[]){this.profiles.set(t.user.id,Promise.resolve({...t,bio:``}));for(let[e,n]of this.model.messages)n.author.id===t.user.id&&this.model.messages.set(e,{...n,author:t.user});for(let e of this.main.querySelectorAll(`[data-avatar-user]`))e.dataset.avatarUser===t.user.id&&(e.replaceChildren(document.createTextNode(t.user.username.slice(0,1).toUpperCase())),this.avatar(t.user,e))}this.renderTimeline(),this.root&&this.renderThread()}async loadEmojis(){if(!this.info?.capabilities.custom_emojis)return;let e=this.generation,t=await this.api.request(`/api/v1/emoji`);if(e===this.generation&&t.revision!==this.emojiRevision){this.emojis.clear();for(let e of t.items)for(let t of[e.name,...e.aliases])this.emojis.set(t,e);this.emojiRevision=t.revision;for(let e of this.main.querySelectorAll(`[data-stamp]`))e.dataset.stamp=``;this.renderTimeline(),this.root&&this.renderThread()}}emoji(e,t){let r=this.emojis.get(e);if(!r)return;let i=this.generation;this.asset(`/api/v1/emoji/files/`+n(r.file_id),r.sha256).then(n=>{if(i!==this.generation||!t.isConnected)return;let r=h(`img`,`custom-emoji`);r.src=n,r.alt=`:`+e+`:`,r.title=r.alt,t.replaceChildren(r)}).catch(()=>{})}async pickFile(){let e=h(`input`);e.type=`file`,e.multiple=!0,e.addEventListener(`change`,()=>{this.stage([...e.files||[]]).catch(v)}),e.click()}async stage(e){this.room&&this.account&&!this.model.rooms.get(this.room)?.encrypted&&this.roomPermissions.get(this.room)?.upload!==!1&&(this.staged.push(...e),await u(`staged`,this.account.key+`:`+this.room,this.staged),this.renderUploads())}async loadUploads(){this.jobs=(await d(`uploads`)).filter(e=>e.account===this.account?.key),this.renderUploads()}renderUploads(){this.strip.replaceChildren();for(let e of this.staged){let t=h(`div`,`staged-chip`);t.append(g(e.name,()=>this.previewFile(e)),T(`close`,O(`cancel`),async()=>{this.staged=this.staged.filter(t=>t!==e),this.account&&this.room&&await u(`staged`,this.account.key+`:`+this.room,this.staged),this.renderUploads()})),e.type.startsWith(`audio/`)&&t.append(g(`▶`,()=>{let[t,n]=y(e.name),r=h(`audio`);r.controls=!0;let i=URL.createObjectURL(e);this.urls.add(i),r.src=i,n.append(r),t.addEventListener(`close`,()=>{r.pause(),URL.revokeObjectURL(i),this.urls.delete(i)})})),this.strip.append(t)}for(let e of this.jobs.filter(e=>e.room===this.room)){let t=h(`div`,`upload-row`+(e.error?` failed`:``));t.append(h(`span`,``,e.file.name+` · `+(e.error?O(`failed`):O(`pending`)))),e.error&&(t.title=e.error,t.append(g(O(`retry`),()=>B(this)),g(O(`cancel`),async()=>{await u(`uploads`,e.account+`:`+e.id),await this.loadUploads()})));let n=this.uploadProgress.get(e.id);if(n!==void 0){let r=h(`progress`);r.max=1,r.value=n,r.setAttribute(`aria-label`,e.file.name),t.append(r)}this.strip.append(t)}}previewFile(e){let t=this.account?.key,n=this.room;if(!t||!n)return;let[r,i]=y(e.name),a=URL.createObjectURL(e);if(this.urls.add(a),r.addEventListener(`close`,()=>{URL.revokeObjectURL(a),this.urls.delete(a)}),e.type.startsWith(`image/`)){let t=h(`img`,`image-viewer`);t.src=a,t.alt=e.name,i.append(t)}let[o,s]=_(E===`fr`?`Légende`:`Caption`,this.composer.value);i.append(o);let c=h(`select`,`pill-entry`);for(let[e,t]of[[`original`,`Original`],[`standard`,`Photo 1600 px`],[`small`,`Photo 960 px`]]){let n=h(`option`,``,t);n.value=e,c.append(n)}[`image/png`,`image/jpeg`,`image/webp`].includes(e.type)&&i.append(c),i.append(g(O(`save`),async()=>{let i=e;if(c.isConnected&&c.value!==`original`){let t=await createImageBitmap(e),n=c.value===`small`?960:1600,r=Math.min(1,n/Math.max(t.width,t.height)),a=h(`canvas`);a.width=Math.max(1,Math.round(t.width*r)),a.height=Math.max(1,Math.round(t.height*r));let o=a.getContext(`2d`);if(!o)throw t.close(),Error(`Image preview unavailable`);o.fillStyle=`#fff`,o.fillRect(0,0,a.width,a.height),o.drawImage(t,0,0,a.width,a.height),t.close();let s=await new Promise((e,t)=>a.toBlob(n=>n?e(n):t(Error(`Image conversion failed`)),`image/jpeg`,c.value===`small`?.75:.88));i=new File([s],e.name.replace(/\.[^.]+$/,``)+`.jpg`,{type:`image/jpeg`})}t===this.account?.key&&n===this.room&&(this.staged=this.staged.map(t=>t===e?i:t),await u(`staged`,t+`:`+n,this.staged),this.composer.value=s.value,await this.saveDraft(),this.renderUploads(),r.close())},`cta`))}async upload(e){this.account&&this.room&&!this.model.rooms.get(this.room)?.encrypted&&this.roomPermissions.get(this.room)?.send!==!1&&(await z(this.account,this.room,e,``,this.root,this.model.rooms.get(this.room)?.read_state?.membership_version),await this.loadUploads(),await B(this))}async record(){if(!this.room||this.model.rooms.get(this.room)?.encrypted||this.roomPermissions.get(this.room)?.upload===!1)return;if(this.recorder?.state===`recording`){this.recorder.stop();return}let e=await navigator.mediaDevices.getUserMedia({audio:!0}),t=[],n=new MediaRecorder(e);this.recorder=n;let r=this.generation,i=g(O(`stop`),()=>n.stop(),`record-bar`);this.strip.append(i),n.ondataavailable=e=>{e.data.size&&t.push(e.data)};let a=this.account?.key,o=this.room;n.onstop=()=>{if(e.getTracks().forEach(e=>e.stop()),i.remove(),r!==this.generation)return;let s=n.mimeType.split(`;`)[0].trim().toLowerCase(),c=s.includes(`ogg`)?`ogg`:s.includes(`mp4`)?`m4a`:`webm`,d=new File(t,`voice-`+Date.now()+`.`+c,{type:s});a&&o&&(async()=>{let e=await l(`staged`,a+`:`+o)||[];e.push(d),await u(`staged`,a+`:`+o,e),a===this.account?.key&&o===this.room&&(this.staged=e,this.renderUploads())})().catch(v)},n.start()}formatLink(){let e=this.composer.selectionStart,t=this.composer.selectionEnd,[n,r]=y(E===`fr`?`Lien`:`Link`),[i,a]=_(`URL`,`https://`,`url`);r.append(i,g(O(`save`),()=>{let r=new URL(a.value);if(![`http:`,`https:`,`mailto:`].includes(r.protocol))return;let i=this.composer.value.slice(e,t)||r.href;this.composer.setRangeText(`[`+i+`](`+r.href+`)`,e,t,`end`),n.close(),this.composer.focus(),this.saveDraft()},`cta`))}formatLines(e){let t=this.composer.value.lastIndexOf(`
`,this.composer.selectionStart-1)+1,n=this.composer.value.indexOf(`
`,this.composer.selectionEnd),r=n<0?this.composer.value.length:n,i=this.composer.value.slice(t,r).split(`
`).map((t,n)=>(e===`numbered`?String(n+1)+`. `:e)+t).join(`
`);this.composer.setRangeText(i,t,r,`select`),this.composer.focus(),this.saveDraft()}format(e,t){let n=this.composer.selectionStart,r=this.composer.selectionEnd,i=this.composer.value,a=i.slice(n,r),o=n>=e.length&&i.slice(n-e.length,n)===e&&i.slice(r,r+t.length)===t,s=n,c=r,l=e+a+t,u=n+e.length,d=r+e.length;o&&n<r?(s=n-e.length,c=r+t.length,l=a,u=s,d=r-e.length):a.startsWith(e)&&a.endsWith(t)&&a.length>=e.length+t.length&&(l=a.slice(e.length,-t.length),u=n,d=n+l.length),this.composer.setRangeText(l,s,c,`select`),this.composer.focus(),this.composer.setSelectionRange(u,d),this.saveDraft()}emojiPicker(e){let[t,n]=y(O(`react`)),[r,i]=_(O(`search`));i.type=`search`;let a=h(`select`,`pill-entry`);for(let e of[`recent`,...N.keys(),...this.emojis.size?[`custom`]:[]]){let t=h(`option`,``,e);t.value=e,a.append(t)}let o=h(`div`,`emoji-grid`);n.append(r,a,o);let s=()=>{o.replaceChildren();let n=i.value.toLowerCase(),r=n?[...j.keys(),...this.emojis.keys()].filter(e=>e.includes(n)):a.value===`recent`?[`smile`,`joy`,`heart`,`thumbsup`,`tada`,`rocket`,`unicorn`,`fire`,`eyes`,`pray`,`sparkles`,`wave`]:a.value===`custom`?[...this.emojis.keys()]:N.get(a.value)||[];for(let n of[...new Set(r)].slice(0,240)){let r=g(``,async()=>{e?await this.reaction(e,n):(this.composer.setRangeText(this.emojis.has(n)?`:`+n+`:`:j.get(n)||`:`+n+`:`,this.composer.selectionStart,this.composer.selectionEnd,`end`),this.composer.focus(),await this.saveDraft()),t.close()},`picker-emoji`),i=h(`span`,`emoji`,j.get(n)||`:`+n+`:`);r.title=`:`+n+`:`,r.setAttribute(`aria-label`,n),r.append(i),o.append(r),this.emoji(n,i)}};i.addEventListener(`input`,s),a.addEventListener(`change`,s),s(),i.focus()}};document.documentElement.style.setProperty(`--text-scale`,String(Number(localStorage.getItem(`rv-text-size`)||`100`)/100)),new je().init().catch(v),`serviceWorker`in navigator&&navigator.serviceWorker.register(`/sw.js`).catch(v);