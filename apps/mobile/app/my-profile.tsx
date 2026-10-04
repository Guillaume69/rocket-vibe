/**
 * « Mon profil » — édition de MES propres informations, comme le compte de
 * l'app officielle. Une vraie page (pas une formSheet : il y a un clavier), sur
 * le modèle de `Paramètres`.
 *
 * Trois leviers serveur, réunis derrière un seul bouton « Enregistrer » qui
 * n'appelle QUE les endpoints des champs réellement modifiés (`lib/myProfile`,
 * `lib/upload`) :
 *  - présence + texte de statut → `users.setStatus`
 *  - nom, bio, e-mail, nom d'utilisateur → `users.updateOwnBasicInfo`
 *  - photo → `users.setAvatar`
 *
 * Changer l'e-mail ou le nom d'utilisateur est sensible : le serveur exige le
 * mot de passe courant et lève souvent la 2FA. On rejoue alors avec le code,
 * via la MÊME machinerie que le login (`preparerCodeDeuxFacteurs`).
 */

import { Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
import { ClientRest, TwoFactorError, type TwoFactorCode } from '../lib/rest.ts';
import { hash } from '../lib/sessionStore.ts';
import { setAvatar, type FileToSend, urlAvatar } from '../lib/upload.ts';
import { pickAvatar } from '../ui/pickAvatar.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { translateCurrent, useT } from '../ui/i18n.ts';
import { PrimaryButton, PillField, AvatarTile } from '../ui/kit.tsx';
import type { TranslationKey } from '../ui/messages.ts';
import { useEtagsAvatars } from '../ui/identities.tsx';
import { PRESENCE_KEYS, presenceColors } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSync } from '../ui/sync.tsx';
import { type Colors, LIST_PRESS_DELAY, FONTS, useColors } from '../ui/theme.ts';
import { transportAvatarExpo } from '../ui/transportUpload.ts';
import { Tappable } from '../ui/tappable.tsx';

/** Les quatre statuts choisissables — couleurs et libellés : ui/presence.ts. */
const PRESENCES: readonly DefaultStatus[] = ['online', 'away', 'busy', 'offline'];

/** Les clés `commun.presence*` sont en minuscule ; ici, entrées d'un sélecteur. */
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

type Banner = { type: 'success' | 'error' | 'info'; text: string };

export default function MyProfileScreen() {
  const { state } = useSession();
  const c = useColors();
  // Atteint depuis Paramètres ; un état déconnecté (déconnexion en cours)
  // renvoie au login plutôt que de crasher sur `client`.
  if (state.phase !== 'connected') return <Redirect href="/login" />;
  return <MyProfileForm c={c} client={state.client} username={state.session.username} />;
}

function MyProfileForm({
  c,
  client,
  username,
}: {
  c: Colors;
  client: ClientRest;
  username: string;
}) {
  const t = useT();
  const router = useRouter();
  const { updateSessionProfile } = useSession();
  const sync = useSync();
  // Le dépôt local, pour y ranger la version de ma photo après l'avoir changée.
  // `null` tant que la base n'est pas prête — l'enregistrement marche quand même,
  // le rattrapage du prochain raccordement (`me`) posera l'etag.
  const store = sync.phase === 'ready' ? sync.engine.syncStore : null;
  const etags = useEtagsAvatars();
  // `initial` = référence lue au chargement ; `form` = valeurs en cours d'édition.
  // Le diff des deux décide quels endpoints appeler. Après un enregistrement
  // réussi, `form` DEVIENT la nouvelle référence (le diff repart à zéro).
  const [initial, setInitial] = useState<MyProfile | null>(null);
  const [form, setForm] = useState<MyProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [avatarLocal, setAvatarLocal] = useState<FileToSend | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  // Second facteur demandé par `users.updateOwnBasicInfo` (e-mail/pseudo).
  const [twoFactorRequest, setTwoFactorRequest] = useState<TwoFactorError | null>(null);
  const [code, setCode] = useState('');

  // Garde de réentrance en ref (pas dans `occupe`) : deux events d'une même
  // frame liraient tous deux l'ancienne valeur — même raison qu'au login.
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    readMyProfile(client)
      .then((p) => {
        if (!alive) return;
        setInitial(p);
        setForm(p);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : translateCurrent('monProfil.profilIllisible'));
      });
    return () => {
      alive = false;
    };
  }, [client]);

  const updateField = useCallback((field: keyof MyProfile, value: string) => {
    setBanner(null);
    setForm((f) => (f === null ? f : { ...f, [field]: value }));
  }, []);

  const pickPhoto = useCallback(async () => {
    try {
      const f = await pickAvatar();
      if (f !== null) {
        setAvatarLocal(f);
        setBanner(null);
      }
    } catch (e) {
      setBanner({ type: 'error', text: e instanceof Error ? e.message : t('monProfil.selectionImpossible') });
    }
  }, [t]);

  const save = useCallback(
    async (twoFactor?: TwoFactorCode) => {
      if (form === null || initial === null || inFlight.current) return;

      const info = diffInfos(initial, form);
      const statusChanged = form.status !== initial.status || form.statusText !== initial.statusText;
      const avatarChange = avatarLocal !== null;
      if (Object.keys(info).length === 0 && !statusChanged && !avatarChange) {
        setBanner({ type: 'info', text: t('monProfil.rienAEnregistrer') });
        return;
      }
      if (requiresPassword(info) && password.trim() === '') {
        setBanner({
          type: 'error',
          text: t('monProfil.mdpRequis'),
        });
        return;
      }

      inFlight.current = true;
      setBusy(true);
      setBanner(null);
      try {
        // Chaque étape réussie devient ACQUISE sur-le-champ (`initial` mis à
        // jour champ par champ, `avatarLocal` vidé dès la photo posée) : une
        // réémission après l'échec d'une étape SUIVANTE ne rejoue alors que ce
        // qui reste. Avant, le `catch` unique laissait `initial` intact : la
        // réémission rejouait un pseudo déjà accepté, que le serveur refusait
        // (« déjà pris »), et l'écran devenait inutilisable pour la seule étape
        // restante. Le bandeau d'erreur, lui, ne porte plus que l'étape qui a
        // vraiment échoué.

        // Les infos de base EN PREMIER : seul appel susceptible d'exiger la 2FA.
        // S'il la réclame, il lève AVANT tout effet de bord (statut, avatar) —
        // on prompte, puis on rejoue toute la fonction avec le code.
        if (Object.keys(info).length > 0) {
          const data: BasicInfo = { ...info };
          if (requiresPassword(info)) data.currentPassword = await hash(password);
          await saveBasicInfo(client, data, twoFactor);
          setInitial((i) => (i === null ? i : { ...i, ...info }));
          setPassword('');
          // Le pseudo est porté par la session (Paramètres, avatar de cet
          // écran) : le rafraîchir tout de suite, sinon il resterait à
          // l'ancienne valeur jusqu'à une reconnexion.
          if (info.username !== undefined) await updateSessionProfile({ username: info.username });
        }
        if (statusChanged) {
          await saveStatus(client, { status: form.status, message: form.statusText });
          setInitial((i) =>
            i === null ? i : { ...i, status: form.status, statusText: form.statusText },
          );
        }
        if (avatarChange) {
          await setAvatar({ client, transport: transportAvatarExpo, file: avatarLocal });
          setAvatarLocal(null);
        }

        // La nouvelle VERSION de la photo (`avatarETag`), relue à la source et
        // rangée en base : c'est elle qui fait bouger l'URI d'avatar partout
        // ailleurs (liste des salons, messages, Paramètres) — sans quoi le cache
        // image d'Android continuerait de servir l'ancienne photo. Le stream
        // `updateAvatar` le dirait aussi, mais on ne fait pas dépendre le retour
        // visuel d'une socket qui peut être tombée. Best-effort : la photo est
        // déjà enregistrée côté serveur, l'échec ici ne remet rien en cause.
        if ((avatarChange || info.username !== undefined) && store !== null) {
          const me = await readMyIdentity(client).catch(() => null);
          if (me !== null) await store.saveIdentity(me).catch(() => {});
        }

        setTwoFactorRequest(null);
        setCode('');
        setBanner({ type: 'success', text: t('monProfil.profilEnregistre') });
      } catch (e) {
        if (e instanceof TwoFactorError) {
          // Le serveur veut un second facteur — ou refuse celui qu'on vient
          // d'envoyer, auquel cas il relève la même erreur.
          if (twoFactor !== undefined) setBanner({ type: 'error', text: t('monProfil.codeRefuse') });
          setCode('');
          setTwoFactorRequest(e);
        } else {
          setBanner({
            type: 'error',
            text: e instanceof Error ? e.message : t('monProfil.enregistrementImpossible'),
          });
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [form, initial, avatarLocal, password, client, store, updateSessionProfile, t],
  );

  const submitCode = useCallback(async () => {
    if (twoFactorRequest === null || code.trim() === '') return;
    try {
      const prepare = await prepareTwoFactorCode(twoFactorRequest, code, hash);
      await save(prepare);
    } catch (e) {
      setBanner({
        type: 'error',
        text: e instanceof Error ? e.message : t('monProfil.preparationCodeImpossible'),
      });
    }
  }, [twoFactorRequest, code, save, t]);

  if (loadError !== null) {
    return (
      <KeyboardAvoidingContainer>
        <Stack.Screen options={{ title: t('monProfil.titre') }} />
        <View style={styles.center}>
          <Text style={[styles.loadError, { color: c.errorText }]}>{loadError}</Text>
        </View>
      </KeyboardAvoidingContainer>
    );
  }

  if (form === null) {
    return (
      <KeyboardAvoidingContainer>
        <Stack.Screen options={{ title: t('monProfil.titre') }} />
        <View style={styles.center}>
          <ActivityIndicator color={c.accent} />
        </View>
      </KeyboardAvoidingContainer>
    );
  }

  const needsPassword = form.email !== initial?.email || form.username !== initial?.username;
  const avatarUri =
    avatarLocal?.uri ?? urlAvatar(client, { username, etag: etags.byUsername.get(username) });

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('monProfil.titre') }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Avatar — tap pour changer. Aperçu immédiat de la photo choisie. */}
        <View style={styles.avatarBlock}>
          <Pressable
            onPress={() => void pickPhoto()}
            accessibilityRole="button"
            accessibilityLabel={t('monProfil.changerPhotoLabel')}
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
          <Pressable onPress={() => void pickPhoto()} hitSlop={8}>
            <Text style={[styles.changePhoto, { color: c.cyan }]}>{t('monProfil.changerPhoto')}</Text>
          </Pressable>
        </View>

        {/* Présence */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('monProfil.sectionPresence')}</Text>
        <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
          {PRESENCES.map((p, i) => {
            const active = form.status === p;
            const label = capitalize(t(PRESENCE_KEYS[p]));
            return (
              <View key={p} style={styles.presenceWrapper}>
                <Tappable
                  onPress={() => {
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
          label={t('monProfil.etiquetteStatut')}
          value={form.statusText}
          onChangeText={(v) => updateField('statusText', v)}
          placeholder={t('monProfil.placeholderStatut')}
          autoCapitalize="sentences"
          maxLength={120}
        />

        {/* Profil */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('monProfil.sectionProfil')}</Text>
        <PillField
          c={c}
          label={t('monProfil.etiquetteNom')}
          value={form.name}
          onChangeText={(v) => updateField('name', v)}
          placeholder={t('monProfil.placeholderNom')}
          autoCapitalize="words"
        />
        <PillField
          c={c}
          label={t('monProfil.etiquetteBio')}
          value={form.bio}
          onChangeText={(v) => updateField('bio', v)}
          placeholder={t('monProfil.placeholderBio')}
          autoCapitalize="sentences"
          maxLength={260}
          multiline
        />

        {/* Compte — sensible : e-mail et nom d'utilisateur exigent le mot de passe. */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('monProfil.sectionCompte')}</Text>
        <Text style={[styles.help, { color: c.dimmed }]}>{t('monProfil.aideCompte')}</Text>
        <PillField
          c={c}
          label={t('monProfil.etiquetteEmail')}
          value={form.email}
          onChangeText={(v) => updateField('email', v)}
          placeholder={t('monProfil.placeholderEmail')}
          keyboardType="email-address"
          autoComplete="email"
        />
        <PillField
          c={c}
          label={t('monProfil.etiquetteUsername')}
          value={form.username}
          icon="@"
          onChangeText={(v) => updateField('username', v)}
          placeholder={t('monProfil.placeholderUsername')}
        />
        {needsPassword && (
          <PillField
            c={c}
            label={t('monProfil.etiquetteMdp')}
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
            <Text style={[styles.twoFactorTitle, { color: c.text }]}>{t('monProfil.verificationRequise')}</Text>
            <Text style={[styles.help, { color: c.dimmed }]}>{t(twoFactorLabel(twoFactorRequest.method))}</Text>
            <PillField
              c={c}
              label={t('monProfil.etiquetteCode')}
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
            <PrimaryButton c={c} busy={busy} onPress={() => void submitCode()} title={t('monProfil.validerCode')} />
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
          title={t('commun.enregistrer')}
          style={styles.save}
        />
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, { color: c.dimmed }]}>{t('commun.annuler')}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingContainer>
  );
}

/** Sous-titre du bloc 2FA selon la méthode réclamée par le serveur. */
function twoFactorLabel(method: TwoFactorError['method']): TranslationKey {
  if (method === 'totp') return 'monProfil.aide2faTotp';
  if (method === 'email') return 'monProfil.aide2faEmail';
  return 'monProfil.aide2faMdp';
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
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
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
