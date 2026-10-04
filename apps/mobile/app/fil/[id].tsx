import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { useRequeteVive } from '../../ui/requeteVive.ts';
import * as Haptics from 'expo-haptics';
import { Redirect, Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';

import type { BaseLocale } from '../../db/client.ts';
import type { DepotBrouillons } from '../../db/depot.ts';
import { messages, salons, sortie, nativeRoomAccess } from '../../db/schema.ts';
import {CryptoNative} from '../../modules/crypto-native/index.ts';
import {lignesPrivees} from '../../fournisseurs/rocketvibe/cryptoProjection.ts';
import {useConversationChiffree} from '../../ui/conversationChiffree.ts';
import {Appuyable} from '../../ui/appuyable.tsx';
import type { MoteurActivite } from '../../lib/activite.ts';
import type { ActionsFournisseur, Fournisseur, Listener, Outbox } from '../../lib/fournisseur.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { MoteurSynchro } from '../../lib/sync.ts';
import { useActivite } from '../../ui/activite.ts';
import { useBrouillon } from '../../ui/brouillons.ts';
import {BorneAdhesionSalon} from '../../ui/adhesionSalon.tsx';
import {LectureObservee} from '../../ui/lectureObservee.ts';
import { filChargeSous, marquerFilCharge } from '../../ui/filsCharges.ts';
import { idsHeuresRepetees, idsSuites } from '../../ui/groupeMessages.ts';
import { insererSeparateursJour, type LigneJour } from '../../ui/separateurJour.ts';
import { jetonSession } from '../../ui/jetonSession.ts';
import { BarreSynchro, SeparateurJour } from '../../ui/kit.tsx';
import { VueEvitantLeClavier } from '../../ui/clavier.tsx';
import { useCandidatsMention } from '../../ui/completionMention.tsx';
import { Composer } from '../../ui/composer.tsx';
import { useT } from '../../ui/i18n.ts';
import { LigneMessage, type LigneDeMessage } from '../../ui/ligneMessage.tsx';
import { useSession } from '../../ui/session.tsx';
import { useSynchro } from '../../ui/synchro.tsx';
import { useCouleurs, type Couleurs, POLICES } from '../../ui/theme.ts';

/**
 * Écran d'un fil (8.3). `id` = `_id` du message racine (`tmid` de ses
 * réponses). Même architecture que le salon : SQLite projeté par requêtes
 * vives, le réseau (REST `chat.getThreadMessages` + stream) écrit dans SQLite.
 *
 * Un fil est court et fini — pas de pagination : `chat.getThreadMessages`
 * rapporte tout le fil en une passe (count=0 y est permis, ce n'est pas
 * l'historique du salon).
 */

export default function EcranFil() {
  const { id, message, rid } = useLocalSearchParams<{ id: string;message?:string;rid?:string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();

  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  if (synchro.phase === 'erreur') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (typeof id !== 'string' || synchro.phase !== 'pret' || etat.phase !== 'connecte') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <FilCadre
      c={c}
      filId={id}
      salonId={typeof rid==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(rid)?rid:null}
      cibleMessage={typeof message==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(message)?message:null}
      base={synchro.base}
      brouillons={synchro.brouillons}
      moteur={synchro.moteur}
      envoi={synchro.envoi}
      ddp={synchro.ddp}
      fournisseur={synchro.fournisseur}
      actions={synchro.actions}
      client={etat.client}
      moi={etat.session.username}
      activite={synchro.activite}
      generation={synchro.generation}
    />
  );
}

function FilCadre(props:Omit<Parameters<typeof Fil>[0],'membership'>){
  const {data}=useRequeteVive(props.base.select({rid:messages.rid}).from(messages).where(or(eq(messages.id,props.filId),eq(messages.filId,props.filId))).limit(1),[props.filId]);
  const rid=props.salonId??data?.[0]?.rid;
  if(!props.fournisseur.native)return <Fil {...props}/>;
  return rid?<BorneAdhesionSalon base={props.base} rid={rid}>{membership=><Fil {...props} membership={membership}/>}</BorneAdhesionSalon>:<Fil {...props} membership={null}/>;
}

function Fil({
  c,
  filId,
  base,
  brouillons,
  moteur,
  envoi,
  ddp,
  fournisseur,
  actions,
  client,
  moi,
  activite,
  generation,
  membership,
  cibleMessage,
  salonId,
}: {
  c: Couleurs;
  filId: string;
  cibleMessage:string|null;
  salonId:string|null;
  base: BaseLocale;
  brouillons: DepotBrouillons;
  moteur: MoteurSynchro;
  envoi: Outbox;
  ddp: Listener;
  fournisseur: Fournisseur;
  actions: ActionsFournisseur;
  client: ClientRest;
  /** Mon username — marque mes réactions dans les lignes. */
  moi: string;
  activite: MoteurActivite;
  generation: number;
  membership?:string|null;
}) {
  const t = useT();
  const enSynchro = useActivite(filId);
  // La racine du fil — elle porte le titre et le `rid`.
  const { data: lignesRacine } = useRequeteVive(
    base.select().from(messages).where(and(eq(messages.id, filId),fournisseur.native && salonId?eq(messages.rid,salonId):undefined)).limit(1),
    [filId,salonId],
  );
  const racine = lignesRacine?.[0];

  const { data: lignesReponses } = useRequeteVive(
    base
      .select()
      .from(messages)
      .where(and(eq(messages.filId, filId),fournisseur.native && salonId?eq(messages.rid,salonId):undefined))
      // Clé secondaire `id` (même raison que l'écran salon) : un ex æquo à la
      // milliseconde près est départagé de façon déterministe, pas par l'ordre
      // d'insertion. Ordre ASC ici pour rester cohérent avec le tri DESC du
      // salon — deux messages liés gardent la même relation dans les deux vues.
      .orderBy(...(fournisseur.ordreMessages==='sequence'?[
        asc(sql`(SELECT position FROM native_positions WHERE id=${messages.id}) IS NULL`),
        asc(sql`length((SELECT position FROM native_positions WHERE id=${messages.id}))`),
        asc(sql`(SELECT position FROM native_positions WHERE id=${messages.id})`),
      ]:[]),asc(messages.horodatage), asc(messages.id)),
    [filId,salonId],
  );

  // `rid` : par la racine, ou À DÉFAUT par une réponse (lien direct à froid —
  // `chat.getThreadMessages` ne renvoie jamais la racine, mais chaque réponse
  // porte le rid). Sans ce repli, l'écran ne pourrait ni s'abonner au stream
  // ni répondre tant que la racine n'est pas arrivée.
  const rid = fournisseur.native && salonId ? salonId : racine?.rid ?? (lignesReponses ?? [])[0]?.rid;

  // Les drapeaux du salon : mêmes interdits que le composer du salon —
  // promettre une réponse dans un salon chiffré ou en lecture seule, c'est
  // promettre un `error-not-allowed`.
  const { data: lignesSalon } = useRequeteVive(
    base
      .select()
      .from(salons)
      .where(eq(salons.rid, rid ?? ''))
      .limit(1),
    [rid],
  );
  const salon = lignesSalon?.[0];
  const native=fournisseur.native;
  const protege=!!native && salon?.chiffre===true;
  const cryptoDisponible=!!CryptoNative && native?.chat.capabilities?.e2ee===true && native.chat.capabilities.device_sessions===true;
  const conversation=useConversationChiffree(native?.chat,rid??'',membership,protege && cryptoDisponible,filId);
  const {data:droitsNatifs}=useRequeteVive(base.select().from(nativeRoomAccess).where(eq(nativeRoomAccess.rid,rid??'')).limit(1),[rid]);
  const { data: lignesSortie } = useRequeteVive(
    base.select().from(sortie).where(eq(sortie.filId, filId)),
    [filId],
  );
  const sortieParId = useMemo(
    () => new Map((lignesSortie ?? []).map((s) => [s.id, s])),
    [lignesSortie],
  );

  // Racine en tête, réponses en ordre chronologique — un fil se lit du haut.
  const donnees = useMemo<LigneDeMessage[]>(() => {
    if(protege)return lignesPrivees(conversation.view,rid??'',true);
    if(native && salon===undefined)return [];
    const reponses = lignesReponses ?? [];
    return racine === undefined ? reponses : [racine, ...reponses];
  }, [racine,lignesReponses,protege,conversation.view,rid,native,salon]);

  // Séparateurs de jour puis regroupement des rafales d'un même auteur
  // (`ui/separateurJour`, `ui/groupeMessages`) — données ASC ici, l'inverse
  // de l'écran salon.
  const donneesListe = useMemo<(LigneDeMessage | LigneJour)[]>(
    () => insererSeparateursJour(donnees, 'ancien-en-tete'),
    [donnees],
  );
  const suites = useMemo(() => idsSuites(donneesListe, 'ancien-en-tete'), [donneesListe]);
  const heuresRepetees = useMemo(
    () => idsHeuresRepetees(donneesListe, 'ancien-en-tete', suites),
    [donneesListe, suites],
  );

  // Le fil complet, depuis le serveur : rejouable, mêmes upserts idempotents.
  // `generation` : un fil ouvert hors ligne se remplit au raccordement.
  // Un fil déjà chargé sous cette génération n'a pas de premier passage à
  // attendre : sans cet état initial, sauter le fetch laisserait « chargement »
  // affiché à vie (même piège que l'écran salon).
  const [premierPassageFini, setPremierPassageFini] = useState(() =>
    filChargeSous(filId, generation),
  );
  useEffect(() => {
    if(protege || native && salonId && !salon)return;
    // Ce chargement ne se rejoue QUE si ce fil n'a pas déjà été chargé sous
    // cette génération de connexion. `generation` étant dans les deps, chaque
    // raccordement — donc chaque retour au premier plan, chaque flap réseau —
    // relançait `chat.getMessage` PUIS toute la pagination du fil, pour
    // ré-ingérer les mêmes documents. Voir `ui/filsCharges.ts`.
    if (filChargeSous(filId, generation)) return;
    let annule = false;
    const jeton = jetonSession();
    // Portée d'activité = le fil lui-même, pas son salon : `rid` n'est pas
    // encore connu quand ce chargement part (fil ouvert par lien direct, la
    // racine n'est pas en base) et il apparaîtrait EN COURS de fetch — la barre
    // écouterait alors une portée que personne n'a alimentée.
    // Le chargement (racine puis pagination défensive des réponses) vit chez
    // le fournisseur — voir `chargerFil` côté Rocket.Chat pour ses quirks.
    void activite
      .suivre(filId, fournisseur.chargerFil(moteur, filId, () => annule))
      .then(() => {
        // Marqué au SUCCÈS seulement : un fil ouvert hors ligne doit repartir
        // au raccordement suivant, pas rester vide.
        if (!annule) marquerFilCharge(filId, generation, jeton);
      })
      .catch(() => {
        // Hors ligne : le cache local suffit.
      })
      .finally(() => {
        if (!annule) setPremierPassageFini(true);
      });
    return () => {
      annule = true;
    };
  }, [fournisseur,moteur,filId,generation,activite,protege,native,salonId,salon]);

  // Les réponses arrivent par le stream du SALON : on s'y abonne aussi d'ici,
  // pour que le fil vive même ouvert par un lien direct (souscription
  // refcountée — voir ddp.souscrire). On arme TOUT ce que le fournisseur
  // déclare pour un salon, y compris l'activité de saisie que cet écran
  // n'affiche pas : dans le cas courant (fil empilé sur son salon), le
  // refcount fait qu'aucun `sub` de plus ne part ; par lien direct à froid,
  // ces battements sont classés « silence » par le traducteur — le prix d'une
  // façade qui ne détaille pas ses clés.
  useEffect(() => {
    if (rid === undefined) return;
    const relachers = fournisseur
      .souscriptionsSalon(rid)
      .map(([nom, cle]) => ddp.souscrire(nom, cle));
    return () => {
      for (const relacher of relachers) relacher();
    };
  }, [ddp, fournisseur, rid]);

  const routeur = useRouter();
  const ouvrirActions = useCallback(
    (idMessage: string) => {
      // « Pop » à l'ouverture de la feuille — confirme que l'appui long a pris.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      // `fil` : une éventuelle cible de réponse revient au composer de CE fil,
      // pas à celui du salon empilé dessous.
      routeur.push({ pathname: '/actions-message', params: { id: idMessage, fil: filId, ...(protege?{prive:'1',rid}:{}) } });
    },
    [routeur, filId,protege,rid],
  );
  const reessayer = useCallback((idMessage:string) => {
    (protege?conversation.outbox.reessayer!(idMessage):envoi.traiter()).catch(() => {});
  }, [envoi,protege,conversation.outbox]);
  const abandonner = useCallback(
    (idMessage: string) => {
      (protege?conversation.outbox:envoi).abandonner(idMessage).catch(() => {});
    },
    [envoi,protege,conversation.outbox],
  );
  // Tir-et-oublie, comme l'écran salon : l'écho du stream réécrit
  // `messages.reactions`, la requête vive re-rend la pastille.
  const reagir = useCallback(
    (ridMessage: string, idMessage: string, code: string, mettre: boolean) => {
      actions.reagir(ridMessage, idMessage, code, mettre).catch(() => {});
    },
    [actions],
  );

  const rendreLigne = useCallback(
    ({ item }: { item: LigneDeMessage | LigneJour }) => {
      if ('jour' in item) {
        return <SeparateurJour c={c} horodatage={item.horodatage} />;
      }
      const etatEnvoi = sortieParId.get(item.id);
      const prive=protege?conversation.view?.messages.find(row=>row.id===item.id):undefined;
      const interrompu=prive && ['pending','cancelling','cancelled'].includes(prive.status);
      return (
        <View style={item.id===cibleMessage?{backgroundColor:c.surfaceActive}:undefined}><LigneMessage
          c={c}
          message={item}
          client={client}
          statutEnvoi={protege?interrompu?'echec':prive?.status==='accepted'?'en-attente':null:etatEnvoi?.statut??null}
          libelleEchec={interrompu?t(prive.status==='cancelled'?'conversation.cancelled':'conversation.pending'):undefined}
          surReessayer={(protege?interrompu && !conversation.busy:etatEnvoi?.statut==='echec')?()=>reessayer(item.id):null}
          surAbandonner={(protege?interrompu && prive.status!=='cancelled' && !conversation.busy:etatEnvoi?.statut==='echec')?abandonner:null}
          surAppuiLong={protege?prive?.status==='journaled' || item.id===conversation.view?.root?.id?ouvrirActions:null:etatEnvoi === undefined ? ouvrirActions : null}
          // On EST dans le fil : pas d'indicateur « N réponses » sur la racine.
          surOuvrirFil={null}
          moi={moi}
          surReagir={!protege && etatEnvoi === undefined ? reagir : null}
          suite={suites.has(item.id)}
          heureRepetee={heuresRepetees.has(item.id)}
        /></View>
      );
    },
    [c,client,sortieParId,reessayer,abandonner,ouvrirActions,moi,reagir,suites,heuresRepetees,cibleMessage,protege,conversation.view,conversation.busy,t],
  );

  const liste = useRef<FlashListRef<LigneDeMessage | LigneJour>>(null);
  const [listePrete,setListePrete]=useState(false);
  const cibleRevelee=useRef<string|null>(null);
  useEffect(()=>{
    if(!listePrete||!cibleMessage||cibleRevelee.current===cibleMessage)return;
    const index=donneesListe.findIndex(m=>!('jour' in m)&&m.id===cibleMessage);
    if(index<0)return;
    liste.current?.scrollToIndex({index,animated:true,viewPosition:0.5});cibleRevelee.current=cibleMessage;
  },[listePrete,cibleMessage,donneesListe]);
  // La liste s'ouvre sur la RACINE : sans défilement après envoi, la réponse
  // optimiste naît sous le pli et l'envoi semble n'avoir rien fait. On attend
  // l'`_id` rendu par `envoi.envoyer` DANS les données — c'est le rendu qui
  // recale la liste, pas une horloge. Le `setTimeout(250)` d'avant perdait la
  // course dès que la file d'écritures était occupée : la chaîne écriture
  // SQLite → `addDatabaseChangeListener` → `useRequeteVive` (débounce plafonné
  // à 400 ms) n'a AUCUNE borne supérieure garantie sous ce délai — et la règle
  // permanente du projet interdit les correctifs par temps d'attente.
  // Une ref, pas un état : « quel envoi attend son défilement » ne rend rien.
  // `envoyer` résout à l'ÉCRITURE locale, et la projection de cette écriture
  // arrive forcément après (débounce ≥ 48 ms de la requête vive) : la ref est
  // toujours posée avant le changement de `donnees` qui la consomme.
  const envoiASuivre = useRef<string | null>(null);
  const apresEnvoi = useCallback((idMessage: string) => {
    envoiASuivre.current = idMessage;
  }, []);
  useEffect(() => {
    if (envoiASuivre.current === null) return;
    if (!donnees.some((m) => m.id === envoiASuivre.current)) return;
    envoiASuivre.current = null;
    liste.current?.scrollToEnd({ animated: true });
  }, [donnees]);

  // Brouillon du fil (8.7), clé `rid:tmid` : isolé du brouillon du salon.
  // `null` tant que le rid n'est pas connu — le composer attend.
  const surSaisie=useCallback((active:boolean)=>{if(rid && !protege)void native?.chat.setTyping(rid,active,filId,membership??undefined);},[native,rid,filId,membership,protege]);
  const depot=useMemo(()=>native?native.store.drafts({room:rid??'',membership:membership??null}):brouillons,[native,brouillons,rid,membership]);
  const persistanceOrdinaire = useBrouillon(depot, rid===undefined || protege || native && !salon ? null : `${rid}:${filId}`);
  const sauverPrive=conversation.save;
  const effacerPrive=useCallback(()=>sauverPrive(''),[sauverPrive]);
  const persistance=protege?{initial:conversation.initial,sauver:conversation.save,effacer:effacerPrive}:persistanceOrdinaire;
  const envoiLie=useMemo<Outbox>(()=>protege?conversation.outbox:native?{...envoi,envoyer:(room,text,root,_jointes,quotes)=>native.chat.send(room,text,{membership:membership??null},quotes,root)}:envoi,[native,envoi,membership,protege,conversation.outbox]);
  const lecture=useMemo(()=>new LectureObservee(async id=>{if(native && membership)await native.chat.markObservedThreadRead(filId,id,membership);}),[native,membership,filId]);
  useEffect(()=>()=>lecture.fermer(),[lecture]);
  useFocusEffect(useCallback(()=>{
    const active=()=>lecture.activer(!!native && !protege && membership!=null && AppState.currentState==='active');
    active();const listener=AppState.addEventListener('change',active);
    return()=>{listener.remove();lecture.activer(false);};
  },[lecture,native,membership,protege]));
  const onVisible=useCallback(({viewableItems}:{viewableItems:{item:LigneDeMessage|LigneJour;index:number|null}[]})=>{
    const latest=viewableItems.filter(token=>!('jour' in token.item) && token.item.filId===filId && !sortieParId.has(token.item.id)).sort((a,b)=>(b.index??-1)-(a.index??-1))[0];
    if(latest && !('jour' in latest.item))lecture.observer(latest.item.id);
  },[lecture,filId,sortieParId]);
  const viewability=useMemo(()=>({itemVisiblePercentThreshold:50}),[]);

  // Candidats à la mention (@) : ceux du SALON, pas seulement du fil — on
  // mentionne souvent dans un fil quelqu'un qui a parlé dans le flux principal.
  // `rid` encore inconnu → requête sur '' : liste vide, le composer n'est de
  // toute façon pas monté.
  const candidatsMention = useCandidatsMention(base, rid ?? '');

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('fil.titre') }} />
      {/* L'en-tête est natif ici (pas d'`EnTeteSalon`) : la barre se pose donc
          juste sous lui. Sans elle, le fil se réécrivait intégralement sans
          qu'aucun signal ne l'indique. */}
      <BarreSynchro c={c} actif={enSynchro} />
      {protege && <View style={styles.avisPrive}>
        <Text style={[styles.textePrive,{color:c.attenue}]}>{t(conversation.failed || !cryptoDisponible?'conversation.failed':conversation.view && !conversation.view.root?'conversation.rootMissing':'conversation.observed')}</Text>
        <Appuyable onPress={conversation.reload} disabled={conversation.busy || !cryptoDisponible} accessibilityRole="button"><Text style={{color:c.cyan}}>{t('devices.refresh')}</Text></Appuyable>
      </View>}
      {donnees.length === 0 ? (
        <View style={styles.centre}>
          {(protege?conversation.view!==null || conversation.failed || !cryptoDisponible:premierPassageFini) ? (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('fil.introuvable')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={liste}
          onLoad={()=>setListePrete(true)}
          extraData={cibleMessage}
          data={donneesListe}
          keyExtractor={(m) => m.id}
          // Trois gabarits (tête avec avatar / suite sans / séparateur de
          // jour) : typés pour que le recyclage de FlashList ne les mélange pas.
          getItemType={(item) =>
            'jour' in item ? 'jour' : suites.has(item.id) ? 'suite' : 'message'
          }
          renderItem={rendreLigne}
          onViewableItemsChanged={native && !protege?onVisible:undefined}
          viewabilityConfig={native && !protege?viewability:undefined}
          contentContainerStyle={styles.contenu}
          // Un fil se LIT depuis sa racine : ouverture en haut — l'idiome
          // INVERSÉ du salon (8.10) n'aurait pas de sens ici. On garde donc
          // le mVCP pour suivre les réponses entrantes près du bas, avec son
          // recalage JS pendant l'animation du clavier — liste courte, à
          // porter si le ressenti l'exige.
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2 }}
        />
      )}
      {/* Le composer COMMUN (ui/composer.tsx) : les variantes chiffré /
          lecture seule vivent dedans — dans un salon chiffré, il propose
          désormais le déverrouillage E2E, comme l'écran salon. `fichiers`
          est null : pas de pièces jointes ni de vocal dans un fil. */}
      {rid !== undefined && salon !== undefined && persistance.initial !== null && (
        <Composer
          key={JSON.stringify([rid,filId,membership,protege?conversation.view?.admission:null,protege?conversation.composer:null])}
          c={c}
          rid={rid}
          filId={filId}
          envoi={envoiLie}
          fichiers={null}
          client={client}
          candidatsMention={candidatsMention}
          lectureSeule={protege?droitsNatifs?.[0]?.canSend!==true || conversation.view?.can_send!==true || conversation.view.catching_up:salon.lectureSeule || !!native && (membership==null || !racine)}
          chiffre={salon.chiffre}
          nativeEncryptedReady={protege && conversation.view!==null}
          citationsDisponibles={!protege || conversation.view!==null}
          placeholder={t('fil.repondre')}
          apresEnvoi={apresEnvoi}
          brouillonInitial={persistance.initial}
          sauverBrouillon={persistance.sauver}
          surSaisie={surSaisie}
          effacerBrouillon={persistance.effacer}
        />
      )}
    </VueEvitantLeClavier>
  );
}

const styles = StyleSheet.create({
  avisPrive:{paddingHorizontal:16,paddingVertical:8,gap:4},
  textePrive:{fontSize:12},
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { paddingHorizontal: 16, paddingVertical: 8 },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  erreur: { fontFamily: POLICES.corpsSemi, fontSize: 14, textAlign: 'center' },
});
