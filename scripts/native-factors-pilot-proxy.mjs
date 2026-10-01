// Private pilot proxy: discard EVERY successful factor verification response.
// Callers must recover their durable candidate through /me; no secret is logged.
import http from 'node:http';
import net from 'node:net';
const server=http.createServer((request,response)=>{
  if(!request.url?.startsWith('/')){response.writeHead(400).end();return;}
  const upstream=http.request({hostname:'server',port:3400,path:request.url,method:request.method,headers:{...request.headers,host:'server:3400'}},answer=>{
    if(request.url==='/api/v1/auth/factors/verify' && answer.statusCode===200){
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
