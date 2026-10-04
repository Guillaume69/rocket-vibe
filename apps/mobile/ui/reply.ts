/**
 * Reply (quote) target: the channel between the action sheet and the
 * composer.
 *
 * Same family as `attachmentSource`, but as OBSERVABLE STATE rather than a
 * promise: the sheet arms the target then closes; the composer, mounted well
 * before, shows it in its banner while it lives, cancelled (✕, back) or
 * settled by sending. Key = `rid` for the room, `rid:threadId` for a thread:
 * both composers can coexist (the thread is stacked on the room) without
 * stealing each other's target. Memory only, on purpose: unlike the draft, a
 * pending quote survives neither a restart nor the END OF SESSION.
 *
 * The "nor the end of session" part was long an intention, not a fact: a
 * logout only unmounts the React tree, it does not clear a module store. The
 * kept permalink embeds the `baseUrl` (`lib/quote.ts`), so the first message
 * typed after reconnecting went out prefixed with the previous session's
 * permalink: the old server quoted in a message posted on the new one. Hence
 * `forgetReplies`, called when `SyncProvider` unmounts.
 */

import { useSyncExternalStore } from 'react';

export type ReplyTarget = {
  /** `_id` of the quoted message. */
  id: string;
  /** Username of the quoted author; the snapshot is enough for a banner. */
  author: string | null;
  /** Excerpt of the quoted text, already stripped of its own quote permalink. */
  preview: string | null;
  /** `?msg=` permalink; becomes the `[ ](…)` prefix at send time. */
  permalink: string;
  /** Quote attachment ready for optimistic display
   *  (`localQuoteAttachment`), quoted message's files included, chain trimmed to 2. */
  localAttachment: string;
  /** (Relative) URL of the quoted message's first image: the banner thumbnail. */
  previewImage: string | null;
};

const targets = new Map<string, ReplyTarget>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

export function requestReply(key: string, target: ReplyTarget): void {
  targets.set(key, target);
  notify();
}

export function cancelReply(key: string): void {
  if (targets.delete(key)) notify();
}

/** End of session / server switch: no quote crosses over. */
export function forgetReplies(): void {
  if (targets.size === 0) return;
  targets.clear();
  notify();
}

function subscribe(reread: () => void): () => void {
  subscribers.add(reread);
  return () => {
    subscribers.delete(reread);
  };
}

/** The target armed for this key, `null` otherwise. Updates itself. */
export function useReply(key: string): ReplyTarget | null {
  return useSyncExternalStore(subscribe, () => targets.get(key) ?? null);
}
