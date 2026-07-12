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

import { demarrerConference, sonderAppelDisponible } from '../lib/appel.ts';
import type { StatutPresence } from '../lib/presence.ts';
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

  const [profil, setProfil] = useState<Profil | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [appelDispo, setAppelDispo] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const enVol = useRef(false);

  useEffect(() => {
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
  }, [client, username, uid]);

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

  const estMoi = profil !== null && profil.username === moi;

  return (
    <View style={[styles.feuille, { backgroundColor: c.carteProfonde }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {profil === null && erreur === null && (
        <View style={styles.centre}>
          <ActivityIndicator color={c.accent} />
        </View>
      )}
      {profil === null && erreur !== null && (
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
      )}
      {profil !== null && client !== null && (
        <>
          <View style={styles.entete}>
            <TuileAvatar
              c={c}
              cle={profil.username}
              initiale={profil.username.charAt(0)}
              taille={72}
              rayon={22}
              uri={urlAvatar(client, { username: profil.username, uid: profil.uid })}
            />
            <View style={styles.identite}>
              <Text style={[styles.nom, { color: c.texte }]} numberOfLines={1}>
                {profil.nom ?? profil.username}
              </Text>
              <Text style={[styles.username, { color: c.attenue }]} numberOfLines={1}>
                @{profil.username}
              </Text>
              <View style={styles.presence}>
                <View style={[styles.pastille, { backgroundColor: PRESENCE[profil.statut].teinte }]} />
                <Text style={[styles.phrasePresence, { color: c.attenue }]}>
                  {PRESENCE[profil.statut].phrase}
                </Text>
              </View>
            </View>
          </View>

          {profil.roles.length > 0 && (
            <View style={styles.roles}>
              {profil.roles.map((role) => (
                <View key={role} style={[styles.role, { backgroundColor: c.carte }]}>
                  <Text style={[styles.roleTexte, { color: c.attenue }]}>{role}</Text>
                </View>
              ))}
            </View>
          )}

          {profil.utcOffset !== null && (
            <Text style={[styles.detail, { color: c.attenue }]}>
              Heure locale : {heureLocale(profil.utcOffset)}
            </Text>
          )}
          {profil.bio !== null && (
            <Text style={[styles.detail, { color: c.texte }]} numberOfLines={4}>
              {profil.bio}
            </Text>
          )}

          {erreur !== null && (
            <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>
          )}

          {!estMoi && (
            <View style={styles.actions}>
              <Pressable
                onPress={() => void ouvrirDm(false)}
                disabled={occupe}
                android_ripple={{ color: c.ondulation }}
                unstable_pressDelay={DELAI_PRESSION_LISTE}
                style={[styles.bouton, { backgroundColor: c.accent }, occupe && styles.inactif]}
                accessibilityRole="button"
                accessibilityLabel={`Envoyer un message à ${profil.username}`}
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
                  disabled={occupe}
                  android_ripple={{ color: c.ondulation }}
                  unstable_pressDelay={DELAI_PRESSION_LISTE}
                  style={[styles.bouton, { backgroundColor: c.carte }, occupe && styles.inactif]}
                  accessibilityRole="button"
                  accessibilityLabel={`Appeler ${profil.username}`}
                >
                  <Text style={[styles.boutonTexte, { color: c.texte }]}>📞 Appeler</Text>
                </Pressable>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  feuille: { padding: 20, paddingBottom: 28, gap: 14 },
  centre: { alignItems: 'center', paddingVertical: 24 },
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
