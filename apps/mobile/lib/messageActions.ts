/**
 * Décision d'affichage des actions message — UNE fonction pure (8.2).
 *
 * Le délai d'édition vient des SETTINGS (`Message_AllowEditing_BlockEditInMinutes`),
 * pas des permissions : c'est le piège noté dans EXECUTION.md. Les permissions
 * accordées (`lib/permissions.ts`) arrivent en paramètre, et les règles sont
 * celles du serveur 8.5 (`canDeleteMessageAsync`, `updateMessage`,
 * `pinMessage`). Tant qu'elles ne sont pas chargées (`null`), on propose ce
 * que peut un membre sur ses messages, plus l'épingle, et le serveur reste
 * l'autorité — une action affichée à tort échoue proprement avec son message
 * d'erreur.
 */

import { stripQuotePrefix } from './quote.ts';
import { attachmentToShare } from './attachment.ts';
import { ENCRYPTED_TYPE } from './normalize.ts';
import { RestError } from './rest.ts';

export type MessageRules = {
  editAllowed: boolean;
  /** 0 = pas de limite. */
  editBlockMinutes: number;
  deleteAllowed: boolean;
  deleteBlockMinutes: number;
  pinAllowed: boolean;
  starAllowed: boolean;
};

export type ActionContext = {
  /**
   * `texte` sert à distinguer un message chiffré LISIBLE (déchiffré en base par
   * `deverrouillageE2E`) d'un message encore opaque — voir la garde de
   * `actionsPossibles`.
   */
  message: {
    authorId: string;
    ts: number;
    systemType: string | null;
    text: string | null;
    attachments: string | null;
    pinned: boolean;
    /** Étoilé par MOI (`lib/marks.ts`). */
    starred: boolean;
  };
  me: string;
  rules: MessageRules;
  /** Permissions accordées dans ce salon ; `null` : pas (encore) connues. */
  permissions: string[] | null;
  readOnly: boolean;
  /**
   * Salon chiffré : on y répond dans un fil, pas en citant — la citation est
   * une carte que le serveur bâtit depuis le texte, et il ne lit pas celui-ci.
   */
  encrypted: boolean;
  /** Feuille ouverte depuis l'écran d'un fil : on y répond déjà. */
  inThread: boolean;
  now: number;
};

export type ActionMessage =
  | 'reagir'
  | 'repondre'
  | 'repondreFil'
  | 'copier'
  | 'partager'
  | 'enregistrer'
  | 'modifier'
  | 'supprimer'
  | 'epingler'
  | 'desepingler'
  | 'etoiler'
  | 'desetoiler';

function dansLeDelai(contexte: ActionContext, minutes: number): boolean {
  if (minutes <= 0) return true; // 0 = illimité
  return contexte.now - contexte.message.ts <= minutes * 60_000;
}

export function actionsPossibles(contexte: ActionContext): ActionMessage[] {
  const actions: ActionMessage[] = [];
  const { message, me: moi, rules: regles, permissions, readOnly: lectureSeule, encrypted: chiffre, inThread: dansUnFil } = contexte;

  // Un message système ne se modifie pas, ne s'épingle pas, ne se commente
  // pas d'un emoji.
  //
  // MAIS `e2e` n'est pas un type système au sens de l'affichage : c'est un
  // message ORDINAIRE dont le corps est chiffré, et `db/upserts.ts` ne remplit
  // que `texte` au déchiffrement — le marqueur, lui, reste. Une fois lisible,
  // ui/messageRow.tsx le rend comme n'importe quel autre message ; la sortie
  // sèche ci-dessous ouvrait donc une feuille d'actions VIDE sur la totalité
  // d'un salon chiffré.
  const chiffreLisible = message.systemType === ENCRYPTED_TYPE && message.text !== null;
  if (message.systemType !== null && !chiffreLisible) return actions;

  if (!lectureSeule) actions.push('reagir');
  // Répondre en citant (`lib/quote.ts`) : n'importe quel message d'autrui ou
  // de soi, tant qu'on PEUT poster dans le salon.
  if (!lectureSeule && !chiffre) actions.push('repondre');
  if (!lectureSeule && !dansUnFil) actions.push('repondreFil');
  const texte = textToCopy(message.text) !== null;
  if (texte) actions.push('copier');
  const fichier = attachmentToShare(message.attachments) !== null;
  if (texte || fichier) actions.push('partager');
  if (fichier) actions.push('enregistrer');

  const mien = message.authorId === moi;
  // Inconnues : ses propres messages et l'épingle restent proposés, rien de plus.
  const a = (permission: string, siInconnue: boolean): boolean =>
    permissions === null ? siInconnue : permissions.includes(permission);
  // `bypass-time-limit-edit-and-delete` lève les délais (édition ET
  // suppression) ; `edit-message` et `delete-message` ouvrent les messages
  // d'autrui, DANS le délai ; `force-delete-message` supprime sans condition.
  const sansDelai = a('bypass-time-limit-edit-and-delete', false);
  if (
    (a('edit-message', false) || (mien && regles.editAllowed)) &&
    (sansDelai || dansLeDelai(contexte, regles.editBlockMinutes))
  ) {
    actions.push('modifier');
  }
  if (
    a('force-delete-message', false) ||
    (regles.deleteAllowed &&
      (a('delete-message', false) || (mien && a('delete-own-message', true))) &&
      (sansDelai || dansLeDelai(contexte, regles.deleteBlockMinutes)))
  ) {
    actions.push('supprimer');
  }
  if (regles.pinAllowed && a('pin-message', true)) {
    actions.push(message.pinned ? 'desepingler' : 'epingler');
  }
  if (regles.starAllowed) actions.push(message.starred ? 'desetoiler' : 'etoiler');

  return actions;
}

/** Le texte que « Copier » et « Partager » emportent : sans le permalien de citation. */
export function textToCopy(texte: string | null): string | null {
  const mots = stripQuotePrefix(texte ?? '').trim();
  return mots === '' ? null : mots;
}

type LecteurMessage = {
  get(chemin: string, options?: { params?: Record<string, unknown> }): Promise<unknown>;
};

/**
 * Après un échec de `chat.delete` : le message existe-t-il encore côté
 * serveur ? Le fantôme classique — supprimé d'un AUTRE client pendant que
 * cette app était fermée, réconciliation ratée — fait répondre « No message
 * found with the id … » ; l'objectif de l'utilisateur est pourtant déjà
 * atteint, il ne reste qu'à purger la ligne locale. Plutôt que de dépendre du
 * LIBELLÉ de l'erreur (fragile entre versions serveur), on confirme par
 * `chat.getMessage`, comme `outbox.ts` confirme une livraison : un 400 ici =
 * le serveur ne connaît plus ce message (vérifié sur 8.5 : `API.v1.failure`).
 * Toute autre issue — message encore là, erreur réseau (statut 0), 429 —
 * vaut « on ne sait pas » : l'erreur d'origine reste la bonne réponse.
 */
export async function messageGoneFromServer(
  client: LecteurMessage,
  msgId: string,
): Promise<boolean> {
  try {
    await client.get('chat.getMessage', { params: { msgId } });
    return false;
  } catch (e) {
    return e instanceof RestError && e.status === 400;
  }
}

type ReglagePublic = { _id?: string; value?: unknown };

/** À croiser avec la lecture `count=0` de settings.public (le `query` est mort en 7.0). */
export function rulesFromSettings(reglages: ReglagePublic[]): MessageRules {
  const valeurs = new Map<string, unknown>();
  for (const r of reglages) {
    if (typeof r._id === 'string') valeurs.set(r._id, r.value);
  }
  const nombre = (cle: string): number => {
    const v = valeurs.get(cle);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    editAllowed: valeurs.get('Message_AllowEditing') !== false,
    editBlockMinutes: nombre('Message_AllowEditing_BlockEditInMinutes'),
    deleteAllowed: valeurs.get('Message_AllowDeleting') !== false,
    deleteBlockMinutes: nombre('Message_AllowDeleting_BlockDeleteInMinutes'),
    pinAllowed: valeurs.get('Message_AllowPinning') !== false,
    starAllowed: valeurs.get('Message_AllowStarring') !== false,
  };
}
