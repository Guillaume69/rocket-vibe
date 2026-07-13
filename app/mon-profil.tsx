/**
 * « Mon profil » — édition de MES propres informations, comme le compte de
 * l'app officielle. Une vraie page (pas une formSheet : il y a un clavier), sur
 * le modèle de `Paramètres`.
 *
 * Trois leviers serveur, réunis derrière un seul bouton « Enregistrer » qui
 * n'appelle QUE les endpoints des champs réellement modifiés (`lib/monProfil`,
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

import { preparerCodeDeuxFacteurs } from '../lib/auth.ts';
import {
  diffInfos,
  enregistrerInfos,
  enregistrerStatut,
  exigeMotDePasse,
  type InfosDeBase,
  lireMonProfil,
  type MonProfil,
  type StatutDefaut,
} from '../lib/monProfil.ts';
import { ClientRest, ErreurDeuxFacteurs, type CodeDeuxFacteurs } from '../lib/rest.ts';
import { hacher } from '../lib/sessionStore.ts';
import { definirAvatar, type FichierAEnvoyer, urlAvatar } from '../lib/upload.ts';
import { choisirAvatar } from '../ui/choisirAvatar.ts';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { traduireCourant, useT } from '../ui/i18n.ts';
import { BoutonPrincipal, ChampPilule, TuileAvatar } from '../ui/kit.tsx';
import type { CleTraduction } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';
import { transportAvatarExpo } from '../ui/transportUpload.ts';

/** Les quatre statuts choisissables, avec leur pastille (tokens du thème). */
type TeintePresence = 'enLigne' | 'absent' | 'danger' | 'horsLigne';
const PRESENCES: { valeur: StatutDefaut; cle: CleTraduction; teinte: TeintePresence }[] = [
  { valeur: 'online', cle: 'monProfil.presenceEnLigne', teinte: 'enLigne' },
  { valeur: 'away', cle: 'monProfil.presenceAbsent', teinte: 'absent' },
  { valeur: 'busy', cle: 'monProfil.presenceOccupe', teinte: 'danger' },
  { valeur: 'offline', cle: 'monProfil.presenceHorsLigne', teinte: 'horsLigne' },
];

type Bandeau = { type: 'succes' | 'erreur' | 'info'; texte: string };

export default function EcranMonProfil() {
  const { etat } = useSession();
  const c = useCouleurs();
  // Atteint depuis Paramètres ; un état déconnecté (déconnexion en cours)
  // renvoie au login plutôt que de crasher sur `client`.
  if (etat.phase !== 'connecte') return <Redirect href="/connexion" />;
  return <FormMonProfil c={c} client={etat.client} username={etat.session.username} />;
}

function FormMonProfil({
  c,
  client,
  username,
}: {
  c: Couleurs;
  client: ClientRest;
  username: string;
}) {
  const t = useT();
  const routeur = useRouter();
  const { majProfilSession } = useSession();
  // `initial` = référence lue au chargement ; `form` = valeurs en cours d'édition.
  // Le diff des deux décide quels endpoints appeler. Après un enregistrement
  // réussi, `form` DEVIENT la nouvelle référence (le diff repart à zéro).
  const [initial, setInitial] = useState<MonProfil | null>(null);
  const [form, setForm] = useState<MonProfil | null>(null);
  const [chargeErreur, setChargeErreur] = useState<string | null>(null);

  const [avatarLocal, setAvatarLocal] = useState<FichierAEnvoyer | null>(null);
  const [motDePasse, setMotDePasse] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [bandeau, setBandeau] = useState<Bandeau | null>(null);

  // Second facteur demandé par `users.updateOwnBasicInfo` (e-mail/pseudo).
  const [demande2FA, setDemande2FA] = useState<ErreurDeuxFacteurs | null>(null);
  const [code, setCode] = useState('');

  // Garde de réentrance en ref (pas dans `occupe`) : deux events d'une même
  // frame liraient tous deux l'ancienne valeur — même raison qu'au login.
  const enVol = useRef(false);

  useEffect(() => {
    let vivant = true;
    lireMonProfil(client)
      .then((p) => {
        if (!vivant) return;
        setInitial(p);
        setForm(p);
      })
      .catch((e: unknown) => {
        if (vivant) setChargeErreur(e instanceof Error ? e.message : traduireCourant('monProfil.profilIllisible'));
      });
    return () => {
      vivant = false;
    };
  }, [client]);

  const majChamp = useCallback((champ: keyof MonProfil, valeur: string) => {
    setBandeau(null);
    setForm((f) => (f === null ? f : { ...f, [champ]: valeur }));
  }, []);

  const choisirPhoto = useCallback(async () => {
    try {
      const f = await choisirAvatar();
      if (f !== null) {
        setAvatarLocal(f);
        setBandeau(null);
      }
    } catch (e) {
      setBandeau({ type: 'erreur', texte: e instanceof Error ? e.message : t('monProfil.selectionImpossible') });
    }
  }, [t]);

  const enregistrer = useCallback(
    async (deuxFacteurs?: CodeDeuxFacteurs) => {
      if (form === null || initial === null || enVol.current) return;

      const infos = diffInfos(initial, form);
      const statutChange = form.status !== initial.status || form.statusText !== initial.statusText;
      const avatarChange = avatarLocal !== null;
      if (Object.keys(infos).length === 0 && !statutChange && !avatarChange) {
        setBandeau({ type: 'info', texte: t('monProfil.rienAEnregistrer') });
        return;
      }
      if (exigeMotDePasse(infos) && motDePasse.trim() === '') {
        setBandeau({
          type: 'erreur',
          texte: t('monProfil.mdpRequis'),
        });
        return;
      }

      enVol.current = true;
      setOccupe(true);
      setBandeau(null);
      try {
        // Les infos de base EN PREMIER : seul appel susceptible d'exiger la 2FA.
        // S'il la réclame, il lève AVANT tout effet de bord (statut, avatar) —
        // on prompte, puis on rejoue toute la fonction avec le code.
        if (Object.keys(infos).length > 0) {
          const data: InfosDeBase = { ...infos };
          if (exigeMotDePasse(infos)) data.currentPassword = await hacher(motDePasse);
          await enregistrerInfos(client, data, deuxFacteurs);
        }
        if (statutChange) {
          await enregistrerStatut(client, { status: form.status, message: form.statusText });
        }
        if (avatarChange) {
          await definirAvatar({ client, transport: transportAvatarExpo, fichier: avatarLocal });
        }

        // Le pseudo est porté par la session (Paramètres, avatar de cet écran) :
        // le rafraîchir tout de suite, sinon il resterait à l'ancienne valeur
        // jusqu'à une reconnexion.
        if (infos.username !== undefined) await majProfilSession({ username: infos.username });

        setInitial(form);
        setAvatarLocal(null);
        setDemande2FA(null);
        setCode('');
        setMotDePasse('');
        setBandeau({ type: 'succes', texte: t('monProfil.profilEnregistre') });
      } catch (e) {
        if (e instanceof ErreurDeuxFacteurs) {
          // Le serveur veut un second facteur — ou refuse celui qu'on vient
          // d'envoyer, auquel cas il relève la même erreur.
          if (deuxFacteurs !== undefined) setBandeau({ type: 'erreur', texte: t('monProfil.codeRefuse') });
          setCode('');
          setDemande2FA(e);
        } else {
          setBandeau({
            type: 'erreur',
            texte: e instanceof Error ? e.message : t('monProfil.enregistrementImpossible'),
          });
        }
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [form, initial, avatarLocal, motDePasse, client, majProfilSession, t],
  );

  const validerCode = useCallback(async () => {
    if (demande2FA === null || code.trim() === '') return;
    try {
      const prepare = await preparerCodeDeuxFacteurs(demande2FA, code, hacher);
      await enregistrer(prepare);
    } catch (e) {
      setBandeau({
        type: 'erreur',
        texte: e instanceof Error ? e.message : t('monProfil.preparationCodeImpossible'),
      });
    }
  }, [demande2FA, code, enregistrer, t]);

  if (chargeErreur !== null) {
    return (
      <VueEvitantLeClavier>
        <Stack.Screen options={{ title: t('monProfil.titre') }} />
        <View style={styles.centre}>
          <Text style={[styles.erreurCharge, { color: c.texteErreur }]}>{chargeErreur}</Text>
        </View>
      </VueEvitantLeClavier>
    );
  }

  if (form === null) {
    return (
      <VueEvitantLeClavier>
        <Stack.Screen options={{ title: t('monProfil.titre') }} />
        <View style={styles.centre}>
          <ActivityIndicator color={c.accent} />
        </View>
      </VueEvitantLeClavier>
    );
  }

  const besoinMdp = form.email !== initial?.email || form.username !== initial?.username;
  const avatarUri = avatarLocal?.uri ?? urlAvatar(client, { username });

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('monProfil.titre') }} />
      <ScrollView contentContainerStyle={styles.contenu} keyboardShouldPersistTaps="handled">
        {/* Avatar — tap pour changer. Aperçu immédiat de la photo choisie. */}
        <View style={styles.avatarBloc}>
          <Pressable
            onPress={() => void choisirPhoto()}
            accessibilityRole="button"
            accessibilityLabel={t('monProfil.changerPhotoLabel')}
            style={({ pressed }) => pressed && styles.presse}
          >
            <TuileAvatar
              c={c}
              cle={username}
              initiale={(form.name || username).charAt(0)}
              taille={96}
              rayon={30}
              uri={avatarUri}
            />
            <View style={[styles.crayon, { backgroundColor: c.accent, borderColor: c.fond }]}>
              <Text style={styles.crayonGlyphe}>✎</Text>
            </View>
          </Pressable>
          <Pressable onPress={() => void choisirPhoto()} hitSlop={8}>
            <Text style={[styles.changerPhoto, { color: c.cyan }]}>{t('monProfil.changerPhoto')}</Text>
          </Pressable>
        </View>

        {/* Présence */}
        <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('monProfil.sectionPresence')}</Text>
        <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
          {PRESENCES.map((p, i) => {
            const actif = form.status === p.valeur;
            return (
              <Pressable
                key={p.valeur}
                onPress={() => {
                  setBandeau(null);
                  setForm((f) => (f === null ? f : { ...f, status: p.valeur }));
                }}
                android_ripple={{ color: c.ondulation }}
                unstable_pressDelay={DELAI_PRESSION_LISTE}
                accessibilityRole="radio"
                accessibilityState={{ selected: actif }}
                accessibilityLabel={t(p.cle)}
                style={[
                  styles.presenceLigne,
                  i > 0 && { borderTopColor: c.bordureDouce, borderTopWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <View style={[styles.pastille, { backgroundColor: c[p.teinte] }]} />
                <Text
                  style={[
                    styles.presenceTexte,
                    { color: actif ? c.texte : c.texteSecondaire },
                    actif && styles.presenceTexteActif,
                  ]}
                >
                  {t(p.cle)}
                </Text>
                <View style={[styles.radio, { borderColor: actif ? c.accent : c.bordure }]}>
                  {actif && <View style={[styles.radioPoint, { backgroundColor: c.accent }]} />}
                </View>
              </Pressable>
            );
          })}
        </View>

        <ChampPilule
          c={c}
          etiquette={t('monProfil.etiquetteStatut')}
          valeur={form.statusText}
          onChangeText={(v) => majChamp('statusText', v)}
          placeholder={t('monProfil.placeholderStatut')}
          autoCapitalize="sentences"
          maxLength={120}
        />

        {/* Profil */}
        <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('monProfil.sectionProfil')}</Text>
        <ChampPilule
          c={c}
          etiquette={t('monProfil.etiquetteNom')}
          valeur={form.name}
          onChangeText={(v) => majChamp('name', v)}
          placeholder={t('monProfil.placeholderNom')}
          autoCapitalize="words"
        />
        <ChampPilule
          c={c}
          etiquette={t('monProfil.etiquetteBio')}
          valeur={form.bio}
          onChangeText={(v) => majChamp('bio', v)}
          placeholder={t('monProfil.placeholderBio')}
          autoCapitalize="sentences"
          maxLength={260}
          multiligne
        />

        {/* Compte — sensible : e-mail et nom d'utilisateur exigent le mot de passe. */}
        <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('monProfil.sectionCompte')}</Text>
        <Text style={[styles.aide, { color: c.attenue }]}>{t('monProfil.aideCompte')}</Text>
        <ChampPilule
          c={c}
          etiquette={t('monProfil.etiquetteEmail')}
          valeur={form.email}
          onChangeText={(v) => majChamp('email', v)}
          placeholder={t('monProfil.placeholderEmail')}
          keyboardType="email-address"
          autoComplete="email"
        />
        <ChampPilule
          c={c}
          etiquette={t('monProfil.etiquetteUsername')}
          valeur={form.username}
          icone="@"
          onChangeText={(v) => majChamp('username', v)}
          placeholder={t('monProfil.placeholderUsername')}
        />
        {besoinMdp && (
          <ChampPilule
            c={c}
            etiquette={t('monProfil.etiquetteMdp')}
            valeur={motDePasse}
            icone="🔒"
            onChangeText={setMotDePasse}
            placeholder="••••••••"
            autoComplete="current-password"
            secureTextEntry
          />
        )}

        {demande2FA !== null && (
          <View style={[styles.carte2FA, { backgroundColor: c.carte, borderColor: c.violet }]}>
            <Text style={[styles.titre2FA, { color: c.texte }]}>{t('monProfil.verificationRequise')}</Text>
            <Text style={[styles.aide, { color: c.attenue }]}>{t(etiquette2FA(demande2FA.methode))}</Text>
            <ChampPilule
              c={c}
              etiquette={t('monProfil.etiquetteCode')}
              valeur={code}
              grand={demande2FA.methode !== 'password'}
              onChangeText={setCode}
              onSubmitEditing={() => void validerCode()}
              placeholder={demande2FA.methode === 'password' ? '••••••••' : '123456'}
              keyboardType={demande2FA.methode === 'password' ? 'default' : 'number-pad'}
              autoComplete={demande2FA.methode === 'password' ? 'current-password' : 'one-time-code'}
              secureTextEntry={demande2FA.methode === 'password'}
              autoFocus
            />
            <BoutonPrincipal c={c} occupe={occupe} onPress={() => void validerCode()} titre={t('monProfil.validerCode')} />
          </View>
        )}

        {bandeau !== null && (
          <View
            style={[
              styles.bandeau,
              {
                backgroundColor: bandeau.type === 'erreur' ? c.carteErreur : c.carte,
                borderColor:
                  bandeau.type === 'erreur'
                    ? c.danger
                    : bandeau.type === 'succes'
                      ? c.enLigne
                      : c.bordure,
              },
            ]}
          >
            <Text
              style={[
                styles.bandeauTexte,
                {
                  color:
                    bandeau.type === 'erreur'
                      ? c.texteErreur
                      : bandeau.type === 'succes'
                        ? c.enLigne
                        : c.texteSecondaire,
                },
              ]}
            >
              {bandeau.texte}
            </Text>
          </View>
        )}

        <BoutonPrincipal
          c={c}
          occupe={occupe}
          onPress={() => void enregistrer()}
          titre={t('commun.enregistrer')}
          style={styles.enregistrer}
        />
        <Pressable onPress={() => routeur.back()} hitSlop={8}>
          <Text style={[styles.annuler, { color: c.attenue }]}>{t('commun.annuler')}</Text>
        </Pressable>
      </ScrollView>
    </VueEvitantLeClavier>
  );
}

/** Sous-titre du bloc 2FA selon la méthode réclamée par le serveur. */
function etiquette2FA(methode: ErreurDeuxFacteurs['methode']): CleTraduction {
  if (methode === 'totp') return 'monProfil.aide2faTotp';
  if (methode === 'email') return 'monProfil.aide2faEmail';
  return 'monProfil.aide2faMdp';
}

const styles = StyleSheet.create({
  contenu: { padding: 20, gap: 12, paddingBottom: 40 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  erreurCharge: { fontFamily: POLICES.corpsGras, fontSize: 14, textAlign: 'center' },
  avatarBloc: { alignItems: 'center', gap: 10, paddingVertical: 8 },
  presse: { opacity: 0.7 },
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
  changerPhoto: { fontFamily: POLICES.corpsGras, fontSize: 14 },
  sectionTitre: {
    fontFamily: POLICES.corpsFort,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginLeft: 4,
  },
  carte: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 16 },
  presenceLigne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  pastille: { width: 11, height: 11, borderRadius: 6 },
  presenceTexte: { fontFamily: POLICES.corpsGras, fontSize: 15, flex: 1 },
  presenceTexteActif: { fontFamily: POLICES.corpsFort },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioPoint: { width: 10, height: 10, borderRadius: 5 },
  aide: { fontFamily: POLICES.corps, fontSize: 13, lineHeight: 18, marginLeft: 4 },
  carte2FA: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10, marginTop: 4 },
  titre2FA: { fontFamily: POLICES.titre, fontSize: 17 },
  bandeau: { borderRadius: 14, borderWidth: 1, padding: 14 },
  bandeauTexte: { fontFamily: POLICES.corpsGras, fontSize: 14 },
  enregistrer: { marginTop: 8 },
  annuler: { fontFamily: POLICES.corpsGras, fontSize: 14, textAlign: 'center', paddingVertical: 12 },
});
