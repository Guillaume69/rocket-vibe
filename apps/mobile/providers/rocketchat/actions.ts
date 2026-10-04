/**
 * Actions unitaires Rocket.Chat sur les messages. Enveloppe fine sur `ClientRest`
 * — isole les endpoints RC (`chat.react`, `chat.update`, …) et leurs quirks de
 * paramètres, pour que les écrans ne les nomment plus. Le driver Mattermost
 * fournira son propre `ActionsFournisseur` (endpoints `/posts`, `/reactions`, …).
 */

import { mentionsE2E } from '../../lib/e2e/mentions.ts';
import type { OutboxEncryptor } from '../../lib/outbox.ts';
import type { ProviderActions } from '../../lib/provider.ts';
import { toMessage, type MessageLocal } from '../../lib/normalize.ts';
import type { ClientRest } from '../../lib/rest.ts';

export class ActionsRC implements ProviderActions {
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
  async react(_rid: string, mid: string, emoji: string, mettre: boolean): Promise<void> {
    await this.client.post('chat.react', {
      body: { messageId: mid, emoji: `:${emoji}:`, shouldReact: mettre },
    });
  }

  /**
   * Un message chiffré se modifie par `content`, que le serveur n'accepte que
   * sur un message `e2e` — et un `text` y serait refusé.
   */
  async edit(rid: string, mid: string, texte: string, chiffreur?: OutboxEncryptor): Promise<void> {
    if (chiffreur === undefined) {
      await this.client.post('chat.update', { body: { roomId: rid, msgId: mid, text: texte } });
      return;
    }
    const content = chiffreur.encrypt(rid, { msg: texte });
    if (content === null) throw new Error('chat.update: clé du salon indisponible');
    await this.client.post('chat.update', {
      body: { roomId: rid, msgId: mid, content, e2eMentions: mentionsE2E(texte) },
    });
  }

  async delete(rid: string, mid: string): Promise<void> {
    await this.client.post('chat.delete', { body: { roomId: rid, msgId: mid } });
  }

  async pin(_rid: string, mid: string): Promise<void> {
    await this.client.post('chat.pinMessage', { body: { messageId: mid } });
  }

  async unpin(_rid: string, mid: string): Promise<void> {
    await this.client.post('chat.unPinMessage', { body: { messageId: mid } });
  }

  async star(_rid: string, mid: string, mettre: boolean): Promise<void> {
    await this.client.post(mettre ? 'chat.starMessage' : 'chat.unStarMessage', {
      body: { messageId: mid },
    });
  }

  listPinned(rid: string): Promise<MessageLocal[]> {
    return this.list('chat.getPinnedMessages', rid);
  }

  listStarred(rid: string): Promise<MessageLocal[]> {
    return this.list('chat.getStarredMessages', rid);
  }

  private async list(chemin: string, rid: string): Promise<MessageLocal[]> {
    const reponse = await this.client.get<{ messages?: Record<string, unknown>[] }>(chemin, {
      params: { roomId: rid, count: 50 },
    });
    return (reponse.messages ?? [])
      .map((brut) => toMessage(brut))
      .filter((m): m is MessageLocal => m !== null)
      .sort((a, b) => b.ts - a.ts);
  }

  async markRead(rid: string): Promise<void> {
    await this.client.post('subscriptions.read', { body: { rid } });
  }

  async openOrCreateDm(
    username: string,
  ): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    const reponse = await this.client.post<{ room?: Record<string, unknown> }>('im.create', {
      body: { username },
    });
    const salonBrut = reponse.room;
    const rid = salonBrut?._id;
    // Un 200 sans salon est anormal (proxy, réponse tronquée) : message de
    // DIAGNOSTIC, pas une phrase d'écran — l'appelant met en phrase s'il veut.
    if (salonBrut === undefined || typeof rid !== 'string') {
      throw new Error('im.create: réponse sans salon');
    }
    return { rid, rawRoom: salonBrut };
  }
}
