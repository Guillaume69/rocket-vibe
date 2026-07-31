/**
 * En-tête de l'écran salon : retour, tuile, nom, présence du correspondant
 * (DM), appel, recherche, barre de synchro.
 *
 * Déplacé tel quel de `app/salon/[rid].tsx` (chantier 14) : props uniquement,
 * aucun couplage avec le moteur de liste — le fichier de l'écran mélangeait
 * trois responsabilités sur 1 400 lignes.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { salons } from '../db/schema.ts';
import { demarrerConference, sonderAppelDisponible } from '../lib/appel.ts';
import type { StatutPresence } from '../lib/presence.ts';
import { ouvrirFicheProfil } from '../lib/profilPreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useActivite } from './activite.ts';
import { useE2EDeverrouille } from './e2e.ts';
import { useT } from './i18n.ts';
import { AvatarSalon, BarreSynchro } from './kit.tsx';
import { CLES_PRESENCE, couleursPresence } from './presence.ts';
import { useSynchro } from './synchro.tsx';
import { type Couleurs, POLICES } from './theme.ts';

type LigneDeSalon = typeof salons.$inferSelect;

/** En-tête du salon : retour, tuile, nom, présence du correspondant (DM), recherche. */
export function EnTeteSalon({
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
  // allument la barre — même portée `rid` que le fetch enveloppé par l'écran.
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
              style={[styles.enteteSous, { color: couleursPresence(c)[statutDM] }]}
              numberOfLines={1}
            >
              {t(CLES_PRESENCE[statutDM])}
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

const styles = StyleSheet.create({
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
});
