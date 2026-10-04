import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Bridge to the Kotlin native module, autolinked by Expo from `modules/`. Android
 * only: on iOS the module is `null`. Importable ONLY in the app: under Node, `requireNativeModule` throws.
 */

type NativeDownloads = {
  /**
   * Copies a LOCAL file (`file://…`) into the public Downloads folder.
   * Returns the URI of the created entry. The system suffixes a name already taken.
   */
  save(source: string, name: string, type: string | null): Promise<string>;
};

export const Downloads = requireOptionalNativeModule<NativeDownloads>('Downloads');
