import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';
import type { NativeTypes } from './protocol.generated.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8')).administration;
const update:NativeTypes['UpdateAdminUser'] = fixture.update_user;
const remove:NativeTypes['DeleteAdminUser'] = fixture.delete_user;
const operation:NativeTypes['AdminOperation'] = fixture.operation;
const report:NativeTypes['ReportInput'] = fixture.report;

test('administration reads and commands use typed authenticated routes', async()=>{
  const sent:{url:string;verb:string|undefined;body:string|undefined}[]=[];
  const client = new NativeTransport('https://example.org/chat', async (url, options)=>{
    assert.equal(new Headers(options?.headers).get('authorization'),'Bearer saved-token');
    assert.equal(options?.redirect,'error');
    const path=new URL(String(url)).pathname.replace('/chat','');
    sent.push({url:String(url).replace('https://example.org/chat',''),verb:options?.method,body:options?.body as string|undefined});
    if(options?.method==='POST')return new Response(null,{status:204});
    const answers:Record<string,unknown>={
      '/api/v1/admin/overview':fixture.overview,'/api/v1/admin/users':fixture.user_page,'/api/v1/admin/rooms':fixture.room_page,
      '/api/v1/admin/reports/messages':fixture.reported_messages,'/api/v1/admin/reports/users':fixture.reported_users,
    };
    return Response.json(answers[path] ?? fixture.user_page.items[1]);
  });
  client.restore('saved-token');
  assert.equal((await client.adminOverview()).users.admins,2);
  assert.equal((await client.adminUsers({after:'bob-id',limit:2,q:'Bo b'})).next,fixture.user_page.next);
  assert.equal((await client.updateAdminUser('dave-id',update)).disabled,true);
  await client.deleteAdminUser('carol-id',remove);
  const rooms=await client.adminRooms({q:'  '});
  assert.equal(rooms.items[1].direct_members?.[1].deleted,true);
  const messages=await client.adminReportedMessages({after:'9007199254740993'});
  assert.equal(messages.items[0].author.deleted,true);
  assert.equal(messages.next,'9007199254740993');
  assert.equal((await client.adminReportedUsers()).items[0].user.id,'bob-id');
  await client.dismissMessageReports('message-id',operation);
  await client.deleteReportedMessage('message-id',operation);
  await client.dismissUserReports('bob-id',operation);
  await client.reportMessage('message-id',report);
  await client.reportUser('bob-id',report);
  assert.deepEqual(sent.map(r=>[r.verb,r.url]),[
    ['GET','/api/v1/admin/overview'],['GET','/api/v1/admin/users?after=bob-id&limit=2&q=Bo+b'],
    ['PATCH','/api/v1/admin/users/dave-id'],['POST','/api/v1/admin/users/carol-id/delete'],
    ['GET','/api/v1/admin/rooms'],['GET','/api/v1/admin/reports/messages?after=9007199254740993'],
    ['GET','/api/v1/admin/reports/users'],
    ['POST','/api/v1/admin/reports/messages/message-id/dismiss'],['POST','/api/v1/admin/reports/messages/message-id/delete'],
    ['POST','/api/v1/admin/reports/users/bob-id/dismiss'],
    ['POST','/api/v1/messages/message-id/report'],['POST','/api/v1/users/bob-id/report'],
  ]);
  assert.deepEqual(sent.filter(r=>r.body!==undefined).map(r=>JSON.parse(r.body!)),[update,remove,operation,operation,operation,report,report]);
});

test('administration refusals keep their codes and do not revoke the session', async()=>{
  let revoked=false;
  const client = new NativeTransport('https://example.org',async url=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/report'))return Response.json({code:'self_report',request_id:'self'},{status:409});
    if(path.startsWith('/api/v1/admin/users/'))return Response.json({code:'last_administrator',request_id:'last'},{status:409});
    return Response.json({code:'permission_denied',request_id:'member'},{status:403});
  });
  client.restore('saved-token');client.onTokenRejected=()=>{revoked=true;};
  const code=(expected:string)=>(error:unknown)=>error instanceof NativeError && error.code===expected;
  await assert.rejects(client.adminOverview(),code('permission_denied'));
  await assert.rejects(client.updateAdminUser('dave-id',update),code('last_administrator'));
  await assert.rejects(client.reportUser('alice-id',report),code('self_report'));
  assert.equal(revoked,false);
});

test('administration payloads are validated and forged fields are refused',()=>{
  assert.equal(decodeNative('AdminOverview',fixture.overview).reports.messages,1);
  assert.equal(decodeNative('User',{id:'a',username:'alice',display_name:'Alice'}).deleted,undefined);
  assert.throws(()=>decodeNative('AdminOverview',{...fixture.overview,users:{...fixture.overview.users,total:'12'}}));
  assert.throws(()=>decodeNative('AdminUser',{...fixture.user_page.items[0],status:'invisible'}));
  assert.throws(()=>decodeNative('AdminRoom',{...fixture.room_page.items[0],kind:'discussion'}));
  assert.throws(()=>decodeNative('User',{...fixture.reported_messages.items[0].author,deleted:'yes'}));
  assert.throws(()=>decodeNative('UpdateAdminUser',{...update,deleted:true}));
  assert.throws(()=>decodeNative('ReportInput',{...report,reporter_id:'forged'}));
  assert.throws(()=>decodeNative('AdminOperation',{...operation,message_id:'forged'}));
});

test('a report cooldown holds both report routes and spares other commands', async t=>{
  t.mock.timers.enable({apis:['Date']});
  let reports=0;
  const client = new NativeTransport('https://example.org',async(url,options)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/report')){reports++;return Response.json({code:'report_limit',request_id:'cap'},{status:429,headers:{'retry-after':'120'}});}
    return options?.method==='POST'?new Response(null,{status:204}):Response.json(fixture.overview);
  });
  client.restore('saved-token');
  const limited=(error:unknown)=>error instanceof NativeError && error.code==='report_limit' && error.retryAfter===120;
  await assert.rejects(client.reportMessage('message-id',report),limited);
  await assert.rejects(client.reportUser('bob-id',report),limited);
  assert.equal(reports,1);
  await client.dismissUserReports('bob-id',operation);
  await client.adminOverview();
  t.mock.timers.tick(120_000);
  await assert.rejects(client.reportUser('bob-id',report),limited);
  assert.equal(reports,2);
});

test('a reported message names its author revision unless the author is deleted', ()=>{
  const page=decodeNative('AdminReportedMessagePage',fixture.reported_messages);
  assert.equal(page.items[0].author_revision,null);
  assert.equal(page.items[1].author_revision,'bob-activation');
  assert.throws(()=>decodeNative('AdminReportedMessage',{...fixture.reported_messages.items[1],author_revision:undefined}));
});
