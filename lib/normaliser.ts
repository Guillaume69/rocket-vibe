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
  dernierMessage: string | null;
  horodatageDernierMessage: number | null;
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
    // `_updatedAt` est l'horloge du serveur : c'est elle qui arbitre les
    // conflits entre le WebSocket et un rattrapage REST plus lent.
    misAJourLe: versEpoch(brut._updatedAt) ?? horodatage,
  };
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

  let nomAffiche = chaine(brut.fname) ?? chaine(brut.name);
  if (nomAffiche === null && type === 'd' && Array.isArray(brut.usernames)) {
    const autres = brut.usernames
      .filter((u): u is string => typeof u === 'string')
      .filter((u) => u !== moi);
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

  return {
    rid,
    type,
    nom: chaine(brut.name),
    nomAffiche,
    chiffre,
    lectureSeule: booleen(brut.ro),
    dmAutreUid,
    // L'aperçu d'un salon chiffré est du ciphertext : jamais affiché.
    dernierMessage: chiffre ? null : chaine(dernier?.msg),
    horodatageDernierMessage: versEpoch(dernier?.ts) ?? versEpoch(brut.lm),
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
    misAJourLe: versEpoch(brut._updatedAt) ?? 0,
  };
}
