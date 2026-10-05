import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CryptoAccount,CryptoHistoryBridge} from '../../modules/crypto-native/index.ts';
import {CryptoHistoryAccess} from './cryptoHistory.ts';
import {CryptoIdentityAccess} from './cryptoIdentity.ts';
import {CryptoStorageAccess} from './cryptoStorage.ts';
import {NativeTransport} from './transport.ts';

// Transport and orchestration only: the Rust bridge tests check the real
// directory trust, sealing and import.
const wire={instance_id:'instance',data_epoch:'epoch'};
const scope:CryptoAccount={origin:'https://example.org',instance:'instance',dataEpoch:'epoch',user:'alice',device:'desktop'};
const directory={scope:wire,identity:null,devices:[],revocations:[],next_revocation:null};
const request='ab'.repeat(32);
const stale='cd'.repeat(32);
function native(pages:number) {
  const actions:string[]=[];
  let pending:string|null=null,sharing:string|null=null,uploads=0;
  let importing:{request:string;next:{period:number;after:string}|null}|null=null;
  const bridge:CryptoHistoryBridge={
    open:async()=>({handle:'view',phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:'11'.repeat(16)}),
    status:async()=>({phase:'ready',accountFingerprint:'ee'.repeat(32),incarnation:'11'.repeat(16)}),
    close:async()=>{},initialize:async()=>{throw Error('Unexpected initialization');},removed:async()=>{},
    identityView:async()=>{throw Error('Unused');},identityBegin:async()=>{throw Error('Unused');},identityRenew:async()=>{throw Error('Unused');},identityPreview:async()=>{throw Error('Unused');},identityApprove:async()=>{throw Error('Unused');},identityInstall:async()=>{throw Error('Unused');},identityPending:async()=>{throw Error('Unused');},identityAcknowledge:async()=>{throw Error('Unused');},
    historyAction:async(_handle,own,json)=>{
      assert.deepEqual(JSON.parse(own),directory);const input=JSON.parse(json);actions.push(input.action);
      switch(input.action){
        case 'request':pending=request;return JSON.stringify({fingerprint:request,input:{scope:wire,request:'cmVxdWVzdA'}});
        case 'view':return JSON.stringify({pending,sharing,importing});
        case 'acknowledgeable':return JSON.stringify({requests:input.listed.requests.map((e:{fingerprint:string})=>e.fingerprint).filter((f:string)=>f!==pending)});
        case 'offers':return JSON.stringify({id:'01'.repeat(16),offers:[{fingerprint:request,device:'phone',issued_at:'1',expires_at:'2'}]});
        case 'preview':assert.equal(input.id,'01'.repeat(16));assert.equal(input.fingerprint,request);
          return JSON.stringify({id:'02'.repeat(16),fingerprint:request,device:'phone',periods:[{room:'general',documents:String(pages)}]});
        case 'approve':assert.equal(input.id,'02'.repeat(16));sharing=request;uploads=0;return '{"approved":true}';
        case 'upload':return JSON.stringify({upload:uploads<pages?{request,input:{scope:wire,period:0,start:String(uploads),records:['cmVjb3Jk']}}:null});
        case 'uploaded':assert.deepEqual(input.receipt,{period:0,count:String(uploads+1)});uploads++;return '{"recorded":true}';
        case 'commit':assert.equal(uploads,pages);return JSON.stringify({request,input:{scope:wire,share:'c2hhcmU'}});
        case 'committed':assert.equal(input.state.share,'c2hhcmU');sharing=null;return '{"committed":true}';
        case 'abandon':sharing=null;return '{"abandoned":true}';
        case 'import_begin':assert.equal(input.state.fingerprint,request);importing={request,next:{period:0,after:'0'}};return JSON.stringify(importing);
        case 'import_page':{
          assert(importing?.next);assert.equal(input.page.start,importing.next.after);
          const after=Number(importing.next.after)+1;
          importing={request,next:after<pages?{period:0,after:String(after)}:null};
          const out=JSON.stringify(importing);if(importing.next===null){importing=null;pending=null;}return out;
        }
        default:throw Error(`Unexpected native action ${input.action}`);
      }
    },
  };
  const open=async(transport:NativeTransport)=>{
    const storage=await CryptoStorageAccess.open(bridge,async()=>scope,()=>true);
    const identity=new CryptoIdentityAccess(storage,bridge,transport);
    return {identity,history:new CryptoHistoryAccess(identity,bridge,transport)};
  };
  return {open,actions};
}
type Server={committed:boolean;claimed:boolean;acked:string[];uploads:number;listed:unknown[]};
function server(state:Server):NativeTransport {
  const transport=new NativeTransport(scope.origin,async(url,options)=>{
    const {pathname:path,searchParams}=new URL(String(url));const method=options?.method??'GET';
    if(path.includes('/users/'))return Response.json(directory);
    if(path==='/api/v1/e2ee/history/requests'&&method==='GET')return Response.json({scope:wire,requests:state.listed});
    if(path==='/api/v1/e2ee/history/requests'&&method==='POST')return Response.json({fingerprint:request,device_id:'phone',request:'cmVxdWVzdA',expires_at:'2',sharer_device_id:null,committed:false});
    const [, , , , , , fingerprint,rest]=path.split('/');
    if(rest==='ack'){state.acked.push(fingerprint!);return new Response(null,{status:204});}
    if(rest==='records'&&method==='PUT'){
      if(state.claimed)return Response.json({code:'history_share_claimed',request_id:'claimed'},{status:409});
      const body=JSON.parse(String(options?.body));state.uploads++;return Response.json({period:body.period,count:String(Number(body.start)+1)});
    }
    if(rest==='share'&&method==='POST'){state.committed=true;return Response.json({scope:wire,fingerprint,sharer_device_id:'desktop',share:'c2hhcmU'});}
    if(rest==='share')return state.committed?Response.json({scope:wire,fingerprint,sharer_device_id:'desktop',share:'c2hhcmU'}):Response.json({code:'not_found',request_id:'missing'},{status:404});
    if(rest==='records'){const after=searchParams.get('after')!;return Response.json({period:0,start:after,records:['cmVjb3Jk'],next:null});}
    throw Error(`Unexpected route ${method} ${path}`);
  });
  transport.restore('saved-token');return transport;
}

test('the sharing device previews, uploads every page and commits, and the new device imports then acknowledges',async()=>{
  const state:Server={committed:false,claimed:false,acked:[],uploads:0,listed:[]};
  const phone=native(2);const desktop=native(2);
  const p=await phone.open(server(state));const d=await desktop.open(server(state));
  // Nothing pending: only the requests nothing waits for are acknowledged.
  state.listed=[{fingerprint:stale,device_id:'phone',request:'eA',expires_at:'1',sharer_device_id:null,committed:true}];
  assert.deepEqual(await p.history.importHistory(),{state:'idle'});
  assert.deepEqual(state.acked,[stale]);
  assert.equal(await p.history.requestHistory(),request);
  assert.deepEqual(await p.history.importHistory(),{state:'waiting',request});
  const offers=await d.history.offers();assert.equal(offers.offers[0]!.device,'phone');
  const preview=await d.history.preview(offers.id,request);assert.deepEqual(preview.periods,[{room:'general',documents:'2'}]);
  await d.history.share(preview.id);
  assert.equal(state.uploads,2);assert(state.committed);
  assert.equal(await d.history.resumeShare(),false);
  assert.deepEqual(await p.history.importHistory(),{state:'done',request});
  assert.deepEqual(state.acked,[stale,request]);
  assert.deepEqual(phone.actions.filter(a=>a==='import_page'),['import_page','import_page']);
});

test('a share claimed by another device of the account is abandoned, not retried',async()=>{
  const state:Server={committed:false,claimed:true,acked:[],uploads:0,listed:[]};
  const desktop=native(1);const d=await desktop.open(server(state));
  const offers=await d.history.offers();const preview=await d.history.preview(offers.id,request);
  await assert.rejects(d.history.share(preview.id),(error:{code?:string})=>error.code==='history_share_claimed');
  assert(desktop.actions.includes('abandon'));
  assert.equal(await d.history.resumeShare(),false);
});
