/**
 * Sélection du fournisseur d'après le `genre` de la session. Un seul driver
 * aujourd'hui (Rocket.Chat) ; `mattermost` s'ajoute ici en une clause quand son
 * driver existe. Le `switch` exhaustif force à traiter tout nouveau `Genre` :
 * ajouter un membre sans clause casse la compilation.
 *
 * Note transitoire : `client` est un `ClientRest` (RC). Le driver Mattermost
 * aura son propre client REST — la création du client passera par le genre en 4b.
 */

import type { Session } from '../lib/auth.ts';
import type { Provider } from '../lib/provider.ts';
import type { ClientRest } from '../lib/rest.ts';
import { createRcProvider } from './rocketchat/index.ts';

export function createProvider(
  session: Session,
  client: ClientRest,
  genererId: () => string,
): Provider {
  switch (session.genre) {
    case 'rocketchat':
      return createRcProvider(session, client, genererId);
  }
}
