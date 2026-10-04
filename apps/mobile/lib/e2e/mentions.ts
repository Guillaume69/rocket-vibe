/**
 * The mentions of an encrypted message. The server cannot read the text, so it
 * can only notify what it is told in `e2eMentions` (probed on 8.5:
 * `e2eUserMentions: ['@bob']` yields the mention `bob`). Same rule as the web
 * client: an `@` or a `#` at the start of the text or after whitespace.
 */

const NAME = '[0-9a-zA-Z-_.]+';
const USER = new RegExp(`(?:^|\\s)(@${NAME}(?:@${NAME})?)`, 'g');
const ROOM = new RegExp(`(?:^|\\s)(#${NAME}(?:@${NAME})?)`, 'g');

export type MentionsE2E = { e2eUserMentions: string[]; e2eChannelMentions: string[] };

function extract(text: string, pattern: RegExp): string[] {
  return [...new Set(Array.from(text.matchAll(pattern), (m) => m[1].replace(/[.-]+$/, '')))];
}

export function mentionsE2E(text: string): MentionsE2E {
  return { e2eUserMentions: extract(text, USER), e2eChannelMentions: extract(text, ROOM) };
}
