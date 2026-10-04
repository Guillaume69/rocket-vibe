import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_SERVER } from '../db/migrate.ts';
import { requestEmailCode, prepareTwoFactorCode, logIn } from '../lib/auth.ts';
import { ClientRest, TwoFactorError, RestError, type TwoFactorCode } from '../lib/rest.ts';
import { probeServer, type ServerProfile } from '../lib/server.ts';
import { hash, readLastServer, listKnownServers } from '../lib/sessionStore.ts';
import { KeyboardAvoidingContainer } from '../ui/keyboard.tsx';
import { useT } from '../ui/i18n.ts';
import { PrimaryButton, PillField, Brand, AvatarTile } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { type Colors, FONTS, useColors } from '../ui/theme.ts';

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
  | { name: 'server' }
  | { name: 'credentials'; profile: ServerProfile; client: ClientRest }
  | {
      name: 'twoFactor';
      profile: ServerProfile;
      client: ClientRest;
      error: TwoFactorError;
      codeSent: boolean;
    };

export default function LoginScreen() {
  const { state: etat, connect: connecter, switchServer: changerDeServeur } = useSession();
  const { change: changer } = useLocalSearchParams<{ change?: string }>();
  const routeur = useRouter();
  const c = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>({ name: 'server' });
  const [adresse, setAdresse] = useState(DEFAULT_SERVER);
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
    readLastServer()
      .then((dernier) => {
        if (!abandonne && dernier !== null) {
          setAdresse((courante) => (courante === DEFAULT_SERVER ? dernier : courante));
        }
      })
      .catch(() => {});
    listKnownServers()
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
          setPhase({ name: 'server' });
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
      const profil = await probeServer(adresse, controleur.signal);
      if (controleur.signal.aborted) return;
      if (!profil.loginForm) {
        // `Accounts_ShowFormLogin = false` : le serveur ne propose que du SSO.
        // L'API accepte parfois quand même un login direct — on prévient sans
        // bloquer.
        setMessage(t('connexion.sansMotDePasse'));
      }
      setPhase({ name: 'credentials', profile: profil, client: new ClientRest(profil.baseUrl) });
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
    async (deuxFacteurs?: TwoFactorCode) => {
      if (enVol.current || phase.name === 'server') return;
      enVol.current = true;
      setOccupe(true);
      setMessage(null);
      try {
        const session = await logIn(
          phase.client,
          { user: utilisateur.trim(), password: motDePasse },
          deuxFacteurs,
        );
        // `Site_Url` vient du sondage, pas du login : c'est ICI qu'il entre
        // dans la session persistée — voir `Session.siteUrl` (lib/auth.ts).
        await connecter({ ...session, siteUrl: phase.profile.siteUrl });
        // Navigation explicite : le <Redirect> en tête de rendu couvre la
        // reprise de session, mais il est neutralisé quand on est venu par
        // « changer de serveur » (`?changer=1`) — sans ceci, un login réussi
        // depuis ce chemin laisserait l'utilisateur planté ici.
        routeur.replace('/');
      } catch (e) {
        if (e instanceof TwoFactorError) {
          // Le serveur veut un second facteur — ou refuse celui qu'on vient
          // d'envoyer, auquel cas il relève la même erreur.
          const memeMethode = phase.name === 'twoFactor' && phase.error.method === e.method;
          setCode('');
          setPhase({
            name: 'twoFactor',
            profile: phase.profile,
            client: phase.client,
            error: e,
            // Un code email déjà parti ne « repart » pas parce que le serveur
            // relève l'erreur avec `codeGenerated: false` (renvoi limité).
            codeSent: e.generatedCode || (memeMethode && phase.codeSent),
          });
          if (deuxFacteurs !== undefined && memeMethode) setMessage(t('connexion.codeRefuse'));
        } else if (
          e instanceof RestError &&
          (e.error === 'totp-invalid' || e.errorType === 'totp-invalid')
        ) {
          // Même dualité error/errorType que `totp-required` : voir lib/rest.ts.
          setMessage(t('connexion.codeRefuse'));
        } else if (e instanceof RestError && e.status === 401) {
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
    if (phase.name !== 'twoFactor' || code.trim() === '') return;
    try {
      const prepare = await prepareTwoFactorCode(phase.error, code, hash);
      await tenterConnexion(prepare);
    } catch (e) {
      // Un `hacher` qui échoue ne doit pas rendre le bouton muet.
      setMessage(e instanceof Error ? e.message : t('connexion.preparationCodeImpossible'));
    }
  }, [phase, code, tenterConnexion, t]);

  const envoyerCodeEmail = useCallback(async () => {
    if (enVol.current || phase.name !== 'twoFactor') return;
    enVol.current = true;
    setOccupe(true);
    setMessage(null);
    try {
      await requestEmailCode(phase.client, utilisateur.trim());
      setPhase({ ...phase, codeSent: true });
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
    setPhase({ name: 'server' });
  }, []);

  // Déjà connecté (reprise au démarrage, ou login qui vient d'aboutir) : cet
  // écran n'a rien à montrer — SAUF si on vient exprès changer de serveur.
  if (etat.phase === 'connected' && changer !== '1') return <Redirect href="/" />;

  const surServeur = phase.name === 'server';
  // Route « changer de serveur » (poussée depuis l'accueil) : on GARDE l'en-tête
  // natif — son bouton retour est la seule sortie vers l'app, et il porte le
  // titre accessible. Le login racine, lui, reste sans en-tête (logo plein).
  const routeChangement = changer === '1';

  return (
    <KeyboardAvoidingContainer>
      <Stack.Screen options={{ headerShown: routeChangement, title: t('connexion.titre') }} />
      <CielEtoile c={c} />
      <ScrollView
        contentContainerStyle={[
          styles.content,
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
          <RetourConnexion c={c} onBack={revenirAuServeur} busy={occupe} />
        )}

        {phase.name !== 'server' && (
          <View style={[styles.chipServeur, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[styles.chipTexte, { color: c.dimmed }]}>
              {phase.client.baseUrl} · Rocket.Chat {phase.profile.version}
            </Text>
          </View>
        )}

        {phase.name === 'server' && (
          <>
            <PillField
              c={c}
              label={t('connexion.adresseServeur')}
              icon="🌐"
              value={adresse}
              onChangeText={setAdresse}
              onSubmitEditing={validerServeur}
              keyboardType="url"
              inputMode="url"
              placeholder="chat.exemple.fr"
              autoComplete="url"
            />
            <PrimaryButton c={c} busy={occupe} onPress={() => void validerServeur()} title={t('connexion.continuer')} />

            {serveursConnus.length > 0 && (
              <View style={[styles.card, { backgroundColor: c.deepCard, borderColor: c.border }]}>
                <Text style={[styles.surtitre, { color: c.dimmed }]}>{t('connexion.serveursConnus')}</Text>
                {serveursConnus.map((url) => (
                  <Pressable key={url} onPress={() => void basculer(url)} disabled={occupe}>
                    <Text style={[styles.lienServeur, { color: c.cyan }]}>{url}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        )}

        {phase.name === 'credentials' && (
          <>
            <PillField
              c={c}
              label={t('connexion.identifiantOuEmail')}
              value={utilisateur}
              onChangeText={setUtilisateur}
              placeholder={t('connexion.exempleIdentifiant')}
              autoComplete="username"
              autoFocus
            />
            <PillField
              c={c}
              label={t('connexion.motDePasse')}
              value={motDePasse}
              onChangeText={setMotDePasse}
              onSubmitEditing={() => void tenterConnexion()}
              placeholder="••••••••"
              autoComplete="current-password"
              secureTextEntry
            />
            <PrimaryButton
              c={c}
              busy={occupe}
              onPress={() => void tenterConnexion()}
              title={t('connexion.seConnecter')}
            />
          </>
        )}

        {phase.name === 'twoFactor' && (
          <SectionDeuxFacteurs
            c={c}
            error={phase.error}
            codeSent={phase.codeSent}
            code={code}
            busy={occupe}
            onChangeCode={setCode}
            onSubmit={() => void validerCode()}
            onSendEmail={() => void envoyerCodeEmail()}
          />
        )}

        {message !== null && (
          <View style={[styles.card, { backgroundColor: c.errorCard, borderColor: c.danger }]}>
            <Text style={[styles.errorMessage, { color: c.errorText }]}>{message}</Text>
            {phase.name === 'server' && Platform.OS === 'android' && (
              <Text style={[styles.help, { color: c.errorText }]}>{t('connexion.aideReseau')}</Text>
            )}
          </View>
        )}

        {phase.name !== 'server' && (
          <Pressable onPress={revenirAuServeur} disabled={occupe}>
            <Text style={[styles.link, { color: c.cyan }]}>{t('connexion.changerServeur')}</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingContainer>
  );
}

/** En-tête de la marque : licorne, barres arc-en-ciel, logotype, sous-titre. */
function EnTeteMarque({ c }: { c: Colors }) {
  const t = useT();
  return (
    <View style={styles.marque}>
      <Text style={styles.licorne}>🦄</Text>
      <View style={styles.bars}>
        {[c.accent, c.yellow, c.cyan, c.purple].map((couleur, i) => (
          <View key={i} style={[styles.bar, { backgroundColor: couleur }]} />
        ))}
      </View>
      <Brand c={c} />
      <Text style={[styles.subtitle, { color: c.dimmed }]}>{t('connexion.slogan')}</Text>
    </View>
  );
}

/** Retour vers l'étape serveur, en tête des phases identifiants / 2FA. */
function RetourConnexion({
  c,
  onBack: onRetour,
  busy: occupe,
}: {
  c: Colors;
  onBack: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <Pressable onPress={onRetour} disabled={occupe} style={styles.back} hitSlop={10}>
      <Text style={[styles.chevron, { color: c.purple }]}>‹</Text>
      <Text style={[styles.retourTitre, { color: c.text }]}>{t('connexion.titre')}</Text>
    </Pressable>
  );
}

function SectionDeuxFacteurs({
  c,
  error: erreur,
  codeSent: codeEnvoye,
  code,
  busy: occupe,
  onChangeCode,
  onSubmit: onValider,
  onSendEmail: onEnvoyerEmail,
}: {
  c: Colors;
  error: TwoFactorError;
  codeSent: boolean;
  code: string;
  busy: boolean;
  onChangeCode: (v: string) => void;
  onSubmit: () => void;
  onSendEmail: () => void;
}) {
  const t = useT();
  if (erreur.method === 'email' && !codeEnvoye) {
    // `codeGenerated: false` : aucun code n'est encore parti, il faut le
    // demander explicitement avant d'afficher un champ de saisie.
    return (
      <>
        <BlasonDeuxFacteurs c={c} subtitle={t('connexion.introEmail')} />
        <PrimaryButton c={c} busy={occupe} onPress={onEnvoyerEmail} title={t('connexion.envoyerLeCode')} />
      </>
    );
  }

  const etiquette =
    erreur.method === 'totp'
      ? t('connexion.etiquetteTotp')
      : erreur.method === 'email'
        ? t('connexion.etiquetteEmail')
        : t('connexion.etiquettePassword');

  return (
    <>
      <BlasonDeuxFacteurs
        c={c}
        subtitle={
          erreur.method === 'password'
            ? t('connexion.introPassword')
            : t('connexion.introTotp')
        }
      />
      <PillField
        c={c}
        label={etiquette}
        value={code}
        large={erreur.method !== 'password'}
        onChangeText={onChangeCode}
        onSubmitEditing={onValider}
        placeholder={erreur.method === 'password' ? '••••••••' : '123456'}
        keyboardType={erreur.method === 'password' ? 'default' : 'number-pad'}
        autoComplete={erreur.method === 'password' ? 'current-password' : 'one-time-code'}
        secureTextEntry={erreur.method === 'password'}
        autoFocus
      />
      <PrimaryButton c={c} busy={occupe} onPress={onValider} title={t('connexion.valider')} />
      {erreur.method === 'email' && (
        <Pressable onPress={onEnvoyerEmail} disabled={occupe}>
          <Text style={[styles.link, { color: c.cyan }]}>{t('connexion.renvoyerCode')}</Text>
        </Pressable>
      )}
    </>
  );
}

/** Blason « Vérification magique » : icône bouclier en dégradé + sous-titre. */
function BlasonDeuxFacteurs({ c, subtitle: sousTitre }: { c: Colors; subtitle: string }) {
  const t = useT();
  return (
    <View style={styles.blason}>
      <AvatarTile
        c={c}
        deg={[c.purple, c.cyan] as const}
        size={70}
        radius={22}
        child={<Text style={styles.bouclierGlyphe}>🛡️</Text>}
      />
      <Text style={[styles.blasonTitre, { color: c.text }]}>{t('connexion.verificationMagique')}</Text>
      <Text style={[styles.blasonSousTitre, { color: c.dimmed }]}>{sousTitre}</Text>
    </View>
  );
}

/**
 * Ciel étoilé décoratif, en fond d'écran. Purement ornemental. `memo` car `c`
 * est stable (palette forcée) : inutile de le re-rendre à chaque frappe.
 */
const CielEtoile = memo(function CielEtoile({ c }: { c: Colors }) {
  const etoiles: { top: number; left: number; size: number; color: string; opacity: number }[] = [
    { top: 90, left: 44, size: 10, color: '#FFFFFF', opacity: 0.5 },
    { top: 150, left: 300, size: 12, color: c.yellow, opacity: 0.7 },
    { top: 250, left: 70, size: 9, color: c.cyan, opacity: 0.6 },
    { top: 330, left: 320, size: 11, color: '#FFFFFF', opacity: 0.4 },
    { top: 470, left: 40, size: 10, color: c.purple, opacity: 0.55 },
    { top: 560, left: 280, size: 9, color: c.cyan, opacity: 0.4 },
    { top: 640, left: 120, size: 8, color: '#FFFFFF', opacity: 0.35 },
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
            fontSize: e.size,
            color: e.color,
            opacity: e.opacity,
          }}
        >
          ✦
        </Text>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: 26, paddingBottom: 32, gap: 16 },
  marque: { alignItems: 'center', gap: 4, marginBottom: 10 },
  licorne: { fontSize: 46, lineHeight: 52 },
  bars: { flexDirection: 'row', gap: 5, marginVertical: 8 },
  bar: { width: 26, height: 5, borderRadius: 3 },
  subtitle: { fontFamily: FONTS.body, fontSize: 13, marginTop: 2 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  chevron: { fontSize: 26, fontFamily: FONTS.title },
  retourTitre: { fontFamily: FONTS.title, fontSize: 17 },
  chipServeur: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  chipTexte: { fontFamily: FONTS.corpsSemi, fontSize: 12.5 },
  blason: { alignItems: 'center', gap: 4, marginTop: 6, marginBottom: 4 },
  bouclierGlyphe: { fontSize: 34 },
  blasonTitre: { fontFamily: FONTS.title, fontSize: 21, marginTop: 12 },
  blasonSousTitre: { fontFamily: FONTS.body, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 9 },
  surtitre: { fontFamily: FONTS.corpsFort, fontSize: 11.5, letterSpacing: 0.4, textTransform: 'uppercase' },
  lienServeur: { fontFamily: FONTS.corpsGras, fontSize: 14, paddingVertical: 3 },
  errorMessage: { fontFamily: FONTS.corpsGras, fontSize: 14 },
  help: { fontFamily: FONTS.body, fontSize: 13, lineHeight: 18 },
  link: { fontFamily: FONTS.corpsGras, fontSize: 14, paddingVertical: 12, textAlign: 'center' },
});
