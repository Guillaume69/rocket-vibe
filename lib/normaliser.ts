/**
 * Traduction des charges utiles Rocket.Chat vers les lignes locales.
 *
 * Module pur : aucun accès réseau, aucune base. C'est ici que se concentrent
 * les bizarreries du serveur, pour qu'elles ne se répandent pas ailleurs.
 */

/** Le serveur envoie soit `{"$date": epochMs}` (EJSON), soit une chaîne ISO. */
export function versEpoch(valeur: unknown): number | null {
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return valeur;
  if (typeof valeur === 'string') {
    const t = Date.parse(valeur);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof valeur === 'object' && valeur !== null) {
    const brut = (valeur as { $date?: unknown }).$date;
    if (typeof brut === 'number' && Number.isFinite(brut)) return brut;
    if (typeof brut === 'string') {
      const t = Date.parse(brut);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

export type MessageLocal = {
  id: string;
  rid: string;
  texte: string | null;
  horodatage: number;
  auteurId: string;
  auteurNom: string | null;
  typeSysteme: string | null;
  filId: string | null;
  filReponses: number;
  filDernier: number | null;
  filAffiche: boolean;
  modifieLe: number | null;
  md: string | null;
  piecesJointes: string | null;
  reactions: string | null;
  /** Métadonnées de lien parsées par le serveur (`urls`), sérialisées. */
  urls: string | null;
  /** `callId` d'un message d'appel (`t: 'videoconf'`), extrait du bloc. */
  appelId: string | null;
  /**
   * Objet `content` d'un message chiffré (`rc.v2.aes-sha2`), sérialisé. On le
   * GARDE — contrairement au reste, où le blob chiffré est jeté — pour pouvoir
   * déchiffrer APRÈS coup, au déverrouillage (E2EE, étape 10). `null` hors
   * message chiffré, ou pour un chiffrement hérité `rc.v1` (dans `msg`, non
   * pris en charge). Ce n'est pas du clair : rien à afficher tel quel.
   */
  chiffreBrut: string | null;
  misAJourLe: number;
};

export type SalonLocal = {
  rid: string;
  type: string;
  nom: string | null;
  nomAffiche: string | null;
  chiffre: boolean;
  lectureSeule: boolean;
  /** L'autre participant d'un DM à deux — voir `versSalon`. */
  dmAutreUid: string | null;
  /**
   * Son PSEUDO. **Transporté, pas stocké dans `salons`** : il sert au dépôt à
   * inscrire l'autre dans `utilisateurs` (uid ↔ pseudo). Sans cette ligne,
   * l'événement `updateAvatar` — qui ne désigne l'utilisateur QUE par son
   * pseudo — ne trouve rien à mettre à jour, et l'avatar du DM reste figé :
   * la liste des salons affiche des gens dont aucun message n'a été ingéré.
   */
  dmAutreUsername: string | null;
  dernierMessage: string | null;
  /**
   * Le `t` du dernier message — ce qui sépare « salon vidé » de « dernier
   * message sans texte à montrer ». Voir `db/schema.ts` et `apercuDuDernier`.
   */
  dernierMessageType: string | null;
  horodatageDernierMessage: number | null;
  /** `avatarETag` : version de la photo du salon, cache-buster de son URL. */
  avatarEtag: string | null;
  misAJourLe: number;
};

export type AbonnementLocal = {
  rid: string;
  /** `_id` de l'abonnement — la seule clé que portent les `remove[]` du rattrapage. */
  subId: string | null;
  nonLus: number;
  mentions: number;
  mentionsGroupe: number;
  alerte: boolean;
  ouvert: boolean;
  favori: boolean;
  luJusquA: number | null;
  /** `E2EKey` : clé AES du salon chiffrée RSA pour ce membre (keyID + base64). */
  e2eKey: string | null;
  /** `e2eKeyId` : UUID de la clé de salon, quand le serveur le fournit à part. */
  e2eKeyId: string | null;
  misAJourLe: number;
};

const chaine = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const entier = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const booleen = (v: unknown): boolean => v === true;
const jsonOuNull = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

/** Un message chiffré n'est pas déchiffrable ici : on n'expose jamais le blob. */
export const TYPE_CHIFFRE = 'e2e';

/** Type système d'un message de visioconférence Rocket.Chat. */
export const TYPE_APPEL = 'videoconf';

/**
 * Le message d'appel porte son `callId` dans un bloc `video_conf` (`appId:
 * 'videoconf-core'`), PAS dans son `_id` : les deux diffèrent (vérifié sur la
 * source RC). On extrait le premier bloc de ce type ; le reste des `blocks`
 * (UI-kit générique) ne nous sert pas et n'est pas conservé.
 */
function callIdDuBloc(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b !== null && typeof b === 'object') {
      const bloc = b as { type?: unknown; callId?: unknown };
      if (bloc.type === 'video_conf') return chaine(bloc.callId);
    }
  }
  return null;
}

export function versMessage(brut: Record<string, unknown>): MessageLocal | null {
  const id = chaine(brut._id);
  const rid = chaine(brut.rid);
  const horodatage = versEpoch(brut.ts);
  const auteur = brut.u as { _id?: unknown; username?: unknown } | undefined;
  const auteurId = chaine(auteur?._id);
  if (id === null || rid === null || horodatage === null || auteurId === null) return null;

  const typeSysteme = chaine(brut.t);
  // `msg` d'un message chiffré contient du base64 opaque. Le stocker inviterait
  // à l'afficher un jour par accident.
  const chiffre = typeSysteme === TYPE_CHIFFRE;

  return {
    id,
    rid,
    texte: chiffre ? null : chaine(brut.msg),
    horodatage,
    auteurId,
    auteurNom: chaine(auteur?.username),
    typeSysteme,
    filId: chaine(brut.tmid),
    filReponses: entier(brut.tcount),
    filDernier: versEpoch(brut.tlm),
    filAffiche: booleen(brut.tshow),
    modifieLe: versEpoch(brut.editedAt),
    md: chiffre ? null : jsonOuNull(brut.md),
    piecesJointes: chiffre ? null : jsonOuNull(brut.attachments),
    reactions: jsonOuNull(brut.reactions),
    // Rien à prévisualiser pour un salon chiffré ; sinon on garde `urls` brut,
    // parsé au rendu (`lib/apercuLien.ts`).
    urls: chiffre ? null : jsonOuNull(brut.urls),
    appelId: typeSysteme === TYPE_APPEL ? callIdDuBloc(brut.blocks) : null,
    // Le `content` chiffré est conservé pour un déchiffrement différé ; le `msg`
    // opaque, lui, ne l'est jamais (voir `texte`).
    chiffreBrut: chiffre ? jsonOuNull(brut.content) : null,
    // `_updatedAt` est l'horloge du serveur : c'est elle qui arbitre les
    // conflits entre le WebSocket et un rattrapage REST plus lent.
    misAJourLe: versEpoch(brut._updatedAt) ?? horodatage,
  };
}

/**
 * Le texte d'aperçu d'un `lastMessage`, pour la liste des salons.
 *
 * Un message qui n'est QU'une pièce jointe a `msg: ''` (sondé sur 8.5, stream
 * comme `rooms.get`). Rendre `null` là-dessus faisait garder l'aperçu du
 * message PRÉCÉDENT : la liste annonçait un échange qui n'était plus le
 * dernier. On retombe donc sur ce que le serveur sait dire du fichier — sa
 * légende (`description`), sinon son nom (`title`).
 *
 * Un `null` qui SORT d'ici veut dire « ce message n'a rien à montrer », ce qui
 * n'est PAS la même chose que « ce salon n'a plus de dernier message » — depuis
 * que `dernier_message` n'est plus COALESCÉ, les deux effacent la ligne. C'est
 * `dernierMessageType` qui les départage : renseigné dans le premier cas, null
 * dans le second. Le cas concret est le message d'appel vidéo (`t: 'videoconf'`,
 * `msg: ''`, contenu dans `blocks`), qui faisait remonter le salon en tête de
 * liste avec un aperçu vide.
 */
function apercuDuDernier(dernier: Record<string, unknown> | undefined): string | null {
  const texte = chaine(dernier?.msg);
  if (texte !== null) return texte;
  if (!Array.isArray(dernier?.attachments)) return null;
  for (const jointe of dernier.attachments) {
    if (jointe === null || typeof jointe !== 'object') continue;
    const j = jointe as { description?: unknown; title?: unknown };
    const libelle = chaine(j.description) ?? chaine(j.title);
    if (libelle !== null) return libelle;
  }
  return null;
}

/**
 * @param moi — nom d'utilisateur du compte courant. Un message direct n'a ni
 * `name` ni `fname` dans `rooms.get` : son nom d'affichage se dérive de
 * `usernames`, en s'excluant soi-même. Sans `moi`, le DM resterait sans nom.
 * @param moiUid — uid du compte courant, pour extraire l'AUTRE participant
 * d'un DM depuis `uids` (présence, 8.4). `uids` et `usernames` ne sont PAS
 * alignés entre eux (vérifié sur 8.5) : seul le filtrage par uid est sûr.
 */
export function versSalon(
  brut: Record<string, unknown>,
  moi?: string | null,
  moiUid?: string | null,
): SalonLocal | null {
  const rid = chaine(brut._id);
  const type = chaine(brut.t);
  if (rid === null || type === null) return null;

  const chiffre = booleen(brut.encrypted);
  const dernier = brut.lastMessage as Record<string, unknown> | undefined;

  // `moi` est FIGÉ à la construction du traducteur (`session.username`) : après
  // un renommage depuis le web, ou pour une session dont le pseudo est vide
  // (`lib/auth.ts`), il ne figure plus dans `usernames`. S'exclure « par
  // différence » sans le vérifier retient alors le PREMIER nom venu — le mien
  // une fois sur deux. On ne s'exclut donc que si l'exclusion est prouvée.
  const nomsDM = Array.isArray(brut.usernames)
    ? brut.usernames.filter((u): u is string => typeof u === 'string' && u !== '')
    : [];
  const jeSuisDedans = typeof moi === 'string' && moi !== '' && nomsDM.includes(moi);

  let nomAffiche = chaine(brut.fname) ?? chaine(brut.name);
  if (nomAffiche === null && type === 'd' && Array.isArray(brut.usernames)) {
    // Sans exclusion prouvée, on n'a rien de mieux à proposer que la liste
    // entière — mieux vaut un nom de trop qu'un correspondant sous mon pseudo.
    const autres = jeSuisDedans ? nomsDM.filter((u) => u !== moi) : nomsDM;
    // Un DM avec soi-même a `usernames: [moi]` : `autres` est vide, on garde moi.
    nomAffiche = autres.length > 0 ? autres.join(', ') : (moi ?? null);
  }

  let dmAutreUid: string | null = null;
  if (type === 'd' && typeof moiUid === 'string' && Array.isArray(brut.uids)) {
    const uids = brut.uids.filter((u): u is string => typeof u === 'string' && u !== '');
    // À deux seulement : un DM de groupe n'a pas UNE présence à montrer.
    if (uids.length <= 2 && uids.includes(moiUid)) {
      dmAutreUid = uids.find((u) => u !== moiUid) ?? moiUid;
    }
  }

  // Le PSEUDO de l'autre, apparié au même endroit et par la même règle que son
  // uid (« celui des deux qui n'est pas moi ») — surtout PAS par index, les deux
  // tableaux ne sont pas alignés. Il ne se déduit pas de `nomAffiche`, qui peut
  // être un nom réel (`fname`) quand le serveur en pose un.
  //
  // Celui-ci part en base sous l'uid de l'autre (`UPSERT_IDENTITE`, sans garde
  // d'horodatage) : se tromper y colle MON pseudo — et donc mon avatar — sur
  // Bob, jusqu'à ce qu'il poste. On préfère donc ne rien dire : `UPSERT_SALON`
  // n'écrit rien sur un `null`, et le premier message de l'autre le posera.
  let dmAutreUsername: string | null = null;
  if (dmAutreUid !== null && nomsDM.length <= 2) {
    if (nomsDM.length === 1) dmAutreUsername = nomsDM[0]!;
    else if (jeSuisDedans) dmAutreUsername = nomsDM.find((u) => u !== moi) ?? null;
  }

  return {
    rid,
    type,
    nom: chaine(brut.name),
    nomAffiche,
    chiffre,
    lectureSeule: booleen(brut.ro),
    dmAutreUid,
    dmAutreUsername,
    // L'aperçu d'un salon chiffré est du ciphertext : jamais affiché. Le sien
    // est posé localement, après déchiffrement (`MAJ_APERCU_CHIFFRE`) — d'où
    // le `null` ici, que l'UPSERT sait ne pas prendre pour un effacement.
    //
    // Ailleurs, `null` VEUT dire « plus de dernier message » : quand le dernier
    // message d'un salon est supprimé, le document Room perd complètement son
    // `lastMessage` (sondé sur 8.5, stream ET `rooms.get`). C'est la seule
    // façon d'apprendre qu'un salon a été vidé.
    dernierMessage: chiffre ? null : apercuDuDernier(dernier),
    // Null pour un salon chiffré, comme l'aperçu : là-bas c'est la base locale
    // qui désigne le dernier message (`MAJ_APERCU_CHIFFRE`), et elle écarte les
    // messages système — garder le `t` du serveur ferait décrire un message par
    // le type d'un AUTRE.
    dernierMessageType: chiffre ? null : chaine(dernier?.t),
    horodatageDernierMessage: versEpoch(dernier?.ts) ?? versEpoch(brut.lm),
    // Absent tant que le salon n'a pas de photo, et absent des documents
    // partiels : `null` veut dire « rien à dire », jamais « efface » (le
    // COALESCE de `UPSERT_SALON` le garantit).
    avatarEtag: chaine(brut.avatarETag),
    misAJourLe: versEpoch(brut._updatedAt) ?? 0,
  };
}

export function versAbonnement(brut: Record<string, unknown>): AbonnementLocal | null {
  const rid = chaine(brut.rid);
  if (rid === null) return null;
  return {
    rid,
    subId: chaine(brut._id),
    nonLus: entier(brut.unread),
    mentions: entier(brut.userMentions),
    mentionsGroupe: entier(brut.groupMentions),
    alerte: booleen(brut.alert),
    ouvert: booleen(brut.open),
    favori: booleen(brut.f),
    luJusquA: versEpoch(brut.ls),
    e2eKey: chaine(brut.E2EKey),
    e2eKeyId: chaine(brut.e2eKeyId),
    misAJourLe: versEpoch(brut._updatedAt) ?? 0,
  };
}
