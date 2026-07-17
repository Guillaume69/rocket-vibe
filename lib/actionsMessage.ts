/**
 * Décision d'affichage des actions message — UNE fonction pure (8.2).
 *
 * Le délai d'édition vient des SETTINGS (`Message_AllowEditing_BlockEditInMinutes`),
 * pas des permissions : c'est le piège noté dans EXECUTION.md. Les permissions
 * par rôle (`force-edit-messages`…) arrivent en paramètre pour ne pas figer la
 * signature ; tant qu'on ne les charge pas, le serveur reste l'autorité — une
 * action affichée à tort échoue proprement avec son message d'erreur.
 */

import { ErreurRest } from './rest.ts';

export type ReglesMessages = {
  editionAutorisee: boolean;
  /** 0 = pas de limite. */
  minutesBlocageEdition: number;
  suppressionAutorisee: boolean;
  minutesBlocageSuppression: number;
  epinglageAutorise: boolean;
};

export type ContexteAction = {
  message: { auteurId: string; horodatage: number; typeSysteme: string | null };
  moi: string;
  regles: ReglesMessages;
  permissions: string[];
  lectureSeule: boolean;
  /** Salon chiffré : on ne peut pas y ENVOYER (donc pas répondre) — réagir, si. */
  chiffre: boolean;
  maintenant: number;
};

export type ActionMessage = 'reagir' | 'repondre' | 'modifier' | 'supprimer' | 'epingler';

function dansLeDelai(contexte: ContexteAction, minutes: number): boolean {
  if (minutes <= 0) return true; // 0 = illimité
  return contexte.maintenant - contexte.message.horodatage <= minutes * 60_000;
}

export function actionsPossibles(contexte: ContexteAction): ActionMessage[] {
  const actions: ActionMessage[] = [];
  const { message, moi, regles, permissions, lectureSeule, chiffre } = contexte;

  // Un message système ne se modifie pas, ne s'épingle pas, ne se commente
  // pas d'un emoji.
  if (message.typeSysteme !== null) return actions;

  if (!lectureSeule) actions.push('reagir');
  // Répondre en citant (`lib/citation.ts`) : n'importe quel message d'autrui ou
  // de soi, tant qu'on PEUT poster dans le salon.
  if (!lectureSeule && !chiffre) actions.push('repondre');

  const mien = message.auteurId === moi;
  // Noms RÉELS des permissions Rocket.Chat : `bypass-time-limit-edit-and-delete`
  // lève les délais (édition ET suppression), `edit-message` /
  // `force-delete-message` portent sur les messages d'autrui.
  const sansDelai = permissions.includes('bypass-time-limit-edit-and-delete');
  if (
    (mien &&
      regles.editionAutorisee &&
      (sansDelai || dansLeDelai(contexte, regles.minutesBlocageEdition))) ||
    permissions.includes('edit-message')
  ) {
    actions.push('modifier');
  }
  if (
    (mien &&
      regles.suppressionAutorisee &&
      (sansDelai || dansLeDelai(contexte, regles.minutesBlocageSuppression))) ||
    permissions.includes('force-delete-message')
  ) {
    actions.push('supprimer');
  }
  if (regles.epinglageAutorise) actions.push('epingler');

  return actions;
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
 * `chat.getMessage`, comme `envoi.ts` confirme une livraison : un 400 ici =
 * le serveur ne connaît plus ce message (vérifié sur 8.5 : `API.v1.failure`).
 * Toute autre issue — message encore là, erreur réseau (statut 0), 429 —
 * vaut « on ne sait pas » : l'erreur d'origine reste la bonne réponse.
 */
export async function messageDisparuDuServeur(
  client: LecteurMessage,
  msgId: string,
): Promise<boolean> {
  try {
    await client.get('chat.getMessage', { params: { msgId } });
    return false;
  } catch (e) {
    return e instanceof ErreurRest && e.statut === 400;
  }
}

type ReglagePublic = { _id?: string; value?: unknown };

/** À croiser avec la lecture `count=0` de settings.public (le `query` est mort en 7.0). */
export function reglesDepuisReglages(reglages: ReglagePublic[]): ReglesMessages {
  const valeurs = new Map<string, unknown>();
  for (const r of reglages) {
    if (typeof r._id === 'string') valeurs.set(r._id, r.value);
  }
  const nombre = (cle: string): number => {
    const v = valeurs.get(cle);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    editionAutorisee: valeurs.get('Message_AllowEditing') !== false,
    minutesBlocageEdition: nombre('Message_AllowEditing_BlockEditInMinutes'),
    suppressionAutorisee: valeurs.get('Message_AllowDeleting') !== false,
    minutesBlocageSuppression: nombre('Message_AllowDeleting_BlockDeleteInMinutes'),
    epinglageAutorise: valeurs.get('Message_AllowPinning') !== false,
  };
}
