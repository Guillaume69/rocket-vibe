/**
 * Translation of Rocket.Chat system messages (`t` on the message).
 *
 * Server conventions, observed on 8.5: for most types, `msg` carries the
 * action's PARAMETER (the added user's name, the room's new name, the
 * topic...), not a sentence. `u` (the author) is who acted.
 *
 * An unknown type yields a generic sentence rather than nothing: the server
 * adds some with every version, and a room that "loses" events is more
 * confusing than a neutral mention.
 *
 * The sentences themselves live in the catalogue (`ui/messages`, `sys.*` keys):
 * this module stays PURE, the translator `t` is INJECTED (type-only import, no
 * platform import), so its tests run under Node with a real `t`.
 */

import type { TranslateFn } from '../ui/messages.ts';

/**
 * Type → translation key table. Types whose rendering depends on a parameter
 * (`{p}`) receive it at call time; cases where an EMPTY `msg` changes the
 * sentence (topic cleared, anonymous welcome) are handled apart in `systemText`.
 */
const KEYS = {
  'rv-room-created':'sys.roomCreated',
  'rv-room-private':'sys.roomPrivate',
  'rv-room-public':'sys.roomPublic',
  'rv-role-owner':'sys.roleOwner',
  'rv-role-moderator':'sys.roleModerator',
  'rv-role-member':'sys.roleMember',
  uj: 'sys.uj',
  ujt: 'sys.ujt',
  ul: 'sys.ul',
  ult: 'sys.ult',
  ru: 'sys.ru',
  au: 'sys.au',
  r: 'sys.r',
  rm: 'sys.rm',
  uploaded: 'sys.uploaded',
  message_pinned: 'sys.messagePinned',
  message_unpinned: 'sys.messageUnpinned',
  // Pinning in an ENCRYPTED room produces a distinct type server-side, read in
  // the 8.5.1 bundle: `originalMessage.t === 'e2e' ?
  // 'message_pinned_e2e' : 'message_pinned'`. Without these two lines, the row
  // shows "(system action "message_pinned_e2e")". The label is the same: what
  // is pinned is still a message.
  message_pinned_e2e: 'sys.messagePinned',
  message_unpinned_e2e: 'sys.messageUnpinned',
  room_changed_avatar: 'sys.roomChangedAvatar',
  room_changed_privacy: 'sys.roomChangedPrivacy',
  'room-set-read-only': 'sys.setReadOnly',
  'room-removed-read-only': 'sys.removedReadOnly',
  'room-archived': 'sys.archived',
  'room-unarchived': 'sys.unarchived',
  'user-muted': 'sys.userMuted',
  'user-unmuted': 'sys.userUnmuted',
  'subscription-role-added': 'sys.roleAdded',
  'subscription-role-removed': 'sys.roleRemoved',
  'room-allowed-reacting': 'sys.allowedReacting',
  'room-disallowed-reacting': 'sys.disallowedReacting',
  'message-deleted-notification': 'sys.messageDeleted',
} as const satisfies Record<string, Parameters<TranslateFn>[0]>;

/** Types where an EMPTY `msg` drops the ": ..." part, handled outside the table. */
const WITH_EMPTY_CASE = {
  room_changed_topic: { removed: 'sys.topicRemoved', full: 'sys.topic' },
  room_changed_announcement: { removed: 'sys.announcementRemoved', full: 'sys.announcement' },
  room_changed_description: { removed: 'sys.descriptionRemoved', full: 'sys.description' },
} as const satisfies Record<string, { removed: Parameters<TranslateFn>[0]; full: Parameters<TranslateFn>[0] }>;

/**
 * A system message's sentence, in the language carried by `t`. `param` is the
 * message's raw `msg`, empty for actions that have none.
 */
export function systemText(t: TranslateFn, type: string, param: string | null): string {
  const p = param ?? '';

  // Welcome: empty `msg` = anonymous welcome ("welcome!"), otherwise named.
  if (type === 'wm') return p === '' ? t('sys.wmEmpty') : t('sys.wm', { p });

  const cases = WITH_EMPTY_CASE[type as keyof typeof WITH_EMPTY_CASE];
  if (cases !== undefined) return p === '' ? t(cases.removed) : t(cases.full, { p });

  const key = KEYS[type as keyof typeof KEYS];
  if (key !== undefined) return t(key, { p });

  // Unknown type: generic sentence. No dangling colon when `msg` is empty.
  return p === '' ? t('sys.unknown', { type }) : t('sys.unknownWithParam', { type, p });
}

/**
 * PREVIEW label for the room list, when the last message has no text to show
 * (`lastMessage` null although the room does have a last message, see
 * `lastMessageType`). `null` = nothing to say, the row stays empty as before.
 *
 * Deliberately SEPARATE from `systemText`: its sentences are predicates, read
 * after the author name shown just above in the timeline ("bob" + "joined the
 * room"). The room list shows no author: the same text there would read
 * "joined the room", with no subject. Hence a standalone label, and only for
 * the types that need one: today the video call, the only one whose content
 * lives entirely in `blocks`.
 */
export function systemPreview(t: TranslateFn, type: string | null, param = ''): string | null {
  if (type?.startsWith('rv-call')) return callSummaryText(t, type, param);
  return type === 'videoconf' ? t('home.callPreview') : null;
}

/** "12 min", "45 s", "1 h 05": a call's length, as short as it reads. */
export function callDuration(t: TranslateFn, seconds: number): string {
  if (seconds < 60) return t('call.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('call.minutes', { n: minutes });
  return t('call.hours', { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, '0') });
}

/**
 * A RocketVibe call row (`rv-call-<state>`, see providers/rocketvibe/systemMessages.ts):
 * its outcome, with the duration once an answered call is over.
 */
export function callSummaryText(t: TranslateFn, type: string, param: string): string {
  switch (type) {
    case 'rv-call-ringing': return t('call.ringing');
    case 'rv-call-declined': return t('call.declined');
    case 'rv-call-missed': return t('call.missed');
    case 'rv-call-cancelled': return t('call.cancelled');
    case 'rv-call-answered': {
      const seconds = Number(param);
      return param !== '' && Number.isFinite(seconds) ? t('call.answeredFor', { d: callDuration(t, seconds) }) : t('call.answered');
    }
    default: return t('call.voice');
  }
}
