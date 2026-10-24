import type { EncryptedContent } from './crypto.ts';
import type { LocalMessage } from './rows.ts';

export type OutboxRow = {
  id: string;
  rid: string;
  text: string;
  threadId: string | null;
  /** A thread reply also shown in the room (`tshow`). */
  shown?: boolean;
  status: 'pending' | 'failed';
  attempts: number;
  createdAt: number;
};

export interface OutboxStore {
  /** One transaction: an optimistic row never exists without its durable send intent. */
  enqueueMessage(message: LocalMessage & { text: string }): Promise<void>;
  listToSend(): Promise<OutboxRow[]>;
  markFailed(id: string, error: string): Promise<void>;
  /** A failed row back to `pending`: the explicit "Retry". */
  rearm(id: string): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  upsertMessage(m: LocalMessage): Promise<void>;
  /** Deletes the message only if it is still optimistic (never delivered). */
  deleteOptimisticMessage(id: string): Promise<void>;
  roomEncrypted(rid: string): Promise<boolean>;
}

/** E2EE encryption of a payload, or `null` while it is impossible (locked, key missing). */
export interface OutboxEncryptor {
  encrypt(rid: string, payload: object): EncryptedContent | null;
}
