import {requireOptionalNativeModule} from 'expo-modules-core';

export type CryptoAccount = {
  origin: string;
  instance: string;
  dataEpoch: string;
  user: string;
  device: string;
};
/** Storage readiness is independent of device registration and E2EE readiness. */
export type CryptoInstallationStatus = {
  phase: 'missing' | 'initializing' | 'ready';
  accountFingerprint: string;
  incarnation: string;
};
export type CryptoStorageBridge = {
  open: (account: CryptoAccount) => Promise<CryptoInstallationStatus & {handle: string}>;
  status: (handle: string) => Promise<CryptoInstallationStatus>;
  initialize: (handle: string, expectedFingerprint: string) => Promise<CryptoInstallationStatus>;
  retire: (handle: string, expectedFingerprint: string) => Promise<void>;
  close: (handle: string) => Promise<void>;
};
/** Keys and protected records remain between Rust and Kotlin, outside this API. */
export const CryptoNative = requireOptionalNativeModule<CryptoStorageBridge>('CryptoNative');
