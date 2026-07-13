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

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { appelDisponibleMemo, demarrerConference, sonderAppelDisponible } from '../lib/appel.ts';
import type { StatutPresence } from '../lib/presence.ts';
import { lireProfilPrecharge } from '../lib/profilPreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar } from '../lib/upload.ts';
import { TuileAvatar } from '../ui/kit.tsx';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';

/** Pastille et phrase par statut — mêmes mots que le sous-titre d'un DM. */
const PRESENCE: Record<StatutPresence, { phrase: string; teinte: string }> = {
  online: { phrase: 'en ligne', teinte: '#3BD16F' },
  away: { phrase: 'absent', teinte: '#F5B03E' },
  busy: { phrase: 'occupé', teinte: '#E8506B' },
  offline: { phrase: 'hors ligne', teinte: '#8A8FA3' },
};

type Profil = {
  uid: string;
  username: string;
  nom: string | null;
  statut: StatutPresence;
  /** Décalage UTC en heures (peut être fractionnaire : 5.5 pour l'Inde). */
  utcOffset: number | null;
  roles: string[];
  bio: string | null;
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
  };
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
  // `username` (mentions, lignes de message) OU `uid` (en-tête d'un DM, où
  // seul `dmAutreUid` est connu localement) — `users.info` accepte les deux.
  const { username, uid } = useLocalSearchParams<{ username?: string; uid?: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();
  const routeur = useRouter();

  const client: ClientRest | null = etat.phase === 'connecte' ? etat.client : null;
  const moi = etat.phase === 'connecte' ? etat.session.username : null;
  const moteur = synchro.phase === 'pret' ? synchro.moteur : null;

  // Fiche préchargée AVANT l'ouverture (`lib/profilPreload`) : présente, on
  // démarre DÉJÀ avec le profil complet et la disponibilité d'appel connue → la
  // sheet `fitToContents` se mesure à sa hauteur finale dès la première frame,
  // sans saut. Absente (réseau lent qui a fait sauter le plafond, ou pas de
  // client) : on retombe sur le chargement async ci-dessous, avec le squelette.
  const [precharge] = useState(() => lireProfilPrecharge({ username, uid }));
  const [profil, setProfil] = useState<Profil | null>(() =>
    precharge !== undefined ? profilDe(precharge.user) : null,
  );
  const [erreur, setErreur] = useState<string | null>(() =>
    precharge !== undefined && precharge.user === undefined ? precharge.erreur : null,
  );
  const [appelDispo, setAppelDispo] = useState(() =>
    client !== null ? appelDisponibleMemo(client) : false,
  );
  const [occupe, setOccupe] = useState(false);
  const enVol = useRef(false);

  useEffect(() => {
    // Déjà préchargé : ne rien recharger — un second rendu rebougerait la hauteur.
    if (precharge !== undefined) return;
    const params =
      typeof username === 'string' && username !== ''
        ? { username }
        : typeof uid === 'string' && uid !== ''
          ? { userId: uid }
          : null;
    if (client === null || params === null) return;
    let vivant = true;
    void client
      .get<{ user?: Record<string, unknown> }>('users.info', { params })
      .then((r) => {
        if (!vivant) return;
        const p = profilDe(r.user);
        if (p === null) setErreur('Profil illisible.');
        else setProfil(p);
      })
      .catch((e: unknown) => {
        if (vivant) setErreur(e instanceof Error ? e.message : 'Profil introuvable.');
      });
    void sonderAppelDisponible(client).then((ok) => {
      if (vivant) setAppelDispo(ok);
    });
    return () => {
      vivant = false;
    };
  }, [client, username, uid, precharge]);

  /** Ouvre (ou crée) le DM, puis y va — la sheet est REMPLACÉE par le salon. */
  const ouvrirDm = useCallback(
    async (versAppel: boolean) => {
      if (client === null || profil === null || enVol.current) return;
      enVol.current = true;
      setOccupe(true);
      setErreur(null);
      try {
        const reponse = await client.post<{ room?: Record<string, unknown> }>('im.create', {
          corps: { username: profil.username },
        });
        const rid = reponse.room?._id;
        if (typeof rid !== 'string') throw new Error('Conversation impossible.');
        if (moteur !== null && reponse.room !== undefined) await moteur.ingererSalons([reponse.room]);
        if (versAppel) {
          // `start` crée la conférence et poste le message d'appel dans le DM ;
          // l'écran d'appel fait le `join`. Au retour (back), on retombe là où
          // la fiche avait été ouverte.
          const callId = await demarrerConference(client, rid);
          routeur.replace({
            pathname: '/appel/[callId]',
            params: { callId, titre: profil.nom ?? profil.username },
          });
        } else {
          routeur.replace({ pathname: '/salon/[rid]', params: { rid } });
        }
      } catch (e) {
        setErreur(e instanceof Error ? e.message : 'Action impossible.');
        enVol.current = false;
        setOccupe(false);
      }
      // Succès : on a navigué, l'écran se démonte — ne pas re-setter l'état.
    },
    [client, profil, moteur, routeur],
  );

  // Ce qu'on sait DÈS le tap (avatar + @username, ou uid pour un DM) : on rend
  // l'en-tête RÉEL à la première frame, à sa hauteur définitive. La sheet
  // `fitToContents` monte alors une seule fois, pile à la bonne taille — pas de
  // plancher (donc pas de vide sous les boutons), pas de saut. Seuls les détails
  // optionnels (rôles, heure locale, bio) se posent ensuite, vers le bas.
  const usernameConnu = typeof username === 'string' && username !== '' ? username : null;
  const usernameAff = profil?.username ?? usernameConnu;
  const nomAff = profil?.nom ?? usernameAff ?? '';
  const avatarUri =
    client !== null ? urlAvatar(client, { username: usernameAff, uid: uid ?? profil?.uid }) : null;
  const estMoi = usernameAff !== null && usernameAff === moi;
  const erreurAvantProfil = profil === null && erreur !== null;

  return (
    <View style={[styles.feuille, { backgroundColor: c.carteProfonde }]}>
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
                { backgroundColor: profil !== null ? PRESENCE[profil.statut].teinte : c.attenue },
              ]}
            />
            <Text style={[styles.phrasePresence, { color: c.attenue }]}>
              {profil !== null ? PRESENCE[profil.statut].phrase : '…'}
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
          Heure locale : {heureLocale(profil.utcOffset)}
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

      {/* Actions présentes dès le squelette (Message désactivé le temps du
          chargement) : leur hauteur ne change pas à l'arrivée des données.
          Masquées si c'est moi, ou si le chargement a échoué avant tout profil. */}
      {!estMoi && !erreurAvantProfil && (
        <View style={styles.actions}>
          <Pressable
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
            accessibilityLabel={`Envoyer un message à ${usernameAff ?? ''}`}
          >
            {occupe ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={styles.boutonTexte}>💬 Message</Text>
            )}
          </Pressable>
          {appelDispo && (
            <Pressable
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
              accessibilityLabel={`Appeler ${usernameAff ?? ''}`}
            >
              <Text style={[styles.boutonTexte, { color: c.texte }]}>📞 Appeler</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
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
