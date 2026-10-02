import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';
import type { NativeTypes } from './protocol.generated.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8'));
const emailContext = {user_id:'alice',device_id:'device',instance_id:'instance',data_epoch:'epoch'};
const emailStatus: NativeTypes['EmailStatus'] = {
  address:null,verified_at:null,version:'contact-version',verification_version:'command-version',context:emailContext,
};
const emailBegin: NativeTypes['BeginEmailVerification'] = {
  address:'alice@example.org',verification_id:'a'.repeat(64),operation_id:'verification-operation',
  expected_version:emailStatus.version,verification_version:emailStatus.verification_version,context:emailContext,
};
const emailResume: NativeTypes['ResumeEmailVerification'] = {
  verification_id:emailBegin.verification_id,operation_id:emailBegin.operation_id,context:emailContext,
};
const emailPending: NativeTypes['EmailVerificationStep'] = {
  state:'pending',verification_id:emailBegin.verification_id,operation_id:emailBegin.operation_id,
  address:emailBegin.address,expires_at:'2026-10-01T12:15:00Z',expected_version:emailStatus.version,
  verification_version:emailStatus.verification_version,delivery:'queued',
};

describe('native protocol contract', () => {
  test('mail recovery retries the original public intent without revoking an installed session', async () => {
    const requests: {url:string; options?:RequestInit}[]=[];
    let lost=true;
    const client=new NativeTransport('https://example.org',async (url,options) => {
      requests.push({url:String(url),options});
      if(String(url).endsWith('/me')) return Response.json(fixture.session.user);
      if(lost){lost=false;throw new TypeError('Synthetic lost acknowledgement');}
      return Response.json({accepted:true},{status:202});
    });
    client.restore('saved-token');let revoked=false;client.surJetonRefuse=()=>{revoked=true;};
    const input:NativeTypes['RequestEmailRecovery']={operation_id:'a'.repeat(64),username:'alice',instance_id:'instance',data_epoch:'epoch'};
    await assert.rejects(client.requestEmailRecovery(input),(e:unknown)=>e instanceof NativeError && e.code==='network_or_protocol_error');
    assert.equal((await client.requestEmailRecovery(input)).accepted,true);
    for(const sent of requests){
      assert.equal(sent.url,'https://example.org/api/v1/auth/recovery/email/start');
      assert.equal(sent.options?.redirect,'error');
      assert.equal(new Headers(sent.options?.headers).has('authorization'),false);
      assert.equal(sent.options?.body,JSON.stringify(input));
    }
    assert.equal(revoked,false);await client.me();
    assert.equal(new Headers(requests[2].options?.headers).get('authorization'),'Bearer saved-token');
  });
  test('a mail recovery capacity cooldown expires without affecting login or the saved bearer', async t => {
    t.mock.timers.enable({apis:['Date']});let calls=0;
    const client=new NativeTransport('https://example.org',async url=>{
      calls++;
      return String(url).endsWith('/me')?Response.json(fixture.session.user):Response.json({code:'email_recovery_limit',request_id:'capacity'},{status:429,headers:{'retry-after':'60'}});
    });
    client.restore('saved-token');
    const input={operation_id:'b'.repeat(64),username:'alice',instance_id:'instance',data_epoch:'epoch'};
    const limited=(e:unknown)=>e instanceof NativeError && e.code==='email_recovery_limit' && e.retryAfter===60;
    await assert.rejects(client.requestEmailRecovery(input),limited);
    await assert.rejects(client.requestEmailRecovery(input),limited);assert.equal(calls,1);
    await client.me();assert.equal(calls,2);
    t.mock.timers.tick(60_000);await assert.rejects(client.requestEmailRecovery(input),limited);assert.equal(calls,3);
  });
  test('the Rust fixture is understood without rounding sequence numbers', () => {
    assert.equal(decodeNative('Message',fixture.message).position,'9007199254740993');
    assert.equal(decodeNative('Room',fixture.room).revision,'9007199254740993');
    assert.equal(decodeNative('Discovery',fixture.discovery).product,'rocketvibe');
    assert.equal(decodeNative('SyncBatch',fixture.sync_batch).changes[0].type,'room_removed');
  });
  test('malformed messages, unknown events and forged input fields are rejected', () => {
    assert.throws(() => decodeNative('Message',{...fixture.message,position:9007199254740992}));
    assert.throws(() => decodeNative('Change',{type:'unexpected',data:{}}));
    assert.throws(() => decodeNative('SendMessage',{...fixture.send_message,author_id:'someone-else'}));
  });
  test('authenticated requests keep the token on the configured origin and forbid redirects', async () => {
    const requests: {url:string; options?: RequestInit}[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      requests.push({url:String(url),options});
      return Response.json(String(url).endsWith('/auth/login') ? fixture.session : fixture.message);
    };
    const client = new NativeTransport('https://example.org/chat/',fetcher);
    await client.login('alice','password');
    await client.send('room-id',fixture.send_message);
    assert.equal(requests[1].url,'https://example.org/chat/api/v1/rooms/room-id/messages');
    assert.equal(requests[1].options?.redirect,'error');
    assert.equal(new Headers(requests[1].options?.headers).get('authorization'),'Bearer fixture-token');
    assert.equal(new Headers(requests[0].options?.headers).has('authorization'),false);
  });
  test('an unrecognized native version is not silently treated as Rocket.Chat', async () => {
    const client = new NativeTransport('https://example.org',async () => Response.json({...fixture.discovery,protocol_versions:[99]}));
    await assert.rejects(client.discover(),/Unsupported RocketVibe/);
  });
  test('server errors stay structured and missing sessions never send a request', async () => {
    let calls = 0;
    const client = new NativeTransport('https://example.org',async () => { calls++; return Response.json(fixture.error,{status:401}); });
    await assert.rejects(client.snapshot(),(e: unknown) => e instanceof NativeError && e.code==='session_rejected');
    assert.equal(calls,0);
    await assert.rejects(client.login('alice','wrong'),(e: unknown) => e instanceof NativeError && e.status===401);
  });
  test('a recognized 429 suppresses early retries without rejecting the saved session', async t => {
    t.mock.timers.enable({apis:['Date']});
    let calls = 0;
    let revoked = false;
    const client = new NativeTransport('https://example.org',async url => {
      calls++;
      return String(url).endsWith('/me') ? Response.json(fixture.session.user)
        : Response.json({code:'ticket_limit',request_id:'test'},{status:429,headers:{'retry-after':'30'}});
    });
    client.restore('saved-token');
    client.surJetonRefuse = () => { revoked = true; };
    const limited = (e: unknown) => e instanceof NativeError && e.status === 429 && e.retryAfter === 30;
    await assert.rejects(client.socketUrl('cursor'),limited);
    await assert.rejects(client.socketUrl('cursor'),limited);
    assert.equal(calls,1);
    assert.equal(revoked,false);
    assert.equal((await client.me()).id,fixture.session.user.id);
    assert.equal(calls,2);
    t.mock.timers.tick(30_000);
    await assert.rejects(client.socketUrl('cursor'),limited);
    assert.equal(calls,3,'the cooldown must expire and allow a new request');
  });
  test('a malformed 429 does not install a server cooldown', async () => {
    let calls = 0;
    const client = new NativeTransport('https://example.org',async () => {
      calls++;
      return Response.json({message:'proxy error'},{status:429,headers:{'retry-after':'999999'}});
    });
    for (let n=0;n<2;n++) await assert.rejects(client.login('alice','wrong'),
      (e: unknown) => e instanceof NativeError && e.status === 0);
    assert.equal(calls,2);
  });
  test('action cooldown spans edits, deletes and reactions while keeping message reads available',async t => {
    t.mock.timers.enable({apis:['Date']});
    const verbs:string[]=[];
    const client=new NativeTransport('https://example.org',async (_,options) => {
      const verb=options?.method ?? 'GET'; verbs.push(verb);
      return verb==='GET'?Response.json(fixture.message):Response.json({code:'message_action_limit',request_id:'action-request'},{status:429,headers:{'retry-after':'1'}});
    });
    client.restore('saved-token');
    const input={operation_id:'action-id',expected_revision:'1'};
    const limited=(error:unknown)=>error instanceof NativeError && error.status===429 && error.requestId==='action-request' && error.retryAfter===1;
    await assert.rejects(client.editMessage('message-id',{...input,content:{kind:'plain',markdown:'Edited',mentions:[],quotes:[],files:[]}}),limited);
    assert.equal((await client.message('message-id')).id,fixture.message.id);
    await assert.rejects(client.deleteMessage('message-id',input),limited);
    await assert.rejects(client.setReaction('message-id',{operation_id:'reaction-id',emoji:'heart',present:true}),limited);
    assert.deepEqual(verbs,['PATCH','GET']);
    t.mock.timers.tick(1000);
    await assert.rejects(client.deleteMessage('message-id',input),limited);
    assert.deepEqual(verbs,['PATCH','GET','DELETE']);
  });
  test('private e-mail routes preserve their original candidate on the configured origin',async () => {
    const requests:{url:string;options?:RequestInit}[]=[];
    const client=new NativeTransport('https://example.org/chat/',async (url,options) => {
      requests.push({url:String(url),options});
      const path=String(url);
      return Response.json(path.endsWith('/email') || path.endsWith('/retire') ? emailStatus
        : path.endsWith('/confirm') ? {state:'verified',address:emailBegin.address,version:'verified-version'} : emailPending);
    });
    client.restore('saved-token');
    assert.equal((await client.emailStatus()).address,null);
    assert.equal((await client.beginEmailVerification(emailBegin)).state,'pending');
    assert.equal((await client.resumeEmailVerification(emailResume)).state,'pending');
    const confirmation={...emailResume,code:'12345678'};
    assert.equal((await client.confirmEmailVerification(confirmation)).state,'verified');
    const retirement={context:emailContext,expected_version:emailStatus.version,verification_version:emailStatus.verification_version};
    await client.retireEmailVerification(retirement);
    assert.deepEqual(requests.map(request=>request.url),[
      'https://example.org/chat/api/v1/me/email',
      ...['start','resume','confirm','retire'].map(step=>`https://example.org/chat/api/v1/me/email/verification/${step}`),
    ]);
    assert.deepEqual(requests.map(request=>request.options?.method),['GET','POST','POST','POST','POST']);
    for (const request of requests) {
      assert.equal(request.options?.redirect,'error');
      assert.equal(new Headers(request.options?.headers).get('authorization'),'Bearer saved-token');
    }
    assert.equal(requests[1].options?.body===JSON.stringify(emailBegin),true);
    assert.equal(requests[2].options?.body===JSON.stringify(emailResume),true);
    assert.equal(requests[3].options?.body===JSON.stringify(confirmation),true);
  });
  test('delivery cooldown leaves private status, resume, confirmation and retirement available',async t => {
    t.mock.timers.enable({apis:['Date']});
    const paths:string[]=[];
    let revoked=false;
    const client=new NativeTransport('https://example.org',async url => {
      const path=new URL(String(url)).pathname; paths.push(path);
      if (path.endsWith('/start')) return Response.json({code:'email_delivery_limit',request_id:'delivery-request'},
        {status:429,headers:{'retry-after':'30'}});
      return Response.json(path.endsWith('/email') || path.endsWith('/retire') ? emailStatus : emailPending);
    });
    client.restore('saved-token');
    client.surJetonRefuse=()=>{revoked=true;};
    const limited=(error:unknown)=>error instanceof NativeError && error.status===429 && error.retryAfter===30;
    await assert.rejects(client.beginEmailVerification(emailBegin),limited);
    await assert.rejects(client.beginEmailVerification(emailBegin),limited);
    await client.emailStatus();
    await client.resumeEmailVerification(emailResume);
    await client.confirmEmailVerification({...emailResume,code:'12345678'});
    await client.retireEmailVerification({context:emailContext,expected_version:emailStatus.version,verification_version:emailStatus.verification_version});
    assert.equal(paths.filter(path=>path.endsWith('/start')).length,1);
    assert.equal(paths.length,5);
    assert.equal(revoked,false);
    t.mock.timers.tick(30_000);
    await assert.rejects(client.beginEmailVerification(emailBegin),limited);
    assert.equal(paths.filter(path=>path.endsWith('/start')).length,2);
  });
  test('unrecognized delivery states and forged e-mail command fields fail validation',async () => {
    const client=new NativeTransport('https://example.org',async()=>Response.json({...emailPending,delivery:'delivered_to_inbox'}));
    client.restore('saved-token');
    await assert.rejects(client.resumeEmailVerification(emailResume));
    assert.throws(()=>decodeNative('BeginEmailVerification',{...emailBegin,user_id:'another-account'}));
    assert.throws(()=>decodeNative('EmailStatus',{...emailStatus,context:{...emailContext,device_id:42}}));
  });
  test('private removal routes keep the original scope and remain usable during SMTP cooldown',async t => {
    t.mock.timers.enable({apis:['Date']});
    const paths:string[]=[],bodies:unknown[]=[],receipt:NativeTypes['EmailRemovalReceipt']={version:'removed-contact',verification_version:'removed-head',context:emailContext};
    const client=new NativeTransport('https://example.org',async(url,options)=>{
      const path=new URL(String(url)).pathname;paths.push(path);
      assert.equal(new URL(String(url)).origin,'https://example.org');
      assert.equal(options?.redirect,'error');assert.equal(options?.method,'POST');
      assert.equal(new Headers(options?.headers).get('authorization'),'Bearer saved-token');
      if(path.endsWith('/verification/start'))return Response.json({code:'email_delivery_limit',request_id:'limit'},{status:429,headers:{'Retry-After':'30'}});
      bodies.push(JSON.parse(String(options?.body)));return Response.json(path.endsWith('/retire')?emailStatus:receipt);
    });
    client.restore('saved-token');
    await assert.rejects(client.beginEmailVerification(emailBegin),e=>e instanceof NativeError && e.status===429);
    const command:NativeTypes['RemoveVerifiedEmail']={operation_id:'original-operation',expected_version:emailStatus.version,verification_version:emailStatus.verification_version,context:emailContext};
    const resume:NativeTypes['ResumeEmailRemoval']={operation_id:command.operation_id,context:emailContext};
    const retire:NativeTypes['RetireEmailRemoval']={expected_version:command.expected_version,verification_version:command.verification_version,context:emailContext};
    assert.deepEqual(await client.removeVerifiedEmail(command),receipt);
    assert.deepEqual(await client.resumeEmailRemoval(resume),receipt);
    assert.deepEqual(await client.retireEmailRemoval(retire),emailStatus);
    assert.deepEqual(bodies,[command,resume,retire]);
    assert.deepEqual(paths,['/api/v1/me/email/verification/start','/api/v1/me/email/removal/start','/api/v1/me/email/removal/resume','/api/v1/me/email/removal/retire']);
  });
  test('rejected removal keeps the session and forged receipt/body fields fail validation',async()=>{
    let revoked=false;
    const client=new NativeTransport('https://example.org',async()=>Response.json({code:'email_removal_rejected',request_id:'rejected'},{status:400}));
    client.restore('saved-token');client.surJetonRefuse=()=>{revoked=true;};
    const command:NativeTypes['RemoveVerifiedEmail']={operation_id:'original-operation',expected_version:emailStatus.version,verification_version:emailStatus.verification_version,context:emailContext};
    await assert.rejects(client.removeVerifiedEmail(command),e=>e instanceof NativeError && e.status===400 && e.code==='email_removal_rejected');
    assert.equal(revoked,false);
    assert.throws(()=>decodeNative('RemoveVerifiedEmail',{...command,address:'forged@example.test'}));
    assert.throws(()=>decodeNative('RetireEmailRemoval',{expected_version:command.expected_version,verification_version:command.verification_version,context:emailContext,address:'forged@example.test'}));
    assert.throws(()=>decodeNative('EmailRemovalReceipt',{version:42,verification_version:'head',context:emailContext}));
    assert.throws(()=>decodeNative('EmailRemovalReceipt',{version:'version',verification_version:'head',context:{...emailContext,device_id:42}}));
  });
});
