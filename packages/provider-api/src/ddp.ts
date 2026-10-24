/** The subset of `WebSocket` we depend on. */
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
};

export type DdpEvent = {
  /** Stream name, e.g. `stream-room-messages`. */
  collection: string;
  /** Event key: a `rid`, or `<uid>/subscriptions-changed`. */
  eventKey: string;
  /** Payload. The first element carries the essentials. */
  args: unknown[];
};

export type DdpState = 'closed' | 'connecting' | 'connected' | 'authenticated';
