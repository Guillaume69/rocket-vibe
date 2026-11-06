/**
 * Slack's single actions on messages: edit, delete, react, mark read, pin,
 * save for later (the app's star), and opening a direct conversation. The RTM
 * echo rewrites the stored rows; a failed action leaves them as they were.
 */

import type { LocalMessage } from '@rocket-vibe/provider-api/rows';
import { NOTES_CONFLICT, type EditableSettings, type GroupDmPerson, type ProviderActions, type ReadObservation, type RoomInformation, type RoomNotes, type RoomSettingsChange } from '@rocket-vibe/provider-api/provider';
import { canvasFile, canvasMarkdown } from './canvas.ts';
import { canvasSession, loadRequest, type CanvasEngine } from './canvasEngine.ts';
import type { SlackClient } from './client.ts';
import { SlackError, compareTimestamp, record } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import type { SlackLive } from './live.ts';
import type { SlackSaved } from './saved.ts';
import { slackName } from './emojis.ts';
import { markdownToMrkdwn, parseMessageId, type SlackTranslator } from './translator.ts';

type Doc = Record<string, unknown>;

/** The app's reaction code into Slack's name for the same emoji (`+1::skin-tone-3`), else as typed. */
export function reactionName(code: string): string {
  return slackName(code);
}

export class SlackActions implements ProviderActions {
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly history: SlackHistory;
  private readonly live: SlackLive;
  private readonly translator: SlackTranslator;
  private readonly saved: SlackSaved;
  private readonly canvasEngine: CanvasEngine | null;

  constructor(options: { client: SlackClient; directory: SlackDirectory; history: SlackHistory; live: SlackLive; translator: SlackTranslator; saved: SlackSaved; canvas?: CanvasEngine | null }) {
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.live = options.live;
    this.translator = options.translator;
    this.saved = options.saved;
    this.canvasEngine = options.canvas ?? null;
  }

  /** A conversation's name, kind, topic, purpose and member count, read from `conversations.info`. */
  async roomInfo(rid: string): Promise<RoomInformation> {
    const c = record((await this.client.call('conversations.info', { channel: rid, include_num_members: true })).channel);
    const direct = c.is_im === true || c.is_mpim === true;
    const value = (key: string): string | null => {
      const v = (c[key] as Doc | undefined)?.value;
      return typeof v === 'string' && v !== '' ? v : null;
    };
    return {
      id: rid,
      name: direct ? '' : typeof c.name === 'string' ? c.name : rid,
      type: direct ? 'd' : c.is_private === true ? 'p' : 'c',
      topic: value('topic'),
      description: value('purpose'),
      announcement: null,
      members: typeof c.num_members === 'number' ? c.num_members : null,
      readOnly: false,
    };
  }

  /** A channel's name, which Slack checks against its own rules (lower case, no spaces). */
  async editableSettings(rid: string): Promise<EditableSettings | null> {
    const info = await this.roomInfo(rid);
    return info.type === 'd' ? null : { name: true, texts: false, readOnly: false };
  }

  async saveRoomSettings(rid: string, fields: RoomSettingsChange): Promise<void> {
    if (fields.name !== undefined) await this.client.call('conversations.rename', { channel: rid, name: fields.name });
  }

  async react(rid: string, mid: string, emoji: string, put: boolean): Promise<void> {
    const target = this.target(rid, mid);
    const name = reactionName(emoji);
    if (name === '') throw new SlackError('invalid_name');
    try {
      await this.client.call(put ? 'reactions.add' : 'reactions.remove', { channel: target.channel, timestamp: target.ts, name });
    } catch (e) {
      // The wanted state is already there: nothing left to do.
      if (e instanceof SlackError && (e.code === (put ? 'already_reacted' : 'no_reaction'))) return;
      throw e;
    }
  }

  async edit(rid: string, mid: string, text: string): Promise<void> {
    const target = this.target(rid, mid);
    await this.client.call('chat.update', {
      channel: target.channel,
      ts: target.ts,
      text: markdownToMrkdwn(text, (u) => this.directory.idOfUsername(u)),
    });
  }

  async delete(rid: string, mid: string): Promise<void> {
    const target = this.target(rid, mid);
    await this.client.call('chat.delete', { channel: target.channel, ts: target.ts });
  }

  /** Up to the message shown, else the newest one known; never backwards, never beyond what was seen. */
  async markRead(rid: string, observation?: ReadObservation): Promise<void> {
    const seen = observation === undefined ? null : parseMessageId(observation.messageId);
    const ts = seen?.channel === rid ? seen.ts : (this.live.counts.get(rid)?.latest as string | undefined) ?? this.history.newestTs(rid);
    if (typeof ts !== 'string') return;
    const before = this.live.marks.get(rid);
    if (before !== undefined && compareTimestamp(ts, before) <= 0) return;
    await this.client.call('conversations.mark', { channel: rid, ts });
    this.live.marks.set(rid, ts);
  }

  async pin(rid: string, mid: string): Promise<void> {
    await this.pinning(rid, mid, true);
  }

  async unpin(rid: string, mid: string): Promise<void> {
    await this.pinning(rid, mid, false);
  }

  /** The screen writes the column; the set keeps it through the next read of the message. */
  async star(rid: string, mid: string, put: boolean): Promise<void> {
    const target = this.target(rid, mid);
    await this.saved.put(target.channel, target.ts, put);
  }

  async listPinned(rid: string): Promise<LocalMessage[]> {
    const body = await this.client.call('pins.list', { channel: rid });
    const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
    const raw = items.flatMap((item) => {
      const message = (item as Doc | null)?.message;
      return (item as Doc | null)?.type === 'message' && typeof message === 'object' && message !== null ? [message as Doc] : [];
    });
    const messages = await this.history.prepare(rid, raw);
    return this.translated(messages.sort((a, b) => compareTimestamp(b.ts as string, a.ts as string)));
  }

  async listStarred(rid: string): Promise<LocalMessage[]> {
    return this.translated(await this.saved.messages(rid));
  }

  /**
   * A conversation's canvas as notes. With a canvas engine it is read through
   * Quip's canvas service (its revision the document's version) and editable;
   * without one, its HTML is read, read-only.
   */
  async roomNotes(rid: string): Promise<RoomNotes> {
    const file = await this.canvas(rid);
    if (file === null) return { markdown: '', revision: '0', editable: false, updatedBy: null, updatedAt: null };
    const info = record((await this.client.call('files.info', { file })).file);
    const editor = typeof info.last_editor === 'string' ? info.last_editor : typeof info.user === 'string' ? info.user : null;
    if (editor !== null) await this.directory.ensure([editor]);
    const updatedBy = editor === null ? null : this.directory.displayName(editor);
    const updatedAt = typeof info.updated === 'number' ? info.updated * 1000 : null;
    if (this.canvasEngine !== null) {
      const { read } = await this.canvasDocument(file, this.canvasEngine);
      return { markdown: read.markdown, revision: read.version, editable: info.editable !== false, updatedBy, updatedAt };
    }
    const url = typeof info.url_private === 'string' ? info.url_private : null;
    if (url === null) throw new SlackError('invalid_response');
    return { markdown: canvasMarkdown(await this.client.fileText(url)), revision: canvasRevision(info), editable: false, updatedBy, updatedAt };
  }

  /**
   * Writes the blocks that changed as Quip's editor would, over the version
   * read: a canvas moved since then is left alone (NOTES_CONFLICT).
   */
  async saveRoomNotes(rid: string, markdown: string, revision: string): Promise<RoomNotes> {
    const engine = this.canvasEngine;
    const file = await this.canvas(rid);
    if (engine === null || file === null) throw new SlackError('not_supported');
    const { load, read } = await this.canvasDocument(file, engine);
    if (read.version !== revision) throw new SlackError(NOTES_CONFLICT);
    const session = canvasSession();
    const plan = engine.plan(load, markdown, session.id, session.suffix, Math.floor(Date.now() / 1000));
    if (plan === null) throw new SlackError('invalid_response');
    if (plan.changed > 0) {
      await this.client.canvasService('edit-document', {
        thread: read.thread, document: read.document, retry_count: '0', session: session.id, sequence: '1',
        nav_action_id: 'null', search_session_id: 'null', data_binary: plan.data, title: read.title,
      });
    }
    return this.roomNotes(rid);
  }

  private async canvasDocument(file: string, engine: CanvasEngine): Promise<{ load: string; read: NonNullable<ReturnType<CanvasEngine['read']>> }> {
    const lookup = record(record(await this.client.call('quip.lookupThreadIds', { file_ids: [file] })).lookup);
    const thread = lookup[file];
    if (typeof thread !== 'string' || thread === '') throw new SlackError('invalid_response');
    const load = await this.client.canvasService('load-data/editor/1', { request_binary: loadRequest(thread) });
    const read = engine.read(load);
    if (read === null) throw new SlackError('invalid_response');
    return { load, read };
  }

  private async canvas(rid: string): Promise<string | null> {
    return canvasFile((await this.client.call('conversations.info', { channel: rid })).channel);
  }

  openOrCreateDm(username: string, uid?: string): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    return this.openDirect([{ username, uid }]);
  }

  /** Up to eight people: Slack's group DM, the same set giving the same one back. */
  openOrCreateGroupDm(people: GroupDmPerson[]): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    return this.openDirect(people);
  }

  private async openDirect(people: readonly GroupDmPerson[]): Promise<{ rid: string; rawRoom: Record<string, unknown> }> {
    const ids = people.map(({ username, uid }) => {
      const id = uid ?? this.directory.idOfUsername(username);
      if (id === null) throw new SlackError('user_not_found');
      return id;
    });
    const rid = record((await this.client.call('conversations.open', { users: ids.join(','), return_im: true })).channel).id;
    if (typeof rid !== 'string' || rid === '') throw new SlackError('channel_not_found');
    await this.directory.ensure(ids);
    const room = await this.live.opened(rid);
    return { rid, rawRoom: room ?? {} };
  }

  private async pinning(rid: string, mid: string, put: boolean): Promise<void> {
    const target = this.target(rid, mid);
    try {
      await this.client.call(put ? 'pins.add' : 'pins.remove', { channel: target.channel, timestamp: target.ts });
    } catch (e) {
      if (e instanceof SlackError && e.code === (put ? 'already_pinned' : 'no_pin')) return;
      throw e;
    }
  }

  private translated(messages: readonly Doc[]): LocalMessage[] {
    return messages.map((m) => this.translator.toMessage(m)).filter((m): m is LocalMessage => m !== null);
  }

  private target(rid: string, mid: string): { channel: string; ts: string } {
    const target = parseMessageId(mid);
    if (target === null || target.channel !== rid) throw new SlackError('message_not_found');
    return target;
  }
}

/** A canvas's last update, in seconds: Slack keeps no revision. */
function canvasRevision(file: Record<string, unknown>): string {
  return typeof file.updated === 'number' ? String(file.updated) : '0';
}
