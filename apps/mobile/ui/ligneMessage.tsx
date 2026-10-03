/**
 * Ligne de message, partagée entre l'écran salon et l'écran fil (8.3).
 *
 * Extraite de `app/salon/[rid].tsx` : l'écran fil affiche exactement les
 * mêmes lignes (markdown, messages système, pièces jointes protégées,
 * statuts d'envoi) — la dupliquer aurait fait diverger les deux rendus.
 */

import { useRouter } from 'expo-router';
import {contexteAppel} from '../lib/appel.ts';
import {useSession} from './session.tsx';
import { memo, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ImageStyle,
  type StyleProp,
} from 'react-native';

import type { messages } from '../db/schema.ts';
import {
  estJointeCitation,
  PROFONDEUR_MAX_CITATION,
  texteCitation,
} from '../lib/citation.ts';
import { chiffrementDeJointe, type ChiffrementFichier } from '../lib/e2e/crypto.ts';
import { unicodeDeCodeCourt } from '../lib/emojis.ts';
import { urlEmojiCustom } from '../lib/emojisCustom.ts';
import {ImageEmoji,useCatalogueEmojis} from './imageEmoji.tsx';
import { arbreDuMessage } from '../lib/markdown.ts';
import { texteSysteme } from '../lib/messagesSysteme.ts';
import { listeReactions, type ReactionAffichee } from '../lib/reactions.ts';
import { ouvrirFicheProfil } from '../lib/profilPreload.ts';
import type { ClientRest } from '../lib/rest.ts';
import { urlAvatar, urlFichierProtege } from '../lib/upload.ts';
import { LiensEmbed } from './carteEmbed.tsx';
import { ApercusLien } from './carteLien.tsx';
import {carteIntegration} from '../lib/cartesIntegration.ts';
import {CarteIntegration} from './carteIntegration.tsx';
import { proposerTelechargerOuPartager } from './actionsJointe.ts';
import { BarreTransfert } from './barreTransfert.tsx';
import { fichierDechiffre } from './fichierJoint.ts';
import {abonnerFichierNatif} from '../lib/fichiersNatifs.ts';
import { useEtagsAvatars, useIdentites } from './identites.tsx';
import { useHeure, useT } from './i18n.ts';
import { TuileAvatar } from './kit.tsx';
import { LecteurAudio } from './lecteurAudio.tsx';
import { LecteurVideo } from './lecteurVideo.tsx';
import { CorpsMessage, GardeRendu } from './markdown.tsx';
import { TexteTappable } from './texteTappable.tsx';
import {
  type Couleurs,
  DELAI_PRESSION_LISTE,
  degradeAvatar,
  largeurDispoCorps,
  POLICES,
  useCouleurs,
} from './theme.ts';
import { useVisionneuse } from './visionneuse.tsx';
import { Appuyable } from './appuyable.tsx';

export type LigneDeMessage = typeof messages.$inferSelect;

export const LigneMessage = memo(function LigneMessage({
  c,
  message,
  client,
  statutEnvoi,
  surReessayer,
  surAbandonner,
  surAppuiLong,
  surAppui,
  surOuvrirFil,
  moi,
  surReagir,
  suite,
  heureRepetee,
}: {
  c: Couleurs;
  message: LigneDeMessage;
  client: ClientRest;
  statutEnvoi: 'en-attente' | 'echec' | null;
  surReessayer: (() => void) | null;
  surAbandonner: ((id: string) => void) | null;
  surAppuiLong: ((id: string) => void) | null;
  /** Toucher la ligne (liste des épinglés/favoris). Absent dans un flux. */
  surAppui?: ((id: string) => void) | undefined;
  /** Ouvre l'écran du fil. `null` dans l'écran fil lui-même. */
  surOuvrirFil: ((id: string) => void) | null;
  /** Mon username — marque mes réactions. `null` : rien n'est marqué mien. */
  moi: string | null;
  /** Pose/retire une réaction. `null` : pastilles en lecture seule (recherche). */
  surReagir: ((rid: string, id: string, code: string, mettre: boolean) => void) | null;
  /**
   * Continuation du message d'au-dessus (même auteur, sous 5 min — calculé par
   * `ui/groupeMessages`) : ni avatar ni pseudo/heure, le corps seul sur la
   * gouttière — les rafales d'un même auteur ne répètent pas son identité.
   */
  suite: boolean;
  /**
   * Suite dont l'heure affichée (à la minute) est déjà rendue au-dessus
   * (`ui/groupeMessages`, `idsHeuresRepetees`) : la gouttière reste vide —
   * même logique que pour l'avatar, on ne réécrit pas ce qui est à l'écran.
   */
  heureRepetee: boolean;
}) {
  const formatHeure = useHeure();
  const heure = formatHeure(message.horodatage);

  const appuiLong = surAppuiLong === null ? undefined : () => surAppuiLong(message.id);
  // Pseudo à AFFICHER, résolu par UID (`ui/identites`) : `auteurNom` est
  // l'instantané figé à l'ingestion, qui reste sur l'ANCIEN nom après un
  // renommage (on ne re-télécharge pas l'historique). La table d'identités,
  // tenue à jour, donne le pseudo courant ; on retombe sur l'instantané tant
  // qu'un uid n'y est pas encore connu (premier rendu, hors-ligne).
  const identites = useIdentites();
  const etags = useEtagsAvatars();
  const t = useT();
  const auteur = (identites.get(message.auteurId) ?? message.auteurNom) ?? '?';
  // Le pseudo prend la première teinte de sa propre tuile-avatar : nom et
  // avatar s'accordent, la même personne garde sa couleur d'un message à l'autre.
  const teinteAuteur = degradeAvatar(auteur, c.avatarsDegrades)[0];
  // Fiche de l'auteur au tap sur l'avatar ou le pseudo. Pas de fiche pour un
  // auteur sans username (message chiffré indéchiffrable : `auteurNom` null).
  // On ouvre par l'UID (`auteurId`), pas par le pseudo affiché : le pseudo est
  // un instantané figé à l'ingestion et devient PÉRIMÉ si la personne se renomme
  // (`users.info?username=ancien` → « user not found »). L'uid, lui, est
  // immuable — la fiche résout donc toujours le profil courant.
  // `ouvrirFicheProfil` précharge la fiche AVANT d'ouvrir la sheet (hauteur
  // finale dès la première frame, pas de saut) — voir lib/profilPreload.
  const ouvrirProfil =
    message.auteurNom === null
      ? undefined
      : () => void ouvrirFicheProfil({ uid: message.auteurId });

  // Les pièces jointes, citations (`message_link`) séparées des fichiers : la
  // citation se rend AU-DESSUS du corps — on lit d'abord ce à quoi on répond —
  // les fichiers restent en dessous.
  const jointes = useMemo(() => analyserJointes(message.piecesJointes), [message.piecesJointes]);
  const citations = jointes.filter((j) => estJointeCitation(j));
  const fichiersJoints = jointes.filter((j) => !estJointeCitation(j));

  // Les réactions, ENFIN lues : la colonne était écrite depuis le premier jour
  // et rafraîchie par le stream, mais aucun rendu ne la projetait — réagir ne
  // changeait rien à l'écran et rien n'était retirable (audit, chantier 11).
  const reactions = useMemo(
    () => listeReactions(message.reactions, moi),
    [message.reactions, moi],
  );

  return (
    <Pressable
      onLongPress={appuiLong}
      onPress={surAppui === undefined ? undefined : () => surAppui(message.id)}
      delayLongPress={350}
      // Sans quoi le Pressable fusionne la ligne en UN nœud d'accessibilité :
      // TalkBack ne peut plus atteindre « réessayer », « abandonner » ni les
      // pièces jointes individuellement.
      accessible={false}
      style={[
        styles.message,
        suite && styles.messageSuite,
        statutEnvoi === 'en-attente' && styles.enAttente,
      ]}
    >
      {suite && heureRepetee ? (
        // L'heure de cette suite est déjà affichée au-dessus (même minute) :
        // la gouttière garde sa largeur pour l'alignement, mais reste vide.
        <View style={styles.heureGouttiere} />
      ) : suite ? (
        // Une suite garde la GOUTTIÈRE de l'avatar (le corps reste aligné sur
        // celui du message de tête) et y loge SON heure, en tout petit — le
        // regroupement ne doit pas coûter l'information. `adjustsFontSizeToFit` :
        // l'heure anglaise (« 2:05 PM ») déborde 34 px à taille pleine — elle
        // se resserre plutôt que tronquer.
        <Text
          style={[styles.heureGouttiere, { color: c.texteTertiaire }]}
          numberOfLines={1}
          adjustsFontSizeToFit
        >
          {heure}
        </Text>
      ) : (
      /* La ligne est `accessible={false}` pour que TalkBack atteigne
          réessayer/abandonner/pièces jointes ; l'initiale décorative ne doit
          pas devenir un nœud de plus, elle double la navigation au balayage.
          (`importantForAccessibility` n'ôte que le nœud a11y — le tap marche.) */
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Pressable
          onPress={ouvrirProfil}
          unstable_pressDelay={DELAI_PRESSION_LISTE}
          style={({ pressed }) => (pressed && ouvrirProfil !== undefined ? styles.presseAvatar : null)}
        >
          <TuileAvatar
            c={c}
            cle={auteur}
            initiale={auteur.charAt(0) || '?'}
            // Avatar visé par le username COURANT (`identites`), uid en repli.
            // Par uid seul, l'URI `/avatar/uid/<uid>` ne change JAMAIS : le cache
            // image RN garde l'ancien avatar après un renommage, alors que le
            // reste de l'app (par `/avatar/<username>`) affiche le courant. Le
            // username courant fait bouger l'URI au renommage → le cache se
            // rafraîchit et reste cohérent avec l'écran profil.
            // L'`etag` (version de la photo) est ce qui rafraîchit l'image
            // quand la personne change d'avatar : par pseudo si on le connaît,
            // par uid sinon — les deux index pointent la même version.
            uri={urlAvatar(client, {
              username: identites.get(message.auteurId),
              uid: message.auteurId,
              etag:
                etags.parUsername.get(identites.get(message.auteurId) ?? '') ??
                etags.parUid.get(message.auteurId),
            })}
            taille={34}
            rayon={12}
          />
        </Pressable>
      </View>
      )}
      <View style={styles.corps}>
        {/* Une suite tait le pseudo et l'heure — mais « modifié » et
            « envoi… » restent dus au lecteur : leur ligne ne se rend que
            quand l'un d'eux a quelque chose à dire. */}
        {(!suite || message.modifieLe !== null || statutEnvoi === 'en-attente') && (
          <View style={styles.enTete}>
            {!suite && (
              <TexteTappable
                style={[styles.auteur, { color: teinteAuteur }]}
                numberOfLines={1}
                onPress={ouvrirProfil}
                accessibilityLabel={t('ligneMessage.profilDe', { nom: auteur })}
              >
                {auteur}
              </TexteTappable>
            )}
            {!suite && <Text style={[styles.heure, { color: c.texteTertiaire }]}>{heure}</Text>}
            {message.modifieLe !== null && (
              <Text style={[styles.heure, { color: c.texteTertiaire }]}>{t('ligneMessage.modifie')}</Text>
            )}
            {statutEnvoi === 'en-attente' && (
              <Text style={[styles.heure, { color: c.texteTertiaire }]}>{t('ligneMessage.envoiEnCours')}</Text>
            )}
          </View>
        )}
        {citations.map((jointe, i) => (
          <Citation key={i} c={c} jointe={jointe} client={client} surAppuiLong={appuiLong} />
        ))}
        <ContenuMessage c={c} message={message} />
        {message.typeSysteme === null && (
            <LiensEmbed c={c} client={client} texte={message.texte} urls={message.urls} surAppuiLong={appuiLong} />
        )}
        {message.typeSysteme === null && (
          <ApercusLien c={c} client={client} urls={message.urls} surAppuiLong={appuiLong} />
        )}
        {fichiersJoints.length > 0 && (
          <PiecesJointes
            c={c}
            jointes={fichiersJoints}
            client={client}
            surAppuiLong={appuiLong}
          />
        )}
        {reactions.length > 0 && (
          <View style={styles.reactions}>
            {reactions.map((reaction) => (
              <PastilleReaction
                key={reaction.code}
                c={c}
                reaction={reaction}
                // Le tap BASCULE : `chat.react` sait aussi retirer — câbler
                // `mettre` en dur à `true` rendait la réaction inannulable.
                surPresser={
                  surReagir === null
                    ? undefined
                    : () => surReagir(message.rid, message.id, reaction.code, !reaction.parMoi)
                }
              />
            ))}
          </View>
        )}
        {surOuvrirFil !== null && message.filReponses > 0 && (
          <Pressable
            onPress={() => surOuvrirFil(message.id)}
            style={[styles.puceFil, { backgroundColor: c.carte, borderColor: c.bordure }]}
          >
            <Text style={[styles.puceFilTexte, { color: c.cyan }]}>
              💬 {t('ligneMessage.reponses', { n: message.filReponses })}
              {message.filDernier !== null && ` · ${formatHeure(message.filDernier)}`}
            </Text>
          </Pressable>
        )}
        {statutEnvoi === 'echec' && (
          <View style={styles.actionsEchec}>
            <Pressable onPress={surReessayer ?? undefined}>
              <Text style={[styles.heure, { color: c.texteErreur }]}>{t('ligneMessage.echecReessayer')}</Text>
            </Pressable>
            <Pressable onPress={() => surAbandonner?.(message.id)}>
              <Text style={[styles.heure, { color: c.attenue }]}>{t('ligneMessage.abandonner')}</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Pressable>
  );
});

/**
 * Corps d'un message : markdown pour les messages ordinaires (`md` du serveur,
 * ou `parse()` local pour les VIEUX messages qui n'en ont pas — repli imposé
 * par le contrat 4.3), substitut sobre pour le chiffré et les messages
 * système (leur traduction arrive en 4.4).
 */
function ContenuMessage({ c, message }: { c: Couleurs; message: LigneDeMessage }) {
  const t = useT();
  // Clés = les CHAÎNES, stables à travers le barattage d'objets de
  // `useLiveQuery` (qui défait le memo de LigneMessage) : sans cela, chaque
  // écriture en base re-parserait le markdown de toutes les lignes visibles.
  // Un message chiffré DÉCHIFFRÉ (déverrouillé) porte encore `t: 'e2e'` mais a
  // un `texte` : il se rend alors comme un message ordinaire (son `md` est null,
  // `arbreDuMessage` parse le texte clair). Verrouillé, `texte` est null.
  const chiffreDechiffre = message.typeSysteme === 'e2e' && message.texte !== null;
  const estOrdinaire = message.typeSysteme === null || chiffreDechiffre;
  const arbre = useMemo(
    () => (estOrdinaire ? arbreDuMessage(message.md, message.texte) : null),
    [estOrdinaire, message.md, message.texte],
  );

  if (message.typeSysteme === 'e2e' && message.texte === null) {
    return <Substitut c={c} texte={t('ligneMessage.chiffre')} />;
  }
  if (message.typeSysteme === 'videoconf') {
    return <CarteAppel c={c} callId={message.appelId} rid={message.rid} />;
  }
  if (message.typeSysteme !== null && !chiffreDechiffre) {
    // La phrase suit le nom de l'auteur affiché juste au-dessus : « bob a
    // rejoint le salon ». `texte` porte le PARAMÈTRE de l'action, pas une
    // phrase — voir lib/messagesSysteme.ts.
    return <Substitut c={c} texte={texteSysteme(t, message.typeSysteme, message.texte)} />;
  }
  if (arbre === null) {
    // Un message d'upload n'a souvent NI texte NI md : ses pièces jointes,
    // rendues à côté, sont tout son contenu — rien à substituer.
    if (message.piecesJointes !== null) return null;
    return <Substitut c={c} texte={t('ligneMessage.messageVide')} />;
  }
  return (
    // Le `md` est en dernier ressort une donnée d'autrui : une forme qui
    // échappe aux validations ne doit coûter que ce message, pas l'écran.
    // La `key` fait RENAÎTRE la garde quand le CONTENU change : sans elle,
    // `casse` restait armé pour toujours et l'édition qui corrige un `md`
    // mal formé laissait le message figé sur son texte nu jusqu'au recyclage
    // de la cellule (le garde-fou était le seul maillon sans réarmement).
    <GardeRendu
      key={message.md ?? message.texte ?? ''}
      repli={<Text style={[styles.texte, { color: c.texte }]}>{message.texte}</Text>}
    >
      <CorpsMessage arbre={arbre} c={c} />
    </GardeRendu>
  );
}

function Substitut({ c, texte }: { c: Couleurs; texte: string }) {
  return <Text style={[styles.texte, styles.italique, { color: c.attenue }]}>{texte}</Text>;
}

/**
 * Une pastille de réaction : l'emoji (glyphe standard, image custom, ou `:nom:`
 * littéral en dernier ressort — même ordre de résolution que le corps des
 * messages) et le compteur. Contour et compteur ACCENTUÉS quand ma réaction y
 * figure : c'est aussi l'indice que le tap retire au lieu d'ajouter.
 */
function PastilleReaction({
  c,
  reaction,
  surPresser,
}: {
  c: Couleurs;
  reaction: ReactionAffichee;
  surPresser: (() => void) | undefined;
}) {
  useCatalogueEmojis();
  const glyphe = unicodeDeCodeCourt(reaction.code);
  const uri = glyphe === null ? urlEmojiCustom(reaction.code) : null;
  return (
    <Pressable
      onPress={surPresser}
      disabled={surPresser === undefined}
      unstable_pressDelay={DELAI_PRESSION_LISTE}
      accessibilityRole="button"
      accessibilityState={{ selected: reaction.parMoi }}
      accessibilityLabel={`:${reaction.code}: ${reaction.total}`}
      style={({ pressed }) => [
        styles.pastilleReaction,
        {
          backgroundColor: c.carte,
          borderColor: reaction.parMoi ? c.accent : c.bordure,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      {glyphe !== null ? (
        <Text style={styles.reactionEmoji}>{glyphe}</Text>
      ) : uri !== null ? (
        <ImageEmoji uri={uri} style={styles.reactionImage} code={reaction.code}/>
      ) : (
        <Text style={[styles.reactionCode, { color: c.attenue }]} numberOfLines={1}>
          :{reaction.code}:
        </Text>
      )}
      <Text
        style={[styles.reactionTotal, { color: reaction.parMoi ? c.accent : c.attenue }]}
      >
        {reaction.total}
      </Text>
    </Pressable>
  );
}

/**
 * Le message CITÉ, au-dessus de la réponse : trait accent, auteur, texte en
 * italique, SES pièces (images en vignette) et — s'il était lui-même une
 * réponse — sa propre citation, imbriquée. Rend la pièce jointe `message_link`
 * que le serveur attache à un message-citation (`lib/citation.ts`) — le même
 * bloc que dessinent les clients officiels, donc les citations croisées entre
 * apps restent lisibles. La chaîne s'arrête à `PROFONDEUR_MAX_CITATION` (2),
 * la taille que produit le serveur (`Message_QuoteChainLimit` par défaut).
 */
function Citation({
  c,
  jointe,
  client,
  surAppuiLong,
  profondeur = 1,
}: {
  c: Couleurs;
  jointe: PieceJointe;
  client: ClientRest;
  surAppuiLong: (() => void) | undefined;
  profondeur?: number;
}) {
  const t = useT();
  // Le cité peut être lui-même une réponse : on ne montre que ses mots, pas
  // son permalien de citation — sa citation s'affiche en bloc imbriqué.
  const texte = texteCitation(jointe).trim();
  const auteur = typeof jointe.author_name === 'string' ? jointe.author_name : null;
  const imbriquees = Array.isArray(jointe.attachments) ? jointe.attachments : [];
  const sousCitations =
    profondeur < PROFONDEUR_MAX_CITATION ? imbriquees.filter((j) => estJointeCitation(j)) : [];
  const fichiers = imbriquees.filter((j) => !estJointeCitation(j));
  const vide = texte === '' && sousCitations.length === 0 && fichiers.length === 0;
  return (
    <Pressable
      onLongPress={surAppuiLong}
      delayLongPress={350}
      style={[styles.citation, { borderLeftColor: c.accent, backgroundColor: c.carte }]}
    >
      {auteur !== null && (
        <Text style={[styles.citationAuteur, { color: c.accent }]} numberOfLines={1}>
          {auteur}
        </Text>
      )}
      {sousCitations.map((sous, i) => (
        <Citation
          key={i}
          c={c}
          jointe={sous}
          client={client}
          surAppuiLong={surAppuiLong}
          profondeur={profondeur + 1}
        />
      ))}
      {texte !== '' && (
        <Text style={[styles.texte, styles.italique, { color: c.attenue }]} numberOfLines={4}>
          {texte}
        </Text>
      )}
      {fichiers.map((fichier, i) => (
        <FichierCite key={i} c={c} jointe={fichier} client={client} surAppuiLong={surAppuiLong} />
      ))}
      {vide && (
        <Text style={[styles.texte, styles.italique, { color: c.attenue }]}>
          {jointe.native_unavailable === true ? t('citation.indisponible') : `📎 ${t('commun.pieceJointe')}`}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Une pièce du message cité, en réduit : l'image en vignette tapable (la
 * visionneuse ouvre l'original), le reste en une ligne titrée — le bloc de
 * citation résume, il ne rejoue pas les lecteurs audio/vidéo.
 */
function FichierCite({
  c,
  jointe,
  client,
  surAppuiLong,
}: {
  c: Couleurs;
  jointe: PieceJointe;
  client: ClientRest;
  surAppuiLong: (() => void) | undefined;
}) {
  const t = useT();
  if (typeof jointe.image_url === 'string') {
    if(jointe.native_file)return <JointeNative c={c} jointe={jointe} client={client} largeurMax={LARGEUR_IMAGE_CITEE} surAppuiLong={surAppuiLong} citee/>;
    // Bornes égales = largeur FIXE : une vignette, pas la pièce plein cadre.
    return (
      <ImageJointe
        jointe={jointe}
        client={client}
        largeurMin={LARGEUR_IMAGE_CITEE}
        largeurMax={LARGEUR_IMAGE_CITEE}
        hauteurMin={72}
        hauteurMax={200}
        style={styles.imageCitee}
        surAppuiLong={surAppuiLong}
      />
    );
  }
  const glyphe =
    typeof jointe.audio_url === 'string' ? '🎵' : typeof jointe.video_url === 'string' ? '🎬' : '📎';
  return (
    <Text style={[styles.texte, styles.italique, { color: c.attenue }]} numberOfLines={1}>
      {glyphe} {jointe.title ?? t('commun.pieceJointe')}
    </Text>
  );
}

/** Largeur fixe des images citées : une vignette, pas la pièce plein cadre. */
const LARGEUR_IMAGE_CITEE = 200;

/**
 * Une image jointe — du bloc citation comme du corps du message : choix de la
 * source, URL protégée, gabarit borné et ouverture en visionneuse. Était écrit
 * deux fois dans ce fichier, avec des bornes déjà divergées.
 *
 * Rocket.Chat génère une VIGNETTE ~480 px (`image_url`) et conserve l'ORIGINAL
 * pleine résolution dans `title_link`. Afficher la vignette la rendait
 * pixelisée dès qu'on l'agrandissait : on prend donc l'original, en le
 * laissant se sous-échantillonner à la taille d'affichage. Repli sur
 * `image_url` si le serveur ne génère pas de vignette (l'original EST alors
 * `image_url`).
 *
 * Le gabarit : largeur naturelle bornée à [largeurMin, largeurMax] (bornes
 * égales = largeur fixe, le cas de la vignette citée), hauteur au ratio de
 * l'original bornée à [hauteurMin, hauteurMax] — un portrait très haut est
 * plafonné (et recadré par `cover`) : la vue en grand, au toucher, montre
 * l'image entière. `image_dimensions` décrit la vignette, mais son RATIO est
 * celui de l'original — parfait pour le gabarit ; carré quand il manque.
 */
function ImageJointe({
  jointe,
  client,
  largeurMin,
  largeurMax,
  hauteurMin,
  hauteurMax,
  style,
  surAppuiLong,
  local,
}: {
  jointe: PieceJointe;
  client: ClientRest;
  largeurMin: number;
  largeurMax: number;
  hauteurMin: number;
  hauteurMax: number;
  /** L'habillage (rayon, marges, fond d'attente) reste à l'appelant. */
  style: StyleProp<ImageStyle>;
  surAppuiLong: (() => void) | undefined;
  /** Fichier clair déjà dans le cache (image chiffrée) : affiché tel quel. */
  local?: string;
}) {
  const visionneuse = useVisionneuse();
  const t = useT();
  const c = useCouleurs();
  if (typeof jointe.image_url !== 'string') return null;
  const source = typeof jointe.title_link === 'string' ? jointe.title_link : jointe.image_url;
  const url = local ?? urlFichierProtege(client, source);
  const reelLargeur = jointe.image_dimensions?.width ?? null;
  const reelHauteur = jointe.image_dimensions?.height ?? null;
  const largeur = Math.max(Math.min(reelLargeur ?? largeurMax, largeurMax), largeurMin);
  const ratio = (reelHauteur ?? largeur) / Math.max(reelLargeur ?? largeur, 1);
  const hauteur = Math.min(Math.max(Math.round(largeur * ratio), hauteurMin), hauteurMax);
  return (
    <Pressable
      onPress={() =>
        visionneuse.ouvrir({
          uri: url,
          largeur: reelLargeur,
          hauteur: reelHauteur,
          titre: jointe.title ?? null,
          type: jointe.image_type ?? null,
          cle: source,
          taille: jointe.image_size ?? null,
        })
      }
      onLongPress={surAppuiLong}
      delayLongPress={350}
      accessibilityRole="imagebutton"
      accessibilityLabel={jointe.title ?? t('ligneMessage.imageAgrandir')}
    >
      <Image
        source={{ uri: url }}
        style={[style, { width: largeur, height: hauteur }]}
        resizeMode="cover"
      />
      <BarreTransfert cle={source} c={c} rayon={10} />
    </Pressable>
  );
}

/**
 * Carte d'un message d'appel (`t: 'videoconf'`) : « Appel vidéo » et un bouton
 * Rejoindre qui ouvre l'écran d'appel (WebView Jitsi). Sans `callId` — vieux
 * message d'avant la persistance du bloc, ou bloc illisible — on n'offre pas de
 * jonction, juste l'étiquette : mieux qu'un bouton qui ne saurait où aller.
 */
function CarteAppel({ c, callId,rid }: { c: Couleurs; callId: string | null;rid:string }) {
  const routeur = useRouter();
  const t = useT();
  const {etat}=useSession();
  return (
    <View style={[styles.carteAppel, { backgroundColor: c.carte, borderColor: c.bordure }]}>
      <Text style={[styles.carteAppelTitre, { color: c.texte }]}>{t('ligneMessage.appelVideo')}</Text>
      {callId !== null && (
        <Appuyable
          onPress={() => {if(etat.phase==='connecte')routeur.push({ pathname: '/appel/[callId]', params: { callId,rid,compte:contexteAppel(etat.client) } });}}
          android_ripple={{ color: c.ondulation }}
          unstable_pressDelay={DELAI_PRESSION_LISTE}
          accessibilityRole="button"
          accessibilityLabel={t('ligneMessage.rejoindreAppel')}
          style={({ pressed }) => [
            styles.rejoindre,
            { backgroundColor: c.accent, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={[styles.rejoindreTexte, { color: c.surAccent }]}>{t('ligneMessage.rejoindre')}</Text>
        </Appuyable>
      )}
    </View>
  );
}

type PieceJointe = {
  native_file?: unknown;
  native_unavailable?: boolean;
  title?: string;
  title_link?: string;
  image_url?: string;
  image_type?: string;
  image_size?: number;
  /** Poids d'une pièce « fichier », en octets. */
  size?: number;
  audio_url?: string;
  audio_type?: string;
  audio_size?: number;
  video_url?: string;
  video_type?: string;
  video_size?: number;
  /** Fichier d'un salon chiffré : sa clé et son compteur (`lib/e2e/crypto.ts`). */
  encryption?: unknown;
  hashes?: unknown;
  image_dimensions?: { width?: number; height?: number };
  /** Citation (reply-quote) : permalien du message cité — voir lib/citation.ts. */
  message_link?: string;
  author_name?: string;
  text?: string;
  /** Pièces du message CITÉ (images, fichiers… et sa propre citation, niveau 2). */
  attachments?: PieceJointe[];
};

/** `piecesJointes` (JSON sérialisé) en tableau — tolérant, comme tout ce qui vient d'autrui. */
function analyserJointes(brut: string | null): PieceJointe[] {
  if (brut === null) return [];
  try {
    const liste = JSON.parse(brut) as unknown;
    return Array.isArray(liste) ? (liste as PieceJointe[]) : [];
  } catch {
    return [];
  }
}

/**
 * Pièces jointes (7.4) : `FileUpload_ProtectFiles = true` sur le serveur
 * cible — chaque URL de fichier reçoit `rc_uid`/`rc_token` en query, sinon
 * le serveur répond 403 et l'image reste blanche.
 *
 * `surAppuiLong` est transmis à chaque élément tapable : un toucher qui
 * démarre sur un enfant Pressable ne remonte jamais au Pressable de la ligne,
 * et un message d'upload (sans texte) n'offrirait AUCUNE surface pour la
 * feuille d'actions.
 */
function PiecesJointes({
  c,
  jointes,
  client,
  surAppuiLong,
}: {
  c: Couleurs;
  jointes: PieceJointe[];
  client: ClientRest;
  surAppuiLong: (() => void) | undefined;
}) {
  const { width: largeurEcran } = useWindowDimensions();
  const dispoLargeur = largeurDispoCorps(largeurEcran);

  return (
    <View style={styles.jointes}>
      {jointes.map((jointe, i) => {
        const carte=carteIntegration(jointe);
        if(carte)return <CarteIntegration key={i} c={c} carte={carte} surAppuiLong={surAppuiLong}/>;
        const chiffrement = chiffrementDeJointe(jointe);
        if (chiffrement !== null) {
          return (
            <JointeChiffree
              key={i}
              c={c}
              jointe={jointe}
              chiffrement={chiffrement}
              client={client}
              largeurMax={dispoLargeur}
              surAppuiLong={surAppuiLong}
            />
          );
        }
        if(client.genre==='rocketvibe'&&typeof jointe.title_link==='string'){
          return <JointeNative key={i} c={c} jointe={jointe} client={client} largeurMax={dispoLargeur} surAppuiLong={surAppuiLong}/>;
        }
        if (typeof jointe?.image_url === 'string') {
          return (
            <ImageJointe
              key={i}
              jointe={jointe}
              client={client}
              largeurMin={120}
              largeurMax={dispoLargeur}
              hauteurMin={0}
              hauteurMax={400}
              style={styles.imageJointe}
              surAppuiLong={surAppuiLong}
            />
          );
        }
        if (typeof jointe?.audio_url === 'string') {
          const url = urlFichierProtege(client, jointe.audio_url);
          return (
            <LecteurAudio
              key={i}
              c={c}
              url={url}
              titre={jointe.title ?? null}
              surAppuiLong={surAppuiLong}
            />
          );
        }
        if (typeof jointe?.video_url === 'string') {
          // Une vidéo porte AUSSI `title_link` (l'original) : cette branche doit
          // passer AVANT la branche « fichier » générique, sinon la vidéo n'y
          // serait qu'un lien ouvert dans le navigateur.
          const url = urlFichierProtege(client, jointe.video_url);
          return (
            <LecteurVideo
              key={i}
              c={c}
              url={url}
              titre={jointe.title ?? null}
              surAppuiLong={surAppuiLong}
              superposition={
                <BarreTransfert cle={jointe.title_link ?? jointe.video_url} c={c} rayon={14} />
              }
            />
          );
        }
        if (typeof jointe?.title_link === 'string') {
          return (
            <JointeFichier
              key={i}
              c={c}
              client={client}
              chemin={jointe.title_link}
              titre={jointe.title ?? null}
              taille={jointe.size ?? null}
              surAppuiLong={surAppuiLong}
            />
          );
        }
        return null;
      })}
    </View>
  );
}

/**
 * Pièce jointe « fichier » (PDF, archive, tableur, APK…) : au toucher, le choix
 * — télécharger ou partager — vient AVANT tout téléchargement ; celui-ci suit
 * en fond, sa progression sous le nom (\`ui/actionsJointe.ts\`).
 *
 * L'URL protégée (\`rc_uid\` et \`rc_token\` en query) ne quitte jamais le
 * processus : elle était remise à \`Linking.openURL\`, donc à Chrome, à son
 * historique et à sa synchronisation, et un \`rc_token\` vaut le compte entier.
 */
/** Resolve a private local file, then use exactly the existing media components. */
function JointeNative({c,jointe,client,largeurMax,surAppuiLong,citee=false}:{c:Couleurs;jointe:PieceJointe;client:ClientRest;largeurMax:number;surAppuiLong:(()=>void)|undefined;citee?:boolean}){
  const source=jointe.title_link!,genre=jointe.image_url?'image':jointe.audio_url?'audio':jointe.video_url?'video':null;
  const url=urlFichierProtege(client,source);
  const [loaded,setLoaded]=useState<{url:string;local:string|null;failed:boolean}|null>(null);
  const local=loaded?.url===url?loaded.local:null,failed=loaded?.url===url&&loaded.failed;
  useEffect(()=>{
    if(!genre)return;
    let active=true;
    let attempt=0;
    const load=()=>{
      const current=++attempt;
      fichierDechiffre({url,titre:jointe.title,type:jointe.image_type??jointe.audio_type??jointe.video_type,taille:jointe.size})
        .then(value=>{if(active&&current===attempt)setLoaded({url,local:value,failed:false});},()=>{if(active&&current===attempt)setLoaded({url,local:null,failed:true});});
    };
    load();
    const stop=abonnerFichierNatif(url,()=>{setLoaded({url,local:null,failed:false});load();});
    return()=>{active=false;stop();};
  },[genre,url,jointe.title,jointe.image_type,jointe.audio_type,jointe.video_type,jointe.size]);
  if(citee&&failed)return <Text style={[styles.texte,styles.italique,{color:c.attenue}]} numberOfLines={1}>📎 {jointe.title}</Text>;
  if(!genre||failed)return <JointeFichier c={c} client={client} chemin={source} titre={jointe.title??null} taille={jointe.size??null} surAppuiLong={surAppuiLong}/>;
  if(!local)return <ActivityIndicator color={c.accent}/>;
  if(genre==='image')return <ImageJointe jointe={jointe} client={client} local={local} largeurMin={citee?LARGEUR_IMAGE_CITEE:120} largeurMax={largeurMax} hauteurMin={citee?72:0} hauteurMax={citee?200:400} style={citee?styles.imageCitee:styles.imageJointe} surAppuiLong={surAppuiLong}/>;
  if(genre==='audio')return <LecteurAudio c={c} url={local} titre={jointe.title??null} surAppuiLong={surAppuiLong}/>;
  return <LecteurVideo c={c} url={local} titre={jointe.title??null} surAppuiLong={surAppuiLong}/>;
}

function JointeFichier({
  c,
  client,
  chemin,
  titre,
  taille,
  surAppuiLong,
  chiffrement = null,
}: {
  c: Couleurs;
  client: ClientRest;
  chemin: string;
  titre: string | null;
  taille: number | null;
  surAppuiLong: (() => void) | undefined;
  chiffrement?: ChiffrementFichier | null;
}) {
  const t = useT();
  // Pas de MIME : \`attachments\` n'en porte pas pour un fichier (son \`type\`
  // vaut « file »). C'est l'extension du nom qui oriente le système.
  const choisir = () =>
    proposerTelechargerOuPartager(
      { cle: chemin, url: urlFichierProtege(client, chemin), titre, type: null, taille, chiffrement },
      t,
    );

  return (
    <Pressable onPress={choisir} onLongPress={surAppuiLong} delayLongPress={350}>
      <Text style={[styles.texte, { color: c.accent }]} numberOfLines={2}>
        📄 {titre ?? t('ligneMessage.fichier')}
      </Text>
      <BarreTransfert cle={chemin} c={c} />
    </Pressable>
  );
}

/** Au-delà, un média chiffré ne se déchiffre pas pour l'aperçu : il se partage ou s'enregistre. */
const APERCU_CHIFFRE_MAX = 25 * 1024 * 1024;

/**
 * Pièce jointe d'un salon chiffré. Le serveur ne détient que du chiffré : une
 * image, un son ou une vidéo se télécharge et se déchiffre dans le cache avant
 * d'être montré, puis se rend comme en clair. Un autre fichier (ou un média
 * trop lourd) reste une carte, déchiffrée au partage ou à l'enregistrement.
 */
function JointeChiffree({
  c,
  jointe,
  chiffrement,
  client,
  largeurMax,
  surAppuiLong,
}: {
  c: Couleurs;
  jointe: PieceJointe;
  chiffrement: ChiffrementFichier;
  client: ClientRest;
  largeurMax: number;
  surAppuiLong: (() => void) | undefined;
}) {
  const t = useT();
  const chemin = jointe.title_link ?? jointe.image_url ?? jointe.video_url ?? jointe.audio_url;
  const genre =
    typeof jointe.image_url === 'string'
      ? 'image'
      : typeof jointe.video_url === 'string'
        ? 'video'
        : typeof jointe.audio_url === 'string'
          ? 'audio'
          : null;
  const taille = jointe.image_size ?? jointe.video_size ?? jointe.audio_size ?? jointe.size ?? null;
  const type = jointe.image_type ?? jointe.video_type ?? jointe.audio_type ?? null;
  const apercu = genre !== null && chemin !== undefined && (taille ?? 0) <= APERCU_CHIFFRE_MAX;
  const [local, setLocal] = useState<string | null>(null);
  const [echec, setEchec] = useState(false);

  useEffect(() => {
    if (!apercu || chemin === undefined) return;
    let actif = true;
    fichierDechiffre({
      url: urlFichierProtege(client, chemin),
      titre: jointe.title,
      type,
      taille,
      chiffrement,
    }).then(
      (uri) => {
        if (actif) setLocal(uri);
      },
      () => {
        if (actif) setEchec(true);
      },
    );
    return () => {
      actif = false;
    };
  }, [apercu, chemin, client, jointe.title, type, taille, chiffrement]);

  if (chemin === undefined) return null;
  if (!apercu) {
    return (
      <JointeFichier
        c={c}
        client={client}
        chemin={chemin}
        titre={jointe.title ?? null}
        taille={taille}
        surAppuiLong={surAppuiLong}
        chiffrement={chiffrement}
      />
    );
  }
  if (echec) return <Substitut c={c} texte={t('ligneMessage.fichierIllisible')} />;
  if (local === null) {
    return (
      <View style={[styles.imageJointe, styles.attenteChiffree]}>
        <ActivityIndicator color={c.attenue} />
      </View>
    );
  }
  if (genre === 'image') {
    return (
      <ImageJointe
        jointe={jointe}
        client={client}
        largeurMin={120}
        largeurMax={largeurMax}
        hauteurMin={0}
        hauteurMax={400}
        style={styles.imageJointe}
        surAppuiLong={surAppuiLong}
        local={local}
      />
    );
  }
  if (genre === 'audio') {
    return <LecteurAudio c={c} url={local} titre={jointe.title ?? null} surAppuiLong={surAppuiLong} />;
  }
  return <LecteurVideo c={c} url={local} titre={jointe.title ?? null} surAppuiLong={surAppuiLong} />;
}

const styles = StyleSheet.create({
  message: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  // Suite d'un même auteur : collée au message de tête (l'écart intra-groupe
  // se réduit au paddingBottom du dessus), gouttière = largeur de la tuile,
  // occupée par l'heure du message. `lineHeight` = celle du corps : l'heure
  // s'aligne sur la première ligne de texte.
  messageSuite: { paddingTop: 0 },
  heureGouttiere: {
    width: 34,
    fontFamily: POLICES.corps,
    fontSize: 9,
    lineHeight: 20,
    textAlign: 'center',
  },
  corps: { flex: 1, gap: 2 },
  enAttente: { opacity: 0.55 },
  enTete: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  presseAvatar: { opacity: 0.55 },
  auteur: { fontFamily: POLICES.corpsFort, fontSize: 13.5, flexShrink: 1 },
  heure: { fontFamily: POLICES.corps, fontSize: 10.5 },
  texte: { fontFamily: POLICES.corps, fontSize: 14, lineHeight: 20 },
  italique: { fontStyle: 'italic' },
  actionsEchec: { flexDirection: 'row', gap: 16 },
  citation: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 2,
    gap: 1,
  },
  citationAuteur: { fontFamily: POLICES.corpsGras, fontSize: 12 },
  // La largeur et la hauteur viennent du gabarit d'`ImageJointe`.
  imageCitee: {
    maxWidth: '100%',
    borderRadius: 8,
    backgroundColor: '#00000010',
    marginVertical: 2,
  },
  jointes: { gap: 6, marginTop: 4 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  pastilleReaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  reactionEmoji: { fontSize: 14 },
  reactionImage: { width: 16, height: 16 },
  reactionCode: { fontFamily: POLICES.corps, fontSize: 11, maxWidth: 90 },
  reactionTotal: { fontFamily: POLICES.corpsGras, fontSize: 12 },
  imageJointe: { borderRadius: 10, backgroundColor: '#00000010' },
  attenteChiffree: { width: 160, height: 120, alignItems: 'center', justifyContent: 'center' },
  puceFil: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 5,
    marginTop: 5,
  },
  puceFilTexte: { fontFamily: POLICES.corpsGras, fontSize: 12 },
  carteAppel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: 12,
    borderWidth: 1,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    marginTop: 4,
  },
  carteAppelTitre: { fontFamily: POLICES.corpsGras, fontSize: 14, flexShrink: 1 },
  rejoindre: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 7 },
  rejoindreTexte: { fontFamily: POLICES.corpsFort, fontSize: 13 },
});
