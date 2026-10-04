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
export type CryptoIdentityStatus = {
  phase: 'missing' | 'identity_created' | 'waiting_for_approval' | 'registering' | 'ready';
  rootFingerprint: string; remoteFingerprint: string; requestFingerprint: string;
  requestCode: string; controlsRoot: boolean;
};
export type CryptoIdentityApproval = {
  id: string; rootFingerprint: string; requestFingerprint: string; device: string; expiresAt: string;
};
export type CryptoIdentityBridge = CryptoStorageBridge & {
  identityView: (handle: string, directory: string) => Promise<CryptoIdentityStatus>;
  identityBegin: (handle: string, directory: string, expectedRoot: string) => Promise<CryptoIdentityStatus>;
  identityPreview: (handle: string, directory: string, request: string) => Promise<CryptoIdentityApproval>;
  identityApprove: (handle: string, directory: string, approvalId: string) => Promise<string>;
  identityInstall: (handle: string, directory: string, grant: string) => Promise<CryptoIdentityStatus>;
  identityPending: (handle: string, directory: string) => Promise<string>;
  identityAcknowledge: (handle: string, directory: string, receipt: string) => Promise<CryptoIdentityStatus>;
};
/** Keys and protected records remain between Rust and Kotlin, outside this API. */
export const CryptoNative = requireOptionalNativeModule<CryptoIdentityBridge>('CryptoNative');
