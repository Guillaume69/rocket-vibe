import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { and, count, eq, gt, isNull, min, or } from 'drizzle-orm';
import { useRequeteVive } from '../../ui/requeteVive.ts';
import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BaseLocale } from '../../db/client.ts';
import type { DepotBrouillons } from '../../db/depot.ts';
import { abonnements, messages, salons, sortie, televersements, nativeRoomAccess,nativePositions } from '../../db/schema.ts';
import type { MoteurActivite } from '../../lib/activite.ts';
import type {
  ActionsFournisseur,
  Fournisseur,
  Listener,
  Outbox,
  OutboxFichiers,
} from '../../lib/fournisseur.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { MoteurSaisie, resumerSaisie } from '../../lib/saisie.ts';
import { amenerMessage } from '../../ui/amenerMessage.ts';
import { useBrouillon } from '../../ui/brouillons.ts';
import {useConversationChiffree} from '../../ui/conversationChiffree.ts';
import {lignesPrivees} from '../../fournisseurs/rocketvibe/cryptoProjection.ts';
import {CryptoNative} from '../../modules/crypto-native/index.ts';
import {BorneAdhesionSalon} from '../../ui/adhesionSalon.tsx';
import { useProgressionFichiers } from '../../ui/progressionFichiers.ts';
import { VueEvitantLeClavier } from '../../ui/clavier.tsx';
import { useCandidatsMention } from '../../ui/completionMention.tsx';
import { Composer } from '../../ui/composer.tsx';
import { EnTeteSalon } from '../../ui/enTeteSalon.tsx';
import { jetonSession } from '../../ui/jetonSession.ts';
import { insererBarreNonLus,insererBarreNonLusNative, type LigneBarre } from '../../ui/barreNonLus.ts';
import {LectureObservee} from '../../ui/lectureObservee.ts';
import { useDonneesLissees } from '../../ui/donneesLissees.ts';
import { idsHeuresRepetees, idsSuites } from '../../ui/groupeMessages.ts';
import { insererSeparateursJour, type LigneJour } from '../../ui/separateurJour.ts';
import { avancerBorne, borneImmobile, pageARecule } from '../../ui/paginationSalon.ts';
import {
  ETAT_RETOUR_INITIAL,
  type EtatRetour,
  surAppuiRetour,
  surDefilementRetour,
  surGlisseRetour,
} from '../../ui/retourAuPlusRecent.ts';
import { garderAuChaud, salonCouvert } from '../../ui/salonChaud.ts';
import { consommerSaut, demanderSaut, useSaut } from '../../ui/sautMessage.ts';
import { signaler } from '../../ui/toast.tsx';
import { marquerSalonCharge, salonChargeSous } from '../../ui/salonsCharges.ts';
import { BoutonPrincipal, IndicateurSaisie, SeparateurJour } from '../../ui/kit.tsx';
import { Appuyable } from '../../ui/appuyable.tsx';
import {parseRoomLink,roomLinkMatches,roomLinkUrl,serviceUrl,type RoomLink} from '../../lib/roomLinks.ts';
import { MoteurSynchro } from '../../lib/sync.ts';
import { LigneMessage, type LigneDeMessage } from '../../ui/ligneMessage.tsx';
import { usePresence } from '../../ui/presence.ts';
import { useT,traduireCourant } from '../../ui/i18n.ts';
import { useSession } from '../../ui/session.tsx';
import { useSynchro } from '../../ui/synchro.tsx';
import { ordreMessages } from '../../ui/ordreMessages.ts';
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

export default function EcranSalon() {
  // `host` vient du deep-link d'une notification (natif comme expo) : il dit de
  // QUEL serveur ce message parle. Absent pour toute navigation interne — le
  // comportement est alors exactement celui d'avant.
  const { rid, host, nativeScope, roomLink } = useLocalSearchParams<{ rid: string; host?: string; nativeScope?:string;roomLink?:string }>();
  const external=roomLink!==undefined||host!==undefined||nativeScope!==undefined;
  const cibleLien=useMemo(()=>{
    if(roomLink!==undefined)return parseRoomLink(roomLink);
    if(!external)return null;
    if(typeof rid!=='string'||host!==undefined&&typeof host!=='string'||nativeScope!==undefined&&typeof nativeScope!=='string')return null;
    const url=new URL(`rocketvibe://salon/${encodeURIComponent(rid)}`);
    if(host!==undefined)url.searchParams.set('host',host);
    if(nativeScope!==undefined)url.searchParams.set('nativeScope',nativeScope);
    return parseRoomLink(url.toString());
  },[roomLink,external,rid,host,nativeScope]);
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
  if(external&&(!cibleLien||cibleLien.rid!==rid))return <View style={[styles.centre,{backgroundColor:c.fond}]}><Text style={[styles.erreur,{color:c.texteErreur}]}>{traduireCourant('salon.lienIndisponible')}</Text></View>;
  if(cibleLien?.host&&cibleLien.host!==serviceUrl(etat.session.baseUrl))return <AutreServeur c={c} cible={cibleLien} />;
  if(cibleLien&&!roomLinkMatches(cibleLien,etat.session))return <View style={[styles.centre,{backgroundColor:c.fond}]}><Text style={[styles.erreur,{color:c.texteErreur}]}>{traduireCourant('salon.lienIndisponible')}</Text></View>;

  const contenu = (membership?:string|null)=>(
    <Salon
      c={c}
      rid={rid}
      base={synchro.base}
      brouillons={synchro.brouillons}
      moteur={synchro.moteur}
      envoi={synchro.envoi}
      fichiers={synchro.fichiers}
      ddp={synchro.ddp}
      fournisseur={synchro.fournisseur}
      actions={synchro.actions}
      client={etat.client}
      moi={etat.session.username}
      declarerSalonOuvert={synchro.declarerSalonOuvert}
      activite={synchro.activite}
      generation={synchro.generation}
      membership={membership}
      cibleLien={cibleLien}
    />
  );
  return synchro.fournisseur.native?<BorneAdhesionSalon key={JSON.stringify(synchro.fournisseur.identite)+rid} base={synchro.base} rid={rid}>{contenu}</BorneAdhesionSalon>:contenu();
}

/**
 * Le message pointé par la notification vit sur un autre serveur que celui
 * affiché. On ne bascule PAS tout seul : `changerDeServeur` déplace le pointeur
 * de reprise, ferme la socket, rouvre une autre base — un tap sur une
 * notification ne doit pas emporter ça sans qu'on le demande. Geste explicite,
 * donc, et le libellé dit où l'on va.
 */
function AutreServeur({ c, cible }: { c: Couleurs; cible:RoomLink }) {
  const t = useT();
  const routeur = useRouter();
  const { changerDeServeur } = useSession();
  const [occupe, setOccupe] = useState(false);
  const [echec, setEchec] = useState(false);
  const hote=cible.host!;

  const basculer = useCallback(() => {
    setOccupe(true);
    setEchec(false);
    changerDeServeur(hote,cible).then(
      (ok) => {
        // Succès : `replace` retire le `host` de l'URL. Le laisser rejouerait ce
        // même écran si l'utilisateur repassait plus tard sur l'autre serveur.
        // Aucun `setState` sur ce chemin : l'écran est déjà en train de partir.
        if (ok) routeur.replace({ pathname: '/salon/[rid]', params: { rid:cible.rid, roomLink:roomLinkUrl(cible) } });
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
  }, [changerDeServeur, hote, cible, routeur]);

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
  fournisseur,
  actions,
  client,
  moi,
  declarerSalonOuvert,
  activite,
  generation,
  membership,
  cibleLien,
}: {
  c: Couleurs;
  rid: string;
  base: BaseLocale;
  brouillons: DepotBrouillons;
  moteur: MoteurSynchro;
  envoi: Outbox;
  fichiers: OutboxFichiers;
  ddp: Listener;
  fournisseur: Fournisseur;
  actions: ActionsFournisseur;
  client: ClientRest;
  /** Mon username — ma propre saisie ne s'affiche pas chez moi. */
  moi: string;
  declarerSalonOuvert: (rid: string) => () => void;
  activite: MoteurActivite;
  generation: number;
  membership?:string|null;
  cibleLien:RoomLink|null;
}) {
  const t = useT();
  const [limite, setLimite] = useState(PAGE);
  const native=fournisseur.identite.genre==='rocketvibe';
  const { data: lignesSalon } = useRequeteVive(
    base.select().from(salons).where(eq(salons.rid, rid)).limit(1), [rid],
  );
  const salon = lignesSalon?.[0];
  const protege=native && salon?.chiffre===true;
  const routeur=useRouter();
  const nativeChat=fournisseur.native?.chat;
  const cryptoDisponible=!!CryptoNative && nativeChat?.capabilities?.e2ee===true && nativeChat.capabilities.device_sessions===true;
  const conversation=useConversationChiffree(nativeChat,rid,membership,protege && cryptoDisponible);
  const online=useSyncExternalStore(useCallback(fn=>nativeChat?.subscribe(fn)??(()=>{}),[nativeChat]),()=>nativeChat?.status.online??true);
  const lienConsomme=useRef<RoomLink|null>(null);
  useEffect(()=>{
    if(!cibleLien||!online||lienConsomme.current===cibleLien||!nativeChat)return;
    let annule=false;
    void nativeChat.resolveRoomLink(cibleLien).then(({link,message})=>{
      if(annule)return;
      lienConsomme.current=cibleLien;
      if(link.root){routeur.push({pathname:'/fil/[id]',params:{id:link.root,...(link.message?{message:link.message}:{})}});}
      else if(link.message&&message)demanderSaut(rid,{id:link.message,horodatage:Date.parse(message.created_at)});
    }).catch(()=>{if(!annule){lienConsomme.current=cibleLien;signaler(t('salon.lienIndisponible'));}});
    return()=>{annule=true;};
  },[cibleLien,online,nativeChat,rid,routeur,t,membership]);
  type LigneListe = LigneDeMessage | LigneBarre | LigneJour;
  const liste = useRef<FlashListRef<LigneListe>>(null);
  const lireVisibles=useRef(()=>{});
  const focused=useRef(false);
  const [positionOuverture,setPositionOuverture]=useState<string|null|undefined>(undefined);
  const {data:positionsNatives}=useRequeteVive(base.select().from(nativePositions).where(eq(nativePositions.rid,native?rid:'__unused__')),[rid,native]);
  const positions=useMemo(()=>new Map(positionsNatives.map(row=>[row.id,row.position])),[positionsNatives]);
  useEffect(()=>{
    if(!native)return;
    let active=true;
    void actions.etatLectureSalon?.(rid).then(state=>{
      if(active)setPositionOuverture(state && state.adhesion===membership?state.positionRacines:null);
    }).catch(()=>{if(active)setPositionOuverture(null);});
    return()=>{active=false;};
  },[actions,rid,native,membership]);
  const lecture=useMemo(()=>new LectureObservee(async messageId=>{
    if(membership!=null)await actions.marquerLu(rid,{messageId,adhesion:membership});
  }),[actions,rid,membership]);
  const lecturesNatives=native && !protege && fournisseur.capacites.lecturesSalon===true && typeof positionOuverture==='string' && membership!=null;
  useEffect(()=>()=>lecture.fermer(),[lecture]);
  useFocusEffect(useCallback(()=>{
    focused.current=true;lecture.activer(lecturesNatives && AppState.currentState==='active');
    const frame=requestAnimationFrame(()=>lireVisibles.current());
    return()=>{cancelAnimationFrame(frame);focused.current=false;lecture.activer(false);};
  },[lecture,lecturesNatives]));
  useEffect(()=>{
    const subscription=AppState.addEventListener('change',state=>{
      lecture.activer(lecturesNatives && focused.current && state==='active');
      if(state==='active')requestAnimationFrame(()=>lireVisibles.current());
    });
    return()=>subscription.remove();
  },[lecture,lecturesNatives]);
  const nativeViewability=useMemo(()=>({itemVisiblePercentThreshold:1,minimumViewTime:250}),[]);
  const onNativeViewables=useCallback(({viewableItems}:{viewableItems:readonly {isViewable:boolean}[]})=>{
    if(viewableItems.some(item=>item.isViewable))lireVisibles.current();
  },[]);
  // Tant que le premier passage d'historique n'est pas retombé, une base
  // vide signifie « chargement », pas « salon vide ».
  // Un salon déjà chargé sous cette génération n'a pas de premier passage à
  // attendre : sans cet état initial, sauter le fetch laisserait « chargement »
  // affiché à vie (rien ne viendrait plus poser le drapeau).
  const [premierPassageFini, setPremierPassageFini] = useState(() =>
    salonChargeSous(rid, generation),
  );

  const {data:droitsNatifs}=useRequeteVive(base.select().from(nativeRoomAccess).where(eq(nativeRoomAccess.rid,rid)).limit(1),[rid]);
  const revisionDroits=droitsNatifs?.[0]?.revision;
  const peutEcrire=droitsNatifs?.[0]?.canSend;
  useEffect(()=>{
    const chat=fournisseur.native?.chat;
    if(!chat || peutEcrire!=null)return;
    let active=true;
    const refresh=()=>{if(active && chat.status.online)void chat.refreshRoomAccess(rid).catch(()=>{});};
    refresh();
    const unsubscribe=chat.subscribe(refresh);
    return ()=>{active=false;unsubscribe();};
  },[fournisseur,rid,revisionDroits,peutEcrire]);
  const insets = useSafeAreaInsets();
  // Sous-titre d'en-tête HONNÊTE : le nombre de membres en ligne n'est pas dans
  // le schéma, mais la présence du correspondant d'un DM, si — sinon, rien.
  const statutDM = usePresence(salon?.dmAutreUid ?? null,salon?.type==='d'?rid:undefined);

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
      .orderBy(...ordreMessages(fournisseur.ordreMessages))
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
  const fraiches = useMemo(() => protege ? lignesPrivees(conversation.view,rid) : brutes ?? [], [protege,conversation.view,rid,brutes]);
  // Lissage des entrants (200 ms) : à l'offset 0, l'inversion absorbe les
  // prepends nativement, mais une rafale re-rendrait l'écran à chaque
  // écriture — et REMONTÉ dans l'historique, chaque prepend décale le
  // contenu de sa hauteur (mVCP coupé, voir l'en-tête) : autant grouper la
  // rafale en un seul décalage. On lisse la projection, pas la base.
  const donneesOrdinaire = useDonneesLissees(brutes ?? [], 200);
  const donnees = protege ? fraiches : donneesOrdinaire;

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
    if(native)return;
    if (dernierIdRecu === undefined) return;
    if (luProgramme.current !== null) return;
    const restant = dernierLu.current + PLANCHER_LU_MS - Date.now();
    luProgramme.current = setTimeout(() => {
      luProgramme.current = null;
      dernierLu.current = Date.now();
      actions.marquerLu(rid).catch(() => {});
    }, Math.max(DEBOUNCE_LU_MS, restant));
  }, [actions, rid, dernierIdRecu,native]);

  // L'appel EN ATTENTE part tout de suite quand l'écran se ferme ou que l'app
  // passe en arrière-plan : différé par le plancher, il serait sinon perdu (le
  // démontage l'annule, l'arrière-plan gèle les timers JS) et le salon
  // resterait « non lu » sur les autres appareils. Rien en attente → rien à
  // envoyer : la sortie d'un salon déjà marqué ne coûte aucune requête.
  const flusherLu = useCallback(() => {
    if(native)return;
    if (luProgramme.current === null) return;
    clearTimeout(luProgramme.current);
    luProgramme.current = null;
    dernierLu.current = Date.now();
    actions.marquerLu(rid).catch(() => {});
  }, [actions, rid,native]);
  useEffect(() => {
    const abonnement = AppState.addEventListener('change', (suivant) => {
      if (suivant !== 'active') flusherLu();
    });
    return () => {
      abonnement.remove();
      flusherLu();
    };
  }, [flusherLu]);

  // Les données de la liste : la barre « nouveaux messages » puis les
  // séparateurs de jour, insérés par les projections de `ui/` (testées sous
  // Node). L'ordre compte : les séparateurs se posent au-dessus de la barre.
  const donneesAvecBarre = useMemo(
    () => protege ? donnees : native?insererBarreNonLusNative(donnees,positionOuverture,positions,fournisseur.identite.compteId):insererBarreNonLus(donnees, luJusquA, client.identifiants?.userId),
    [donnees, luJusquA, client,native,positionOuverture,positions,fournisseur.identite.compteId,protege],
  );
  const donneesListe = useMemo<LigneListe[]>(
    () => insererSeparateursJour(donneesAvecBarre, 'recent-en-tete'),
    [donneesAvecBarre],
  );
  useLayoutEffect(()=>{
    lireVisibles.current=()=>{
    if(!lecturesNatives || !focused.current || AppState.currentState!=='active')return;
    let range:{startIndex:number;endIndex:number}|undefined;
    try{range=liste.current?.computeVisibleIndices();}catch{return;}
    if(!range || range.startIndex<0)return;
    // DESC data: the first confirmed visible row has the greatest sequence.
    for(let index=range.startIndex;index<=range.endIndex;index++) {
      const row=donneesListe[index];
      if(row && !('barre' in row) && !('jour' in row) && positions.has(row.id)) {
        lecture.observer(row.id);break;
      }
    }
    };
    return()=>{lireVisibles.current=()=>{};};
  },[lecture,lecturesNatives,donneesListe,positions]);

  // Regroupement des rafales d'un même auteur (`ui/groupeMessages`) : calculé
  // APRÈS les insertions — barre et séparateur rompent les groupes. Données DESC.
  const suites = useMemo(() => idsSuites(donneesListe, 'recent-en-tete'), [donneesListe]);
  const heuresRepetees = useMemo(
    () => idsHeuresRepetees(donneesListe, 'recent-en-tete', suites),
    [donneesListe, suites],
  );

  // Suivi des entrants (idiome duogo) : à l'offset 0, un nouveau `data[0]`
  // s'affiche tout seul — natif. Légèrement remonté, on snappe au bas si le
  // message est de moi ou qu'on était près du bas ; en pleine lecture
  // d'historique, on ne bouge pas. Refs : le défilement ne re-rend rien.
  const presDuBas = useRef(true);
  const dernierSuivi = useRef<{ id: string; horodatage: number } | null>(null);
  const hauteurListe = useRef(0);
  const etatRetour = useRef<EtatRetour>(ETAT_RETOUR_INITIAL);
  const [retourVisible, setRetourVisible] = useState(false);
  const appliquerRetour = useCallback((suivant: EtatRetour) => {
    etatRetour.current = suivant;
    setRetourVisible(suivant.visible);
  }, []);
  const surDefilement = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const decalage = e.nativeEvent.contentOffset.y;
      presDuBas.current = decalage <= PRES_DU_BAS_PX;
      appliquerRetour(surDefilementRetour(etatRetour.current, decalage, hauteurListe.current));
    },
    [appliquerRetour],
  );
  const allerAuPlusRecent = useCallback(() => {
    appliquerRetour(surAppuiRetour());
    liste.current?.scrollToOffset({ offset: 0, animated: true });
  }, [appliquerRetour]);
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
    // Les streams et leurs clés sont l'affaire du fournisseur — on arme ce
    // qu'il déclare, sans en connaître le format.
    const relachers = fournisseur
      .souscriptionsSalon(rid)
      .map(([nom, cle]) => ddp.souscrire(nom, cle));
    // Le rattrapage (`chat.syncMessages`, un salon à la fois) vise le salon
    // que l'utilisateur regarde : on se déclare, et on rend la déclaration en
    // partant — jamais un `null` global, qui effacerait l'écran salon resté
    // dessous quand on dépile celui du dessus.
    const rendreDeclaration = declarerSalonOuvert(rid);
    return () => {
      rendreDeclaration();
      garderAuChaud(rid, generationRef.current, relachers, jeton);
    };
  }, [ddp, fournisseur, rid, declarerSalonOuvert]);

  const surSaisie=useCallback((active:boolean)=>{void fournisseur.native?.chat.setTyping(rid,active,undefined,membership??undefined);},[fournisseur,rid,membership]);
  // The existing indicator consumes provider events; RC emission remains unchanged.
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
  const resumeQuiTape = resumerSaisie(quiTape);
  const phraseQuiTape =
    resumeQuiTape === null
      ? null
      : resumeQuiTape.forme === 'un'
        ? t('salon.saisieUn', { nom: resumeQuiTape.nom })
        : resumeQuiTape.forme === 'deux'
          ? t('salon.saisieDeux', { a: resumeQuiTape.a, b: resumeQuiTape.b })
          : t('salon.saisieN', { n: resumeQuiTape.n });

  // Brouillon persistant (8.7) — le hook vit ICI : le composer ne monte
  // qu'une fois la valeur initiale lue.
  const depotObserve=useMemo(()=>fournisseur.native && membership!==undefined?fournisseur.native.chat.store.drafts({room:rid,membership}):brouillons,[fournisseur,brouillons,rid,membership]);
  const envoiObserve=useMemo<Outbox>(()=>{
    if(protege)return conversation.outbox;
    const chat=fournisseur.native?.chat;
    if(!chat || membership===undefined)return envoi;
    return {reessayer:envoi.reessayer?.bind(envoi),traiter:()=>envoi.traiter(),abandonner:id=>envoi.abandonner(id),envoyer:(target,text,thread,_jointes,citations=[])=>{
      if(target!==rid || thread)throw new Error('Room unavailable in this composer');
      return chat.send(target,text,{membership},citations);
    }};
  },[envoi,fournisseur,rid,membership,protege,conversation.outbox]);
  const persistanceOrdinaire = useBrouillon(depotObserve, protege ? null : rid);
  const sauverPrive=conversation.save;
  const effacerPrive=useCallback(()=>sauverPrive(''),[sauverPrive]);
  const persistance = protege ? {initial:conversation.initial,sauver:conversation.save,effacer:effacerPrive} : persistanceOrdinaire;

  // Candidats à la mention (@) : le hook vit ICI, où `base` est en scope — le
  // composer reçoit la liste toute prête, comme le brouillon.
  const candidatsMention = useCandidatsMention(base, rid);

  // Le chargement lui-même (endpoint, quirks de pagination, naissance du
  // curseur de rattrapage) vit chez le fournisseur — l'écran ne garde que le
  // critère de recul (`plusAncien`) pour sa pagination.
  const chargerHistorique = useCallback(
    (type: string, latest?: string) => fournisseur.chargerHistorique(moteur, rid, type, latest),
    [fournisseur, moteur, rid],
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
    if (type === undefined || protege) return;
    let annule = false;
    const jeton = jetonSession();
    // Rattrapage SAUTÉ quand le salon est resté écouté sans interruption : rien
    // n'a pu être manqué, et la lecture coûterait plusieurs secondes pour zéro
    // document sur un gros salon.
    if (!salonCouvert(rid, generation)) {
      void activite
        .suivre(rid, fournisseur.rattraperSalon(moteur, rid, () => annule))
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
  }, [type, chargerHistorique, generation, activite, rid, fournisseur, moteur,protege]);

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
    if(protege)return;
    const epuise = fraiches.length < limite;
    if (!epuise) {
      setLimite((l) => l + PAGE);
      return;
    }
    if (passeEpuise.current || enVol.current || type === undefined || fraiches.length === 0) {
      return;
    }
    const plusVieux = fraiches[fraiches.length - 1];
    // Prédicats extraits dans `ui/paginationSalon.ts`, testés sous Node — ils
    // encodent les deux leçons payées en 429 (ex æquo, borne immobile).
    bornePrecedente.current = avancerBorne(bornePrecedente.current, plusVieux.id);
    if (borneImmobile(bornePrecedente.current)) {
      passeEpuise.current = true;
      console.warn(`salon ${rid}: pagination immobile sur ${plusVieux.id}, passé déclaré épuisé`);
      return;
    }
    enVol.current = true;
    chargerHistorique(type, new Date(plusVieux.horodatage).toISOString())
      .then(({ plusAncien, aRecule }) => {
        if (aRecule ?? pageARecule(plusAncien, plusVieux.horodatage)) {
          setLimite((l) => l + PAGE);
        } else {
          passeEpuise.current = true;
        }
      })
      .catch((e: unknown) => console.warn('salon: page d’historique échouée', e))
      .finally(() => {
        enVol.current = false;
      });
  }, [fraiches, limite, type, chargerHistorique, rid,protege]);

  // Saut vers un message choisi dans les épinglés/favoris (`ui/sautMessage.ts`) :
  // l'amener dans la fenêtre (`ui/amenerMessage.ts`), attendre qu'il figure
  // dans les données de la liste, défiler jusqu'à lui et le surligner.
  const cibleSaut = useSaut(rid);
  const [sautVise, setSautVise] = useState<string | null>(null);
  useEffect(() => {
    if (cibleSaut === null || type === undefined) return;
    let annule = false;
    const cible = cibleSaut;
    const fluxPrincipal = and(
      eq(messages.rid, rid),
      or(isNull(messages.filId), eq(messages.filAffiche, true)),
    );
    const echouer = () => {
      if (annule) return;
      consommerSaut(rid, cible.id);
      signaler(t('salon.sautImpossible'));
    };
    if(fournisseur.native){
      void fournisseur.native.store.messageRank(rid,cible.id).then(rang=>{
        if(annule)return;
        if(rang===null){echouer();return;}
        consommerSaut(rid,cible.id);setLimite(l=>Math.max(l,rang+PAGE));setSautVise(cible.id);
      },echouer);
      return()=>{annule=true;};
    }
    amenerMessage({
      horodatage: cible.horodatage,
      rang: async () => {
        const trouve = await base
          .select({ horodatage: messages.horodatage })
          .from(messages)
          .where(and(eq(messages.id, cible.id), fluxPrincipal))
          .limit(1);
        if (trouve.length === 0) return null;
        const [plusRecents] = await base
          .select({ n: count() })
          .from(messages)
          .where(and(fluxPrincipal, gt(messages.horodatage, trouve[0].horodatage)));
        return plusRecents?.n ?? 0;
      },
      plusVieux: async () => {
        const [ligne] = await base
          .select({ h: min(messages.horodatage) })
          .from(messages)
          .where(eq(messages.rid, rid));
        return ligne?.h ?? null;
      },
      chargerPage: (latest) =>
        activite.suivre(rid, chargerHistorique(type, new Date(latest).toISOString())),
    }).then((rang) => {
      if (annule) return;
      if (rang === null) {
        echouer();
        return;
      }
      consommerSaut(rid, cible.id);
      setLimite((l) => Math.max(l, rang + PAGE));
      setSautVise(cible.id);
    }, echouer);
    return () => {
      annule = true;
    };
  }, [cibleSaut, type, base, rid, activite, chargerHistorique, t,fournisseur]);
  const indexSaut = useMemo(
    () =>
      sautVise === null
        ? -1
        : donneesListe.findIndex((l) => !('barre' in l) && !('jour' in l) && l.id === sautVise),
    [sautVise, donneesListe],
  );
  const dejaDefile = useRef<string | null>(null);
  useEffect(() => {
    if (sautVise === null || indexSaut < 0) return;
    const defiler = () =>
      liste.current?.scrollToIndex({ index: indexSaut, animated: true, viewPosition: 0.5 });
    let recaler: ReturnType<typeof setTimeout> | undefined;
    if (dejaDefile.current !== sautVise) {
      dejaDefile.current = sautVise;
      defiler();
      // Les hauteurs au-delà de la zone rendue sont estimées : le premier
      // défilement tombe à peu près, le second, lignes mesurées, juste.
      recaler = setTimeout(defiler, 450);
    }
    const eteindre = setTimeout(() => {
      dejaDefile.current = null;
      setSautVise(null);
    }, 2_500);
    return () => {
      clearTimeout(recaler);
      clearTimeout(eteindre);
    };
  }, [sautVise, indexSaut]);

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

  const reessayer = useCallback((id?: string) => {
    (id && envoiObserve.reessayer ? envoiObserve.reessayer(id) : envoiObserve.traiter()).catch(() => {});
  }, [envoiObserve]);
  const abandonner = useCallback(
    (id: string) => {
      envoiObserve.abandonner(id).catch(() => {});
    },
    [envoiObserve],
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
  const surligne = indexSaut >= 0 ? sautVise : null;
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
      if ('jour' in item) {
        return <SeparateurJour c={c} horodatage={item.horodatage} />;
      }
      const etatEnvoi = sortieParId.get(item.id);
      const prive=protege?conversation.view?.messages.find(row=>row.id===item.id):undefined;
      const interrompu=prive && ['pending','cancelling','cancelled'].includes(prive.status);
      return (
        <View
          style={[
            styles.ligneSurlignable,
            item.id === surligne && { backgroundColor: c.surfaceActive },
          ]}
        >
          <LigneMessage
            c={c}
            message={item}
            client={client}
            statutEnvoi={protege ? interrompu ? 'echec' : prive?.status==='accepted' ? 'en-attente' : null : etatEnvoi?.statut ?? null}
            libelleEchec={interrompu?t(prive.status==='cancelled'?'conversation.cancelled':'conversation.pending'):undefined}
            surReessayer={(protege ? interrompu && !conversation.busy : etatEnvoi?.statut === 'echec') ? () => reessayer(item.id) : null}
            surAbandonner={(protege ? interrompu && prive.status!=='cancelled' && !conversation.busy : etatEnvoi?.statut === 'echec') ? abandonner : null}
            // Pas d'actions sur une ligne d'outbox : son `_id` client n'a pas
            // été accepté par le serveur — `chat.delete`/`chat.update` dessus ne
            // peuvent qu'échouer. Ses vraies actions sont réessayer/abandonner.
            surAppuiLong={!protege && etatEnvoi === undefined ? ouvrirActions : null}
            surOuvrirFil={protege || fournisseur.capacites.fils === false ? null : ouvrirFil}
            moi={moi}
            surReagir={!protege && etatEnvoi === undefined && fournisseur.capacites.reactions !== false ? reagir : null}
            suite={suites.has(item.id)}
            heureRepetee={heuresRepetees.has(item.id)}
          />
        </View>
      );
    },
    [c, client, sortieParId, reessayer, abandonner, ouvrirActions, ouvrirFil, t, moi, reagir, suites, heuresRepetees, surligne, fournisseur,protege,conversation.view,conversation.busy],
  );

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ headerShown: false }} />
      <EnTeteSalon
        c={c}
        rid={rid}
        salon={salon}
        client={client}
        membership={membership}
        statutDM={statutDM}
        insetTop={insets.top}
        // Repli si le salon est la RACINE (deep-link à froid) : `back()` n'a
        // alors aucune cible et laisserait l'utilisateur coincé.
        onRetour={() => (routeur.canGoBack() ? routeur.back() : routeur.replace('/'))}
        onRecherche={() => routeur.push({ pathname: '/recherche-messages', params: { rid } })}
        onMarques={() => routeur.push({ pathname: '/messages-marques', params: { rid } })}
        actionsMessagesDisponibles={!protege}
      />
      {protege && <View style={styles.avisPrive}>
        <Text style={[styles.textePrive,{color:c.attenue}]}>{t(conversation.failed || !cryptoDisponible?'conversation.failed':'conversation.observed')}</Text>
        <Appuyable onPress={conversation.reload} disabled={conversation.busy || !cryptoDisponible} accessibilityRole="button">
          <Text style={{color:c.cyan}}>{t('devices.refresh')}</Text>
        </Appuyable>
      </View>}
      {donneesListe.length === 0 ? (
        // Vide : indicateur, puis mention explicite. (L'ancien piège mVCP
        // « viewport sous le contenu » a disparu avec l'inversion ; attendre
        // le premier lot reste la bonne UX — une liste qui clignote non.)
        <View style={styles.centre}>
          {(protege ? conversation.view!==null || conversation.failed || !cryptoDisponible : premierPassageFini) ? (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('salon.aucunMessage')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <View
          style={styles.plein}
          onLayout={(e) => {
            hauteurListe.current = e.nativeEvent.layout.height;
          }}
        >
          <FlashList
            ref={liste}
            inverted
            onScrollBeginDrag={() => {
              etatRetour.current = surGlisseRetour(etatRetour.current);
            }}
            data={donneesListe}
            onViewableItemsChanged={lecturesNatives?onNativeViewables:undefined}
            viewabilityConfig={lecturesNatives?nativeViewability:undefined}
            // Coupé : à l'offset 0, un prepend s'affiche de lui-même, et le
            // recalage natif partait avant le snap JS et l'écrasait.
            maintainVisibleContentPosition={{ disabled: true }}
            keyExtractor={(m) => m.id}
            // Contenu HÉTÉROGÈNE (messages, suites sans avatar, barre de
            // non-lus, séparateurs de jour) : sans type d'item, le recyclage
            // de FlashList mélange les gabarits.
            getItemType={(item) =>
              'barre' in item
                ? 'barre'
                : 'jour' in item
                  ? 'jour'
                  : suites.has(item.id)
                    ? 'suite'
                    : 'message'
            }
            renderItem={rendreLigne}
            extraData={surligne}
            onScroll={surDefilement}
            scrollEventThrottle={16}
            // Inversé : la fin des DONNÉES est le haut visuel — le passé.
            onEndReached={chargerPlus}
            onEndReachedThreshold={0.4}
            contentContainerStyle={styles.contenu}
          />
          {retourVisible && (
            <Appuyable
              onPress={allerAuPlusRecent}
              android_ripple={{ color: c.ondulation, borderless: true }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('salon.allerAuPlusRecent')}
              style={[
                styles.retourPlusRecent,
                {
                  backgroundColor: c.carte,
                  borderColor: c.bordure,
                  boxShadow: `0px 4px 12px -4px ${c.ombrePortee}`,
                },
              ]}
            >
              <Text style={[styles.retourPlusRecentFleche, { color: c.accent }]}>↓</Text>
            </Appuyable>
          )}
        </View>
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
            <Pressable onPress={() => reessayer()}>
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
            key={protege?`${rid}:${conversation.view?.admission}:${conversation.composer}`:rid}
            c={c}
            rid={rid}
            envoi={envoiObserve}
            fichiers={protege || fournisseur.capacites.fichiers === false ? null : fichiers}
            client={client}
            candidatsMention={candidatsMention}
            lectureSeule={protege ? peutEcrire!==true || conversation.view?.can_send!==true : fournisseur.native && fournisseur.capacites.infosSalon ? peutEcrire!==true : salon.lectureSeule}
            chiffre={salon.chiffre}
            nativeEncryptedReady={protege && conversation.view!==null}
            citationsDisponibles={!protege}
            placeholder={t('salon.messagePlaceholder')}
            brouillonInitial={persistance.initial}
            sauverBrouillon={persistance.sauver}
            surSaisie={surSaisie}
            effacerBrouillon={persistance.effacer}
          />
        )}
      </View>
    </VueEvitantLeClavier>
  );
}

const styles = StyleSheet.create({
  avisPrive: {paddingHorizontal:16,paddingVertical:8,flexDirection:'row',alignItems:'center',gap:10},
  textePrive: {flex:1,fontSize:11,fontFamily:POLICES.corps},
  plein: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { paddingHorizontal: 16, paddingVertical: 8 },
  heure: { fontSize: 11 },
  basComposer: { position: 'relative' },
  ligneSurlignable: { borderRadius: 12, marginHorizontal: -8, paddingHorizontal: 8 },
  retourPlusRecent: {
    position: 'absolute',
    right: 16,
    bottom: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retourPlusRecentFleche: { fontFamily: POLICES.titreFort, fontSize: 22, lineHeight: 26 },
  vide: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: POLICES.corps },
  erreur: { fontFamily: POLICES.corpsGras, fontSize: 14, textAlign: 'center' },
  autreServeurHote: {
    fontFamily: POLICES.corps,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  autreServeurBouton: { marginTop: 20, alignSelf: 'stretch' },
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
});
