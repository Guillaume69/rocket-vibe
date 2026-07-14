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
import { useRequeteVive } from '../ui/requeteVive.ts';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import { type ShareIntent, useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import type { Outbox, OutboxFichiers } from '../lib/fournisseur.ts';
import type { ClientRest } from '../lib/rest.ts';
import { ApercuPieceJointe, type FichierEnAttente } from '../ui/apercuPieceJointe.tsx';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { useT } from '../ui/i18n.ts';
import { AvatarSalon } from '../ui/kit.tsx';
import { compresserImageSiUtile } from '../ui/preparerPieceJointe.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { type Couleurs, DELAI_PRESSION_LISTE, POLICES, useCouleurs } from '../ui/theme.ts';

type LigneDeSalon = typeof salons.$inferSelect;

/**
 * Pièce partagée, à clé stable. On sépare CE QU'ON AFFICHE de CE QU'ON ENVOIE :
 * `origine` (l'URI d'origine) alimente l'aperçu et n'est JAMAIS modifiée ;
 * `aEnvoyer` porte la version compressée, calculée au montage. Sans cette
 * séparation, remplacer l'URI affichée par celle du fichier compressé faisait
 * RECHARGER l'`Image` de la vignette — le clignotement quand on partage
 * plusieurs photos (toutes les images rechargent d'un coup en fin de
 * compression).
 */
type PieceEnAttente = { cle: number; origine: FichierEnAttente; aEnvoyer: FichierEnAttente };

export default function EcranPartager() {
  const c = useCouleurs();
  const { etat } = useSession();
  const synchro = useSynchro();
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const t = useT();

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
    return <Message c={c} texte={t('partager.connecteToi')} />;
  }
  if (synchro.phase === 'erreur') {
    return <Message c={c} texte={synchro.message} />;
  }
  if (etat.phase !== 'connecte' || synchro.phase !== 'pret') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: t('partager.titre') }} />
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
  const t = useT();
  return (
    <View style={[styles.centre, { backgroundColor: c.fond }]}>
      <Stack.Screen options={{ title: t('partager.titre') }} />
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
  envoi: Outbox;
  fichiers: OutboxFichiers;
  client: ClientRest;
  shareIntent: ShareIntent;
}) {
  const routeur = useRouter();
  const t = useT();

  // Fichiers partagés → pièces en attente. Construites UNE fois, au montage :
  // le partage entrant est figé pour la vie de l'écran, et l'objet `shareIntent`
  // peut changer d'identité à chaque rendu du provider (s'en servir comme
  // dépendance relancerait la compression en boucle). `path` est déjà un chemin
  // local accessible (le module natif a copié les content://). `origine` et
  // `aEnvoyer` pointent d'abord sur le MÊME fichier : tant que la compression
  // n'a pas fini, on enverrait l'original — acceptable (juste plus lourd).
  const [pieces, setPieces] = useState<PieceEnAttente[]>(() =>
    (shareIntent.files ?? []).map((f, i) => {
      const fichier: FichierEnAttente = {
        uri: f.path,
        nom: f.fileName,
        type: f.mimeType,
        taille: f.size,
      };
      return { cle: i, origine: fichier, aEnvoyer: fichier };
    }),
  );

  // Compression des images au montage. SÉQUENTIELLE — plusieurs grosses photos
  // décodées en parallèle saturent le CPU et saccadent l'arrivée sur l'écran —
  // puis UNE SEULE mise à jour groupée. On ne touche QUE `aEnvoyer` : `origine`
  // (ce que la vignette affiche) reste identique, donc aucune `Image` ne
  // recharge et rien ne clignote. On associe par `cle` (pas par référence) :
  // une pièce retirée entre-temps n'est pas ressuscitée.
  useEffect(() => {
    let vivant = true;
    void (async () => {
      const originales = pieces;
      const prepares: FichierEnAttente[] = [];
      for (const p of originales) prepares.push(await compresserImageSiUtile(p.origine));
      if (!vivant) return;
      setPieces((actuelles) =>
        actuelles.map((p) => {
          const i = originales.findIndex((o) => o.cle === p.cle);
          return i >= 0 ? { ...p, aEnvoyer: prepares[i] } : p;
        }),
      );
    })();
    return () => {
      vivant = false;
    };
    // Au montage uniquement : les pièces initiales ne changent qu'ici.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Texte partagé (ou lien) : légende quand un fichier l'accompagne, sinon
  // c'est le message lui-même.
  const [legende, setLegende] = useState(shareIntent.text ?? shareIntent.webUrl ?? '');
  const [filtre, setFiltre] = useState('');
  const [occupe, setOccupe] = useState(false);
  // Salon vers lequel l'envoi est en cours : le spinner s'affiche SUR sa ligne
  // (pas en voile flottant), pour qu'on voie quelle destination reçoit.
  const [ridEnCours, setRidEnCours] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const enVol = useRef(false);

  const aFichiers = pieces.length > 0;

  // Même source que l'accueil : deux requêtes vives (une par table), fusionnées
  // en JS, ordonnées par récence. On ne garde que les salons visibles.
  const { data: lignesSalons } = useRequeteVive(
    base.select().from(salons).orderBy(desc(salons.horodatageDernierMessage)),
  );
  const { data: lignesAbonnements } = useRequeteVive(base.select().from(abonnements));
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
      setRidEnCours(rid);
      setErreur(null);
      try {
        if (aFichiers) {
          // Un message par fichier ; la légende n'accompagne que le premier,
          // sinon elle se répéterait sous chaque pièce.
          for (let i = 0; i < pieces.length; i++) {
            await fichiers.envoyer(
              rid,
              pieces[i].aEnvoyer,
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
        setErreur(e instanceof Error ? e.message : t('partager.partageImpossible'));
        enVol.current = false;
        setOccupe(false);
        setRidEnCours(null);
      }
    },
    [aFichiers, pieces, legende, fichiers, envoi, routeur, t],
  );

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('partager.titre'), headerShown: true }} />
      <View style={styles.haut}>
        {/*
          Un seul fichier : la carte pleine largeur (nom, type, taille) alignée
          sur les champs. Plusieurs : une BANDE de vignettes carrées défilable
          horizontalement — empilées verticalement, quelques photos suffisaient
          à repousser la liste des salons hors de l'écran, et l'espacement entre
          cartes paraissait trop grand. La bande a une hauteur fixe, quel que
          soit le nombre de pièces.
        */}
        {pieces.length === 1 && (
          <ApercuPieceJointe
            key={pieces[0].cle}
            c={c}
            fichier={pieces[0].origine}
            occupe={occupe}
            retraitHorizontal={0}
            retraitVertical={0}
            onRetirer={() => setPieces((prev) => prev.filter((x) => x.cle !== pieces[0].cle))}
          />
        )}
        {pieces.length > 1 && (
          <BandeauApercus
            c={c}
            pieces={pieces}
            occupe={occupe}
            onRetirer={(cle) => setPieces((prev) => prev.filter((x) => x.cle !== cle))}
          />
        )}
        <TextInput
          value={legende}
          onChangeText={setLegende}
          editable={!occupe}
          placeholder={aFichiers ? t('partager.ajouterLegende') : t('partager.messageAPartager')}
          placeholderTextColor={c.texteTertiaire}
          multiline
          style={[
            styles.legende,
            { color: c.texte, backgroundColor: c.carte, borderColor: c.bordure },
          ]}
        />
        {erreur !== null && <Text style={[styles.erreur, { color: c.texteErreur }]}>{erreur}</Text>}
        <Text style={[styles.label, { color: c.attenue }]}>{t('partager.partagerVers')}</Text>
        <TextInput
          value={filtre}
          onChangeText={setFiltre}
          placeholder={t('partager.rechercherConversation')}
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
        // Pendant l'envoi, on fige la liste : le spinner reste sur la ligne
        // choisie plutôt que de flotter au-dessus d'un contenu qui défile.
        scrollEnabled={!occupe}
        style={styles.liste}
        contentContainerStyle={styles.listeContenu}
        renderItem={({ item }) => (
          <LigneCible
            c={c}
            salon={item}
            client={client}
            occupe={occupe}
            envoiEnCours={item.rid === ridEnCours}
            onChoisir={() => void partagerVers(item.rid)}
          />
        )}
        ListEmptyComponent={
          <Text style={[styles.vide, { color: c.attenue }]}>{t('partager.aucuneConversation')}</Text>
        }
      />
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
  envoiEnCours,
  onChoisir,
}: {
  c: Couleurs;
  salon: LigneDeSalon;
  client: ClientRest;
  occupe: boolean;
  /** Cette ligne est la destination de l'envoi en cours : elle porte le spinner. */
  envoiEnCours: boolean;
  onChoisir: () => void;
}) {
  const t = useT();
  const nom = salon.nomAffiche ?? salon.nom ?? salon.rid;
  const bloque = salon.chiffre || salon.lectureSeule;
  const raison = salon.chiffre ? t('partager.chiffre') : salon.lectureSeule ? t('partager.lectureSeule') : null;
  // Bloqué, ou une autre destination pendant un envoi : la ligne s'estompe pour
  // concentrer l'attention sur celle qui reçoit.
  const attenue = bloque || (occupe && !envoiEnCours);

  return (
    <View style={styles.enveloppeLigne}>
      <Pressable
        onPress={onChoisir}
        disabled={occupe || bloque}
        android_ripple={bloque ? undefined : { color: c.ondulation }}
        unstable_pressDelay={DELAI_PRESSION_LISTE}
        style={({ pressed }) => [styles.ligne, { opacity: attenue ? 0.4 : pressed ? 0.6 : 1 }]}
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
        {envoiEnCours && <ActivityIndicator color={c.accent} />}
      </Pressable>
    </View>
  );
}

/** Émoji d'après la famille MIME, pour les vignettes non-image. */
function emojiPiece(type: string): string {
  if (type.startsWith('video/')) return '🎬';
  if (type.startsWith('audio/')) return '🎵';
  if (type === 'application/pdf') return '📄';
  if (type.startsWith('text/')) return '📃';
  if (type.includes('zip') || type.includes('compressed')) return '🗜️';
  return '📎';
}

/**
 * Bande d'aperçus compacte pour PLUSIEURS pièces : des vignettes carrées côte à
 * côte, défilables horizontalement. La hauteur est fixe quel que soit le nombre
 * de pièces, donc la liste des salons reste toujours visible dessous.
 */
function BandeauApercus({
  c,
  pieces,
  occupe,
  onRetirer,
}: {
  c: Couleurs;
  pieces: PieceEnAttente[];
  occupe: boolean;
  onRetirer: (cle: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.bandeau}
    >
      {pieces.map((p) => (
        <VignettePiece
          key={p.cle}
          c={c}
          fichier={p.origine}
          occupe={occupe}
          onRetirer={() => onRetirer(p.cle)}
        />
      ))}
    </ScrollView>
  );
}

function VignettePiece({
  c,
  fichier,
  occupe,
  onRetirer,
}: {
  c: Couleurs;
  fichier: FichierEnAttente;
  occupe: boolean;
  onRetirer: () => void;
}) {
  const t = useT();
  const estImage = fichier.type.startsWith('image/');
  return (
    <View style={styles.vignetteHote}>
      {estImage ? (
        <Image source={{ uri: fichier.uri }} style={styles.vignetteImg} resizeMode="cover" />
      ) : (
        <LinearGradient
          colors={c.degradeNeutre}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.vignetteImg}
        >
          <Text style={styles.vignetteEmoji}>{emojiPiece(fichier.type)}</Text>
        </LinearGradient>
      )}
      <Pressable
        onPress={onRetirer}
        disabled={occupe}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('partager.retirerPieceJointe')}
        style={[
          styles.vignetteRetirer,
          {
            backgroundColor: c.surfaceActive,
            borderColor: c.bordure,
            opacity: occupe ? 0.4 : 1,
          },
        ]}
      >
        <Text style={[styles.vignetteCroix, { color: c.texteSecondaire }]}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  message: { fontFamily: POLICES.corpsGras, fontSize: 15, textAlign: 'center' },
  haut: { paddingHorizontal: 12, paddingTop: 12, gap: 10 },
  bandeau: { gap: 8, paddingVertical: 2 },
  vignetteHote: { width: 76, height: 76 },
  vignetteImg: {
    width: 76,
    height: 76,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00000010',
  },
  vignetteEmoji: { fontSize: 30 },
  vignetteRetirer: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  vignetteCroix: { fontFamily: POLICES.corpsSemi, fontSize: 15, lineHeight: 16 },
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
  // Le rayon vit sur l'ENVELOPPE : seul le clip d'un parent (`overflow`)
  // découpe l'ondulation — borderRadius sur le Pressable est ignoré par le
  // masque du ripple sous Fabric. Invisible au repos (pas de fond).
  enveloppeLigne: { borderRadius: 18, overflow: 'hidden' },
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
});
