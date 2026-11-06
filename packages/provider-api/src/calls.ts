export type CallScope={room?:string;membership?:string|null;alive?:()=>boolean};

/** An Amazon Chime attendee's credentials, for a call the voice engine carries itself. */
export type ChimeCredentials={signalingUrl:string;audioHost:string;attendeeId:string;joinToken:string;origin:string};

export type NativeCalls={
  available:(room?:string,membership?:string|null)=>Promise<boolean>;
  memo:()=>boolean;
  start:(room:string,membership:string|null|undefined,alive:()=>boolean)=>Promise<string>;
  join:(id:string,scope:CallScope,alive:()=>boolean,state?:{cam?:boolean;mic?:boolean})=>Promise<string>;
  decline?:(id:string)=>Promise<void>;
  /** A call the voice engine can carry over Amazon Chime: joins it and answers its credentials (Slack's huddles). */
  chime?:(id:string)=>Promise<ChimeCredentials>;
  /** The name of someone in such a call, from the id the call gives them. */
  personName?:(identity:string)=>Promise<string|null>;
};

export type CallSignal =
  | { kind: 'call'; rid: string; messageId: string; callId: string; authorId: string; ts: number }
  | { kind: 'over'; messageId: string }
  /** A call the server rang this app with itself (Teams): no message to check. */
  | { kind: 'ring'; rid: string; messageId: string; callId: string; callerId: string; callerName: string | null }
  /** Whichever call the server rang stopped ringing here (Teams: answered elsewhere or over). */
  | { kind: 'rung-over' };

/** The server's record of a call. */
export type CallCheck = { rid: string; callerId: string; callerName: string | null; over: boolean; joined: readonly string[] };
