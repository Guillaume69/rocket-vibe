import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
export async function bridgeServer(collector,issue=()=>"waiting_for_sign_in") {
 const prefix='/'+randomBytes(24).toString('hex')+'/';let server;
    const [html,js]=await Promise.all(['browser-page.html','browser-page.js'].map(f=>readFile(new URL('./'+f,import.meta.url),'utf8')));
    server=createServer((req,res)=>{void(async()=>{
      const port=server.address().port,origin='http://127.0.0.1:'+port;
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      if(req.headers.host!=='127.0.0.1:'+port||req.headers.origin&&req.headers.origin!==origin||!req.url.startsWith(prefix)){res.writeHead(403);res.end();return;}
      if(req.method==='GET'&&req.url===prefix){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}
      else if(req.method==='GET'&&req.url===prefix+'bridge.js'){res.setHeader('Content-Type','application/javascript');res.end(js);}
      else if(req.method==='GET'&&req.url===prefix+'state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...collector.state(),issue:issue()}));}
      else if(req.method==='POST'&&req.url===prefix+'export'){
        if(req.headers.origin!==origin||req.headers['content-type']!=='application/json'){res.writeHead(403);res.end();return;}
        let raw='';for await(const chunk of req){raw+=chunk.toString();if(raw.length>1024){res.writeHead(413);res.end();return;}}
        let code;try{const body=JSON.parse(raw);code=collector.seal(body.pairingKey);}catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({code:'handoff_unavailable'}));return;}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code}));
      }else{res.writeHead(404);res.end();}
    })().catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url='http://127.0.0.1:'+server.address().port+prefix;return {server,url};
}
