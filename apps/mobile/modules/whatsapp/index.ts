import {requireOptionalNativeModule} from 'expo-modules-core';

/**
 * The WhatsApp engine (apps/desktop/whatsapp, the desktop helper's own Go
 * code) run in-process by Kotlin, one per account state. Commands and frames
 * are the desktop helper's JSON wire objects (brain/features/whatsapp.md).
 * The engine outlives JS reloads and account switches: only stop, logout and
 * forget end it. Its storage key never reaches JS.
 */
export type WhatsAppNative = {
  /** A new account state id (24 lower-case hex characters). */
  newState(): string;
  /** The states with an engine running in this process. */
  running(): string[];
  /** Opens the state and connects; nothing when it already runs. Rejects with
   * `whatsapp_busy`, `whatsapp_key_missing` or `whatsapp_start_failed`. */
  start(state: string): Promise<void>;
  /** Runs one JSON command; false once the engine ended (stop, logout). */
  handle(state: string, command: string): Promise<boolean>;
  stop(state: string): Promise<void>;
  /** Stops the engine and erases the state, its media and its key. */
  forget(state: string): Promise<void>;
  /** A recorded note (`file://` m4a) written as a WhatsApp voice note (Opus in Ogg) at `output`; false when this device cannot (before Android 10). */
  toVoiceNote(input: string, output: string): Promise<boolean>;
  /** The licence notice of the engine's Go modules (whatsmeow, MPL-2.0, first); null when the build has none. */
  licenses(): Promise<string | null>;
  /** Whether the account receives with the app closed (a foreground service). */
  background(state: string): boolean;
  setBackground(state: string, on: boolean): Promise<void>;
  addListener(event: 'frame', listener: (event: {state: string; frame: string}) => void): {remove(): void};
};

/** Null outside Android or in a build without the module. */
export const WhatsApp = requireOptionalNativeModule<WhatsAppNative>('WhatsApp');
