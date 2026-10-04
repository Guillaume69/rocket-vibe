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
const capitaliser = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

type Bandeau = { type: 'success' | 'error' | 'info'; text: string };

export default function MyProfileScreen() {
  const { state: etat } = useSession();
  const c = useColors();
  // Atteint depuis Paramètres ; un état déconnecté (déconnexion en cours)
  // renvoie au login plutôt que de crasher sur `client`.
  if (etat.phase !== 'connected') return <Redirect href="/login" />;
  return <FormMonProfil c={c} client={etat.client} username={etat.session.username} />;
}

function FormMonProfil({
  c,
  client,
  username,
}: {
  c: Colors;
  client: ClientRest;
  username: string;
}) {
  const t = useT();
  const routeur = useRouter();
  const { updateSessionProfile: majProfilSession } = useSession();
  const synchro = useSync();
  // Le dépôt local, pour y ranger la version de ma photo après l'avoir changée.
  // `null` tant que la base n'est pas prête — l'enregistrement marche quand même,
  // le rattrapage du prochain raccordement (`me`) posera l'etag.
  const depot = synchro.phase === 'ready' ? synchro.engine.syncStore : null;
  const etags = useEtagsAvatars();
  // `initial` = référence lue au chargement ; `form` = valeurs en cours d'édition.
  // Le diff des deux décide quels endpoints appeler. Après un enregistrement
  // réussi, `form` DEVIENT la nouvelle référence (le diff repart à zéro).
  const [initial, setInitial] = useState<MyProfile | null>(null);
  const [form, setForm] = useState<MyProfile | null>(null);
  const [chargeErreur, setChargeErreur] = useState<string | null>(null);

  const [avatarLocal, setAvatarLocal] = useState<FileToSend | null>(null);
  const [motDePasse, setMotDePasse] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [bandeau, setBandeau] = useState<Bandeau | null>(null);

  // Second facteur demandé par `users.updateOwnBasicInfo` (e-mail/pseudo).
  const [demande2FA, setDemande2FA] = useState<TwoFactorError | null>(null);
  const [code, setCode] = useState('');

  // Garde de réentrance en ref (pas dans `occupe`) : deux events d'une même
  // frame liraient tous deux l'ancienne valeur — même raison qu'au login.
  const enVol = useRef(false);

  useEffect(() => {
    let vivant = true;
    readMyProfile(client)
      .then((p) => {
        if (!vivant) return;
        setInitial(p);
        setForm(p);
      })
      .catch((e: unknown) => {
        if (vivant) setChargeErreur(e instanceof Error ? e.message : translateCurrent('monProfil.profilIllisible'));
      });
    return () => {
      vivant = false;
    };
  }, [client]);

  const majChamp = useCallback((champ: keyof MyProfile, valeur: string) => {
    setBandeau(null);
    setForm((f) => (f === null ? f : { ...f, [champ]: valeur }));
  }, []);

  const choisirPhoto = useCallback(async () => {
    try {
      const f = await pickAvatar();
      if (f !== null) {
        setAvatarLocal(f);
        setBandeau(null);
      }
    } catch (e) {
      setBandeau({ type: 'error', text: e instanceof Error ? e.message : t('monProfil.selectionImpossible') });
    }
  }, [t]);

  const enregistrer = useCallback(
    async (deuxFacteurs?: TwoFactorCode) => {
      if (form === null || initial === null || enVol.current) return;

      const infos = diffInfos(initial, form);
      const statutChange = form.status !== initial.status || form.statusText !== initial.statusText;
      const avatarChange = avatarLocal !== null;
      if (Object.keys(infos).length === 0 && !statutChange && !avatarChange) {
        setBandeau({ type: 'info', text: t('monProfil.rienAEnregistrer') });
        return;
      }
      if (requiresPassword(infos) && motDePasse.trim() === '') {
        setBandeau({
          type: 'error',
          text: t('monProfil.mdpRequis'),
        });
        return;
      }

      enVol.current = true;
      setOccupe(true);
      setBandeau(null);
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
        if (Object.keys(infos).length > 0) {
          const data: BasicInfo = { ...infos };
          if (requiresPassword(infos)) data.currentPassword = await hash(motDePasse);
          await saveBasicInfo(client, data, deuxFacteurs);
          setInitial((i) => (i === null ? i : { ...i, ...infos }));
          setMotDePasse('');
          // Le pseudo est porté par la session (Paramètres, avatar de cet
          // écran) : le rafraîchir tout de suite, sinon il resterait à
          // l'ancienne valeur jusqu'à une reconnexion.
          if (infos.username !== undefined) await majProfilSession({ username: infos.username });
        }
        if (statutChange) {
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
        if ((avatarChange || infos.username !== undefined) && depot !== null) {
          const moi = await readMyIdentity(client).catch(() => null);
          if (moi !== null) await depot.saveIdentity(moi).catch(() => {});
        }

        setDemande2FA(null);
        setCode('');
        setBandeau({ type: 'success', text: t('monProfil.profilEnregistre') });
      } catch (e) {
        if (e instanceof TwoFactorError) {
          // Le serveur veut un second facteur — ou refuse celui qu'on vient
          // d'envoyer, auquel cas il relève la même erreur.
          if (deuxFacteurs !== undefined) setBandeau({ type: 'error', text: t('monProfil.codeRefuse') });
          setCode('');
          setDemande2FA(e);
        } else {
          setBandeau({
            type: 'error',
            text: e instanceof Error ? e.message : t('monProfil.enregistrementImpossible'),
          });
        }
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [form, initial, avatarLocal, motDePasse, client, depot, majProfilSession, t],
  );

  const validerCode = useCallback(async () => {
    if (demande2FA === null || code.trim() === '') return;
    try {
      const prepare = await prepareTwoFactorCode(demande2FA, code, hash);
      await enregistrer(prepare);
    } catch (e) {
      setBandeau({
        type: 'error',
        text: e instanceof Error ? e.message : t('monProfil.preparationCodeImpossible'),
      });
    }
  }, [demande2FA, code, enregistrer, t]);

  if (chargeErreur !== null) {
    return (
      <KeyboardAvoidingContainer>
        <Stack.Screen options={{ title: t('monProfil.titre') }} />
        <View style={styles.center}>
          <Text style={[styles.erreurCharge, { color: c.errorText }]}>{chargeErreur}</Text>
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

  const besoinMdp = form.email !== initial?.email || form.username !== initial?.username;
  const avatarUri =
    avatarLocal?.uri ?? urlAvatar(client, { username, etag: etags.byUsername.get(username) });

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ title: t('monProfil.titre') }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Avatar — tap pour changer. Aperçu immédiat de la photo choisie. */}
        <View style={styles.avatarBloc}>
          <Pressable
            onPress={() => void choisirPhoto()}
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
            <View style={[styles.crayon, { backgroundColor: c.accent, borderColor: c.background }]}>
              <Text style={styles.crayonGlyphe}>✎</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => void choisirPhoto()} hitSlop={8}>
            <Text style={[styles.changerPhoto, { color: c.cyan }]}>{t('monProfil.changerPhoto')}</Text>
          </Pressable>
        </View>

        {/* Présence */}
        <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('monProfil.sectionPresence')}</Text>
        <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
          {PRESENCES.map((p, i) => {
            const actif = form.status === p;
            const libelle = capitaliser(t(PRESENCE_KEYS[p]));
            return (
              <View key={p} style={styles.enveloppePresence}>
                <Tappable
                  onPress={() => {
                    setBandeau(null);
                    setForm((f) => (f === null ? f : { ...f, status: p }));
                  }}
                  android_ripple={{ color: c.ripple }}
                  unstable_pressDelay={LIST_PRESS_DELAY}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: actif }}
                  accessibilityLabel={libelle}
                  style={[
                    styles.presenceLigne,
                    i > 0 && {
                      borderTopColor: c.softBorder,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <View style={[styles.badge, { backgroundColor: presenceColors(c)[p] }]} />
                  <Text
                    style={[
                      styles.presenceTexte,
                      { color: actif ? c.text : c.secondaryText },
                      actif && styles.presenceTexteActif,
                    ]}
                  >
                    {libelle}
                  </Text>
                  <View style={[styles.radio, { borderColor: actif ? c.accent : c.border }]}>
                    {actif && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
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
          onChangeText={(v) => majChamp('statusText', v)}
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
          onChangeText={(v) => majChamp('name', v)}
          placeholder={t('monProfil.placeholderNom')}
          autoCapitalize="words"
        />
        <PillField
          c={c}
          label={t('monProfil.etiquetteBio')}
          value={form.bio}
          onChangeText={(v) => majChamp('bio', v)}
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
          onChangeText={(v) => majChamp('email', v)}
          placeholder={t('monProfil.placeholderEmail')}
          keyboardType="email-address"
          autoComplete="email"
        />
        <PillField
          c={c}
          label={t('monProfil.etiquetteUsername')}
          value={form.username}
          icon="@"
          onChangeText={(v) => majChamp('username', v)}
          placeholder={t('monProfil.placeholderUsername')}
        />
        {besoinMdp && (
          <PillField
            c={c}
            label={t('monProfil.etiquetteMdp')}
            value={motDePasse}
            icon="🔒"
            onChangeText={setMotDePasse}
            placeholder="••••••••"
            autoComplete="current-password"
            secureTextEntry
          />
        )}

        {demande2FA !== null && (
          <View style={[styles.carte2FA, { backgroundColor: c.card, borderColor: c.purple }]}>
            <Text style={[styles.titre2FA, { color: c.text }]}>{t('monProfil.verificationRequise')}</Text>
            <Text style={[styles.help, { color: c.dimmed }]}>{t(etiquette2FA(demande2FA.method))}</Text>
            <PillField
              c={c}
              label={t('monProfil.etiquetteCode')}
              value={code}
              large={demande2FA.method !== 'password'}
              onChangeText={setCode}
              onSubmitEditing={() => void validerCode()}
              placeholder={demande2FA.method === 'password' ? '••••••••' : '123456'}
              keyboardType={demande2FA.method === 'password' ? 'default' : 'number-pad'}
              autoComplete={demande2FA.method === 'password' ? 'current-password' : 'one-time-code'}
              secureTextEntry={demande2FA.method === 'password'}
              autoFocus
            />
            <PrimaryButton c={c} busy={occupe} onPress={() => void validerCode()} title={t('monProfil.validerCode')} />
          </View>
        )}

        {bandeau !== null && (
          <View
            style={[
              styles.banner,
              {
                backgroundColor: bandeau.type === 'error' ? c.errorCard : c.card,
                borderColor:
                  bandeau.type === 'error'
                    ? c.danger
                    : bandeau.type === 'success'
                      ? c.online
                      : c.border,
              },
            ]}
          >
            <Text
              style={[
                styles.bandeauTexte,
                {
                  color:
                    bandeau.type === 'error'
                      ? c.errorText
                      : bandeau.type === 'success'
                        ? c.online
                        : c.secondaryText,
                },
              ]}
            >
              {bandeau.text}
            </Text>
          </View>
        )}

        <PrimaryButton
          c={c}
          busy={occupe}
          onPress={() => void enregistrer()}
          title={t('commun.enregistrer')}
          style={styles.save}
        />
        <Pressable onPress={() => routeur.back()} hitSlop={8}>
          <Text style={[styles.cancel, { color: c.dimmed }]}>{t('commun.annuler')}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingContainer>
  );
}

/** Sous-titre du bloc 2FA selon la méthode réclamée par le serveur. */
function etiquette2FA(methode: TwoFactorError['method']): TranslationKey {
  if (methode === 'totp') return 'monProfil.aide2faTotp';
  if (methode === 'email') return 'monProfil.aide2faEmail';
  return 'monProfil.aide2faMdp';
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  erreurCharge: { fontFamily: FONTS.corpsGras, fontSize: 14, textAlign: 'center' },
  avatarBloc: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  pressed: { opacity: 0.7 },
  crayon: {
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
  crayonGlyphe: { fontSize: 14, color: '#FFFFFF' },
  changerPhoto: { fontFamily: FONTS.corpsGras, fontSize: 14 },
  sectionTitle: {
    fontFamily: FONTS.corpsFort,
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
  enveloppePresence: { borderRadius: 12, overflow: 'hidden' },
  presenceLigne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  badge: { width: 11, height: 11, borderRadius: 6 },
  presenceTexte: { fontFamily: FONTS.corpsGras, fontSize: 15, flex: 1 },
  presenceTexteActif: { fontFamily: FONTS.corpsFort },
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
  carte2FA: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10, marginTop: 4 },
  titre2FA: { fontFamily: FONTS.title, fontSize: 17 },
  banner: { borderRadius: 14, borderWidth: 1, padding: 14 },
  bandeauTexte: { fontFamily: FONTS.corpsGras, fontSize: 14 },
  save: { marginTop: 8 },
  cancel: { fontFamily: FONTS.corpsGras, fontSize: 14, textAlign: 'center', paddingVertical: 12 },
});
