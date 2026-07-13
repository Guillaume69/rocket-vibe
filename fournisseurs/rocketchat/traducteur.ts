/**
 * Traducteur Rocket.Chat : la part serveur-spécifique de la synchro. Décode les
 * `Evenement` bruts des streams RC et les documents REST en formes neutres
 * (`ChangementSync`, lignes locales). Tout ce que `MoteurSynchro` savait de
 * Rocket.Chat vit désormais ici — le cœur de synchro n'en connaît plus rien.
 *
 * Le routage reproduit à l'identique l'ancien `MoteurSynchro.appliquer` (mêmes
 * garanties : charges inconnues ignorées mais comptées, `user-activity` tu en
 * silence, `removed` distingué de l'upsert).
 */

import type { Evenement } from '../../lib/ddp.ts';
import type { Traducteur, Traduction } from '../../lib/fournisseur.ts';
import {
  versAbonnement,
  versMessage,
  versSalon,
  type AbonnementLocal,
  type MessageLocal,
  type SalonLocal,
} from '../../lib/normaliser.ts';
import { STREAM_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER } from '../../lib/sync.ts';

const IGNORE: Traduction = { sorte: 'ignore' };
const SILENCE: Traduction = { sorte: 'silence' };

export class TraducteurRC implements Traducteur {
  // Servent à nommer les DM (versSalon) : le nom d'utilisateur et l'uid du
  // compte courant. Portés par le traducteur, plus par le moteur de synchro.
  private readonly moi: string | null;
  private readonly moiUid: string | null;

  constructor(moi: string | null = null, moiUid: string | null = null) {
    this.moi = moi;
    this.moiUid = moiUid;
  }

  versMessage(brut: Record<string, unknown>): MessageLocal | null {
    return versMessage(brut);
  }

  versSalon(brut: Record<string, unknown>): SalonLocal | null {
    return versSalon(brut, this.moi, this.moiUid);
  }

  versAbonnement(brut: Record<string, unknown>): AbonnementLocal | null {
    return versAbonnement(brut);
  }

  traduireEvenement(evenement: Evenement): Traduction {
    switch (evenement.collection) {
      case STREAM_MESSAGES: {
        // Ici, et ici seulement, `args[0]` est directement le document.
        const document = objetOuNull(evenement.args[0]);
        if (document === null) return IGNORE;
        const message = versMessage(document);
        return message === null ? IGNORE : { sorte: 'changement', changement: { type: 'message', doc: message } };
      }

      case STREAM_NOTIFY_USER: {
        const sujet = sujetDe(evenement.cleEvenement);
        if (sujet === 'subscriptions-changed') return this.traduireAbonnement(evenement);
        if (sujet === 'rooms-changed') return this.traduireSalon(evenement);
        return IGNORE;
      }

      case STREAM_NOTIFY_ROOM: {
        const sujet = sujetDe(evenement.cleEvenement);
        // `user-activity` est ATTENDU (l'écran salon s'y abonne pour la saisie)
        // mais traité ailleurs : le compter en anomalie noierait le compteur
        // sous des battements de frappe.
        if (sujet === 'user-activity') return SILENCE;
        if (sujet !== 'deleteMessage') return IGNORE;
        const document = objetOuNull(evenement.args[0]);
        const id = typeof document?._id === 'string' ? document._id : null;
        return id === null ? IGNORE : { sorte: 'changement', changement: { type: 'suppr-message', id } };
      }

      default:
        return IGNORE;
    }
  }

  /**
   * `subscriptions-changed` livre `[action, document]`. 'removed' : le compte a
   * quitté le salon (ou il a été supprimé) ; RC n'envoie que le `_id` de
   * l'ABONNEMENT — de quoi le retrouver, pas de quoi le reconstruire. Sans ce
   * cas, un upsert maintiendrait un salon supprimé en FANTÔME.
   */
  private traduireAbonnement(evenement: Evenement): Traduction {
    const document = documentDeNotification(evenement);
    if (document === null) return IGNORE;
    if (actionDeNotification(evenement) === 'removed') {
      const subId = typeof document._id === 'string' ? document._id : null;
      return subId === null ? IGNORE : { sorte: 'changement', changement: { type: 'suppr-abonnement-par-sub', subId } };
    }
    const abonnement = versAbonnement(document);
    return abonnement === null ? IGNORE : { sorte: 'changement', changement: { type: 'abonnement', doc: abonnement } };
  }

  private traduireSalon(evenement: Evenement): Traduction {
    const document = documentDeNotification(evenement);
    if (document === null) return IGNORE;
    if (actionDeNotification(evenement) === 'removed') {
      const rid = typeof document._id === 'string' ? document._id : null;
      return rid === null ? IGNORE : { sorte: 'changement', changement: { type: 'suppr-salon', rid } };
    }
    const salon = versSalon(document, this.moi, this.moiUid);
    return salon === null ? IGNORE : { sorte: 'changement', changement: { type: 'salon', doc: salon } };
  }
}

function objetOuNull(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** `<uid>/subscriptions-changed` -> `subscriptions-changed`. */
function sujetDe(cleEvenement: string): string {
  return cleEvenement.split('/').slice(1).join('/');
}

/**
 * `stream-notify-user` envoie `args: ['updated', {…}]` (vérifié 8.5) : le
 * document est le SECOND argument quand le premier est une action. Certaines
 * versions envoient directement le document — on accepte les deux formes.
 */
function documentDeNotification(evenement: Evenement): Record<string, unknown> | null {
  if (typeof evenement.args[0] === 'string') return objetOuNull(evenement.args[1]);
  return objetOuNull(evenement.args[0]);
}

/** L'ACTION d'une notification `[action, document]`, ou null si le document vient directement. */
function actionDeNotification(evenement: Evenement): string | null {
  return typeof evenement.args[0] === 'string' ? evenement.args[0] : null;
}
