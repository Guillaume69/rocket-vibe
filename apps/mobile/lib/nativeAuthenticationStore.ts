/** The pre-authentication candidate is private to this device and unavailable
 * to push extensions. It never shares the active session's key or SQLite. */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {AuthenticationVault} from '../fournisseurs/rocketvibe/authenticationVault.ts';
import {EmailRecoveryVault} from '../fournisseurs/rocketvibe/emailRecoveryVault.ts';
import type {LoginChallenge} from '../fournisseurs/rocketvibe/authentication.ts';
import {hacher,lireSession} from './sessionStore.ts';

const dependencies={
  hash:hacher,
  token:async()=>Array.from(Crypto.getRandomBytes(32),b=>b.toString(16).padStart(2,'0')).join(''),
  storage:{
    read:(key:string)=>SecureStore.getItemAsync(key),
    write:(key:string,value:string)=>SecureStore.setItemAsync(key,value,{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
    remove:(key:string)=>SecureStore.deleteItemAsync(key),
  },
};
export const nativeAuthenticationVault=new AuthenticationVault(dependencies);
export const nativeEmailRecoveryVault=new EmailRecoveryVault(dependencies);

export async function completeNativeAuthentication(record:LoginChallenge):Promise<boolean> {
  return nativeAuthenticationVault.clearCompleted(record,await lireSession(record.baseUrl));
}
