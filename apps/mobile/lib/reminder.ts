/**
 * Mattermost's reminder post (`type: "reminder"`), worded by the server in its
 * own language. The translator stores it as the English sentence below, rebuilt
 * from the post's props, and the row shows it in the app's language.
 *
 * Pure module: the translator `t` is injected, as in `lib/systemMessages.ts`.
 */

import type { TranslateFn } from '../ui/messages.ts';

const PREFIX = "Hi there, here's your reminder about this message from @";
const STORED = /^Hi there, here's your reminder about this message from @([^\s:]+): (https?:\/\/\S+)$/;

export function reminderMessage(username: string, link: string): string {
  return `${PREFIX}${username}: ${link}`;
}

export function reminderParts(text: string): { username: string; link: string } | null {
  const m = STORED.exec(text);
  return m === null ? null : { username: m[1]!, link: m[2]! };
}

/** The reminder's sentence in the language of `t`; any other text unchanged. */
export function localizedReminder(t: TranslateFn, text: string): string {
  const parts = reminderParts(text);
  return parts === null ? text : t('messageRow.reminder', parts);
}
