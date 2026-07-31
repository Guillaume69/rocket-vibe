import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { useRequeteVive } from '../../ui/requeteVive.ts';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BaseLocale } from '../../db/client.ts';
import type { DepotBrouillons } from '../../db/depot.ts';
import { abonnements, messages, salons, sortie, televersements } from '../../db/schema.ts';
import type { MoteurActivite } from '../../lib/activite.ts';
import { demarrerConference, sonderAppelDisponible } from '../../lib/appel.ts';
import { citer } from '../../lib/citation.ts';
import type { CandidatMention } from '../../lib/completionMention.ts';
import type {
  ActionsFournisseur,
  Listener,
  Outbox,
  OutboxFichiers,
} from '../../lib/fournisseur.ts';
import { versEpoch } from '../../lib/normaliser.ts';
import { ouvrirFicheProfil } from '../../lib/profilPreload.ts';
import { rattraperSalon } from '../../lib/rattrapage.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { MoteurSaisie, phraseSaisie } from '../../lib/saisie.ts';
import { useActivite } from '../../ui/activite.ts';
import { ApercuPieceJointe, type FichierEnAttente } from '../../ui/apercuPieceJointe.tsx';
import { BandeauReponse } from '../../ui/bandeauReponse.tsx';
import { useBrouillon } from '../../ui/brouillons.ts';
import { estRejetArbreDeVues, lancerSelecteurAvecReprise } from '../../ui/lancerSelecteur.ts';
import { annulerReponse, useReponse } from '../../ui/reponse.ts';
import { supprimerSiTemporaire } from '../../ui/fichiersTemporaires.ts';
import { compresserImageSiUtile } from '../../ui/preparerPieceJointe.ts';
import { useProgressionFichiers } from '../../ui/progressionFichiers.ts';
import { demanderSource, feuilleEstMontee } from '../../ui/sourcePieceJointe.ts';
import { VueEvitantLeClavier } from '../../ui/clavier.tsx';
import { BandeauCompletionEmoji, useCompletionEmoji } from '../../ui/completionEmoji.tsx';
import { BandeauCompletionMention, useCandidatsMention } from '../../ui/completionMention.tsx';
import { NavigateurEmoji, usePanneauEmoji } from '../../ui/navigateurEmoji.tsx';
import { useRetourMateriel } from '../../ui/retourMateriel.ts';
import { jetonSession } from '../../ui/jetonSession.ts';
import { garderAuChaud, salonCouvert } from '../../ui/salonChaud.ts';
import { marquerSalonCharge, salonChargeSous } from '../../ui/salonsCharges.ts';
import {
  AvatarSalon,
  BarreSynchro,
  BoutonPrincipal,
  IndicateurSaisie,
  TuileAvatar,
} from '../../ui/kit.tsx';
import { memeOrigine, origineDe } from '../../lib/origine.ts';
import { MoteurSynchro, STREAM_MESSAGES, STREAM_NOTIFY_ROOM } from '../../lib/sync.ts';
import { LigneMessage, type LigneDeMessage } from '../../ui/ligneMessage.tsx';
import type { StatutPresence } from '../../lib/presence.ts';
import { COULEURS_PRESENCE, usePresence } from '../../ui/presence.ts';
import { useT } from '../../ui/i18n.ts';
import type { CleTraduction } from '../../ui/messages.ts';
import { useSession } from '../../ui/session.tsx';
import { useSynchro } from '../../ui/synchro.tsx';
import { useE2EDeverrouille } from '../../ui/e2e.ts';
import { type Couleurs, POLICES, useCouleurs } from '../../ui/theme.ts';

/**
 * Écran d'un salon — **lecture seule** à cette étape ; l'envoi arrive en 4.5.
 *
 * La liste projette SQLite (`useLiveQuery`), le réseau écrit dans SQLite :
 * l'historique REST initial et le stream DDP convergent dans les mêmes
 * upserts idempotents.
 *
 * **Liste INVERSÉE, mVCP coupé** (idiome duogo, adopté en 8.10) : le plus
 * récent est en `data[0]`, à l'offset natif 0 = le bas visuel. Le bas reste
 * collé au composer PAR CONSTRUCTION, même quand le clavier anime la hauteur
 * du conteneur frame par frame — aucune compensation JS. L'ancien montage
 * (données croissantes + `startRenderingFromBottom` +
 * `autoscrollToBottomThreshold`) recalait le défilement en JS après coup :
 * liste visiblement décorrélée du composer pendant l'animation du clavier,
 * constaté sur le Pixel. `maintainVisibleContentPosition` est DÉSACTIVÉ :
 * à l'offset 0, un prepend s'affiche de lui-même, et le recalage natif du
 * mVCP partait avant nos effets et écrasait le snap manuel (cicatrice
 * duogo). Suivi des entrants : `scrollToOffset(0)` si le message est de moi
 * ou si on est près du bas. COMPROMIS assumé, le même que duogo : remonté
 * dans l'historique, pas de snap, mais un prepend décale quand même le
 * contenu de sa hauteur — c'est ce que le mVCP corrigerait — et le lissage
 * de 200 ms groupe les rafales en un seul décalage.
 * La requête `DESC LIMIT n` alimente la liste TELLE QUELLE — l'inversion
 * visuelle est native, plus de `reverse()` ; le passé se charge par
 * `onEndReached` (la fin des DONNÉES est le haut visuel).
 */

const PAGE = 50;
/** Sous ce défilement (px depuis le bas), un entrant nous ramène au bas. */
const PRES_DU_BAS_PX = 120;

/** Regroupe la rafale d'entrants avant de marquer lu. */
const DEBOUNCE_LU_MS = 1_500;
/**
 * Cadence PLANCHER de `marquerLu` : le débounce seul ne borne que l'écart entre
 * deux appels, pas leur nombre — un message toutes les 2 s produisait 30
 * `subscriptions.read` par minute sur une route limitée à 10/min, et chaque 429
 * coûtait à `lib/rest.ts` jusqu'à trois siestes de 30 s pour un travail
 * idempotent. Rien n'est perdu à espacer : l'appel marque tout lu jusqu'à
 * MAINTENANT, le suivant englobe les précédents.
 */
const PLANCHER_LU_MS = 10_000;

type LigneDeSalon = typeof salons.$inferSelect;

/** Sous-titre d'en-tête d'un DM, selon la présence du correspondant. Clés de
 *  traduction (constante module → pas de hook) résolues au rendu. */
const PHRASE_PRESENCE: Record<StatutPresence, CleTraduction> = {
  online: 'salon.presenceOnline',
  away: 'salon.presenceAway',
  busy: 'salon.presenceBusy',
  offline: 'salon.presenceOffline',
};

export default function EcranSalon() {
  // `host` vient du deep-link d'une notification (natif comme expo) : il dit de
  // QUEL serveur ce message parle. Absent pour toute navigation interne — le
  // comportement est alors exactement celui d'avant.
  const { rid, host } = useLocalSearchParams<{ rid: string; host?: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();

  // Ce garde est le pendant de celui d'index.tsx : un lien profond (le tap
  // sur une notification, étape 6.2) peut atterrir ici sans session.
  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  if (synchro.phase === 'erreur') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{synchro.message}</Text>
      </View>
    );
  }

  if (typeof rid !== 'string' || synchro.phase !== 'pret' || etat.phase !== 'connecte') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }

  // Notification d'un AUTRE serveur que celui affiché. Les sessions coexistent
  // (`changerDeServeur` n'en efface aucune) et le jeton push est enregistré sur
  // chacune : les deux serveurs poussent. Sans ce garde, on tombait dans le
  // salon avec un rid que la base locale ne connaît pas — `type === undefined`
  // court-circuite l'effet de chargement, `premierPassageFini` reste faux, et
  // l'écran garde son indicateur d'activité POUR TOUJOURS.
  //
  // On travaille sur l'ORIGINE, pas sur la chaîne reçue : elle vient d'un intent
  // que n'importe quelle app peut émettre. Ce qui n'est pas une URL web n'est
  // pas un serveur Rocket.Chat — on l'ignore, et le comportement redevient
  // exactement celui d'avant plutôt que d'afficher au premier plan un texte
  // arbitraire de longueur arbitraire.
  const origineHote = typeof host === 'string' ? origineDe(host) : null;
  if (origineHote !== null && !memeOrigine(host!, etat.session.baseUrl)) {
    return <AutreServeur c={c} hote={origineHote} rid={rid} />;
  }

  return (
    <Salon
      c={c}
      rid={rid}
      base={synchro.base}
      brouillons={synchro.brouillons}
      moteur={synchro.moteur}
      envoi={synchro.envoi}
      fichiers={synchro.fichiers}
      ddp={synchro.ddp}
      actions={synchro.actions}
      client={etat.client}
      moi={etat.session.username}
      declarerSalonOuvert={synchro.declarerSalonOuvert}
      activite={synchro.activite}
      generation={synchro.generation}
    />
  );
}

/**
 * Le message pointé par la notification vit sur un autre serveur que celui
 * affiché. On ne bascule PAS tout seul : `changerDeServeur` déplace le pointeur
 * de reprise, ferme la socket, rouvre une autre base — un tap sur une
 * notification ne doit pas emporter ça sans qu'on le demande. Geste explicite,
 * donc, et le libellé dit où l'on va.
 */
function AutreServeur({ c, hote, rid }: { c: Couleurs; hote: string; rid: string }) {
  const t = useT();
  const routeur = useRouter();
  const { changerDeServeur } = useSession();
  const [occupe, setOccupe] = useState(false);
  const [echec, setEchec] = useState(false);

  const basculer = useCallback(() => {
    setOccupe(true);
    setEchec(false);
    changerDeServeur(hote).then(
      (ok) => {
        // Succès : `replace` retire le `host` de l'URL. Le laisser rejouerait ce
        // même écran si l'utilisateur repassait plus tard sur l'autre serveur.
        // Aucun `setState` sur ce chemin : l'écran est déjà en train de partir.
        if (ok) routeur.replace({ pathname: '/salon/[rid]', params: { rid } });
        else {
          setOccupe(false);
          setEchec(true);
        }
      },
      () => {
        setOccupe(false);
        setEchec(true);
      },
    );
  }, [changerDeServeur, hote, rid, routeur]);

  return (
    <View style={[styles.centre, { backgroundColor: c.fond }]}>
      <Stack.Screen options={{ title: t('salon.autreServeurTitre') }} />
      <Text style={[styles.erreur, { color: c.texte }]}>{t('salon.autreServeurTitre')}</Text>
      <Text style={[styles.autreServeurHote, { color: c.texteSecondaire }]}>
        {t('salon.autreServeurCorps', { hote })}
      </Text>
      <BoutonPrincipal
        c={c}
        titre={t('salon.autreServeurBouton')}
        onPress={basculer}
        occupe={occupe}
        style={styles.autreServeurBouton}
      />
      {echec ? (
        <Text style={[styles.autreServeurHote, { color: c.texteErreur }]}>
          {t('salon.autreServeurEchec')}
        </Text>
      ) : null}
    </View>
  );
}

function Salon({
  c,
  rid,
  base,
  brouillons,
  moteur,
  envoi,
  fichiers,
  ddp,
  actions,
  client,
  moi,
  declarerSalonOuvert,
  activite,
  generation,
}: {
  c: Couleurs;
  rid: string;
  base: BaseLocale;
  brouillons: DepotBrouillons;
  moteur: MoteurSynchro;
  envoi: Outbox;
  fichiers: OutboxFichiers;
  ddp: Listener;
  actions: ActionsFournisseur;
  client: ClientRest;
  /** Mon username — ma propre saisie ne s'affiche pas chez moi. */
  moi: string;
  declarerSalonOuvert: (rid: string) => () => void;
  activite: MoteurActivite;
  generation: number;
}) {
  const t = useT();
  const [limite, setLimite] = useState(PAGE);
  // Tant que le premier passage d'historique n'est pas retombé, une base
  // vide signifie « chargement », pas « salon vide ».
  // Un salon déjà chargé sous cette génération n'a pas de premier passage à
  // attendre : sans cet état initial, sauter le fetch laisserait « chargement »
  // affiché à vie (rien ne viendrait plus poser le drapeau).
  const [premierPassageFini, setPremierPassageFini] = useState(() =>
    salonChargeSous(rid, generation),
  );

  const { data: lignesSalon } = useRequeteVive(
    base.select().from(salons).where(eq(salons.rid, rid)).limit(1),
    [rid],
  );
  const salon = lignesSalon?.[0];
  const insets = useSafeAreaInsets();
  // Sous-titre d'en-tête HONNÊTE : le nombre de membres en ligne n'est pas dans
  // le schéma, mais la présence du correspondant d'un DM, si — sinon, rien.
  const statutDM = usePresence(salon?.dmAutreUid ?? null);

  const { data: brutes } = useRequeteVive(
    base
      .select()
      .from(messages)
      // Une réponse de fil vit dans SON fil, pas dans le flux principal —
      // sauf si l'expéditeur a coché « aussi dans le salon » (`tshow`).
      .where(
        and(eq(messages.rid, rid), or(isNull(messages.filId), eq(messages.filAffiche, true))),
      )
      // Clé secondaire `id` : deux messages à la MÊME milliseconde (rafale de
      // bot, intégration) n'ont sinon aucun ordre défini — SQLite les rend dans
      // l'ordre d'INSERTION (rowid), qui diffère selon le chemin de chargement.
      // La pagination d'historique insère le plus récent d'abord : une telle
      // paire s'affichait alors À L'ENVERS après un rechargement. Départager par
      // `id` rend l'ordre DÉTERMINISTE, identique quel que soit le chargement.
      // (Rocket.Chat n'expose aucun signal sous la milliseconde : l'ordre exact
      // d'un vrai ex æquo reste indécidable, mais au moins il est stable.)
      .orderBy(desc(messages.horodatage), desc(messages.id))
      .limit(limite),
    [rid, limite],
  );
  // Statuts d'envoi (en-attente / échec) : table séparée, requête vive
  // séparée — même raison que la liste des salons, `useLiveQuery` n'écoute
  // que la table du FROM.
  const { data: lignesSortie } = useRequeteVive(
    base.select().from(sortie).where(eq(sortie.rid, rid)),
    [rid],
  );
  // TOUS les téléversements de ce salon, quel que soit leur statut.
  //
  // Le filtre `statut === 'echec'` d'avant laissait un trou béant : un fichier
  // envoyé hors ligne reste `en-attente`, `envoyer()` résout normalement — donc
  // l'aperçu, le brouillon et la citation se vident — et l'écran ne montrait
  // RIEN. La photo disparaissait sans le moindre signe ; l'utilisateur la
  // renvoyait, il en avait deux.
  const { data: lignesTeleversements } = useRequeteVive(
    base.select().from(televersements).where(eq(televersements.rid, rid)),
    [rid],
  );
  const fichiersEnCours = lignesTeleversements ?? [];
  // La fraction d'avancement ne vit qu'en mémoire du moteur : aucune écriture
  // SQLite ne la porte, donc `useRequeteVive` ne la verrait jamais bouger.
  const progressions = useProgressionFichiers(fichiers);
  // Les décisions (pagination) se prennent sur la valeur FRAÎCHE ; seul
  // l'affichage est lissé.
  const fraiches = useMemo(() => brutes ?? [], [brutes]);
  // Lissage des entrants (200 ms) : à l'offset 0, l'inversion absorbe les
  // prepends nativement, mais une rafale re-rendrait l'écran à chaque
  // écriture — et REMONTÉ dans l'historique, chaque prepend décale le
  // contenu de sa hauteur (mVCP coupé, voir l'en-tête) : autant grouper la
  // rafale en un seul décalage. On lisse la projection, pas la base.
  const donnees = useDonneesLissees(fraiches, 200);

  // Non-lus (8.1). La barre « nouveaux messages » se place sur un INSTANTANÉ
  // de `ls` pris au montage : si elle suivait la valeur vive, le
  // `subscriptions.read` qui suit l'effacerait avant qu'on l'ait vue.
  const [luJusquA, setLuJusquA] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let annule = false;
    base
      .select()
      .from(abonnements)
      .where(eq(abonnements.rid, rid))
      .limit(1)
      .then((lignes) => {
        if (!annule) setLuJusquA(lignes[0]?.luJusquA ?? null);
      })
      .catch(() => {
        if (!annule) setLuJusquA(null);
      });
    return () => {
      annule = true;
    };
  }, [base, rid]);

  // Marquer lu : à l'ouverture, puis à chaque nouvel entrant écran ouvert.
  // Débounce (regrouper la rafale) + PLANCHER de cadence (voir PLANCHER_LU_MS).
  //
  // Un appel déjà programmé ABSORBE les entrants suivants au lieu d'être
  // réarmé : `subscriptions.read` marque tout lu jusqu'à maintenant, donc
  // l'appel en attente couvre ce qui arrive d'ici son départ — et un timer
  // qu'on ne repousse jamais ne peut pas être affamé par un flot continu
  // (l'ancien débounce réarmé à chaque entrant, PIRE que la cadence : sous un
  // message/seconde il ne partait JAMAIS).
  const dernierIdRecu = fraiches[0]?.id;
  const luProgramme = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dernierLu = useRef(0);
  useEffect(() => {
    if (dernierIdRecu === undefined) return;
    if (luProgramme.current !== null) return;
    const restant = dernierLu.current + PLANCHER_LU_MS - Date.now();
    luProgramme.current = setTimeout(() => {
      luProgramme.current = null;
      dernierLu.current = Date.now();
      actions.marquerLu(rid).catch(() => {});
    }, Math.max(DEBOUNCE_LU_MS, restant));
  }, [actions, rid, dernierIdRecu]);

  // L'appel EN ATTENTE part tout de suite quand l'écran se ferme ou que l'app
  // passe en arrière-plan : différé par le plancher, il serait sinon perdu (le
  // démontage l'annule, l'arrière-plan gèle les timers JS) et le salon
  // resterait « non lu » sur les autres appareils. Rien en attente → rien à
  // envoyer : la sortie d'un salon déjà marqué ne coûte aucune requête.
  const flusherLu = useCallback(() => {
    if (luProgramme.current === null) return;
    clearTimeout(luProgramme.current);
    luProgramme.current = null;
    dernierLu.current = Date.now();
    actions.marquerLu(rid).catch(() => {});
  }, [actions, rid]);
  useEffect(() => {
    const abonnement = AppState.addEventListener('change', (suivant) => {
      if (suivant !== 'active') flusherLu();
    });
    return () => {
      abonnement.remove();
      flusherLu();
    };
  }, [flusherLu]);

  // Les données de la liste, avec la barre insérée au-dessus (visuellement)
  // du premier message d'AUTRUI postérieur à `ls`. Données DESC : ce message
  // est la DERNIÈRE occurrence qui satisfait le prédicat, et « au-dessus »
  // est l'index SUIVANT — la liste inversée rend l'index i+1 au-dessus de i.
  type LigneListe = LigneDeMessage | { barre: true; id: string };
  const donneesAvecBarre = useMemo<LigneListe[]>(() => {
    if (typeof luJusquA !== 'number') return donnees;
    const moiUid = client.identifiants?.userId;
    let premierNonLu = -1;
    for (let i = 0; i < donnees.length; i++) {
      const m = donnees[i];
      if (m.horodatage > luJusquA && m.auteurId !== moiUid) premierNonLu = i;
    }
    if (premierNonLu === -1) return donnees;
    return [
      ...donnees.slice(0, premierNonLu + 1),
      { barre: true, id: 'barre-nouveaux' },
      ...donnees.slice(premierNonLu + 1),
    ];
  }, [donnees, luJusquA, client]);

  // Suivi des entrants (idiome duogo) : à l'offset 0, un nouveau `data[0]`
  // s'affiche tout seul — natif. Légèrement remonté, on snappe au bas si le
  // message est de moi ou qu'on était près du bas ; en pleine lecture
  // d'historique, on ne bouge pas. Refs : le défilement ne re-rend rien.
  const liste = useRef<FlashListRef<LigneListe>>(null);
  const presDuBas = useRef(true);
  const dernierSuivi = useRef<{ id: string; horodatage: number } | null>(null);
  const surDefilement = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    presDuBas.current = e.nativeEvent.contentOffset.y <= PRES_DU_BAS_PX;
  }, []);
  const plusRecent = donnees[0];
  useEffect(() => {
    if (plusRecent === undefined || dernierSuivi.current?.id === plusRecent.id) return;
    const precedent = dernierSuivi.current;
    dernierSuivi.current = { id: plusRecent.id, horodatage: plusRecent.horodatage };
    // Premier remplissage : la liste inversée naît déjà calée en bas.
    if (precedent === null) return;
    // Un head PLUS ANCIEN que le précédent n'est pas un entrant : c'est la
    // SUPPRESSION du plus récent (stream deleteMessage, abandon d'un envoi).
    // Snapper là-dessus arracherait le lecteur à l'historique.
    if (plusRecent.horodatage < precedent.horodatage) return;
    const deMoi = plusRecent.auteurId === client.identifiants?.userId;
    if (deMoi || presDuBas.current) {
      liste.current?.scrollToOffset({ offset: 0, animated: true });
    }
  }, [plusRecent, client]);

  // La génération au moment de la SORTIE, lue par le cleanup. En dépendance de
  // l'effet ci-dessous, elle le rejouerait à chaque raccordement — pour rien,
  // les souscriptions désirées étant déjà rejouées par le client DDP.
  const generationRef = useRef(generation);
  useEffect(() => {
    generationRef.current = generation;
  }, [generation]);

  // `sub` à l'ouverture. `souscrire` est synchrone et indépendant de l'état du
  // transport : demandé trop tôt (lien profond au démarrage), le stream
  // s'établit tout seul à l'authentification.
  //
  // À la SORTIE, on ne relâche PAS : on confie les références à `salonChaud`,
  // qui garde le salon écouté. Couper l'écoute ouvrait un trou que seule une
  // lecture pouvait combler — et cette lecture coûte 3 s sur un gros salon,
  // barre de synchro allumée, pour n'annoncer aucun changement. Voir
  // `ui/salonChaud.ts` : les références sont comptées, garder la nôtre n'envoie
  // aucune `sub` de plus.
  useEffect(() => {
    // Capturé ICI, avec les souscriptions : c'est la session à laquelle ces
    // références appartiennent. Le provider peut être démonté AVANT cet
    // écran — son cleanup court en premier — et les relâcheurs pointeraient
    // alors sur un client déjà rangé. Voir `ui/jetonSession.ts`.
    const jeton = jetonSession();
    const relachers = [
      ddp.souscrire(STREAM_MESSAGES, rid),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/user-activity`),
    ];
    // Le rattrapage (`chat.syncMessages`, un salon à la fois) vise le salon
    // que l'utilisateur regarde : on se déclare, et on rend la déclaration en
    // partant — jamais un `null` global, qui effacerait l'écran salon resté
    // dessous quand on dépile celui du dessus.
    const rendreDeclaration = declarerSalonOuvert(rid);
    return () => {
      rendreDeclaration();
      garderAuChaud(rid, generationRef.current, relachers, jeton);
    };
  }, [ddp, rid, declarerSalonOuvert]);

  // Indicateur de saisie (8.6) : volatil, propre à l'écran — écoute seule,
  // voir lib/saisie.ts pour l'écart consigné sur l'émission.
  const saisie = useMemo(() => new MoteurSaisie({ rid, moi }), [rid, moi]);
  useEffect(() => {
    const detacher = ddp.surEvenement((evenement) => saisie.appliquer(evenement));
    return () => {
      detacher();
      saisie.arreter();
    };
  }, [ddp, saisie]);
  const quiTape = useSyncExternalStore(
    useCallback((relire) => saisie.surChangement(relire), [saisie]),
    useCallback(() => saisie.quiTape(), [saisie]),
  );
  const phraseQuiTape = phraseSaisie(quiTape);

  // Brouillon persistant (8.7) — le hook vit ICI : le composer ne monte
  // qu'une fois la valeur initiale lue.
  const persistance = useBrouillon(brouillons, rid);

  // Candidats à la mention (@) : le hook vit ICI, où `base` est en scope — le
  // composer reçoit la liste toute prête, comme le brouillon.
  const candidatsMention = useCandidatsMention(base, rid);

  const chargerHistorique = useCallback(
    async (type: string, latest?: string): Promise<{ plusAncien: number | null }> => {
      const reponse = await client.get<{ messages?: Record<string, unknown>[] }>(
        cheminHistorique(type),
        {
          // `inclusive` : deux messages peuvent partager la même milliseconde.
          // Sans lui, le jumeau du message-borne serait un trou permanent dans
          // l'historique. Les upserts idempotents absorbent le recouvrement.
          // `showThreadMessages: false` — EXPLICITE bien que ce soit le défaut
          // vérifié sur 8.5 : le filtre serveur (tmid absent OU tshow) doit
          // rester identique au filtre local du flux, sinon une page entière
          // de réponses masquées ferait boucler la pagination keyset sur
          // place (le `latest` vient de la liste FILTRÉE).
          params: { roomId: rid, count: PAGE, latest, inclusive: true, showThreadMessages: false },
        },
      );
      const lot = reponse.messages ?? [];
      const recent = await moteur.ingererMessages(lot);
      // Le plus ancien `ts` de la page : c'est LUI qui dit à `chargerPlus` si
      // la page a vraiment reculé dans le passé (voir le critère là-bas).
      let plusAncien: number | null = null;
      for (const brut of lot) {
        const ts = versEpoch((brut as { ts?: unknown }).ts);
        if (ts !== null && (plusAncien === null || ts < plusAncien)) plusAncien = ts;
      }
      // Le curseur de rattrapage du salon NAÎT ici — et RIEN DE PLUS. Sans lui,
      // `rattraperSalon` no-ope à vie (`depuis === null`) ; avec, il reprend la
      // pagination par curseur là où elle en est.
      //
      // Il ne se RÉ-ANCRE plus à chaque ouverture. Ce saut en avant n'existait
      // que pour garder minuscule la fenêtre d'un `chat.syncMessages?lastUpdate=`
      // non borné, au prix des éditions et suppressions de l'intervalle sauté.
      // Depuis que le rattrapage pagine par curseur et se plafonne lui-même
      // (`lib/rattrapage.ts`), la fenêtre n'a plus besoin d'être petite : le
      // curseur peut redevenir honnête.
      if (recent !== null) {
        const existant = await moteur.depotSynchro.lireCurseur(rid, 'messages');
        if (existant === null) {
          await moteur.depotSynchro.ecrireCurseur(rid, 'messages', recent);
        }
      }
      return { plusAncien };
    },
    [client, moteur, rid],
  );

  // Ouverture du salon. Deux travaux de nature différente, et un seul est
  // conditionnel.
  //
  // 1. `rattraperSalon` part TOUJOURS. C'est lui qui couvre le trou : en sortant
  //    du salon on se désabonne de ses streams (voir plus haut), donc le cache
  //    d'un salon fermé n'est plus tenu à jour par le temps réel. Sa pagination
  //    par curseur reprend exactement où elle en était, et ne coûte que ~92
  //    octets quand rien n'a bougé. Il porte aussi les suppressions
  //    (`type=DELETED`), que l'historique ne peut PAS voir : un message effacé
  //    côté serveur est simplement absent de la page, sa ligne locale resterait
  //    en fantôme à vie — et `chat.delete` dessus répond « No message found ».
  //    Tir-et-oublie : chaque page est bornée, l'ouverture n'attend rien.
  //
  // 2. L'historique complet (les 50 derniers) ne se rejoue QUE si ce salon n'a
  //    pas déjà été chargé sous cette génération de connexion. L'écran étant
  //    démonté à la sortie, un `useRef` de garde ne survivait pas : ressortir et
  //    rentrer refaisait 31 Ko et ré-ingérait 50 messages identiques, barre de
  //    synchro allumée — pur gaspillage. Le critère est causal, pas temporel :
  //    `generation` change à chaque raccordement, donc une coupure, même brève,
  //    fait retomber la garde (le trou peut être de n'importe quelle taille,
  //    au-delà de ce que les 100 messages de `rattraperSalon` couvrent).
  //    Voir `ui/salonsCharges.ts`.
  const type = salon?.type;
  useEffect(() => {
    if (type === undefined) return;
    let annule = false;
    const jeton = jetonSession();
    // Rattrapage SAUTÉ quand le salon est resté écouté sans interruption : rien
    // n'a pu être manqué, et la lecture coûterait plusieurs secondes pour zéro
    // document sur un gros salon.
    if (!salonCouvert(rid, generation)) {
      void activite
        .suivre(rid, rattraperSalon(client, moteur, rid, () => annule))
        .catch((e: unknown) => console.warn('rattraperSalon (ouverture): échec ignoré', e));
    }

    if (salonChargeSous(rid, generation)) {
      return () => {
        annule = true;
      };
    }
    // Enveloppé dans `activite` : l'en-tête allume sa barre de synchro le temps
    // du fetch, même quand le cache local remplit déjà la liste (rien ne
    // signalait sinon qu'on la rafraîchit).
    activite
      .suivre(rid, chargerHistorique(type))
      .then(() => {
        // Marqué au SUCCÈS seulement. Un échec (hors ligne) laisse la garde
        // ouverte : la prochaine génération refera partir le chargement.
        if (!annule) marquerSalonCharge(rid, generation, jeton);
      })
      .catch((e: unknown) => {
        // Hors ligne : le cache local suffit. Mais pas en silence — un échec
        // systématique ici a déjà masqué un vrai bug.
        console.warn('salon: historique initial échoué', e);
      })
      .finally(() => {
        if (!annule) setPremierPassageFini(true);
      });
    return () => {
      annule = true;
    };
  }, [type, chargerHistorique, generation, activite, rid, client, moteur]);

  // Remonter vers le passé : élargir la fenêtre locale, et si elle est déjà
  // épuisée, demander la page plus ancienne au serveur (pagination keyset sur
  // `latest`, jamais d'offset).
  const enVol = useRef(false);
  // `onEndReached` (FlashList v2) se réarme à CHAQUE changement de data, pas
  // seulement au défilement : passé épuisé et utilisateur garé au haut
  // visuel, chaque entrant redemanderait la même page vide au REST
  // rate-limité. Ce verrou s'arme à la première page vide et ne se relâche
  // plus — le passé d'un salon ne repousse pas.
  const passeEpuise = useRef(false);
  // Filet : si le message-borne n'a pas changé après deux pages consécutives,
  // la pagination n'avance plus — quoi qu'en dise le contenu des réponses.
  const bornePrecedente = useRef<{ id: string; pages: number } | null>(null);
  const chargerPlus = useCallback(() => {
    const epuise = fraiches.length < limite;
    if (!epuise) {
      setLimite((l) => l + PAGE);
      return;
    }
    if (passeEpuise.current || enVol.current || type === undefined || fraiches.length === 0) {
      return;
    }
    const plusVieux = fraiches[fraiches.length - 1];
    const borne = bornePrecedente.current;
    bornePrecedente.current =
      borne !== null && borne.id === plusVieux.id
        ? { id: plusVieux.id, pages: borne.pages + 1 }
        : { id: plusVieux.id, pages: 1 };
    if (bornePrecedente.current.pages > 2) {
      passeEpuise.current = true;
      console.warn(`salon ${rid}: pagination immobile sur ${plusVieux.id}, passé déclaré épuisé`);
      return;
    }
    enVol.current = true;
    chargerHistorique(type, new Date(plusVieux.horodatage).toISOString())
      .then(({ plusAncien }) => {
        // Il reste du passé si la page a VRAIMENT reculé : un message
        // strictement plus ancien que la borne. Compter (`n > 1`) ne le
        // prouvait pas — `inclusive: true` renvoie la borne ET tous ses
        // jumeaux de la même milliseconde (rafale de bot, import), donc un
        // groupe d'ex æquo en queue d'historique gardait `n > 1` pour
        // toujours : `passeEpuise` jamais armé, la ré-ingestion faisait
        // changer `data`, `onEndReached` (FlashList v2) se réarmait, et la
        // boucle s'auto-entretenait jusqu'au 429.
        if (plusAncien !== null && plusAncien < plusVieux.horodatage) {
          setLimite((l) => l + PAGE);
        } else {
          passeEpuise.current = true;
        }
      })
      .catch((e: unknown) => console.warn('salon: page d’historique échouée', e))
      .finally(() => {
        enVol.current = false;
      });
  }, [fraiches, limite, type, chargerHistorique, rid]);

  const routeur = useRouter();
  const ouvrirActions = useCallback(
    (id: string) => {
      // « Pop » à l'ouverture de la feuille — confirme que l'appui long a pris.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      routeur.push({ pathname: '/actions-message', params: { id } });
    },
    [routeur],
  );
  const ouvrirFil = useCallback(
    (id: string) => {
      routeur.push({ pathname: '/fil/[id]', params: { id } });
    },
    [routeur],
  );

  const reessayer = useCallback(() => {
    envoi.traiter().catch(() => {});
  }, [envoi]);
  const abandonner = useCallback(
    (id: string) => {
      envoi.abandonner(id).catch(() => {});
    },
    [envoi],
  );
  // Tir-et-oublie : l'écho du stream réécrit `messages.reactions`, et la
  // requête vive re-rend la pastille — pas d'état optimiste à tenir ici.
  const reagir = useCallback(
    (ridMessage: string, id: string, code: string, mettre: boolean) => {
      actions.reagir(ridMessage, id, code, mettre).catch(() => {});
    },
    [actions],
  );

  const sortieParId = useMemo(
    () => new Map((lignesSortie ?? []).map((s) => [s.id, s])),
    [lignesSortie],
  );
  const rendreLigne = useCallback(
    ({ item }: { item: LigneListe }) => {
      if ('barre' in item) {
        return (
          <View style={styles.barreNouveaux}>
            <View style={[styles.traitNouveaux, { backgroundColor: c.accent }]} />
            <Text style={[styles.texteNouveaux, { color: c.accent }]}>{t('salon.nouveauxMessages')}</Text>
            <View style={[styles.traitNouveaux, { backgroundColor: c.accent }]} />
          </View>
        );
      }
      const etatEnvoi = sortieParId.get(item.id);
      return (
        <LigneMessage
          c={c}
          message={item}
          client={client}
          statutEnvoi={etatEnvoi?.statut ?? null}
          surReessayer={etatEnvoi?.statut === 'echec' ? reessayer : null}
          surAbandonner={etatEnvoi?.statut === 'echec' ? abandonner : null}
          // Pas d'actions sur une ligne d'outbox : son `_id` client n'a pas
          // été accepté par le serveur — `chat.delete`/`chat.update` dessus ne
          // peuvent qu'échouer. Ses vraies actions sont réessayer/abandonner.
          surAppuiLong={etatEnvoi === undefined ? ouvrirActions : null}
          surOuvrirFil={ouvrirFil}
          moi={moi}
          surReagir={etatEnvoi === undefined ? reagir : null}
        />
      );
    },
    [c, client, sortieParId, reessayer, abandonner, ouvrirActions, ouvrirFil, t, moi, reagir],
  );

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ headerShown: false }} />
      <EnTeteSalon
        c={c}
        rid={rid}
        salon={salon}
        client={client}
        statutDM={statutDM}
        insetTop={insets.top}
        // Repli si le salon est la RACINE (deep-link à froid) : `back()` n'a
        // alors aucune cible et laisserait l'utilisateur coincé.
        onRetour={() => (routeur.canGoBack() ? routeur.back() : routeur.replace('/'))}
        onRecherche={() => routeur.push({ pathname: '/recherche-messages', params: { rid } })}
      />
      {donneesAvecBarre.length === 0 ? (
        // Vide : indicateur, puis mention explicite. (L'ancien piège mVCP
        // « viewport sous le contenu » a disparu avec l'inversion ; attendre
        // le premier lot reste la bonne UX — une liste qui clignote non.)
        <View style={styles.centre}>
          {premierPassageFini ? (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('salon.aucunMessage')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={liste}
          inverted
          data={donneesAvecBarre}
          // Coupé : à l'offset 0, un prepend s'affiche de lui-même, et le
          // recalage natif partait avant le snap JS et l'écrasait.
          maintainVisibleContentPosition={{ disabled: true }}
          keyExtractor={(m) => m.id}
          // Contenu HÉTÉROGÈNE (messages + barre de non-lus) : sans type
          // d'item, le recyclage de FlashList mélange les gabarits.
          getItemType={(item) => ('barre' in item ? 'barre' : 'message')}
          renderItem={rendreLigne}
          onScroll={surDefilement}
          scrollEventThrottle={16}
          // Inversé : la fin des DONNÉES est le haut visuel — le passé.
          onEndReached={chargerPlus}
          onEndReachedThreshold={0.4}
          contentContainerStyle={styles.contenu}
        />
      )}
      {fichiersEnCours.map((tele) => {
        const enEchec = tele.statut === 'echec';
        const libelle = enEchec
          ? t('salon.fichierNonEnvoye', { nom: tele.nom })
          : tele.statut === 'envoi'
            ? t('salon.fichierEnvoi', {
                nom: tele.nom,
                pourcent: String(Math.round((progressions.get(tele.id) ?? 0) * 100)),
              })
            : t('salon.fichierEnAttente', { nom: tele.nom });
        return (
          <View key={tele.id} style={styles.bandeEchecFichier}>
            <Text
              style={[styles.heure, { color: enEchec ? c.texteErreur : c.attenue }]}
              numberOfLines={1}
            >
              {libelle}
            </Text>
            {/* « Réessayer » n'a de sens que sur un échec — et il lui faut
                l'id : le rejeu automatique ne voit plus les lignes en échec,
                un simple `traiter()` passerait à côté. Une ligne `en-attente`
                ou `envoi`, elle, part déjà toute seule. */}
            {enEchec && (
              <Pressable onPress={() => void fichiers.reessayer(tele.id)}>
                <Text style={[styles.heure, { color: c.accent }]}>{t('salon.reessayer')}</Text>
              </Pressable>
            )}
            <Pressable onPress={() => void fichiers.abandonner(tele.id, tele.uri)}>
              <Text style={[styles.heure, { color: c.attenue }]}>{t('salon.abandonner')}</Text>
            </Pressable>
          </View>
        );
      })}
      {/* Une réponse de FIL refusée n'a aucune ligne dans ce flux (filtrée par
          fil_id) : sans ce bandeau, son échec ne serait visible qu'en
          rouvrant le fil exact — silencieusement jamais, en pratique. */}
      {(lignesSortie ?? [])
        .filter((s) => s.statut === 'echec' && s.filId !== null)
        .map((s) => (
          <View key={s.id} style={styles.bandeEchecFichier}>
            <Pressable
              style={styles.plein}
              onPress={() => routeur.push({ pathname: '/fil/[id]', params: { id: s.filId ?? '' } })}
            >
              <Text style={[styles.heure, { color: c.texteErreur }]} numberOfLines={1}>
                {t('salon.reponseFilNonEnvoyee')}
              </Text>
            </Pressable>
            <Pressable onPress={reessayer}>
              <Text style={[styles.heure, { color: c.accent }]}>{t('salon.reessayer')}</Text>
            </Pressable>
            <Pressable onPress={() => abandonner(s.id)}>
              <Text style={[styles.heure, { color: c.attenue }]}>{t('salon.abandonner')}</Text>
            </Pressable>
          </View>
        ))}
      {/* Indicateur de saisie EN FLUX, juste au-dessus du composer : sa hauteur
          s'ouvre par un ressort (voir `IndicateurSaisie`) et, la liste étant
          `flex: 1`, ce gain comprime la liste et fait remonter nativement le
          dernier message au lieu de le masquer. Replié à 0, aucune bande morte. */}
      <View style={styles.basComposer}>
        <IndicateurSaisie c={c} phrase={phraseQuiTape} />
        {/* Tant que la ligne du salon n'est pas là (lien profond vers un salon
            pas encore synchronisé), on ne promet pas un envoi : `chiffre` et
            `lectureSeule` sont peut-être vrais. */}
        {/* `key={rid}` + attente du brouillon chargé : le composer naît avec
            son état initial déjà juste — ni restauration après coup, ni fuite
            du texte d'un salon vers un autre. */}
        {salon !== undefined && persistance.initial !== null && (
          <Composer
            key={rid}
            c={c}
            rid={rid}
            envoi={envoi}
            fichiers={fichiers}
            client={client}
            candidatsMention={candidatsMention}
            lectureSeule={salon.lectureSeule}
            chiffre={salon.chiffre}
            brouillonInitial={persistance.initial}
            sauverBrouillon={persistance.sauver}
            effacerBrouillon={persistance.effacer}
          />
        )}
      </View>
    </VueEvitantLeClavier>
  );
}

/** Média d'`expo-image-picker` → pièce en attente normalisée. */
function assetVersFichier(a: ImagePicker.ImagePickerAsset): FichierEnAttente {
  const estVideo = a.type === 'video';
  return {
    uri: a.uri,
    nom: a.fileName ?? a.uri.split('/').pop() ?? `piece-${Date.now()}.${estVideo ? 'mp4' : 'jpg'}`,
    type: a.mimeType ?? (estVideo ? 'video/mp4' : 'image/jpeg'),
    taille: a.fileSize ?? null,
  };
}

function Composer({
  c,
  rid,
  envoi,
  fichiers,
  client,
  candidatsMention,
  lectureSeule,
  chiffre,
  brouillonInitial,
  sauverBrouillon,
  effacerBrouillon,
}: {
  c: Couleurs;
  rid: string;
  envoi: Outbox;
  fichiers: OutboxFichiers;
  /** Avatars des suggestions de mention. */
  client: ClientRest;
  /** Auteurs récents du salon (`useCandidatsMention`), calculés par le parent. */
  candidatsMention: CandidatMention[];
  lectureSeule: boolean;
  chiffre: boolean;
  /** Brouillon restauré (8.7) — le parent attend sa lecture avant de monter. */
  brouillonInitial: string;
  sauverBrouillon: (texte: string) => void;
  effacerBrouillon: () => void;
}) {
  const [brouillon, setBrouillon] = useState(brouillonInitial);
  // Le texte COURANT, lisible depuis une continuation asynchrone. Un
  // téléversement prend des secondes et le champ reste éditable pendant tout ce
  // temps (seuls 📎/➤/🎤 sont grisés) : à la fin de l'envoi, il faut pouvoir
  // distinguer « le champ porte encore la légende partie » de « l'utilisateur a
  // continué à composer ». La closure de `envoyer` ne voit que le texte de
  // l'appui, elle ne peut pas répondre à cette question.
  const brouillonRef = useRef(brouillon);
  useEffect(() => {
    brouillonRef.current = brouillon;
  }, [brouillon]);
  const [envoiFichier, setEnvoiFichier] = useState(false);
  const [erreurFichier, setErreurFichier] = useState<string | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  // Pièce jointe en attente d'envoi (image, audio, ou tout fichier) : elle se
  // pose au-dessus du composer, on lui ajoute une légende, puis on l'envoie —
  // au lieu de partir dès le choix (7.x). Une seule à la fois.
  const [enAttente, setEnAttente] = useState<FichierEnAttente | null>(null);
  // `.m4a` AAC (préréglage HIGH_QUALITY) — le MIME attendu est `audio/mp4`.
  const enregistreur = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const routeur = useRouter();
  const t = useT();

  // Autocomplétion des emojis : curseur + insertion, mécanique partagée avec le
  // composer du fil (`useCompletionEmoji`).
  const { curseur, selection, surSelection, choisirEmoji, insererAuCurseur, reinitialiser } =
    useCompletionEmoji(brouillon, setBrouillon, sauverBrouillon);

  // Navigateur d'emojis : un panneau qui prend la place du clavier. Le bouton
  // 😀 bascule de l'un à l'autre ; toucher le champ rouvre le clavier (onFocus).
  const champRef = useRef<TextInput>(null);
  const emoji = usePanneauEmoji(champRef);
  const { fermer: fermerEmoji } = emoji;

  // Le back retire l'aperçu en attente au lieu de quitter le salon — sinon on
  // perd le salon ET la pièce jointe préparée.
  // Retirer l'aperçu efface AUSSI le fichier : aucune ligne de téléversement
  // ne l'a jamais connu, donc le ménage de la file ne l'atteindrait jamais.
  // `supprimerSiTemporaire` ne touche que le cache de l'app — jamais la photo
  // que l'utilisateur a désignée en place.
  // L'effacement est HORS de l'updater : React peut rejouer un updater, et une
  // suppression de fichier n'est pas rejouable.
  const retirerEnAttente = useCallback(() => {
    if (enAttente !== null) void supprimerSiTemporaire(enAttente.uri);
    setEnAttente(null);
  }, [enAttente]);
  useRetourMateriel(enAttente !== null, retirerEnAttente);

  // Cible de réponse (citation), armée par la feuille d'actions (appui long →
  // Répondre). Déclaré APRÈS le gestionnaire de pièce jointe : inscrit en
  // dernier, le back referme d'abord le bandeau de réponse.
  const reponse = useReponse(rid);
  const annulerCitation = useCallback(() => annulerReponse(rid), [rid]);
  useRetourMateriel(reponse !== null, annulerCitation);
  // La feuille se referme sur la cible armée : le clavier s'ouvre sur le champ,
  // prêt pour la réponse.
  useEffect(() => {
    if (reponse !== null) champRef.current?.focus();
  }, [reponse]);

  const changerBrouillon = useCallback(
    (texte: string) => {
      setBrouillon(texte);
      sauverBrouillon(texte);
    },
    [sauverBrouillon],
  );

  const envoyer = useCallback(() => {
    const legende = brouillon.trim();
    // Une citation armée préfixe le texte de son permalien `[ ](…)` — le
    // serveur en fera la pièce jointe de citation (lib/citation.ts).
    const texteAEnvoyer = reponse === null ? legende : citer(reponse.permalien, legende);
    // Une pièce jointe en attente part AVEC la légende, en un seul message.
    if (enAttente !== null) {
      setErreurFichier(null);
      setEnvoiFichier(true);
      // `fichiers.envoyer` valide (taille/type), persiste l'intention puis
      // téléverse ; il ne REJETTE que sur un refus de validation. Tout le
      // reste — refus serveur ET réseau injoignable — devient une ligne du
      // bandeau ci-dessus, désormais affichée QUEL QUE SOIT son statut : un
      // envoi hors ligne reste `en-attente` et n'aurait été visible nulle part.
      // On ne vide donc l'aperçu qu'au succès, sinon le fichier serait perdu.
      fichiers
        .envoyer(rid, enAttente, texteAEnvoyer || undefined)
        .then(() => {
          setEnAttente(null);
          // La citation, elle, a été CONSOMMÉE par le message qui vient de
          // partir — son permalien est dans `texteAEnvoyer`, calculé avant
          // l'appel. La désarmer sans condition : sous la garde ci-dessous,
          // elle resterait armée et le message SUIVANT re-citerait la même
          // cible sans qu'on l'ait demandé.
          annulerReponse(rid);
          // Le reste ne se solde que si le champ n'a pas bougé depuis l'appui :
          // ce qui a été tapé pendant le téléversement n'est ni la légende
          // partie, ni à jeter (correctif de 8.7, perdu en 30e1c85 au profit
          // d'un vidage sec). `effacerBrouillon()` détruit en plus la ligne
          // persistée — le texte ne serait pas même récupérable au retour dans
          // le salon.
          if (brouillonRef.current === brouillon) {
            setBrouillon('');
            reinitialiser();
            effacerBrouillon();
          }
        })
        .catch((e: unknown) =>
          setErreurFichier(e instanceof Error ? e.message : t('salon.televersementImpossible')),
        )
        .finally(() => setEnvoiFichier(false));
      return;
    }
    if (legende === '') return;
    setBrouillon('');
    reinitialiser();
    effacerBrouillon();
    // L'aperçu optimiste de la citation : la version du serveur, qui porte les
    // vraies pièces jointes reconstruites du permalien, l'écrasera.
    const jointesLocales = reponse === null ? null : reponse.jointeLocale;
    annulerReponse(rid);
    // L'affichage optimiste et la persistance de l'intention sont dans
    // `envoyer` : d'ici, rien à attendre. Un refus deviendra un statut
    // « échec » actionnable sur la ligne elle-même.
    envoi
      .envoyer(rid, texteAEnvoyer, null, jointesLocales)
      .catch((e: unknown) => console.warn('envoi: échec local', e));
  }, [brouillon, enAttente, envoi, fichiers, rid, reponse, effacerBrouillon, reinitialiser, t]);

  const basculerVocal = useCallback(async () => {
    setErreurFichier(null);
    try {
      if (!enregistrement) {
        const permission = await AudioModule.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          setErreurFichier(t('salon.microRefuse'));
          return;
        }
        await enregistreur.prepareToRecordAsync();
        enregistreur.record();
        setEnregistrement(true);
        return;
      }
      setEnregistrement(false);
      await enregistreur.stop();
      const uri = enregistreur.uri;
      if (uri === null) {
        setErreurFichier(t('salon.enregistrementVide'));
        return;
      }
      // On ne l'envoie plus tout de suite : le vocal se pose au-dessus du
      // composer (réécoutable), en attente d'une éventuelle légende et de l'envoi.
      setEnAttente({
        uri,
        nom: `vocal-${Date.now()}.m4a`,
        type: 'audio/mp4',
        taille: null,
      });
    } catch (e) {
      setEnregistrement(false);
      setErreurFichier(e instanceof Error ? e.message : t('salon.enregistrementImpossible'));
    }
  }, [enregistrement, enregistreur, t]);

  // Normalise un média/fichier choisi en pièce en attente : compression (7.3)
  // DÈS le choix — l'aperçu montre déjà ce qui partira (une photo repart en
  // JPEG raisonnable, inutile de pousser 12 Mpx pour un chat ; logique partagée
  // avec l'écran de partage) — puis on la pose au-dessus du composer, en
  // attente d'une légende. Validation (taille/type) et envoi arrivent au clic
  // sur « envoyer » (voir `envoyer`).
  const poserPieceJointe = useCallback(async (brut: FichierEnAttente) => {
    setEnvoiFichier(true);
    try {
      const pret = await compresserImageSiUtile(brut);
      // La compression a écrit un JPEG neuf : l'original copié par le picker
      // ne sert plus à rien. Et choisir une SECONDE pièce sans envoyer la
      // première abandonnait la sienne de la même façon.
      if (pret.uri !== brut.uri) void supprimerSiTemporaire(brut.uri);
      // Choisir une SECONDE pièce sans envoyer la première abandonnait la
      // sienne : aucune ligne SQL ne l'avait jamais connue.
      if (enAttente !== null && enAttente.uri !== pret.uri) {
        void supprimerSiTemporaire(enAttente.uri);
      }
      setEnAttente(pret);
    } finally {
      setEnvoiFichier(false);
    }
  }, [enAttente]);

  // Referme la feuille « joindre », restée ouverte pendant le sélecteur. Le
  // garde n'est pas décoratif : sans lui, si l'usager a balayé la feuille entre
  // temps, ce `back()` dépilerait le SALON.
  const fermerFeuilleJoindre = useCallback(() => {
    if (feuilleEstMontee()) routeur.back();
  }, [routeur]);

  const depuisCamera = useCallback(
    async (type: 'photo' | 'video') => {
      // Seule la caméra exige une permission ; le photo picker système et le
      // sélecteur de fichiers n'en demandent pas. Le dialogue de permission est
      // lui aussi une activité : il part donc, comme le reste, feuille ouverte.
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        fermerFeuilleJoindre();
        setErreurFichier(t('salon.cameraRefuse'));
        return;
      }
      const res = await lancerSelecteurAvecReprise(() =>
        ImagePicker.launchCameraAsync({
          mediaTypes: type === 'photo' ? ['images'] : ['videos'],
          quality: 1,
        }),
      );
      // On referme DÈS le retour du sélecteur, avant la compression : sinon la
      // feuille resterait affichée le temps de traiter une grosse photo.
      fermerFeuilleJoindre();
      if (!res.canceled) await poserPieceJointe(assetVersFichier(res.assets[0]));
    },
    [poserPieceJointe, fermerFeuilleJoindre, t],
  );

  const depuisBibliotheque = useCallback(async () => {
    const res = await lancerSelecteurAvecReprise(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 1,
      }),
    );
    fermerFeuilleJoindre();
    if (!res.canceled) await poserPieceJointe(assetVersFichier(res.assets[0]));
  }, [poserPieceJointe, fermerFeuilleJoindre]);

  const depuisFichier = useCallback(async () => {
    const choix = await lancerSelecteurAvecReprise(() =>
      DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }),
    );
    fermerFeuilleJoindre();
    if (choix.canceled || choix.assets.length === 0) return;
    const brut = choix.assets[0];
    await poserPieceJointe({
      uri: brut.uri,
      nom: brut.name,
      type: brut.mimeType ?? 'application/octet-stream',
      taille: brut.size ?? null,
    });
  }, [poserPieceJointe, fermerFeuilleJoindre]);

  // 📎 → menu de sources (feuille native), comme l'app officielle, au lieu
  // d'ouvrir directement le sélecteur de fichiers. La feuille renvoie la source
  // choisie via `demanderSource` SANS se fermer : on lance donc le sélecteur
  // pendant qu'elle est ouverte et immobile, seul moment où l'arbre de vues
  // Android est sûr (voir `ui/sourcePieceJointe.ts`). C'est `depuisX` qui la
  // referme, au retour du sélecteur.
  const joindre = useCallback(async () => {
    setErreurFichier(null);
    // Part d'un état de saisie stable : panneau emoji fermé et clavier baissé.
    // Un `TextInput` focalisé pendant le retour du sélecteur peut, lui aussi,
    // laisser une vue nulle sur le chemin de `dispatchCancelPendingInputEvents`.
    fermerEmoji();
    Keyboard.dismiss();
    const choix = demanderSource();
    routeur.push('/joindre');
    const source = await choix;
    if (source === null) return; // feuille fermée sans choix : déjà démontée
    try {
      if (source === 'photo') await depuisCamera('photo');
      else if (source === 'video') await depuisCamera('video');
      else if (source === 'bibliotheque') await depuisBibliotheque();
      else await depuisFichier();
    } catch (e) {
      // Le sélecteur n'est jamais parti : la feuille est encore là, et l'erreur
      // s'afficherait derrière elle. On la referme avant de la montrer.
      fermerFeuilleJoindre();
      // Le NPE d'arbre de vues n'a AUCUN sens pour qui le lit, et surtout il
      // appelle un geste précis : seul un redémarrage de l'app le solde (pas
      // même sortir du salon — vécu). On le dit, au lieu d'afficher la trace.
      setErreurFichier(
        estRejetArbreDeVues(e)
          ? t('salon.selecteurBloque')
          : e instanceof Error
            ? e.message
            : t('salon.selectionImpossible'),
      );
    }
  }, [routeur, depuisCamera, depuisBibliotheque, depuisFichier, fermerFeuilleJoindre, fermerEmoji, t]);

  // Salon chiffré : lecture désormais possible (E2EE, étape 10), mais PAS
  // l'envoi (le serveur rejette un clair, `error-not-allowed`). Verrouillé, on
  // propose de déverrouiller ; déverrouillé, on explique la lecture seule.
  if (chiffre) {
    return <ComposerChiffre c={c} />;
  }
  if (lectureSeule) {
    return (
      <View style={[styles.composer, { borderTopColor: c.bordureDouce }]}>
        <Text style={[styles.noteComposer, { color: c.attenue }]}>{t('salon.lectureSeule')}</Text>
      </View>
    );
  }

  const brouillonVide = brouillon.trim() === '';
  // Le bouton d'envoi remplace le micro dès qu'il y a un texte OU une pièce
  // jointe en attente — mais JAMAIS pendant l'enregistrement, où le bouton doit
  // rester « arrêter » (⏹), même si du texte a été tapé entre-temps.
  const montrerEnvoi = (!brouillonVide || enAttente !== null) && !enregistrement;

  return (
    <View>
      {erreurFichier !== null && (
        <Text style={[styles.erreurComposer, { color: c.texteErreur }]}>{erreurFichier}</Text>
      )}
      {/* Le buffer d'aperçu : la pièce jointe attend ici qu'on l'envoie. Son
          apparition pousse nativement le dernier message vers le haut. */}
      {enAttente !== null && (
        <ApercuPieceJointe
          c={c}
          fichier={enAttente}
          occupe={envoiFichier}
          onRetirer={() => setEnAttente(null)}
        />
      )}
      {reponse !== null && (
        <BandeauReponse c={c} cible={reponse} client={client} surAnnuler={annulerCitation} />
      )}
      {!emoji.ouvert && (
        <BandeauCompletionEmoji texte={brouillon} curseur={curseur} c={c} surChoisir={choisirEmoji} />
      )}
      {/* Jetons `:` et `@` mutuellement exclusifs : un seul bandeau à la fois. */}
      {!emoji.ouvert && (
        <BandeauCompletionMention
          texte={brouillon}
          curseur={curseur}
          candidats={candidatsMention}
          client={client}
          c={c}
          surChoisir={choisirEmoji}
        />
      )}
      <View style={[styles.composer, { borderTopColor: c.bordureDouce }]}>
        <Pressable
          onPress={() => void joindre()}
          // Une seule pièce jointe à la fois : pour en changer, on retire d'abord.
          disabled={envoiFichier || enregistrement || enAttente !== null}
          android_ripple={{ color: c.ondulation, borderless: true }}
          style={styles.boutonJoindre}
          accessibilityLabel={t('salon.joindreFichier')}
        >
          {envoiFichier ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : (
            <Text
              style={[styles.attache, (enregistrement || enAttente !== null) && styles.attacheInactif]}
            >
              📎
            </Text>
          )}
        </Pressable>
        <Pressable
          onPress={emoji.basculer}
          android_ripple={{ color: c.ondulation, borderless: true }}
          style={styles.boutonEmoji}
          accessibilityLabel={emoji.ouvert ? t('salon.revenirClavier') : t('salon.choisirEmoji')}
        >
          <Text style={styles.attache}>{emoji.ouvert ? '⌨️' : '😀'}</Text>
        </Pressable>
        <TextInput
          ref={champRef}
          value={brouillon}
          selection={selection}
          onChangeText={changerBrouillon}
          onSelectionChange={surSelection}
          // Toucher le champ referme le panneau : le clavier reprend sa place.
          onFocus={emoji.surFocus}
          placeholder={enAttente !== null ? t('salon.ajouterLegende') : t('salon.messagePlaceholder')}
          placeholderTextColor={c.texteTertiaire}
          multiline
          style={[styles.champComposer, { color: c.texte, backgroundColor: c.carte }]}
        />
        {montrerEnvoi ? (
          <Pressable
            onPress={envoyer}
            disabled={envoiFichier}
            style={({ pressed }) => ({ opacity: pressed || envoiFichier ? 0.7 : 1 })}
            accessibilityLabel={t('commun.envoyer')}
          >
            <TuileAvatar
              c={c}
              deg={[c.accent, c.violet] as const}
              taille={40}
              rayon={20}
              enfant={<Text style={[styles.rondGlyphe, { color: c.surAccent }]}>➤</Text>}
            />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void basculerVocal()}
            disabled={envoiFichier}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            accessibilityLabel={enregistrement ? t('salon.arreterEnregistrement') : t('salon.messageVocal')}
          >
            <TuileAvatar
              c={c}
              deg={enregistrement ? ([c.danger, c.danger] as const) : ([c.accent, c.violet] as const)}
              taille={40}
              rayon={20}
              enfant={<Text style={styles.rondGlyphe}>{enregistrement ? '⏹' : '🎤'}</Text>}
            />
          </Pressable>
        )}
      </View>
      {emoji.monte && (
        <NavigateurEmoji
          c={c}
          hauteur={emoji.hauteur}
          cible={emoji.cible}
          glisse={emoji.glisse}
          onChoisir={insererAuCurseur}
        />
      )}
    </View>
  );
}

/**
 * Zone composer d'un salon chiffré. Verrouillé : un bouton qui ouvre la feuille
 * de déverrouillage (les messages s'éclairent ensuite tout seuls). Déverrouillé :
 * une note de lecture seule — l'envoi chiffré n'est pas encore pris en charge.
 */
function ComposerChiffre({ c }: { c: Couleurs }) {
  const t = useT();
  const routeur = useRouter();
  const synchro = useSynchro();
  // Composer monté seulement en phase 'pret' (garde de l'écran) ; le hook
  // tolère null pour rester inconditionnel.
  const e2e = synchro.phase === 'pret' ? synchro.e2e : null;
  const deverrouille = useE2EDeverrouille(e2e);

  if (deverrouille) {
    return (
      <View style={[styles.composer, { borderTopColor: c.bordureDouce }]}>
        <Text style={[styles.noteComposer, { color: c.attenue }]}>{t('salon.chiffreLecture')}</Text>
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => routeur.push('/deverrouiller-e2e')}
      android_ripple={{ color: c.ondulation }}
      style={[styles.composer, { borderTopColor: c.bordureDouce }]}
      accessibilityRole="button"
      accessibilityLabel={t('salon.chiffreVerrouille')}
    >
      <Text style={[styles.noteComposer, { color: c.accent }]}>{t('salon.chiffreVerrouille')}</Text>
    </Pressable>
  );
}

/** En-tête du salon : retour, tuile, nom, présence du correspondant (DM), recherche. */
function EnTeteSalon({
  c,
  rid,
  salon,
  client,
  statutDM,
  insetTop,
  onRetour,
  onRecherche,
}: {
  c: Couleurs;
  rid: string;
  salon: LigneDeSalon | undefined;
  client: ClientRest;
  statutDM: StatutPresence | null;
  insetTop: number;
  onRetour: () => void;
  onRecherche: () => void;
}) {
  const nom = salon ? (salon.nomAffiche ?? salon.nom ?? salon.rid) : '…';
  const estDM = salon?.type === 'd';
  // Chargement de l'historique (ouverture) et rattrapage du salon (reconnexion)
  // allument la barre — même portée `rid` que le fetch enveloppé plus haut.
  const enSynchro = useActivite(rid);
  const routeur = useRouter();
  const t = useT();
  const synchro = useSynchro();
  const deverrouille = useE2EDeverrouille(synchro.phase === 'pret' ? synchro.e2e : null);

  // Disponibilité de la visioconférence : masque le bouton là où aucun
  // fournisseur n'est configuré (Docker local), l'affiche sur la cible (Jitsi).
  const [appelDispo, setAppelDispo] = useState(false);
  const [demarrage, setDemarrage] = useState(false);
  useEffect(() => {
    let vivant = true;
    void sonderAppelDisponible(client).then((ok) => {
      if (vivant) setAppelDispo(ok);
    });
    return () => {
      vivant = false;
    };
  }, [client]);

  const demarrerAppel = useCallback(() => {
    if (demarrage) return;
    setDemarrage(true);
    void (async () => {
      try {
        // `start` crée la conférence, poste le message d'appel dans le salon,
        // et renvoie le callId — l'écran d'appel s'occupe de `join` + WebView.
        const callId = await demarrerConference(client, rid);
        routeur.push({ pathname: '/appel/[callId]', params: { callId, titre: nom } });
      } catch {
        Alert.alert(t('salon.appelTitre'), t('salon.appelImpossibleDemarrer'));
      } finally {
        setDemarrage(false);
      }
    })();
  }, [demarrage, client, rid, routeur, nom, t]);

  return (
    <View style={[styles.entete, { paddingTop: insetTop + 6, borderBottomColor: c.bordureDouce }]}>
      <Pressable onPress={onRetour} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('salon.retour')}>
        <Text style={[styles.retour, { color: c.violet }]}>‹</Text>
      </Pressable>
      {/* Le nom (et l'avatar) ouvrent la fiche : celle de l'INTERLOCUTEUR pour
          un DM (visé par `dmAutreUid` — le `name` d'un DM est null localement),
          celle du salon sinon. */}
      <View style={styles.enveloppeEntete}>
        <Pressable
          onPress={() =>
            estDM && salon?.dmAutreUid != null
              ? void ouvrirFicheProfil({ uid: salon.dmAutreUid })
              : routeur.push({ pathname: '/salon-info', params: { rid } })
          }
          android_ripple={{ color: c.ondulation, borderless: false }}
          style={styles.enteteFiche}
          accessibilityRole="button"
          accessibilityLabel={t('salon.infosConversation')}
        >
        <AvatarSalon
          c={c}
          nom={nom}
          type={salon?.type}
          chiffre={salon?.chiffre ?? false}
          chiffreDeverrouille={deverrouille}
          rid={salon?.rid}
          dmAutreUid={salon?.dmAutreUid}
          avatarEtag={salon?.avatarEtag}
          client={client}
          taille={34}
          rayon={12}
        />
        <View style={styles.enteteBloc}>
          <Text style={[styles.enteteNom, { color: c.texte }]} numberOfLines={1}>
            {salon?.chiffre === true && <Text style={styles.badgeChiffreEntete}>🔒 </Text>}
            {nom}
          </Text>
          {estDM && statutDM !== null && (
            <Text
              style={[styles.enteteSous, { color: COULEURS_PRESENCE[statutDM] }]}
              numberOfLines={1}
            >
              {t(PHRASE_PRESENCE[statutDM])}
            </Text>
          )}
          </View>
        </Pressable>
      </View>
      {appelDispo && (
        <Pressable
          onPress={demarrerAppel}
          disabled={demarrage}
          hitSlop={8}
          android_ripple={{ color: c.ondulation, borderless: true }}
          accessibilityRole="button"
          accessibilityLabel={t('salon.demarrerAppel')}
          style={({ pressed }) => ({ opacity: pressed || demarrage ? 0.5 : 1 })}
        >
          <Text style={styles.iconeEntete}>📞</Text>
        </Pressable>
      )}
      <Pressable
        onPress={onRecherche}
        hitSlop={8}
        android_ripple={{ color: c.ondulation, borderless: true }}
      >
        <Text style={styles.iconeEntete}>🔍</Text>
      </Pressable>
      <BarreSynchro c={c} actif={enSynchro} />
    </View>
  );
}

function cheminHistorique(type: string): string {
  // Trois endpoints pour la même chose, selon le type du salon — héritage de
  // l'API Rocket.Chat. `l` (livechat) est hors périmètre.
  if (type === 'c') return 'channels.history';
  if (type === 'p') return 'groups.history';
  return 'im.history';
}

/** Throttle avant/arrière : la valeur suit, mais jamais plus vite que `delaiMs`. */
function useDonneesLissees<T>(valeur: T, delaiMs: number): T {
  const [lisse, setLisse] = useState(valeur);
  const dernierRendu = useRef(0);

  useEffect(() => {
    const ecoule = Date.now() - dernierRendu.current;
    if (ecoule >= delaiMs) {
      dernierRendu.current = Date.now();
      setLisse(valeur);
      return;
    }
    const minuterie = setTimeout(() => {
      dernierRendu.current = Date.now();
      setLisse(valeur);
    }, delaiMs - ecoule);
    return () => clearTimeout(minuterie);
  }, [valeur, delaiMs]);

  return lisse;
}

const styles = StyleSheet.create({
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { paddingHorizontal: 16, paddingVertical: 8 },
  heure: { fontSize: 11 },
  entete: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  retour: { fontFamily: POLICES.titre, fontSize: 26, paddingRight: 2 },
  // Reprend la géométrie qu'avaient avatar + bloc en enfants directs de
  // l'en-tête (ligne, même gap, extension) — le Pressable est transparent.
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. L'enveloppe porte le flex de l'en-tête.
  enveloppeEntete: { flex: 1, minWidth: 0, borderRadius: 12, overflow: 'hidden' },
  enteteFiche: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  enteteBloc: { flex: 1, minWidth: 0 },
  enteteNom: { fontFamily: POLICES.titre, fontSize: 16 },
  badgeChiffreEntete: { fontSize: 12 },
  enteteSous: { fontFamily: POLICES.corpsGras, fontSize: 11 },
  iconeEntete: { fontSize: 18, paddingHorizontal: 6 },
  basComposer: { position: 'relative' },
  vide: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: POLICES.corps },
  erreur: { fontFamily: POLICES.corpsGras, fontSize: 14, textAlign: 'center' },
  autreServeurHote: {
    fontFamily: POLICES.corps,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  autreServeurBouton: { marginTop: 20, alignSelf: 'stretch' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  champComposer: {
    flex: 1,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontFamily: POLICES.corps,
    fontSize: 15,
    maxHeight: 120,
  },
  attache: { fontSize: 20 },
  attacheInactif: { opacity: 0.35 },
  rondGlyphe: { fontSize: 18 },
  boutonJoindre: { paddingVertical: 8, paddingHorizontal: 2 },
  boutonEmoji: { paddingVertical: 8, paddingHorizontal: 2 },
  erreurComposer: { fontSize: 12, textAlign: 'center', paddingTop: 6, paddingHorizontal: 12 },
  barreNouveaux: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  traitNouveaux: { flex: 1, height: 2, borderRadius: 2, opacity: 0.5 },
  texteNouveaux: {
    fontFamily: POLICES.corpsFort,
    fontSize: 10.5,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bandeEchecFichier: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  noteComposer: {
    flex: 1,
    textAlign: 'center',
    fontFamily: POLICES.corps,
    fontSize: 13,
    paddingVertical: 8,
  },
});
