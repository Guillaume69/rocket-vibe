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
import type { Fournisseur } from '../lib/fournisseur.ts';
import type { ClientRest } from '../lib/rest.ts';
import { creerFournisseurRC } from './rocketchat/index.ts';
import { creerFournisseurRV } from './rocketvibe/index.ts';
import type { NativeStore } from './rocketvibe/store.ts';

export function creerFournisseur(
  session: Session,
  client: ClientRest,
  genererId: () => string,
  nativeStore?: NativeStore,
  nativeOptions:Parameters<typeof creerFournisseurRV>[4]={},
): Fournisseur {
  switch (session.genre) {
    case 'rocketchat':
      return creerFournisseurRC(session, client, genererId);
    case 'rocketvibe':
      if (!nativeStore) throw new Error('Native provider requires its account store');
      return creerFournisseurRV(session,client,genererId,nativeStore,nativeOptions);
  }
}
