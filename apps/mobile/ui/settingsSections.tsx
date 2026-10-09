/**
 * The content of the settings categories (`ui/settingsCategories.ts`): the
 * sections that sat one under the other on the single settings page, moved
 * here unchanged and grouped by category. `app/settings/index.tsx` lists the
 * categories, `app/settings/[category].tsx` renders one with
 * `SettingsCategoryContent`.
 *
 * The push preference is GLOBAL to the account (Rocket.Chat's
 * `settings.preferences.pushNotifications`), not per room: it is the default
 * "when to notify me on this device". Read via `GET me`, written via
 * `POST users.setPreferences` (`{ data: { pushNotifications } }`). The server
 * knows a 4th level `'default'` (follow the server setting); we only expose
 * the three the original app asks for. If the account is on `'default'`, no
 * option is checked until the first choice, which is honest rather than
 * misleading.
 */

import Constants from 'expo-constants';
import { Link, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, View } from 'react-native';

import { readMyProfile } from '../lib/myProfile.ts';
import { getFcmToken } from '../lib/push.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import type { NativeChat } from '../providers/rocketvibe/chat.ts';
import type { Provider, SidebarSettings } from '../lib/provider.ts';
import { BotsSection } from './bots.tsx';
import { WorkflowsSection } from './workflows.tsx';
import { DevicesSection } from './devices.tsx';
import { useE2EUnlocked } from './e2e.ts';
import { EncryptedIdentitySection } from './encryptedIdentity.tsx';
import { setLanguage, useT, useLanguagePreference } from './i18n.ts';
import { useAvatarEtags } from './identities.tsx';
import { AvatarTile } from './kit.tsx';
import {
  type TranslationKey,
  LANGUAGES,
  LANGUAGE_NAMES,
  type LanguagePreference,
  type TranslateFn,
} from './messages.ts';
import { NativeSecuritySection } from './nativeSecurity.tsx';
import { setServerRailHidden, useServerRailHidden } from './serverRailSetting.ts';
import { useNativePreferences } from './nativePreferences.ts';
import type { SettingsCategory } from './settingsCategories.ts';
import { useSync } from './sync.tsx';
import { Tappable } from './tappable.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS } from './theme.ts';

type PushLevel = 'all' | 'mention' | 'nothing';
const OPTIONS_PUSH: { value: PushLevel; key: TranslationKey }[] = [
  { value: 'all', key: 'settings.pushAll' },
  { value: 'mention', key: 'settings.pushMentions' },
  { value: 'nothing', key: 'settings.pushNone' },
];

/** What a category page needs of the session. */
export type SettingsAccount = {
  client: RestClient;
  username: string;
  baseUrl: string;
};

/** The server as a person reads it: no scheme, no trailing slash. */
export function serverLabel(baseUrl: string): string {
  return baseUrl.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}

/** The current server's native chat, once the session is ready. */
function useNativeChat(): NativeChat | null {
  const sync = useSync();
  return sync.phase === 'ready' ? (sync.provider.native?.chat ?? null) : null;
}

/**
 * My display name, for the profile card; `null` while unknown or when the
 * server has none (the card then shows the username alone). Rocket.Chat reads
 * `GET me`, the native provider my own profile when it offers profiles.
 */
export function useMyName(client: RestClient): string | null {
  const chat = useNativeChat();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const read =
      client.kind === 'rocketvibe'
        ? chat?.capabilities?.profiles
          ? chat.ownProfile().then((own) => own.profile.user.display_name ?? null)
          : Promise.resolve(null)
        : readMyProfile(client).then((p) => p.name);
    read
      .then((n) => {
        if (alive) setName(n?.trim() || null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, chat]);
  return name;
}

/**
 * My avatar, name, `@username · server`, and a chevron: the head of the
 * settings list (opens My account) and the card of My account (opens the
 * profile editor, `link` then says so).
 */
export function ProfileCard({
  c,
  account,
  name,
  link,
  disabled = false,
  onPress,
}: {
  c: Colors;
  account: SettingsAccount;
  name: string | null;
  link?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  // Version of MY photo: without it, the profile card would keep the old
  // image even after changing it in "My profile" (frozen image cache).
  const etags = useAvatarEtags();
  const { client, username, baseUrl } = account;
  return (
    <Tappable
      disabled={disabled}
      onPress={onPress}
      android_ripple={{ color: c.ripple }}
      unstable_pressDelay={LIST_PRESS_DELAY}
      accessibilityRole="button"
      accessibilityLabel={link ?? name ?? `@${username}`}
      style={({ pressed }) => [
        styles.profileCard,
        { backgroundColor: c.deepCard, borderColor: c.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <AvatarTile
        c={c}
        hueKey={username}
        initial={(name ?? username).charAt(0)}
        uri={avatarUrl(client, { username, etag: etags.byUsername.get(username) })}
      />
      <View style={styles.profileTexts}>
        <Text style={[styles.profileName, { color: c.text }]} numberOfLines={1}>
          {name ?? `@${username}`}
        </Text>
        <Text style={[styles.profileSub, { color: c.dimmed }]} numberOfLines={1}>
          {name !== null ? `@${username} · ` : ''}
          {serverLabel(baseUrl)}
        </Text>
        {link !== undefined && <Text style={[styles.profileLink, { color: c.cyan }]}>{link}</Text>}
      </View>
      <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
    </Tappable>
  );
}

/** The body of one category page. */
export function SettingsCategoryContent({
  c,
  category,
  account,
}: {
  c: Colors;
  category: SettingsCategory;
  account: SettingsAccount;
}) {
  switch (category) {
    case 'account':
      return <AccountCategory c={c} account={account} />;
    case 'notifications':
      return <NotificationsCategory c={c} client={account.client} />;
    case 'language':
      return <LanguageCategory c={c} client={account.client} />;
    case 'encryption':
      return account.client.kind === 'rocketvibe' ? <EncryptedIdentitySection c={c} /> : <SectionE2E c={c} />;
    case 'security':
      return <NativeSecuritySection c={c} />;
    case 'devices':
      return <DevicesSection c={c} />;
    case 'bots':
      return <BotsSection c={c} client={account.client} baseUrl={account.baseUrl} />;
    case 'workflows':
      return <WorkflowsSection c={c} baseUrl={account.baseUrl} />;
    case 'accounts':
      return <AccountsCategory c={c} account={account} />;
    case 'app':
      return <AppCategory c={c} client={account.client} />;
  }
}

/** My account: the profile card, opening the profile editor (presence and status text live there). */
function AccountCategory({ c, account }: { c: Colors; account: SettingsAccount }) {
  const t = useT();
  const router = useRouter();
  const sync = useSync();
  const name = useMyName(account.client);
  const sidebar = sync.phase === 'ready' ? sync.provider.sidebarSettings : undefined;
  return (
    <>
      <ProfileCard
        c={c}
        account={account}
        name={name}
        link={t('settings.editProfile')}
        disabled={account.client.kind === 'rocketvibe' && (sync.phase !== 'ready' || !sync.provider.native?.chat.capabilities?.profiles)}
        onPress={() => router.push('/my-profile')}
      />
      {sidebar !== undefined && <SidebarSettingsCard c={c} source={sidebar} />}
    </>
  );
}

const NAME_FORMATS: readonly { value: SidebarSettings['nameFormat']; key: TranslationKey }[] = [
  { value: 'full_name', key: 'settings.nameFull' },
  { value: 'nickname_full_name', key: 'settings.nameNicknameFull' },
  { value: 'username', key: 'settings.nameUsername' },
];

/** Mattermost's own values: "all" is 10000, as its web app writes it. */
const DM_LIMITS: readonly number[] = [10000, 10, 15, 20, 40];

/**
 * The account's conversation list settings, kept on the server and shared
 * with kChat's own apps. Optimistic like the push preference: the choice
 * moves at once and comes back if the server refuses it.
 */
function SidebarSettingsCard({ c, source }: { c: Colors; source: NonNullable<Provider['sidebarSettings']> }) {
  const t = useT();
  const [value, setValue] = useState<SidebarSettings | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    source.read().then((v) => alive && setValue(v), () => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [source]);
  const change = (next: Partial<Pick<SidebarSettings, 'nameFormat' | 'dmLimit'>>) => {
    if (value === null) return;
    const before = value;
    setValue({ ...value, ...next });
    setError(false);
    source.write(next).catch(() => {
      setValue(before);
      setError(true);
    });
  };
  if (value === null) {
    return (
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.settingTitle, { color: c.text }]}>{t('settings.sidebarTitle')}</Text>
        {error ? <Text style={[styles.error, { color: c.errorText }]}>{t('settings.sidebarFailed')}</Text> : <View style={styles.loading}><ActivityIndicator color={c.accent} /></View>}
      </View>
    );
  }
  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Text style={[styles.settingTitle, { color: c.text }]}>{t('settings.sidebarTitle')}</Text>
      <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('settings.sidebarHelp')}</Text>
      <Text style={[styles.settingTitle, { color: c.text }]}>{t('settings.nameFormat')}</Text>
      {value.nameLocked && <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('settings.nameLocked')}</Text>}
      <RadioList
        c={c}
        options={NAME_FORMATS.map((o) => ({ id: o.value, label: t(o.key) }))}
        selected={value.nameFormat}
        disabled={value.nameLocked}
        onSelect={(id) => change({ nameFormat: id as SidebarSettings['nameFormat'] })}
      />
      <Text style={[styles.settingTitle, { color: c.text }]}>{t('settings.dmLimit')}</Text>
      <RadioList
        c={c}
        options={DM_LIMITS.map((n) => ({ id: String(n), label: n >= 10000 ? t('settings.dmAll') : String(n) }))}
        selected={String(value.dmLimit)}
        disabled={false}
        onSelect={(id) => change({ dmLimit: Number(id) })}
      />
      {error && <Text style={[styles.error, { color: c.errorText }]}>{t('settings.sidebarFailed')}</Text>}
    </View>
  );
}

function RadioList({ c, options, selected, disabled, onSelect }: {
  c: Colors;
  options: readonly { id: string; label: string }[];
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.options}>
      {options.map((o, i) => {
        const active = o.id === selected;
        return (
          <View key={o.id} style={styles.optionWrapper}>
            <Tappable
              onPress={() => onSelect(o.id)}
              disabled={disabled || active}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: active, disabled }}
              accessibilityLabel={o.label}
              style={[styles.optionRow, i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth }]}
            >
              <View style={[styles.radio, { borderColor: active ? c.accent : c.border }]}>
                {active && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
              </View>
              <Text style={[styles.optionText, { color: active ? c.text : c.secondaryText }, active && styles.optionTextActive]}>{o.label}</Text>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Reads and writes the push preference. `value === null` = still reading.
 * The write is OPTIMISTIC: we switch the UI right away and roll back if the
 * server refuses; a setting must respond to the finger, not to the network.
 */
function usePreferencePush(client: RestClient,natives:ReturnType<typeof useNativePreferences>) {
  const [value, setValue] = useState<string | null>(null);
  // The error is stored as a translation KEY, not a sentence: the component
  // translates it at render, in the current language.
  const [error, setError] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (client.kind !== 'rocketchat') return;
    let alive = true;
    client
      .get<MeResponse>('me')
      .then((r) => {
        if (alive) setValue(r.settings?.preferences?.pushNotifications ?? 'default');
      })
      .catch(() => {
        if (alive) setError('settings.pushNotFound');
      });
    return () => {
      alive = false;
    };
  }, [client]);

  // Sequence number: two choices in quick succession launch two concurrent
  // POSTs, and without it the FIRST one's `catch` restored the value from
  // BEFORE the second choice; the UI showed a level the server does not hold.
  // Only the LATEST choice keeps the right to roll back and show an error.
  const sequence = useRef(0);
  const set = useCallback(
    async (next: PushLevel) => {
      const n = ++sequence.current;
      const previous = value;
      setValue(next);
      setError(null);
      try {
        if(client.kind==='rocketvibe'){
          await natives.change({push_enabled:next!=='nothing',push_mentions_only:next==='mention'});
          return;
        }
        await client.post('users.setPreferences', {
          body: { data: { pushNotifications: next } },
        });
      } catch {
        if (sequence.current !== n) return;
        setValue(previous);
        setError('settings.saveFailed');
      }
    },
    [client, value,natives],
  );

  const p=natives.preferences;
  return { value:client.kind==='rocketvibe'?(p?(!p.push_enabled?'nothing':p.push_mentions_only?'mention':'all'):null):value,
    error:client.kind==='rocketvibe'?(natives.error?'settings.saveFailed' as const:null):error,
    disabled:client.kind==='rocketvibe'&&(natives.busy||natives.intention!==null),set };
}

type MeResponse = { settings?: { preferences?: { pushNotifications?: string } } };

/** The native preferences (push, language) of the current server, with their pending intent. */
function useNatives() {
  const sync=useSync();
  const chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  return useNativePreferences(chat,sync.phase==='ready'?sync.generation:0);
}

function NotificationsCategory({ c, client }: { c: Colors; client: RestClient }) {
  const t = useT();
  const natives = useNatives();
  const push = usePreferencePush(client,natives);
  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Text style={[styles.settingTitle, { color: c.text }]}>{t('settings.push')}</Text>
      <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('settings.pushHelp')}</Text>
      <NotificationChoice c={c} push={push} />
      {push.error !== null && (
        <Text style={[styles.error, { color: c.errorText }]}>{t(push.error)}</Text>
      )}
    </View>
  );
}

function LanguageCategory({ c, client }: { c: Colors; client: RestClient }) {
  const t = useT();
  const natives = useNatives();
  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('settings.languageHelp')}</Text>
      <LanguagePicker c={c} t={t} natives={client.kind==='rocketvibe'?natives:undefined} />
      {client.kind==='rocketvibe'&&natives.error&&<Text style={[styles.error,{color:c.errorText}]}>{t('native.error')}</Text>}
      {client.kind==='rocketvibe'&&natives.intention&&<>
        <Text style={[styles.settingHelp,{color:c.dimmed}]}>{t(natives.intention.phase==='failed'?'native.profileRefused':'native.pending')}</Text>
        <Tappable disabled={natives.busy} onPress={()=>void(natives.intention?.phase==='failed'?natives.discard():natives.resume())}>
          <Text style={[styles.action,{color:c.cyan}]}>{t(natives.intention.phase==='failed'?'common.cancel':'common.retry')}</Text>
        </Tappable>
      </>}
    </View>
  );
}

/**
 * Accounts: who is signed in, on which server, the way to another server, and
 * the switch hiding the server rail (that link stays the way to switch).
 */
function AccountsCategory({ c, account }: { c: Colors; account: SettingsAccount }) {
  const t = useT();
  const railHidden = useServerRailHidden();
  return (
    <>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Pair c={c} label={t('settings.signedIn')} value={`@${account.username}`} />
        <Pair c={c} label={t('settings.server')} value={account.baseUrl} />
      </View>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <View style={styles.switchRow}>
          <Text style={[styles.settingTitle, styles.grow, { color: c.text }]}>{t('settings.hideServerRail')}</Text>
          <Switch
            value={railHidden}
            onValueChange={setServerRailHidden}
            trackColor={{ true: c.accent }}
            accessibilityLabel={t('settings.hideServerRail')}
          />
        </View>
        <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('settings.hideServerRailHelp')}</Text>
      </View>
      <Link href="/login?change=1" style={[styles.link, { color: c.cyan }]}>
        {t('settings.switchServer')}
      </Link>
    </>
  );
}

/** App: the version, and the push diagnostics on Rocket.Chat. */
function AppCategory({ c, client }: { c: Colors; client: RestClient }) {
  const t = useT();
  return (
    <>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Pair c={c} label={t('settings.version')} value={Constants.expoConfig?.version ?? '?'} />
      </View>
      {client.kind !== 'rocketvibe' && <>
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('settings.sectionDiagnostics')}</Text>
        <FcmTokenSection c={c} t={t} />
      </>}
    </>
  );
}

/** Radio list of the three notification levels. Nothing checked while reading. */
function NotificationChoice({
  c,
  push,
}: {
  c: Colors;
  push: ReturnType<typeof usePreferencePush>;
}) {
  const t = useT();
  if (push.value === null && push.error === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <View style={styles.options}>
      {OPTIONS_PUSH.map((o, i) => {
        const active = push.value === o.value;
        const label = t(o.key);
        return (
          <View key={o.value} style={styles.optionWrapper}>
            <Tappable
              onPress={() => void push.set(o.value)}
              disabled={push.value === null||push.disabled}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={label}
              style={[
                styles.optionRow,
                i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: active ? c.accent : c.border }]}>
              {active && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
            </View>
              <Text
                style={[
                  styles.optionText,
                  { color: active ? c.text : c.secondaryText },
                  active && styles.optionTextActive,
                ]}
              >
                {label}
              </Text>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Language picker: "Automatic" (follows the phone) then each language by its
 * endonym. Same radio list as notifications. The switch is immediate
 * (`setLanguage` pushes into the subscribable store): the whole screen, title
 * included, re-renders in the new language without a reload.
 */
function LanguagePicker({ c, t,natives }: { c: Colors; t: TranslateFn;natives?:ReturnType<typeof useNativePreferences> }) {
  const preference = useLanguagePreference();
  const language=natives?.preferences?.language;
  useEffect(()=>{if(language!==undefined)setLanguage(language==='fr'||language==='en'?language:'auto');},[language]);
  const options: { pref: LanguagePreference; label: string; help?: string }[] = [
    { pref: 'auto', label: t('language.auto'), help: t('language.autoHelp') },
    ...LANGUAGES.map((l) => ({ pref: l, label: LANGUAGE_NAMES[l] })),
  ];
  return (
    <View style={styles.options}>
      {options.map((o, i) => {
        const active = preference === o.pref;
        return (
          <View key={o.pref} style={styles.optionWrapper}>
            <Tappable
              disabled={natives!==undefined&&(!natives.preferences||natives.busy||natives.intention!==null)}
              onPress={() => {setLanguage(o.pref);if(natives)void natives.change({language:o.pref});}}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={o.label}
              style={[
                styles.optionRow,
                i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: active ? c.accent : c.border }]}>
              {active && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
            </View>
              <View style={styles.optionTexts}>
                <Text
                  style={[
                    styles.optionText,
                    { color: active ? c.text : c.secondaryText },
                    active && styles.optionTextActive,
                  ]}
                >
                  {o.label}
                </Text>
                {o.help !== undefined && (
                  <Text style={[styles.optionHelp, { color: c.tertiaryText }]}>{o.help}</Text>
                )}
              </View>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/** Push diagnostics: proves the native FCM token was obtained. Moved from home. */
function FcmTokenSection({ c, t }: { c: Colors; t: TranslateFn }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback(async () => {
    setError(null);
    const r = await getFcmToken();
    if (r.ok) {
      setToken(r.token);
      console.log('FCM_TOKEN', r.token);
    } else {
      setError(`${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      console.log('FCM_TOKEN_FAILED', r.reason, r.detail ?? '');
    }
  }, []);

  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Tappable
        onPress={ask}
        // Text link: round `borderless` ripple; the bounded ripple mask ignores
        // borderRadius under Fabric, a calibrated radius does the job.
        android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
        unstable_pressDelay={LIST_PRESS_DELAY}
      >
        <Text style={[styles.action, { color: c.cyan }]}>{t('settings.getToken')}</Text>
      </Tappable>
      {token !== null && (
        <Text style={[styles.help, { color: c.text }]} selectable numberOfLines={3}>
          {token}
        </Text>
      )}
      {error !== null && <Text style={[styles.help, { color: c.errorText }]}>{error}</Text>}
    </View>
  );
}

/**
 * Encryption section: the device's locked/unlocked state. Locked, a link
 * opens the unlock sheet; unlocked, a button forgets the key (re-masks the
 * local plaintext).
 */
function SectionE2E({ c }: { c: Colors }) {
  const t = useT();
  const router = useRouter();
  const sync = useSync();
  const e2e = sync.phase === 'ready' ? sync.e2e : null;
  const unlocked = useE2EUnlocked(e2e);
  const [busy, setBusy] = useState(false);

  const lock = (): void => {
    if (sync.phase !== 'ready' || busy) return;
    setBusy(true);
    void sync.lockE2E().finally(() => setBusy(false));
  };

  return (
    <>
      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('settings.e2eTitle')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.settingHelp, { color: c.dimmed }]}>
          {t(unlocked ? 'settings.e2eUnlocked' : 'settings.e2eLocked')}
        </Text>
        {unlocked ? (
          <Tappable
            onPress={lock}
            disabled={busy}
            android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed || busy ? 0.6 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profileLink, { color: c.errorText }]}>
              {t('settings.e2eLock')}
            </Text>
          </Tappable>
        ) : (
          <Tappable
            onPress={() => router.push('/unlock-e2e')}
            android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profileLink, { color: c.cyan }]}>
              {t('settings.e2eUnlock')}
            </Text>
          </Tappable>
        )}
      </View>
    </>
  );
}

// `label`, never `key`: React keeps that prop to itself, the label showed empty.
function Pair({ c, label, value }: { c: Colors; label: string; value: string }) {
  return (
    <View style={styles.pair}>
      <Text style={[styles.key, { color: c.dimmed }]}>{label}</Text>
      <Text style={[styles.value, { color: c.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 40 },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  profileTexts: { flex: 1, gap: 2 },
  profileName: { fontFamily: FONTS.title, fontSize: 17 },
  profileSub: { fontFamily: FONTS.body, fontSize: 13 },
  profileLink: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  chevron: { fontFamily: FONTS.title, fontSize: 24 },
  sectionTitle: {
    fontFamily: FONTS.bodyStrong,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginLeft: 4,
  },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  settingTitle: { fontFamily: FONTS.title, fontSize: 16 },
  settingHelp: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1 },
  options: { marginTop: 2 },
  // The radius lives on the WRAPPER: only a parent's clip (`overflow`) cuts
  // the ripple; borderRadius on the Pressable is ignored by the ripple mask
  // under Fabric. Invisible at rest (no background).
  optionWrapper: { borderRadius: 12, overflow: 'hidden' },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 4,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  optionTexts: { flex: 1, gap: 1 },
  optionText: { fontFamily: FONTS.bodyBold, fontSize: 15, flexShrink: 1 },
  optionTextActive: { fontFamily: FONTS.bodyStrong },
  optionHelp: { fontFamily: FONTS.body, fontSize: 12 },
  loading: { paddingVertical: 18, alignItems: 'center' },
  error: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  pair: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  key: { fontFamily: FONTS.body, fontSize: 13 },
  value: { fontFamily: FONTS.bodyBold, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  action: { fontFamily: FONTS.bodyBold, fontSize: 13 },
  help: { fontFamily: FONTS.body, fontSize: 12, opacity: 0.9 },
  link: { fontFamily: FONTS.bodyBold, fontSize: 15, paddingVertical: 12, textAlign: 'center' },
});
