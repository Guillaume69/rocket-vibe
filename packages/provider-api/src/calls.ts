export type CallScope={room?:string;membership?:string|null;alive?:()=>boolean};

export type NativeCalls={
  available:(room?:string,membership?:string|null)=>Promise<boolean>;
  memo:()=>boolean;
  start:(room:string,membership:string|null|undefined,alive:()=>boolean)=>Promise<string>;
  join:(id:string,scope:CallScope,alive:()=>boolean,state?:{cam?:boolean;mic?:boolean})=>Promise<string>;
  decline?:(id:string)=>Promise<void>;
};

export type CallSignal =
  | { kind: 'call'; rid: string; messageId: string; callId: string; authorId: string; ts: number }
  | { kind: 'over'; messageId: string };

/** The server's record of a call. */
export type CallCheck = { rid: string; callerId: string; callerName: string | null; over: boolean; joined: readonly string[] };
