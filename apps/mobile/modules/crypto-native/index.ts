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
  removed: (handle: string, expectedFingerprint: string) => Promise<void>;
  close: (handle: string) => Promise<void>;
};
export type CryptoIdentityStatus = {
  phase: 'missing' | 'identity_created' | 'waiting_for_approval' | 'registering' | 'ready' | 'expired' | 'renewing';
  rootFingerprint: string; remoteFingerprint: string; requestFingerprint: string;
  requestCode: string; controlsRoot: boolean; certificateExpiresAt: string | null;
};
export type CryptoIdentityApproval = {
  id: string; rootFingerprint: string; requestFingerprint: string; device: string; expiresAt: string;
};
export type CryptoIdentityBridge = CryptoStorageBridge & {
  identityView: (handle: string, directory: string) => Promise<CryptoIdentityStatus>;
  identityBegin: (handle: string, directory: string, expectedRoot: string) => Promise<CryptoIdentityStatus>;
  identityRenew: (handle: string, directory: string, expectedRoot: string) => Promise<CryptoIdentityStatus>;
  identityPreview: (handle: string, directory: string, request: string) => Promise<CryptoIdentityApproval>;
  identityApprove: (handle: string, directory: string, approvalId: string) => Promise<string>;
  identityInstall: (handle: string, directory: string, grant: string) => Promise<CryptoIdentityStatus>;
  identityPending: (handle: string, directory: string) => Promise<string>;
  identityAcknowledge: (handle: string, directory: string, receipt: string) => Promise<CryptoIdentityStatus>;
};
export type CryptoPeerStatus = {
  user: string; fingerprint: string; previous_fingerprint: string;
  trust: 'unknown' | 'unverified' | 'verified' | 'changed';
  devices: {id: string; incarnation: string; fingerprint: string; expires_at: string; approved: boolean}[];
};
export type CryptoWithdrawalBridge = CryptoIdentityBridge & {
  withdrawalAction:(handle:string,ownDirectory:string,input:string)=>Promise<string>;
};
/** Explicit recovery-code display/input only; no private key or record API. */
export type CryptoRecoveryBridge = CryptoIdentityBridge & {
  recoveryAction:(handle:string,ownDirectory:string,input:string)=>Promise<string>;
};
/** History recovery between devices of the account: public wire values only. */
export type CryptoHistoryBridge = CryptoIdentityBridge & {
  historyAction:(handle:string,ownDirectory:string,input:string)=>Promise<string>;
};
/** History backup: the history code crosses only the explicit view and join input. */
export type CryptoHistoryBackupBridge = CryptoIdentityBridge & {
  historyBackupAction:(handle:string,ownDirectory:string,input:string)=>Promise<string>;
};
export type CryptoPeerView = CryptoPeerStatus & {id: string};
export type CryptoPeerApproval = {
  id: string; user: string; rootFingerprint: string; device: string;
  fingerprint: string; incarnation: string; expiresAt: string;
};
export type CryptoPeerBridge = CryptoIdentityBridge & {
  peerView: (handle:string,ownDirectory:string,user:string,peerDirectory:string)=>Promise<{id:string;statusJson:string}>;
  peerPin: (handle:string,ownDirectory:string,peerDirectory:string,viewId:string,choice:string,confirmed:string,old:string)=>Promise<{id:string;statusJson:string}>;
  peerPreview: (handle:string,ownDirectory:string,peerDirectory:string,viewId:string,device:string)=>Promise<CryptoPeerApproval>;
  peerApprove: (handle:string,ownDirectory:string,peerDirectory:string,approvalId:string)=>Promise<{id:string;statusJson:string}>;
};
/** Keys and protected records remain between Rust and Kotlin, outside this API. */
export type CryptoParticipant = {user:string;device:string;incarnation:string;root:string;certificate:string};
export type CryptoGroupPreview = {id:string;kind:'genesis'|'change'|'admission'|'readmission'|'commit';fingerprint:string;recipients:CryptoParticipant[]};
export type CryptoGroupBridge = CryptoPeerBridge & {
  groupAction:(handle:string,ownDirectory:string,input:string)=>Promise<string>;
};
export type CryptoConversationBridge = CryptoGroupBridge & {
  conversationAction:(handle:string,ownDirectory:string,input:string)=>Promise<string>;
};
export const CryptoNative = requireOptionalNativeModule<CryptoConversationBridge & CryptoWithdrawalBridge & CryptoRecoveryBridge & CryptoHistoryBridge & CryptoHistoryBackupBridge>('CryptoNative');
