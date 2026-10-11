/**
 * Browser notifications for new messages. With the app's service worker
 * controlling the page they are persistent (`showNotification`): buttons, the
 * author's photo and the message's picture, clicks handled in `sw.js`, which
 * hands them back to a live tab. Without it, `new Notification` (no buttons).
 * The session token never reaches the worker: a tab performs every action.
 */

/** What `sw.js` hands a tab when a notification or one of its buttons is clicked. */
export type NoteClick = {
  type: "rv-notification";
  action: "open" | "reply" | "read" | "like";
  /** The text typed in an inline reply, or null when the platform showed a plain button. */
  reply: string | null;
  account: string;
  room: string;
  message: string;
};
/** Stored in the notification (`data`), read back by `sw.js`. Never a token. */
export type NoteData = {
  rv: "message";
  account: string;
  room: string;
  message: string;
  position: string;
};
export type NoteAction = {
  action: "read" | "like" | "reply";
  title: string;
  type?: "text";
  placeholder?: string;
};
export type NoteLabels = {
  read: string;
  like: string;
  reply: string;
  placeholder: string;
};
/** What the worker said it can do (`rv-notification-hello`). */
export type NoteWorker = { inlineReply: boolean };
export type NoteHandle = { close(): void };
export type NoteOptions = {
  body: string;
  tag: string;
  data: NoteData;
  icon?: string;
  image?: string;
  silent: boolean;
};

/** The reaction the 👍 button sends: the code the app's quick reactions use. */
export const LIKE = "thumbsup";
/** Photo and picture sizes, and the longest data URL kept for either. */
export const PHOTO_SIZE = 192;
export const PICTURE_SIZE = { width: 720, height: 720 };
export const PICTURE_MAX_SOURCE = 10 * 1024 * 1024;
const MAX_DATA_URL = 1024 * 1024;

const SOUND_KEY = "rv-notification-sound";
/** The app's own sound in place of the system's (GTK's "rocket-vibe sound" switch), on by default. */
export function ownSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}
export function setOwnSound(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SOUND_KEY);
    else localStorage.setItem(SOUND_KEY, "off");
  } catch {}
}

/**
 * The buttons, most wanted first, cut to what the browser shows (Chromium
 * and Firefox: 2). Reply is a text field only where the worker can read one
 * back (`NotificationEvent.reply`); never a plain Reply button, since a click
 * on the notification already opens the room with the composer focused.
 */
export function noteActions(
  max: number,
  worker: NoteWorker,
  labels: NoteLabels,
): NoteAction[] {
  const actions: NoteAction[] = [
    { action: "read", title: labels.read },
    { action: "like", title: labels.like },
  ];
  if (worker.inlineReply)
    actions.push({
      action: "reply",
      title: labels.reply,
      type: "text",
      placeholder: labels.placeholder,
    });
  return actions.slice(0, Math.max(0, Math.floor(max) || 0));
}

export function maxActions(): number {
  const value = (globalThis as { Notification?: { maxActions?: unknown } })
    .Notification?.maxActions;
  return typeof value === "number" ? value : 0;
}

/** A click message from `sw.js`, checked field by field. */
export function parseClick(value: unknown): NoteClick | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (
    item.type !== "rv-notification" ||
    !["open", "reply", "read", "like"].includes(item.action as string) ||
    typeof item.account !== "string" ||
    typeof item.room !== "string" ||
    typeof item.message !== "string" ||
    (item.reply !== null && typeof item.reply !== "string")
  )
    return undefined;
  return item as NoteClick;
}

/** The size a picture is drawn at: cropped square for a photo, fitted (never enlarged) otherwise. */
export function fitSize(
  natural: { width: number; height: number },
  box: { width: number; height: number },
): { width: number; height: number } {
  const scale = Math.min(
    1,
    box.width / Math.max(1, natural.width),
    box.height / Math.max(1, natural.height),
  );
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale)),
  };
}

/** Resolves undefined after `ms` instead of waiting longer (or on failure). */
export function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return Promise.race([
    work.catch(() => undefined),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);
}

/**
 * A picture the operating system can show: the system fetches `icon` and
 * `image` itself, without the session, so a protected file becomes a data URL
 * drawn in the page from its authenticated object URL.
 */
export async function pictureData(
  url: string,
  photo: boolean,
): Promise<string | undefined> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context || !image.naturalWidth || !image.naturalHeight) return undefined;
  if (photo) {
    canvas.width = canvas.height = PHOTO_SIZE;
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      PHOTO_SIZE,
      PHOTO_SIZE,
    );
  } else {
    const size = fitSize(
      { width: image.naturalWidth, height: image.naturalHeight },
      PICTURE_SIZE,
    );
    canvas.width = size.width;
    canvas.height = size.height;
    context.drawImage(image, 0, 0, size.width, size.height);
  }
  const data = canvas.toDataURL(photo ? "image/png" : "image/jpeg", 0.85);
  return data.length <= MAX_DATA_URL ? data : undefined;
}

let hello:
  | { controller: ServiceWorker; answer: Promise<NoteWorker | undefined> }
  | undefined;
/**
 * The worker controlling this page, if it is one that handles notification
 * clicks (an older `sw.js` would leave them dead): asked once per controller.
 */
export function noteWorker(): Promise<NoteWorker | undefined> {
  const controller =
    "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
  if (!controller) return Promise.resolve(undefined);
  if (hello?.controller === controller) return hello.answer;
  const answer = new Promise<NoteWorker | undefined>((resolve) => {
    const channel = new MessageChannel();
    // No answer in time: ask again next time rather than give up for good.
    const timer = setTimeout(() => {
      if (hello?.answer === answer) hello = undefined;
      resolve(undefined);
    }, 1000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const data = event.data as { version?: unknown; inlineReply?: unknown };
      resolve(
        data && data.version === 1
          ? { inlineReply: data.inlineReply === true }
          : undefined,
      );
    };
    controller.postMessage({ type: "rv-notification-hello" }, [channel.port2]);
  });
  hello = { controller, answer };
  return answer;
}

/** Tells the worker this tab is signed in and ready for clicks it kept back. */
export function announceReady(): void {
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.controller?.postMessage({
      type: "rv-notification-ready",
    });
}

/**
 * Shows one message notification. Through the worker when it answered the
 * hello and the browser accepts it, else `new Notification` (`onclick`
 * handles its click; a constructed notification takes no buttons).
 */
export async function showNote(
  title: string,
  options: NoteOptions,
  worker: NoteWorker | undefined,
  actions: NoteAction[],
  previous: NoteHandle | undefined,
  onclick: () => void,
): Promise<NoteHandle> {
  const registration = worker
    ? await navigator.serviceWorker.getRegistration().catch(() => undefined)
    : undefined;
  if (registration?.active)
    try {
      // `renotify`: a second message in the room alerts again, not a silent swap.
      await registration.showNotification(title, {
        ...options,
        actions,
        renotify: true,
      } as NotificationOptions);
      const position = BigInt(options.data.position);
      return {
        // The room's notifications up to this one: a newer one shown later
        // (by this tab or another) stays.
        close: () =>
          void registration
            .getNotifications({ tag: options.tag })
            .then((list) => {
              for (const note of list) {
                const data = note.data as Partial<NoteData> | null;
                if (
                  typeof data?.position !== "string" ||
                  BigInt(data.position) <= position
                )
                  note.close();
              }
            })
            .catch(() => {}),
      };
    } catch {}
  previous?.close();
  const note = new Notification(title, {
    body: options.body,
    tag: options.tag,
    icon: options.icon,
    silent: options.silent,
    ...(options.image ? { image: options.image } : {}),
  } as NotificationOptions);
  note.onclick = () => {
    onclick();
    note.close();
  };
  return note;
}
