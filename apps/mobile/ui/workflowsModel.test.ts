import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import type { Step, Trigger, WorkflowForm } from '../providers/rocketvibe/protocol.generated.ts';
import { translate, type TranslateFn } from './messages.ts';
import {
  answerInput,
  cleanStep,
  defaultStep,
  defaultTrigger,
  definition,
  draftProblem,
  fieldIdFor,
  formErrorKey,
  formState,
  insertVariable,
  moveStep,
  parseForm,
  relabel,
  runErrorKey,
  slug,
  toggleDay,
  triggerSummary,
  uniqueName,
  validCommand,
  validName,
  validTime,
  variablesAt,
  waitParts,
  waitSeconds,
  workflowErrorKey,
  type WorkflowDraft,
} from './workflowsModel.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../docs/protocol/v1.fixture.json', import.meta.url), 'utf8')).workflows;
const en: TranslateFn = (key, params) => translate('en', key, params);
const fr: TranslateFn = (key, params) => translate('fr', key, params);
const rooms = (id: string) => (id === 'room-id' ? '#general' : id);

describe('triggerSummary', () => {
  test('each trigger in words, in both languages', () => {
    assert.equal(triggerSummary({ kind: 'command', name: 'standup' }, en, rooms), 'Command /standup');
    assert.equal(triggerSummary({ kind: 'member_joined', room: 'room-id' }, en, rooms), 'When someone joins #general');
    assert.equal(triggerSummary({ kind: 'webhook' }, fr, rooms), 'Appel du webhook');
    assert.equal(triggerSummary(fixture.create_workflow.trigger, en, rooms), 'Every Mon, Tue, Wed, Thu, Fri at 09:30, in #general (Europe/Paris)');
    const hourly: Trigger = { kind: 'schedule', every: 'hour', time: '08:15', timezone: 'UTC', room: 'room-id' };
    assert.equal(triggerSummary(hourly, en, rooms), 'Every hour at :15, in #general (UTC)');
    assert.equal(triggerSummary({ ...hourly, every: 'day' }, fr, rooms), 'Tous les jours à 08:15, dans #general (UTC)');
  });
});

describe('field ids', () => {
  test('a label becomes [a-z0-9_], accents dropped, 32 at most', () => {
    assert.equal(slug('Ce que j’ai fait aujourd’hui !'), 'ce_que_j_ai_fait_aujourd_hui');
    assert.equal(slug('Été 2026'), 'ete_2026');
    assert.equal(slug('   '), '');
    assert.equal(slug('x'.repeat(40)).length, 32);
  });

  test('unique within the form, never a reserved name', () => {
    assert.equal(uniqueName('Today', ['today']), 'today_2');
    assert.equal(uniqueName('Today', ['today', 'today_2']), 'today_3');
    assert.equal(uniqueName('', []), 'field');
    assert.equal(uniqueName('Now', []), 'now_2');
    assert.equal(uniqueName('trigger', []), 'trigger_2');
    assert.equal(uniqueName('y'.repeat(40), ['y'.repeat(32)]), `${'y'.repeat(30)}_2`);
    assert.ok(!validName('webhook') && !validName('A') && !validName('') && validName('a_1'));
  });

  test('a field follows its label until its id was edited', () => {
    const fields = [
      { id: 'today', label: 'Today', kind: 'text' as const },
      { id: 'answer', label: '', kind: 'text' as const },
    ];
    assert.equal(fieldIdFor('Today', fields, 1), 'today_2');
    assert.deepEqual(relabel(fields, 1, 'Mood', true)[1], { id: 'mood', label: 'Mood', kind: 'text' });
    assert.deepEqual(relabel(fields, 1, 'Mood', false)[1], { id: 'answer', label: 'Mood', kind: 'text' });
  });
});

describe('variablesAt', () => {
  const steps: Step[] = fixture.workflow.steps;
  test('the trigger, then what earlier steps saved, then now', () => {
    assert.deepEqual(variablesAt({ kind: 'command', name: 'x' }, steps, 0), [
      'trigger.user.username',
      'trigger.user.display_name',
      'trigger.room.name',
      'trigger.text',
      'now',
    ]);
    assert.deepEqual(variablesAt({ kind: 'command', name: 'x' }, steps, 3).slice(4), [
      'standup.by.username',
      'standup.by.display_name',
      'standup.answers.today',
      'standup.answers.mood',
      'log.status',
      'log.body',
      'now',
    ]);
    assert.deepEqual(variablesAt({ kind: 'webhook' }, [], 0), ['webhook', 'now']);
    assert.deepEqual(variablesAt({ kind: 'schedule', every: 'day', time: '09:00', timezone: 'UTC', room: 'r' }, [], 0), ['trigger.room.name', 'trigger.at', 'now']);
  });

  test('a chip inserts at the cursor, or at the end', () => {
    assert.deepEqual(insertVariable('Hi !', 'trigger.user.username', 3), { text: 'Hi {{trigger.user.username}}!', cursor: 28 });
    assert.equal(insertVariable('Hi', 'now').text, 'Hi{{now}}');
    assert.equal(insertVariable('Hi', 'now', 99).text, 'Hi{{now}}');
  });
});

describe('steps', () => {
  test('reordering moves one step and stops at the ends', () => {
    assert.deepEqual(moveStep(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepEqual(moveStep(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    assert.deepEqual(moveStep(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
    assert.deepEqual(moveStep(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  });

  test('waits in seconds, 1 s to 30 days', () => {
    assert.equal(waitSeconds('5', 'minutes'), 300);
    assert.equal(waitSeconds('2', 'hours'), 7200);
    assert.equal(waitSeconds('30', 'days'), 2592000);
    assert.equal(waitSeconds('31', 'days'), null);
    assert.equal(waitSeconds('1,5', 'minutes'), 90);
    assert.equal(waitSeconds('0', 'minutes'), null);
    assert.equal(waitSeconds('abc', 'hours'), null);
    assert.deepEqual(waitParts(7200), { amount: '2', unit: 'hours' });
    assert.deepEqual(waitParts(172800), { amount: '2', unit: 'days' });
    assert.deepEqual(waitParts(90), { amount: '1.5', unit: 'minutes' });
  });

  test('defaults follow the trigger', () => {
    const form = defaultStep('form', { kind: 'webhook' }, [fixture.workflow.steps[0]]);
    assert.equal(form.kind, 'form');
    if (form.kind === 'form') {
      assert.equal(form.room, '');
      assert.equal(form.recipient, 'anyone');
      assert.equal(form.save_as, 'form');
    }
    const asked = defaultStep('form', { kind: 'command', name: 'x' }, [{ ...fixture.workflow.steps[0], save_as: 'form' }]);
    if (asked.kind === 'form') {
      assert.equal(asked.room, 'trigger');
      assert.equal(asked.recipient, 'trigger_user');
      assert.equal(asked.save_as, 'form_2');
    }
    assert.deepEqual(defaultTrigger('schedule', 'Europe/Paris'), { kind: 'schedule', every: 'day', time: '09:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Paris', room: '' });
    assert.deepEqual(toggleDay([5, 1], 3), [1, 3, 5]);
    assert.deepEqual(toggleDay([1, 3], 3), [1]);
    assert.ok(validTime('23:59') && !validTime('24:00') && !validTime('9:00'));
    assert.ok(validCommand('stand-up_2') && !validCommand('shrug') && !validCommand('Up') && !validCommand(''));
  });
});

describe('what a save sends', () => {
  const draft: WorkflowDraft = {
    name: '  Standup ',
    description: ' daily ',
    botId: 'helper-id',
    enabled: true,
    trigger: { kind: 'schedule', every: 'day', time: '09:30', days: [1], timezone: ' Europe/Paris ', room: 'room-id' },
    steps: [
      { kind: 'message', room: 'trigger', text: 'Hi', save_as: '', in_thread: false },
      { kind: 'http', method: 'GET', url: ' https://example.org ', headers: [{ name: '', value: '' }, { name: ' X-A ', value: 'b' }], body: '', save_as: 'call' },
      { kind: 'form', room: 'room-id', recipient: 'anyone', title: ' Q ', save_as: 'q', fields: [{ id: 'pick', label: ' Pick ', kind: 'choice', options: ['a', ' ', ' b'] }, { id: 'n', label: 'N', kind: 'number', options: ['x'], required: true }] },
    ],
  };

  test('trimmed, empty optional fields left out, days only for a week', () => {
    assert.deepEqual(definition(draft), {
      name: 'Standup',
      description: 'daily',
      bot_id: 'helper-id',
      enabled: true,
      trigger: { kind: 'schedule', every: 'day', time: '09:30', timezone: 'Europe/Paris', room: 'room-id' },
      steps: [
        { kind: 'message', room: 'trigger', text: 'Hi' },
        { kind: 'http', method: 'GET', url: 'https://example.org', headers: [{ name: 'X-A', value: 'b' }], save_as: 'call' },
        { kind: 'form', room: 'room-id', recipient: 'anyone', title: 'Q', save_as: 'q', fields: [{ id: 'pick', label: 'Pick', kind: 'choice', required: false, options: ['a', 'b'] }, { id: 'n', label: 'N', kind: 'number', required: true }] },
      ],
    });
    const weekly = definition({ ...draft, trigger: { ...draft.trigger, every: 'week', days: [3, 1] } as Trigger });
    assert.deepEqual(weekly.trigger, { kind: 'schedule', every: 'week', time: '09:30', timezone: 'Europe/Paris', room: 'room-id', days: [1, 3] });
    assert.deepEqual(cleanStep({ kind: 'message', room: 'r', text: 't', in_thread: true, save_as: 'm' }), { kind: 'message', room: 'r', text: 't', in_thread: true, save_as: 'm' });
  });

  test('what the editor refuses before the server', () => {
    assert.equal(draftProblem(draft), null);
    assert.equal(draftProblem({ ...draft, name: ' ' }), 'workflows.needName');
    assert.equal(draftProblem({ ...draft, botId: '' }), 'workflows.needBot');
    assert.equal(draftProblem({ ...draft, trigger: { kind: 'command', name: 'me' } }), 'workflows.badCommand');
    assert.equal(draftProblem({ ...draft, trigger: { kind: 'webhook' } }), 'workflows.needStepRoom');
    assert.equal(draftProblem({ ...draft, steps: [] }), 'workflows.needStep');
    assert.equal(draftProblem({ ...draft, steps: [{ kind: 'wait', seconds: 0 }] }), 'workflows.badWait');
    const call = draft.steps[1] as Extract<Step, { kind: 'http' }>;
    assert.equal(draftProblem({ ...draft, steps: [call, { ...call, url: 'https://x' }] }), 'workflows.duplicateSaveAs');
    const form = draft.steps[2]!;
    if (form.kind === 'form') {
      assert.equal(draftProblem({ ...draft, steps: [{ ...form, recipient: 'trigger_user' }] }), 'workflows.badRecipient');
      assert.equal(draftProblem({ ...draft, steps: [{ ...form, fields: [{ id: 'a', label: 'A', kind: 'choice', options: [' '] }] }] }), 'workflows.needOptions');
      assert.equal(draftProblem({ ...draft, steps: [{ ...form, fields: [{ id: 'a', label: 'A', kind: 'text' }, { id: 'a', label: 'B', kind: 'text' }] }] }), 'workflows.badFieldId');
    }
  });
});

describe('wording', () => {
  test('every error code of WORKFLOWS.md has its sentence', () => {
    const saving = ['bots_disabled', 'workflow_limit', 'workflow_bot', 'bot_scope_missing', 'workflow_bot_not_member', 'crypto_required', 'workflow_room', 'workflow_command', 'workflow_command_taken', 'workflow_schedule', 'workflow_steps', 'workflow_message', 'workflow_wait', 'workflow_http', 'workflow_form', 'revision_conflict'];
    const running = ['workflow_unavailable', 'workflow_rate_limited', 'workflow_busy', 'http_address', 'http_url', 'http_failed', 'form_expired', 'bot_unavailable', 'workflow_retries'];
    const keys = [...saving, ...running].map((code) => workflowErrorKey(code, 400));
    assert.ok(keys.every((key) => key !== 'workflows.failed'));
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) assert.notEqual(en(key), fr(key));
    assert.equal(workflowErrorKey('mystery', 429), 'workflows.errRateLimited');
    assert.equal(workflowErrorKey('mystery', 0), 'workflows.errOffline');
    assert.equal(runErrorKey('something_new'), null);
    const forms = ['form_required', 'form_value', 'form_answered', 'form_expired', 'permission_denied'].map((code) => formErrorKey(code, 400));
    assert.ok(forms.every((key) => key !== 'forms.failed'));
  });
});

describe('forms in messages', () => {
  const form: WorkflowForm = fixture.workflow_form;
  const before = Date.parse('2026-10-10T00:00:00Z');
  test('who may answer, and when', () => {
    assert.equal(formState(form, 'alice-id', before), 'answer');
    assert.equal(formState(form, 'bob-id', before), 'other');
    assert.equal(formState({ ...form, recipient: null }, 'bob-id', before), 'answer');
    assert.equal(formState(form, 'alice-id', Date.parse('2026-10-16T00:00:00Z')), 'expired');
    assert.equal(formState({ ...form, answered_by: form.recipient }, 'alice-id', before), 'answered');
  });

  test('the stored JSON is read back, a malformed one ignored', () => {
    assert.deepEqual(parseForm(JSON.stringify(form)), form);
    assert.equal(parseForm('{"title":3}'), null);
    assert.equal(parseForm('not json'), null);
    assert.equal(parseForm(null), null);
  });

  test('answers are checked like the server checks them', () => {
    const fields = [
      { id: 'today', label: 'Today', kind: 'long_text' as const, required: true },
      { id: 'n', label: 'N', kind: 'number' as const },
      { id: 'mood', label: 'Mood', kind: 'choice' as const, options: ['good', 'meh'] },
      { id: 'note', label: 'Note', kind: 'text' as const },
    ];
    assert.deepEqual(answerInput(fields, { today: ' Reviews ', n: '1,5', mood: 'good', note: '' }), { answers: { today: 'Reviews', n: '1.5', mood: 'good' } });
    assert.deepEqual(answerInput(fields, { today: '  ' }), { field: 'today', problem: 'required' });
    assert.deepEqual(answerInput(fields, { today: 'x', n: 'twelve' }), { field: 'n', problem: 'value' });
    assert.deepEqual(answerInput(fields, { today: 'x', mood: 'great' }), { field: 'mood', problem: 'value' });
    assert.deepEqual(answerInput(fields, { today: 'x', note: 'a\nb' }), { field: 'note', problem: 'value' });
  });
});

describe('reactions, matching messages and person fields', () => {
  const draft = (trigger: Trigger, steps: Step[]): WorkflowDraft => ({ name: 'n', description: '', botId: 'bot', enabled: true, trigger, steps });
  const say: Step = { kind: 'message', room: 'trigger', text: 'hi' };

  test('a reaction trigger takes any emoji or one, colons dropped', () => {
    assert.deepEqual(definition(draft({ kind: 'reaction_added', room: 'room-id', emoji: ' :tada: ' }, [say])).trigger, { kind: 'reaction_added', room: 'room-id', emoji: 'tada' });
    assert.deepEqual(definition(draft({ kind: 'reaction_added', room: 'room-id', emoji: '  ' }, [say])).trigger, { kind: 'reaction_added', room: 'room-id' });
    assert.equal(triggerSummary({ kind: 'reaction_added', room: 'room-id', emoji: 'tada' }, en, rooms), 'Reaction :tada: in #general');
    assert.equal(triggerSummary({ kind: 'reaction_added', room: 'room-id' }, en, rooms), 'Any reaction in #general');
    assert.equal(draftProblem(draft({ kind: 'reaction_added', room: '' }, [say])), 'workflows.needRoom');
  });

  test('a matching message needs its text and offers the message to the steps', () => {
    assert.equal(draftProblem(draft({ kind: 'message_posted', room: 'room-id', contains: ' ' }, [say])), 'workflows.needMatch');
    assert.equal(draftProblem(draft({ kind: 'message_posted', room: 'room-id', contains: 'x'.repeat(101) }, [say])), 'workflows.needMatch');
    assert.equal(draftProblem(draft({ kind: 'message_posted', room: 'room-id', contains: 'deploy' }, [say])), null);
    assert.equal(triggerSummary({ kind: 'message_posted', room: 'room-id', contains: 'deploy' }, en, rooms), 'Message containing “deploy” in #general');
    const trigger: Trigger = { kind: 'message_posted', room: 'room-id', contains: 'deploy' };
    assert.ok(variablesAt(trigger, [say], 0).includes('trigger.message.text'));
    // The author can be the one a form asks.
    assert.equal((defaultStep('form', trigger, []) as Extract<Step, { kind: 'form' }>).recipient, 'trigger_user');
    assert.equal(workflowErrorKey('workflow_emoji', 400), 'workflows.errEmoji');
  });

  test('a person field sends its people only when it names some', () => {
    const form = (people?: string[]): Step => ({
      kind: 'form',
      room: 'trigger',
      recipient: 'anyone',
      title: 'Assign',
      save_as: 'task',
      fields: [{ id: 'owner', label: 'Owner', kind: 'person', options: ['stale'], ...(people === undefined ? {} : { people }), required: true }],
    });
    const fields = (step: Step) => (step.kind === 'form' ? step.fields : []);
    assert.deepEqual(fields(cleanStep(form([]))), [{ id: 'owner', label: 'Owner', kind: 'person', required: true }]);
    assert.deepEqual(fields(cleanStep(form(['u1', 'u2']))), [{ id: 'owner', label: 'Owner', kind: 'person', required: true, people: ['u1', 'u2'] }]);
    assert.ok(variablesAt({ kind: 'command', name: 'x' }, [form(), say], 1).includes('task.people.owner.display_name'));
    const field = fields(form(['u1']))[0]!;
    assert.deepEqual(answerInput([field], { owner: 'u1' }), { answers: { owner: 'u1' } });
    assert.deepEqual(answerInput([field], { owner: 'u9' }), { field: 'owner', problem: 'value' });
    // Anyone in the room: the server checks the membership.
    assert.deepEqual(answerInput(fields(form()), { owner: 'u9' }), { answers: { owner: 'u9' } });
  });

  test('every new wording exists in both languages', () => {
    for (const key of ['workflows.triggerReaction', 'workflows.triggerMessage', 'workflows.fieldPerson', 'workflows.peopleRoom', 'forms.choosePerson'] as const) {
      assert.notEqual(en(key), key);
      assert.notEqual(fr(key), key);
    }
  });
});

describe('several answers', () => {
  const choice = { id: 'tags', label: 'Tags', kind: 'choice' as const, options: ['a', 'b', 'c'], multiple: true, required: true };

  test('ticked boxes go out as a list in the options order, checked against them', () => {
    assert.deepEqual(answerInput([choice], { tags: ['c', 'a', 'a'] }), { answers: { tags: ['a', 'c'] } });
    assert.deepEqual(answerInput([choice], { tags: [] }), { field: 'tags', problem: 'required' });
    assert.deepEqual(answerInput([choice], { tags: ['z'] }), { field: 'tags', problem: 'value' });
    // A list where one answer is expected is refused.
    assert.deepEqual(answerInput([{ ...choice, multiple: false }], { tags: ['a'] }), { field: 'tags', problem: 'value' });
    // Anyone in the room: the server checks who.
    assert.deepEqual(answerInput([{ id: 'who', label: 'Who', kind: 'person', multiple: true }], { who: ['u2', 'u1'] }), { answers: { who: ['u2', 'u1'] } });
  });

  test('several answers are kept only on a choice or a person', () => {
    const step = (kind: 'text' | 'choice'): Step => ({
      kind: 'form',
      room: 'trigger',
      recipient: 'anyone',
      title: 'T',
      save_as: 'x',
      fields: [{ id: 'f', label: 'F', kind, options: kind === 'choice' ? ['a'] : [], multiple: true }],
    });
    const field = (s: Step) => (s.kind === 'form' ? s.fields[0] : undefined);
    assert.equal(field(cleanStep(step('text')))?.multiple, undefined);
    assert.equal(field(cleanStep(step('choice')))?.multiple, true);
    const person: Step = { kind: 'form', room: 'trigger', recipient: 'anyone', title: 'T', save_as: 'x', fields: [{ id: 'who', label: 'Who', kind: 'person', multiple: true }] };
    const names = variablesAt({ kind: 'command', name: 'c' }, [person, { kind: 'message', room: 'trigger', text: '' }], 1);
    assert.ok(names.includes('x.mentions.who'));
    assert.ok(!names.includes('x.people.who.display_name'));
  });
});
