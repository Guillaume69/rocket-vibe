import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SERVEUR_PAR_DEFAUT } from '../db/migrer.ts';
import { demanderCodeParEmail, preparerCodeDeuxFacteurs, seConnecter } from '../lib/auth.ts';
import { ClientRest, ErreurDeuxFacteurs, ErreurRest, type CodeDeuxFacteurs } from '../lib/rest.ts';
import { sonderServeur, type ProfilServeur } from '../lib/server.ts';
import { hacher, lireDernierServeur, listerServeursConnus } from '../lib/sessionStore.ts';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { BoutonPrincipal, Marque, TuileAvatar } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { type Couleurs, POLICES, useCouleurs } from '../ui/theme.ts';

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
  const insets = useSafeAreaInsets();

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

  const surServeur = phase.nom === 'serveur';
  // Route « changer de serveur » (poussée depuis l'accueil) : on GARDE l'en-tête
  // natif — son bouton retour est la seule sortie vers l'app, et il porte le
  // titre accessible. Le login racine, lui, reste sans en-tête (logo plein).
  const routeChangement = changer === '1';

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ headerShown: routeChangement, title: 'Connexion' }} />
      <CielEtoile c={c} />
      <ScrollView
        contentContainerStyle={[
          styles.contenu,
          {
            paddingTop: routeChangement ? 20 : insets.top + 20,
            justifyContent: surServeur ? 'center' : 'flex-start',
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {surServeur ? (
          <EnTeteMarque c={c} />
        ) : (
          <RetourConnexion c={c} onRetour={revenirAuServeur} occupe={occupe} />
        )}

        {phase.nom !== 'serveur' && (
          <View style={[styles.chipServeur, { backgroundColor: c.carte, borderColor: c.bordure }]}>
            <Text style={[styles.chipTexte, { color: c.attenue }]}>
              {phase.client.baseUrl} · Rocket.Chat {phase.profil.version}
            </Text>
          </View>
        )}

        {phase.nom === 'serveur' && (
          <>
            <ChampPilule
              c={c}
              etiquette="Adresse du serveur"
              icone="🌐"
              valeur={adresse}
              onChangeText={setAdresse}
              onSubmitEditing={validerServeur}
              keyboardType="url"
              inputMode="url"
              placeholder="chat.exemple.fr"
              autoComplete="url"
            />
            <BoutonPrincipal c={c} occupe={occupe} onPress={() => void validerServeur()} titre="Continuer" />

            {serveursConnus.length > 0 && (
              <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
                <Text style={[styles.surtitre, { color: c.attenue }]}>Serveurs connus</Text>
                {serveursConnus.map((url) => (
                  <Pressable key={url} onPress={() => void basculer(url)} disabled={occupe}>
                    <Text style={[styles.lienServeur, { color: c.cyan }]}>{url}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}

        {phase.nom === 'identifiants' && (
          <>
            <ChampPilule
              c={c}
              etiquette="Identifiant ou email"
              valeur={utilisateur}
              onChangeText={setUtilisateur}
              placeholder="jean.dupont"
              autoComplete="username"
              autoFocus
            />
            <ChampPilule
              c={c}
              etiquette="Mot de passe"
              valeur={motDePasse}
              onChangeText={setMotDePasse}
              onSubmitEditing={() => void tenterConnexion()}
              placeholder="••••••••"
              autoComplete="current-password"
              secureTextEntry
            />
            <BoutonPrincipal
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
          <View style={[styles.carte, { backgroundColor: c.carteErreur, borderColor: c.danger }]}>
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
            <Text style={[styles.lien, { color: c.cyan }]}>Changer de serveur</Text>
          </Pressable>
        )}
      </ScrollView>
    </VueEvitantLeClavier>
  );
}

/** En-tête de la marque : licorne, barres arc-en-ciel, logotype, sous-titre. */
function EnTeteMarque({ c }: { c: Couleurs }) {
  return (
    <View style={styles.marque}>
      <Text style={styles.licorne}>🦄</Text>
      <View style={styles.barres}>
        {[c.accent, c.jaune, c.cyan, c.violet].map((couleur, i) => (
          <View key={i} style={[styles.barre, { backgroundColor: couleur }]} />
        ))}
      </View>
      <Marque c={c} />
      <Text style={[styles.sousTitre, { color: c.attenue }]}>Ton coin de chat magique ✨</Text>
    </View>
  );
}

/** Retour vers l'étape serveur, en tête des phases identifiants / 2FA. */
function RetourConnexion({
  c,
  onRetour,
  occupe,
}: {
  c: Couleurs;
  onRetour: () => void;
  occupe: boolean;
}) {
  return (
    <Pressable onPress={onRetour} disabled={occupe} style={styles.retour} hitSlop={10}>
      <Text style={[styles.chevron, { color: c.violet }]}>‹</Text>
      <Text style={[styles.retourTitre, { color: c.texte }]}>Connexion</Text>
    </Pressable>
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
        <BlasonDeuxFacteurs c={c} sousTitre="Ce compte est protégé par un code envoyé par email." />
        <BoutonPrincipal c={c} occupe={occupe} onPress={onEnvoyerEmail} titre="M'envoyer le code" />
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
      <BlasonDeuxFacteurs
        c={c}
        sousTitre={
          erreur.methode === 'password'
            ? 'Ressaisis ton mot de passe pour confirmer.'
            : "Entre le code de ton application\nd'authentification ✨"
        }
      />
      <ChampPilule
        c={c}
        etiquette={etiquette}
        valeur={code}
        grand={erreur.methode !== 'password'}
        onChangeText={onChangeCode}
        onSubmitEditing={onValider}
        placeholder={erreur.methode === 'password' ? '••••••••' : '123456'}
        keyboardType={erreur.methode === 'password' ? 'default' : 'number-pad'}
        autoComplete={erreur.methode === 'password' ? 'current-password' : 'one-time-code'}
        secureTextEntry={erreur.methode === 'password'}
        autoFocus
      />
      <BoutonPrincipal c={c} occupe={occupe} onPress={onValider} titre="Valider" />
      {erreur.methode === 'email' && (
        <Pressable onPress={onEnvoyerEmail} disabled={occupe}>
          <Text style={[styles.lien, { color: c.cyan }]}>Renvoyer le code</Text>
        </Pressable>
      )}
    </>
  );
}

/** Blason « Vérification magique » : icône bouclier en dégradé + sous-titre. */
function BlasonDeuxFacteurs({ c, sousTitre }: { c: Couleurs; sousTitre: string }) {
  return (
    <View style={styles.blason}>
      <TuileAvatar
        c={c}
        deg={[c.violet, c.cyan] as const}
        taille={70}
        rayon={22}
        enfant={<Text style={styles.bouclierGlyphe}>🛡️</Text>}
      />
      <Text style={[styles.blasonTitre, { color: c.texte }]}>Vérification magique</Text>
      <Text style={[styles.blasonSousTitre, { color: c.attenue }]}>{sousTitre}</Text>
    </View>
  );
}

type PropsChamp = {
  c: Couleurs;
  etiquette: string;
  valeur: string;
  icone?: string;
  grand?: boolean;
} & Omit<React.ComponentProps<typeof TextInput>, 'value' | 'style'>;

/** Champ en pilule : contour cyan et anneau au focus, comme le design. */
function ChampPilule({ c, etiquette, valeur, icone, grand, ...props }: PropsChamp) {
  const [focus, setFocus] = useState(false);
  const champ = useRef<TextInput>(null);
  return (
    <View style={styles.groupe}>
      <Text style={[styles.etiquette, { color: c.attenue }]}>{etiquette}</Text>
      {/* Pressable : taper N'IMPORTE OÙ dans la pilule (padding, icône) focalise
          le champ — le padding vit sur l'enveloppe, pas sur l'input lui-même. */}
      <Pressable
        onPress={() => champ.current?.focus()}
        style={[
          styles.pilule,
          { backgroundColor: c.carte, borderColor: focus ? c.cyan : c.bordure },
          // Anneau diffus au focus, DÉRIVÉ du token (`24` hex ≈ 14 % d'opacité).
          focus && { boxShadow: `0px 0px 0px 3px ${c.cyan}24` },
        ]}
      >
        {icone !== undefined && <Text style={styles.icone}>{icone}</Text>}
        <TextInput
          ref={champ}
          value={valeur}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          placeholderTextColor={c.texteTertiaire}
          {...props}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={[grand ? styles.saisieGrande : styles.saisie, { color: c.texte }]}
        />
      </Pressable>
    </View>
  );
}

/**
 * Ciel étoilé décoratif, en fond d'écran. Purement ornemental. `memo` car `c`
 * est stable (palette forcée) : inutile de le re-rendre à chaque frappe.
 */
const CielEtoile = memo(function CielEtoile({ c }: { c: Couleurs }) {
  const etoiles: { top: number; left: number; taille: number; couleur: string; opacite: number }[] = [
    { top: 90, left: 44, taille: 10, couleur: '#FFFFFF', opacite: 0.5 },
    { top: 150, left: 300, taille: 12, couleur: c.jaune, opacite: 0.7 },
    { top: 250, left: 70, taille: 9, couleur: c.cyan, opacite: 0.6 },
    { top: 330, left: 320, taille: 11, couleur: '#FFFFFF', opacite: 0.4 },
    { top: 470, left: 40, taille: 10, couleur: c.violet, opacite: 0.55 },
    { top: 560, left: 280, taille: 9, couleur: c.cyan, opacite: 0.4 },
    { top: 640, left: 120, taille: 8, couleur: '#FFFFFF', opacite: 0.35 },
  ];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {etoiles.map((e, i) => (
        <Text
          key={i}
          style={{
            position: 'absolute',
            top: e.top,
            left: e.left,
            fontSize: e.taille,
            color: e.couleur,
            opacity: e.opacite,
          }}
        >
          ✦
        </Text>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  contenu: { flexGrow: 1, padding: 26, paddingBottom: 32, gap: 16 },
  marque: { alignItems: 'center', gap: 4, marginBottom: 10 },
  licorne: { fontSize: 46, lineHeight: 52 },
  barres: { flexDirection: 'row', gap: 5, marginVertical: 8 },
  barre: { width: 26, height: 5, borderRadius: 3 },
  sousTitre: { fontFamily: POLICES.corps, fontSize: 13, marginTop: 2 },
  retour: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  chevron: { fontSize: 26, fontFamily: POLICES.titre },
  retourTitre: { fontFamily: POLICES.titre, fontSize: 17 },
  chipServeur: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  chipTexte: { fontFamily: POLICES.corpsSemi, fontSize: 12.5 },
  groupe: { gap: 6 },
  etiquette: { fontFamily: POLICES.corpsGras, fontSize: 12.5, paddingLeft: 4 },
  pilule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderRadius: 16,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  icone: { fontSize: 14 },
  saisie: { flex: 1, fontFamily: POLICES.corpsSemi, fontSize: 15, padding: 0 },
  saisieGrande: {
    flex: 1,
    fontFamily: POLICES.titre,
    fontSize: 26,
    letterSpacing: 8,
    textAlign: 'center',
    padding: 0,
  },
  blason: { alignItems: 'center', gap: 4, marginTop: 6, marginBottom: 4 },
  bouclierGlyphe: { fontSize: 34 },
  blasonTitre: { fontFamily: POLICES.titre, fontSize: 21, marginTop: 12 },
  blasonSousTitre: { fontFamily: POLICES.corps, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  carte: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 9 },
  surtitre: { fontFamily: POLICES.corpsFort, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase' },
  lienServeur: { fontFamily: POLICES.corpsGras, fontSize: 14, paddingVertical: 3 },
  messageErreur: { fontFamily: POLICES.corpsGras, fontSize: 14 },
  aide: { fontFamily: POLICES.corps, fontSize: 13, lineHeight: 18 },
  lien: { fontFamily: POLICES.corpsGras, fontSize: 14, paddingVertical: 12, textAlign: 'center' },
});
