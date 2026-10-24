/**
 * Teams file queue, over the same `uploads` table as the others. The bytes go
 * to the channel's SharePoint folder through Microsoft Graph (a binary PUT to
 * `/content`, the transport injected for Teams), then a chat-service message
 * carries the file as `properties.files` - the same shape `translate.ts` reads
 * back, so the sent file shows as a downloadable card. The file id is recorded
 * once the bytes are up, so a replay never uploads them twice; a replay with
 * the id recorded first looks for a message of the room carrying its stable
 * client id, and only sends when none does. Channel-only: a chat has no parent
 * team here. Mirrors `post_teams` in `apps/desktop/crates/rv-core/src/uploads.rs`.
 */

import type { FileOutbox, Ingest } from '@rocket-vibe/provider-api/provider';
import type { FileToSend, TransportUpload, UploadRow, UploadStore } from '@rocket-vibe/provider-api/uploads';
import { TeamsError } from './auth.ts';
import type { TeamsClient, TeamsFileRef } from './client.ts';
import { clientMessageId, threadTarget, toHtml } from './outbox.ts';
import type { TeamsDirectory } from './translate.ts';

type Doc = Record<string, unknown>;

/** Rows this process is sending; the others found `sending` were orphaned by a killed run. */
const IN_FLIGHT_HERE = new Set<string>();
/** Failures that leave the row waiting for the next connection rather than failed. */
const TRANSIENT = new Set(['network', 'connection_failed', 'timeout', 'cancelled']);

export class TeamsUploadQueue implements FileOutbox {
  readonly progress = new Map<string, number>();
  private readonly store: UploadStore;
  private readonly client: TeamsClient;
  private readonly transport: TransportUpload;
  private readonly directory: TeamsDirectory;
  private readonly me: string;
  private readonly generateId: () => string;
  private readonly ingest: Ingest;
  private readonly deleteLocalFile: ((uri: string) => Promise<void>) | undefined;
  private readonly observers = new Set<() => void>();
  private readonly discarded = new Set<string>();
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private inFlight = false;
  private rerun = false;
  private rearmed = false;

  constructor(options: {
    store: UploadStore;
    client: TeamsClient;
    transport: TransportUpload;
    directory: TeamsDirectory;
    me: string;
    generateId: () => string;
    ingest: Ingest;
    deleteLocalFile?: (uri: string) => Promise<void>;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.transport = options.transport;
    this.directory = options.directory;
    this.me = options.me;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.deleteLocalFile = options.deleteLocalFile;
  }

  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => void this.observers.delete(listener);
  }

  /** Graph enforces its own limits at upload time, which marks the row failed. */
  async validate(): Promise<void> {}

  async send(rid: string, file: FileToSend & { size: number | null }, caption?: string, thread?: string | null): Promise<void> {
    const id = this.generateId();
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
        if (e instanceof TeamsError && (TRANSIENT.has(e.code) || e.status === 0 || e.status >= 500)) {
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
    const clientId = clientMessageId(row.id);
    let ref: TeamsFileRef;
    if (row.fileId === null) {
      ref = await this.upload(row);
      await this.store.recordFileId(row.id, ref.itemId);
    } else {
      // A retry whose upload already happened: did the message go out?
      const posted = await this.posted(row.rid, clientId);
      if (posted !== null) {
        await this.settle(row);
        if (!this.discarded.has(row.id)) await this.ingest({ ...posted, __rid: row.rid });
        return;
      }
      ref = await this.client.fileRef(row.rid, row.name);
    }
    if (this.discarded.has(row.id)) return;
    await this.sendMessage(row, ref, clientId);
    await this.settle(row);
  }

  private async upload(row: UploadRow): Promise<TeamsFileRef> {
    const url = await this.client.contentUrl(row.rid, row.name);
    const bearer = await this.client.tokens.graph();
    if (this.discarded.has(row.id)) throw new TeamsError('cancelled');
    const result = await this.transport(
      url,
      { authorization: `Bearer ${bearer}` },
      { uri: row.uri, name: row.name, type: row.type },
      (fraction) => this.recordProgress(row.id, fraction),
      (cancel) => void this.cancellations.set(row.id, cancel),
    ).catch((e: unknown) => {
      if (e instanceof Error && 'status' in e && (e as { status: unknown }).status === 0) throw new TeamsError('connection_failed');
      throw e;
    });
    if (result.status === 0) throw new TeamsError('connection_failed');
    if (result.status < 200 || result.status >= 300) throw new TeamsError('upload_failed', result.status);
    return this.client.fileRef(row.rid, row.name);
  }

  private async sendMessage(row: UploadRow, ref: TeamsFileRef, clientId: string): Promise<void> {
    const ext = ref.name.includes('.') ? ref.name.slice(ref.name.lastIndexOf('.') + 1) : '';
    const files = JSON.stringify([{
      '@type': 'http://schema.skype.com/File',
      version: 2,
      id: ref.unique,
      itemid: ref.unique,
      fileName: ref.name,
      fileType: ext,
      title: ref.name,
      type: ext,
      state: 'active',
      fileInfo: { fileUrl: ref.webUrl, siteUrl: ref.site, serverRelativeUrl: '', itemId: null, shareUrl: null, shareId: null },
      fileChicletState: { serviceName: 'teams', state: 'active' },
      baseUrl: ref.site,
      objectUrl: ref.webUrl,
    }]);
    const body: Doc = {
      content: row.caption !== null && row.caption !== '' ? toHtml(row.caption) : '',
      messagetype: 'RichText/Html',
      contenttype: 'Text',
      clientmessageid: clientId,
      imdisplayname: this.directory.shown(this.me),
      properties: { files },
    };
    const url = await this.client.conversation(threadTarget(row.rid, row.tmid), ['messages']);
    await this.client.chat('POST', url, body);
  }

  /** The room's message carrying our stable client id, in recent history. */
  private async posted(rid: string, clientId: string): Promise<Doc | null> {
    const url = await this.client.conversation(rid, ['messages'], 'view=msnp24Equivalent%7CsupportsMessageProperties&pageSize=50');
    const body = (await this.client.chat('GET', url)).body;
    const messages = Array.isArray(body.messages) ? (body.messages as Doc[]) : [];
    return messages.find((m) => (m as Doc).clientmessageid === clientId) ?? null;
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
