/**
 * Actions unitaires Rocket.Chat sur les messages. Enveloppe fine sur `ClientRest`
 * — isole les endpoints RC (`chat.react`, `chat.update`, …) et leurs quirks de
 * paramètres, pour que les écrans ne les nomment plus. Le driver Mattermost
 * fournira son propre `ActionsFournisseur` (endpoints `/posts`, `/reactions`, …).
 */

import type { ActionsFournisseur } from '../../lib/fournisseur.ts';
import { versMessage, type MessageLocal } from '../../lib/normaliser.ts';
import type { ClientRest } from '../../lib/rest.ts';

export class ActionsRC implements ActionsFournisseur {
  // Champ ordinaire, pas une « parameter property » : cette dernière n'est pas
  // une syntaxe effaçable et empêcherait de charger le module sous Node (test).
  private readonly client: ClientRest;

  constructor(client: ClientRest) {
    this.client = client;
  }

  /**
   * `emoji` est le SHORTNAME sans deux-points (`+1`, `heart`) : `chat.react`
   * refuse l'unicode brut (« Invalid emoji provided ») et veut `:code:`.
   * `mettre` mappe sur `shouldReact` — poser ou retirer sans ambiguïté de bascule.
   */
  async reagir(_rid: string, mid: string, emoji: string, mettre: boolean): Promise<void> {
    await this.client.post('chat.react', {
      corps: { messageId: mid, emoji: `:${emoji}:`, shouldReact: mettre },
    });
  }

  async modifier(rid: string, mid: string, texte: string): Promise<void> {
    await this.client.post('chat.update', { corps: { roomId: rid, msgId: mid, text: texte } });
  }

  async supprimer(rid: string, mid: string): Promise<void> {
    await this.client.post('chat.delete', { corps: { roomId: rid, msgId: mid } });
  }

  async epingler(_rid: string, mid: string): Promise<void> {
    await this.client.post('chat.pinMessage', { corps: { messageId: mid } });
  }

  async desepingler(_rid: string, mid: string): Promise<void> {
    await this.client.post('chat.unPinMessage', { corps: { messageId: mid } });
  }

  async etoiler(_rid: string, mid: string, mettre: boolean): Promise<void> {
    await this.client.post(mettre ? 'chat.starMessage' : 'chat.unStarMessage', {
      corps: { messageId: mid },
    });
  }

  listerEpingles(rid: string): Promise<MessageLocal[]> {
    return this.lister('chat.getPinnedMessages', rid);
  }

  listerEtoiles(rid: string): Promise<MessageLocal[]> {
    return this.lister('chat.getStarredMessages', rid);
  }

  private async lister(chemin: string, rid: string): Promise<MessageLocal[]> {
    const reponse = await this.client.get<{ messages?: Record<string, unknown>[] }>(chemin, {
      params: { roomId: rid, count: 50 },
    });
    return (reponse.messages ?? [])
      .map((brut) => versMessage(brut))
      .filter((m): m is MessageLocal => m !== null)
      .sort((a, b) => b.horodatage - a.horodatage);
  }

  async marquerLu(rid: string): Promise<void> {
    await this.client.post('subscriptions.read', { corps: { rid } });
  }

  async ouvrirOuCreerDm(
    username: string,
  ): Promise<{ rid: string; salonBrut: Record<string, unknown> }> {
    const reponse = await this.client.post<{ room?: Record<string, unknown> }>('im.create', {
      corps: { username },
    });
    const salonBrut = reponse.room;
    const rid = salonBrut?._id;
    // Un 200 sans salon est anormal (proxy, réponse tronquée) : message de
    // DIAGNOSTIC, pas une phrase d'écran — l'appelant met en phrase s'il veut.
    if (salonBrut === undefined || typeof rid !== 'string') {
      throw new Error('im.create: réponse sans salon');
    }
    return { rid, salonBrut };
  }
}
