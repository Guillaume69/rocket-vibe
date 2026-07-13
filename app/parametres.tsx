import { Link, Redirect, Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { obtenirJetonFcm } from '../lib/push.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { TuileAvatar } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';

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
const OPTIONS_PUSH: { valeur: NiveauPush; libelle: string }[] = [
  { valeur: 'all', libelle: 'Tous les messages' },
  { valeur: 'mention', libelle: 'Mentions et messages directs' },
  { valeur: 'nothing', libelle: 'Aucune' },
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
function usePreferencePush(client: ClientRest) {
  const [valeur, setValeur] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    client
      .get<ReponseMe>('me')
      .then((r) => {
        if (vivant) setValeur(r.settings?.preferences?.pushNotifications ?? 'default');
      })
      .catch(() => {
        if (vivant) setErreur('Préférence de notification introuvable.');
      });
    return () => {
      vivant = false;
    };
  }, [client]);

  const definir = useCallback(
    async (nouvelle: NiveauPush) => {
      const precedente = valeur;
      setValeur(nouvelle);
      setErreur(null);
      try {
        await client.post('users.setPreferences', {
          corps: { data: { pushNotifications: nouvelle } },
        });
      } catch {
        setValeur(precedente);
        setErreur('Enregistrement impossible — réessaie.');
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
  c: Couleurs;
  client: ClientRest;
  username: string;
  baseUrl: string;
}) {
  const routeur = useRouter();
  const { deconnecter } = useSession();
  const push = usePreferencePush(client);
  const [deconnexion, setDeconnexion] = useState(false);

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
      <Stack.Screen options={{ title: 'Paramètres' }} />

      <Pressable
        onPress={() => routeur.push('/mon-profil')}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        accessibilityRole="button"
        accessibilityLabel="Modifier mon profil"
        style={({ pressed }) => [
          styles.carteProfil,
          { backgroundColor: c.carteProfonde, borderColor: c.bordure, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <TuileAvatar c={c} cle={username} initiale={username.charAt(0)} uri={urlAvatar(client, { username })} />
        <View style={styles.profilTextes}>
          <Text style={[styles.profilNom, { color: c.texte }]} numberOfLines={1}>
            @{username}
          </Text>
          <Text style={[styles.profilLien, { color: c.cyan }]}>Modifier mon profil</Text>
        </View>
        <Text style={[styles.chevron, { color: c.attenue }]}>›</Text>
      </Pressable>

      <Text style={[styles.sectionTitre, { color: c.attenue }]}>Notifications</Text>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Text style={[styles.reglageTitre, { color: c.texte }]}>Notifications push</Text>
        <Text style={[styles.reglageAide, { color: c.attenue }]}>
          Quels messages déclenchent une notification sur cet appareil.
        </Text>
        <ChoixNotification c={c} push={push} />
        {push.erreur !== null && (
          <Text style={[styles.erreur, { color: c.texteErreur }]}>{push.erreur}</Text>
        )}
      </View>

      <Text style={[styles.sectionTitre, { color: c.attenue }]}>Compte</Text>
      <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
        <Paire c={c} cle="Connecté" valeur={`@${username}`} />
        <Paire c={c} cle="Serveur" valeur={baseUrl} />
      </View>

      <Text style={[styles.sectionTitre, { color: c.attenue }]}>Diagnostic</Text>
      <SectionJetonFcm c={c} />

      <Link href="/connexion?changer=1" style={[styles.lien, { color: c.cyan }]}>
        Changer de serveur
      </Link>

      <Pressable
        onPress={seDeconnecter}
        disabled={deconnexion}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        style={({ pressed }) => [
          styles.bouton,
          { backgroundColor: c.carteErreur, opacity: pressed || deconnexion ? 0.6 : 1 },
        ]}
      >
        <Text style={[styles.texteBoutonSecondaire, { color: c.texteErreur }]}>Se déconnecter</Text>
      </Pressable>
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
        return (
          <Pressable
            key={o.valeur}
            onPress={() => void push.definir(o.valeur)}
            disabled={push.valeur === null}
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
            <Text
              style={[
                styles.optionTexte,
                { color: actif ? c.texte : c.texteSecondaire },
                actif && styles.optionTexteActif,
              ]}
            >
              {o.libelle}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Diagnostic push : prouve l'obtention du jeton FCM natif. Déplacé de l'accueil. */
function SectionJetonFcm({ c }: { c: Couleurs }) {
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
      <Pressable
        onPress={demander}
        android_ripple={{ color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
      >
        <Text style={[styles.action, { color: c.cyan }]}>Obtenir le jeton FCM</Text>
      </Pressable>
      {jeton !== null && (
        <Text style={[styles.aide, { color: c.texte }]} selectable numberOfLines={3}>
          {jeton}
        </Text>
      )}
      {erreur !== null && <Text style={[styles.aide, { color: c.texteErreur }]}>{erreur}</Text>}
    </View>
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
  optionTexte: { fontFamily: POLICES.corpsGras, fontSize: 15, flexShrink: 1 },
  optionTexteActif: { fontFamily: POLICES.corpsFort },
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
