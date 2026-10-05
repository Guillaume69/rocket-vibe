import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {FactorVault} from '../providers/rocketvibe/factorVault.ts';
import {EmailVault} from '../providers/rocketvibe/emailVault.ts';
import {ReauthenticationVault} from '../providers/rocketvibe/reauthenticationVault.ts';
import {hash} from './sessionStore.ts';

const dependencies={hash:hash,
  token:async()=>Array.from(Crypto.getRandomBytes(32),b=>b.toString(16).padStart(2,'0')).join(''),
  storage:{read:(key:string)=>SecureStore.getItemAsync(key),
    write:(key:string,value:string)=>SecureStore.setItemAsync(key,value,{keychainAccessible:SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY}),
    remove:(key:string)=>SecureStore.deleteItemAsync(key)},
};
export const nativeReauthenticationVault=new ReauthenticationVault(dependencies);
export const nativeFactorVault=new FactorVault(dependencies);
export const nativeEmailVault=new EmailVault(dependencies);
