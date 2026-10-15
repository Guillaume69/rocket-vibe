/**
 * Slack file queue, over the same `uploads` table as Rocket.Chat's: an
 * upload URL from `files.getUploadURLExternal`, the bytes to it, then
 * `files.completeUploadExternal`, which posts the message. The file id is
 * recorded once the bytes are up, so a replay never uploads them twice. The
 * posted message carries no client id: a replay with that id recorded first
 * looks for a message of the room carrying the file, and only completes when
 * none does.
 */

import type { FileOutbox, Ingest } from '../../lib/provider.ts';
import type { FileToSend, TransportUpload } from '../../lib/upload.ts';
import type { UploadRow, UploadStore } from '../../lib/uploadQueue.ts';
import { SlackError, record, type SlackClient } from './client.ts';
import type { SlackDirectory } from './directory.ts';
import type { SlackHistory } from './history.ts';
import { markdownToMrkdwn, parseMessageId } from './translator.ts';

type Doc = Record<string, unknown>;

/** Rows this process is sending; the others found `sending` were orphaned by a killed run. */
const IN_FLIGHT_HERE = new Set<string>();
/** How far back a room's history is searched for a message carrying the file. */
const RECENT = 100;
const THREAD_PAGES = 5;
/** Failures that leave the row waiting for the next connection rather than failed. */
const TRANSIENT = new Set(['connection_failed', 'timeout', 'ratelimited', 'cancelled']);

/** Slack's upload URLs, the only place the bytes go. */
export function uploadUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw : '');
  } catch {
    throw new SlackError('invalid_response');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.username || url.password || url.port) throw new SlackError('invalid_response');
  return url.href;
}

/** Does a Slack message carry the file? */
export function carriesFile(message: Doc, fileId: string): boolean {
  return Array.isArray(message.files) && message.files.some((f) => typeof f === 'object' && f !== null && (f as Doc).id === fileId);
}

export class SlackUploadQueue implements FileOutbox {
  readonly progress = new Map<string, number>();
  private readonly store: UploadStore;
  private readonly client: SlackClient;
  private readonly directory: SlackDirectory;
  private readonly history: SlackHistory;
  private readonly transport: TransportUpload;
  private readonly generateId: () => string;
  private readonly ingest: Ingest;
  private readonly fileSize: ((uri: string) => Promise<number | null>) | undefined;
  private readonly deleteLocalFile: ((uri: string) => Promise<void>) | undefined;
  /** Sizes known at `send`; a row replayed after a restart asks `fileSize`. */
  private readonly sizes = new Map<string, number>();
  private readonly observers = new Set<() => void>();
  private readonly discarded = new Set<string>();
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private inFlight = false;
  private rerun = false;
  private rearmed = false;

  constructor(options: {
    store: UploadStore;
    client: SlackClient;
    directory: SlackDirectory;
    history: SlackHistory;
    transport: TransportUpload;
    generateId: () => string;
    ingest: Ingest;
    fileSize?: (uri: string) => Promise<number | null>;
    deleteLocalFile?: (uri: string) => Promise<void>;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.directory = options.directory;
    this.history = options.history;
    this.transport = options.transport;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.fileSize = options.fileSize;
    this.deleteLocalFile = options.deleteLocalFile;
  }

  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => void this.observers.delete(listener);
  }

  /** Slack's own limits answer at upload time, which marks the row failed. */
  async validate(): Promise<void> {}

  async send(rid: string, file: FileToSend & { size: number | null }, caption?: string, thread?: string | null): Promise<void> {
    const id = this.generateId();
    if (file.size !== null && file.size > 0) this.sizes.set(id, file.size);
    await this.store.insert({ id, rid, uri: file.uri, name: file.name, type: file.type, caption: caption ?? null, tmid: thread ?? null });
    await this.process();
  }

  async process(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      if (!this.rearmed) {
        this.rearmed = true;
        await this.store.rearmInFlight([...IN_FLIGHT_HERE]);
      }
      do {
        this.rerun = false;
        if (!(await this.runPass())) return;
      } while (this.rerun);
    } finally {
      this.inFlight = false;
    }
  }

  async retry(id: string): Promise<void> {
    await this.store.rearm(id);
    await this.process();
  }

  async discard(id: string, uri?: string): Promise<void> {
    this.discarded.add(id);
    await this.store.delete(id);
    const cancel = this.cancellations.get(id);
    if (cancel !== undefined) await cancel().catch(() => {});
    if (uri !== undefined) await this.deleteLocalFile?.(uri).catch(() => {});
    this.sizes.delete(id);
    this.progress.delete(id);
    this.publish();
  }

  private async runPass(): Promise<boolean> {
    for (const row of await this.store.listToSend()) {
      if (!(await this.store.claim(row.id))) continue;
      IN_FLIGHT_HERE.add(row.id);
      try {
        this.progress.set(row.id, 0);
        this.publish();
        await this.post(row);
      } catch (e) {
        if (this.discarded.has(row.id)) continue;
        if (e instanceof SlackError && (TRANSIENT.has(e.code) || (e.code === 'http_error' && e.status >= 500))) {
          await this.store.rearm(row.id);
          return false;
        }
        await this.store.markFailed(row.id, e instanceof Error ? e.message : 'Send refused.');
      } finally {
        IN_FLIGHT_HERE.delete(row.id);
        this.progress.delete(row.id);
        this.cancellations.delete(row.id);
        this.discarded.delete(row.id);
        this.publish();
      }
    }
    return true;
  }

  private async post(row: UploadRow): Promise<void> {
    const thread = row.tmid === null ? null : parseMessageId(row.tmid);
    if (row.tmid !== null && (thread === null || thread.channel !== row.rid)) throw new SlackError('thread_not_found');
    let fileId = row.fileId;
    if (fileId === null) {
      fileId = await this.upload(row);
      await this.store.recordFileId(row.id, fileId);
    } else if (await this.store.fileAlreadyPosted(row.rid, fileId)) {
      await this.settle(row);
      return;
    } else {
      const posted = await this.posted(row, fileId);
      if (posted !== null) {
        await this.settle(row);
        if (!this.discarded.has(row.id)) await this.ingest(posted);
        return;
      }
    }
    if (this.discarded.has(row.id)) return;
    const caption = row.caption === null || row.caption === '' ? undefined : markdownToMrkdwn(row.caption, (u) => this.directory.idOfUsername(u));
    await this.client.call('files.completeUploadExternal', {
      files: JSON.stringify([{ id: fileId, title: row.name }]),
      channel_id: row.rid,
      initial_comment: caption,
      thread_ts: thread?.ts,
    });
    await this.settle(row);
    if (this.discarded.has(row.id)) return;
    // Slack shares the file a moment later; the live stream brings the message when it is not there yet.
    const echo = await this.posted(row, fileId).catch(() => null);
    if (echo !== null) await this.ingest(echo);
  }

  private async upload(row: UploadRow): Promise<string> {
    const length = this.sizes.get(row.id) ?? (await this.fileSize?.(row.uri).catch(() => null)) ?? null;
    if (length === null || length <= 0) throw new SlackError('file_size_unknown');
    const target = await this.client.call('files.getUploadURLExternal', { filename: row.name, length });
    const url = uploadUrl(target.upload_url);
    const fileId = target.file_id;
    if (typeof fileId !== 'string' || !/^F[A-Z0-9]+$/.test(fileId)) throw new SlackError('invalid_response');
    if (this.discarded.has(row.id)) throw new SlackError('cancelled');
    const result = await this.transport(
      url,
      {},
      { uri: row.uri, name: row.name, type: row.type },
      (fraction) => this.recordProgress(row.id, fraction),
      (cancel) => void this.cancellations.set(row.id, cancel),
    ).catch((e: unknown) => {
      if (e instanceof Error && 'status' in e && (e as { status: unknown }).status === 0) throw new SlackError('connection_failed');
      throw e;
    });
    if (result.status === 0) throw new SlackError('connection_failed');
    if (result.status < 200 || result.status >= 300) throw new SlackError('upload_failed', result.status);
    return fileId;
  }

  /** The room's (or the thread's) message carrying the file, in Slack's recent history. */
  private async posted(row: UploadRow, fileId: string): Promise<Doc | null> {
    const thread = row.tmid === null ? null : parseMessageId(row.tmid);
    const messages = thread === null
      ? (await this.history.history(row.rid, { limit: RECENT })).messages
      : await this.history.prepare(row.rid, await this.client.pages('conversations.replies', { channel: row.rid, ts: thread.ts, limit: 200 }, 'messages', THREAD_PAGES));
    return messages.find((m) => carriesFile(record(m), fileId)) ?? null;
  }

  private async settle(row: UploadRow): Promise<void> {
    this.sizes.delete(row.id);
    await this.store.delete(row.id);
    await this.deleteLocalFile?.(row.uri).catch(() => {});
  }

  private recordProgress(id: string, fraction: number): void {
    const before = this.progress.get(id) ?? 0;
    this.progress.set(id, fraction);
    if (Math.floor(fraction * 100) !== Math.floor(before * 100)) this.publish();
  }

  private publish(): void {
    for (const listener of this.observers) listener();
  }
}
