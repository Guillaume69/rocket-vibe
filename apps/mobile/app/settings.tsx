import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getFcmToken } from '../lib/push.ts';
import type { RestClient } from '../lib/rest.ts';
import { avatarUrl } from '../lib/upload.ts';
import { setLanguage, useT, useLanguagePreference } from '../ui/i18n.ts';
import { useAvatarEtags } from '../ui/identities.tsx';
import { AvatarTile } from '../ui/kit.tsx';
import {
  type TranslationKey,
  LANGUAGES,
  LANGUAGE_NAMES,
  type LanguagePreference,
  type TranslateFn,
} from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { useE2EUnlocked } from '../ui/e2e.ts';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { Tappable } from '../ui/tappable.tsx';
import {DevicesSection} from '../ui/devices.tsx';
import {NativeSecuritySection} from '../ui/nativeSecurity.tsx';
import {EncryptedIdentitySection} from '../ui/encryptedIdentity.tsx';
import {useNativePreferences} from '../ui/nativePreferences.ts';

/**
 * "Settings" screen: what used to sit at the bottom of the conversation list
 * (account, server, FCM token, logout), plus the push notification
 * preference, the genuinely new part.
 *
 * The preference is GLOBAL to the account (Rocket.Chat's
 * `settings.preferences.pushNotifications`), not per room: it is the default
 * "when to notify me on this device". Read via `GET me`, written via
 * `POST users.setPreferences` (`{ data: { pushNotifications } }`). The server
 * knows a 4th level `'default'` (follow the server setting); we only expose
 * the three the original app asks for. If the account is on `'default'`, no
 * option is checked until the first choice, which is honest rather than
 * misleading.
 */

type PushLevel = 'all' | 'mention' | 'nothing';
const OPTIONS_PUSH: { value: PushLevel; key: TranslationKey }[] = [
  { value: 'all', key: 'settings.pushAll' },
  { value: 'mention', key: 'settings.pushMentions' },
  { value: 'nothing', key: 'settings.pushNone' },
];

export default function SettingsScreen() {
  const c = useColors();
  const { state } = useSession();
  // Reached from the logged-in home; as a safeguard, a logged-out state
  // (logout in progress) sends back to login rather than crashing on `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return (
    <Settings
      c={c}
      client={state.client}
      username={state.session.username}
      baseUrl={state.session.baseUrl}
    />
  );
}

type MeResponse = { settings?: { preferences?: { pushNotifications?: string } } };

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
    if (client.kind === 'rocketvibe') return;
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

function Settings({
  c,
  client,
  username,
  baseUrl,
}: {
  c: Colors;
  client: RestClient;
  username: string;
  baseUrl: string;
}) {
  const router = useRouter();
  const t = useT();
  const { logOut } = useSession();
  const sync=useSync();
  const chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  const natives=useNativePreferences(chat,sync.phase==='ready'?sync.generation:0);
  const push = usePreferencePush(client,natives);
  const [logout, setLogout] = useState(false);
  // Version of MY photo: without it, the profile card would keep the old
  // image even after changing it in "My profile" (frozen image cache).
  const etags = useAvatarEtags();

  const handleLogOut = useCallback(() => {
    if (logout) return;
    setLogout(true);
    // `logOut` switches the session to "disconnected" synchronously (before
    // its first await): home, revealed by the back, then redirects to /login.
    // The network logout finishes best-effort in the background.
    void logOut();
    router.back();
  }, [logout, logOut, router]);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t('settings.title') }} />

      <Tappable
        disabled={client.kind==='rocketvibe'&&(sync.phase!=='ready'||!sync.provider.native?.chat.capabilities?.profiles)}
        onPress={() => router.push('/my-profile')}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        accessibilityRole="button"
        accessibilityLabel={t('settings.editProfile')}
        style={({ pressed }) => [
          styles.profileCard,
          { backgroundColor: c.deepCard, borderColor: c.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <AvatarTile
          c={c}
          key={username}
          initial={username.charAt(0)}
          uri={avatarUrl(client, { username, etag: etags.byUsername.get(username) })}
        />
        <View style={styles.profileTexts}>
          <Text style={[styles.profileName, { color: c.text }]} numberOfLines={1}>
            @{username}
          </Text>
          <Text style={[styles.profileLink, { color: c.cyan }]}>{t('settings.editProfile')}</Text>
        </View>
        <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
      </Tappable>

      {(client.kind !== 'rocketvibe'||sync.phase==='ready'&&sync.capabilities.push) && <>
      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('settings.sectionNotifications')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.settingTitle, { color: c.text }]}>{t('settings.push')}</Text>
        <Text style={[styles.settingHelp, { color: c.dimmed }]}>{t('settings.pushHelp')}</Text>
        <NotificationChoice c={c} push={push} />
        {push.error !== null && (
          <Text style={[styles.error, { color: c.errorText }]}>{t(push.error)}</Text>
        )}
      </View>
      </>}

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('settings.sectionLanguage')}</Text>
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

      {client.kind !== 'rocketvibe' && <SectionE2E c={c} t={t} />}

      {client.kind === 'rocketvibe' && <><NativeSecuritySection c={c}/><DevicesSection c={c}/><EncryptedIdentitySection c={c}/></>}

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('settings.sectionAccount')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Pair c={c} key={t('settings.signedIn')} value={`@${username}`} />
        <Pair c={c} key={t('settings.server')} value={baseUrl} />
      </View>

      {client.kind !== 'rocketvibe' && <>
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('settings.sectionDiagnostics')}</Text>
        <FcmTokenSection c={c} t={t} />
      </>}

      <Link href="/login?change=1" style={[styles.link, { color: c.cyan }]}>
        {t('settings.switchServer')}
      </Link>

      <Tappable
        onPress={handleLogOut}
        disabled={logout}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: c.errorCard, opacity: pressed || logout ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.secondaryButtonText, { color: c.errorText }]}>{t('settings.signOut')}</Text>
      </Tappable>
    </ScrollView>
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
function SectionE2E({ c, t }: { c: Colors; t: TranslateFn }) {
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

function Pair({ c, key, value }: { c: Colors; key: string; value: string }) {
  return (
    <View style={styles.pair}>
      <Text style={[styles.key, { color: c.dimmed }]}>{key}</Text>
      <Text style={[styles.value, { color: c.text }]} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
  button: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  secondaryButtonText: { fontFamily: FONTS.bodyBold, fontSize: 16 },
});
