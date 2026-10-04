/**
 * Traduction des charges utiles Rocket.Chat vers les lignes locales.
 *
 * Module pur : aucun accès réseau, aucune base. C'est ici que se concentrent
 * les bizarreries du serveur, pour qu'elles ne se répandent pas ailleurs.
 */

import { starredIds } from './marks.ts';

/** Le serveur envoie soit `{"$date": epochMs}` (EJSON), soit une chaîne ISO. */
export function toEpoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'object' && value !== null) {
    const raw = (value as { $date?: unknown }).$date;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
      const t = Date.parse(raw);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

export type MessageLocal = {
  id: string;
  rid: string;
  text: string | null;
  ts: number;
  authorId: string;
  authorName: string | null;
  systemType: string | null;
  threadId: string | null;
  threadCount: number;
  threadLast: number | null;
  threadShown: boolean;
  editedAt: number | null;
  md: string | null;
  attachments: string | null;
  reactions: string | null;
  /** Métadonnées de lien parsées par le serveur (`urls`), sérialisées. */
  urls: string | null;
  /** `callId` d'un message d'appel (`t: 'videoconf'`), extrait du bloc. */
  callId: string | null;
  /**
   * Objet `content` d'un message chiffré (`rc.v2.aes-sha2`), sérialisé. On le
   * GARDE — contrairement au reste, où le blob chiffré est jeté — pour pouvoir
   * déchiffrer APRÈS coup, au déverrouillage (E2EE, étape 10). `null` hors
   * message chiffré, ou pour un chiffrement hérité `rc.v1` (dans `msg`, non
   * pris en charge). Ce n'est pas du clair : rien à afficher tel quel.
   */
  encryptedRaw: string | null;
  pinned: boolean;
  /** Uids qui ont étoilé le message, sérialisés (`lib/marks.ts`). */
  starred: string | null;
  updatedAt: number;
};

export type LocalRoom = {
  rid: string;
  type: string;
  name: string | null;
  displayName: string | null;
  encrypted: boolean;
  readOnly: boolean;
  /** L'autre participant d'un DM à deux — voir `versSalon`. */
  dmOtherUid: string | null;
  /**
   * Son PSEUDO. **Transporté, pas stocké dans `salons`** : il sert au dépôt à
   * inscrire l'autre dans `utilisateurs` (uid ↔ pseudo). Sans cette ligne,
   * l'événement `updateAvatar` — qui ne désigne l'utilisateur QUE par son
   * pseudo — ne trouve rien à mettre à jour, et l'avatar du DM reste figé :
   * la liste des salons affiche des gens dont aucun message n'a été ingéré.
   */
  dmOtherUsername: string | null;
  lastMessage: string | null;
  /**
   * Le `t` du dernier message — ce qui sépare « salon vidé » de « dernier
   * message sans texte à montrer ». Voir `db/schema.ts` et `apercuDuDernier`.
   */
  lastMessageType: string | null;
  lastMessageTs: number | null;
  /** `avatarETag` : version de la photo du salon, cache-buster de son URL. */
  avatarEtag: string | null;
  updatedAt: number;
};

export type LocalSubscription = {
  rid: string;
  /** `_id` de l'abonnement — la seule clé que portent les `remove[]` du rattrapage. */
  subId: string | null;
  unread: number;
  mentions: number;
  groupMentions: number;
  alert: boolean;
  open: boolean;
  favorite: boolean;
  lastSeen: number | null;
  /** `E2EKey` : clé AES du salon chiffrée RSA pour ce membre (keyID + base64). */
  e2eKey: string | null;
  /** `e2eKeyId` : UUID de la clé de salon, quand le serveur le fournit à part. */
  e2eKeyId: string | null;
  /** Mes rôles dans le salon, sérialisés — `null` si le document n'en porte pas. */
  roles: string | null;
  updatedAt: number;
};

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const boolean = (v: unknown): boolean => v === true;
const jsonOrNull = (v: unknown): string | null =>
  v === undefined || v === null ? null : JSON.stringify(v);

/** Un message chiffré n'est pas déchiffrable ici : on n'expose jamais le blob. */
export const ENCRYPTED_TYPE = 'e2e';

/** Type système d'un message de visioconférence Rocket.Chat. */
export const CALL_TYPE = 'videoconf';

/**
 * Le message d'appel porte son `callId` dans un bloc `video_conf` (`appId:
 * 'videoconf-core'`), PAS dans son `_id` : les deux diffèrent (vérifié sur la
 * source RC). On extrait le premier bloc de ce type ; le reste des `blocks`
 * (UI-kit générique) ne nous sert pas et n'est pas conservé.
 */
function blockCallId(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b !== null && typeof b === 'object') {
      const block = b as { type?: unknown; callId?: unknown };
      if (block.type === 'video_conf') return asString(block.callId);
    }
  }
  return null;
}

export function toMessage(raw: Record<string, unknown>): MessageLocal | null {
  const id = asString(raw._id);
  const rid = asString(raw.rid);
  const ts = toEpoch(raw.ts);
  const author = raw.u as { _id?: unknown; username?: unknown } | undefined;
  const authorId = asString(author?._id);
  if (id === null || rid === null || ts === null || authorId === null) return null;

  const systemType = asString(raw.t);
  // `msg` d'un message chiffré contient du base64 opaque. Le stocker inviterait
  // à l'afficher un jour par accident.
  const encrypted = systemType === ENCRYPTED_TYPE;

  return {
    id,
    rid,
    text: encrypted ? null : asString(raw.msg),
    ts,
    authorId,
    authorName: asString(author?.username),
    systemType,
    threadId: asString(raw.tmid),
    threadCount: asInt(raw.tcount),
    threadLast: toEpoch(raw.tlm),
    threadShown: boolean(raw.tshow),
    editedAt: toEpoch(raw.editedAt),
    md: encrypted ? null : jsonOrNull(raw.md),
    attachments: encrypted ? null : jsonOrNull(raw.attachments),
    reactions: jsonOrNull(raw.reactions),
    // Rien à prévisualiser pour un salon chiffré ; sinon on garde `urls` brut,
    // parsé au rendu (`lib/linkPreview.ts`).
    urls: encrypted ? null : jsonOrNull(raw.urls),
    callId: systemType === CALL_TYPE ? blockCallId(raw.blocks) : null,
    // Le `content` chiffré est conservé pour un déchiffrement différé ; le `msg`
    // opaque, lui, ne l'est jamais (voir `texte`).
    encryptedRaw: encrypted ? jsonOrNull(raw.content) : null,
    pinned: boolean(raw.pinned),
    starred: starredIds(raw.starred),
    // `_updatedAt` est l'horloge du serveur : c'est elle qui arbitre les
    // conflits entre le WebSocket et un rattrapage REST plus lent.
    updatedAt: toEpoch(raw._updatedAt) ?? ts,
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
function lastMessagePreview(last: Record<string, unknown> | undefined): string | null {
  const text = asString(last?.msg);
  if (text !== null) return text;
  if (!Array.isArray(last?.attachments)) return null;
  for (const attachment of last.attachments) {
    if (attachment === null || typeof attachment !== 'object') continue;
    const j = attachment as { description?: unknown; title?: unknown };
    const label = asString(j.description) ?? asString(j.title);
    if (label !== null) return label;
  }
  return null;
}

/**
 * @param me — nom d'utilisateur du compte courant. Un message direct n'a ni
 * `name` ni `fname` dans `rooms.get` : son nom d'affichage se dérive de
 * `usernames`, en s'excluant soi-même. Sans `moi`, le DM resterait sans nom.
 * @param myUid — uid du compte courant, pour extraire l'AUTRE participant
 * d'un DM depuis `uids` (présence, 8.4). `uids` et `usernames` ne sont PAS
 * alignés entre eux (vérifié sur 8.5) : seul le filtrage par uid est sûr.
 */
export function toRoom(
  raw: Record<string, unknown>,
  me?: string | null,
  myUid?: string | null,
): LocalRoom | null {
  const rid = asString(raw._id);
  const type = asString(raw.t);
  if (rid === null || type === null) return null;

  const encrypted = boolean(raw.encrypted);
  const last = raw.lastMessage as Record<string, unknown> | undefined;

  // `moi` est FIGÉ à la construction du traducteur (`session.username`) : après
  // un renommage depuis le web, ou pour une session dont le pseudo est vide
  // (`lib/auth.ts`), il ne figure plus dans `usernames`. S'exclure « par
  // différence » sans le vérifier retient alors le PREMIER nom venu — le mien
  // une fois sur deux. On ne s'exclut donc que si l'exclusion est prouvée.
  const dmNames = Array.isArray(raw.usernames)
    ? raw.usernames.filter((u): u is string => typeof u === 'string' && u !== '')
    : [];
  const iAmIn = typeof me === 'string' && me !== '' && dmNames.includes(me);

  let displayName = asString(raw.fname) ?? asString(raw.name);
  if (displayName === null && type === 'd' && Array.isArray(raw.usernames)) {
    // Sans exclusion prouvée, on n'a rien de mieux à proposer que la liste
    // entière — mieux vaut un nom de trop qu'un correspondant sous mon pseudo.
    const others = iAmIn ? dmNames.filter((u) => u !== me) : dmNames;
    // Un DM avec soi-même a `usernames: [moi]` : `autres` est vide, on garde moi.
    displayName = others.length > 0 ? others.join(', ') : (me ?? null);
  }

  let dmOtherUid: string | null = null;
  if (type === 'd' && typeof myUid === 'string' && Array.isArray(raw.uids)) {
    const uids = raw.uids.filter((u): u is string => typeof u === 'string' && u !== '');
    // À deux seulement : un DM de groupe n'a pas UNE présence à montrer.
    if (uids.length <= 2 && uids.includes(myUid)) {
      dmOtherUid = uids.find((u) => u !== myUid) ?? myUid;
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
  let dmOtherUsername: string | null = null;
  if (dmOtherUid !== null && dmNames.length <= 2) {
    if (dmNames.length === 1) dmOtherUsername = dmNames[0]!;
    else if (iAmIn) dmOtherUsername = dmNames.find((u) => u !== me) ?? null;
  }

  return {
    rid,
    type,
    name: asString(raw.name),
    displayName,
    encrypted,
    readOnly: boolean(raw.ro),
    dmOtherUid,
    dmOtherUsername,
    // L'aperçu d'un salon chiffré est du ciphertext : jamais affiché. Le sien
    // est posé localement, après déchiffrement (`MAJ_APERCU_CHIFFRE`) — d'où
    // le `null` ici, que l'UPSERT sait ne pas prendre pour un effacement.
    //
    // Ailleurs, `null` VEUT dire « plus de dernier message » : quand le dernier
    // message d'un salon est supprimé, le document Room perd complètement son
    // `lastMessage` (sondé sur 8.5, stream ET `rooms.get`). C'est la seule
    // façon d'apprendre qu'un salon a été vidé.
    lastMessage: encrypted ? null : lastMessagePreview(last),
    // Null pour un salon chiffré, comme l'aperçu : là-bas c'est la base locale
    // qui désigne le dernier message (`MAJ_APERCU_CHIFFRE`), et elle écarte les
    // messages système — garder le `t` du serveur ferait décrire un message par
    // le type d'un AUTRE.
    lastMessageType: encrypted ? null : asString(last?.t),
    lastMessageTs: toEpoch(last?.ts) ?? toEpoch(raw.lm),
    // Absent tant que le salon n'a pas de photo, et absent des documents
    // partiels : `null` veut dire « rien à dire », jamais « efface » (le
    // COALESCE de `UPSERT_SALON` le garantit).
    avatarEtag: asString(raw.avatarETag),
    updatedAt: toEpoch(raw._updatedAt) ?? 0,
  };
}

export function toSubscription(raw: Record<string, unknown>): LocalSubscription | null {
  const rid = asString(raw.rid);
  if (rid === null) return null;
  return {
    rid,
    subId: asString(raw._id),
    unread: asInt(raw.unread),
    mentions: asInt(raw.userMentions),
    groupMentions: asInt(raw.groupMentions),
    alert: boolean(raw.alert),
    open: boolean(raw.open),
    favorite: boolean(raw.f),
    lastSeen: toEpoch(raw.ls),
    e2eKey: asString(raw.E2EKey),
    e2eKeyId: asString(raw.e2eKeyId),
    roles: Array.isArray(raw.roles)
      ? JSON.stringify(raw.roles.filter((r): r is string => typeof r === 'string'))
      : null,
    updatedAt: toEpoch(raw._updatedAt) ?? 0,
  };
}
