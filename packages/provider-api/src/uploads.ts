import type { EncryptedContent, FileJwk } from './crypto.ts';

export type UploadRow = {
  id: string;
  rid: string;
  uri: string;
  name: string;
  type: string;
  caption: string | null;
  /** The thread the file answers, sent as `tmid` with the confirmation; null in the room. */
  tmid: string | null;
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

export type FileToSend = {
  uri: string;
  name: string;
  /** MIME. Checked against `FileUpload_MediaTypeWhiteList` BEFORE the call. */
  type: string;
};

/**
 * Sends the multipart and returns the response's TEXT BODY. The app
 * implementation uses `expo-file-system` (createUploadTask); tests, a fetch.
 */
export type TransportUpload = (
  url: string,
  headers: Record<string, string>,
  file: FileToSend,
  onProgress?: (fraction: number) => void,
  /**
   * Called ONCE, as soon as the task exists, with a way to interrupt it.
   * Without it "Discard" only did a DELETE in the database: the bytes kept
   * going up and the file ended up appearing in the room, after the user had
   * explicitly discarded it.
   */
  onCancelable?: (cancel: () => Promise<void>) => void,
  /** Text fields added to the multipart (the encrypted `content` of a file in an encrypted room). */
  fields?: Record<string, string>,
) => Promise<{ status: number; body: string }>;

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
