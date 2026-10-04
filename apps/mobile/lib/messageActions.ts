/**
 * Which message actions to show: ONE pure function (8.2).
 *
 * The edit window comes from SETTINGS (`Message_AllowEditing_BlockEditInMinutes`),
 * not permissions: the trap noted in EXECUTION.md. Granted permissions
 * (`lib/permissions.ts`) come in as a parameter, and the rules are the 8.5
 * server's (`canDeleteMessageAsync`, `updateMessage`, `pinMessage`). Until they
 * are loaded (`null`), we offer what a member can do on their own messages,
 * plus pinning, and the server stays the authority: a wrongly shown action
 * fails cleanly with its error message.
 */

import { stripQuotePrefix } from './quote.ts';
import { attachmentToShare } from './attachment.ts';
import { ENCRYPTED_TYPE } from './normalize.ts';
import { RestError } from './rest.ts';

export type MessageRules = {
  editAllowed: boolean;
  /** 0 = no limit. */
  editBlockMinutes: number;
  deleteAllowed: boolean;
  deleteBlockMinutes: number;
  pinAllowed: boolean;
  starAllowed: boolean;
};

export type ActionContext = {
  /**
   * `text` tells a READABLE encrypted message (decrypted in the database by the
   * E2E unlock) from a still opaque one: see the guard in `actionsPossibles`.
   */
  message: {
    authorId: string;
    ts: number;
    systemType: string | null;
    text: string | null;
    attachments: string | null;
    pinned: boolean;
    /** Starred by ME (`lib/marks.ts`). */
    starred: boolean;
  };
  me: string;
  rules: MessageRules;
  /** Permissions granted in this room; `null`: not known (yet). */
  permissions: string[] | null;
  readOnly: boolean;
  /**
   * Encrypted room: replies go in a thread, not as quotes. A quote is a card the
   * server builds from the text, and it cannot read this one.
   */
  encrypted: boolean;
  /** Sheet opened from a thread screen: replies already go there. */
  inThread: boolean;
  now: number;
};

export type ActionMessage =
  | 'react'
  | 'reply'
  | 'replyInThread'
  | 'copy'
  | 'share'
  | 'save'
  | 'edit'
  | 'delete'
  | 'pin'
  | 'unpin'
  | 'star'
  | 'unstar';

function withinDelay(context: ActionContext, minutes: number): boolean {
  if (minutes <= 0) return true; // 0 = unlimited
  return context.now - context.message.ts <= minutes * 60_000;
}

export function actionsPossibles(context: ActionContext): ActionMessage[] {
  const actions: ActionMessage[] = [];
  const { message, me, rules, permissions, readOnly, encrypted, inThread } = context;

  // A system message cannot be edited, pinned, or reacted to.
  //
  // BUT `e2e` is not a system type for display purposes: it is an ORDINARY
  // message whose body is encrypted, and `db/upserts.ts` only fills `text` on
  // decryption, the marker stays. Once readable, ui/messageRow.tsx renders it
  // like any other message; the early return below therefore opened an EMPTY
  // action sheet on every message of an encrypted room.
  const readableEncrypted = message.systemType === ENCRYPTED_TYPE && message.text !== null;
  if (message.systemType !== null && !readableEncrypted) return actions;

  if (!readOnly) actions.push('react');
  // Reply by quoting (`lib/quote.ts`): any message, someone else's or one's
  // own, as long as one CAN post in the room.
  if (!readOnly && !encrypted) actions.push('reply');
  if (!readOnly && !inThread) actions.push('replyInThread');
  const text = textToCopy(message.text) !== null;
  if (text) actions.push('copy');
  const file = attachmentToShare(message.attachments) !== null;
  if (text || file) actions.push('share');
  if (file) actions.push('save');

  const mine = message.authorId === me;
  // Unknown: own messages and pinning stay offered, nothing more.
  const a = (permission: string, ifUnknown: boolean): boolean =>
    permissions === null ? ifUnknown : permissions.includes(permission);
  // `bypass-time-limit-edit-and-delete` lifts the time limits (edit AND
  // delete); `edit-message` and `delete-message` open other people's messages,
  // WITHIN the limit; `force-delete-message` deletes unconditionally.
  const immediate = a('bypass-time-limit-edit-and-delete', false);
  if (
    (a('edit-message', false) || (mine && rules.editAllowed)) &&
    (immediate || withinDelay(context, rules.editBlockMinutes))
  ) {
    actions.push('edit');
  }
  if (
    a('force-delete-message', false) ||
    (rules.deleteAllowed &&
      (a('delete-message', false) || (mine && a('delete-own-message', true))) &&
      (immediate || withinDelay(context, rules.deleteBlockMinutes)))
  ) {
    actions.push('delete');
  }
  if (rules.pinAllowed && a('pin-message', true)) {
    actions.push(message.pinned ? 'unpin' : 'pin');
  }
  if (rules.starAllowed) actions.push(message.starred ? 'unstar' : 'star');

  return actions;
}

/** The text "Copy" and "Share" take: without the quote permalink. */
export function textToCopy(text: string | null): string | null {
  const words = stripQuotePrefix(text ?? '').trim();
  return words === '' ? null : words;
}

type MessageReader = {
  get(path: string, options?: { params?: Record<string, unknown> }): Promise<unknown>;
};

/**
 * After a `chat.delete` failure: does the message still exist server-side?
 * The classic ghost (deleted from ANOTHER client while this app was closed,
 * reconciliation missed) answers "No message found with the id …"; yet the
 * user's goal is already reached, only the local row is left to purge. Rather
 * than depend on the error's WORDING (fragile across server versions), confirm
 * with `chat.getMessage`, as `outbox.ts` confirms a delivery: a 400 here = the
 * server no longer knows this message (verified on 8.5: `API.v1.failure`).
 * Any other outcome (message still there, network error (status 0), 429)
 * means "we don't know": the original error stays the right answer.
 */
export async function messageGoneFromServer(
  client: MessageReader,
  msgId: string,
): Promise<boolean> {
  try {
    await client.get('chat.getMessage', { params: { msgId } });
    return false;
  } catch (e) {
    return e instanceof RestError && e.status === 400;
  }
}

type PublicSetting = { _id?: string; value?: unknown };

/** To match against the `count=0` read of settings.public (`query` died in 7.0). */
export function rulesFromSettings(settings: PublicSetting[]): MessageRules {
  const values = new Map<string, unknown>();
  for (const r of settings) {
    if (typeof r._id === 'string') values.set(r._id, r.value);
  }
  const count = (key: string): number => {
    const v = values.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    editAllowed: values.get('Message_AllowEditing') !== false,
    editBlockMinutes: count('Message_AllowEditing_BlockEditInMinutes'),
    deleteAllowed: values.get('Message_AllowDeleting') !== false,
    deleteBlockMinutes: count('Message_AllowDeleting_BlockDeleteInMinutes'),
    pinAllowed: values.get('Message_AllowPinning') !== false,
    starAllowed: values.get('Message_AllowStarring') !== false,
  };
}
