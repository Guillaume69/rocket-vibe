/**
 * "My bots", a settings category on a RocketVibe server announcing `bots`
 * (RFC 0003, `docs/protocol/BOTS.md`): my bot accounts, creating one (when
 * `create_bot` allows it), its description and scopes, its keys, and deleting
 * it. Built like `ui/devices.tsx`: remounted per provider, every answer
 * dropped once the page lost focus or a newer call started, and a key needing
 * a recent sign-in confirmed in place (`ConfirmNativeIdentity`).
 *
 * A new key is shown ONCE, from memory only: never persisted, gone when
 * dismissed or when the page closes; copied only while the page is focused
 * and the app active (`ui/encryptedIdentity.tsx` does the same).
 */

import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Alert, AppState, Platform, StyleSheet, Text, View } from 'react-native';

import { dismissible } from './alerts.ts';
import type { NativeChat } from '../providers/rocketvibe/chat.ts';
import type { Bot, BotKey, BotKeyCreated, BotReference, BotScope } from '../providers/rocketvibe/protocol.generated.ts';
import { NativeError } from '../providers/rocketvibe/transport.ts';
import { useSync } from './sync.tsx';
import { useT } from './i18n.ts';
import { Tappable } from './tappable.tsx';
import { AvatarTile, PillField } from './kit.tsx';
import { FONTS, type Colors } from './theme.ts';
import { ConfirmNativeIdentity } from './nativeSecurity.tsx';
import { providerKey } from './devices.tsx';
import type { TranslationKey } from './messages.ts';
import { BOT_SCOPES, SCOPE_TEXT, botErrorKey, curlExample, expiryDays, sameScopes, scopeRoutes, toggleScope } from './botsModel.ts';

const MONO = Platform.select({ android: 'monospace', default: 'Menlo' });

/** The server offers bot accounts (also what shows the settings category). */
export function hasBots(chat: NativeChat | null | undefined): boolean {
  return !!chat?.capabilities?.bots;
}

export function BotsSection({ c, baseUrl }: { c: Colors; baseUrl: string }) {
  const sync = useSync();
  const chat = sync.phase === 'ready' ? sync.provider.native?.chat : null;
  return chat && hasBots(chat) ? <Bots key={providerKey(chat)} c={c} chat={chat} baseUrl={baseUrl} /> : null;
}

type Screen = { kind: 'list' } | { kind: 'create' } | { kind: 'bot'; id: string };
type Failure = { key: TranslationKey; reauth: boolean };

function failure(e: unknown): Failure {
  if (e instanceof NativeError) return { key: botErrorKey(e.code, e.status), reauth: e.code === 'reauthentication_required' };
  return { key: 'bots.failed', reauth: false };
}

function Bots({ c, chat, baseUrl }: { c: Colors; chat: NativeChat; baseUrl: string }) {
  const t = useT();
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [reference, setReference] = useState<BotReference | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [keys, setKeys] = useState<{ bot: string; keys: BotKey[] } | null>(null);
  const [created, setCreated] = useState<{ bot: string; value: BotKeyCreated } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const alive = useRef(false);
  const epoch = useRef(0);
  const inFlight = useRef<number | null>(null);
  const screenRef = useRef<Screen>({ kind: 'list' });
  const referenceRead = useRef(false);
  // One creation intent per filled form: a retry after a lost answer replays
  // it and gets the same bot back, instead of `username_taken`.
  const createOperation = useRef<string | null>(null);

  const go = useCallback((next: Screen) => {
    screenRef.current = next;
    setScreen(next);
    setError(null);
    setConfirming(false);
  }, []);

  /** One call at a time; then the list, my permission and, on a bot's page, its keys. */
  const run = useCallback(
    async (action: (visible: () => boolean) => Promise<void>) => {
      if (!alive.current || inFlight.current !== null) return;
      const n = epoch.current;
      const visible = () => alive.current && epoch.current === n;
      inFlight.current = n;
      setBusy(true);
      setError(null);
      try {
        await action(visible);
        if (!visible()) return;
        const [list, permissions] = await chat.bots((tr) => Promise.all([tr.bots(), tr.accountPermissions()]));
        if (!visible()) return;
        setBots(list.bots);
        setCanCreate(permissions.create_bot === true);
        if (!referenceRead.current) {
          // The API list under each scope; the page works without it.
          const read = await chat.bots((tr) => tr.botReference()).catch(() => null);
          if (!visible()) return;
          if (read !== null) {
            referenceRead.current = true;
            setReference(read);
          }
        }
        const current = screenRef.current;
        if (current.kind === 'bot') {
          if (!list.bots.some((b) => b.user.id === current.id)) {
            go({ kind: 'list' });
            return;
          }
          const listed = await chat.bots((tr) => tr.botKeys(current.id));
          if (visible() && screenRef.current === current) setKeys({ bot: current.id, keys: listed.keys });
        }
      } catch (e) {
        if (visible()) setError(failure(e));
      } finally {
        if (inFlight.current === n) {
          inFlight.current = null;
          if (visible()) setBusy(false);
        }
      }
    },
    [chat, go],
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
        // Leaving the page is dismissing the key: it is never shown again.
        setCreated(null);
      };
    }, [run]),
  );

  const open = (id: string) => {
    if (busy) return;
    setKeys(null);
    go({ kind: 'bot', id });
    void run(async () => {});
  };

  const create = (input: { username: string; displayName: string; description: string; scopes: BotScope[] }) =>
    void run(async (visible) => {
      const bot = await chat.bots((tr, operation) => {
        createOperation.current ??= operation();
        return tr.createBot({
          operation_id: createOperation.current,
          username: input.username.trim(),
          display_name: input.displayName.trim(),
          description: input.description.trim(),
          scopes: input.scopes,
        });
      });
      createOperation.current = null;
      if (visible()) {
        setKeys(null);
        go({ kind: 'bot', id: bot.user.id });
      }
    });

  const save = (bot: Bot, description: string, scopes: BotScope[]) =>
    void run(async () => {
      await chat.bots((tr, operation) => tr.updateBot(bot.user.id, { operation_id: operation(), description: description.trim(), scopes }));
    });

  const remove = (bot: Bot) => {
    const n = epoch.current;
    Alert.alert(
      t('bots.deleteConfirm', { name: bot.user.display_name || bot.user.username }),
      t('bots.deleteBody', { username: bot.user.username }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('bots.delete'),
          style: 'destructive',
          onPress: () => {
            if (!alive.current || epoch.current !== n) return;
            void run(async (visible) => {
              await chat.bots((tr) => tr.deleteBot(bot.user.id));
              if (visible()) {
                setCreated(null);
                go({ kind: 'list' });
              }
            });
          },
        },
      ],
      dismissible(),
    );
  };

  const createKey = (bot: Bot, label: string, days: number | null) =>
    void run(async (visible) => {
      const value = await chat.bots((tr, operation) =>
        tr.createBotKey(bot.user.id, { operation_id: operation(), label: label.trim(), ...(days === null ? {} : { expires_in_days: days }) }),
      );
      if (visible()) setCreated({ bot: bot.user.id, value });
    });

  const revokeKey = (bot: Bot, key: BotKey) => {
    const n = epoch.current;
    Alert.alert(
      t('bots.revokeConfirm', { label: key.label || key.hint }),
      t('bots.revokeBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('bots.revoke'),
          style: 'destructive',
          onPress: () => {
            if (!alive.current || epoch.current !== n) return;
            void run(async () => {
              await chat.bots((tr) => tr.revokeBotKey(bot.user.id, key.id));
            });
          },
        },
      ],
      dismissible(),
    );
  };

  const copy = (value: string) => {
    if (alive.current && AppState.currentState === 'active') void Clipboard.setStringAsync(value);
  };

  const shown = screen.kind === 'bot' ? bots?.find((b) => b.user.id === screen.id) ?? null : null;

  return (
    <>
      <Text style={[styles.heading, { color: c.dimmed }]}>{t('bots.title')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        {busy && <ActivityIndicator color={c.accent} />}
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

        {screen.kind === 'list' && (
          <>
            <Text style={[styles.text, { color: c.secondaryText }]}>{t('bots.intro')}</Text>
            {bots !== null && bots.length === 0 && <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.empty')}</Text>}
            {bots?.map((bot) => (
              <BotRow key={bot.user.id} c={c} bot={bot} disabled={busy} onPress={() => open(bot.user.id)} />
            ))}
            {bots !== null &&
              (canCreate ? (
                <Action c={c} label={t('bots.create')} disabled={busy} onPress={() => go({ kind: 'create' })} />
              ) : (
                <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.createClosed')}</Text>
              ))}
            <Action c={c} label={t('bots.refresh')} disabled={busy} onPress={() => void run(async () => {})} />
          </>
        )}

        {screen.kind === 'create' && (
          <CreateForm
            c={c}
            busy={busy}
            reference={reference}
            onChange={() => {
              createOperation.current = null;
            }}
            onCreate={create}
            onCancel={() => go({ kind: 'list' })}
          />
        )}

        {screen.kind === 'bot' && shown !== null && (
          <Detail
            key={shown.user.id}
            c={c}
            bot={shown}
            busy={busy}
            reference={reference}
            keys={keys?.bot === shown.user.id ? keys.keys : null}
            created={created?.bot === shown.user.id ? created.value : null}
            baseUrl={baseUrl}
            onSave={(description, scopes) => save(shown, description, scopes)}
            onCreateKey={(label, days) => createKey(shown, label, days)}
            onRevokeKey={(key) => revokeKey(shown, key)}
            onDismissKey={() => setCreated(null)}
            onCopy={copy}
            onDelete={() => remove(shown)}
            onBack={() => {
              setCreated(null);
              go({ kind: 'list' });
            }}
          />
        )}
        {screen.kind === 'bot' && shown === null && busy && <Text style={[styles.text, { color: c.dimmed }]}>…</Text>}
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

function BotRow({ c, bot, disabled, onPress }: { c: Colors; bot: Bot; disabled: boolean; onPress: () => void }) {
  const t = useT();
  const name = bot.user.display_name || bot.user.username;
  return (
    <Tappable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      style={[styles.bot, { borderColor: c.softBorder }]}
    >
      <AvatarTile c={c} hueKey={bot.user.username} initial={bot.user.username.charAt(0)} size={40} radius={13} />
      <View style={styles.botTexts}>
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.text, { color: c.dimmed }]} numberOfLines={1}>
          @{bot.user.username}
        </Text>
        {bot.description !== '' && (
          <Text style={[styles.text, { color: c.secondaryText }]} numberOfLines={2}>
            {bot.description}
          </Text>
        )}
        <Text style={[styles.text, { color: bot.disabled ? c.errorText : c.dimmed }]}>
          {bot.disabled ? t('bots.disabled') : t('bots.summary', { scopes: bot.scopes.length, n: bot.live_keys })}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
    </Tappable>
  );
}

/** The scopes as a checklist (`onToggle` absent: read only), each with its sentence and its routes. */
function ScopeList({ c, scopes, reference, disabled, onToggle }: { c: Colors; scopes: readonly BotScope[]; reference: BotReference | null; disabled: boolean; onToggle: (scope: BotScope) => void }) {
  const t = useT();
  return (
    <View style={styles.scopes}>
      <Text style={[styles.label, { color: c.dimmed }]}>{t('bots.scopes')}</Text>
      {BOT_SCOPES.map((scope) => {
        const on = scopes.includes(scope);
        return (
          <View key={scope} style={styles.scope}>
            <Tappable
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled }}
              accessibilityLabel={`${scope}. ${t(SCOPE_TEXT[scope])}`}
              onPress={() => onToggle(scope)}
              style={styles.scopeHead}
            >
              <Text style={[styles.check, { color: on ? c.accent : c.dimmed }]}>{on ? '☑' : '☐'}</Text>
              <View style={styles.botTexts}>
                <Text style={[styles.code, { color: c.text }]}>{scope}</Text>
                <Text style={[styles.text, { color: c.secondaryText }]}>{t(SCOPE_TEXT[scope])}</Text>
              </View>
            </Tappable>
            <Routes c={c} reference={reference} scope={scope} />
          </View>
        );
      })}
      <View style={styles.scope}>
        <View style={styles.scopeHead}>
          <Text style={[styles.check, { color: c.dimmed }]}>✓</Text>
          <Text style={[styles.text, styles.botTexts, { color: c.secondaryText }]}>{t(SCOPE_TEXT.always)}</Text>
        </View>
        <Routes c={c} reference={reference} scope="always" />
      </View>
      <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.closed')}</Text>
      {reference !== null && (
        <Text style={[styles.text, { color: c.dimmed }]}>
          {t('bots.budgets', { sends: reference.sends_per_minute, direct: reference.direct_per_minute })}
        </Text>
      )}
    </View>
  );
}

/** The "API" disclosure of one scope: the routes the server opens with it. */
function Routes({ c, reference, scope }: { c: Colors; reference: BotReference | null; scope: BotScope | 'always' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const routes = scopeRoutes(reference, scope);
  if (routes.length === 0) return null;
  return (
    <View style={styles.routes}>
      <Tappable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)}>
        <Text style={[styles.disclosure, { color: c.cyan }]}>
          {open ? '▾' : '▸'} {t('bots.api')}
        </Text>
      </Tappable>
      {open &&
        routes.map((route) => (
          <Text key={`${route.method} ${route.path}`} selectable style={[styles.route, { color: c.secondaryText }]}>
            {route.method.padEnd(6)} {route.path}
          </Text>
        ))}
    </View>
  );
}

function CreateForm({ c, busy, reference, onChange, onCreate, onCancel }: {
  c: Colors;
  busy: boolean;
  reference: BotReference | null;
  onChange: () => void;
  onCreate: (input: { username: string; displayName: string; description: string; scopes: BotScope[] }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [scopes, setScopes] = useState<BotScope[]>(['rooms:read', 'messages:write']);
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    onChange();
    set(value);
  };
  const ready = username.trim() !== '' && displayName.trim() !== '';
  return (
    <View style={styles.form}>
      <Text style={[styles.title, { color: c.text }]}>{t('bots.create')}</Text>
      <PillField c={c} label={t('bots.username')} value={username} editable={!busy} autoCapitalize="none" autoCorrect={false} maxLength={64} onChangeText={edit(setUsername)} />
      <PillField c={c} label={t('bots.displayName')} value={displayName} editable={!busy} maxLength={128} onChangeText={edit(setDisplayName)} />
      <PillField c={c} label={t('bots.description')} value={description} editable={!busy} multiline maxLength={512} onChangeText={edit(setDescription)} />
      <ScopeList c={c} scopes={scopes} reference={reference} disabled={busy} onToggle={(scope) => edit(setScopes)(toggleScope(scopes, scope))} />
      <Action c={c} label={t('bots.createConfirm')} disabled={busy || !ready} onPress={() => onCreate({ username, displayName, description, scopes })} />
      <Action c={c} label={t('common.cancel')} disabled={busy} onPress={onCancel} />
    </View>
  );
}

function Detail({ c, bot, busy, reference, keys, created, baseUrl, onSave, onCreateKey, onRevokeKey, onDismissKey, onCopy, onDelete, onBack }: {
  c: Colors;
  bot: Bot;
  busy: boolean;
  reference: BotReference | null;
  keys: BotKey[] | null;
  created: BotKeyCreated | null;
  baseUrl: string;
  onSave: (description: string, scopes: BotScope[]) => void;
  onCreateKey: (label: string, days: number | null) => void;
  onRevokeKey: (key: BotKey) => void;
  onDismissKey: () => void;
  onCopy: (value: string) => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [description, setDescription] = useState(bot.description);
  const [scopes, setScopes] = useState<BotScope[]>(bot.scopes);
  const changed = description.trim() !== bot.description || !sameScopes(scopes, bot.scopes);
  const date = (value: string) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
  };
  const example = created === null ? '' : curlExample(baseUrl, created.key);
  return (
    <View style={styles.form}>
      <Action c={c} label={`‹ ${t('bots.back')}`} disabled={busy} onPress={onBack} />
      <View style={styles.bot}>
        <AvatarTile c={c} hueKey={bot.user.username} initial={bot.user.username.charAt(0)} size={48} radius={15} />
        <View style={styles.botTexts}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
            {bot.user.display_name || bot.user.username}
          </Text>
          <Text style={[styles.text, { color: c.dimmed }]} selectable>
            @{bot.user.username}
          </Text>
          <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.created', { date: date(bot.created_at) })}</Text>
        </View>
      </View>
      {bot.disabled && <Text style={[styles.text, { color: c.errorText }]}>{t('bots.disabledBody')}</Text>}

      <PillField c={c} label={t('bots.description')} value={description} editable={!busy} multiline maxLength={512} onChangeText={setDescription} />
      <ScopeList c={c} scopes={scopes} reference={reference} disabled={busy} onToggle={(scope) => setScopes(toggleScope(scopes, scope))} />
      <Action c={c} label={t('common.save')} disabled={busy || !changed} onPress={() => onSave(description, scopes)} />

      <Text style={[styles.label, { color: c.dimmed }]}>{t('bots.keys')}</Text>
      {keys === null && busy && <ActivityIndicator color={c.accent} />}
      {keys !== null && keys.length === 0 && <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.noKeys')}</Text>}
      {keys?.map((key) => (
        <View key={key.id} style={[styles.key, { borderColor: c.softBorder }]}>
          <Text style={[styles.strong, { color: c.text }]}>
            {key.label || t('bots.unnamedKey')} <Text style={[styles.code, { color: c.dimmed }]}>…{key.hint}</Text>
          </Text>
          <Text style={[styles.text, { color: c.secondaryText }]}>{t('bots.keyCreated', { date: date(key.created_at) })}</Text>
          <Text style={[styles.text, { color: c.secondaryText }]}>
            {key.expires_at == null ? t('bots.keyNoExpiry') : t('bots.keyExpires', { date: date(key.expires_at) })}
          </Text>
          <Text style={[styles.text, { color: c.secondaryText }]}>
            {key.last_used_at == null ? t('bots.keyNeverUsed') : t('bots.keyUsed', { date: date(key.last_used_at) })}
          </Text>
          <Action c={c} label={t('bots.revoke')} danger disabled={busy} onPress={() => onRevokeKey(key)} />
        </View>
      ))}
      {/* Shown where the key was asked for, beside the form the user just used. */}
      {created !== null && (
        <View style={[styles.secret, { borderColor: c.yellow, backgroundColor: c.card }]}>
          <Text accessibilityRole="alert" style={[styles.strong, { color: c.yellow }]}>
            {t('bots.keyOnce')}
          </Text>
          <Text selectable style={[styles.code, { color: c.text }]}>
            {created.key}
          </Text>
          <Action c={c} label={t('bots.copyKey')} onPress={() => onCopy(created.key)} />
          <Text style={[styles.text, { color: c.secondaryText }]}>{t('bots.example')}</Text>
          <Text selectable style={[styles.code, { color: c.text }]}>
            {example}
          </Text>
          <Action c={c} label={t('bots.copyExample')} onPress={() => onCopy(example)} />
          <Action c={c} label={t('bots.keyDone')} onPress={onDismissKey} />
        </View>
      )}
      {/* Remounted by each new key: the form empties only once a key exists, so
          a refusal (a sign-in to confirm first) keeps what was typed. */}
      {!bot.disabled && <KeyForm key={created?.info.id ?? 'new'} c={c} busy={busy} onCreateKey={onCreateKey} />}

      <Action c={c} label={t('bots.delete')} danger disabled={busy} onPress={onDelete} />
      <Text style={[styles.text, { color: c.dimmed }]}>{t('bots.deleteHint')}</Text>
    </View>
  );
}

function KeyForm({ c, busy, onCreateKey }: { c: Colors; busy: boolean; onCreateKey: (label: string, days: number | null) => void }) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('');
  const expiry = expiryDays(days);
  return (
    <View style={styles.form}>
      <PillField c={c} label={t('bots.keyLabel')} value={label} editable={!busy} maxLength={64} onChangeText={setLabel} />
      <PillField c={c} label={t('bots.keyDays')} value={days} editable={!busy} keyboardType="number-pad" maxLength={4} onChangeText={setDays} />
      {expiry === undefined && <Text style={[styles.text, { color: c.errorText }]}>{t('bots.keyDaysInvalid')}</Text>}
      <Action
        c={c}
        label={t('bots.createKey')}
        disabled={busy || label.trim() === '' || expiry === undefined}
        onPress={() => {
          if (expiry !== undefined) onCreateKey(label, expiry);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8, marginLeft: 4 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  form: { gap: 10 },
  bot: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  botTexts: { flex: 1, gap: 2 },
  title: { fontFamily: FONTS.title, fontSize: 16 },
  text: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  strong: { fontFamily: FONTS.bodyBold, fontSize: 13.5, lineHeight: 19 },
  label: { fontFamily: FONTS.bodyStrong, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 6 },
  action: { fontFamily: FONTS.bodyBold, fontSize: 13, paddingVertical: 8 },
  chevron: { fontFamily: FONTS.title, fontSize: 22 },
  scopes: { gap: 8 },
  scope: { gap: 2 },
  scopeHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 },
  check: { fontSize: 18, width: 22, textAlign: 'center' },
  code: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18 },
  routes: { marginLeft: 32, gap: 2 },
  disclosure: { fontFamily: FONTS.bodyBold, fontSize: 12, paddingVertical: 4 },
  route: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
  secret: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  key: { gap: 4, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
});
