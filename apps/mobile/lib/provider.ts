import type { NativeChat } from '../providers/vibez/chat.ts';
import type { NativeStore } from '../providers/vibez/store.ts';
import type { NativeQuoteSelection } from '../providers/vibez/quotes.ts';
import type { NativeFileIO } from '../providers/vibez/uploads.ts';
import type { FileOutbox, Ingest, Outbox as OutboxContract, Provider as ProviderContract, UploadHooks } from '@rocket-vibe/provider-api/provider';
import type { OutboxEncryptor, OutboxStore } from '@rocket-vibe/provider-api/outbox';
import type { TransportUpload, UploadStore } from '@rocket-vibe/provider-api/uploads';
import type { ProviderAdmin, ProviderReports } from './admin.ts';
import type { ProviderScheduled } from './scheduled.ts';

export * from '@rocket-vibe/provider-api/provider';

/** The text outbox, whose quotes are Vibez's own selections. */
export interface Outbox extends OutboxContract {
  send(
    rid: string,
    text: string,
    threadId?: string | null,
    localAttachments?: string | null,
    quotes?: readonly NativeQuoteSelection[],
    alsoInRoom?: boolean,
  ): Promise<string>;
}

/** The provider contract plus what only the app's own servers offer. */
export interface Provider extends ProviderContract {
  readonly native?: { chat: NativeChat; store: NativeStore };
  /** Server administration (`lib/admin.ts`), when `capabilities.administration`. */
  readonly admin?: ProviderAdmin;
  /** Reporting a message or an account, when `capabilities.reports`. */
  readonly reports?: ProviderReports;
  /** Messages the server sends later, when `capabilities.scheduledMessages` (`lib/scheduled.ts`). */
  readonly scheduled?: ProviderScheduled;
  createOutbox(store: OutboxStore, ingest: Ingest, encryptor?: OutboxEncryptor): Outbox;
  createUploadQueue(
    store: UploadStore,
    transport: TransportUpload,
    ingest: Ingest,
    hooks?: UploadHooks & { nativeFiles?: NativeFileIO },
  ): FileOutbox;
}
