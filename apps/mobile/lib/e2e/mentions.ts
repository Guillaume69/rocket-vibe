/**
 * Les mentions d'un message chiffré. Le serveur ne lit pas le texte, donc il ne
 * sait notifier que ce qu'on lui déclare dans `e2eMentions` (sondé sur 8.5 :
 * `e2eUserMentions: ['@bob']` donne la mention `bob`). Même règle que le client
 * web : un `@` ou un `#` en début de texte ou après un blanc.
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
