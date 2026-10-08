import type {
  Message,
  Room,
  Session,
  Snapshot,
  SyncBatch,
  SendMessage,
} from "./protocol";
export interface Account {
  key: string;
  session: Session;
  instance: string;
  epoch: string;
}
export interface Pending {
  id: string;
  account: string;
  room: string;
  payload: SendMessage;
  created: string;
  membership?: string | null;
  error?: string;
}
export const newer = (incoming: string, previous: string): boolean =>
  BigInt(incoming) >= BigInt(previous);
export class Model {
  rooms = new Map<string, Room>();
  messages = new Map<string, Message>();
  cursor = "";
  replace(snapshot: Snapshot): void {
    this.rooms = new Map(snapshot.rooms.map((room) => [room.id, room]));
    this.messages = new Map(
      snapshot.messages.map((message) => [message.id, message]),
    );
    this.cursor = snapshot.cursor;
  }
  put(message: Message): void {
    const old = this.messages.get(message.id);
    if (!old || newer(message.revision, old.revision)) {
      this.messages.set(message.id, message);
      if (old && (message.deleted || message.revision !== old.revision))
        this.invalidateQuote(message.id);
    }
  }
  batch(batch: SyncBatch): void {
    if (batch.protocol_version !== 1 || !batch.cursor)
      throw new Error("Invalid sync batch");
    for (const change of batch.changes) {
      if (change.type === "room_removed") {
        this.rooms.delete(change.data.room_id);
        this.invalidateRoom(change.data.room_id);
      } else if (change.type === "room_upsert") {
        const old = this.rooms.get(change.data.id),
          lifetime = change.data.read_state?.membership_version;
        if (old && lifetime && old.read_state?.membership_version !== lifetime)
          this.invalidateRoom(old.id);
        const incoming = change.data;
        if (
          old &&
          old.read_state &&
          incoming.read_state &&
          old.read_state.membership_version === lifetime
        ) {
          const state = incoming.read_state;
          if (
            !newer(
              state.favorite_revision || "0",
              old.read_state.favorite_revision || "0",
            )
          ) {
            state.favorite = old.read_state.favorite;
            state.favorite_revision = old.read_state.favorite_revision;
          }
          if (!newer(state.revision, old.read_state.revision))
            incoming.read_state = {
              ...old.read_state,
              favorite: state.favorite,
              favorite_revision: state.favorite_revision,
            };
        }
        this.rooms.set(
          incoming.id,
          old && !newer(incoming.revision, old.revision)
            ? { ...old, read_state: incoming.read_state }
            : incoming,
        );
      } else if (
        change.type === "message_upsert" &&
        this.rooms.has(change.data.room_id)
      )
        this.put(change.data);
    }
    this.cursor = batch.cursor;
  }
  invalidateQuote(id: string): void {
    const redact = (
      quote: import("./protocol").MessageQuote,
    ): import("./protocol").MessageQuote => {
      if (quote.reference.message_id === id) return { ...quote, excerpt: null };
      if (quote.excerpt?.quotes)
        return {
          ...quote,
          excerpt: {
            ...quote.excerpt,
            quotes: quote.excerpt.quotes.map(redact),
          },
        };
      return quote;
    };
    for (const [key, message] of this.messages)
      if (message.quotes?.length)
        this.messages.set(key, {
          ...message,
          quotes: message.quotes.map(redact),
        });
  }
  invalidateRoom(room: string): void {
    for (const [id, message] of this.messages)
      if (message.room_id === room) this.messages.delete(id);
    const redact = (
      quote: import("./protocol").MessageQuote,
    ): import("./protocol").MessageQuote => {
      if (quote.reference.room_id === room) return { ...quote, excerpt: null };
      if (quote.excerpt?.quotes)
        return {
          ...quote,
          excerpt: {
            ...quote.excerpt,
            quotes: quote.excerpt.quotes.map(redact),
          },
        };
      return quote;
    };
    for (const [id, message] of this.messages)
      if (message.quotes?.length)
        this.messages.set(id, {
          ...message,
          quotes: message.quotes.map(redact),
        });
  }
  snapshot(): Snapshot {
    return {
      protocol_version: 1,
      rooms: [...this.rooms.values()],
      messages: [...this.messages.values()],
      cursor: this.cursor,
    };
  }
  timeline(room: string, root?: string): Message[] {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.room_id === room &&
          !message.deleted &&
          (root ? message.reply_to === root : !message.reply_to),
      )
      .sort((a, b) =>
        BigInt(a.position) < BigInt(b.position)
          ? -1
          : BigInt(a.position) > BigInt(b.position)
            ? 1
            : a.id.localeCompare(b.id),
      );
  }
}
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("rocket-vibe-web", 4);
    request.onupgradeneeded = () => {
      for (const name of [
        "accounts",
        "cache",
        "outbox",
        "drafts",
        "operations",
        "uploads",
        "staged",
        "media",
      ])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
export async function read<T>(
  store: string,
  key: string,
): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}
export async function write(
  store: string,
  key: string,
  value?: unknown,
): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    if (value === undefined) transaction.objectStore(store).delete(key);
    else transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
export async function all<T>(store: string): Promise<T[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}
export async function purgeRoom(account: string, room: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      ["outbox", "uploads", "drafts", "staged", "media"],
      "readwrite",
    );
    for (const name of ["outbox", "uploads", "drafts", "staged", "media"]) {
      const request = transaction.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (
          String(cursor.key) === account + ":" + room ||
          String(cursor.key).startsWith(account + ":" + room + ":") ||
          (value &&
            typeof value === "object" &&
            value.account === account &&
            value.room === room)
        )
          cursor.delete();
        cursor.continue();
      };
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function purge(account: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [
        "accounts",
        "cache",
        "outbox",
        "drafts",
        "operations",
        "uploads",
        "staged",
        "media",
      ],
      "readwrite",
    );
    tx.objectStore("accounts").delete(account);
    tx.objectStore("cache").delete(account);
    for (const name of [
      "outbox",
      "drafts",
      "operations",
      "uploads",
      "staged",
      "media",
    ]) {
      const request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(account + ":")) cursor.delete();
        cursor.continue();
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
