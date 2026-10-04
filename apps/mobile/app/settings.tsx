import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { getFcmToken } from '../lib/push.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { setLanguage, useT, useLanguagePreference } from '../ui/i18n.ts';
import { useEtagsAvatars } from '../ui/identities.tsx';
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

/**
 * Écran « Paramètres » : ce qui traînait en bas de la liste des conversations
 * (compte, serveur, jeton FCM, déconnexion), plus la préférence de notification
 * push — le point vraiment neuf.
 *
 * La préférence est GLOBALE au compte (`settings.preferences.pushNotifications`
 * de Rocket.Chat), pas par salon : c'est le défaut « quand me notifier sur cet
 * appareil ». Lue via `GET me`, écrite via `POST users.setPreferences`
 * (`{ data: { pushNotifications } }`). Le serveur connaît un 4ᵉ niveau
 * `'default'` (suivre le réglage serveur) ; on n'expose que les trois que
 * réclame l'app originale — si le compte est sur `'default'`, aucune option
 * n'est cochée jusqu'au premier choix, ce qui est honnête plutôt que trompeur.
 */

type NiveauPush = 'all' | 'mention' | 'nothing';
const OPTIONS_PUSH: { value: NiveauPush; key: TranslationKey }[] = [
  { value: 'all', key: 'parametres.pushTous' },
  { value: 'mention', key: 'parametres.pushMentions' },
  { value: 'nothing', key: 'parametres.pushAucune' },
];

export default function SettingsScreen() {
  const c = useColors();
  const { state: etat } = useSession();
  // Atteint depuis l'accueil connecté ; en garde-fou, un état déconnecté
  // (déconnexion en cours) renvoie au login plutôt que de crasher sur `client`.
  if (etat.phase !== 'connecte') return <Redirect href="/login" />;
  return (
    <Parametres
      c={c}
      client={etat.client}
      username={etat.session.username}
      baseUrl={etat.session.baseUrl}
    />
  );
}

type ReponseMe = { settings?: { preferences?: { pushNotifications?: string } } };

/**
 * Lit et écrit la préférence de push. `valeur === null` = encore en train de
 * lire. L'écriture est OPTIMISTE : on bascule l'UI tout de suite et on revient
 * en arrière si le serveur refuse — un réglage doit répondre au doigt, pas au
 * réseau.
 */
function usePreferencePush(client: ClientRest) {
  const [valeur, setValeur] = useState<string | null>(null);
  // L'erreur est stockée comme CLÉ de traduction, pas comme phrase : le
  // composant la traduit au rendu, dans la langue courante.
  const [erreur, setErreur] = useState<TranslationKey | null>(null);

  useEffect(() => {
    let vivant = true;
    client
      .get<ReponseMe>('me')
      .then((r) => {
        if (vivant) setValeur(r.settings?.preferences?.pushNotifications ?? 'default');
      })
      .catch(() => {
        if (vivant) setErreur('parametres.pushIntrouvable');
      });
    return () => {
      vivant = false;
    };
  }, [client]);

  // Numéro de séquence : deux choix rapprochés lancent deux POST concurrents,
  // et sans lui le `catch` du PREMIER restaurait la valeur d'AVANT le second
  // choix — l'UI affichait un niveau que le serveur ne porte pas. Seul le
  // DERNIER choix garde le droit de rollback et de message d'erreur.
  const sequence = useRef(0);
  const definir = useCallback(
    async (nouvelle: NiveauPush) => {
      const n = ++sequence.current;
      const precedente = valeur;
      setValeur(nouvelle);
      setErreur(null);
      try {
        await client.post('users.setPreferences', {
          body: { data: { pushNotifications: nouvelle } },
        });
      } catch {
        if (sequence.current !== n) return;
        setValeur(precedente);
        setErreur('parametres.enregistrementImpossible');
      }
    },
    [client, valeur],
  );

  return { valeur, erreur, definir };
}

function Parametres({
  c,
  client,
  username,
  baseUrl,
}: {
  c: Colors;
  client: ClientRest;
  username: string;
  baseUrl: string;
}) {
  const routeur = useRouter();
  const t = useT();
  const { logOut: deconnecter } = useSession();
  const push = usePreferencePush(client);
  const [deconnexion, setDeconnexion] = useState(false);
  // Version de MA photo : sans elle, la carte de profil garderait l'ancienne
  // image même après l'avoir changée dans « Mon profil » (cache image figé).
  const etags = useEtagsAvatars();

  const seDeconnecter = useCallback(() => {
    if (deconnexion) return;
    setDeconnexion(true);
    // `deconnecter` bascule la session en « deconnecte » de façon synchrone
    // (avant son premier await) : l'accueil, révélé par le back, redirige alors
    // vers /connexion. Le logout réseau finit best-effort en arrière-plan.
    void deconnecter();
    routeur.back();
  }, [deconnexion, deconnecter, routeur]);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t('parametres.titre') }} />

      <Tappable
        onPress={() => routeur.push('/my-profile')}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        accessibilityRole="button"
        accessibilityLabel={t('parametres.modifierProfil')}
        style={({ pressed }) => [
          styles.carteProfil,
          { backgroundColor: c.deepCard, borderColor: c.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <AvatarTile
          c={c}
          key={username}
          initial={username.charAt(0)}
          uri={urlAvatar(client, { username, etag: etags.byUsername.get(username) })}
        />
        <View style={styles.profilTextes}>
          <Text style={[styles.profilNom, { color: c.text }]} numberOfLines={1}>
            @{username}
          </Text>
          <Text style={[styles.profilLien, { color: c.cyan }]}>{t('parametres.modifierProfil')}</Text>
        </View>
        <Text style={[styles.chevron, { color: c.dimmed }]}>›</Text>
      </Tappable>

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionNotifications')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.reglageTitre, { color: c.text }]}>{t('parametres.push')}</Text>
        <Text style={[styles.reglageAide, { color: c.dimmed }]}>{t('parametres.pushAide')}</Text>
        <ChoixNotification c={c} push={push} />
        {push.erreur !== null && (
          <Text style={[styles.error, { color: c.errorText }]}>{t(push.erreur)}</Text>
        )}
      </View>

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionLangue')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.reglageAide, { color: c.dimmed }]}>{t('parametres.langueAide')}</Text>
        <SelecteurLangue c={c} t={t} />
      </View>

      <SectionE2E c={c} t={t} />

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionCompte')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Paire c={c} key={t('parametres.connecte')} value={`@${username}`} />
        <Paire c={c} key={t('parametres.serveur')} value={baseUrl} />
      </View>

      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.sectionDiagnostic')}</Text>
      <SectionJetonFcm c={c} t={t} />

      <Link href="/login?change=1" style={[styles.link, { color: c.cyan }]}>
        {t('parametres.changerServeur')}
      </Link>

      <Tappable
        onPress={seDeconnecter}
        disabled={deconnexion}
        android_ripple={{ color: c.ripple }}
        unstable_pressDelay={LIST_PRESS_DELAY}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: c.errorCard, opacity: pressed || deconnexion ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.texteBoutonSecondaire, { color: c.errorText }]}>{t('parametres.seDeconnecter')}</Text>
      </Tappable>
    </ScrollView>
  );
}

/** Liste radio des trois niveaux de notification. Rien de coché tant qu'on lit. */
function ChoixNotification({
  c,
  push,
}: {
  c: Colors;
  push: ReturnType<typeof usePreferencePush>;
}) {
  const t = useT();
  if (push.valeur === null && push.erreur === null) {
    return (
      <View style={styles.charge}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <View style={styles.options}>
      {OPTIONS_PUSH.map((o, i) => {
        const actif = push.valeur === o.value;
        const libelle = t(o.key);
        return (
          <View key={o.value} style={styles.enveloppeOption}>
            <Tappable
              onPress={() => void push.definir(o.value)}
              disabled={push.valeur === null}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: actif }}
              accessibilityLabel={libelle}
              style={[
                styles.optionLigne,
                i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: actif ? c.accent : c.border }]}>
              {actif && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
            </View>
              <Text
                style={[
                  styles.optionTexte,
                  { color: actif ? c.text : c.secondaryText },
                  actif && styles.optionTexteActif,
                ]}
              >
                {libelle}
              </Text>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/**
 * Sélecteur de langue : « Automatique » (suit le téléphone) puis chaque langue
 * en endonyme. Même liste radio que les notifications. La bascule est immédiate
 * (`definirLangue` pousse dans le store abonnable) : tout l'écran, titre compris,
 * se re-rend dans la nouvelle langue sans rechargement.
 */
function SelecteurLangue({ c, t }: { c: Colors; t: TranslateFn }) {
  const preference = useLanguagePreference();
  const options: { pref: LanguagePreference; label: string; help?: string }[] = [
    { pref: 'auto', label: t('langue.auto'), help: t('langue.autoAide') },
    ...LANGUAGES.map((l) => ({ pref: l, label: LANGUAGE_NAMES[l] })),
  ];
  return (
    <View style={styles.options}>
      {options.map((o, i) => {
        const actif = preference === o.pref;
        return (
          <View key={o.pref} style={styles.enveloppeOption}>
            <Tappable
              onPress={() => setLanguage(o.pref)}
              android_ripple={{ color: c.ripple }}
              unstable_pressDelay={LIST_PRESS_DELAY}
              accessibilityRole="radio"
              accessibilityState={{ selected: actif }}
              accessibilityLabel={o.label}
              style={[
                styles.optionLigne,
                i > 0 && { borderTopColor: c.softBorder, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: actif ? c.accent : c.border }]}>
              {actif && <View style={[styles.radioDot, { backgroundColor: c.accent }]} />}
            </View>
              <View style={styles.optionTextes}>
                <Text
                  style={[
                    styles.optionTexte,
                    { color: actif ? c.text : c.secondaryText },
                    actif && styles.optionTexteActif,
                  ]}
                >
                  {o.label}
                </Text>
                {o.help !== undefined && (
                  <Text style={[styles.optionAide, { color: c.tertiaryText }]}>{o.help}</Text>
                )}
              </View>
            </Tappable>
          </View>
        );
      })}
    </View>
  );
}

/** Diagnostic push : prouve l'obtention du jeton FCM natif. Déplacé de l'accueil. */
function SectionJetonFcm({ c, t }: { c: Colors; t: TranslateFn }) {
  const [jeton, setJeton] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const demander = useCallback(async () => {
    setErreur(null);
    const r = await getFcmToken();
    if (r.ok) {
      setJeton(r.token);
      console.log('JETON_FCM', r.token);
    } else {
      setErreur(`${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
      console.log('JETON_FCM_ECHEC', r.reason, r.detail ?? '');
    }
  }, []);

  return (
    <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
      <Tappable
        onPress={demander}
        // Lien texte : vague ronde `borderless` — le masque du ripple borné
        // ignore borderRadius sous Fabric, un rayon calibré fait le travail.
        android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
        unstable_pressDelay={LIST_PRESS_DELAY}
      >
        <Text style={[styles.action, { color: c.cyan }]}>{t('parametres.obtenirJeton')}</Text>
      </Tappable>
      {jeton !== null && (
        <Text style={[styles.help, { color: c.text }]} selectable numberOfLines={3}>
          {jeton}
        </Text>
      )}
      {erreur !== null && <Text style={[styles.help, { color: c.errorText }]}>{erreur}</Text>}
    </View>
  );
}

/**
 * Section chiffrement : état verrouillé/déverrouillé de l'appareil. Verrouillé,
 * un lien ouvre la feuille de déverrouillage ; déverrouillé, un bouton oublie
 * la clé (re-masque le clair local).
 */
function SectionE2E({ c, t }: { c: Colors; t: TranslateFn }) {
  const routeur = useRouter();
  const synchro = useSync();
  const e2e = synchro.phase === 'pret' ? synchro.e2e : null;
  const deverrouille = useE2EUnlocked(e2e);
  const [occupe, setOccupe] = useState(false);

  const verrouiller = (): void => {
    if (synchro.phase !== 'pret' || occupe) return;
    setOccupe(true);
    void synchro.lockE2E().finally(() => setOccupe(false));
  };

  return (
    <>
      <Text style={[styles.sectionTitle, { color: c.dimmed }]}>{t('parametres.e2eTitre')}</Text>
      <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
        <Text style={[styles.reglageAide, { color: c.dimmed }]}>
          {t(deverrouille ? 'parametres.e2eDeverrouille' : 'parametres.e2eVerrouille')}
        </Text>
        {deverrouille ? (
          <Tappable
            onPress={verrouiller}
            disabled={occupe}
            android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed || occupe ? 0.6 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profilLien, { color: c.errorText }]}>
              {t('parametres.e2eVerrouiller')}
            </Text>
          </Tappable>
        ) : (
          <Tappable
            onPress={() => routeur.push('/unlock-e2e')}
            android_ripple={{ color: c.ripple, borderless: true, radius: 24 }}
            unstable_pressDelay={LIST_PRESS_DELAY}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profilLien, { color: c.cyan }]}>
              {t('parametres.e2eDeverrouiller')}
            </Text>
          </Tappable>
        )}
      </View>
    </>
  );
}

function Paire({ c, key: cle, value: valeur }: { c: Colors; key: string; value: string }) {
  return (
    <View style={styles.paire}>
      <Text style={[styles.key, { color: c.dimmed }]}>{cle}</Text>
      <Text style={[styles.value, { color: c.text }]} selectable>
        {valeur}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 40 },
  carteProfil: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  profilTextes: { flex: 1, gap: 2 },
  profilNom: { fontFamily: FONTS.title, fontSize: 17 },
  profilLien: { fontFamily: FONTS.corpsGras, fontSize: 13 },
  chevron: { fontFamily: FONTS.title, fontSize: 24 },
  sectionTitle: {
    fontFamily: FONTS.corpsFort,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginLeft: 4,
  },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  reglageTitre: { fontFamily: FONTS.title, fontSize: 16 },
  reglageAide: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  options: { marginTop: 2 },
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  enveloppeOption: { borderRadius: 12, overflow: 'hidden' },
  optionLigne: {
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
  optionTextes: { flex: 1, gap: 1 },
  optionTexte: { fontFamily: FONTS.corpsGras, fontSize: 15, flexShrink: 1 },
  optionTexteActif: { fontFamily: FONTS.corpsFort },
  optionAide: { fontFamily: FONTS.body, fontSize: 12 },
  charge: { paddingVertical: 18, alignItems: 'center' },
  error: { fontFamily: FONTS.corpsGras, fontSize: 13 },
  paire: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  key: { fontFamily: FONTS.body, fontSize: 13 },
  value: { fontFamily: FONTS.corpsGras, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  action: { fontFamily: FONTS.corpsGras, fontSize: 13 },
  help: { fontFamily: FONTS.body, fontSize: 12, opacity: 0.9 },
  link: { fontFamily: FONTS.corpsGras, fontSize: 15, paddingVertical: 12, textAlign: 'center' },
  button: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBoutonSecondaire: { fontFamily: FONTS.corpsGras, fontSize: 16 },
});
