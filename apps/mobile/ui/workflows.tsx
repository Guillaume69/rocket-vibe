/**
 * "Workflows", a settings category on a RocketVibe server announcing
 * `workflows` (RFC 0004, `docs/protocol/WORKFLOWS.md`): my workflows, creating
 * one (when `create_bot` allows it, the same rule as bots), and an editor: a
 * name, the bot it acts through, a trigger and its settings, steps to add,
 * edit, reorder and remove, the variables each template may use, then save,
 * test, turn off, delete, the run history and, for a webhook, its URL.
 * Built like `ui/bots.tsx`: remounted per provider, every answer dropped once
 * the page lost focus or a newer call started, the webhook URL (it holds its
 * secret) needing a recent sign-in confirmed in place and shown ONCE, from
 * memory only, gone when dismissed or when the page closes.
 *
 * Pickers (bot, room, kinds) are inline lists of native rows: no modal.
 * Rooms come from the local database (unencrypted ones); the server decides
 * whether the bot belongs to them, its refusal worded.
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Alert, AppState, Platform, StyleSheet, Switch, Text, View } from 'react-native';

import { rooms as roomsTable } from '../db/schema.ts';
import type { LocalDatabase } from '../db/client.ts';
import type { NativeChat } from '../providers/rocketvibe/chat.ts';
import type { Bot, FormField, FormRecipient, Step, Trigger, Workflow, WorkflowRun } from '../providers/rocketvibe/protocol.generated.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { useAdminFormat } from './adminKit.tsx';
import { dismissible } from './alerts.ts';
import { providerKey } from './devices.tsx';
import { useT } from './i18n.ts';
import { PillField } from './kit.tsx';
import type { TranslationKey } from './messages.ts';
import { ConfirmNativeIdentity } from './nativeSecurity.tsx';
import { useSync } from './sync.tsx';
import { Tappable } from './tappable.tsx';
import { FONTS, type Colors } from './theme.ts';
import {
  EVERY,
  EVERY_TEXT,
  FIELD_KINDS,
  FIELD_TEXT,
  HTTP_METHODS,
  LIMITS,
  RUN_STATE_TEXT,
  STEP_KINDS,
  STEP_TEXT,
  TRIGGER_KINDS,
  TRIGGER_ROOM,
  TRIGGER_TEXT,
  UNIT_TEXT,
  WAIT_UNITS,
  WEEKDAYS,
  dayText,
  defaultStep,
  defaultTrigger,
  definition,
  deviceTimeZone,
  draftProblem,
  fieldIdFor,
  hasTriggerRoom,
  hasTriggerUser,
  insertVariable,
  moveStep,
  relabel,
  removeAt,
  replaceAt,
  runErrorKey,
  toggleDay,
  triggerSummary,
  uniqueName,
  variablesAt,
  waitParts,
  waitSeconds,
  workflowErrorKey,
  type WaitUnit,
  type WorkflowDraft,
} from './workflowsModel.ts';

const MONO = Platform.select({ android: 'monospace', default: 'Menlo' });
/** Who answers a form; `trigger_user` only with a trigger that has a person. */
const RECIPIENTS: readonly FormRecipient[] = ['trigger_user', 'anyone'];

/** The server offers workflows (also what shows the settings category). */
export function hasWorkflows(chat: NativeChat | null | undefined): boolean {
  return !!chat?.capabilities?.workflows;
}

export function WorkflowsSection({ c, baseUrl }: { c: Colors; baseUrl: string }) {
  const sync = useSync();
  const chat = sync.phase === 'ready' ? sync.provider.native?.chat : null;
  const base = sync.phase === 'ready' ? sync.base : null;
  return chat && hasWorkflows(chat) ? <Workflows key={providerKey(chat)} c={c} chat={chat} base={base} baseUrl={baseUrl} /> : null;
}

type Screen = { kind: 'list' } | { kind: 'edit'; id: string | null };
/** Where a refusal shows: atop the card, or beside the webhook action when its URL was refused. */
type Failure = { key: TranslationKey; reauth: boolean; at: 'page' | 'webhook' };
type RoomChoice = { id: string; label: string };

function failure(e: unknown, at: Failure['at']): Failure {
  if (e instanceof NativeError) return { key: workflowErrorKey(e.code, e.status), reauth: e.code === 'reauthentication_required', at };
  return { key: 'workflows.failed', reauth: false, at };
}

/** A server timestamp in the app's language, to the minute. */
function useDate(): (value: string | null | undefined) => string {
  const { dateTime } = useAdminFormat();
  return (value) => {
    if (value == null) return '';
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? dateTime(ms) : value;
  };
}

/** My unencrypted rooms, by name: what a trigger or a step may name. */
async function readRooms(base: LocalDatabase | null): Promise<RoomChoice[]> {
  if (base === null) return [];
  const rows = await base
    .select({ rid: roomsTable.rid, name: roomsTable.name, displayName: roomsTable.displayName, type: roomsTable.type, encrypted: roomsTable.encrypted })
    .from(roomsTable);
  return rows
    .filter((r) => !r.encrypted)
    .map((r) => ({ id: r.rid, label: `${r.type === 'd' ? '@' : '#'}${r.displayName ?? r.name ?? r.rid}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function Workflows({ c, chat, base, baseUrl }: { c: Colors; chat: NativeChat; base: LocalDatabase | null; baseUrl: string }) {
  const t = useT();
  const [list, setList] = useState<Workflow[] | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [rooms, setRooms] = useState<RoomChoice[]>([]);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [loaded, setLoaded] = useState<Workflow | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [webhook, setWebhook] = useState<{ workflow: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A reload after a conflict replaces the draft even at the same revision.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const alive = useRef(false);
  const epoch = useRef(0);
  const inFlight = useRef<number | null>(null);
  const screenRef = useRef<Screen>({ kind: 'list' });
  // One intent per filled form: a retry after a lost answer replays it and
  // gets the same workflow back, instead of a second one.
  const saveOperation = useRef<string | null>(null);

  const go = useCallback((next: Screen) => {
    screenRef.current = next;
    setScreen(next);
    setError(null);
    setNotice(null);
    setConfirming(false);
    saveOperation.current = null;
  }, []);

  /** One call at a time; then the list, my permission, my bots, my rooms and, in the editor, the workflow and its runs. */
  const run = useCallback(
    async (action: (visible: () => boolean) => Promise<void>, at: Failure['at'] = 'page') => {
      if (!alive.current || inFlight.current !== null) return;
      const n = epoch.current;
      const visible = () => alive.current && epoch.current === n;
      inFlight.current = n;
      setBusy(true);
      setError(null);
      setNotice(null);
      let stage: Failure['at'] = at;
      try {
        await action(visible);
        stage = 'page';
        if (!visible()) return;
        const [listed, permissions, owned] = await chat.workflows((tr) =>
          Promise.all([tr.workflows(), tr.accountPermissions(), tr.bots().catch(() => ({ bots: [] as Bot[] }))]),
        );
        const mine = await readRooms(base).catch(() => [] as RoomChoice[]);
        if (!visible()) return;
        setList(listed.workflows);
        setCanCreate(permissions.create_bot === true);
        setBots(owned.bots);
        setRooms(mine);
        const current = screenRef.current;
        if (current.kind === 'edit' && current.id !== null) {
          const id = current.id;
          if (!listed.workflows.some((w) => w.id === id)) {
            go({ kind: 'list' });
            return;
          }
          const [workflow, history] = await chat.workflows((tr) => Promise.all([tr.workflow(id), tr.workflowRuns(id)]));
          if (visible() && screenRef.current === current) {
            setLoaded(workflow);
            setRuns(history.runs);
          }
        }
      } catch (e) {
        if (visible()) setError(failure(e, stage));
      } finally {
        if (inFlight.current === n) {
          inFlight.current = null;
          if (visible()) setBusy(false);
        }
      }
    },
    [chat, base, go],
  );

  useFocusEffect(
    useCallback(() => {
      alive.current = true;
      epoch.current++;
      inFlight.current = null;
      queueMicrotask(() => {
        if (alive.current) void run(async () => {});
      });
      return () => {
        alive.current = false;
        epoch.current++;
        // Leaving the page is dismissing the URL: it is never shown again.
        setWebhook(null);
      };
    }, [run]),
  );

  const open = (id: string | null) => {
    if (busy) return;
    setLoaded(null);
    setRuns(null);
    setWebhook(null);
    go({ kind: 'edit', id });
    if (id !== null) void run(async () => {});
  };

  const save = (draft: WorkflowDraft) => {
    const body = definition(draft);
    const current = loaded;
    void run(async (visible) => {
      saveOperation.current ??= chat.operationId();
      const operation = saveOperation.current;
      if (current === null) {
        const created = await chat.workflows((tr) => tr.createWorkflow({ operation_id: operation, ...body }));
        saveOperation.current = null;
        if (!visible()) return;
        setLoaded(created);
        setRuns([]);
        setList((l) => (l === null ? [created] : l.some((w) => w.id === created.id) ? l : [...l, created]));
        go({ kind: 'edit', id: created.id });
      } else {
        try {
          const updated = await chat.workflows((tr) => tr.updateWorkflow(current.id, { operation_id: operation, revision: current.revision, ...body }));
          saveOperation.current = null;
          if (visible()) setLoaded(updated);
        } catch (e) {
          if (e instanceof NativeError && e.code === 'revision_conflict') {
            // Moved elsewhere: the server's copy replaces the draft, and says so.
            saveOperation.current = null;
            const fresh = await chat.workflows((tr) => tr.workflow(current.id));
            if (visible()) {
              setLoaded(fresh);
              setEditorEpoch((v) => v + 1);
            }
          }
          throw e;
        }
      }
      if (visible()) setNotice('workflows.savedNote');
    });
  };

  const test = (workflow: Workflow) =>
    void run(async (visible) => {
      await chat.workflows((tr) => tr.testWorkflow(workflow.id));
      if (visible()) setNotice('workflows.testStarted');
    });

  const disable = (workflow: Workflow) =>
    void run(async (visible) => {
      const off = await chat.workflows((tr) => tr.disableWorkflow(workflow.id));
      if (visible()) {
        setLoaded(off);
        setEditorEpoch((v) => v + 1);
      }
    });

  const remove = (workflow: Workflow) => {
    const n = epoch.current;
    Alert.alert(
      t('workflows.deleteConfirm', { name: workflow.name }),
      t('workflows.deleteBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            if (!alive.current || epoch.current !== n) return;
            void run(async (visible) => {
              await chat.workflows((tr) => tr.deleteWorkflow(workflow.id));
              if (visible()) {
                setWebhook(null);
                go({ kind: 'list' });
              }
            });
          },
        },
      ],
      dismissible(),
    );
  };

  const generateWebhook = (workflow: Workflow) =>
    void run(async (visible) => {
      const secret = await chat.workflows((tr) => tr.workflowWebhook(workflow.id));
      if (visible()) setWebhook({ workflow: workflow.id, url: `${baseUrl.replace(/\/+$/, '')}${secret.path}` });
    }, 'webhook');

  const copy = (value: string) => {
    if (alive.current && AppState.currentState === 'active') void Clipboard.setStringAsync(value);
  };

  const roomName = (id: string): string =>
    id === TRIGGER_ROOM ? t('workflows.roomTrigger') : id === '' ? t('workflows.roomNone') : rooms.find((r) => r.id === id)?.label ?? id;

  const back = () => {
    setWebhook(null);
    go({ kind: 'list' });
  };

  const editing = screen.kind === 'edit';
  const refusalAt: Failure['at'] = error?.at === 'webhook' && editing && loaded !== null ? 'webhook' : 'page';
  const refusal = (at: Failure['at']): ReactNode =>
    refusalAt !== at ? null : (
      <>
        {error !== null && (
          <Text accessibilityRole="alert" style={[styles.text, { color: c.errorText }]}>
            {t(error.key)}
          </Text>
        )}
        {error?.reauth === true && chat.capabilities?.reauthentication_retirement === true && !confirming && (
          <Action c={c} label={t('security.verify')} onPress={() => setConfirming(true)} />
        )}
        {confirming && (
          <ConfirmNativeIdentity
            c={c}
            chat={chat}
            onConfirmed={() => {
              if (!alive.current) return;
              setConfirming(false);
              setError(null);
            }}
          />
        )}
      </>
    );

  return (
    <>
      <Text style={[styles.heading, { color: c.dimmed }]}>{t('workflows.title')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        {busy && <ActivityIndicator color={c.accent} />}
        {refusal('page')}
        {notice !== null && <Text style={[styles.text, { color: c.online }]}>{t(notice)}</Text>}

        {screen.kind === 'list' && (
          <>
            <Text style={[styles.text, { color: c.secondaryText }]}>{t('workflows.intro')}</Text>
            {list !== null && list.length === 0 && <Text style={[styles.text, { color: c.dimmed }]}>{t('workflows.empty')}</Text>}
            {list?.map((workflow) => (
              <WorkflowRow key={workflow.id} c={c} workflow={workflow} summary={triggerSummary(workflow.trigger, t, roomName)} disabled={busy} onPress={() => open(workflow.id)} />
            ))}
            {list !== null &&
              (canCreate ? (
                <Action c={c} label={t('workflows.create')} disabled={busy || list.length >= LIMITS.workflows} onPress={() => open(null)} />
              ) : (
                <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.createClosed')}</Text>
              ))}
            <Action c={c} label={t('workflows.refresh')} disabled={busy} onPress={() => void run(async () => {})} />
          </>
        )}

        {editing && (screen.id === null || loaded !== null) && (
          <Editor
            key={`${loaded?.id ?? 'new'}:${loaded?.revision ?? ''}:${editorEpoch}`}
            c={c}
            workflow={loaded}
            bots={bots}
            rooms={rooms}
            runs={runs}
            busy={busy}
            webhookUrl={webhook !== null && webhook.workflow === loaded?.id ? webhook.url : null}
            roomName={roomName}
            onChange={() => {
              saveOperation.current = null;
            }}
            onSave={save}
            onTest={() => loaded !== null && test(loaded)}
            onDisable={() => loaded !== null && disable(loaded)}
            onDelete={() => loaded !== null && remove(loaded)}
            onWebhook={() => loaded !== null && generateWebhook(loaded)}
            onDismissWebhook={() => setWebhook(null)}
            onCopy={copy}
            onRefreshRuns={() => void run(async () => {})}
            onBack={back}
            webhookRefusal={refusal('webhook')}
          />
        )}
        {/* A workflow not (yet) loaded: never a dead end. */}
        {editing && screen.id !== null && loaded === null && (
          <>
            <Action c={c} label={`‹ ${t('workflows.back')}`} disabled={busy} onPress={back} />
            {!busy && <Action c={c} label={t('workflows.refresh')} onPress={() => void run(async () => {})} />}
          </>
        )}
      </View>
    </>
  );
}

function Action({ c, label, onPress, disabled = false, danger = false }: { c: Colors; label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <Tappable disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress}>
      <Text style={[styles.action, { color: danger ? c.errorText : c.cyan, opacity: disabled ? 0.5 : 1 }]}>{label}</Text>
    </Tappable>
  );
}

/** One choice among a few, drawn as a row of chips (a native radio group). */
function Chips<T extends string | number>({ c, options, value, label, disabled, onPick, multiple }: {
  c: Colors;
  options: readonly T[];
  value: readonly T[];
  label: (option: T) => string;
  disabled: boolean;
  onPick: (option: T) => void;
  multiple?: boolean;
}) {
  return (
    <View style={styles.chips} accessibilityRole={multiple === true ? undefined : 'radiogroup'}>
      {options.map((option) => {
        const on = value.includes(option);
        return (
          <Tappable
            key={String(option)}
            disabled={disabled}
            accessibilityRole={multiple === true ? 'checkbox' : 'radio'}
            accessibilityState={multiple === true ? { checked: on, disabled } : { selected: on, disabled }}
            onPress={() => onPick(option)}
            style={[styles.chip, { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.card : 'transparent' }]}
          >
            <Text style={[styles.chipText, { color: on ? c.text : c.secondaryText }]}>{label(option)}</Text>
          </Tappable>
        );
      })}
    </View>
  );
}

function Toggle({ c, label, value, disabled, onChange }: { c: Colors; label: string; value: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Text style={[styles.text, styles.grow, { color: c.text }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: c.accent }} accessibilityLabel={label} />
    </View>
  );
}

function WorkflowRow({ c, workflow, summary, disabled, onPress }: { c: Colors; workflow: Workflow; summary: string; disabled: boolean; onPress: () => void }) {
  const t = useT();
  const date = useDate();
  const last = workflow.last_run;
  const runText =
    last == null
      ? t('workflows.neverRun')
      : last.state === 'failed'
        ? t('workflows.lastRunFailed', { step: last.step + 1, error: runError(t, last.error) })
        : t('workflows.lastRun', { state: t(RUN_STATE_TEXT[last.state]), date: date(last.updated_at) });
  return (
    <Tappable disabled={disabled} accessibilityRole="button" accessibilityLabel={workflow.name} onPress={onPress} style={[styles.row, { borderColor: c.softBorder }]}>
      <View style={styles.grow}>
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {workflow.name}
        </Text>
        <Text style={[styles.text, { color: c.secondaryText }]} numberOfLines={2}>
          {summary}
        </Text>
        <Text style={[styles.text, { color: workflow.enabled ? c.online : c.dimmed }]}>{workflow.enabled ? t('workflows.on') : t('workflows.off')}</Text>
        <Text style={[styles.text, { color: last?.state === 'failed' ? c.errorText : c.dimmed }]} numberOfLines={2}>
          {runText}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
    </Tappable>
  );
}

function runError(t: ReturnType<typeof useT>, code: string | null | undefined): string {
  if (code == null || code === '') return '-';
  const key = runErrorKey(code);
  return key === null ? code : t(key);
}

/** A room among mine, or the trigger's when `allowTrigger`; the list unfolds in place. */
function RoomPicker({ c, rooms, value, allowTrigger, disabled, roomName, onChange }: {
  c: Colors;
  rooms: readonly RoomChoice[];
  value: string;
  allowTrigger: boolean;
  disabled: boolean;
  roomName: (id: string) => string;
  onChange: (room: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const choices: RoomChoice[] = [...(allowTrigger ? [{ id: TRIGGER_ROOM, label: t('workflows.roomTrigger') }] : []), ...rooms];
  return (
    <View style={styles.group}>
      <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.room')}</Text>
      <Text style={[styles.strong, { color: value === '' || (value === TRIGGER_ROOM && !allowTrigger) ? c.errorText : c.text }]}>{roomName(value)}</Text>
      <Tappable disabled={disabled} accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}>
        <Text style={[styles.disclosure, { color: c.cyan }]}>
          {open ? '▾' : '▸'} {t('workflows.chooseRoom')}
        </Text>
      </Tappable>
      {open && choices.length === 0 && <Text style={[styles.text, { color: c.dimmed }]}>{t('workflows.noRooms')}</Text>}
      {open &&
        choices.map((room) => (
          <Tappable
            key={room.id}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: room.id === value }}
            onPress={() => {
              onChange(room.id);
              setOpen(false);
            }}
            style={styles.choice}
          >
            <Text style={[styles.check, { color: room.id === value ? c.accent : c.dimmed }]}>{room.id === value ? '◉' : '○'}</Text>
            <Text style={[styles.text, styles.grow, { color: c.text }]} numberOfLines={1}>
              {room.label}
            </Text>
          </Tappable>
        ))}
      <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.roomHint')}</Text>
    </View>
  );
}

/** A template input with the variables of its step under it; a tap inserts one at the cursor. */
function TemplateField({ c, label, value, variables, disabled, multiline, maxLength, onChange }: {
  c: Colors;
  label: string;
  value: string;
  variables: readonly string[];
  disabled: boolean;
  multiline?: boolean;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const cursor = useRef<number | undefined>(undefined);
  return (
    <View style={styles.group}>
      <PillField
        c={c}
        label={label}
        value={value}
        editable={!disabled}
        multiline={multiline}
        maxLength={maxLength}
        onChangeText={onChange}
        onSelectionChange={(e) => {
          cursor.current = e.nativeEvent.selection.end;
        }}
      />
      <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.variables')}</Text>
      <View style={styles.chips}>
        {variables.map((name) => (
          <Tappable
            key={name}
            disabled={disabled}
            accessibilityRole="button"
            onPress={() => {
              const next = insertVariable(value, name, cursor.current);
              cursor.current = next.cursor;
              onChange(next.text);
            }}
            style={[styles.variable, { borderColor: c.softBorder }]}
          >
            <Text style={[styles.code, { color: c.cyan }]}>{`{{${name}}}`}</Text>
          </Tappable>
        ))}
      </View>
    </View>
  );
}

function Editor({ c, workflow, bots, rooms, runs, busy, webhookUrl, roomName, onChange, onSave, onTest, onDisable, onDelete, onWebhook, onDismissWebhook, onCopy, onRefreshRuns, onBack, webhookRefusal }: {
  c: Colors;
  /** `null`: a new workflow. */
  workflow: Workflow | null;
  bots: readonly Bot[];
  rooms: readonly RoomChoice[];
  runs: readonly WorkflowRun[] | null;
  busy: boolean;
  webhookUrl: string | null;
  roomName: (id: string) => string;
  onChange: () => void;
  onSave: (draft: WorkflowDraft) => void;
  onTest: () => void;
  onDisable: () => void;
  onDelete: () => void;
  onWebhook: () => void;
  onDismissWebhook: () => void;
  onCopy: (value: string) => void;
  onRefreshRuns: () => void;
  onBack: () => void;
  webhookRefusal: ReactNode;
}) {
  const t = useT();
  const date = useDate();
  const live = bots.filter((b) => !b.disabled || b.user.id === workflow?.bot.id);
  const [draft, setDraft] = useState<WorkflowDraft>(() => {
    const trigger = workflow?.trigger ?? defaultTrigger('command', deviceTimeZone());
    return {
      name: workflow?.name ?? '',
      description: workflow?.description ?? '',
      botId: workflow?.bot.id ?? '',
      enabled: workflow?.enabled ?? true,
      trigger,
      steps: workflow?.steps ?? [defaultStep('message', trigger, [])],
    };
  });
  // A new workflow with a single bot, none picked yet: that one.
  const botId = draft.botId === '' && workflow === null && live.length === 1 ? live[0]!.user.id : draft.botId;
  const current: WorkflowDraft = { ...draft, botId };
  const edit = (change: (d: WorkflowDraft) => WorkflowDraft) => {
    onChange();
    setDraft(change);
  };
  const setTrigger = (trigger: Trigger) => edit((d) => ({ ...d, trigger }));
  const setStep = (index: number, step: Step) => edit((d) => ({ ...d, steps: replaceAt(d.steps, index, step) }));
  const problem = draftProblem(current);
  const trigger = draft.trigger;

  const removeStep = (index: number) =>
    Alert.alert(
      t('workflows.removeStepConfirm', { n: index + 1 }),
      t('workflows.removeStepBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('workflows.removeStep'), style: 'destructive', onPress: () => edit((d) => ({ ...d, steps: removeAt(d.steps, index) })) },
      ],
      dismissible(),
    );

  return (
    <View style={styles.form}>
      <Action c={c} label={`‹ ${t('workflows.back')}`} disabled={busy} onPress={onBack} />
      <Text style={[styles.title, { color: c.text }]}>{workflow === null ? t('workflows.new') : workflow.name}</Text>
      {workflow?.next_fire_at != null && <Text style={[styles.text, { color: c.dimmed }]}>{t('workflows.nextFire', { date: date(workflow.next_fire_at) })}</Text>}

      <PillField c={c} label={t('workflows.name')} value={draft.name} editable={!busy} maxLength={128} onChangeText={(name) => edit((d) => ({ ...d, name }))} />
      <PillField c={c} label={t('workflows.description')} value={draft.description} editable={!busy} multiline maxLength={512} onChangeText={(description) => edit((d) => ({ ...d, description }))} />
      <Toggle c={c} label={t('workflows.enabled')} value={draft.enabled} disabled={busy} onChange={(enabled) => edit((d) => ({ ...d, enabled }))} />

      <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.bot')}</Text>
      {live.length === 0 && <Text style={[styles.text, { color: c.dimmed }]}>{t('workflows.noBots')}</Text>}
      {live.map((bot) => {
        const on = bot.user.id === botId;
        return (
          <Tappable key={bot.user.id} disabled={busy} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => edit((d) => ({ ...d, botId: bot.user.id }))} style={styles.choice}>
            <Text style={[styles.check, { color: on ? c.accent : c.dimmed }]}>{on ? '◉' : '○'}</Text>
            <View style={styles.grow}>
              <Text style={[styles.strong, { color: c.text }]} numberOfLines={1}>
                {bot.user.display_name || bot.user.username}
              </Text>
              <Text style={[styles.hint, { color: c.dimmed }]} numberOfLines={1}>
                @{bot.user.username} · {bot.scopes.join(', ')}
              </Text>
            </View>
          </Tappable>
        );
      })}

      <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.trigger')}</Text>
      <Chips
        c={c}
        options={TRIGGER_KINDS}
        value={[trigger.kind]}
        label={(kind) => t(TRIGGER_TEXT[kind])}
        disabled={busy}
        onPick={(kind) => {
          if (kind !== trigger.kind) setTrigger(defaultTrigger(kind, deviceTimeZone()));
        }}
      />
      <Text style={[styles.hint, { color: c.secondaryText }]}>{triggerSummary(trigger, t, roomName)}</Text>
      {trigger.kind === 'command' && (
        <>
          <PillField c={c} label={t('workflows.commandName')} value={trigger.name} editable={!busy} maxLength={32} onChangeText={(name) => setTrigger({ ...trigger, name: name.toLowerCase() })} />
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.commandHint')}</Text>
        </>
      )}
      {trigger.kind === 'schedule' && (
        <>
          <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.every')}</Text>
          <Chips c={c} options={EVERY} value={[trigger.every]} label={(every) => t(EVERY_TEXT[every])} disabled={busy} onPick={(every) => setTrigger({ ...trigger, every })} />
          <PillField c={c} label={t('workflows.time')} value={trigger.time} editable={!busy} maxLength={5} keyboardType="numbers-and-punctuation" onChangeText={(time) => setTrigger({ ...trigger, time })} />
          {trigger.every === 'hour' && <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.timeHourHint')}</Text>}
          {trigger.every === 'week' && (
            <>
              <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.days')}</Text>
              <Chips c={c} multiple options={WEEKDAYS} value={trigger.days ?? []} label={(day) => t(dayText(day))} disabled={busy} onPick={(day) => setTrigger({ ...trigger, days: toggleDay(trigger.days ?? [], day) })} />
            </>
          )}
          <PillField c={c} label={t('workflows.timezone')} value={trigger.timezone} editable={!busy} maxLength={64} onChangeText={(timezone) => setTrigger({ ...trigger, timezone })} />
          <RoomPicker c={c} rooms={rooms} value={trigger.room} allowTrigger={false} disabled={busy} roomName={roomName} onChange={(room) => setTrigger({ ...trigger, room })} />
        </>
      )}
      {trigger.kind === 'member_joined' && (
        <RoomPicker c={c} rooms={rooms} value={trigger.room} allowTrigger={false} disabled={busy} roomName={roomName} onChange={(room) => setTrigger({ ...trigger, room })} />
      )}
      {trigger.kind === 'webhook' && (
        <View style={styles.group}>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.webhookHint')}</Text>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.webhookVariables')}</Text>
          {/* The URL belongs to the saved workflow: generated once it is a webhook one. */}
          {workflow !== null && workflow.trigger.kind === 'webhook' && (
            <>
              {workflow.has_webhook === true && webhookUrl === null && <Text style={[styles.text, { color: c.secondaryText }]}>{t('workflows.webhookExists')}</Text>}
              {webhookUrl !== null && (
                <View style={[styles.secret, { borderColor: c.yellow, backgroundColor: c.card }]}>
                  <Text accessibilityRole="alert" style={[styles.strong, { color: c.yellow }]}>
                    {t('workflows.webhookOnce')}
                  </Text>
                  <Text selectable style={[styles.code, { color: c.text }]}>
                    {webhookUrl}
                  </Text>
                  <Action c={c} label={t('workflows.webhookCopy')} onPress={() => onCopy(webhookUrl)} />
                  <Action c={c} label={t('workflows.webhookDone')} onPress={onDismissWebhook} />
                </View>
              )}
              <Action c={c} label={t('workflows.webhookGenerate')} disabled={busy} onPress={onWebhook} />
              {webhookRefusal}
            </>
          )}
        </View>
      )}

      <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.steps')}</Text>
      {draft.steps.map((step, index) => (
        <View key={index} style={[styles.step, { borderColor: c.softBorder }]}>
          <View style={styles.stepHead}>
            <Text style={[styles.strong, styles.grow, { color: c.text }]}>{t('workflows.stepTitle', { n: index + 1, kind: t(STEP_TEXT[step.kind]) })}</Text>
            <Action c={c} label="↑" disabled={busy || index === 0} onPress={() => edit((d) => ({ ...d, steps: moveStep(d.steps, index, -1) }))} />
            <Action c={c} label="↓" disabled={busy || index === draft.steps.length - 1} onPress={() => edit((d) => ({ ...d, steps: moveStep(d.steps, index, 1) }))} />
            <Action c={c} label={t('workflows.removeStep')} danger disabled={busy} onPress={() => removeStep(index)} />
          </View>
          <StepEditor
            c={c}
            step={step}
            trigger={trigger}
            variables={variablesAt(trigger, draft.steps, index)}
            rooms={rooms}
            busy={busy}
            roomName={roomName}
            onChange={(next) => setStep(index, next)}
          />
        </View>
      ))}
      {draft.steps.length < LIMITS.steps && (
        <>
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.addStep')}</Text>
          <View style={styles.chips}>
            {STEP_KINDS.map((kind) => (
              <Tappable
                key={kind}
                disabled={busy}
                accessibilityRole="button"
                onPress={() => edit((d) => ({ ...d, steps: [...d.steps, defaultStep(kind, d.trigger, d.steps)] }))}
                style={[styles.chip, { borderColor: c.border }]}
              >
                <Text style={[styles.chipText, { color: c.cyan }]}>+ {t(STEP_TEXT[kind])}</Text>
              </Tappable>
            ))}
          </View>
        </>
      )}

      {problem !== null && <Text style={[styles.text, { color: c.errorText }]}>{t(problem)}</Text>}
      <Action c={c} label={t('workflows.save')} disabled={busy || problem !== null} onPress={() => onSave(current)} />
      {workflow !== null && (
        <>
          <Action c={c} label={t('workflows.test')} disabled={busy} onPress={onTest} />
          {workflow.enabled && <Action c={c} label={t('workflows.disable')} disabled={busy} onPress={onDisable} />}
          <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.runs')}</Text>
          {runs !== null && runs.length === 0 && <Text style={[styles.text, { color: c.dimmed }]}>{t('workflows.noRuns')}</Text>}
          {runs?.map((r) => (
            <View key={r.id} style={[styles.run, { borderColor: c.softBorder }]}>
              <Text style={[styles.strong, { color: r.state === 'failed' ? c.errorText : c.text }]}>{r.state === 'done' || r.state === 'cancelled'
                  ? t(RUN_STATE_TEXT[r.state])
                  : t('workflows.runLine', { state: t(RUN_STATE_TEXT[r.state]), step: r.step + 1 })}</Text>
              {r.error != null && r.error !== '' && <Text style={[styles.text, { color: c.errorText }]}>{t('workflows.runError', { error: runError(t, r.error) })}</Text>}
              <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.runDates', { start: date(r.created_at), end: date(r.updated_at) })}</Text>
            </View>
          ))}
          <Action c={c} label={t('workflows.refreshRuns')} disabled={busy} onPress={onRefreshRuns} />
          <Action c={c} label={t('workflows.delete')} danger disabled={busy} onPress={onDelete} />
        </>
      )}
    </View>
  );
}

function StepEditor({ c, step, trigger, variables, rooms, busy, roomName, onChange }: {
  c: Colors;
  step: Step;
  trigger: Trigger;
  variables: readonly string[];
  rooms: readonly RoomChoice[];
  busy: boolean;
  roomName: (id: string) => string;
  onChange: (step: Step) => void;
}) {
  const t = useT();
  switch (step.kind) {
    case 'message':
      return (
        <View style={styles.form}>
          <RoomPicker c={c} rooms={rooms} value={step.room} allowTrigger={hasTriggerRoom(trigger)} disabled={busy} roomName={roomName} onChange={(room) => onChange({ ...step, room })} />
          <TemplateField c={c} label={t('workflows.text')} value={step.text} variables={variables} disabled={busy} multiline maxLength={8192} onChange={(text) => onChange({ ...step, text })} />
          <Toggle c={c} label={t('workflows.inThread')} value={step.in_thread === true} disabled={busy} onChange={(in_thread) => onChange({ ...step, in_thread })} />
          <PillField c={c} label={t('workflows.saveAs')} value={step.save_as ?? ''} editable={!busy} maxLength={32} onChangeText={(save_as) => onChange({ ...step, save_as: save_as.toLowerCase() })} />
        </View>
      );
    case 'wait':
      return <WaitEditor c={c} seconds={step.seconds} busy={busy} onChange={(seconds) => onChange({ ...step, seconds })} />;
    case 'http': {
      const headers = step.headers ?? [];
      return (
        <View style={styles.form}>
          <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.method')}</Text>
          <Chips c={c} options={HTTP_METHODS} value={[step.method]} label={(m) => m} disabled={busy} onPick={(method) => onChange({ ...step, method })} />
          <TemplateField c={c} label={t('workflows.url')} value={step.url} variables={variables} disabled={busy} maxLength={2048} onChange={(url) => onChange({ ...step, url })} />
          <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.headers')}</Text>
          {headers.map((header, i) => (
            <View key={i} style={[styles.nested, { borderColor: c.softBorder }]}>
              <PillField c={c} label={t('workflows.headerName')} value={header.name} editable={!busy} maxLength={64} onChangeText={(name) => onChange({ ...step, headers: replaceAt(headers, i, { ...header, name }) })} />
              <TemplateField c={c} label={t('workflows.headerValue')} value={header.value} variables={variables} disabled={busy} maxLength={1024} onChange={(value) => onChange({ ...step, headers: replaceAt(headers, i, { ...header, value }) })} />
              <Action c={c} label={t('workflows.removeHeader')} danger disabled={busy} onPress={() => onChange({ ...step, headers: removeAt(headers, i) })} />
            </View>
          ))}
          {headers.length < LIMITS.headers && <Action c={c} label={t('workflows.addHeader')} disabled={busy} onPress={() => onChange({ ...step, headers: [...headers, { name: '', value: '' }] })} />}
          <TemplateField c={c} label={t('workflows.body')} value={step.body ?? ''} variables={variables} disabled={busy} multiline maxLength={8192} onChange={(body) => onChange({ ...step, body })} />
          <PillField c={c} label={t('workflows.saveAs')} value={step.save_as ?? ''} editable={!busy} maxLength={32} onChangeText={(save_as) => onChange({ ...step, save_as: save_as.toLowerCase() })} />
          <Toggle c={c} label={t('workflows.continueOnError')} value={step.continue_on_error === true} disabled={busy} onChange={(continue_on_error) => onChange({ ...step, continue_on_error })} />
          <Text style={[styles.hint, { color: c.dimmed }]}>{t('workflows.httpHint')}</Text>
        </View>
      );
    }
    case 'form': {
      const fields = step.fields;
      const setField = (i: number, field: FormField) => onChange({ ...step, fields: replaceAt(fields, i, field) });
      return (
        <View style={styles.form}>
          <RoomPicker c={c} rooms={rooms} value={step.room} allowTrigger={hasTriggerRoom(trigger)} disabled={busy} roomName={roomName} onChange={(room) => onChange({ ...step, room })} />
          <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.recipient')}</Text>
          <Chips
            c={c}
            options={hasTriggerUser(trigger) ? RECIPIENTS : RECIPIENTS.slice(1)}
            value={[step.recipient]}
            label={(r) => t(r === 'trigger_user' ? 'workflows.recipientTrigger' : 'workflows.recipientAnyone')}
            disabled={busy}
            onPick={(recipient) => onChange({ ...step, recipient })}
          />
          <PillField c={c} label={t('workflows.formTitle')} value={step.title} editable={!busy} maxLength={256} onChangeText={(title) => onChange({ ...step, title })} />
          <Text style={[styles.label, { color: c.dimmed }]}>{t('workflows.fields')}</Text>
          {fields.map((field, i) => (
            <View key={i} style={[styles.nested, { borderColor: c.softBorder }]}>
              <PillField
                c={c}
                label={t('workflows.fieldLabel')}
                value={field.label}
                editable={!busy}
                maxLength={256}
                onChangeText={(label) =>
                  // The id follows the label until it was edited by hand.
                  onChange({ ...step, fields: relabel(fields, i, label, field.id === fieldIdFor(field.label, fields, i)) })
                }
              />
              <PillField c={c} label={t('workflows.fieldId')} value={field.id} editable={!busy} maxLength={32} onChangeText={(id) => setField(i, { ...field, id: id.toLowerCase() })} />
              <Chips c={c} options={FIELD_KINDS} value={[field.kind]} label={(kind) => t(FIELD_TEXT[kind])} disabled={busy} onPick={(kind) => setField(i, { ...field, kind })} />
              {field.kind === 'choice' && (
                <PillField
                  c={c}
                  label={t('workflows.options')}
                  value={(field.options ?? []).join('\n')}
                  editable={!busy}
                  multiline
                  maxLength={20 * 129}
                  onChangeText={(text) => setField(i, { ...field, options: text.split('\n').slice(0, LIMITS.options) })}
                />
              )}
              <Toggle c={c} label={t('workflows.required')} value={field.required === true} disabled={busy} onChange={(required) => setField(i, { ...field, required })} />
              {fields.length > 1 && <Action c={c} label={t('workflows.removeField')} danger disabled={busy} onPress={() => onChange({ ...step, fields: removeAt(fields, i) })} />}
            </View>
          ))}
          {fields.length < LIMITS.fields && (
            <Action
              c={c}
              label={t('workflows.addField')}
              disabled={busy}
              onPress={() => onChange({ ...step, fields: [...fields, { id: uniqueName('field', fields.map((f) => f.id)), label: '', kind: 'text', required: false }] })}
            />
          )}
          <PillField c={c} label={t('workflows.saveAsForm')} value={step.save_as} editable={!busy} maxLength={32} onChangeText={(save_as) => onChange({ ...step, save_as: save_as.toLowerCase() })} />
        </View>
      );
    }
  }
}

/** A wait: a number and a unit, kept as typed; the step holds its seconds (0 while invalid, refused before saving). */
function WaitEditor({ c, seconds, busy, onChange }: { c: Colors; seconds: number; busy: boolean; onChange: (seconds: number) => void }) {
  const t = useT();
  const [parts, setParts] = useState(() => waitParts(seconds));
  const update = (amount: string, unit: WaitUnit) => {
    setParts({ amount, unit });
    onChange(waitSeconds(amount, unit) ?? 0);
  };
  return (
    <View style={styles.form}>
      <PillField c={c} label={t('workflows.waitAmount')} value={parts.amount} editable={!busy} keyboardType="decimal-pad" maxLength={8} onChangeText={(amount) => update(amount, parts.unit)} />
      <Chips c={c} options={WAIT_UNITS} value={[parts.unit]} label={(unit) => t(UNIT_TEXT[unit])} disabled={busy} onPick={(unit) => update(parts.amount, unit)} />
      {waitSeconds(parts.amount, parts.unit) === null && <Text style={[styles.text, { color: c.errorText }]}>{t('workflows.badWait')}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8, marginLeft: 4 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  form: { gap: 10 },
  group: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  grow: { flex: 1, gap: 2 },
  title: { fontFamily: FONTS.title, fontSize: 16 },
  text: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  hint: { fontFamily: FONTS.body, fontSize: 12, lineHeight: 16 },
  strong: { fontFamily: FONTS.bodyBold, fontSize: 13.5, lineHeight: 19 },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 6 },
  action: { fontFamily: FONTS.bodyBold, fontSize: 13, paddingVertical: 8, paddingHorizontal: 2 },
  chevron: { fontFamily: FONTS.title, fontSize: 22 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { fontFamily: FONTS.bodyStrong, fontSize: 12.5 },
  variable: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 3 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  check: { fontSize: 16, width: 22, textAlign: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  disclosure: { fontFamily: FONTS.bodyBold, fontSize: 12, paddingVertical: 4 },
  code: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  secret: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  step: { borderWidth: 1, borderRadius: 12, padding: 10, gap: 8 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nested: { borderLeftWidth: 2, paddingLeft: 10, gap: 8 },
  run: { gap: 2, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
