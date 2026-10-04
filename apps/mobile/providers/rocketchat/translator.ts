/**
 * Rocket.Chat translator: the server-specific part of sync. Decodes the raw
 * `DdpEvent`s of the RC streams and the REST documents into neutral shapes
 * (`SyncChange`, local rows). Everything `SyncEngine` knew about Rocket.Chat
 * now lives here; the sync core no longer knows anything about it.
 *
 * The routing reproduces the former `SyncEngine.apply` exactly (same
 * guarantees: unknown payloads ignored but counted, `user-activity` silenced,
 * `removed` told apart from the upsert).
 */

import type { DdpEvent } from '../../lib/ddp.ts';
import type { Translator, Translation } from '../../lib/provider.ts';
import {
  toSubscription,
  toMessage,
  toRoom,
  type LocalSubscription,
  type LocalMessage,
  type LocalRoom,
} from '../../lib/normalize.ts';
import { PRESENCE_EVENT, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
import { STREAM_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER } from '../../lib/sync.ts';
import { AVATAR_NO_PHOTO } from '../../lib/upload.ts';

/**
 * Photo change, user or room: `args = [{username, etag}]` or
 * `[{rid, etag}]` (probed on 8.5). The `etag` is MISSING when the photo is
 * removed; see `AVATAR_NO_PHOTO`.
 */
export const AVATAR_EVENT = 'updateAvatar';

const IGNORE: Translation = { kind: 'ignore' };
const SILENCE: Translation = { kind: 'silence' };

export class RcTranslator implements Translator {
  // Used to name DMs (toRoom): the username and uid of the current account.
  // Carried by the translator, no longer by the sync engine.
  private readonly me: string | null;
  private readonly myUid: string | null;

  constructor(me: string | null = null, myUid: string | null = null) {
    this.me = me;
    this.myUid = myUid;
  }

  toMessage(raw: Record<string, unknown>): LocalMessage | null {
    return toMessage(raw);
  }

  toRoom(raw: Record<string, unknown>): LocalRoom | null {
    return toRoom(raw, this.me, this.myUid);
  }

  toSubscription(raw: Record<string, unknown>): LocalSubscription | null {
    return toSubscription(raw);
  }

  translateEvent(event: DdpEvent): Translation {
    switch (event.collection) {
      case STREAM_MESSAGES: {
        // Here, and here only, `args[0]` is directly the document.
        const document = objectOrNull(event.args[0]);
        if (document === null) return IGNORE;
        const message = toMessage(document);
        return message === null ? IGNORE : { kind: 'change', change: { type: 'message', doc: message } };
      }

      case STREAM_NOTIFY_USER: {
        const topic = topicOf(event.eventKey);
        if (topic === 'subscriptions-changed') return this.translateSubscription(event);
        if (topic === 'rooms-changed') return this.translateRoom(event);
        return IGNORE;
      }

      case STREAM_NOTIFY_LOGGED: {
        // Presence goes through the SAME stream, but it is volatile and handled by
        // `PresenceEngine`: silence, not an anomaly; otherwise every round trip of a
        // contact would inflate the ignored counter.
        if (event.eventKey === PRESENCE_EVENT) return SILENCE;
        if (event.eventKey !== AVATAR_EVENT) return IGNORE;
        return translateAvatar(event);
      }

      case STREAM_NOTIFY_ROOM: {
        const topic = topicOf(event.eventKey);
        // `user-activity` is EXPECTED (the room screen subscribes to it for typing)
        // but handled elsewhere: counting it as an anomaly would drown the counter
        // in typing beats.
        if (topic === 'user-activity') return SILENCE;
        if (topic !== 'deleteMessage') return IGNORE;
        const document = objectOrNull(event.args[0]);
        const id = typeof document?._id === 'string' ? document._id : null;
        return id === null ? IGNORE : { kind: 'change', change: { type: 'message-deleted', id } };
      }

      default:
        return IGNORE;
    }
  }

  /**
   * `subscriptions-changed` delivers `[action, document]`. 'removed': the
   * account left the room (or it was deleted); RC only sends the
   * SUBSCRIPTION's `_id`: enough to find it, not enough to rebuild it. Without
   * this case, an upsert would keep a deleted room as a GHOST.
   */
  private translateSubscription(event: DdpEvent): Translation {
    const document = notificationDocument(event);
    if (document === null) return IGNORE;
    if (notificationAction(event) === 'removed') {
      const subId = typeof document._id === 'string' ? document._id : null;
      return subId === null ? IGNORE : { kind: 'change', change: { type: 'subscription-deleted-by-sub', subId } };
    }
    const subscription = toSubscription(document);
    return subscription === null ? IGNORE : { kind: 'change', change: { type: 'subscription', doc: subscription } };
  }

  private translateRoom(event: DdpEvent): Translation {
    const document = notificationDocument(event);
    if (document === null) return IGNORE;
    if (notificationAction(event) === 'removed') {
      const rid = typeof document._id === 'string' ? document._id : null;
      return rid === null ? IGNORE : { kind: 'change', change: { type: 'room-deleted', rid } };
    }
    const room = toRoom(document, this.me, this.myUid);
    return room === null ? IGNORE : { kind: 'change', change: { type: 'room', doc: room } };
  }
}

/**
 * `updateAvatar`: only one of the two keys is present. A missing `etag`
 * signals a REMOVED avatar (`users.resetAvatar`); we then set the
 * `AVATAR_NO_PHOTO` marker rather than nothing, so the URI changes anyway.
 */
function translateAvatar(event: DdpEvent): Translation {
  const document = objectOrNull(event.args[0]);
  if (document === null) return IGNORE;
  const username = typeof document.username === 'string' ? document.username : null;
  const rid = typeof document.rid === 'string' ? document.rid : null;
  if (username === null && rid === null) return IGNORE;
  const etag = typeof document.etag === 'string' && document.etag !== '' ? document.etag : null;
  return {
    kind: 'change',
    change: { type: 'avatar', username, rid, etag: etag ?? AVATAR_NO_PHOTO },
  };
}

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/** `<uid>/subscriptions-changed` -> `subscriptions-changed`. */
function topicOf(eventKey: string): string {
  return eventKey.split('/').slice(1).join('/');
}

/**
 * `stream-notify-user` sends `args: ['updated', {...}]` (checked on 8.5): the
 * document is the SECOND argument when the first is an action. Some versions
 * send the document directly; we accept both shapes.
 */
function notificationDocument(event: DdpEvent): Record<string, unknown> | null {
  if (typeof event.args[0] === 'string') return objectOrNull(event.args[1]);
  return objectOrNull(event.args[0]);
}

/** The ACTION of an `[action, document]` notification, or null if the document comes directly. */
function notificationAction(event: DdpEvent): string | null {
  return typeof event.args[0] === 'string' ? event.args[0] : null;
}
