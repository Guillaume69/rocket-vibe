/**
 * Mattermost file queue, over the same `uploads` table as Rocket.Chat's:
 * bytes to `POST /files?channel_id=` (the `file` multipart field is accepted
 * like `files`), then a post carrying `file_ids`. The file id is recorded as
 * soon as the bytes are up, so a replay never uploads them twice, and the post
 * leaves with the row id as `pending_post_id`, which the server deduplicates.
 */

import type { FileOutbox, Ingest } from '../../lib/provider.ts';
import type { FileToSend, TransportUpload } from '../../lib/upload.ts';
import type { UploadRow, UploadStore } from '../../lib/uploadQueue.ts';
import { MmError, type MmClient } from './client.ts';
import { pendingPostId } from './outbox.ts';

/** Rows this process is sending; the others found `sending` were orphaned by a killed run. */
const IN_FLIGHT_HERE = new Set<string>();

export class MmUploadQueue implements FileOutbox {
  readonly progress = new Map<string, number>();
  private readonly store: UploadStore;
  private readonly client: MmClient;
  private readonly transport: TransportUpload;
  private readonly generateId: () => string;
  private readonly myId: string;
  private readonly ingest: Ingest;
  private readonly deleteLocalFile: ((uri: string) => Promise<void>) | undefined;
  private readonly refreshRoom: ((rid: string) => Promise<void>) | undefined;
  private readonly observers = new Set<() => void>();
  private readonly discarded = new Set<string>();
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private inFlight = false;
  private rerun = false;
  private rearmed = false;

  constructor(options: {
    store: UploadStore;
    client: MmClient;
    transport: TransportUpload;
    generateId: () => string;
    myId: string;
    ingest: Ingest;
    deleteLocalFile?: (uri: string) => Promise<void>;
    refreshRoom?: (rid: string) => Promise<void>;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.transport = options.transport;
    this.generateId = options.generateId;
    this.myId = options.myId;
    this.ingest = options.ingest;
    this.deleteLocalFile = options.deleteLocalFile;
    this.refreshRoom = options.refreshRoom;
  }

  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => void this.observers.delete(listener);
  }

  /** The server's own limit answers with a 413, which marks the row failed. */
  async validate(): Promise<void> {}

  async send(rid: string, file: FileToSend & { size: number | null }, caption?: string, thread?: string | null): Promise<void> {
    await this.store.insert({
      id: this.generateId(),
      rid,
      uri: file.uri,
      name: file.name,
      type: file.type,
      caption: caption ?? null,
      tmid: thread ?? null,
    });
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
        if (e instanceof MmError && e.status === 0) {
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
    let fileId = row.fileId;
    if (fileId === null) {
      fileId = await this.upload(row);
      await this.store.recordFileId(row.id, fileId);
    } else if (await this.alreadyPosted(row.rid, fileId)) {
      await this.settle(row);
      return;
    }
    if (this.discarded.has(row.id)) return;
    const post = await this.client.post<Record<string, unknown>>('/posts', {
      body: {
        channel_id: row.rid,
        message: row.caption ?? '',
        root_id: row.tmid ?? '',
        file_ids: [fileId],
        pending_post_id: pendingPostId(this.myId, row.id),
      },
    });
    await this.settle(row);
    if (!this.discarded.has(row.id)) await this.ingest(post);
  }

  private async upload(row: UploadRow): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.client.token !== null) headers.Authorization = `Bearer ${this.client.token}`;
    const result = await this.transport(
      this.client.url('/files', { channel_id: row.rid }),
      headers,
      { uri: row.uri, name: row.name, type: row.type },
      (fraction) => this.recordProgress(row.id, fraction),
      (cancel) => void this.cancellations.set(row.id, cancel),
    ).catch((e: unknown) => {
      throw new MmError(0, null, e instanceof Error ? e.message : 'Upload unreachable');
    });
    let body: { file_infos?: { id?: unknown }[]; id?: unknown; message?: unknown } = {};
    try {
      body = JSON.parse(result.body) as typeof body;
    } catch {
      /* status decides below */
    }
    if (result.status === 0) throw new MmError(0, null, 'Upload unreachable');
    const id = body.file_infos?.[0]?.id;
    if (result.status < 200 || result.status >= 300 || typeof id !== 'string') {
      throw new MmError(result.status, typeof body.id === 'string' ? body.id : null, typeof body.message === 'string' ? body.message : `HTTP ${result.status}`);
    }
    return id;
  }

  private async alreadyPosted(rid: string, fileId: string): Promise<boolean> {
    if (await this.store.fileAlreadyPosted(rid, fileId)) return true;
    if (this.refreshRoom === undefined) return false;
    try {
      await this.refreshRoom(rid);
    } catch {
      return false;
    }
    return this.store.fileAlreadyPosted(rid, fileId);
  }

  private async settle(row: UploadRow): Promise<void> {
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
