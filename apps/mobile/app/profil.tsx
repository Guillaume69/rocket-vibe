/**
 * Fiche d'un utilisateur — sheet native (`presentation: 'formSheet'` déclarée
 * dans `app/_layout.tsx`, même mécanique que la feuille d'actions de message).
 *
 * Ouverte par : l'avatar ou le nom d'auteur d'un message, une mention
 * `@username` dans un corps de message. Paramètre : `username`.
 *
 * Le contenu vient d'UN appel `users.info` : nom, statut de présence, rôles,
 * fuseau (`utcOffset`) — l'heure locale de l'interlocuteur est l'information
 * la plus utile avant de le déranger. Les actions : ouvrir (ou créer) le DM,
 * et appeler — le bouton n'apparaît que si un fournisseur de visioconférence
 * est configuré (`sonderAppelDisponible`), comme dans l'en-tête du salon.
 */

import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {ReactNode} from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import {SectionConfianceChiffree} from '../ui/confianceChiffree.tsx';
import {SectionGroupeChiffre} from '../ui/groupeChiffre.tsx';
import {BorneAdhesionSalon} from '../ui/adhesionSalon.tsx';
import {CryptoNative} from '../modules/crypto-native/index.ts';

import { appelDisponibleMemo, contexteAppel, demarrerConference, sonderAppelDisponible } from '../lib/appel.ts';
import type { StatutPresence } from '../lib/presence.ts';
import { chargerProfil,lireProfilPrecharge, type ErreurProfil } from '../lib/profilPreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { traduireCourant, useT } from '../ui/i18n.ts';
import { useEtagsAvatars } from '../ui/identites.tsx';
import { TuileAvatar } from '../ui/kit.tsx';
import { CLES_PRESENCE, couleursPresence } from '../ui/presence.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';
import { Appuyable } from '../ui/appuyable.tsx';
import { useMargeBasFeuille } from '../ui/margeFeuille.ts';

type Profil = {
  uid: string;
  username: string;
  nom: string | null;
  statut: StatutPresence;
  /** Décalage UTC en heures (peut être fractionnaire : 5.5 pour l'Inde). */
  utcOffset: number | null;
  roles: string[];
  bio: string | null;
  /**
   * Version de sa photo. `users.info` est le SEUL rattrapage possible pour un
   * avatar changé pendant que l'app était fermée : on la range en base au
   * passage, pour que la liste et les messages en profitent aussi.
   */
  avatarEtag: string | null;
};

function chaine(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function profilDe(brut: Record<string, unknown> | undefined): Profil | null {
  if (brut === undefined) return null;
  const uid = chaine(brut._id);
  const username = chaine(brut.username);
  if (uid === null || username === null) return null;
  const statut = chaine(brut.status);
  return {
    uid,
    username,
    nom: chaine(brut.name),
    statut:
      statut === 'online' || statut === 'away' || statut === 'busy' ? statut : 'offline',
    utcOffset: typeof brut.utcOffset === 'number' ? brut.utcOffset : null,
    roles: Array.isArray(brut.roles) ? brut.roles.filter((r): r is string => typeof r === 'string') : [],
    bio: chaine(brut.bio) ?? chaine(brut.statusText),
    avatarEtag: chaine(brut.avatarETag),
  };
}

/** L'erreur du préchargement, en langue : la clé se traduit ICI — le module
 *  `lib/profilPreload.ts` est du lib/ pur, il ne porte que la clé. */
function texteErreurProfil(e: ErreurProfil | null): string | null {
  if (e === null) return null;
  return 'message' in e ? e.message : traduireCourant(e.cle);
}

/** `14:07 (UTC+2)` — l'heure qu'il est CHEZ LUI, calculée du décalage serveur. */
function heureLocale(utcOffset: number): string {
  const la = new Date(Date.now() + utcOffset * 3_600_000);
  const h = String(la.getUTCHours()).padStart(2, '0');
  const m = String(la.getUTCMinutes()).padStart(2, '0');
  const signe = utcOffset >= 0 ? '+' : '−';
  const brut = Math.abs(utcOffset);
  const entier = Math.trunc(brut);
  const fraction = brut !== entier ? `:${String(Math.round((brut - entier) * 60)).padStart(2, '0')}` : '';
  return `${h}:${m} (UTC${signe}${entier}${fraction})`;
}

export default function EcranProfil() {
  const margeBas = useMargeBasFeuille();
  // `username` (mentions, lignes de message) OU `uid` (en-tête d'un DM, où
  // seul `dmAutreUid` est connu localement) — `users.info` accepte les deux.
  const { username, uid, cryptoRoom } = useLocalSearchParams<{ username?: string; uid?: string; cryptoRoom?:string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();
  const routeur = useRouter();
  // Pour lire la pile sous la feuille — voir « Message » plus bas.
  const navigation = useNavigation();
  const t = useT();

  const client: ClientRest | null = etat.phase === 'connecte' ? etat.client : null;
  const moi = etat.phase === 'connecte' ? etat.session.username : null;
  const moiId=etat.phase==='connecte'?etat.session.userId:null;
  const moteur = synchro.phase === 'pret' ? synchro.moteur : null;
  const actions = synchro.phase === 'pret' ? synchro.actions : null;
  const chat=synchro.phase==='pret'?synchro.fournisseur.native?.chat:null;
  const etags = useEtagsAvatars();

  // Fiche préchargée AVANT l'ouverture (`lib/profilPreload`) : présente, on
  // démarre DÉJÀ avec le profil complet et la disponibilité d'appel connue → la
  // sheet `fitToContents` se mesure à sa hauteur finale dès la première frame,
  // sans saut. Absente (réseau lent qui a fait sauter le plafond, ou pas de
  // client) : on retombe sur le chargement async ci-dessous, avec le squelette.
  const [precharge] = useState(() => lireProfilPrecharge({ username, uid }));
  const [profil, setProfil] = useState<Profil | null>(() =>
    precharge !== undefined ? profilDe(precharge.user) : null,
  );
  const cibleProfil=uid??username??'';
  const profilUid=profil?.uid??uid??null;
  const subscribeProfiles=useCallback((fn:()=>void)=>chat?.subscribe(fn)??(()=>{}),[chat]);
  const snapshotProfiles=useCallback(()=>chat?.profileVersionFor(profilUid)??'', [chat,profilUid]);
  const profileVersion=useSyncExternalStore(subscribeProfiles,snapshotProfiles,snapshotProfiles);
  const preloadVersion=useRef(profileVersion);
  const identiteResolue=useRef({cible:cibleProfil,uid:profil?.uid??null});
  const subscribePresence=useCallback((fn:()=>void)=>chat?.live.subscribe(fn)??(()=>{}),[chat]);
  const snapshotPresence=useCallback(()=>{
    const state=chat?.live.state,id=profilUid;
    return state&&id?state.presence.find(p=>p.user.id===id)?.status??(state.profiles?.some(p=>p.user.id===id)?'offline':null):null;
  },[chat,profilUid]);
  const presenceNative=useSyncExternalStore(subscribePresence,snapshotPresence,snapshotPresence);
  const statutAff=client?.genre==='rocketvibe'?presenceNative:profil?.statut??null;
  const [erreur, setErreur] = useState<string | null>(() =>
    precharge !== undefined && precharge.user === undefined
      ? texteErreurProfil(precharge.erreur)
      : null,
  );
  const porteeAction=useMemo(()=>({client,cibleProfil}),[client,cibleProfil]);
  const [disponibilite,setDisponibilite]=useState(()=>({portee:porteeAction,disponible:client!==null&&appelDisponibleMemo(client)}));
  const appelsPermis=synchro.phase==='pret'&&synchro.capacites.appelVideo!==false;
  const appelDispo=appelsPermis&&disponibilite.portee===porteeAction&&disponibilite.disponible;
  const visible=useRef<typeof porteeAction|null>(porteeAction);
  useEffect(()=>{visible.current=porteeAction;return()=>{if(visible.current===porteeAction)visible.current=null;};},[porteeAction]);
  const [actionEnVol,setActionEnVol]=useState<typeof porteeAction|null>(null);
  const occupe=actionEnVol===porteeAction;
  const enVol = useRef<typeof porteeAction|null>(null);

  useEffect(()=>{
    if(client===null||!appelsPermis)return;
    let vivant=true;
    void sonderAppelDisponible(client).then(disponible=>{if(vivant)setDisponibilite({portee:porteeAction,disponible});});
    return()=>{vivant=false;};
  },[client,appelsPermis,porteeAction]);

  useEffect(() => {
    // Déjà préchargé : ne rien recharger — un second rendu rebougerait la hauteur.
    if (precharge !== undefined && preloadVersion.current===profileVersion) return;
    const stableUid=client?.genre==='rocketvibe'&&identiteResolue.current.cible===cibleProfil?identiteResolue.current.uid:null;
    const params =
      stableUid?{uid:stableUid}:typeof username === 'string' && username !== ''
        ? { username }
        : typeof uid === 'string' && uid !== ''
          ? { uid }
          : null;
    if (client === null || params === null) return;
    let vivant = true;
    void chargerProfil(client,params)
      .then((user) => {
        if (!vivant) return;
        const p = profilDe(user);
        if (p === null) setErreur(traduireCourant('profil.profilIllisible'));
        else {identiteResolue.current={cible:cibleProfil,uid:p.uid};setProfil(p);setErreur(null);}
      })
      .catch((e: unknown) => {
        if (vivant){setProfil(null);setErreur(client.genre==='rocketvibe'?traduireCourant('native.error'):e instanceof Error ? e.message : traduireCourant('profil.profilIntrouvable'));}
      });
    return () => {
      vivant = false;
    };
  }, [client, username, uid, precharge,profileVersion,cibleProfil]);

  // Ce que la fiche vient d'apprendre profite au reste de l'app : pseudo courant
  // et version de photo rangés en base, donc la liste des salons et les messages
  // affichent la MÊME photo, tout de suite. Le SQL ne touche la ligne que si
  // quelque chose a vraiment changé (voir `UPSERT_IDENTITE`).
  useEffect(() => {
    if (profil === null || moteur === null || client?.genre==='rocketvibe') return;
    void moteur.depotSynchro
      .enregistrerIdentite({
        uid: profil.uid,
        username: profil.username,
        avatarEtag: profil.avatarEtag,
      })
      .catch(() => {
        // Une base indisponible ne doit pas empêcher d'afficher la fiche.
      });
  }, [profil, moteur,client]);

  /** Ouvre (ou crée) le DM, puis y va — la sheet est REMPLACÉE par le salon. */
  const ouvrirDm = useCallback(
    async (versAppel: boolean) => {
      if (client === null || actions === null || profil === null || enVol.current===porteeAction) return;
      const compte=contexteAppel(client),alive=()=>visible.current===porteeAction&&contexteAppel(client)===compte;
      enVol.current = porteeAction;
      setActionEnVol(porteeAction);
      setErreur(null);
      try {
        const { rid, salonBrut } = await actions.ouvrirOuCreerDm(profil.username,profil.uid);
        if(!alive())return;
        if (moteur !== null) await moteur.ingererSalons([salonBrut]);
        if(!alive())return;
        if (versAppel) {
          // `start` crée la conférence et poste le message d'appel dans le DM ;
          // l'écran d'appel fait le `join`. Au retour (back), on retombe là où
          // la fiche avait été ouverte.
          const callId = await demarrerConference(client, rid,{alive});
          if(!alive())return;
          routeur.replace({
            pathname: '/appel/[callId]',
            params: { callId, titre: profil.nom ?? profil.username,rid,compte },
          });
        } else {
          // `im.create` est idempotent : ouverte depuis un DM, la fiche rend le
          // rid de l'écran qui est JUSTE dessous. Un `replace` y fabriquait
          // quand même une nouvelle clé de route, donc une SECONDE instance
          // vivante du même salon — deux minuteries `marquerLu` (deux
          // `subscriptions.read` sur une route à 10/min), deux
          // `signalerSalonActif`, deux écouteurs de saisie, deux FlashList — et
          // un retour arrière qui a l'air de ne rien faire.
          //
          // Dans ce cas on se contente de refermer la feuille. Volontairement
          // défensif plutôt qu'un `navigate` : celui-ci dépilerait bien jusqu'à
          // l'écran existant, mais dans le cas NOMINAL (le DM n'est pas encore
          // ouvert) il empilerait le salon PAR-DESSUS la fiche, qui
          // réapparaîtrait au retour. Si la pile n'a pas la forme attendue, on
          // retombe sur le `replace` d'avant : au pire ce code ne fait rien,
          // jamais pire qu'avant.
          const pile = navigation.getState()?.routes ?? [];
          const dessous = pile.length >= 2 ? pile[pile.length - 2] : undefined;
          // Le `name` d'une route expo-router est son chemin de fichier
          // (`salon/[rid]`) ; on tolère une éventuelle barre de tête plutôt que
          // de parier sur la forme exacte.
          const dejaOuvert =
            dessous !== undefined &&
            dessous.name.replace(/^\//, '').startsWith('salon/') &&
            (dessous.params as { rid?: unknown } | undefined)?.rid === rid;
          if (dejaOuvert) routeur.back();
          else routeur.replace({ pathname: '/salon/[rid]', params: { rid } });
        }
      } catch (e) {
        if(!alive())return;
        setErreur(e instanceof Error ? e.message : t('profil.actionImpossible'));
        enVol.current = null;
        setActionEnVol(null);
      }
      // Succès : on a navigué, l'écran se démonte — ne pas re-setter l'état.
    },
    [client, actions, profil, moteur, routeur, navigation, t,porteeAction],
  );

  // Ce qu'on sait DÈS le tap (avatar + @username, ou uid pour un DM) : on rend
  // l'en-tête RÉEL à la première frame, à sa hauteur définitive. La sheet
  // `fitToContents` monte alors une seule fois, pile à la bonne taille — pas de
  // plancher (donc pas de vide sous les boutons), pas de saut. Seuls les détails
  // optionnels (rôles, heure locale, bio) se posent ensuite, vers le bas.
  const usernameConnu = typeof username === 'string' && username !== '' ? username : null;
  const usernameAff = profil?.username ?? usernameConnu;
  const nomAff = profil?.nom ?? usernameAff ?? '';
  // L'etag vient de la fiche fraîchement lue, sinon de la base (l'affichage
  // reste alors identique à celui de la ligne de message d'où l'on vient — pas
  // de photo qui saute d'une version à l'autre entre les deux écrans).
  const etagConnu =
    (usernameAff !== null ? etags.parUsername.get(usernameAff) : undefined) ??
    (typeof uid === 'string' ? etags.parUid.get(uid) : undefined) ??
    null;
  const avatarUri =
    client !== null
      ? urlAvatar(client, {
          username: usernameAff,
          uid: uid ?? profil?.uid,
          etag: client.genre==='rocketvibe'?etagConnu??profil?.avatarEtag:profil?.avatarEtag??etagConnu,
        })
      : null;
  const estMoi = profil?.uid?profil.uid===moiId:usernameAff !== null && usernameAff === moi;
  const erreurAvantProfil = profil === null && erreur !== null;

  return (
    <CorpsProfil c={c} bas={margeBas} scrollable={client?.genre==='rocketvibe' && CryptoNative!==null && chat?.capabilities?.e2ee===true && chat.capabilities.device_sessions===true}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.entete}>
        <TuileAvatar
          c={c}
          cle={usernameAff ?? '?'}
          initiale={(usernameAff ?? '?').charAt(0)}
          taille={72}
          rayon={22}
          uri={avatarUri ?? undefined}
        />
        <View style={styles.identite}>
          {/* `|| ' '` réserve la hauteur de ligne tant que le nom n'est pas là
              (cas du DM ouvert par uid), pour que rien ne bouge à l'arrivée. */}
          <Text style={[styles.nom, { color: c.texte }]} numberOfLines={1}>
            {nomAff || ' '}
          </Text>
          {usernameAff !== null && (
            <Text style={[styles.username, { color: c.attenue }]} numberOfLines={1}>
              @{usernameAff}
            </Text>
          )}
          <View style={styles.presence}>
            <View
              style={[
                styles.pastille,
                { backgroundColor: statutAff !== null ? couleursPresence(c)[statutAff] : c.attenue },
              ]}
            />
            <Text style={[styles.phrasePresence, { color: c.attenue }]}>
              {statutAff !== null ? t(CLES_PRESENCE[statutAff]) : '…'}
            </Text>
          </View>
        </View>
      </View>

      {profil !== null && profil.roles.length > 0 && (
        <View style={styles.roles}>
          {profil.roles.map((role) => (
            <View key={role} style={[styles.role, { backgroundColor: c.carte }]}>
              <Text style={[styles.roleTexte, { color: c.attenue }]}>{role}</Text>
            </View>
          ))}
        </View>
      )}

      {profil !== null && profil.utcOffset !== null && (
        <Text style={[styles.detail, { color: c.attenue }]}>
          {t('profil.heureLocale', { heure: heureLocale(profil.utcOffset) })}
        </Text>
      )}
      {profil !== null && profil.bio !== null && (
        <Text style={[styles.detail, { color: c.texte }]} numberOfLines={4}>
          {profil.bio}
        </Text>
      )}

      {erreur !== null && (
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
      )}
      {client?.genre==='rocketvibe' && profil && <SectionConfianceChiffree c={c} user={profil.uid}/>}
      {client?.genre==='rocketvibe' && typeof cryptoRoom==='string' && synchro.phase==='pret' && chat?.capabilities?.e2ee &&
        <BorneAdhesionSalon base={synchro.base} rid={cryptoRoom}>{membership=>membership?<SectionGroupeChiffre c={c} room={cryptoRoom} membership={membership}/>:null}</BorneAdhesionSalon>}

      {/* Actions présentes dès le squelette (Message désactivé le temps du
          chargement) : leur hauteur ne change pas à l'arrivée des données.
          Masquées si c'est moi, ou si le chargement a échoué avant tout profil. */}
      {!estMoi && !erreurAvantProfil && (
        <View style={styles.actions}>
          <Appuyable
            onPress={() => void ouvrirDm(false)}
            disabled={occupe || profil === null}
            android_ripple={{ color: c.ondulation }}
            unstable_pressDelay={DELAI_PRESSION_LISTE}
            style={[
              styles.bouton,
              { backgroundColor: c.accent },
              (occupe || profil === null) && styles.inactif,
            ]}
            accessibilityRole="button"
            accessibilityLabel={t('profil.envoyerMessageLabel', { nom: usernameAff ?? '' })}
          >
            {occupe ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.boutonTexte}>{t('profil.boutonMessage')}</Text>
            )}
          </Appuyable>
          {appelDispo && (
            <Appuyable
              onPress={() => void ouvrirDm(true)}
              disabled={occupe || profil === null}
              android_ripple={{ color: c.ondulation }}
              unstable_pressDelay={DELAI_PRESSION_LISTE}
              style={[
                styles.bouton,
                { backgroundColor: c.carte },
                (occupe || profil === null) && styles.inactif,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('profil.appelerLabel', { nom: usernameAff ?? '' })}
            >
              <Text style={[styles.boutonTexte, { color: c.texte }]}>{t('profil.boutonAppeler')}</Text>
            </Appuyable>
          )}
        </View>
      )}
    </CorpsProfil>
  );
}

function CorpsProfil({c,bas,scrollable,children}:{c:ReturnType<typeof useCouleurs>;bas:number;scrollable:boolean;children:ReactNode}) {
  const content=[styles.feuille,{backgroundColor:c.carteProfonde,paddingBottom:bas}];
  return scrollable ? <ScrollView style={{backgroundColor:c.carteProfonde}} contentContainerStyle={content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    : <View style={content}>{children}</View>;
}

const styles = StyleSheet.create({
  feuille: { padding: 20, paddingBottom: 28, gap: 14 },
  entete: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identite: { flex: 1, gap: 2 },
  nom: { fontFamily: POLICES.titre, fontSize: 20 },
  username: { fontFamily: POLICES.corps, fontSize: 14 },
  presence: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  pastille: { width: 9, height: 9, borderRadius: 5 },
  phrasePresence: { fontFamily: POLICES.corps, fontSize: 13 },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  role: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  roleTexte: { fontFamily: POLICES.corpsFort, fontSize: 12 },
  detail: { fontFamily: POLICES.corps, fontSize: 14 },
  erreur: { fontFamily: POLICES.corps, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  bouton: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 14,
  },
  inactif: { opacity: 0.6 },
  boutonTexte: { fontFamily: POLICES.corpsFort, fontSize: 15, color: '#FFFFFF' },
});
