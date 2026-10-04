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

import type { DdpEvent } from '../../lib/ddp.ts';
import type { Translator, Translation } from '../../lib/provider.ts';
import {
  toSubscription,
  toMessage,
  toRoom,
  type LocalSubscription,
  type MessageLocal,
  type LocalRoom,
} from '../../lib/normalize.ts';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
import { STREAM_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER } from '../../lib/sync.ts';
import { AVATAR_NO_PHOTO } from '../../lib/upload.ts';

/**
 * Changement de photo, utilisateur ou salon : `args = [{username, etag}]` ou
 * `[{rid, etag}]` (relevé par sonde sur 8.5). L'`etag` MANQUE quand la photo
 * est retirée — voir `AVATAR_SANS_PHOTO`.
 */
export const AVATAR_EVENT = 'updateAvatar';

const IGNORE: Translation = { kind: 'ignore' };
const SILENCE: Translation = { kind: 'silence' };

export class RcTranslator implements Translator {
  // Servent à nommer les DM (versSalon) : le nom d'utilisateur et l'uid du
  // compte courant. Portés par le traducteur, plus par le moteur de synchro.
  private readonly me: string | null;
  private readonly myUid: string | null;

  constructor(moi: string | null = null, moiUid: string | null = null) {
    this.me = moi;
    this.myUid = moiUid;
  }

  toMessage(brut: Record<string, unknown>): MessageLocal | null {
    return toMessage(brut);
  }

  toRoom(brut: Record<string, unknown>): LocalRoom | null {
    return toRoom(brut, this.me, this.myUid);
  }

  toSubscription(brut: Record<string, unknown>): LocalSubscription | null {
    return toSubscription(brut);
  }

  translateEvent(evenement: DdpEvent): Translation {
    switch (evenement.collection) {
      case STREAM_MESSAGES: {
        // Ici, et ici seulement, `args[0]` est directement le document.
        const document = objetOuNull(evenement.args[0]);
        if (document === null) return IGNORE;
        const message = toMessage(document);
        return message === null ? IGNORE : { kind: 'changement', change: { type: 'message', doc: message } };
      }

      case STREAM_NOTIFY_USER: {
        const sujet = sujetDe(evenement.eventKey);
        if (sujet === 'subscriptions-changed') return this.translateSubscription(evenement);
        if (sujet === 'rooms-changed') return this.translateRoom(evenement);
        return IGNORE;
      }

      case STREAM_NOTIFY_LOGGED: {
        // La présence transite par le MÊME stream, mais elle est volatile et
        // traitée par `MoteurPresence` : silence, pas anomalie — sinon chaque
        // aller-retour d'un contact gonflerait le compteur d'ignorés.
        if (evenement.eventKey === PRESENCE_EVENT) return SILENCE;
        if (evenement.eventKey !== AVATAR_EVENT) return IGNORE;
        return traduireAvatar(evenement);
      }

      case STREAM_NOTIFY_ROOM: {
        const sujet = sujetDe(evenement.eventKey);
        // `user-activity` est ATTENDU (l'écran salon s'y abonne pour la saisie)
        // mais traité ailleurs : le compter en anomalie noierait le compteur
        // sous des battements de frappe.
        if (sujet === 'user-activity') return SILENCE;
        if (sujet !== 'deleteMessage') return IGNORE;
        const document = objetOuNull(evenement.args[0]);
        const id = typeof document?._id === 'string' ? document._id : null;
        return id === null ? IGNORE : { kind: 'changement', change: { type: 'suppr-message', id } };
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
  private translateSubscription(evenement: DdpEvent): Translation {
    const document = documentDeNotification(evenement);
    if (document === null) return IGNORE;
    if (actionDeNotification(evenement) === 'removed') {
      const subId = typeof document._id === 'string' ? document._id : null;
      return subId === null ? IGNORE : { kind: 'changement', change: { type: 'suppr-abonnement-par-sub', subId } };
    }
    const abonnement = toSubscription(document);
    return abonnement === null ? IGNORE : { kind: 'changement', change: { type: 'abonnement', doc: abonnement } };
  }

  private translateRoom(evenement: DdpEvent): Translation {
    const document = documentDeNotification(evenement);
    if (document === null) return IGNORE;
    if (actionDeNotification(evenement) === 'removed') {
      const rid = typeof document._id === 'string' ? document._id : null;
      return rid === null ? IGNORE : { kind: 'changement', change: { type: 'suppr-salon', rid } };
    }
    const salon = toRoom(document, this.me, this.myUid);
    return salon === null ? IGNORE : { kind: 'changement', change: { type: 'salon', doc: salon } };
  }
}

/**
 * `updateAvatar` : une seule des deux clés est présente. L'`etag` absent
 * signale un avatar RETIRÉ (`users.resetAvatar`) — on pose alors le marqueur
 * `AVATAR_SANS_PHOTO` plutôt que rien, pour que l'URI change quand même.
 */
function traduireAvatar(evenement: DdpEvent): Translation {
  const document = objetOuNull(evenement.args[0]);
  if (document === null) return IGNORE;
  const username = typeof document.username === 'string' ? document.username : null;
  const rid = typeof document.rid === 'string' ? document.rid : null;
  if (username === null && rid === null) return IGNORE;
  const etag = typeof document.etag === 'string' && document.etag !== '' ? document.etag : null;
  return {
    kind: 'changement',
    change: { type: 'avatar', username, rid, etag: etag ?? AVATAR_NO_PHOTO },
  };
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
function documentDeNotification(evenement: DdpEvent): Record<string, unknown> | null {
  if (typeof evenement.args[0] === 'string') return objetOuNull(evenement.args[1]);
  return objetOuNull(evenement.args[0]);
}

/** L'ACTION d'une notification `[action, document]`, ou null si le document vient directement. */
function actionDeNotification(evenement: DdpEvent): string | null {
  return typeof evenement.args[0] === 'string' ? evenement.args[0] : null;
}
