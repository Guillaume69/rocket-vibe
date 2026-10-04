/**
 * Upload queue (7.2), the counterpart of `OutboxEngine` for files. The intent
 * (local uri, name, type, caption) is persisted BEFORE sending: a kill during
 * the upload is replayed at the next start.
 *
 * Validation (7.3): `FileUpload_MaxFileSize` and
 * `FileUpload_MediaTypeWhiteList` are read from `settings.public` and checked
 * BEFORE pushing a single byte: refusing afterwards wastes the network and
 * leaves orphans.
 *
 * Encrypted room: the file leaves encrypted (with its own AES-CTR key), under
 * the hash of its name; its real name, type, key and the caption only travel
 * inside the content encrypted under the room key, as the web client does.
 */

import type { EncryptedContent, FileJwk } from './e2e/crypto.ts';
import type { RestClient } from './rest.ts';
import { RestError } from './rest.ts';
import {
  confirmMedia,
  uploadBytes,
  type FileToSend,
  type TransportUpload,
} from './upload.ts';

export type UploadRow = {
  id: string;
  rid: string;
  uri: string;
  name: string;
  type: string;
  caption: string | null;
  status: 'pending' | 'sending' | 'failed';
  /** Returned by `rooms.media`. Non-null = the bytes are already on the server. */
  fileId: string | null;
};

export interface UploadStore {
  insert(row: Omit<UploadRow, 'status' | 'fileId'>): Promise<void>;
  /** Only the `pending` rows, in creation order. */
  listToSend(): Promise<UploadRow[]>;
  /** Claims the row (`pending` → `sending`). `false` if another pass took it. */
  claim(id: string): Promise<boolean>;
  /** Hands back to the replay the orphaned `sending` rows of a killed process, EXCEPT those still in flight here. */
  rearmInFlight(inFlightHere: string[]): Promise<void>;
  /** The "Retry" gesture: a failure becomes a candidate again. */
  rearm(id: string): Promise<void>;
  recordFileId(id: string, fileId: string): Promise<void>;
  /** Is the message carrying this file ALREADY in the database? Local, never network. */
  fileAlreadyPosted(rid: string, fileId: string): Promise<boolean>;
  markFailed(id: string, error: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export type UploadRules = {
  maxSize: number | null;
  /** MIME whitelist, `null` = everything accepted. */
  acceptedTypes: string[] | null;
  /** `E2E_Enable_Encrypt_Files`: without it, an encrypted room accepts no file. */
  encryptedFiles: boolean;
};

/** An encrypted file in a temporary file, ready to upload. */
export type EncryptedFile = { uri: string; key: FileJwk; iv: string; sha256: string; size: number };

/** What the queue needs to send into an encrypted room. */
export interface UploadEncryption {
  roomEncrypted(rid: string): Promise<boolean>;
  /** Content encrypted for this room, `null` without a key (locked). */
  encrypt(rid: string, payload: object): EncryptedContent | null;
  encryptFile(uri: string): Promise<EncryptedFile>;
  /** SHA-256 hash (hex) of a text: the name the file leaves under. */
  hashedName(name: string): string;
}

/** The room key is missing: the row waits for the unlock, it does not fail. */
class KeyWait extends Error {}

/**
 * The attachment of an encrypted file, as the web client builds and reads it:
 * `title_link` designates the ciphertext, the key and hash make it readable,
 * and an image, audio or video announces itself as such.
 */
export function encryptedFileAttachment(options: {
  fileId: string;
  url: string;
  name: string;
  type: string;
  size: number;
  key: FileJwk;
  iv: string;
  sha256: string;
}): Record<string, unknown> {
  const { fileId, url, name, type, size } = options;
  const base = {
    title: name,
    type: 'file',
    title_link: url,
    title_link_download: true,
    encryption: { key: options.key, iv: options.iv },
    hashes: { sha256: options.sha256 },
    fileId,
  };
  const kind = /^(image|audio|video)\//.exec(type)?.[1];
  if (kind !== undefined) {
    return { ...base, [`${kind}_url`]: url, [`${kind}_type`]: type, [`${kind}_size`]: size };
  }
  const dot = name.lastIndexOf('.');
  return { ...base, size, format: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
}

type PublicSetting = { _id?: string; value?: unknown };

/**
 * Reads the settings that govern the upload. Memoised by the caller.
 *
 * WARNING: the `query` parameter of `settings.public` was REMOVED in 7.0: the
 * server ignores it and pages at 50, never returning the `FileUpload_*` ones
 * (checked against the real 8.5: the validation was a no-op). Ask for
 * EVERYTHING (`count=0`, like the login survey) and filter client-side.
 */
export async function readUploadRules(client: RestClient): Promise<UploadRules> {
  const response = await client.get<{ settings?: PublicSetting[] }>('settings.public', {
    params: { count: 0 },
  });
  let maxSize: number | null = null;
  let acceptedTypes: string[] | null = null;
  let encryptedFiles = false;
  for (const setting of response.settings ?? []) {
    if (setting._id === 'E2E_Enable_Encrypt_Files') encryptedFiles = setting.value === true;
    if (setting._id === 'FileUpload_MaxFileSize' && typeof setting.value === 'number') {
      maxSize = setting.value > 0 ? setting.value : null;
    }
    if (setting._id === 'FileUpload_MediaTypeWhiteList' && typeof setting.value === 'string') {
      const list = setting.value
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== '');
      acceptedTypes = list.length > 0 ? list : null;
    }
  }
  return { maxSize, acceptedTypes, encryptedFiles };
}

/**
 * Rows THIS JS runtime has in flight, across all engines. Deliberately at
 * module level and not per instance: `SyncProvider` can build a second
 * `UploadEngine` without stopping the first (new `session` object for the
 * same account), and both share the same SQLite connection. It is the only
 * scope where "in flight here" makes sense.
 */
const IN_FLIGHT_HERE = new Set<string>();

/**
 * A validation refusal carries DATA (code + parameters), not a sentence: this
 * module is pure and tested under Node, it embeds no language. The wording
 * happens at the display point (`validationMessage`, ui/fileValidation.ts).
 */
export type DetailValidation =
  | { code: 'size'; maxMb: string }
  | { code: 'type'; type: string }
  | { code: 'encrypted' };

export class ValidationError extends Error {
  readonly detail: DetailValidation;

  constructor(detail: DetailValidation) {
    // `message` is a diagnostic (logs), never the displayed string.
    super(
      detail.code === 'size'
        ? `size > ${detail.maxMb} MB`
        : detail.code === 'type'
          ? `type ${detail.type} refused`
          : 'encrypted files disabled',
    );
    this.name = 'ValidationError';
    this.detail = detail;
  }
}

/** `image/*` in the whitelist accepts `image/png`, etc. */
export function validateFile(
  rules: UploadRules,
  file: { type: string; size: number | null },
  roomEncrypted = false,
): void {
  if (roomEncrypted && !rules.encryptedFiles) throw new ValidationError({ code: 'encrypted' });
  if (rules.maxSize !== null && file.size !== null && file.size > rules.maxSize) {
    const mo = (rules.maxSize / 1024 / 1024).toFixed(1);
    throw new ValidationError({ code: 'size', maxMb: mo });
  }
  if (rules.acceptedTypes !== null) {
    const accepted = rules.acceptedTypes.some((pattern) => {
      if (pattern === file.type) return true;
      const [family, sub] = pattern.split('/');
      return sub === '*' && file.type.startsWith(`${family}/`);
    });
    if (!accepted) {
      throw new ValidationError({ code: 'type', type: file.type });
    }
  }
}

export class UploadEngine {
  private readonly store: UploadStore;
  private readonly client: RestClient;
  private readonly transport: TransportUpload;
  private readonly generateId: () => string;
  private readonly ingest: (doc: Record<string, unknown>) => Promise<void>;
  private readonly deleteLocalFile: ((uri: string) => Promise<void>) | undefined;
  private readonly refreshRoom: ((rid: string) => Promise<void>) | undefined;
  private readonly encryption: UploadEncryption | undefined;
  /**
   * Key of each encrypted file already uploaded, waiting for its confirm. In
   * memory only: a process killed between the two steps loses it, and the
   * file then goes again, encrypted under a new key.
   */
  private readonly encrypted = new Map<string, EncryptedFile & { hashedName: string }>();
  private inFlight = false;
  private rerun = false;
  /** 0..1 progress of the running upload, by id, for the UI. */
  readonly progress = new Map<string, number>();
  private rules: UploadRules | null = null;
  /** False until the orphaned `sending` rows of the previous process have been handed back. */
  private rearmed = false;
  /** Ids discarded during their own send, checked before posting. */
  private readonly discarded = new Set<string>();
  /** Interrupters of the tasks in flight, set by the transport. */
  private readonly cancellations = new Map<string, () => Promise<void>>();
  private readonly observers = new Set<() => void>();

  constructor(options: {
    store: UploadStore;
    client: RestClient;
    transport: TransportUpload;
    generateId: () => string;
    ingest: (doc: Record<string, unknown>) => Promise<void>;
    /**
     * Deletes the local file of a settled row (success or discard). Injected
     * rather than imported: `expo-file-system` does not exist under Node, and
     * this module must stay testable without it. The implementation alone
     * decides whether the URI really is in the app cache: a file the user
     * picked elsewhere is NEVER deleted.
     */
    deleteLocalFile?: (uri: string) => Promise<void>;
    /**
     * Fetches a room's recent messages. Called ONLY when an already persisted
     * `file_id` requires knowing whether the message exists and the local
     * database does not know, so never on the nominal path.
     */
    refreshRoom?: (rid: string) => Promise<void>;
    encryption?: UploadEncryption;
  }) {
    this.store = options.store;
    this.client = options.client;
    this.transport = options.transport;
    this.generateId = options.generateId;
    this.ingest = options.ingest;
    this.deleteLocalFile = options.deleteLocalFile;
    this.refreshRoom = options.refreshRoom;
    this.encryption = options.encryption;
  }

  /**
   * Subscribe to `progress` changes: that is what moves the banner's bar. A
   * `useCoalescedLiveQuery` is not enough: the fraction lives only in memory,
   * no SQLite write carries it.
   */
  subscribe(listener: () => void): () => void {
    this.observers.add(listener);
    return () => void this.observers.delete(listener);
  }

  private publish(): void {
    for (const listener of this.observers) listener();
  }

  private async uploadRules(): Promise<UploadRules> {
    if (this.rules !== null) return this.rules;
    try {
      const rules = await readUploadRules(this.client);
      this.rules = rules; // only a SUCCESS is memoised:
      return rules;
    } catch {
      // a permissive fallback cached after an offline spell would disable
      // validation for the whole session.
      return { maxSize: null, acceptedTypes: null, encryptedFiles: true };
    }
  }

  /**
   * Validation alone, persisting nothing: the composer refuses an attachment as
   * soon as it is added, not at send time. `send` validates again anyway: the
   * attachment may have been downscaled in between.
   */
  async validate(file: { type: string; size: number | null }, rid?: string): Promise<void> {
    const encrypted = rid !== undefined && (await this.encryption?.roomEncrypted(rid)) === true;
    validateFile(await this.uploadRules(), file, encrypted);
  }

  /** Validates (7.3) THEN persists the intent THEN attempts the send. */
  async send(
    rid: string,
    file: FileToSend & { size: number | null },
    caption?: string,
  ): Promise<void> {
    const encrypted = (await this.encryption?.roomEncrypted(rid)) === true;
    validateFile(await this.uploadRules(), file, encrypted);

    await this.store.insert({
      id: this.generateId(),
      rid,
      uri: file.uri,
      name: file.name,
      type: file.type,
      caption: caption ?? null,
    });
    await this.process();
  }

  /** Replays the queue, one pass at a time: same discipline as OutboxEngine. */
  async process(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    try {
      // Once per process, BEFORE the first read of the queue: an `sending` can
      // only have been set by a previous run, killed mid-upload. Without this,
      // its row would stay out of the listing forever and the file would never
      // leave.
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

  /** The explicit "Retry" gesture, the only one that takes a row out of failure. */
  async retry(id: string): Promise<void> {
    await this.store.rearm(id);
    await this.process();
  }

  private async runPass(): Promise<boolean> {
    for (const row of await this.store.listToSend()) {
      // Atomic claim: if another pass already took it, leave it.
      if (!(await this.store.claim(row.id))) continue;
      IN_FLIGHT_HERE.add(row.id);
      try {
        this.progress.set(row.id, 0);
        this.publish();
        if (!(await this.post(row))) return false;
      } catch (e) {
        if (this.discarded.has(row.id)) {
          // The cancellation made the task fail, which is the intended outcome:
          // the row is already deleted, there is nothing to mark.
          continue;
        }
        if (e instanceof KeyWait) {
          await this.store.rearm(row.id);
          continue;
        }
        if (e instanceof RestError && e.status === 0) {
          // Unreachable. The row must GO BACK to `pending`: leaving it in
          // `sending` would take it out of the listing until the next launch.
          await this.store.rearm(row.id);
          return false;
        }
        // `last_error` is a DIAGNOSTIC (never displayed, the UI shows
        // `messageRow.failedRetry`): not a string to translate.
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

  /**
   * One row, in two steps separated by a write. Returns `false` when the
   * network is dead and the pass must stop.
   */
  private async post(row: UploadRow): Promise<boolean> {
    if ((await this.encryption?.roomEncrypted(row.rid)) === true) {
      return this.postEncrypted(row, this.encryption as UploadEncryption);
    }
    let fileId = row.fileId;

    if (fileId === null) {
      fileId = await uploadBytes({
        client: this.client,
        transport: this.transport,
        rid: row.rid,
        file: { uri: row.uri, name: row.name, type: row.type },
        onProgress: (fraction) => this.recordProgress(row.id, fraction),
        onCancelable: (cancel) => void this.cancellations.set(row.id, cancel),
      });
      // BEFORE the confirm: that is the whole point of the column.
      await this.store.recordFileId(row.id, fileId);
    } else if (await this.alreadyPosted(row.rid, fileId)) {
      // The bytes had already left AND the message is there: the confirm had
      // succeeded, only its response got lost. Confirming again would post a
      // duplicate. Settle the row, without sending anything.
      await this.settle(row);
      return true;
    }

    // Last window where "Discard" can still keep the message from existing:
    // after the confirm, the server has created it and the DDP stream will
    // deliver it anyway; it can no longer be unposted.
    if (this.discarded.has(row.id)) return true;

    const message = await confirmMedia({
      client: this.client,
      rid: row.rid,
      fileId,
      message: row.caption ?? undefined,
    });
    await this.settle(row);
    if (!this.discarded.has(row.id)) await this.ingest(message);
    return true;
  }

  /**
   * The encrypted counterpart of `post`, same two steps. Nothing leaves while
   * the room key is missing: neither the bytes nor the message.
   */
  private async postEncrypted(
    row: UploadRow,
    encryption: UploadEncryption,
  ): Promise<boolean> {
    if (encryption.encrypt(row.rid, {}) === null) throw new KeyWait();
    let fileId = row.fileId;
    let file = this.encrypted.get(row.id);

    if (fileId !== null && file === undefined) {
      if (await this.alreadyPosted(row.rid, fileId)) {
        await this.settle(row);
        return true;
      }
      fileId = null;
    }

    const meta = (f: EncryptedFile) => ({
      type: row.type,
      typeGroup: row.type.split('/')[0],
      name: row.name,
      encryption: { key: f.key, iv: f.iv },
      hashes: { sha256: f.sha256 },
    });

    if (fileId === null || file === undefined) {
      const encrypted = await encryption.encryptFile(row.uri);
      file = { ...encrypted, hashedName: encryption.hashedName(row.name) };
      const encryptedContent = encryption.encrypt(row.rid, meta(file));
      if (encryptedContent === null) throw new KeyWait();
      try {
        fileId = await uploadBytes({
          client: this.client,
          transport: this.transport,
          rid: row.rid,
          file: { uri: file.uri, name: file.hashedName, type: 'application/octet-stream' },
          onProgress: (fraction) => this.recordProgress(row.id, fraction),
          onCancelable: (cancel) => void this.cancellations.set(row.id, cancel),
          fields: { content: JSON.stringify(encryptedContent) },
        });
      } finally {
        await this.deleteLocalFile?.(file.uri).catch(() => {});
      }
      this.encrypted.set(row.id, file);
      await this.store.recordFileId(row.id, fileId);
    }

    if (this.discarded.has(row.id)) return true;

    const plainAttachment = { _id: fileId, name: row.name, type: row.type, size: file.size };
    const attachment = encryptedFileAttachment({
      fileId,
      url: `/file-upload/${fileId}/${file.hashedName}`,
      name: row.name,
      type: row.type,
      size: file.size,
      key: file.key,
      iv: file.iv,
      sha256: file.sha256,
    });
    const content = encryption.encrypt(row.rid, {
      msg: row.caption ?? '',
      attachments: [attachment],
      files: [plainAttachment],
      file: plainAttachment,
    });
    const fileContent = encryption.encrypt(row.rid, meta(file));
    if (content === null || fileContent === null) throw new KeyWait();

    const message = await confirmMedia({
      client: this.client,
      rid: row.rid,
      fileId,
      body: { msg: '', t: 'e2e', content, fileContent },
    });
    this.encrypted.delete(row.id);
    await this.settle(row);
    if (!this.discarded.has(row.id)) await this.ingest(message);
    return true;
  }

  /**
   * "Is this file already posted?": the question the whole workstream hinges
   * on, because **the server cannot answer it**: a second
   * `rooms.mediaConfirm` on the same `fileId` answers 200 returning the FIRST
   * message, while it has just created a second one (probed on 8.5, see
   * CLAUDE.md). The response is therefore indistinguishable from a success;
   * only the local database can decide.
   *
   * It still has to KNOW. The case that catches it out is precisely the one
   * targeted: at restart after a kill, no room screen is mounted, so
   * `stream-room-messages` is subscribed to nothing and the `messages` table
   * knows nothing of the message created by the lost confirm. So the question
   * is not asked again blindly: that one room is REFRESHED, once, then asked
   * again. One targeted REST call, paid only in the rare case of a lost
   * response, never on the nominal path.
   */
  private async alreadyPosted(rid: string, fileId: string): Promise<boolean> {
    if (await this.store.fileAlreadyPosted(rid, fileId)) return true;
    if (this.refreshRoom === undefined) return false;
    try {
      await this.refreshRoom(rid);
    } catch {
      // Refresh impossible: still unknown. See below for the deliberate choice
      // between the duplicate and the loss.
      return false;
    }
    return this.store.fileAlreadyPosted(rid, fileId);
  }

  /** Settled row: no more queue entry, no more temporary file. */
  private async settle(row: UploadRow): Promise<void> {
    await this.store.delete(row.id);
    await this.deleteLocalFile?.(row.uri).catch(() => {});
  }

  /**
   * Wakes the UI only when the WHOLE PERCENT changes. The transport yields at
   * each chunk: re-rendering the room screen at that rate would cost more than
   * the upload itself.
   */
  private recordProgress(id: string, fraction: number): void {
    const before = this.progress.get(id) ?? 0;
    this.progress.set(id, fraction);
    if (Math.floor(fraction * 100) !== Math.floor(before * 100)) this.publish();
  }

  /**
   * Discard. Three actions, not one: the row leaves the queue, the task in
   * flight is INTERRUPTED (otherwise the bytes kept going up and the file
   * appeared in the room after the discard), and the intent is noted so the
   * running pass ingests nothing.
   *
   * `uri` also allows deleting the temporary file: the caller has it at hand,
   * the engine does not (the row was just deleted).
   */
  async discard(id: string, uri?: string): Promise<void> {
    this.discarded.add(id);
    this.encrypted.delete(id);
    await this.store.delete(id);
    const cancel = this.cancellations.get(id);
    if (cancel !== undefined) await cancel().catch(() => {});
    if (uri !== undefined) await this.deleteLocalFile?.(uri).catch(() => {});
    this.progress.delete(id);
    this.publish();
  }
}
