// Disposable Compose settings bench only. Codes stay in its private volume;
// the SMTP identity below is explicitly public, synthetic test data.
import {readFileSync,writeFileSync,chownSync} from 'node:fs';
import {createPrivateKey} from 'node:crypto';
import tls from 'node:tls';

const directory='/pilot-invitations';
if(process.argv[2]==='configure'){
  const path=`${directory}/smtp-pilot.json`;
  writeFileSync(path,JSON.stringify({host:'localhost',port:3465,from:'service@example.test',tls:'implicit_tls',
    username:null,password:null,ca_file:'/mail-fixtures/mail-cert.pem'}),{mode:0o600});
  chownSync(path,10001,10001);
}else{
  const cert=readFileSync('/src/apps/server/tests/fixtures/mail-cert.pem');
  const key=createPrivateKey({key:readFileSync('/src/apps/server/tests/fixtures/mail-key.der'),format:'der',type:'pkcs8'})
    .export({type:'pkcs8',format:'pem'});
  const recipients=new Set(['gtk-security@example.test','swift-security@example.test','gtk-email@example.test','swift-email@example.test']);
  const otpSequences=new Map();
  const relay=tls.createServer({cert,key},socket=>{
    socket.setEncoding('utf8');socket.setTimeout(10000,()=>socket.destroy());
    socket.on('error',()=>{});
    let buffer='',recipient=null,data=false,message='';
    socket.write('220 localhost disposable mail fixture\r\n');
    socket.on('data',chunk=>{
      buffer+=chunk;
      if(buffer.length+message.length>32768){socket.destroy();return;}
      for(let end;(end=buffer.indexOf('\r\n'))!==-1;){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(data){
          if(line!=='.'){message+=`${line.startsWith('..')?line.slice(1):line}\r\n`;continue;}
          const code=message.match(/(?:^|\r\n)Code: ([0-9]{8})(?:\r\n|$)/)?.[1];
          if(!code || !recipients.has(recipient)){socket.write('550 invalid disposable message\r\n');}
          else{
            try{
              const username=recipient.split('@')[0];
              const otp=['gtk-email','swift-email'].includes(username);
              const sequence=(otpSequences.get(recipient)??0)+1;
              if(otp)otpSequences.set(recipient,sequence);
              const metadata=otp?{sequence}:{};
              writeFileSync(`${directory}/${username}-mail.json`,JSON.stringify({address:recipient,code,...metadata}),{mode:0o600});
              socket.write('250 message accepted\r\n');
            }catch{socket.write('451 disposable storage unavailable\r\n');}
          }
          data=false;message='';recipient=null;continue;
        }
        if(/^(EHLO|HELO) /i.test(line))socket.write('250-localhost\r\n250 SIZE 16384\r\n');
        else if(/^MAIL FROM:/i.test(line)){recipient=null;socket.write('250 sender accepted\r\n');}
        else if(/^RCPT TO:/i.test(line)){
          const address=line.match(/^RCPT TO:<([^>]+)>$/i)?.[1];
          if(recipients.has(address)){recipient=address;socket.write('250 recipient accepted\r\n');}
          else socket.write('550 only disposable recipients accepted\r\n');
        }else if(line.toUpperCase()==='DATA' && recipient){data=true;message='';socket.write('354 send data\r\n');}
        else if(line.toUpperCase()==='QUIT'){socket.end('221 goodbye\r\n');return;}
        else if(line.toUpperCase()==='RSET'){recipient=null;socket.write('250 reset\r\n');}
        else if(line.toUpperCase()==='NOOP')socket.write('250 ok\r\n');
        else socket.write('502 unsupported command\r\n');
      }
    });
  });
  relay.on('tlsClientError',()=>{});
  relay.listen(3465,'127.0.0.1',()=>console.log('Disposable TLS email relay ready'));
}
