import { Link, Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SERVEUR_PAR_DEFAUT } from '../db/migrer.ts';
import { demanderCodeParEmail, preparerCodeDeuxFacteurs, seConnecter } from '../lib/auth.ts';
import { ClientRest, ErreurDeuxFacteurs, ErreurRest, type CodeDeuxFacteurs } from '../lib/rest.ts';
import { sonderServeur, type ProfilServeur } from '../lib/server.ts';
import { hacher, lireDernierServeur, listerServeursConnus } from '../lib/sessionStore.ts';
import { useSession } from '../ui/session.tsx';
import { useCouleurs, type Couleurs } from '../ui/theme.ts';

/**
 * Écran de connexion, en trois temps : serveur → identifiants → second facteur.
 *
 * Le second facteur n'est pas deviné : `ErreurDeuxFacteurs.methode` dit ce que
 * le serveur attend. `totp` et `email` envoient le code saisi ; `password`
 * attend le SHA-256 du mot de passe ressaisi — jamais le clair
 * (`preparerCodeDeuxFacteurs` s'en charge).
 *
 * Le client REST vit DANS les variantes de `Phase` : il existe exactement
 * quand un serveur a été validé, et l'état ne peut pas se désynchroniser.
 */

type Phase =
  | { nom: 'serveur' }
  | { nom: 'identifiants'; profil: ProfilServeur; client: ClientRest }
  | {
      nom: 'deuxFacteurs';
      profil: ProfilServeur;
      client: ClientRest;
      erreur: ErreurDeuxFacteurs;
      codeEnvoye: boolean;
    };

export default function EcranConnexion() {
  const { etat, connecter, changerDeServeur } = useSession();
  const { changer } = useLocalSearchParams<{ changer?: string }>();
  const routeur = useRouter();
  const c = useCouleurs();

  const [phase, setPhase] = useState<Phase>({ nom: 'serveur' });
  const [adresse, setAdresse] = useState(SERVEUR_PAR_DEFAUT);
  const [utilisateur, setUtilisateur] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [code, setCode] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Garde de réentrance dans une ref, pas dans `occupe` : deux événements de
  // la même frame (Entrée clavier + tape sur le bouton) liraient tous deux
  // l'ancienne valeur de l'état et enverraient deux logins — dont deux
  // consommations du même code TOTP à usage unique.
  const enVol = useRef(false);
  const requete = useRef<AbortController | null>(null);
  useEffect(() => () => requete.current?.abort(), []);

  // Pré-remplir avec le dernier serveur utilisé, sans écraser une saisie déjà
  // commencée — et charger le registre des serveurs connus (5.3).
  const [serveursConnus, setServeursConnus] = useState<string[]>([]);
  useEffect(() => {
    let abandonne = false;
    lireDernierServeur()
      .then((dernier) => {
        if (!abandonne && dernier !== null) {
          setAdresse((courante) => (courante === SERVEUR_PAR_DEFAUT ? dernier : courante));
        }
      })
      .catch(() => {});
    listerServeursConnus()
      .then((liste) => {
        if (!abandonne) setServeursConnus(liste);
      })
      .catch(() => {});
    return () => {
      abandonne = true;
    };
  }, []);

  // Bascule multi-serveurs : chaque session vit sous sa propre clé, changer
  // de serveur ne déconnecte personne. Réentrance gardée : deux taps rapides
  // sur deux serveurs feraient courir deux bascules dont les écritures
  // s'entrelacent.
  const basculer = useCallback(
    async (url: string) => {
      if (enVol.current) return;
      enVol.current = true;
      setOccupe(true);
      try {
        const sessionExistante = await changerDeServeur(url);
        if (sessionExistante) {
          routeur.replace('/');
        } else {
          // Pas de session là-bas : on reste connecté ici, le formulaire se
          // pré-remplit simplement.
          setAdresse(url);
          setMessage(null);
          setPhase({ nom: 'serveur' });
        }
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [changerDeServeur, routeur],
  );

  const validerServeur = useCallback(async () => {
    if (enVol.current) return;
    enVol.current = true;
    requete.current?.abort();
    const controleur = new AbortController();
    requete.current = controleur;
    setOccupe(true);
    setMessage(null);
    try {
      const profil = await sonderServeur(adresse, controleur.signal);
      if (controleur.signal.aborted) return;
      if (!profil.formulaireDeConnexion) {
        // `Accounts_ShowFormLogin = false` : le serveur ne propose que du SSO.
        // L'API accepte parfois quand même un login direct — on prévient sans
        // bloquer.
        setMessage('Ce serveur ne propose pas la connexion par mot de passe.');
      }
      setPhase({ nom: 'identifiants', profil, client: new ClientRest(profil.baseUrl) });
    } catch (e) {
      if (!controleur.signal.aborted) {
        setMessage(e instanceof Error ? e.message : 'Serveur injoignable.');
      }
    } finally {
      enVol.current = false;
      if (!controleur.signal.aborted) setOccupe(false);
    }
  }, [adresse]);

  const tenterConnexion = useCallback(
    async (deuxFacteurs?: CodeDeuxFacteurs) => {
      if (enVol.current || phase.nom === 'serveur') return;
      enVol.current = true;
      setOccupe(true);
      setMessage(null);
      try {
        const session = await seConnecter(
          phase.client,
          { utilisateur: utilisateur.trim(), motDePasse },
          deuxFacteurs,
        );
        await connecter(session);
        // Navigation explicite : le <Redirect> en tête de rendu couvre la
        // reprise de session, mais il est neutralisé quand on est venu par
        // « changer de serveur » (`?changer=1`) — sans ceci, un login réussi
        // depuis ce chemin laisserait l'utilisateur planté ici.
        routeur.replace('/');
      } catch (e) {
        if (e instanceof ErreurDeuxFacteurs) {
          // Le serveur veut un second facteur — ou refuse celui qu'on vient
          // d'envoyer, auquel cas il relève la même erreur.
          const memeMethode = phase.nom === 'deuxFacteurs' && phase.erreur.methode === e.methode;
          setCode('');
          setPhase({
            nom: 'deuxFacteurs',
            profil: phase.profil,
            client: phase.client,
            erreur: e,
            // Un code email déjà parti ne « repart » pas parce que le serveur
            // relève l'erreur avec `codeGenerated: false` (renvoi limité).
            codeEnvoye: e.codeGenere || (memeMethode && phase.codeEnvoye),
          });
          if (deuxFacteurs !== undefined && memeMethode) setMessage('Code refusé. Réessaie.');
        } else if (
          e instanceof ErreurRest &&
          (e.erreur === 'totp-invalid' || e.errorType === 'totp-invalid')
        ) {
          // Même dualité error/errorType que `totp-required` : voir lib/rest.ts.
          setMessage('Code refusé. Réessaie.');
        } else if (e instanceof ErreurRest && e.statut === 401) {
          setMessage('Identifiant ou mot de passe refusé.');
        } else {
          setMessage(e instanceof Error ? e.message : 'Connexion impossible.');
        }
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [phase, utilisateur, motDePasse, connecter, routeur],
  );

  const validerCode = useCallback(async () => {
    if (phase.nom !== 'deuxFacteurs' || code.trim() === '') return;
    try {
      const prepare = await preparerCodeDeuxFacteurs(phase.erreur, code, hacher);
      await tenterConnexion(prepare);
    } catch (e) {
      // Un `hacher` qui échoue ne doit pas rendre le bouton muet.
      setMessage(e instanceof Error ? e.message : 'Préparation du code impossible.');
    }
  }, [phase, code, tenterConnexion]);

  const envoyerCodeEmail = useCallback(async () => {
    if (enVol.current || phase.nom !== 'deuxFacteurs') return;
    enVol.current = true;
    setOccupe(true);
    setMessage(null);
    try {
      await demanderCodeParEmail(phase.client, utilisateur.trim());
      setPhase({ ...phase, codeEnvoye: true });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Impossible d'envoyer le code.");
    } finally {
      enVol.current = false;
      setOccupe(false);
    }
  }, [phase, utilisateur]);

  const revenirAuServeur = useCallback(() => {
    setMotDePasse('');
    setCode('');
    setMessage(null);
    setPhase({ nom: 'serveur' });
  }, []);

  // Déjà connecté (reprise au démarrage, ou login qui vient d'aboutir) : cet
  // écran n'a rien à montrer — SAUF si on vient exprès changer de serveur.
  if (etat.phase === 'connecte' && changer !== '1') return <Redirect href="/" />;

  return (
    <SafeAreaView style={[styles.plein, { backgroundColor: c.fond }]} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Connexion' }} />
      <ScrollView contentContainerStyle={styles.contenu} keyboardShouldPersistTaps="handled">
        {phase.nom === 'serveur' && (
          <>
            <Champ
              c={c}
              etiquette="Adresse du serveur"
              valeur={adresse}
              onChangeText={setAdresse}
              onSubmitEditing={validerServeur}
              keyboardType="url"
              inputMode="url"
              placeholder="chat.exemple.fr"
              autoComplete="url"
            />
            <Bouton c={c} occupe={occupe} onPress={() => void validerServeur()} titre="Continuer" />

            {serveursConnus.length > 0 && (
              <View style={[styles.carte, { backgroundColor: c.carte }]}>
                <Text style={[styles.etiquette, { color: c.attenue }]}>Serveurs connus</Text>
                {serveursConnus.map((url) => (
                  <Pressable key={url} onPress={() => void basculer(url)} disabled={occupe}>
                    <Text style={[styles.lien, { color: c.accent, textAlign: 'left' }]}>{url}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}

        {phase.nom !== 'serveur' && (
          <View style={[styles.carte, { backgroundColor: c.carte }]}>
            <Text style={[styles.aide, { color: c.attenue }]}>
              {phase.client.baseUrl} · Rocket.Chat {phase.profil.version}
            </Text>
          </View>
        )}

        {phase.nom === 'identifiants' && (
          <>
            <Champ
              c={c}
              etiquette="Identifiant ou email"
              valeur={utilisateur}
              onChangeText={setUtilisateur}
              placeholder="jean.dupont"
              autoComplete="username"
              autoFocus
            />
            <Champ
              c={c}
              etiquette="Mot de passe"
              valeur={motDePasse}
              onChangeText={setMotDePasse}
              onSubmitEditing={() => void tenterConnexion()}
              placeholder="••••••••"
              autoComplete="current-password"
              secureTextEntry
            />
            <Bouton
              c={c}
              occupe={occupe}
              onPress={() => void tenterConnexion()}
              titre="Se connecter"
            />
          </>
        )}

        {phase.nom === 'deuxFacteurs' && (
          <SectionDeuxFacteurs
            c={c}
            erreur={phase.erreur}
            codeEnvoye={phase.codeEnvoye}
            code={code}
            occupe={occupe}
            onChangeCode={setCode}
            onValider={() => void validerCode()}
            onEnvoyerEmail={() => void envoyerCodeEmail()}
          />
        )}

        {message !== null && (
          <View style={[styles.carte, { backgroundColor: c.carteErreur }]}>
            <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{message}</Text>
            {phase.nom === 'serveur' && Platform.OS === 'android' && (
              <Text style={[styles.aide, { color: c.texteErreur }]}>
                Depuis l&apos;émulateur : `adb reverse tcp:3000 tcp:3000`. Depuis un téléphone :
                l&apos;IP LAN de la machine.
              </Text>
            )}
          </View>
        )}

        {phase.nom !== 'serveur' && (
          <Pressable onPress={revenirAuServeur} disabled={occupe}>
            <Text style={[styles.lien, { color: c.accent }]}>Changer de serveur</Text>
          </Pressable>
        )}

        {/* L'instrument de diagnostic doit rester joignable même quand la
            connexion est précisément ce qui est cassé. */}
        <Link href="/debug" style={[styles.lien, { color: c.attenue }]}>
          Écran debug
        </Link>
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionDeuxFacteurs({
  c,
  erreur,
  codeEnvoye,
  code,
  occupe,
  onChangeCode,
  onValider,
  onEnvoyerEmail,
}: {
  c: Couleurs;
  erreur: ErreurDeuxFacteurs;
  codeEnvoye: boolean;
  code: string;
  occupe: boolean;
  onChangeCode: (v: string) => void;
  onValider: () => void;
  onEnvoyerEmail: () => void;
}) {
  if (erreur.methode === 'email' && !codeEnvoye) {
    // `codeGenerated: false` : aucun code n'est encore parti, il faut le
    // demander explicitement avant d'afficher un champ de saisie.
    return (
      <>
        <Text style={[styles.aide, { color: c.attenue }]}>
          Ce compte est protégé par un code envoyé par email.
        </Text>
        <Bouton c={c} occupe={occupe} onPress={onEnvoyerEmail} titre="M'envoyer le code" />
      </>
    );
  }

  const etiquette =
    erreur.methode === 'totp'
      ? "Code de l'application d'authentification"
      : erreur.methode === 'email'
        ? 'Code reçu par email'
        : 'Confirme ton mot de passe';

  return (
    <>
      <Champ
        c={c}
        etiquette={etiquette}
        valeur={code}
        onChangeText={onChangeCode}
        onSubmitEditing={onValider}
        placeholder={erreur.methode === 'password' ? '••••••••' : '123456'}
        keyboardType={erreur.methode === 'password' ? 'default' : 'number-pad'}
        autoComplete={erreur.methode === 'password' ? 'current-password' : 'one-time-code'}
        secureTextEntry={erreur.methode === 'password'}
        autoFocus
      />
      <Bouton c={c} occupe={occupe} onPress={onValider} titre="Valider" />
      {erreur.methode === 'email' && (
        <Pressable onPress={onEnvoyerEmail} disabled={occupe}>
          <Text style={[styles.lien, { color: c.accent }]}>Renvoyer le code</Text>
        </Pressable>
      )}
    </>
  );
}

type PropsChamp = {
  c: Couleurs;
  etiquette: string;
  valeur: string;
} & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'style'>;

function Champ({ c, etiquette, valeur, ...props }: PropsChamp) {
  return (
    <View style={styles.groupe}>
      <Text style={[styles.etiquette, { color: c.attenue }]}>{etiquette}</Text>
      <TextInput
        value={valeur}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="go"
        placeholderTextColor={c.attenue}
        style={[styles.champ, { color: c.texte, borderColor: c.bordure }]}
        {...props}
      />
    </View>
  );
}

function Bouton({
  c,
  occupe,
  onPress,
  titre,
}: {
  c: Couleurs;
  occupe: boolean;
  onPress: () => void;
  titre: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={occupe}
      android_ripple={{ color: c.ondulation }}
      style={({ pressed }) => [
        styles.bouton,
        { backgroundColor: c.accent, opacity: pressed || occupe ? 0.6 : 1 },
      ]}
    >
      {occupe ? <ActivityIndicator color="#fff" /> : <Text style={styles.texteBouton}>{titre}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  contenu: { padding: 20, gap: 12 },
  groupe: { gap: 6 },
  etiquette: { fontSize: 13, fontWeight: '500' },
  champ: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  bouton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  texteBouton: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  carte: { borderRadius: 12, padding: 16, gap: 10, marginTop: 4 },
  messageErreur: { fontSize: 14, fontWeight: '600' },
  aide: { fontSize: 13, lineHeight: 18 },
  lien: { fontSize: 15, fontWeight: '600', paddingVertical: 12, textAlign: 'center' },
});
