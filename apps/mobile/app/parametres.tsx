import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { obtenirJetonFcm } from '../lib/push.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { definirLangue, useT, usePreferenceLangue } from '../ui/i18n.ts';
import { useEtagsAvatars } from '../ui/identites.tsx';
import { TuileAvatar } from '../ui/kit.tsx';
import {
  type CleTraduction,
  LANGUES,
  NOMS_LANGUE,
  type PreferenceLangue,
  type Traducteur,
} from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { useE2EDeverrouille } from '../ui/e2e.ts';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';
import { Appuyable } from '../ui/appuyable.tsx';
import {SectionAppareils} from '../ui/appareils.tsx';
import {SectionSecuriteNative} from '../ui/securiteNative.tsx';
import {SectionIdentiteChiffree} from '../ui/identiteChiffree.tsx';
import {usePreferencesNatives} from '../ui/preferencesNatives.ts';

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
const OPTIONS_PUSH: { valeur: NiveauPush; cle: CleTraduction }[] = [
  { valeur: 'all', cle: 'parametres.pushTous' },
  { valeur: 'mention', cle: 'parametres.pushMentions' },
  { valeur: 'nothing', cle: 'parametres.pushAucune' },
];

export default function EcranParametres() {
  const c = useCouleurs();
  const { etat } = useSession();
  // Atteint depuis l'accueil connecté ; en garde-fou, un état déconnecté
  // (déconnexion en cours) renvoie au login plutôt que de crasher sur `client`.
  if (etat.phase !== 'connecte') return <Redirect href="/connexion" />;
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
function usePreferencePush(client: ClientRest,natives:ReturnType<typeof usePreferencesNatives>) {
  const [valeur, setValeur] = useState<string | null>(null);
  // L'erreur est stockée comme CLÉ de traduction, pas comme phrase : le
  // composant la traduit au rendu, dans la langue courante.
  const [erreur, setErreur] = useState<CleTraduction | null>(null);

  useEffect(() => {
    if (client.genre === 'rocketvibe') return;
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
        if(client.genre==='rocketvibe'){
          await natives.changer({push_enabled:nouvelle!=='nothing',push_mentions_only:nouvelle==='mention'});
          return;
        }
        await client.post('users.setPreferences', {
          corps: { data: { pushNotifications: nouvelle } },
        });
      } catch {
        if (sequence.current !== n) return;
        setValeur(precedente);
        setErreur('parametres.enregistrementImpossible');
      }
    },
    [client, valeur,natives],
  );

  const p=natives.preferences;
  return { valeur:client.genre==='rocketvibe'?(p?(!p.push_enabled?'nothing':p.push_mentions_only?'mention':'all'):null):valeur,
    erreur:client.genre==='rocketvibe'?(natives.erreur?'parametres.enregistrementImpossible' as const:null):erreur,
    disabled:client.genre==='rocketvibe'&&(natives.occupe||natives.intention!==null),definir };
}

function Parametres({
  c,
  client,
  username,
  baseUrl,
}: {
  c: Couleurs;
  client: ClientRest;
  username: string;
  baseUrl: string;
}) {
  const routeur = useRouter();
  const t = useT();
  const { deconnecter } = useSession();
  const synchro=useSynchro();
  const chat=synchro.phase==='pret'?synchro.fournisseur.native?.chat:null;
  const natives=usePreferencesNatives(chat,synchro.phase==='pret'?synchro.generation:0);
  const push = usePreferencePush(client,natives);
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
      style={{ backgroundColor: c.fond }}
      contentContainerStyle={styles.contenu}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen options={{ title: t('parametres.titre') }} />

      <Appuyable
        disabled={client.genre==='rocketvibe'&&(synchro.phase!=='pret'||!synchro.fournisseur.native?.chat.capabilities?.profiles)}
        onPress={() => routeur.push('/mon-profil')}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        accessibilityRole="button"
        accessibilityLabel={t('parametres.modifierProfil')}
        style={({ pressed }) => [
          styles.carteProfil,
          { backgroundColor: c.carteProfonde, borderColor: c.bordure, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <TuileAvatar
          c={c}
          cle={username}
          initiale={username.charAt(0)}
          uri={urlAvatar(client, { username, etag: etags.parUsername.get(username) })}
        />
        <View style={styles.profilTextes}>
          <Text style={[styles.profilNom, { color: c.texte }]} numberOfLines={1}>
            @{username}
          </Text>
          <Text style={[styles.profilLien, { color: c.cyan }]}>{t('parametres.modifierProfil')}</Text>
        </View>
        <Text style={[styles.chevron, { color: c.attenue }]}>›</Text>
      </Appuyable>

      {(client.genre !== 'rocketvibe'||synchro.phase==='pret'&&synchro.capacites.push) && <>
      <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('parametres.sectionNotifications')}</Text>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Text style={[styles.reglageTitre, { color: c.texte }]}>{t('parametres.push')}</Text>
        <Text style={[styles.reglageAide, { color: c.attenue }]}>{t('parametres.pushAide')}</Text>
        <ChoixNotification c={c} push={push} />
        {push.erreur !== null && (
          <Text style={[styles.erreur, { color: c.texteErreur }]}>{t(push.erreur)}</Text>
        )}
      </View>
      </>}

      <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('parametres.sectionLangue')}</Text>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Text style={[styles.reglageAide, { color: c.attenue }]}>{t('parametres.langueAide')}</Text>
        <SelecteurLangue c={c} t={t} natives={client.genre==='rocketvibe'?natives:undefined} />
        {client.genre==='rocketvibe'&&natives.erreur&&<Text style={[styles.erreur,{color:c.texteErreur}]}>{t('native.error')}</Text>}
        {client.genre==='rocketvibe'&&natives.intention&&<>
          <Text style={[styles.reglageAide,{color:c.attenue}]}>{t(natives.intention.phase==='failed'?'native.profileRefused':'native.pending')}</Text>
          <Appuyable disabled={natives.occupe} onPress={()=>void(natives.intention?.phase==='failed'?natives.abandonner():natives.reprendre())}>
            <Text style={[styles.action,{color:c.cyan}]}>{t(natives.intention.phase==='failed'?'commun.annuler':'commun.reessayer')}</Text>
          </Appuyable>
        </>}
      </View>

      {client.genre !== 'rocketvibe' && <SectionE2E c={c} t={t} />}

      {client.genre === 'rocketvibe' && <><SectionSecuriteNative c={c}/><SectionAppareils c={c}/><SectionIdentiteChiffree c={c}/></>}

      <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('parametres.sectionCompte')}</Text>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Paire c={c} cle={t('parametres.connecte')} valeur={`@${username}`} />
        <Paire c={c} cle={t('parametres.serveur')} valeur={baseUrl} />
      </View>

      {client.genre !== 'rocketvibe' && <>
        <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('parametres.sectionDiagnostic')}</Text>
        <SectionJetonFcm c={c} t={t} />
      </>}

      <Link href="/connexion?changer=1" style={[styles.lien, { color: c.cyan }]}>
        {t('parametres.changerServeur')}
      </Link>

      <Appuyable
        onPress={seDeconnecter}
        disabled={deconnexion}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        style={({ pressed }) => [
          styles.bouton,
          { backgroundColor: c.carteErreur, opacity: pressed || deconnexion ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.texteBoutonSecondaire, { color: c.texteErreur }]}>{t('parametres.seDeconnecter')}</Text>
      </Appuyable>
    </ScrollView>
  );
}

/** Liste radio des trois niveaux de notification. Rien de coché tant qu'on lit. */
function ChoixNotification({
  c,
  push,
}: {
  c: Couleurs;
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
        const actif = push.valeur === o.valeur;
        const libelle = t(o.cle);
        return (
          <View key={o.valeur} style={styles.enveloppeOption}>
            <Appuyable
              onPress={() => void push.definir(o.valeur)}
              disabled={push.valeur === null||push.disabled}
              android_ripple={{ color: c.ondulation }}
              unstable_pressDelay={DELAI_PRESSION_LISTE}
              accessibilityRole="radio"
              accessibilityState={{ selected: actif }}
              accessibilityLabel={libelle}
              style={[
                styles.optionLigne,
                i > 0 && { borderTopColor: c.bordureDouce, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: actif ? c.accent : c.bordure }]}>
              {actif && <View style={[styles.radioPoint, { backgroundColor: c.accent }]} />}
            </View>
              <Text
                style={[
                  styles.optionTexte,
                  { color: actif ? c.texte : c.texteSecondaire },
                  actif && styles.optionTexteActif,
                ]}
              >
                {libelle}
              </Text>
            </Appuyable>
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
function SelecteurLangue({ c, t,natives }: { c: Couleurs; t: Traducteur;natives?:ReturnType<typeof usePreferencesNatives> }) {
  const preference = usePreferenceLangue();
  const langue=natives?.preferences?.language;
  useEffect(()=>{if(langue!==undefined)definirLangue(langue==='fr'||langue==='en'?langue:'auto');},[langue]);
  const options: { pref: PreferenceLangue; libelle: string; aide?: string }[] = [
    { pref: 'auto', libelle: t('langue.auto'), aide: t('langue.autoAide') },
    ...LANGUES.map((l) => ({ pref: l, libelle: NOMS_LANGUE[l] })),
  ];
  return (
    <View style={styles.options}>
      {options.map((o, i) => {
        const actif = preference === o.pref;
        return (
          <View key={o.pref} style={styles.enveloppeOption}>
            <Appuyable
              disabled={natives!==undefined&&(!natives.preferences||natives.occupe||natives.intention!==null)}
              onPress={() => {definirLangue(o.pref);if(natives)void natives.changer({language:o.pref});}}
              android_ripple={{ color: c.ondulation }}
              unstable_pressDelay={DELAI_PRESSION_LISTE}
              accessibilityRole="radio"
              accessibilityState={{ selected: actif }}
              accessibilityLabel={o.libelle}
              style={[
                styles.optionLigne,
                i > 0 && { borderTopColor: c.bordureDouce, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
            <View style={[styles.radio, { borderColor: actif ? c.accent : c.bordure }]}>
              {actif && <View style={[styles.radioPoint, { backgroundColor: c.accent }]} />}
            </View>
              <View style={styles.optionTextes}>
                <Text
                  style={[
                    styles.optionTexte,
                    { color: actif ? c.texte : c.texteSecondaire },
                    actif && styles.optionTexteActif,
                  ]}
                >
                  {o.libelle}
                </Text>
                {o.aide !== undefined && (
                  <Text style={[styles.optionAide, { color: c.texteTertiaire }]}>{o.aide}</Text>
                )}
              </View>
            </Appuyable>
          </View>
        );
      })}
    </View>
  );
}

/** Diagnostic push : prouve l'obtention du jeton FCM natif. Déplacé de l'accueil. */
function SectionJetonFcm({ c, t }: { c: Couleurs; t: Traducteur }) {
  const [jeton, setJeton] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const demander = useCallback(async () => {
    setErreur(null);
    const r = await obtenirJetonFcm();
    if (r.ok) {
      setJeton(r.jeton);
      console.log('JETON_FCM', r.jeton);
    } else {
      setErreur(`${r.raison}${r.detail ? ` — ${r.detail}` : ''}`);
      console.log('JETON_FCM_ECHEC', r.raison, r.detail ?? '');
    }
  }, []);

  return (
    <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
      <Appuyable
        onPress={demander}
        // Lien texte : vague ronde `borderless` — le masque du ripple borné
        // ignore borderRadius sous Fabric, un rayon calibré fait le travail.
        android_ripple={{ color: c.ondulation, borderless: true, radius: 24 }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
      >
        <Text style={[styles.action, { color: c.cyan }]}>{t('parametres.obtenirJeton')}</Text>
      </Appuyable>
      {jeton !== null && (
        <Text style={[styles.aide, { color: c.texte }]} selectable numberOfLines={3}>
          {jeton}
        </Text>
      )}
      {erreur !== null && <Text style={[styles.aide, { color: c.texteErreur }]}>{erreur}</Text>}
    </View>
  );
}

/**
 * Section chiffrement : état verrouillé/déverrouillé de l'appareil. Verrouillé,
 * un lien ouvre la feuille de déverrouillage ; déverrouillé, un bouton oublie
 * la clé (re-masque le clair local).
 */
function SectionE2E({ c, t }: { c: Couleurs; t: Traducteur }) {
  const routeur = useRouter();
  const synchro = useSynchro();
  const e2e = synchro.phase === 'pret' ? synchro.e2e : null;
  const deverrouille = useE2EDeverrouille(e2e);
  const [occupe, setOccupe] = useState(false);

  const verrouiller = (): void => {
    if (synchro.phase !== 'pret' || occupe) return;
    setOccupe(true);
    void synchro.verrouillerE2E().finally(() => setOccupe(false));
  };

  return (
    <>
      <Text style={[styles.sectionTitre, { color: c.attenue }]}>{t('parametres.e2eTitre')}</Text>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Text style={[styles.reglageAide, { color: c.attenue }]}>
          {t(deverrouille ? 'parametres.e2eDeverrouille' : 'parametres.e2eVerrouille')}
        </Text>
        {deverrouille ? (
          <Appuyable
            onPress={verrouiller}
            disabled={occupe}
            android_ripple={{ color: c.ondulation, borderless: true, radius: 24 }}
            unstable_pressDelay={DELAI_PRESSION_LISTE}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed || occupe ? 0.6 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profilLien, { color: c.texteErreur }]}>
              {t('parametres.e2eVerrouiller')}
            </Text>
          </Appuyable>
        ) : (
          <Appuyable
            onPress={() => routeur.push('/deverrouiller-e2e')}
            android_ripple={{ color: c.ondulation, borderless: true, radius: 24 }}
            unstable_pressDelay={DELAI_PRESSION_LISTE}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1, paddingVertical: 6 })}
          >
            <Text style={[styles.profilLien, { color: c.cyan }]}>
              {t('parametres.e2eDeverrouiller')}
            </Text>
          </Appuyable>
        )}
      </View>
    </>
  );
}

function Paire({ c, cle, valeur }: { c: Couleurs; cle: string; valeur: string }) {
  return (
    <View style={styles.paire}>
      <Text style={[styles.cle, { color: c.attenue }]}>{cle}</Text>
      <Text style={[styles.valeur, { color: c.texte }]} selectable>
        {valeur}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenu: { padding: 20, gap: 12, paddingBottom: 40 },
  carteProfil: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
  },
  profilTextes: { flex: 1, gap: 2 },
  profilNom: { fontFamily: POLICES.titre, fontSize: 17 },
  profilLien: { fontFamily: POLICES.corpsGras, fontSize: 13 },
  chevron: { fontFamily: POLICES.titre, fontSize: 24 },
  sectionTitre: {
    fontFamily: POLICES.corpsFort,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 8,
    marginLeft: 4,
  },
  carte: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 10 },
  reglageTitre: { fontFamily: POLICES.titre, fontSize: 16 },
  reglageAide: { fontFamily: POLICES.corps, fontSize: 13, lineHeight: 18 },
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
  radioPoint: { width: 10, height: 10, borderRadius: 5 },
  optionTextes: { flex: 1, gap: 1 },
  optionTexte: { fontFamily: POLICES.corpsGras, fontSize: 15, flexShrink: 1 },
  optionTexteActif: { fontFamily: POLICES.corpsFort },
  optionAide: { fontFamily: POLICES.corps, fontSize: 12 },
  charge: { paddingVertical: 18, alignItems: 'center' },
  erreur: { fontFamily: POLICES.corpsGras, fontSize: 13 },
  paire: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  cle: { fontFamily: POLICES.corps, fontSize: 13 },
  valeur: { fontFamily: POLICES.corpsGras, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  action: { fontFamily: POLICES.corpsGras, fontSize: 13 },
  aide: { fontFamily: POLICES.corps, fontSize: 12, opacity: 0.9 },
  lien: { fontFamily: POLICES.corpsGras, fontSize: 15, paddingVertical: 12, textAlign: 'center' },
  bouton: {
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBoutonSecondaire: { fontFamily: POLICES.corpsGras, fontSize: 16 },
});
