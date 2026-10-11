/**
 * Scheduled messages on a RocketVibe server (`scheduled_messages`, contract in
 * `docs/protocol/SCHEDULED.md`), mapped to the neutral `lib/scheduled.ts`.
 *
 * Each schedule carries an `operation_id` kept until the server ANSWERS: a
 * retry of the same text in the same room and thread (a lost answer, a
 * network failure, a session renewed meanwhile) replays that operation, which
 * the server answers with the scheduled message it already made, never a
 * second one. A refusal (4xx other than 408/429) or a success forgets it.
 */

import type { ProviderScheduled, ScheduledItem } from '../../lib/scheduled.ts';
import type { NativeTypes } from './protocol.generated.ts';
import { NativeError, type NativeTransport } from './transport.ts';

type Transport = Pick<NativeTransport, 'scheduleMessage' | 'scheduledMessages' | 'cancelScheduled'>;
/** `NativeChat.scheduled`: a verified session, the capability, the same generation. */
export type ScheduledGate = <T>(call: (transport: Transport, operation: () => string) => Promise<T>) => Promise<T>;

export function scheduledItem(m: NativeTypes['ScheduledMessage']): ScheduledItem {
  const sendAt = Date.parse(m.send_at);
  if (!Number.isFinite(sendAt)) throw new NativeError(0, 'invalid_scheduled_message');
  return {
    id: m.id,
    rid: m.room_id,
    text: m.text,
    threadId: m.reply_to ?? null,
    sendAt,
    failed: m.state === 'failed',
    error: m.state === 'failed' ? (m.error ?? null) : null,
  };
}

/** Whether the server answered for good: the operation is then settled. */
function settled(error: unknown): boolean {
  return error instanceof NativeError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

export function nativeScheduled(gate: ScheduledGate): ProviderScheduled {
  // Room, thread and text → the operation awaiting its answer.
  const operations = new Map<string, string>();
  return {
    async schedule(rid, text, sendAt, threadId) {
      const key = JSON.stringify([rid, threadId, text]);
      try {
        const made = await gate((transport, operation) => {
          let id = operations.get(key);
          if (id === undefined) {
            id = operation();
            operations.set(key, id);
          }
          return transport.scheduleMessage(rid, {
            operation_id: id,
            text,
            ...(threadId !== null ? { reply_to: threadId } : {}),
            send_at: new Date(sendAt).toISOString(),
          });
        });
        operations.delete(key);
        return scheduledItem(made);
      } catch (error) {
        if (settled(error)) operations.delete(key);
        throw error;
      }
    },
    async list(rid) {
      const all = await gate((transport) => transport.scheduledMessages());
      return all.messages
        .filter((m) => m.room_id === rid)
        .map(scheduledItem)
        .sort((a, b) => a.sendAt - b.sendAt);
    },
    async cancel(id) {
      await gate((transport) => transport.cancelScheduled(id));
    },
  };
}
