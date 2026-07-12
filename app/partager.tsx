/**
 * Écran de partage entrant (cible ACTION_SEND d'Android).
 *
 * Ouvert par la feuille de partage système via `GardePartage` (app/_layout).
 * On y voit le contenu partagé — fichier(s) ou texte — on peut ajouter une
 * légende, puis on choisit une conversation existante (canal, groupe ou MP)
 * dans la liste locale. L'envoi réutilise les mêmes moteurs que le composeur
 * du salon : `fichiers.envoyer` pour les pièces jointes, `envoi.envoyer` pour
 * le texte seul. Aucune destination inventée : uniquement ce qu'on a déjà.
 *
 * Le module natif d'`expo-share-intent` a déjà copié les `content://` vers des
 * chemins accessibles (`file.path`) — d'où l'usage direct comme `uri`.
 */

import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Stack, useRouter } from 'expo-router';
import { type ShareIntent, useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import type { MoteurEnvoi } from '../lib/envoi.ts';
import type { MoteurTeleversement } from '../lib/envoiFichiers.ts';
import type { ClientRest } from '../lib/rest.ts';
import { ApercuPieceJointe, type FichierEnAttente } from '../ui/apercuPieceJointe.tsx';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { AvatarSalon } from '../ui/kit.tsx';
import { compresserImageSiUtile } from '../ui/preparerPieceJointe.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { type Couleurs, POLICES, useCouleurs } from '../ui/theme.ts';

type LigneDeSalon = typeof salons.$inferSelect;

export default function EcranPartager() {
  const c = useCouleurs();
  const { etat } = useSession();
  const synchro = useSynchro();
  const { shareIntent, resetShareIntent } = useShareIntentContext();

  // Quitter cet écran — par envoi, retour ou geste — doit TOUJOURS solder
  // l'intent : sinon `hasShareIntent` resterait vrai et le garde rouvrirait
  // `/partager`. Via une ref, pour n'appeler que le dernier `resetShareIntent`
  // une seule fois au démontage, sans dépendre de la stabilité de son identité.
  const resetRef = useRef(resetShareIntent);
  useEffect(() => {
    resetRef.current = resetShareIntent;
  }, [resetShareIntent]);
  useEffect(() => () => resetRef.current(true), []);

  if (etat.phase === 'deconnecte') {
    return <Message c={c} texte="Connecte-toi pour partager dans une conversation." />;
  }
  if (synchro.phase === 'erreur') {
    return <Message c={c} texte={synchro.message} />;
  }
  if (etat.phase !== 'connecte' || synchro.phase !== 'pret') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: 'Partager' }} />
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  return (
    <Partager
      c={c}
      base={synchro.base}
      envoi={synchro.envoi}
      fichiers={synchro.fichiers}
      client={etat.client}
      shareIntent={shareIntent}
    />
  );
}

function Message({ c, texte }: { c: Couleurs; texte: string }) {
  return (
    <View style={[styles.centre, { backgroundColor: c.fond }]}>
      <Stack.Screen options={{ title: 'Partager' }} />
      <Text style={[styles.message, { color: c.texteSecondaire }]}>{texte}</Text>
    </View>
  );
}

function Partager({
  c,
  base,
  envoi,
  fichiers,
  client,
  shareIntent,
}: {
  c: Couleurs;
  base: BaseLocale;
  envoi: MoteurEnvoi;
  fichiers: MoteurTeleversement;
  client: ClientRest;
  shareIntent: ShareIntent;
}) {
  const routeur = useRouter();

  // Fichiers partagés → pièces en attente. `path` est déjà un chemin local
  // accessible (le module natif a copié les content://).
  const initiales = useMemo<FichierEnAttente[]>(
    () =>
      (shareIntent.files ?? []).map((f) => ({
        uri: f.path,
        nom: f.fileName,
        type: f.mimeType,
        taille: f.size,
      })),
    [shareIntent],
  );
  const [pieces, setPieces] = useState<FichierEnAttente[]>(initiales);

  // Compression des images en tâche de fond : l'aperçu s'affiche tout de suite
  // avec l'original, puis chaque image lourde est remplacée par sa version
  // réduite. Mise à jour ciblée par `uri` (map sur `prev`) : un fichier retiré
  // entre-temps ne réapparaît pas.
  useEffect(() => {
    let vivant = true;
    for (const f of initiales) {
      void compresserImageSiUtile(f).then((prep) => {
        if (vivant && prep !== f) {
          setPieces((prev) => prev.map((p) => (p.uri === f.uri ? prep : p)));
        }
      });
    }
    return () => {
      vivant = false;
    };
  }, [initiales]);

  // Texte partagé (ou lien) : légende quand un fichier l'accompagne, sinon
  // c'est le message lui-même.
  const [legende, setLegende] = useState(shareIntent.text ?? shareIntent.webUrl ?? '');
  const [filtre, setFiltre] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const enVol = useRef(false);

  const aFichiers = pieces.length > 0;

  // Même source que l'accueil : deux requêtes vives (une par table), fusionnées
  // en JS, ordonnées par récence. On ne garde que les salons visibles.
  const { data: lignesSalons } = useLiveQuery(
    base.select().from(salons).orderBy(desc(salons.horodatageDernierMessage)),
  );
  const { data: lignesAbonnements } = useLiveQuery(base.select().from(abonnements));
  const aboParRid = new Map((lignesAbonnements ?? []).map((a) => [a.rid, a]));
  const filtreNorm = filtre.trim().toLowerCase();
  const cibles = (lignesSalons ?? [])
    .filter((s) => aboParRid.get(s.rid)?.ouvert !== false)
    .filter((s) => {
      if (filtreNorm === '') return true;
      return (s.nomAffiche ?? s.nom ?? s.rid).toLowerCase().includes(filtreNorm);
    });

  const partagerVers = useCallback(
    async (rid: string) => {
      if (enVol.current) return;
      const legendePropre = legende.trim();
      if (!aFichiers && legendePropre === '') return;
      enVol.current = true;
      setOccupe(true);
      setErreur(null);
      try {
        if (aFichiers) {
          // Un message par fichier ; la légende n'accompagne que le premier,
          // sinon elle se répéterait sous chaque pièce.
          for (let i = 0; i < pieces.length; i++) {
            await fichiers.envoyer(
              rid,
              pieces[i],
              i === 0 && legendePropre !== '' ? legendePropre : undefined,
            );
          }
        } else {
          await envoi.envoyer(rid, legendePropre);
        }
        // Succès : on ouvre la conversation. Le démontage soldera l'intent.
        routeur.replace({ pathname: '/salon/[rid]', params: { rid } });
      } catch (e) {
        // Seul un refus de validation (taille/type) rejette ici ; un échec
        // réseau deviendra une ligne d'échec actionnable dans le salon.
        setErreur(e instanceof Error ? e.message : 'Partage impossible.');
        enVol.current = false;
        setOccupe(false);
      }
    },
    [aFichiers, pieces, legende, fichiers, envoi, routeur],
  );

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: 'Partager', headerShown: true }} />
      <View style={styles.haut}>
        {pieces.map((f, i) => (
          <ApercuPieceJointe
            key={`${f.uri}-${i}`}
            c={c}
            fichier={f}
            occupe={occupe}
            // Le conteneur `haut` applique déjà le retrait : la carte s'aligne
            // ainsi sur la largeur du champ légende et du filtre.
            retraitHorizontal={0}
            onRetirer={() => setPieces((prev) => prev.filter((_, j) => j !== i))}
          />
        ))}
        <TextInput
          value={legende}
          onChangeText={setLegende}
          editable={!occupe}
          placeholder={aFichiers ? 'Ajouter une légende…' : 'Message à partager'}
          placeholderTextColor={c.texteTertiaire}
          multiline
          style={[
            styles.legende,
            { color: c.texte, backgroundColor: c.carte, borderColor: c.bordure },
          ]}
        />
        {erreur !== null && <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>}
        <Text style={[styles.label, { color: c.attenue }]}>Partager vers</Text>
        <TextInput
          value={filtre}
          onChangeText={setFiltre}
          placeholder="Rechercher une conversation…"
          placeholderTextColor={c.texteTertiaire}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.filtre, { color: c.texte, borderColor: c.bordure }]}
        />
      </View>
      <FlatList
        data={cibles}
        keyExtractor={(s) => s.rid}
        keyboardShouldPersistTaps="handled"
        style={styles.liste}
        contentContainerStyle={styles.listeContenu}
        renderItem={({ item }) => (
          <LigneCible
            c={c}
            salon={item}
            client={client}
            occupe={occupe}
            onChoisir={() => void partagerVers(item.rid)}
          />
        )}
        ListEmptyComponent={
          <Text style={[styles.vide, { color: c.attenue }]}>Aucune conversation.</Text>
        }
      />
      {occupe && (
        <View style={styles.voile}>
          <ActivityIndicator color={c.accent} size="large" />
        </View>
      )}
    </VueEvitantLeClavier>
  );
}

/**
 * Une conversation cible. Salon chiffré ou en lecture seule : on ne peut pas y
 * poster (le serveur rejette le clair en E2EE, et le lecteur seul est muet) —
 * la ligne est grisée et non sélectionnable, avec la raison.
 */
function LigneCible({
  c,
  salon,
  client,
  occupe,
  onChoisir,
}: {
  c: Couleurs;
  salon: LigneDeSalon;
  client: ClientRest;
  occupe: boolean;
  onChoisir: () => void;
}) {
  const nom = salon.nomAffiche ?? salon.nom ?? salon.rid;
  const bloque = salon.chiffre || salon.lectureSeule;
  const raison = salon.chiffre ? '🔒 Chiffré' : salon.lectureSeule ? 'Lecture seule' : null;

  return (
    <Pressable
      onPress={onChoisir}
      disabled={occupe || bloque}
      android_ripple={bloque ? undefined : { color: c.ondulation }}
      style={({ pressed }) => [styles.ligne, { opacity: bloque ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <AvatarSalon
        c={c}
        nom={nom}
        type={salon.type}
        chiffre={salon.chiffre}
        rid={salon.rid}
        dmAutreUid={salon.dmAutreUid}
        client={client}
      />
      <View style={styles.corpsLigne}>
        <Text style={[styles.nomCible, { color: c.texte }]} numberOfLines={1}>
          {nom}
        </Text>
        {raison !== null && (
          <Text style={[styles.raison, { color: c.attenue }]} numberOfLines={1}>
            {raison}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { fontFamily: POLICES.corpsGras, fontSize: 15, textAlign: 'center' },
  haut: { paddingHorizontal: 12, paddingTop: 12, gap: 10 },
  legende: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: POLICES.corps,
    fontSize: 15,
    minHeight: 46,
    maxHeight: 140,
  },
  erreur: { fontFamily: POLICES.corpsGras, fontSize: 13 },
  label: {
    fontFamily: POLICES.corpsFort,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: 4,
  },
  filtre: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: POLICES.corps,
    fontSize: 15,
  },
  liste: { flex: 1, marginTop: 4 },
  listeContenu: { paddingBottom: 16 },
  ligne: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  corpsLigne: { flex: 1, minWidth: 0, gap: 2 },
  nomCible: { fontFamily: POLICES.corpsGras, fontSize: 15 },
  raison: { fontFamily: POLICES.corps, fontSize: 12 },
  vide: { textAlign: 'center', padding: 24, fontSize: 14, fontFamily: POLICES.corps },
  voile: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
