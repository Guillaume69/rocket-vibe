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
  private withdrawals = new Map<string, number>();
  roomLifetime(room: string): number {
    return this.withdrawals.get(room) || 0;
  }
  private withdrewRoom(room: string): void {
    this.withdrawals.set(room, this.roomLifetime(room) + 1);
  }
  replace(snapshot: Snapshot): void {
    const incoming = new Map(snapshot.rooms.map((room) => [room.id, room]));
    for (const [id, previous] of this.rooms) {
      const room = incoming.get(id),
        membership = previous.read_state?.membership_version;
      if (
        !room ||
        (membership && room.read_state?.membership_version !== membership)
      )
        this.withdrewRoom(id);
    }
    this.rooms = new Map(snapshot.rooms.map((room) => [room.id, room]));
    this.messages = new Map(
      snapshot.messages.map((message) => [message.id, message]),
    );
    this.cursor = snapshot.cursor;
  }
  put(message: Message): void {
    const old = this.messages.get(message.id);
    // Personal marks (star, follow) carry their own revision: the newer copy
    // wins, whatever the message's own revision.
    const pick = <T extends { revision: string }>(
      previous: T | null | undefined,
      incoming: T | null | undefined,
    ) =>
      previous && (!incoming || !newer(incoming.revision, previous.revision))
        ? previous
        : incoming;
    const star = pick(old?.personal_star, message.personal_star),
      follow = pick(old?.personal_follow, message.personal_follow);
    if (!old || newer(message.revision, old.revision)) {
      this.messages.set(
        message.id,
        message.deleted
          ? message
          : { ...message, personal_star: star, personal_follow: follow },
      );
      if (old && (message.deleted || message.revision !== old.revision))
        this.invalidateQuote(message.id);
    } else if (
      !old.deleted &&
      (star !== old.personal_star || follow !== old.personal_follow)
    ) {
      this.messages.set(message.id, {
        ...old,
        personal_star: star,
        personal_follow: follow,
      });
    }
  }
  batch(batch: SyncBatch): void {
    if (batch.protocol_version !== 1 || !batch.cursor)
      throw new Error("Invalid sync batch");
    for (const change of batch.changes) {
      if (change.type === "room_removed") {
        this.withdrewRoom(change.data.room_id);
        this.rooms.delete(change.data.room_id);
        this.invalidateRoom(change.data.room_id);
      } else if (change.type === "room_upsert") {
        const old = this.rooms.get(change.data.id),
          lifetime = change.data.read_state?.membership_version;
        if (
          old?.read_state?.membership_version &&
          lifetime &&
          old.read_state.membership_version !== lifetime
        )
          this.withdrewRoom(old.id);
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
    const live = [...this.messages.values()].filter(
      (message) => message.room_id === room && !message.deleted,
    );
    if (root)
      return sorted(live.filter((message) => message.reply_to === root));
    const roots = live.filter((message) => !message.reply_to);
    // A reply also sent to the room shows among the roots, but only within the
    // loaded window: an older one (from an opened thread) would make history
    // paging skip what lies between.
    const oldest = roots.reduce<bigint | undefined>(
      (low, message) =>
        low === undefined || BigInt(message.position) < low
          ? BigInt(message.position)
          : low,
      undefined,
    );
    return sorted([
      ...roots,
      ...live.filter(
        (message) =>
          !!message.reply_to &&
          message.also_in_room &&
          (oldest === undefined || BigInt(message.position) >= oldest),
      ),
    ]);
  }
  /**
   * Keeps each room's `kept` newest messages (by creation time, then position
   * and id), as the native apps do once per session after the catch-up
   * (desktop `Writer::apply_retention`, mobile `APPLY_RETENTION`): older ones
   * come back from the server when the history is paged again. A thread root
   * still answered by a kept reply stays, and so does every message of the
   * `spared` rooms (the room on screen). Answers how many went.
   */
  retain(kept: number, spared: Iterable<string> = []): number {
    const skip = new Set(spared),
      byRoom = new Map<string, Message[]>();
    for (const message of this.messages.values()) {
      if (skip.has(message.room_id)) continue;
      const list = byRoom.get(message.room_id);
      if (list) list.push(message);
      else byRoom.set(message.room_id, [message]);
    }
    const dropped = new Set<string>();
    for (const list of byRoom.values()) {
      if (list.length <= kept) continue;
      list.sort(newestFirst);
      for (const message of list.slice(kept)) dropped.add(message.id);
    }
    if (!dropped.size) return 0;
    for (const message of this.messages.values())
      if (message.reply_to && !dropped.has(message.id))
        dropped.delete(message.reply_to);
    for (const id of dropped) this.messages.delete(id);
    return dropped.size;
  }
}
/** The messages kept per room once per session (the native apps' quota). */
export const MESSAGES_KEPT_PER_ROOM = 500;
function newestFirst(a: Message, b: Message): number {
  const time =
    (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
  if (time) return time;
  const left = BigInt(a.position),
    right = BigInt(b.position);
  return left < right ? 1 : left > right ? -1 : b.id.localeCompare(a.id);
}
function sorted(messages: Message[]): Message[] {
  return messages.sort((a, b) =>
    BigInt(a.position) < BigInt(b.position)
      ? -1
      : BigInt(a.position) > BigInt(b.position)
        ? 1
        : a.id.localeCompare(b.id),
  );
}
let database: Promise<IDBDatabase> | undefined;
export class StorageOpenError extends Error {
  readonly code: "blocked" | "unavailable";
  constructor(code: "blocked" | "unavailable") {
    super("browser_storage_" + code);
    this.name = "StorageOpenError";
    this.code = code;
  }
}
function open(): Promise<IDBDatabase> {
  if (database) return database;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new StorageOpenError("unavailable")),
      10000,
    );
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open("rocket-vibe-web", 6);
    } catch (error) {
      fail(error);
      return;
    }
    request.onblocked = () => fail(new StorageOpenError("blocked"));
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      for (const name of [
        "accounts",
        "cache",
        "outbox",
        "drafts",
        "operations",
        "uploads",
        "staged",
        "media",
        "reminders",
        // Sign-outs the server did not hear: never purged with the account.
        "logouts",
      ])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => {
        db.close();
        if (database === pending) database = undefined;
      };
      resolve(db);
    };
    request.onerror = () =>
      fail(request.error || new StorageOpenError("unavailable"));
  });
  database = pending;
  void pending.catch(() => {
    if (database === pending) database = undefined;
  });
  return pending;
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
export async function writeBatch(
  changes: { store: string; key: string; value?: unknown }[],
  active: () => boolean,
): Promise<boolean> {
  const db = await open();
  if (!active()) return false;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [...new Set(changes.map((change) => change.store))],
      "readwrite",
    );
    for (const change of changes) {
      const target = tx.objectStore(change.store);
      if (change.value === undefined) target.delete(change.key);
      else target.put(change.value, change.key);
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
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
      ["outbox", "uploads", "drafts", "staged", "media", "operations"],
      "readwrite",
    );
    for (const name of [
      "outbox",
      "uploads",
      "drafts",
      "staged",
      "media",
      "operations",
    ]) {
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
        "reminders",
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
      "reminders",
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
