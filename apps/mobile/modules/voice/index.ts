import {requireOptionalNativeModule} from 'expo-modules-core';

export type VoiceState='idle'|'connecting'|'connected'|'reconnecting'|'disconnected';
export type VoiceRoute='speaker'|'earpiece'|'bluetooth'|'wired';
export type VoiceMember={identity:string;speaking:boolean;muted:boolean;deafened:boolean;level:number;local:boolean};
/** The process's one voice connection, as the native engine sees it. */
export type VoiceSnapshot={
  state:VoiceState;
  /** The RocketVibe room this connection belongs to; null once over. */
  room?:string|null;
  microphone?:boolean;
  deafened?:boolean;
  /** Why the last connection ended (LiveKit's reason, lowercase): duplicate_identity, participant_removed... */
  reason?:string|null;
  route?:VoiceRoute|null;
  routes?:VoiceRoute[];
  participants:VoiceMember[];
};
export type VoiceConnect={room:string;url:string;token:string;title:string;link?:string|null;microphone:boolean};
type Bridge={
  snapshot():VoiceSnapshot;
  connect(options:VoiceConnect):Promise<void>;
  disconnect():Promise<void>;
  setMicrophone(enabled:boolean):Promise<void>;
  setDeafened(on:boolean):Promise<void>;
  setRoute(route:VoiceRoute):Promise<void>;
  ringback(on:boolean):Promise<void>;
  ringtone(on:boolean):Promise<void>;
  missed():Promise<void>;
  /** Stops the system ring of an incoming call the app now shows itself. */
  dismissRing(ring:string):Promise<void>;
  addListener(event:'change',listener:(snapshot:VoiceSnapshot)=>void):{remove:()=>void};
};
/**
 * LiveKit audio in a microphone foreground service (Android). Absent from a
 * build without the module: the app then never offers voice.
 */
export const VoiceNative=requireOptionalNativeModule<Bridge>('Voice');
