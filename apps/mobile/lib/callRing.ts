/**
 * Ringing for a call someone starts in a direct room of a Rocket.Chat or
 * Mattermost/kChat server, done by the client from the call message: neither
 * server rings a third-party app (Rocket.Chat rings only through its licensed
 * direct calls and a DDP method, kChat through its own apps), see
 * brain/decisions.md.
 *
 * A call message from the other member of a two-person room, seen live and
 * younger than `RING_MS`, rings once. Rocket.Chat lets any member post a
 * `videoconf` message, so the server's own record of the call
 * (`video-conference.info`) names the caller and says whether it still rings;
 * kChat's post is the record. Module without `react-native`.
 */

import type { DdpEvent } from './ddp.ts';
import { CALL_TYPE, type LocalMessage } from './normalize.ts';
import type { Translator } from './provider.ts';

/** How long a call rings: Rocket.Chat cancels an unanswered direct call after 40 s. */
export const RING_MS = 40_000;
/** How often the server's record of a ringing call is read again. */
export const RING_CHECK_MS = 5_000;
const SEEN_KEPT = 200;

export type CallSignal =
  | { kind: 'call'; rid: string; messageId: string; callId: string; authorId: string; ts: number }
  | { kind: 'over'; messageId: string };

/** The server's record of a call. */
export type CallCheck = { rid: string; callerId: string; callerName: string | null; over: boolean; joined: readonly string[] };

export type IncomingCall = { messageId: string; rid: string; callId: string; callerId: string; callerName: string | null; until: number };

export function callSignalOfMessage(message: LocalMessage): CallSignal | null {
  if (message.systemType === CALL_TYPE && message.callId !== null) {
    return { kind: 'call', rid: message.rid, messageId: message.id, callId: message.callId, authorId: message.authorId, ts: message.ts };
  }
  return message.systemType === 'videoconf-ended' ? { kind: 'over', messageId: message.id } : null;
}

/** A call message carried by a live event the translator writes as a message. */
export function liveCallSignal(translator: Translator, event: DdpEvent): CallSignal | null {
  const translation = translator.translateEvent(event);
  if (translation.kind !== 'change' || translation.change.type !== 'message') return null;
  return callSignalOfMessage(translation.change.doc);
}

export type RingerDeps = {
  me: string;
  now(): number;
  /** The other member of a two-person direct room and the room's name, `null` for any other room. */
  directPeer(rid: string): Promise<{ uid: string; name: string | null } | null>;
  /** The server's record, `null` when the message is the record (kChat). Throws when there is none. */
  check(callId: string): Promise<CallCheck | null>;
  schedule(run: () => void, ms: number): () => void;
};

export class CallRinger {
  private readonly deps: RingerDeps;
  private readonly seen = new Set<string>();
  private readonly over = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private current: IncomingCall | null = null;
  private timers: (() => void)[] = [];

  constructor(deps: RingerDeps) {
    this.deps = deps;
  }

  get ringing(): IncomingCall | null {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async signal(signal: CallSignal): Promise<void> {
    if (signal.kind === 'over') {
      if (this.current?.messageId === signal.messageId) this.stop();
      remember(this.over, signal.messageId);
      return;
    }
    if (this.seen.has(signal.messageId) || this.over.has(signal.messageId)) return;
    remember(this.seen, signal.messageId);
    const { me, now } = this.deps;
    const age = now() - signal.ts;
    if (signal.authorId === me || age > RING_MS || age < -RING_MS) return;
    const peer = await this.deps.directPeer(signal.rid);
    if (peer === null) return;
    let check: CallCheck | null;
    try {
      check = await this.deps.check(signal.callId);
    } catch {
      return;
    }
    if (this.over.has(signal.messageId)) return;
    const callerId = check?.callerId ?? signal.authorId;
    if (callerId !== peer.uid || (check !== null && (check.rid !== signal.rid || ended(check, me)))) return;
    if (this.current !== null) return;
    const until = Math.min(signal.ts, now()) + RING_MS;
    this.current = { messageId: signal.messageId, rid: signal.rid, callId: signal.callId, callerId, callerName: check?.callerName ?? peer.name, until };
    this.timers.push(this.deps.schedule(() => this.stop(), Math.max(0, until - now())));
    if (check !== null) this.follow(this.current);
    this.emit();
  }

  /** Answered, declined or ignored here: rings no more, never again for this message. */
  stop(): void {
    for (const cancel of this.timers) cancel();
    this.timers = [];
    if (this.current === null) return;
    this.current = null;
    this.emit();
  }

  private follow(call: IncomingCall): void {
    this.timers.push(this.deps.schedule(() => {
      if (this.current !== call) return;
      this.deps.check(call.callId).then((check) => {
        if (this.current !== call) return;
        if (check !== null && ended(check, this.deps.me)) this.stop();
        else this.follow(call);
      }, () => { if (this.current === call) this.follow(call); });
    }, RING_CHECK_MS));
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function remember(ids: Set<string>, id: string): void {
  ids.add(id);
  if (ids.size > SEEN_KEPT) ids.delete(ids.values().next().value as string);
}

/** Over, or already answered on another of my devices. */
function ended(check: CallCheck, me: string): boolean {
  return check.over || check.joined.includes(me);
}
