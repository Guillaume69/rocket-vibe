/**
 * Enregistrement du jeton FCM auprès de Rocket.Chat.
 *
 * Contrat vérifié dans le code serveur au tag 8.5.0
 * (`apps/meteor/app/api/server/v1/push.ts`) puis contre le serveur Docker :
 *
 * - `POST /api/v1/push.token`, corps `{ type, value, appName }`, tous trois
 *   requis, `additionalProperties: false` — ne rien envoyer de plus.
 * - `type` vaut `'gcm'` (nommage historique ; la valeur est bien un jeton
 *   FCM v1), sous iOS comme sous Android puisque les deux passent par FCM.
 *   Le serveur accepte aussi `'apn'`, que l'app n'envoie pas.
 * - `appName` est une **chaîne libre** (`minLength: 1`) ; aucun lien imposé
 *   avec l'applicationId.
 * - `DELETE /api/v1/push.token`, corps `{ token }`. Un rejeu répond **404** :
 *   un jeton déjà absent est un dé-enregistrement réussi, pas un échec, sinon
 *   le logout casserait après une réinstallation.
 *
 * Le transport (en-têtes, rejeu sur 429, JSON défensif, 2FA) vient de
 * `ClientRest` : on ne le réimplémente pas ici.
 */

import { ClientRest, RestError } from './rest.ts';

export const APP_NAME = 'rocket-vibe';

export type TokenType = 'gcm' | 'apn';

export function registerToken(
  client: ClientRest,
  token: string,
  type: TokenType,
): Promise<unknown> {
  return client.post('push.token', { body: { type, value: token, appName: APP_NAME } });
}

export async function unregisterToken(client: ClientRest, token: string): Promise<void> {
  try {
    await client.delete('push.token', { body: { token } });
  } catch (e) {
    // On teste le statut, pas le texte du message, qui peut être reformulé.
    if (e instanceof RestError && e.status === 404) return;
    throw e;
  }
}
