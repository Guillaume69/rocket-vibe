/**
 * Les mentions d'un message chiffré. Le serveur ne lit pas le texte, donc il ne
 * sait notifier que ce qu'on lui déclare dans `e2eMentions` (sondé sur 8.5 :
 * `e2eUserMentions: ['@bob']` donne la mention `bob`). Même règle que le client
 * web : un `@` ou un `#` en début de texte ou après un blanc.
 */

const NOM = '[0-9a-zA-Z-_.]+';
const UTILISATEUR = new RegExp(`(?:^|\\s)(@${NOM}(?:@${NOM})?)`, 'g');
const SALON = new RegExp(`(?:^|\\s)(#${NOM}(?:@${NOM})?)`, 'g');

export type MentionsE2E = { e2eUserMentions: string[]; e2eChannelMentions: string[] };

function extraire(texte: string, motif: RegExp): string[] {
  return [...new Set(Array.from(texte.matchAll(motif), (m) => m[1].replace(/[.-]+$/, '')))];
}

export function mentionsE2E(texte: string): MentionsE2E {
  return { e2eUserMentions: extraire(texte, UTILISATEUR), e2eChannelMentions: extraire(texte, SALON) };
}
