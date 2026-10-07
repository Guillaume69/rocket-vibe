import {requireNativeViewManager, requireOptionalNativeModule} from 'expo-modules-core';
import type {ComponentType} from 'react';
import type {ViewProps} from 'react-native';

export type VoiceState='idle'|'connecting'|'connected'|'reconnecting'|'disconnected';
export type VoiceRoute='speaker'|'earpiece'|'bluetooth'|'wired';
export type VoiceMember={identity:string;speaking:boolean;muted:boolean;deafened:boolean;level:number;local:boolean;camera?:boolean;screen?:boolean};
/** The process's one voice connection, as the native engine sees it. */
export type VoiceSnapshot={
  state:VoiceState;
  /** The RocketVibe room this connection belongs to; null once over. */
  room?:string|null;
  microphone?:boolean;
  deafened?:boolean;
  /** The own camera is on; the own screen is shared. */
  camera?:boolean;
  sharing?:boolean;
  /** Frames are end-to-end encrypted (an encrypted room). */
  encrypted?:boolean;
  /** Why the last connection ended (LiveKit's reason, lowercase): duplicate_identity, participant_removed... */
  reason?:string|null;
  route?:VoiceRoute|null;
  routes?:VoiceRoute[];
  participants:VoiceMember[];
};
export type VoiceConnect={room:string;url:string;token:string;title:string;link?:string|null;microphone:boolean;
  /** An encrypted room's voice key, base64 (docs/protocol/VOICE.md); null in a plaintext room. */
  e2eeKey?:string|null};
type Bridge={
  snapshot():VoiceSnapshot;
  connect(options:VoiceConnect):Promise<void>;
  disconnect():Promise<void>;
  /** Replaces the frame key when the room's group reaches a new epoch. */
  setE2eeKey(key:string):Promise<void>;
  setMicrophone(enabled:boolean):Promise<void>;
  setDeafened(on:boolean):Promise<void>;
  setRoute(route:VoiceRoute):Promise<void>;
  setCamera(enabled:boolean):Promise<void>;
  /** Asks Android for the screen, then shares it; false when the user refused. */
  startScreenShare():Promise<boolean>;
  stopScreenShare():Promise<void>;
  ringback(on:boolean):Promise<void>;
  ringtone(on:boolean):Promise<void>;
  missed():Promise<void>;
  /** Stops the system ring of an incoming call the app now shows itself. */
  dismissRing(ring:string):Promise<void>;
  /** How loud someone plays here (0 to 2) and a mute for this side only; kept for the process. */
  setPersonVolume(identity:string,volume:number,muted:boolean):Promise<void>;
  setInputVolume(volume:number):Promise<void>;
  setOutputVolume(volume:number):Promise<void>;
  /** The noise remover (RNNoise) on the microphone. */
  setNoiseSuppression(on:boolean):Promise<void>;
  /** The next screen share's lines (the screen's shorter side) and frames a second. */
  setShareQuality(height:number,fps:number):Promise<void>;
  addListener(event:'change',listener:(snapshot:VoiceSnapshot)=>void):{remove:()=>void};
  /** The microphone's level, 0 to 1, about ten times a second while connected. */
  addListener(event:'level',listener:(event:{level:number})=>void):{remove:()=>void};
};
/**
 * LiveKit audio in a microphone foreground service (Android). Absent from a
 * build without the module: the app then never offers voice.
 */
export const VoiceNative=requireOptionalNativeModule<Bridge>('Voice');

export type VoiceVideoProps=ViewProps&{identity:string;source:'camera'|'screen';fit?:'cover'|'contain'};
/** A participant's camera or screen, from the engine's room. Null without the module. */
export const VoiceVideoView:ComponentType<VoiceVideoProps>|null=VoiceNative?requireNativeViewManager<VoiceVideoProps>('Voice'):null;
