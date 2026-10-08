/**
 * The pure part of the "Workflows" page (`ui/workflows.tsx`) and of the forms
 * workflows post (`ui/messageRow.tsx`, `app/answer-form.tsx`), RFC 0004,
 * `docs/protocol/WORKFLOWS.md`: defaults, a trigger in words, field ids derived
 * from labels, the variables a step may use, step reordering, waits in
 * seconds, what a save sends, the wording of the server's refusals and of a
 * run's error, and a form's state for the reader.
 * Loadable by plain Node, tested in `ui/workflowsModel.test.ts`.
 */

import type {
  CreateWorkflow,
  Every,
  FormField,
  FormFieldKind,
  HttpMethod,
  RunState,
  Step,
  Trigger,
  WorkflowForm,
} from '../providers/rocketvibe/protocol.generated.ts';
import { decodeNative } from '../providers/rocketvibe/validation.ts';
import type { TranslateFn, TranslationKey } from './messages.ts';

export type TriggerKind = Trigger['kind'];
export type StepKind = Step['kind'];

export const TRIGGER_KINDS: readonly TriggerKind[] = ['command', 'schedule', 'member_joined', 'reaction_added', 'message_posted', 'webhook'];
export const STEP_KINDS: readonly StepKind[] = ['message', 'wait', 'http', 'form'];
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const FIELD_KINDS: readonly FormFieldKind[] = ['text', 'long_text', 'number', 'choice', 'person'];
export const EVERY: readonly Every[] = ['hour', 'day', 'week'];
/** ISO weekdays, 1 Monday to 7 Sunday, the order of the chips. */
export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
/** `room: "trigger"`: the room of what started the run. */
export const TRIGGER_ROOM = 'trigger';
/** The server's limits (`crates/rv-protocol/src/workflows.rs`). */
export const LIMITS = { workflows: 20, steps: 20, fields: 10, headers: 10, options: 20, people: 50, match: 100, waitSeconds: 30 * 24 * 3600 } as const;
/** Names a `save_as` or a field id may not take: the run's own context. */
const RESERVED = ['trigger', 'webhook', 'now'];
/** The server's core commands: a workflow command cannot take their names. */
const CORE_COMMANDS = ['gimme', 'invite', 'join', 'kick', 'leave', 'lennyface', 'me', 'msg', 'shrug', 'status', 'tableflip', 'topic', 'unflip'];

export const TRIGGER_TEXT: Record<TriggerKind, TranslationKey> = {
  command: 'workflows.triggerCommand',
  schedule: 'workflows.triggerSchedule',
  member_joined: 'workflows.triggerJoined',
  reaction_added: 'workflows.triggerReaction',
  message_posted: 'workflows.triggerMessage',
  webhook: 'workflows.triggerWebhook',
};
export const STEP_TEXT: Record<StepKind, TranslationKey> = {
  message: 'workflows.stepMessage',
  wait: 'workflows.stepWait',
  http: 'workflows.stepHttp',
  form: 'workflows.stepForm',
};
export const FIELD_TEXT: Record<FormFieldKind, TranslationKey> = {
  text: 'workflows.fieldText',
  long_text: 'workflows.fieldLongText',
  number: 'workflows.fieldNumber',
  choice: 'workflows.fieldChoice',
  person: 'workflows.fieldPerson',
};
export const EVERY_TEXT: Record<Every, TranslationKey> = {
  hour: 'workflows.everyHour',
  day: 'workflows.everyDay',
  week: 'workflows.everyWeek',
};
export const RUN_STATE_TEXT: Record<RunState, TranslationKey> = {
  pending: 'workflows.runPending',
  waiting: 'workflows.runWaiting',
  done: 'workflows.runDone',
  failed: 'workflows.runFailed',
  cancelled: 'workflows.runCancelled',
};
const DAY_TEXT: Record<number, TranslationKey> = {
  1: 'workflows.day1',
  2: 'workflows.day2',
  3: 'workflows.day3',
  4: 'workflows.day4',
  5: 'workflows.day5',
  6: 'workflows.day6',
  7: 'workflows.day7',
};
export function dayText(day: number): TranslationKey {
  return DAY_TEXT[day] ?? 'workflows.day1';
}

/** The device's IANA time zone (`Europe/Paris`), `UTC` when the engine cannot tell. */
export function deviceTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

export function hasTriggerRoom(trigger: Trigger): boolean {
  return trigger.kind !== 'webhook';
}
export function hasTriggerUser(trigger: Trigger): boolean {
  return trigger.kind !== 'schedule' && trigger.kind !== 'webhook';
}

/** The triggers that watch what people do in a room: they need the bot's `rooms:read`. */
export function watchesRoom(trigger: Trigger): boolean {
  return trigger.kind === 'reaction_added' || trigger.kind === 'message_posted';
}

export function defaultTrigger(kind: TriggerKind, timezone: string): Trigger {
  switch (kind) {
    case 'command':
      return { kind, name: '' };
    case 'schedule':
      return { kind, every: 'day', time: '09:00', days: [1, 2, 3, 4, 5], timezone, room: '' };
    case 'member_joined':
      return { kind, room: '' };
    case 'reaction_added':
      return { kind, room: '' };
    case 'message_posted':
      return { kind, room: '', contains: '' };
    case 'webhook':
      return { kind };
  }
}

/** A new step, its room the trigger's when there is one, its `save_as` free. */
export function defaultStep(kind: StepKind, trigger: Trigger, steps: readonly Step[]): Step {
  const room = hasTriggerRoom(trigger) ? TRIGGER_ROOM : '';
  switch (kind) {
    case 'message':
      return { kind, room, text: '' };
    case 'wait':
      return { kind, seconds: 3600 };
    case 'http':
      return { kind, method: 'POST', url: 'https://', headers: [] };
    case 'form':
      return {
        kind,
        room,
        recipient: hasTriggerUser(trigger) ? 'trigger_user' : 'anyone',
        title: '',
        fields: [{ id: 'answer', label: '', kind: 'text', required: true }],
        save_as: uniqueName('form', savedNames(steps)),
      };
  }
}

/**
 * A label made into an id: `[a-z0-9_]`, accents dropped, anything else an
 * underscore, 32 characters at most; empty when nothing is left.
 */
export function slug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)
    .replace(/_+$/, '');
}

/** `[a-z0-9_]{1,32}`, not `trigger`, `webhook` nor `now`: a `save_as` or a field id the server takes. */
export function validName(value: string): boolean {
  return /^[a-z0-9_]{1,32}$/.test(value) && !RESERVED.includes(value);
}

/** `base` made a valid name no one in `taken` has (`_2`, `_3`... appended). */
export function uniqueName(base: string, taken: Iterable<string>, fallback = 'field'): string {
  const used = new Set(taken);
  const stem = slug(base) || fallback;
  let candidate = stem;
  for (let n = 2; used.has(candidate) || !validName(candidate); n++) {
    const suffix = `_${n}`;
    candidate = stem.slice(0, 32 - suffix.length) + suffix;
  }
  return candidate;
}

/** The id a field gets from its label, unique among the form's other fields. */
export function fieldIdFor(label: string, fields: readonly FormField[], index: number): string {
  return uniqueName(label, fields.filter((_, i) => i !== index).map((f) => f.id));
}

/** The ids of a form whose labels changed: each field follows its label unless its id was edited by hand. */
export function relabel(fields: readonly FormField[], index: number, label: string, followLabel: boolean): FormField[] {
  return fields.map((field, i) => {
    if (i !== index) return field;
    return { ...field, label, id: followLabel ? fieldIdFor(label, fields, index) : field.id };
  });
}

/** The `save_as` names of the steps, the context they add to the run. */
export function savedNames(steps: readonly Step[]): string[] {
  return steps.flatMap((step) => (step.kind !== 'wait' && step.save_as != null && step.save_as !== '' ? [step.save_as] : []));
}

/**
 * The variables a template of the step at `index` may use, without braces:
 * the trigger's, what the steps before it saved, and `now`.
 */
export function variablesAt(trigger: Trigger, steps: readonly Step[], index: number): string[] {
  const names: string[] = [];
  switch (trigger.kind) {
    case 'command':
      names.push('trigger.user.username', 'trigger.user.display_name', 'trigger.room.name', 'trigger.text');
      break;
    case 'schedule':
      names.push('trigger.room.name', 'trigger.at');
      break;
    case 'member_joined':
      names.push('trigger.user.username', 'trigger.user.display_name', 'trigger.room.name');
      break;
    case 'reaction_added':
      names.push('trigger.user.username', 'trigger.user.display_name', 'trigger.room.name', 'trigger.emoji', 'trigger.message.text', 'trigger.message.author.username');
      break;
    case 'message_posted':
      names.push('trigger.user.username', 'trigger.user.display_name', 'trigger.room.name', 'trigger.message.text');
      break;
    case 'webhook':
      names.push('webhook');
      break;
  }
  for (const step of steps.slice(0, Math.max(0, index))) {
    if (step.kind === 'wait' || step.save_as == null || !validName(step.save_as)) continue;
    const saved = step.save_as;
    if (step.kind === 'message') names.push(`${saved}.message_id`);
    if (step.kind === 'http') names.push(`${saved}.status`, `${saved}.body`);
    if (step.kind === 'form') {
      names.push(`${saved}.by.username`, `${saved}.by.display_name`);
      for (const field of step.fields) {
        if (!validName(field.id)) continue;
        names.push(`${saved}.answers.${field.id}`);
        if (field.kind === 'person') names.push(`${saved}.people.${field.id}.display_name`);
      }
    }
  }
  names.push('now');
  return names;
}

/** `text` with `{{name}}` put at `at` (the cursor; the end when unknown). */
export function insertVariable(text: string, name: string, at?: number): { text: string; cursor: number } {
  const place = at === undefined || at < 0 || at > text.length ? text.length : at;
  const inserted = `{{${name}}}`;
  return { text: text.slice(0, place) + inserted + text.slice(place), cursor: place + inserted.length };
}

/** `list` with the item at `index` moved by `delta` (-1 up, 1 down); unchanged at an end. */
export function moveStep<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  const next = [...list];
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

export function removeAt<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

export function replaceAt<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((current, i) => (i === index ? item : current));
}

export type WaitUnit = 'minutes' | 'hours' | 'days';
export const WAIT_UNITS: readonly WaitUnit[] = ['minutes', 'hours', 'days'];
const UNIT_SECONDS: Record<WaitUnit, number> = { minutes: 60, hours: 3600, days: 86400 };
export const UNIT_TEXT: Record<WaitUnit, TranslationKey> = {
  minutes: 'workflows.unitMinutes',
  hours: 'workflows.unitHours',
  days: 'workflows.unitDays',
};

/** A wait in seconds, 1 s to 30 days; `null` for anything else. */
export function waitSeconds(amount: string, unit: WaitUnit): number | null {
  const trimmed = amount.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const seconds = Math.round(Number(trimmed) * UNIT_SECONDS[unit]);
  return seconds >= 1 && seconds <= LIMITS.waitSeconds ? seconds : null;
}

/** A wait shown in the largest unit that keeps it whole (minutes otherwise). */
export function waitParts(seconds: number): { amount: string; unit: WaitUnit } {
  for (const unit of ['days', 'hours'] as const) {
    if (seconds >= UNIT_SECONDS[unit] && seconds % UNIT_SECONDS[unit] === 0) return { amount: String(seconds / UNIT_SECONDS[unit]), unit };
  }
  return { amount: String(Math.round((seconds / 60) * 100) / 100), unit: 'minutes' };
}

/** `HH:MM`, 00:00 to 23:59. */
export function validTime(text: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text);
}

/** A command name the server may take: `[a-z0-9_-]{1,32}`, not a core command. */
export function validCommand(name: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(name) && !CORE_COMMANDS.includes(name);
}

export function toggleDay(days: readonly number[], day: number): number[] {
  const next = new Set(days);
  if (next.has(day)) next.delete(day);
  else next.add(day);
  return WEEKDAYS.filter((d) => next.has(d));
}

/** The trigger in words, for the list and the editor. */
export function triggerSummary(trigger: Trigger, t: TranslateFn, roomName: (id: string) => string): string {
  switch (trigger.kind) {
    case 'command':
      return t('workflows.summaryCommand', { name: trigger.name });
    case 'member_joined':
      return t('workflows.summaryJoined', { room: roomName(trigger.room) });
    case 'reaction_added':
      return trigger.emoji != null && trigger.emoji !== ''
        ? t('workflows.summaryReaction', { emoji: trigger.emoji, room: roomName(trigger.room) })
        : t('workflows.summaryAnyReaction', { room: roomName(trigger.room) });
    case 'message_posted':
      return t('workflows.summaryMessage', { text: trigger.contains, room: roomName(trigger.room) });
    case 'webhook':
      return t('workflows.summaryWebhook');
    case 'schedule': {
      const room = roomName(trigger.room);
      const zone = trigger.timezone;
      if (trigger.every === 'hour') return t('workflows.summaryHourly', { minute: trigger.time.slice(3), room, zone });
      if (trigger.every === 'day') return t('workflows.summaryDaily', { time: trigger.time, room, zone });
      const days = WEEKDAYS.filter((d) => (trigger.days ?? []).includes(d))
        .map((d) => t(dayText(d)))
        .join(', ');
      return t('workflows.summaryWeekly', { days: days || '-', time: trigger.time, room, zone });
    }
  }
}

/** What the trigger sends: trimmed, the days only for a weekly schedule. */
export function cleanTrigger(trigger: Trigger): Trigger {
  switch (trigger.kind) {
    case 'command':
      return { kind: 'command', name: trigger.name.trim() };
    case 'schedule': {
      const { days, ...rest } = trigger;
      return rest.every === 'week'
        ? { ...rest, timezone: rest.timezone.trim(), days: WEEKDAYS.filter((d) => (days ?? []).includes(d)) }
        : { ...rest, timezone: rest.timezone.trim() };
    }
    case 'reaction_added': {
      // `:tada:` as typed is `tada`; nothing at all is any emoji.
      const emoji = (trigger.emoji ?? '').trim().replace(/^:+|:+$/g, '');
      return emoji === '' ? { kind: 'reaction_added', room: trigger.room } : { kind: 'reaction_added', room: trigger.room, emoji };
    }
    case 'message_posted':
      return { kind: 'message_posted', room: trigger.room, contains: trigger.contains.trim() };
    default:
      return trigger;
  }
}

/** What a step sends: optional fields left out when empty, choices only on a choice. */
export function cleanStep(step: Step): Step {
  const saveAs = (value: string | null | undefined) => (value == null || value.trim() === '' ? {} : { save_as: value.trim() });
  switch (step.kind) {
    case 'message': {
      const { save_as, in_thread, ...rest } = step;
      return { ...rest, ...(in_thread === true ? { in_thread: true } : {}), ...saveAs(save_as) };
    }
    case 'wait':
      return step;
    case 'http': {
      const { save_as, headers, body, continue_on_error, ...rest } = step;
      const kept = (headers ?? []).map((h) => ({ name: h.name.trim(), value: h.value })).filter((h) => h.name !== '' || h.value !== '');
      return {
        ...rest,
        url: rest.url.trim(),
        ...(kept.length > 0 ? { headers: kept } : {}),
        ...(body != null && body !== '' ? { body } : {}),
        ...(continue_on_error === true ? { continue_on_error: true } : {}),
        ...saveAs(save_as),
      };
    }
    case 'form':
      return {
        ...step,
        title: step.title.trim(),
        save_as: step.save_as.trim(),
        fields: step.fields.map((field) => {
          const { options, people, ...rest } = field;
          const label = rest.label.trim();
          if (field.kind === 'choice') {
            return { ...rest, label, required: rest.required === true, options: (options ?? []).map((o) => o.trim()).filter((o) => o !== '') };
          }
          // A person field without people offers the whole room.
          if (field.kind === 'person' && people != null && people.length > 0) return { ...rest, label, required: rest.required === true, people: [...people] };
          return { ...rest, label, required: rest.required === true };
        }),
      };
  }
}

export type WorkflowDraft = {
  name: string;
  description: string;
  botId: string;
  enabled: boolean;
  trigger: Trigger;
  steps: Step[];
};

/** The body of a save (`CreateWorkflow` without its operation id, `UpdateWorkflow` without it and the revision). */
export function definition(draft: WorkflowDraft): Omit<CreateWorkflow, 'operation_id'> & { enabled: boolean } {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    bot_id: draft.botId,
    enabled: draft.enabled,
    trigger: cleanTrigger(draft.trigger),
    steps: draft.steps.map(cleanStep),
  };
}

/**
 * What the editor can tell before the server does, as a sentence key; `null`
 * when nothing is missing. The server still decides (rooms, bot, scopes).
 */
export function draftProblem(draft: WorkflowDraft): TranslationKey | null {
  if (draft.name.trim() === '') return 'workflows.needName';
  if (draft.botId === '') return 'workflows.needBot';
  const trigger = draft.trigger;
  if (trigger.kind === 'command' && !validCommand(trigger.name.trim())) return 'workflows.badCommand';
  if (trigger.kind === 'schedule') {
    if (!validTime(trigger.time)) return 'workflows.badTime';
    if (trigger.every === 'week' && (trigger.days ?? []).length === 0) return 'workflows.needDays';
    if (trigger.timezone.trim() === '') return 'workflows.badZone';
  }
  if (trigger.kind !== 'command' && trigger.kind !== 'webhook' && trigger.room === '') return 'workflows.needRoom';
  if (trigger.kind === 'message_posted') {
    const contains = trigger.contains.trim();
    if (contains === '' || new TextEncoder().encode(contains).length > LIMITS.match) return 'workflows.needMatch';
  }
  if (draft.steps.length === 0) return 'workflows.needStep';
  if (draft.steps.length > LIMITS.steps) return 'workflows.tooManySteps';
  const names = new Set<string>();
  for (const step of draft.steps) {
    if (step.kind === 'wait') {
      if (!Number.isInteger(step.seconds) || step.seconds < 1 || step.seconds > LIMITS.waitSeconds) return 'workflows.badWait';
      continue;
    }
    const saved = step.save_as?.trim() ?? '';
    if (saved !== '') {
      if (!validName(saved)) return 'workflows.badSaveAs';
      if (names.has(saved)) return 'workflows.duplicateSaveAs';
      names.add(saved);
    }
    if (step.kind === 'message' || step.kind === 'form') {
      if (step.room === '' || (step.room === TRIGGER_ROOM && !hasTriggerRoom(trigger))) return 'workflows.needStepRoom';
    }
    if (step.kind === 'message' && step.text.trim() === '') return 'workflows.needText';
    if (step.kind === 'http' && !/^https?:\/\/\S/.test(step.url.trim())) return 'workflows.badUrl';
    if (step.kind === 'form') {
      if (step.title.trim() === '') return 'workflows.needTitle';
      if (saved === '') return 'workflows.badSaveAs';
      if (step.recipient === 'trigger_user' && !hasTriggerUser(trigger)) return 'workflows.badRecipient';
      if (step.fields.length === 0 || step.fields.length > LIMITS.fields) return 'workflows.needFields';
      const ids = new Set<string>();
      for (const field of step.fields) {
        if (field.label.trim() === '') return 'workflows.needLabel';
        if (!validName(field.id) || ids.has(field.id)) return 'workflows.badFieldId';
        ids.add(field.id);
        if (field.kind === 'choice' && (field.options ?? []).filter((o) => o.trim() !== '').length === 0) return 'workflows.needOptions';
        if (field.kind === 'person' && (field.people ?? []).length > LIMITS.people) return 'workflows.tooManyPeople';
      }
    }
  }
  return null;
}

/** The sentence for a refused workflow call, from the server's error code. */
export function workflowErrorKey(code: string, status: number): TranslationKey {
  const known = codeKey(code);
  if (known !== null) return known;
  if (status === 429) return 'workflows.errRateLimited';
  if (status === 0 || status >= 500 || code === 'offline' || code === 'session_closed') return 'workflows.errOffline';
  return 'workflows.failed';
}

/** A run's `error` in words; `null` for a code the app does not know (then shown as is). */
export function runErrorKey(code: string): TranslationKey | null {
  return codeKey(code);
}

function codeKey(code: string): TranslationKey | null {
  switch (code) {
    case 'bots_disabled':
      return 'workflows.errBotsDisabled';
    case 'workflow_limit':
      return 'workflows.errLimit';
    case 'workflow_bot':
      return 'workflows.errBot';
    case 'bot_scope_missing':
      return 'workflows.errScope';
    case 'workflow_bot_not_member':
      return 'workflows.errNotMember';
    case 'crypto_required':
      return 'workflows.errEncrypted';
    case 'workflow_room':
      return 'workflows.errRoom';
    case 'workflow_command':
      return 'workflows.errCommand';
    case 'workflow_command_taken':
      return 'workflows.errCommandTaken';
    case 'workflow_schedule':
      return 'workflows.errSchedule';
    case 'workflow_steps':
      return 'workflows.errSteps';
    case 'workflow_message':
      return 'workflows.errMessage';
    case 'workflow_wait':
      return 'workflows.errWait';
    case 'workflow_http':
      return 'workflows.errHttp';
    case 'workflow_form':
      return 'workflows.errForm';
    case 'workflow_match':
      return 'workflows.needMatch';
    case 'workflow_emoji':
      return 'workflows.errEmoji';
    case 'revision_conflict':
      return 'workflows.errConflict';
    case 'workflow_unavailable':
      return 'workflows.errUnavailable';
    case 'workflow_rate_limited':
      return 'workflows.errRunRate';
    case 'workflow_busy':
      return 'workflows.errBusy';
    case 'http_address':
      return 'workflows.errHttpAddress';
    case 'http_url':
      return 'workflows.errHttpUrl';
    case 'http_failed':
      return 'workflows.errHttpFailed';
    case 'form_expired':
      return 'workflows.errFormExpired';
    case 'bot_unavailable':
      return 'workflows.errBotUnavailable';
    case 'bot_rate_limited':
      return 'workflows.errBotRate';
    case 'workflow_retries':
      return 'workflows.errRetries';
    case 'reauthentication_required':
      return 'workflows.errReauth';
    case 'invalid_request':
      return 'workflows.errInvalid';
    case 'not_found':
      return 'workflows.errNotFound';
    case 'permission_denied':
      return 'workflows.errDenied';
    default:
      return null;
  }
}

/** The sentence for a refused answer to a form. */
export function formErrorKey(code: string, status: number): TranslationKey {
  switch (code) {
    case 'form_required':
      return 'forms.errRequired';
    case 'form_value':
      return 'forms.errValue';
    case 'form_answered':
      return 'forms.errAnswered';
    case 'form_expired':
      return 'forms.errExpired';
    case 'permission_denied':
      return 'forms.errDenied';
    case 'not_found':
      return 'forms.errNotFound';
  }
  if (status === 429) return 'forms.errRateLimited';
  if (status === 0 || status >= 500 || code === 'offline' || code === 'session_closed') return 'forms.errOffline';
  return 'forms.failed';
}

/** The form a message carries (its stored JSON), `null` when absent or malformed. */
export function parseForm(json: string | null | undefined): WorkflowForm | null {
  if (json == null || json === '') return null;
  try {
    return decodeNative('WorkflowForm', JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * What the card offers its reader: `answered` (by someone), `expired`,
 * `answer` (mine to answer: I am the recipient, or there is none) or `other`
 * (someone else's).
 */
export function formState(form: WorkflowForm, me: string | null, now: number): 'answered' | 'expired' | 'answer' | 'other' {
  if (form.answered_by != null) return 'answered';
  const expires = Date.parse(form.expires_at);
  if (Number.isFinite(expires) && expires <= now) return 'expired';
  if (form.recipient != null && form.recipient.id !== me) return 'other';
  return 'answer';
}

/**
 * The answers to send, trimmed and without the empty optional ones; or the
 * first field the server would refuse, and why.
 */
export function answerInput(
  fields: readonly FormField[],
  values: Readonly<Record<string, string>>,
): { answers: Record<string, string> } | { field: string; problem: 'required' | 'value' } {
  const answers: Record<string, string> = {};
  for (const field of fields) {
    const value = (values[field.id] ?? '').trim();
    if (value === '') {
      if (field.required === true) return { field: field.id, problem: 'required' };
      continue;
    }
    const ok =
      field.kind === 'number'
        ? Number.isFinite(Number(value.replace(',', '.'))) && /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(value)
        : field.kind === 'choice'
          ? (field.options ?? []).includes(value)
          : field.kind === 'person'
            ? (field.people ?? []).length === 0 || (field.people ?? []).includes(value)
          : field.kind === 'text'
            ? !value.includes('\n') && new TextEncoder().encode(value).length <= 1024
            : new TextEncoder().encode(value).length <= 4096;
    if (!ok) return { field: field.id, problem: 'value' };
    answers[field.id] = field.kind === 'number' ? value.replace(',', '.') : value;
  }
  return { answers };
}
