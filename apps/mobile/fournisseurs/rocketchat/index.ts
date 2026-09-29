/**
 * Assemble un `Fournisseur` Rocket.Chat pour une session : réunit derrière la
 * façade neutre le DDP (listener), le traducteur, les actions, et les fabriques
 * d'envoi/rattrapage liées au `ClientRest`. `ui/synchro.tsx` l'orchestre sans
 * nommer Rocket.Chat. Le driver Mattermost fournira `creerFournisseurMattermost`
 * rendant le même objet.
 */

import type { Session } from '../../lib/auth.ts';
import { ClientDdp } from '../../lib/ddp.ts';
import { MoteurEnvoi } from '../../lib/envoi.ts';
import { MoteurTeleversement } from '../../lib/envoiFichiers.ts';
import {
  CAPACITES_ROCKETCHAT,
  type Fournisseur,
  type Ingerer,
  type Outbox,
  type OutboxFichiers,
} from '../../lib/fournisseur.ts';
import { EVENEMENT_PRESENCE, STREAM_NOTIFY_LOGGED } from '../../lib/presence.ts';
import { rattraperGlobal, rattraperSalon, reconcilierSalons } from '../../lib/rattrapage.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { STREAM_MESSAGES, STREAM_NOTIFY_ROOM, STREAM_NOTIFY_USER } from '../../lib/sync.ts';
import type { ChiffreurEnvoi, DepotEnvoi } from '../../lib/envoi.ts';
import type { DepotTeleversements } from '../../lib/envoiFichiers.ts';
import type { TransportUpload } from '../../lib/upload.ts';
import { ActionsRC } from './actions.ts';
import { chargerFil, chargerHistorique } from './historique.ts';
import { EVENEMENT_AVATAR, TraducteurRC } from './traducteur.ts';

function urlWebSocket(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/websocket`;
}

export function creerFournisseurRC(
  session: Session,
  client: ClientRest,
  genererId: () => string,
): Fournisseur {
  const listener = new ClientDdp(urlWebSocket(session.baseUrl));
  const traducteur = new TraducteurRC(session.username, session.userId);
  const actions = new ActionsRC(client);

  return {
    capacites: CAPACITES_ROCKETCHAT,
    listener,
    traducteur,
    actions,
    souscriptionsInitiales(): readonly (readonly [string, string])[] {
      return [
        [STREAM_NOTIFY_USER, `${session.userId}/subscriptions-changed`],
        [STREAM_NOTIFY_USER, `${session.userId}/rooms-changed`],
        [STREAM_NOTIFY_LOGGED, EVENEMENT_PRESENCE],
        // Photos de profil et de salon : le serveur diffuse la nouvelle version
        // (`etag`) à TOUS les connectés. Sans cet abonnement, un avatar changé
        // reste figé jusqu'au prochain `me`/`users.info` — voir `urlAvatar`.
        [STREAM_NOTIFY_LOGGED, EVENEMENT_AVATAR],
      ];
    },
    souscriptionsSalon(rid: string): readonly (readonly [string, string])[] {
      // Le format « rid » / « rid/sujet » est CELUI de Rocket.Chat : fabriqué
      // ici, parsé par `sujetDe` dans le traducteur — nulle part ailleurs.
      return [
        [STREAM_MESSAGES, rid],
        [STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`],
        [STREAM_NOTIFY_ROOM, `${rid}/user-activity`],
      ];
    },
    chargerHistorique: (moteur, rid, type, latest) =>
      chargerHistorique(client, moteur, rid, type, latest),
    chargerFil: (moteur, filId, estAbandonne) => chargerFil(client, moteur, filId, estAbandonne),
    creerEnvoi(depot: DepotEnvoi, ingerer: Ingerer, chiffreur?: ChiffreurEnvoi): Outbox {
      return new MoteurEnvoi({
        depot,
        client,
        moi: { id: session.userId, username: session.username },
        genererId,
        ingerer,
        chiffreur,
      });
    },
    creerTeleversement(
      depot: DepotTeleversements,
      transport: TransportUpload,
      ingerer: Ingerer,
      crochets?: {
        supprimerFichierLocal?: (uri: string) => Promise<void>;
        rafraichirSalon?: (rid: string) => Promise<void>;
      },
    ): OutboxFichiers {
      return new MoteurTeleversement({
        depot,
        client,
        transport,
        genererId,
        ingerer,
        supprimerFichierLocal: crochets?.supprimerFichierLocal,
        rafraichirSalon: crochets?.rafraichirSalon,
      });
    },
    rattraperGlobal: (moteur, estAbandonne) => rattraperGlobal(client, moteur, estAbandonne),
    rattraperSalon: (moteur, rid, estAbandonne) =>
      rattraperSalon(client, moteur, rid, estAbandonne),
    reconcilier: (moteur, estAbandonne) => reconcilierSalons(client, moteur, estAbandonne),
  };
}
