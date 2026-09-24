/**
 * Composer commun aux écrans salon et fil : champ, brouillon persistant,
 * pièces jointes (caméra, bibliothèque, fichier, vocal), complétions
 * emoji/mention, citation, et les variantes lecture seule / salon chiffré.
 *
 * Extrait de `app/salon/[rid].tsx` (chantier 14). Le composer du fil en était
 * une copie DIVERGÉE — police système faute de `POLICES`, pas de fermeture du
 * clavier avant sélecteur, bouton d'envoi textuel — la fusion résorbe ces
 * écarts. Ce qui diffère réellement est paramétré :
 *
 *  - `filId` : la réponse part dans ce fil (`envoi.envoyer`), et la cible de
 *    citation est adressée `rid:filId` au lieu de `rid` ;
 *  - `fichiers` : `null` = ni 📎 ni 🎤 (le fil n'a pas les pièces jointes —
 *    `OutboxFichiers.envoyer` ne sait d'ailleurs pas viser un fil) ;
 *  - `apresEnvoi` : reçoit l'`_id` client posé par l'outbox (le fil suit son
 *    apparition pour défiler) ;
 *  - `placeholder` : « Message » côté salon, « Répondre… » côté fil.
 *
 * Couplages externes uniquement par stores module-level (`useReponse`,
 * `demanderSource`) — aucun lien avec le moteur de liste des écrans.
 */

import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { citer } from '../lib/citation.ts';
import type { CandidatMention } from '../lib/completionMention.ts';
import type { Outbox, OutboxFichiers } from '../lib/fournisseur.ts';
import type { ClientRest } from '../lib/rest.ts';
import { ApercuPieceJointe, type FichierEnAttente } from './apercuPieceJointe.tsx';
import { BandeauReponse } from './bandeauReponse.tsx';
import { BandeauCompletionEmoji, useCompletionEmoji } from './completionEmoji.tsx';
import { BandeauCompletionMention } from './completionMention.tsx';
import { useE2EDeverrouille } from './e2e.ts';
import { supprimerSiTemporaire } from './fichiersTemporaires.ts';
import { useT } from './i18n.ts';
import { TuileAvatar } from './kit.tsx';
import { estRejetArbreDeVues, lancerSelecteurAvecReprise } from './lancerSelecteur.ts';
import { NavigateurEmoji, usePanneauEmoji } from './navigateurEmoji.tsx';
import { reduirePieceJointe } from './preparerPieceJointe.ts';
import { reductionProposable, type QualiteEnvoi } from './qualitePieceJointe.ts';
import { annulerReponse, useReponse } from './reponse.ts';
import { useRetourMateriel } from './retourMateriel.ts';
import { demanderSource, feuilleEstMontee } from './sourcePieceJointe.ts';
import { useSynchro } from './synchro.tsx';
import { type Couleurs, POLICES } from './theme.ts';
import { phraseValidation } from './validationFichiers.ts';

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

export function Composer({
  c,
  rid,
  filId = null,
  envoi,
  fichiers,
  client,
  candidatsMention,
  lectureSeule,
  chiffre,
  placeholder,
  apresEnvoi,
  brouillonInitial,
  sauverBrouillon,
  effacerBrouillon,
}: {
  c: Couleurs;
  rid: string;
  /** Fil visé par les envois, ou `null` pour le flux principal du salon. */
  filId?: string | null;
  envoi: Outbox;
  /** `null` : pas de pièces jointes ni de vocal (le composer du fil). */
  fichiers: OutboxFichiers | null;
  /** Avatars des suggestions de mention. */
  client: ClientRest;
  /** Auteurs récents du salon (`useCandidatsMention`), calculés par le parent. */
  candidatsMention: CandidatMention[];
  lectureSeule: boolean;
  chiffre: boolean;
  /** Placeholder du champ vide — une pièce jointe en attente le remplace. */
  placeholder: string;
  /** Reçoit l'`_id` client posé par l'outbox — le fil suit son apparition. */
  apresEnvoi?: ((idMessage: string) => void) | undefined;
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
  // Qualité d'envoi d'un média réductible (photo lourde, vidéo) : « réduite »
  // par défaut, basculable sur les pastilles de l'aperçu. La réduction se fait
  // À L'ENVOI (voir `envoyer`) — pas au choix du fichier, où elle ferait payer
  // un transcodage à qui retire la pièce ou veut l'original.
  const [qualite, setQualite] = useState<QualiteEnvoi>('reduite');
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
  // Répondre). Adressée à CE composer : `rid:filId` dans un fil, `rid` dans le
  // salon — voir `ui/reponse.ts`. Déclaré APRÈS le gestionnaire de pièce
  // jointe : inscrit en dernier, le back referme d'abord le bandeau de réponse.
  const cleReponse = filId === null ? rid : `${rid}:${filId}`;
  const reponse = useReponse(cleReponse);
  const annulerCitation = useCallback(() => annulerReponse(cleReponse), [cleReponse]);
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
    // (`fichiers` ne peut pas être null ici : sans lui, ni 📎 ni 🎤 — rien ne
    // peut poser de pièce en attente. La garde contente le typage.)
    if (enAttente !== null && fichiers !== null) {
      setErreurFichier(null);
      setEnvoiFichier(true);
      const originale = enAttente;
      // `fichiers.envoyer` valide (taille/type), persiste l'intention puis
      // téléverse ; il ne REJETTE que sur un refus de validation. Tout le
      // reste — refus serveur ET réseau injoignable — devient une ligne du
      // bandeau de l'écran, désormais affichée QUEL QUE SOIT son statut : un
      // envoi hors ligne reste `en-attente` et n'aurait été visible nulle part.
      // On ne vide donc l'aperçu qu'au succès, sinon le fichier serait perdu.
      void (async () => {
        // La réduction promise par les pastilles se paie ICI (photo → JPEG
        // 1920 px, vidéo → MP4 H.264 720p via le module natif Media3) : le
        // spinner du 📎 couvre le transcodage puis le téléversement.
        const pret =
          qualite === 'reduite' && reductionProposable(originale)
            ? await reduirePieceJointe(originale)
            : originale;
        try {
          await fichiers.envoyer(rid, pret, texteAEnvoyer || undefined);
          // L'original du sélecteur ne sert plus : la version réduite est
          // partie (la file effacera SON fichier au solde de la ligne).
          if (pret.uri !== originale.uri) void supprimerSiTemporaire(originale.uri);
          setEnAttente(null);
          // La citation, elle, a été CONSOMMÉE par le message qui vient de
          // partir — son permalien est dans `texteAEnvoyer`, calculé avant
          // l'appel. La désarmer sans condition : sous la garde ci-dessous,
          // elle resterait armée et le message SUIVANT re-citerait la même
          // cible sans qu'on l'ait demandé.
          annulerReponse(cleReponse);
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
        } catch (e) {
          // Refus de validation : l'aperçu (l'original) reste en place ; la
          // version réduite orpheline s'efface — elle se recalculera si on
          // réessaie.
          if (pret.uri !== originale.uri) void supprimerSiTemporaire(pret.uri);
          setErreurFichier(
            phraseValidation(e, t) ??
              (e instanceof Error ? e.message : t('salon.televersementImpossible')),
          );
        } finally {
          setEnvoiFichier(false);
        }
      })();
      return;
    }
    if (legende === '') return;
    setBrouillon('');
    reinitialiser();
    effacerBrouillon();
    // L'aperçu optimiste de la citation : la version du serveur, qui porte les
    // vraies pièces jointes reconstruites du permalien, l'écrasera.
    const jointesLocales = reponse === null ? null : reponse.jointeLocale;
    annulerReponse(cleReponse);
    // L'affichage optimiste et la persistance de l'intention sont dans
    // `envoyer` : d'ici, rien à attendre. Un refus deviendra un statut
    // « échec » actionnable sur la ligne elle-même. `envoyer` résout avec
    // l'`_id` client dès l'écriture locale : le fil défile quand CE message
    // apparaît dans sa liste, pas après un délai.
    envoi
      .envoyer(rid, texteAEnvoyer, filId, jointesLocales)
      .then((idMessage) => apresEnvoi?.(idMessage))
      .catch((e: unknown) => console.warn('envoi: échec local', e));
  }, [
    brouillon,
    enAttente,
    qualite,
    envoi,
    fichiers,
    rid,
    filId,
    reponse,
    cleReponse,
    apresEnvoi,
    effacerBrouillon,
    reinitialiser,
    t,
  ]);

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

  // Pose un média/fichier choisi au-dessus du composer, en attente d'une
  // légende. La pièce reste l'ORIGINAL : la réduction éventuelle (7.3) se paie
  // à l'envoi, selon les pastilles de qualité de l'aperçu — « réduite » est
  // réarmé à chaque pose, le choix vaut pour UNE pièce, pas pour la session.
  // Validation (taille/type) et envoi arrivent au clic sur ➤ (voir `envoyer`).
  const poserPieceJointe = useCallback((piece: FichierEnAttente) => {
    // Choisir une SECONDE pièce sans envoyer la première abandonnait la
    // sienne : aucune ligne SQL ne l'avait jamais connue.
    if (enAttente !== null && enAttente.uri !== piece.uri) {
      void supprimerSiTemporaire(enAttente.uri);
    }
    setEnAttente(piece);
    setQualite('reduite');
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
      fermerFeuilleJoindre();
      if (!res.canceled) poserPieceJointe(assetVersFichier(res.assets[0]));
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
    if (!res.canceled) poserPieceJointe(assetVersFichier(res.assets[0]));
  }, [poserPieceJointe, fermerFeuilleJoindre]);

  const depuisFichier = useCallback(async () => {
    const choix = await lancerSelecteurAvecReprise(() =>
      DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }),
    );
    fermerFeuilleJoindre();
    if (choix.canceled || choix.assets.length === 0) return;
    const brut = choix.assets[0];
    poserPieceJointe({
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
          // Le même geste que le retour matériel : l'aperçu part ET son
          // fichier temporaire aussi — le ✕ seul laissait fuir le cache.
          onRetirer={retirerEnAttente}
          qualite={reductionProposable(enAttente) ? qualite : null}
          surQualite={setQualite}
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
        {fichiers !== null && (
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
        )}
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
          placeholder={enAttente !== null ? t('salon.ajouterLegende') : placeholder}
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
        ) : fichiers !== null ? (
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
        ) : null}
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

const styles = StyleSheet.create({
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
  noteComposer: {
    flex: 1,
    textAlign: 'center',
    fontFamily: POLICES.corps,
    fontSize: 13,
    paddingVertical: 8,
  },
});
