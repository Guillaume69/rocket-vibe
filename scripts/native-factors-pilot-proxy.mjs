// Private pilot proxy: discard EVERY successful factor verification response.
// Callers must recover their durable candidate through /me; no secret is logged.
import http from 'node:http';
import net from 'node:net';
// Only the dedicated disposable settings pilot enables this. Each successful
// endpoint is lost once; the original operation's receipt can then be replayed.
const discarded=new Set();
const securityPaths=new Set(['/api/v1/me/reauth/start','/api/v1/me/reauth/finish',
  '/api/v1/me/factors/recovery/regenerate','/api/v1/me/factors/totp/disable']);
if(process.env.RV_PILOT_EMAIL_OTP==='1'){
  securityPaths.add('/api/v1/auth/factors/email/start');
  securityPaths.add('/api/v1/me/reauth/email/start');
}
if(process.env.RV_PILOT_EMAIL_SETTINGS==='1'){
  securityPaths.add('/api/v1/me/factors/email/enable');
  securityPaths.add('/api/v1/me/factors/email/disable');
}
if(process.env.RV_PILOT_EMAIL==='1'){
  securityPaths.add('/api/v1/me/email/verification/start');
  securityPaths.add('/api/v1/me/email/verification/confirm');
  securityPaths.add('/api/v1/me/email/removal/start');
}
const server=http.createServer((request,response)=>{
  if(!request.url?.startsWith('/')){response.writeHead(400).end();return;}
  // Test-only observation: static endpoint names, never codes or request bodies.
  // It proves ACK loss separately from a legitimate pre-dispatch view refusal.
  if(process.env.RV_PILOT_SECURITY==='1' && request.method==='GET' && request.url==='/__pilot/security-response-losses'){
    response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify([...discarded]));return;
  }
  const upstream=http.request({hostname:'server',port:3400,path:request.url,method:request.method,headers:{...request.headers,host:'server:3400'}},answer=>{
    if(process.env.RV_PILOT_SECURITY==='1')console.log(`Pilot HTTP ${request.method} ${request.url.split('?')[0]} ${answer.statusCode}`);
    const securityLoss=process.env.RV_PILOT_SECURITY==='1' &&
      securityPaths.has(request.url) && !discarded.has(request.url) &&
      answer.statusCode>=200 && answer.statusCode<300;
    if(securityLoss)discarded.add(request.url);
    if((request.url==='/api/v1/auth/factors/verify' && answer.statusCode===200) || securityLoss){
      if(securityLoss)console.log(`Disposable security response discarded: ${request.url}`);
      answer.resume();answer.once('end',()=>response.destroy());return;
    }
    response.writeHead(answer.statusCode??502,answer.headers);answer.pipe(response);
  });
  upstream.on('error',()=>response.destroy());request.on('error',()=>upstream.destroy());request.pipe(upstream);
});
server.on('upgrade',(request,front,head)=>{
  const back=net.connect({host:'server',port:3400},()=>{
    const headers=request.rawHeaders.reduce((lines,value,index)=>index%2===0?lines+`${value}: ${request.rawHeaders[index+1]}\r\n`:lines,'');
    back.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);if(head.length)back.write(head);
    front.pipe(back).pipe(front);
  });
  back.on('error',()=>front.destroy());front.on('error',()=>back.destroy());front.on('close',()=>back.destroy());
});
server.listen(3401,'0.0.0.0',()=>console.log('Disposable factor ACK-loss proxy ready'));
