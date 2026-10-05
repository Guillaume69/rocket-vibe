/**
 * "My profile": editing MY own information, like the official app's account
 * page. A real page (not a formSheet: there is a keyboard), modelled on
 * `Settings`.
 *
 * Three server levers, gathered behind a single "Save" button that calls ONLY
 * the endpoints of the fields actually changed (`lib/myProfile`,
 * `lib/upload`):
 *  - presence + status text -> `users.setStatus`
 *  - name, bio, email, username -> `users.updateOwnBasicInfo`
 *  - photo -> `users.setAvatar`
 *
 * Changing the email or the username is sensitive: the server requires the
 * current password and often raises 2FA. We then replay with the code, via
 * the SAME machinery as login (`prepareTwoFactorCode`).
 */

import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {File} from 'expo-file-system';
import {NativeError} from '../providers/rocketvibe/transport.ts';
import {profileIntent,nativeMyProfile,type SavedProfileOperation} from '../providers/rocketvibe/profileOperations.ts';
import {ConfirmNativeIdentity} from '../ui/nativeSecurity.tsx';

import { prepareTwoFactorCode } from '../lib/auth.ts';
import {
  diffInfos,
  saveBasicInfo,
  saveStatus,
  requiresPassword,
  type BasicInfo,
  readMyIdentity,
  readMyProfile,
  type MyProfile,
  type DefaultStatus,
} from '../lib/myProfile.ts';
import { RestClient, TwoFactorError, type TwoFactorCode } from '../lib/rest.ts';
import { hash } from '../lib/sessionStore.ts';
import { setAvatar, type FileToSend, avatarUrl } from '../lib/upload.ts';
import { pickAvatar } from '../ui/pickAvatar.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { PrimaryButton, PillField, AvatarTile } from '../ui/kit.tsx';
import type { TranslationKey } from '../ui/messages.ts';
import { useAvatarEtags } from '../ui/identities.tsx';
import { PRESENCE_KEYS, presenceColors } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { transportAvatarExpo } from '../ui/transportUpload.ts';
import { Tappable } from '../ui/tappable.tsx';

/** The four selectable statuses; colours and labels: ui/presence.ts. */
const PRESENCES: readonly DefaultStatus[] = ['online', 'away', 'busy', 'offline'];

/** The `common.presence*` keys are lowercase; here, entries of a picker. */
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

type Banner = { type: 'success' | 'error' | 'info'; text: string };

export default function MyProfileScreen() {
  const { state } = useSession();
  const c = useColors();
  // Reached from Settings; a logged-out state (logout in progress) sends
  // back to login rather than crashing on `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return <MyProfileForm c={c} client={state.client} username={state.session.username} />;
}

function MyProfileForm({
  c,
  client,
  username,
}: {
  c: Colors;
  client: RestClient;
  username: string;
}) {
  const t = useT();
  const router = useRouter();
  const { updateSessionProfile,state } = useSession();
  const sync = useSync();
  // The local store, to save my photo's version there after changing it.
  // `null` while the database is not ready; saving works anyway, the catch-up
  // of the next connection setup (`me`) will set the etag.
  const store = sync.phase === 'ready' ? sync.engine.syncStore : null;
  const chat=sync.phase==='ready'?sync.provider.native?.chat:null;
  const native=client.kind==='rocketvibe';
  const profileVersion=chat?.profileVersionFor(state.phase==='connected'?state.session.userId:null);
  const online=chat?.status.online===true;
  const etags = useAvatarEtags();
  // `initial` = reference read on load; `form` = values being edited.
  // Their diff decides which endpoints to call. After a successful save,
  // `form` BECOMES the new reference (the diff starts from zero).
  const [initial, setInitial] = useState<MyProfile | null>(null);
  const [form, setForm] = useState<MyProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [localAvatar, setLocalAvatar] = useState<FileToSend | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [nativeIntent,setNativeIntent]=useState<SavedProfileOperation|null>(null);
  const [nativeAvatar,setNativeAvatar]=useState<SavedProfileOperation|null>(null);
  const [nativeProof,setNativeProof]=useState(false);
  const currentClient=useRef<RestClient|null>(client);
  useEffect(()=>{currentClient.current=client;return()=>{currentClient.current=null;};},[client]);

  // Second factor requested by `users.updateOwnBasicInfo` (email/username).
  const [twoFactorRequest, setTwoFactorRequest] = useState<TwoFactorError | null>(null);
  const [code, setCode] = useState('');

  // Reentrancy guard in a ref (not in `busy`): two events in the same
  // frame would both read the old value; same reason as at login.
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    if(native&&(!chat?.status.online||!chat.capabilities?.profiles))return;
    const load=async()=>{
      if(!native)return readMyProfile(client);
      const p=nativeMyProfile(await chat!.ownProfile()),saved=await chat!.store.profileOperations.get('profile'),avatar=await chat!.store.profileOperations.get('avatar');
      if(alive){setNativeIntent(saved);setNativeAvatar(avatar);setNativeProof(saved?.phase==='proof'||avatar?.phase==='proof');}
      return {current:p,desired:profileIntent(saved,p)};
    };
    void load()
      .then((value) => {
        if (!alive) return;
        setInitial(previous=>native&&previous?previous:('current' in value?value.current:value));
        setForm(previous=>native&&previous?previous:('desired' in value?value.desired:value));
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : translateCurrent('myProfile.profileUnreadable'));
      });
    return () => {
      alive = false;
    };
  }, [client,native,chat,online,profileVersion]);

  const updateField = useCallback((field: keyof MyProfile, value: string) => {
    setBanner(null);
    setForm((f) => (f === null ? f : { ...f, [field]: value }));
  }, []);

  const pickPhoto = useCallback(async () => {
    try {
      const f = await pickAvatar(native);
      if (f !== null) {
        setLocalAvatar(f);
        setBanner(null);
      }
    } catch (e) {
      setBanner({ type: 'error', text: e instanceof Error ? e.message : t('myProfile.selectionFailed') });
    }
  }, [t,native]);

  const save = useCallback(
    async (twoFactor?: TwoFactorCode,nativeProofGiven=false) => {
      if (form === null || initial === null || inFlight.current) return;

      if(native){
        if(!chat)return;
        inFlight.current=true;setBusy(true);setBanner(null);
        let latest=initial;
        try{
          const saved=await chat.store.profileOperations.get('profile');
          if(saved?.phase==='proof'){
            if(!nativeProofGiven)throw new NativeError(403,'reauthentication_required');
            await chat.store.profileOperations.mark(saved,'pending',null);
          }
          const change=Object.keys(diffInfos(initial,form)).length>0||form.status!==initial.status||form.statusText!==initial.statusText;
          if(change||saved){latest=nativeMyProfile(await chat.editOwnProfile({...form,revision:latest.revision}));if(currentClient.current!==client)return;setInitial(latest);setForm(latest);setNativeIntent(null);}
          const avatar=await chat.store.profileOperations.get('avatar');
          if(localAvatar){
            const file=new File(localAvatar.uri);if(file.size>2*1024*1024)throw new NativeError(413,'avatar_too_large');
            latest=nativeMyProfile(await chat.setOwnAvatar(latest.revision!,{mime:localAvatar.type,bytes:new Uint8Array(await file.arrayBuffer())}));
            if(currentClient.current!==client)return;
            setLocalAvatar(null);setNativeAvatar(null);setInitial(latest);setForm(latest);
          }else if(avatar){latest=nativeMyProfile(await chat.resumeProfile('avatar'));if(currentClient.current!==client)return;setNativeAvatar(null);setInitial(latest);setForm(latest);}
          setNativeProof(false);setBanner({type:'success',text:t('myProfile.profileSaved')});
        }catch(error){
          if(currentClient.current!==client)return;
          if(error instanceof NativeError&&error.code==='reauthentication_required')setNativeProof(true);
          setNativeIntent(await chat.store.profileOperations.get('profile').catch(()=>null));
          setNativeAvatar(await chat.store.profileOperations.get('avatar').catch(()=>null));
          setBanner({type:'error',text:t('native.error')});
        }finally{
          inFlight.current=false;if(currentClient.current===client)setBusy(false);
          if(currentClient.current===client&&chat.status.online&&latest.username!==username)await updateSessionProfile({username:latest.username});
        }
        return;
      }

      const info = diffInfos(initial, form);
      const statusChanged = form.status !== initial.status || form.statusText !== initial.statusText;
      const avatarChange = localAvatar !== null;
      if (Object.keys(info).length === 0 && !statusChanged && !avatarChange) {
        setBanner({ type: 'info', text: t('myProfile.nothingToSave') });
        return;
      }
      if (requiresPassword(info) && password.trim() === '') {
        setBanner({
          type: 'error',
          text: t('myProfile.passwordRequired'),
        });
        return;
      }

      inFlight.current = true;
      setBusy(true);
      setBanner(null);
      try {
        // Each successful step becomes SETTLED at once (`initial` updated field by
        // field, `localAvatar` cleared as soon as the photo is set): a resubmission
        // after a LATER step fails then replays only what remains. Before, the
        // single `catch` left `initial` intact: the resubmission replayed an
        // already accepted username, which the server refused ("already taken"),
        // and the screen became unusable for the only remaining step. The error
        // banner now only carries the step that really failed.

        // Basic info FIRST: the only call likely to require 2FA. If it asks for it,
        // it throws BEFORE any side effect (status, avatar); we prompt, then replay
        // the whole function with the code.
        if (Object.keys(info).length > 0) {
          const data: BasicInfo = { ...info };
          if (requiresPassword(info)) data.currentPassword = await hash(password);
          await saveBasicInfo(client, data, twoFactor);
          setInitial((i) => (i === null ? i : { ...i, ...info }));
          setPassword('');
          // The username is carried by the session (Settings, this screen's
          // avatar): refresh it right away, otherwise it would keep the old value
          // until a reconnection.
          if (info.username !== undefined) await updateSessionProfile({ username: info.username });
        }
        if (statusChanged) {
          await saveStatus(client, { status: form.status, message: form.statusText });
          setInitial((i) =>
            i === null ? i : { ...i, status: form.status, statusText: form.statusText },
          );
        }
        if (avatarChange) {
          await setAvatar({ client, transport: transportAvatarExpo, file: localAvatar });
          setLocalAvatar(null);
        }

        // The photo's new VERSION (`avatarETag`), reread at the source and stored in
        // the database: it is what moves the avatar URI everywhere else (room list,
        // messages, Settings); otherwise Android's image cache would keep serving
        // the old photo. The `updateAvatar` stream would say so too, but the visual
        // feedback is not made to depend on a socket that may have dropped.
        // Best-effort: the photo is already saved server-side, a failure here
        // undoes nothing.
        if ((avatarChange || info.username !== undefined) && store !== null) {
          const me = await readMyIdentity(client).catch(() => null);
          if (me !== null) await store.saveIdentity(me).catch(() => {});
        }

        setTwoFactorRequest(null);
        setCode('');
        setBanner({ type: 'success', text: t('myProfile.profileSaved') });
      } catch (e) {
        if (e instanceof TwoFactorError) {
          // The server wants a second factor, or rejects the one we just
          // sent, in which case it raises the same error.
          if (twoFactor !== undefined) setBanner({ type: 'error', text: t('myProfile.codeRejected') });
          setCode('');
          setTwoFactorRequest(e);
        } else {
          setBanner({
            type: 'error',
            text: e instanceof Error ? e.message : t('myProfile.saveFailed'),
          });
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [form, initial, localAvatar, password, client, store, updateSessionProfile, t,native,chat,username],
  );

  const submitCode = useCallback(async () => {
    if (twoFactorRequest === null || code.trim() === '') return;
    try {
      const prepare = await prepareTwoFactorCode(twoFactorRequest, code, hash);
      await save(prepare);
    } catch (e) {
      setBanner({
        type: 'error',
        text: e instanceof Error ? e.message : t('myProfile.codePrepareFailed'),
      });
    }
  }, [twoFactorRequest, code, save, t]);

  if (loadError !== null) {
    return (
      <KeyboardAvoidingContainer>
        <Stack.Screen options={{ title: t('myProfile.title') }} />
        <View style={styles.center}>
          <Text style={[styles.loadError, { color: c.errorText }]}>{loadError}</Text>
        </View>
      </KeyboardAvoidingContainer>
    );
  }

  if (form === null) {
    return (
      <KeyboardAvoidingContainer>
        <Stack.Screen options={{ title: t('myProfile.title') }} />
        <View style={styles.center}>
          <ActivityIndicator color={c.accent} />
        </View>
      </KeyboardAvoidingContainer>
    );
  }

  const needsPassword = !native&&(form.email !== initial?.email || form.username !== initial?.username);
  const waiting=native&&[nativeIntent,nativeAvatar].some(s=>s?.phase==='pending'||s?.phase==='proof');
  const avatarDraft=nativeAvatar?.command.kind==='avatar'?nativeAvatar.command.upload:null;
  const avatarUri =
    localAvatar?.uri ?? (avatarDraft?`data:${avatarDraft.mime};base64,${avatarDraft.base64}`:avatarUrl(client, { username, etag: etags.byUsername.get(username) }));

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('myProfile.title') }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {native&&chat&&(nativeIntent||nativeAvatar)&&<View style={styles.twoFactorCard}>
          <Text style={{color:c.dimmed}}>{t([nativeIntent,nativeAvatar].some(s=>s?.phase==='failed')?'native.profileRefused':'native.pending')}</Text>
          {[nativeIntent,nativeAvatar].filter((s):s is SavedProfileOperation=>s!==null&&s.phase!=='pending').map(s=><Tappable key={s.command.kind} onPress={()=>void(async()=>{
            if(await chat.discardProfile(s.command.kind,s.command.input.operation_id)){
              const p=nativeMyProfile(await chat.ownProfile());if(currentClient.current!==client)return;setInitial(p);
              if(s.command.kind==='profile'){setNativeIntent(null);setNativeProof(false);}else setNativeAvatar(null);
            }
          })().catch(()=>{if(currentClient.current===client)setBanner({type:'error',text:t('native.error')});})}><Text style={{color:c.cyan}}>{t('common.cancel')}</Text></Tappable>)}
        </View>}
        {nativeProof&&chat?.capabilities?.reauthentication&&<ConfirmNativeIdentity c={c} chat={chat} onConfirmed={()=>void save(undefined,true)}/>}
        {/* Avatar: tap to change. Immediate preview of the chosen photo. */}
        <View style={styles.avatarBlock}>
          <Pressable
            disabled={busy||waiting||(native&&!chat?.capabilities?.profile_avatars)}
            onPress={() => void pickPhoto()}
            accessibilityRole="button"
            accessibilityLabel={t('myProfile.changePhotoLabel')}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <AvatarTile
              c={c}
              key={username}
              initial={(form.name || username).charAt(0)}
              size={96}
              radius={30}
              uri={avatarUri}
            />
            <View style={[styles.pencil, { backgroundColor: c.accent, borderColor: c.background }]}>
              <Text style={styles.pencilGlyph}>✎</Text>
            </View>
          </Pressable>
          <Pressable disabled={busy||waiting||(native&&!chat?.capabilities?.profile_avatars)} onPress={() => void pickPhoto()} hitSlop={8}>
            <Text style={[styles.changePhoto, { color: c.cyan }]}>{t('myProfile.changePhoto')}</Text>
          </Pressable>
        </View>

        {/* Presence */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('myProfile.sectionPresence')}</Text>
        <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
          {PRESENCES.map((p, i) => {
            const active = form.status === p;
            const label = capitalize(t(PRESENCE_KEYS[p]));
            return (
              <View key={p} style={styles.presenceWrapper}>
                <Tappable
                  onPress={() => {
                    if(busy||waiting)return;
                    setBanner(null);
                    setForm((f) => (f === null ? f : { ...f, status: p }));
                  }}
                  android_ripple={{ color: c.ripple }}
                  unstable_pressDelay={LIST_PRESS_DELAY}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={label}
                  style={[
                    styles.presenceRow,
                    i > 0 && {
                      borderTopColor: c.softBorder,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <View style={[styles.badge, { backgroundColor: presenceColors(c)[p] }]} />
                  <Text
                    style={[
                      styles.presenceText,
                      { color: active ? c.text : c.secondaryText },
                      active && styles.presenceTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                  <View style={[styles.radio, { borderColor: active ? c.accent : c.border }]}>
                    {active && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
                  </View>
                </Tappable>
              </View>
            );
          })}
        </View>

        <PillField
          c={c}
          label={t('myProfile.labelStatus')}
          value={form.statusText}
          editable={!busy&&!waiting}
          onChangeText={(v) => updateField('statusText', v)}
          placeholder={t('myProfile.placeholderStatus')}
          autoCapitalize="sentences"
          maxLength={120}
        />

        {/* Profil */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('myProfile.sectionProfile')}</Text>
        <PillField
          c={c}
          label={t('myProfile.labelName')}
          value={form.name}
          editable={!busy&&!waiting}
          onChangeText={(v) => updateField('name', v)}
          placeholder={t('myProfile.placeholderName')}
          autoCapitalize="words"
        />
        <PillField
          c={c}
          label={t('myProfile.labelBio')}
          value={form.bio}
          editable={!busy&&!waiting}
          onChangeText={(v) => updateField('bio', v)}
          placeholder={t('myProfile.placeholderBio')}
          autoCapitalize="sentences"
          maxLength={260}
          multiline
        />

        {/* Account, sensitive: email and username require the password. */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('myProfile.sectionAccount')}</Text>
        <Text style={[styles.help, { color: c.dimmed }]}>{t('myProfile.accountHelp')}</Text>
        <PillField
          c={c}
          label={t('myProfile.labelEmail')}
          value={form.email}
          editable={!native&&!busy}
          onChangeText={(v) => updateField('email', v)}
          placeholder={t('myProfile.placeholderEmail')}
          keyboardType="email-address"
          autoComplete="email"
        />
        {native&&<Tappable onPress={()=>router.back()}><Text style={[styles.help,{color:c.cyan}]}>{t('myProfile.nativeEmail')}</Text></Tappable>}
        <PillField
          c={c}
          label={t('myProfile.labelUsername')}
          value={form.username}
          editable={!busy&&!waiting}
          icon="@"
          onChangeText={(v) => updateField('username', v)}
          placeholder={t('myProfile.placeholderUsername')}
        />
        {needsPassword && (
          <PillField
            c={c}
            label={t('myProfile.labelPassword')}
            value={password}
            icon="🔒"
            onChangeText={setPassword}
            placeholder="••••••••"
            autoComplete="current-password"
            secureTextEntry
          />
        )}

        {twoFactorRequest !== null && (
          <View style={[styles.twoFactorCard, { backgroundColor: c.card, borderColor: c.purple }]}>
            <Text style={[styles.twoFactorTitle, { color: c.text }]}>{t('myProfile.verificationRequired')}</Text>
            <Text style={[styles.help, { color: c.dimmed }]}>{t(twoFactorLabel(twoFactorRequest.method))}</Text>
            <PillField
              c={c}
              label={t('myProfile.labelCode')}
              value={code}
              large={twoFactorRequest.method !== 'password'}
              onChangeText={setCode}
              onSubmitEditing={() => void submitCode()}
              placeholder={twoFactorRequest.method === 'password' ? '••••••••' : '123456'}
              keyboardType={twoFactorRequest.method === 'password' ? 'default' : 'number-pad'}
              autoComplete={twoFactorRequest.method === 'password' ? 'current-password' : 'one-time-code'}
              secureTextEntry={twoFactorRequest.method === 'password'}
              autoFocus
            />
            <PrimaryButton c={c} busy={busy} onPress={() => void submitCode()} title={t('myProfile.submitCode')} />
          </View>
        )}

        {banner !== null && (
          <View
            style={[
              styles.banner,
              {
                backgroundColor: banner.type === 'error' ? c.errorCard : c.card,
                borderColor:
                  banner.type === 'error'
                    ? c.danger
                    : banner.type === 'success'
                      ? c.online
                      : c.border,
              },
            ]}
          >
            <Text
              style={[
                styles.bannerText,
                {
                  color:
                    banner.type === 'error'
                      ? c.errorText
                      : banner.type === 'success'
                        ? c.online
                        : c.secondaryText,
                },
              ]}
            >
              {banner.text}
            </Text>
          </View>
        )}

        <PrimaryButton
          c={c}
          busy={busy}
          onPress={() => void save()}
          title={t('common.save')}
          style={styles.save}
        />
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, { color: c.dimmed }]}>{t('common.cancel')}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingContainer>
  );
}

/** Subtitle of the 2FA block depending on the method the server asks for. */
function twoFactorLabel(method: TwoFactorError['method']): TranslationKey {
  if (method === 'totp') return 'myProfile.help2faTotp';
  if (method === 'email') return 'myProfile.help2faEmail';
  return 'myProfile.help2faPassword';
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadError: { fontFamily: FONTS.bodyBold, fontSize: 14, textAlign: 'center' },
  avatarBlock: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  pressed: { opacity: 0.7 },
  pencil: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pencilGlyph: { fontSize: 14, color: '#FFFFFF' },
  changePhoto: { fontFamily: FONTS.bodyBold, fontSize: 14 },
  sectionTitle: {
    fontFamily: FONTS.bodyStrong,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginLeft: 4,
  },
  card: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16 },
  // The radius lives on the WRAPPER: only a parent's clip (`overflow`) cuts
  // the ripple; borderRadius on the Pressable is ignored by the ripple mask
  // under Fabric. Invisible at rest (no background).
  presenceWrapper: { borderRadius: 12, overflow: 'hidden' },
  presenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  badge: { width: 11, height: 11, borderRadius: 6 },
  presenceText: { fontFamily: FONTS.bodyBold, fontSize: 15, flex: 1 },
  presenceTextActive: { fontFamily: FONTS.bodyStrong },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18, marginLeft: 4 },
  twoFactorCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10, marginTop: 4 },
  twoFactorTitle: { fontFamily: FONTS.title, fontSize: 17 },
  banner: { borderRadius: 14, borderWidth: 1, padding: 14 },
  bannerText: { fontFamily: FONTS.bodyBold, fontSize: 14 },
  save: { marginTop: 8 },
  cancel: { fontFamily: FONTS.bodyBold, fontSize: 14, textAlign: 'center', paddingVertical: 12 },
});
