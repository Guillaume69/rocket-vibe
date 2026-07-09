/**
 * Enregistrement du jeton FCM auprès de Rocket.Chat.
 *
 * Contrat vérifié dans le code serveur au tag 8.5.0
 * (`apps/meteor/app/api/server/v1/push.ts`) puis contre le serveur Docker :
 *
 * - `POST /api/v1/push.token`, corps `{ type, value, appName }`, tous trois
 *   requis, `additionalProperties: false` — ne rien envoyer de plus.
 * - `type` vaut `'gcm'` pour Android (nommage historique ; la valeur est bien
 *   un jeton FCM v1) ou `'apn'` pour iOS.
 * - `appName` est une **chaîne libre** (`minLength: 1`) ; aucun lien imposé
 *   avec l'applicationId.
 * - `DELETE /api/v1/push.token`, corps `{ token }`. Un rejeu répond **404** :
 *   un jeton déjà absent est un dé-enregistrement réussi, pas un échec, sinon
 *   le logout casserait après une réinstallation.
 *
 * Le transport (en-têtes, rejeu sur 429, JSON défensif, 2FA) vient de
 * `ClientRest` : on ne le réimplémente pas ici.
 */

import { ClientRest, ErreurRest } from './rest.ts';

export const APP_NAME = 'rocket-vibe';

export type TypeJeton = 'gcm' | 'apn';

export function enregistrerJeton(
  client: ClientRest,
  jeton: string,
  type: TypeJeton,
): Promise<unknown> {
  return client.post('push.token', { corps: { type, value: jeton, appName: APP_NAME } });
}

export async function desenregistrerJeton(client: ClientRest, jeton: string): Promise<void> {
  try {
    await client.supprimer('push.token', { corps: { token: jeton } });
  } catch (e) {
    // On teste le statut, pas le texte du message, qui peut être reformulé.
    if (e instanceof ErreurRest && e.statut === 404) return;
    throw e;
  }
}
