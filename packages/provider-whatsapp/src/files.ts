/**
 * Files sent to WhatsApp, shown while they go: each one is a row of the
 * `uploads` table, which the room screen already draws (sending, failed with
 * Retry and Discard), until the engine reports the message. The engine
 * uploads the file to WhatsApp, then records and sends the message; a
 * refusal names the upload, which then waits for Retry.
 */

import type { FileOutbox } from '@rocket-vibe/provider-api/provider';
import type { FileToSend } from '@rocket-vibe/provider-api/uploads';
import { ValidationError, type UploadRow, type UploadStore } from '@rocket-vibe/provider-api/uploads';

/** A file to send, made readable by the engine: a plain path, its type, its name, whether it is a voice note. */
export type PreparedFile = { path: string; mime: string; name: string; voice: boolean };
/** Copies (or converts, for a recorded voice note) a picked file where the engine can read it. */
export type FilePreparer = (file: FileToSend & { size: number | null }, id: string) => Promise<PreparedFile>;
/** Sends one engine command; false once the engine ended. */
export type Command = (value: Record<string, unknown>) => Promise<boolean>;

/** The engine's own limit (`engine/upload.go` `maxUpload`). */
export const MAX_UPLOAD_MB = 100;

/** The prepared file of a row, when this process did not prepare it (a retry after a restart). */
function fromRow(row: UploadRow): PreparedFile {
  const path = decodeURIComponent(row.uri.replace(/^file:\/\//, ''));
  return { path, mime: row.type, name: row.name, voice: row.name === 'voice.ogg' && row.type === 'audio/ogg' };
}

export class WhatsAppFiles implements FileOutbox {
  readonly progress = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly prepared = new Map<string, PreparedFile>();
  private readonly store: UploadStore;
  private readonly command: Command;
  private readonly prepare: FilePreparer;
  private readonly newId: () => string;
  private rearmed = false;
  private running: Promise<void> = Promise.resolve();

  constructor(store: UploadStore, command: Command, prepare: FilePreparer, newId: () => string) {
    this.store = store;
    this.command = command;
    this.prepare = prepare;
    this.newId = newId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  async validate(file: { type: string; size: number | null }): Promise<void> {
    if (file.size !== null && file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new ValidationError({ code: 'size', maxMb: String(MAX_UPLOAD_MB) });
    }
  }

  async send(rid: string, file: FileToSend & { size: number | null }, caption?: string): Promise<void> {
    await this.validate(file);
    const id = this.newId();
    const ready = await this.prepare(file, id);
    this.prepared.set(id, ready);
    await this.store.insert({ id, rid, uri: `file://${encodeURI(ready.path)}`, name: ready.name, type: ready.mime,
      caption: caption ?? null, tmid: null });
    await this.process();
  }

  /** Hands the waiting files to the engine, one pass at a time. */
  process(): Promise<void> {
    this.running = this.running.then(() => this.pass()).catch(() => {});
    return this.running;
  }

  private async pass(): Promise<void> {
    // A process killed mid-send left rows `sending`: they go again (the engine
    // refuses a message it already recorded, which then counts as sent).
    if (!this.rearmed) {
      this.rearmed = true;
      await this.store.rearmInFlight([]);
    }
    for (const row of await this.store.listToSend()) {
      if (!(await this.store.claim(row.id))) continue;
      this.progress.set(row.id, 0);
      this.publish();
      const ready = this.prepared.get(row.id) ?? fromRow(row);
      const running = await this.command({ type: 'upload', id: row.id, chat: row.rid, path: ready.path, mime: ready.mime,
        name: ready.name, text: row.caption ?? '', voice: ready.voice }).catch(() => false);
      if (!running) await this.refused(row.id, 'not_connected');
    }
  }

  async retry(id: string): Promise<void> {
    await this.store.rearm(id);
    await this.process();
  }

  async discard(id: string): Promise<void> {
    await this.store.delete(id);
    this.prepared.delete(id);
    this.progress.delete(id);
    this.publish();
  }

  /** The engine recorded the message of an upload: it now shows in the timeline. */
  async settled(id: string): Promise<void> {
    if (!this.progress.has(id) && !this.prepared.has(id)) return;
    await this.store.delete(id);
    this.prepared.delete(id);
    this.progress.delete(id);
    this.publish();
  }

  /** WhatsApp refused an upload (or the engine was gone): it waits for Retry or Discard. */
  async refused(id: string, code: string): Promise<void> {
    if (code === 'send_already_recorded') return this.settled(id);
    if (!this.progress.has(id)) return;
    await this.store.markFailed(id, code);
    this.progress.delete(id);
    this.publish();
  }
}
