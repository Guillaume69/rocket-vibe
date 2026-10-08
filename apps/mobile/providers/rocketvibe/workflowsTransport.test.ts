import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeError, NativeTransport } from './transport.ts';
import { decodeNative } from './validation.ts';

const all = JSON.parse(readFileSync(new URL('../../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8'));
const fixture = all.workflows;

test('workflow routes, verbs and bodies follow WORKFLOWS.md', async()=>{
  const sent:{verb:string|undefined;url:string;type:string|null;body:string|undefined}[]=[];
  const client=new NativeTransport('https://example.org/chat',async(url,options)=>{
    assert.equal(new Headers(options?.headers).get('authorization'),'Bearer saved-token');
    const parsed=new URL(String(url));
    const path=parsed.pathname.replace('/chat','')+parsed.search;
    sent.push({verb:options?.method,url:path,type:new Headers(options?.headers).get('content-type'),body:options?.body as string|undefined});
    if(options?.method==='DELETE' || path.endsWith('/answer'))return new Response(null,{status:204});
    if(path.startsWith('/api/v1/workflows?')||path==='/api/v1/workflows'&&options?.method==='GET')return Response.json(fixture.workflow_list);
    if(path.endsWith('/runs'))return Response.json(fixture.workflow_run_list);
    if(path.endsWith('/webhook'))return Response.json(fixture.webhook_secret);
    if(path.endsWith('/test'))return Response.json(fixture.run_started);
    if(path.startsWith('/api/v1/commands'))return Response.json(all.command_list);
    return Response.json(fixture.workflow);
  });
  client.restore('saved-token');
  assert.equal((await client.workflows()).workflows[0].name,'Standup');
  await client.workflows(true);
  assert.equal((await client.workflow('wf id')).revision,'rev-1');
  assert.equal((await client.createWorkflow(fixture.create_workflow)).bot.bot,true);
  assert.equal((await client.updateWorkflow('wf-id',fixture.update_workflow)).id,'wf-id');
  await client.deleteWorkflow('wf-id');
  assert.equal((await client.disableWorkflow('wf-id')).id,'wf-id');
  assert.ok((await client.workflowWebhook('wf-id')).path.startsWith('/api/v1/hooks/wf-id/'));
  assert.equal((await client.workflowRuns('wf-id')).runs[1].error,'http_address');
  assert.equal((await client.testWorkflow('wf-id')).run_id,'run-id');
  await client.answerForm('message id',fixture.answer_form);
  await client.commands('room id');
  await client.commands();
  assert.deepEqual(sent.map(r=>[r.verb,r.url]),[
    ['GET','/api/v1/workflows'],['GET','/api/v1/workflows?all=true'],['GET','/api/v1/workflows/wf%20id'],
    ['POST','/api/v1/workflows'],['PUT','/api/v1/workflows/wf-id'],['DELETE','/api/v1/workflows/wf-id'],
    ['POST','/api/v1/workflows/wf-id/disable'],['POST','/api/v1/workflows/wf-id/webhook'],['GET','/api/v1/workflows/wf-id/runs'],
    ['POST','/api/v1/workflows/wf-id/test'],['POST','/api/v1/forms/message%20id/answer'],
    ['GET','/api/v1/commands?room=room%20id'],['GET','/api/v1/commands'],
  ]);
  // Bodies only where the contract has one; the action routes send none.
  assert.deepEqual(sent.filter(r=>r.body!==undefined).map(r=>JSON.parse(r.body!)),[fixture.create_workflow,fixture.update_workflow,fixture.answer_form]);
  assert.deepEqual(sent.filter(r=>r.body===undefined).map(r=>r.type),Array(10).fill(null));
});

test('workflow refusals keep their codes and never revoke the session', async()=>{
  let revoked=false;
  const client=new NativeTransport('https://example.org',async url=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/webhook'))return Response.json({code:'reauthentication_required',request_id:'reauth'},{status:403});
    if(path.endsWith('/answer'))return Response.json({code:'form_answered',request_id:'late'},{status:409});
    return Response.json({code:'revision_conflict',request_id:'moved'},{status:409});
  });
  client.restore('saved-token');client.onTokenRejected=()=>{revoked=true;};
  const code=(expected:string)=>(error:unknown)=>error instanceof NativeError && error.code===expected;
  await assert.rejects(client.updateWorkflow('wf-id',fixture.update_workflow),code('revision_conflict'));
  await assert.rejects(client.workflowWebhook('wf-id'),code('reauthentication_required'));
  await assert.rejects(client.answerForm('m',fixture.answer_form),code('form_answered'));
  assert.equal(revoked,false);
});

test('workflow payloads are validated', ()=>{
  assert.equal(decodeNative('Workflow',fixture.workflow).steps.length,4);
  assert.equal(decodeNative('WorkflowForm',fixture.workflow_form).recipient?.username,'alice');
  assert.throws(()=>decodeNative('Workflow',{...fixture.workflow,trigger:{kind:'cron'}}));
  assert.throws(()=>decodeNative('WorkflowRunList',{runs:[{...fixture.workflow_run_list.runs[0],state:'lost'}]}));
  // `answers` maps field ids to text.
  assert.equal(decodeNative('AnswerForm',fixture.answer_form).operation_id,'answer-1');
  assert.throws(()=>decodeNative('AnswerForm',{...fixture.answer_form,answers:{today:3}}));
  const withForm=decodeNative('Message',{...all.message,form:fixture.workflow_form});
  assert.equal(withForm.form?.title,'Standup');
});
