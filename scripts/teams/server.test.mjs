import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { bridgeServer } from './server.mjs';
const call=(url,method='GET',headers={},body='')=>new Promise((resolve,reject)=>{
  const req=request(url,{method,headers},res=>{let raw='';res.on('data',c=>{raw+=c;});res.on('end',()=>resolve({status:res.statusCode,body:raw,headers:res.headers}));});req.on('error',reject);req.end(body);
});
test('local bridge refuses missing capability, rebinding hosts and foreign origins',async()=>{
  const bridge=await bridgeServer({state:()=>({ready:false,captured:[]})});
  try{
    assert.equal((await call(new URL('/wrong/state',bridge.url))).status,403);
    assert.equal((await call(bridge.url+'state','GET',{Host:'evil.test'})).status,403);
    assert.equal((await call(bridge.url+'state','GET',{Origin:'https://evil.test'})).status,403);
    const good=await call(bridge.url+'state');assert.equal(good.status,200);assert.deepEqual(JSON.parse(good.body),{ready:false,captured:[],issue:'waiting_for_sign_in'});assert.equal(good.headers['cache-control'],'no-store');
  }finally{await new Promise(r=>bridge.server.close(r));}
});
test('export requires same-origin POST and returns only sealed data',async()=>{
  let calls=0;const bridge=await bridgeServer({state:()=>({ready:true,captured:['spaces','aggregator','chat']}),seal:key=>{assert.equal(key,'synthetic-public-code');calls++;return 'rvteams2.synthetic-encrypted-data';}});
  try{
    const body=JSON.stringify({pairingKey:'synthetic-public-code'}),origin=new URL(bridge.url).origin;
    assert.equal((await call(bridge.url+'export','POST',{'Content-Type':'application/json'},body)).status,403);
    assert.equal((await call(bridge.url+'export','POST',{'Content-Type':'application/json',Origin:'https://evil.test'},body)).status,403);
    const good=await call(bridge.url+'export','POST',{'Content-Type':'application/json',Origin:origin},body);assert.equal(good.status,200);assert.deepEqual(JSON.parse(good.body),{code:'rvteams2.synthetic-encrypted-data'});assert.equal(calls,1);
  }finally{await new Promise(r=>bridge.server.close(r));}
});
