/** The pre-authentication candidate is private to this device and unavailable
 * to push extensions. It never shares the active session's key or SQLite. */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {AuthenticationVault} from '../fournisseurs/rocketvibe/authenticationVault.ts';
import type {LoginChallenge} from '../fournisseurs/rocketvibe/authentication.ts';
import {hacher,lireSession} from './sessionStore.ts';

export const nativeAuthenticationVault=new AuthenticationVault({
  hash:hacher,
  token:async()=>Array.from(Crypto.getRandomBytes(32),b=>b.toString(16).padStart(2,'0')).join(''),
  storage:{
    read:key=>SecureStore.getItemAsync(key),
    write:(key,value)=>SecureStore.setItemAsync(key,value,{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
    remove:key=>SecureStore.deleteItemAsync(key),
  },
});

export async function completeNativeAuthentication(record:LoginChallenge):Promise<boolean> {
  return nativeAuthenticationVault.clearCompleted(record,await lireSession(record.baseUrl));
}
