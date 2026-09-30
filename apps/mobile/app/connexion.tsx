import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SERVEUR_PAR_DEFAUT } from '../db/migrer.ts';
import { demanderCodeParEmail, preparerCodeDeuxFacteurs, seConnecter } from '../lib/auth.ts';
import { ClientRest, ErreurDeuxFacteurs, ErreurRest, type CodeDeuxFacteurs } from '../lib/rest.ts';
import { discoverServer, type ServerProfile as ProfilServeur } from '../lib/serverKind.ts';
import { nativeLogin } from '../fournisseurs/rocketvibe/auth.ts';
import { hacher, lireDernierServeur, listerServeursConnus } from '../lib/sessionStore.ts';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { useT } from '../ui/i18n.ts';
import { BoutonPrincipal, ChampPilule, Marque, TuileAvatar } from '../ui/kit.tsx';
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
  const t = useT();
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
      const profil = await discoverServer(adresse, controleur.signal);
      if (controleur.signal.aborted) return;
      if (!profil.formulaireDeConnexion) {
        // `Accounts_ShowFormLogin = false` : le serveur ne propose que du SSO.
        // L'API accepte parfois quand même un login direct — on prévient sans
        // bloquer.
        setMessage(t('connexion.sansMotDePasse'));
      }
      setPhase({ nom: 'identifiants', profil, client: new ClientRest(profil.baseUrl) });
    } catch (e) {
      if (!controleur.signal.aborted) {
        setMessage(e instanceof Error ? e.message : t('connexion.serveurInjoignable'));
      }
    } finally {
      enVol.current = false;
      if (!controleur.signal.aborted) setOccupe(false);
    }
  }, [adresse, t]);

  const tenterConnexion = useCallback(
    async (deuxFacteurs?: CodeDeuxFacteurs) => {
      if (enVol.current || phase.nom === 'serveur') return;
      enVol.current = true;
      setOccupe(true);
      setMessage(null);
      try {
        const session = phase.profil.native
          ? await nativeLogin(phase.profil.baseUrl, phase.profil.native, { utilisateur: utilisateur.trim(), motDePasse })
          : await seConnecter(
          phase.client,
          { utilisateur: utilisateur.trim(), motDePasse },
          deuxFacteurs,
        );
        // `Site_Url` vient du sondage, pas du login : c'est ICI qu'il entre
        // dans la session persistée — voir `Session.siteUrl` (lib/auth.ts).
        await connecter({ ...session, siteUrl: phase.profil.siteUrl });
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
          if (deuxFacteurs !== undefined && memeMethode) setMessage(t('connexion.codeRefuse'));
        } else if (
          e instanceof ErreurRest &&
          (e.erreur === 'totp-invalid' || e.errorType === 'totp-invalid')
        ) {
          // Même dualité error/errorType que `totp-required` : voir lib/rest.ts.
          setMessage(t('connexion.codeRefuse'));
        } else if (e instanceof ErreurRest && e.statut === 401) {
          setMessage(t('connexion.identifiantsRefuses'));
        } else {
          setMessage(e instanceof Error ? e.message : t('connexion.connexionImpossible'));
        }
      } finally {
        enVol.current = false;
        setOccupe(false);
      }
    },
    [phase, utilisateur, motDePasse, connecter, routeur, t],
  );

  const validerCode = useCallback(async () => {
    if (phase.nom !== 'deuxFacteurs' || code.trim() === '') return;
    try {
      const prepare = await preparerCodeDeuxFacteurs(phase.erreur, code, hacher);
      await tenterConnexion(prepare);
    } catch (e) {
      // Un `hacher` qui échoue ne doit pas rendre le bouton muet.
      setMessage(e instanceof Error ? e.message : t('connexion.preparationCodeImpossible'));
    }
  }, [phase, code, tenterConnexion, t]);

  const envoyerCodeEmail = useCallback(async () => {
    if (enVol.current || phase.nom !== 'deuxFacteurs') return;
    enVol.current = true;
    setOccupe(true);
    setMessage(null);
    try {
      await demanderCodeParEmail(phase.client, utilisateur.trim());
      setPhase({ ...phase, codeEnvoye: true });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : t('connexion.envoiCodeImpossible'));
    } finally {
      enVol.current = false;
      setOccupe(false);
    }
  }, [phase, utilisateur, t]);

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
      <Stack.Screen options={{ headerShown: routeChangement, title: t('connexion.titre') }} />
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
              etiquette={t('connexion.adresseServeur')}
              icone="🌐"
              valeur={adresse}
              onChangeText={setAdresse}
              onSubmitEditing={validerServeur}
              keyboardType="url"
              inputMode="url"
              placeholder="chat.exemple.fr"
              autoComplete="url"
            />
            <BoutonPrincipal c={c} occupe={occupe} onPress={() => void validerServeur()} titre={t('connexion.continuer')} />

            {serveursConnus.length > 0 && (
              <View style={[styles.carte, { backgroundColor: c.carteProfonde, borderColor: c.bordure }]}>
                <Text style={[styles.surtitre, { color: c.attenue }]}>{t('connexion.serveursConnus')}</Text>
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
              etiquette={t('connexion.identifiantOuEmail')}
              valeur={utilisateur}
              onChangeText={setUtilisateur}
              placeholder={t('connexion.exempleIdentifiant')}
              autoComplete="username"
              autoFocus
            />
            <ChampPilule
              c={c}
              etiquette={t('connexion.motDePasse')}
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
              titre={t('connexion.seConnecter')}
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
              <Text style={[styles.aide, { color: c.texteErreur }]}>{t('connexion.aideReseau')}</Text>
            )}
          </View>
        )}

        {phase.nom !== 'serveur' && (
          <Pressable onPress={revenirAuServeur} disabled={occupe}>
            <Text style={[styles.lien, { color: c.cyan }]}>{t('connexion.changerServeur')}</Text>
          </Pressable>
        )}
      </ScrollView>
    </VueEvitantLeClavier>
  );
}

/** En-tête de la marque : licorne, barres arc-en-ciel, logotype, sous-titre. */
function EnTeteMarque({ c }: { c: Couleurs }) {
  const t = useT();
  return (
    <View style={styles.marque}>
      <Text style={styles.licorne}>🦄</Text>
      <View style={styles.barres}>
        {[c.accent, c.jaune, c.cyan, c.violet].map((couleur, i) => (
          <View key={i} style={[styles.barre, { backgroundColor: couleur }]} />
        ))}
      </View>
      <Marque c={c} />
      <Text style={[styles.sousTitre, { color: c.attenue }]}>{t('connexion.slogan')}</Text>
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
  const t = useT();
  return (
    <Pressable onPress={onRetour} disabled={occupe} style={styles.retour} hitSlop={10}>
      <Text style={[styles.chevron, { color: c.violet }]}>‹</Text>
      <Text style={[styles.retourTitre, { color: c.texte }]}>{t('connexion.titre')}</Text>
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
  const t = useT();
  if (erreur.methode === 'email' && !codeEnvoye) {
    // `codeGenerated: false` : aucun code n'est encore parti, il faut le
    // demander explicitement avant d'afficher un champ de saisie.
    return (
      <>
        <BlasonDeuxFacteurs c={c} sousTitre={t('connexion.introEmail')} />
        <BoutonPrincipal c={c} occupe={occupe} onPress={onEnvoyerEmail} titre={t('connexion.envoyerLeCode')} />
      </>
    );
  }

  const etiquette =
    erreur.methode === 'totp'
      ? t('connexion.etiquetteTotp')
      : erreur.methode === 'email'
        ? t('connexion.etiquetteEmail')
        : t('connexion.etiquettePassword');

  return (
    <>
      <BlasonDeuxFacteurs
        c={c}
        sousTitre={
          erreur.methode === 'password'
            ? t('connexion.introPassword')
            : t('connexion.introTotp')
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
      <BoutonPrincipal c={c} occupe={occupe} onPress={onValider} titre={t('connexion.valider')} />
      {erreur.methode === 'email' && (
        <Pressable onPress={onEnvoyerEmail} disabled={occupe}>
          <Text style={[styles.lien, { color: c.cyan }]}>{t('connexion.renvoyerCode')}</Text>
        </Pressable>
      )}
    </>
  );
}

/** Blason « Vérification magique » : icône bouclier en dégradé + sous-titre. */
function BlasonDeuxFacteurs({ c, sousTitre }: { c: Couleurs; sousTitre: string }) {
  const t = useT();
  return (
    <View style={styles.blason}>
      <TuileAvatar
        c={c}
        deg={[c.violet, c.cyan] as const}
        taille={70}
        rayon={22}
        enfant={<Text style={styles.bouclierGlyphe}>🛡️</Text>}
      />
      <Text style={[styles.blasonTitre, { color: c.texte }]}>{t('connexion.verificationMagique')}</Text>
      <Text style={[styles.blasonSousTitre, { color: c.attenue }]}>{sousTitre}</Text>
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
