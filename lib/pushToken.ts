/**
 * Enregistrement du jeton FCM auprès de Rocket.Chat.
 *
 * Contrat vérifié dans le code serveur au tag 8.5.0
 * (`apps/meteor/app/api/server/v1/push.ts`) :
 *
 * - `POST /api/v1/push.token`, corps `{ type, value, appName }`, tous trois
 *   requis, `additionalProperties: false` — ne rien envoyer de plus.
 * - `type` vaut `'gcm'` pour Android (nommage historique ; la valeur est bien
 *   un jeton FCM v1) ou `'apn'` pour iOS.
 * - `appName` est une **chaîne libre** (`minLength: 1`) qui étiquette le jeton ;
 *   aucun lien imposé avec l'applicationId.
 * - `DELETE /api/v1/push.token`, corps `{ token }`, dé-enregistre — à appeler
 *   au logout, sinon le serveur poussera vers un appareil déconnecté.
 */

import { Platform } from 'react-native';

export const APP_NAME = 'rocket-vibe';

type Auth = { baseUrl: string; token: string; userId: string };

class ErreurPush extends Error {
  readonly statut: number;

  constructor(message: string, statut: number) {
    super(message);
    this.name = 'ErreurPush';
    this.statut = statut;
  }
}

async function appelPush(methode: 'POST' | 'DELETE', auth: Auth, corps: object): Promise<void> {
  const reponse = await fetch(`${auth.baseUrl}/api/v1/push.token`, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': auth.token,
      'X-User-Id': auth.userId,
    },
    body: JSON.stringify(corps),
  });
  // Un proxy peut répondre du HTML : « JSON invalide » ne doit pas fuir en
  // SyntaxError brut (même classe de bug corrigée dans lib/server.ts).
  const texte = await reponse.text();
  let json: { success?: boolean; error?: string };
  try {
    json = JSON.parse(texte) as typeof json;
  } catch {
    throw new ErreurPush(`push.token ${methode} : réponse non JSON`, reponse.status);
  }
  if (!reponse.ok || json.success !== true) {
    throw new ErreurPush(
      `push.token ${methode} a échoué : ${json.error ?? '?'}`,
      reponse.status,
    );
  }
}

export function enregistrerJeton(auth: Auth, jeton: string): Promise<void> {
  return appelPush('POST', auth, {
    type: Platform.OS === 'ios' ? 'apn' : 'gcm',
    value: jeton,
    appName: APP_NAME,
  });
}

export async function desenregistrerJeton(auth: Auth, jeton: string): Promise<void> {
  try {
    await appelPush('DELETE', auth, { token: jeton });
  } catch (e) {
    // Vérifié contre 8.5 : un DELETE rejoué répond 404 « Resource not found ».
    // Un jeton déjà absent est un dé-enregistrement réussi, pas un échec —
    // sinon le logout casserait après une réinstallation de l'app. On teste le
    // statut, pas le texte du message, qui peut être reformulé.
    if (e instanceof ErreurPush && e.statut === 404) return;
    throw e;
  }
}
