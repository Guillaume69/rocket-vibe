import { requireOptionalNativeModule } from 'expo-modules-core';
export type UpdateInstallStatus = 'idle' | 'ready' | 'installing' | 'confirmation' | 'updated' | 'failed';
export type UpdaterInfo = {
  version: string; versionCode: number; abis: string[]; canInstall: boolean;
  status: UpdateInstallStatus; target: string | null; error: string | null;
};
type Bridge = {
  info(): Promise<UpdaterInfo>;
  download(version: string, url: string, size: number, digest: string): Promise<void>;
  cancelDownload(): void;
  install(): Promise<void>;
  cancelInstall(): Promise<void>;
  resumeInstall(): Promise<void>;
  openInstallSettings(): Promise<void>;
  addListener(event: 'progress', listener: (value: { downloaded: number; total: number }) => void): { remove(): void };
};
export const AppUpdater = requireOptionalNativeModule<Bridge>('AppUpdater');
