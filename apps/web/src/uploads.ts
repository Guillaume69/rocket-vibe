import type { App } from "./app";
import { ApiError, operation, segment } from "./api.ts";
import { all, write, writeBatch, type Account } from "./store.ts";
import type { Upload, Message } from "./protocol";
export interface UploadJob {
  id: string;
  account: string;
  room: string;
  file: File;
  caption: string;
  created?: number;
  root?: string;
  slot?: string;
  complete: string;
  membership?: string | null;
  error?: string;
}
let lastCreated = 0;
export async function enqueueUploads(
  account: Account,
  room: string,
  files: File[],
  caption: string,
  root: string | undefined,
  membership: string | null | undefined,
  staged: File[],
  active: () => boolean,
): Promise<boolean> {
  if (files.some((file) => file.size <= 0 || file.size > 100 * 1024 * 1024))
    throw new Error("File size must be between 1 byte and 100 MiB");
  const changes: { store: string; key: string; value?: unknown }[] = files.map(
    (file, index) => {
      const id = operation();
      return {
        store: "uploads",
        key: account.key + ":" + id,
        value: {
          id,
          account: account.key,
          room,
          file,
          caption: index === 0 ? caption : "",
          root,
          membership,
          created: (lastCreated = Math.max(Date.now(), lastCreated + 1)),
          complete: operation(),
        } satisfies UploadJob,
      };
    },
  );
  changes.push({
    store: "staged",
    key: account.key + ":" + room,
    value: staged.length ? staged : undefined,
  });
  return writeBatch(changes, active);
}
export async function enqueueUpload(
  account: Account,
  room: string,
  file: File,
  caption = "",
  root?: string,
  membership?: string | null,
): Promise<void> {
  if (file.size <= 0 || file.size > 100 * 1024 * 1024)
    throw new Error("File size must be between 1 byte and 100 MiB");
  const id = operation();
  const job: UploadJob = {
    id,
    account: account.key,
    room,
    file,
    caption,
    created: (lastCreated = Math.max(Date.now(), lastCreated + 1)),
    root,
    membership,
    complete: operation(),
  };
  await write("uploads", account.key + ":" + id, job);
}
export async function flushUploads(app: App): Promise<void> {
  if (!app.account || app.uploading || !navigator.onLine) return;
  app.uploading = true;
  const account = app.account.key,
    generation = app.generation,
    active = () =>
      account === app.account?.key && generation === app.generation;
  const run = async () => {
    for (const job of (await all<UploadJob>("uploads"))
      .filter((job) => job.account === account)
      .sort((a, b) => (a.created || 0) - (b.created || 0))) {
      if (!active()) return;
      const access = () =>
        app.model.rooms.has(job.room) &&
        !app.model.rooms.get(job.room)?.encrypted &&
        job.membership ===
          app.model.rooms.get(job.room)?.read_state?.membership_version;
      const guard = () => {
        if (!active()) throw new Error("Session changed");
        if (!access())
          throw new Error(
            "Conversation access changed. Attach this file again.",
          );
      };
      try {
        guard();
        let slot: Upload;
        if (!job.slot) {
          const hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                await job.file.arrayBuffer(),
              ),
            ),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          guard();
          slot = await app.api.request<Upload>("/api/v1/uploads", "POST", {
            operation_id: job.id,
            room_id: job.room,
            bytes: String(job.file.size),
            sha256: hash,
            media_type:
              job.file.type.split(";")[0].trim().toLowerCase() ||
              "application/octet-stream",
            filename: job.file.name,
            encrypted: false,
          });
          guard();
          job.slot = slot.id;
          await write("uploads", account + ":" + job.id, job);
          guard();
        } else
          slot = await app.api.request<Upload>(
            "/api/v1/uploads/" + segment(job.slot),
          );
        guard();
        if (slot.state === "expired" || slot.state === "cancelled")
          throw new Error("Upload expired");
        if (slot.state === "prepared")
          await app.api.upload(
            "/api/v1/uploads/" + segment(slot.id) + "/bytes",
            job.file,
            (fraction) => {
              if (active() && access()) {
                app.uploadProgress.set(job.id, fraction);
                app.renderUploads();
              }
            },
          );
        guard();
        const message = await app.api.request<Message>(
          "/api/v1/uploads/" + segment(slot.id) + "/complete",
          "POST",
          {
            operation_id: job.complete,
            content: {
              kind: "plain",
              markdown: job.caption,
              mentions: [],
              quotes: [],
              files: [slot.id],
            },
            reply_to: job.root || null,
          },
        );
        guard();
        await write("uploads", account + ":" + job.id);
        guard();
        app.model.put(message);
        app.refresh();
      } catch (error) {
        if (!active()) return;
        if (!access()) {
          await write("uploads", account + ":" + job.id);
          continue;
        }
        job.error = error instanceof Error ? error.message : String(error);
        await write("uploads", account + ":" + job.id, job);
        if (!active()) return;
        if (!access()) {
          await write("uploads", account + ":" + job.id);
          continue;
        }
        if (
          !(error instanceof ApiError) ||
          error.status === 429 ||
          error.status >= 500
        )
          break;
      }
    }
  };
  try {
    if (navigator.locks)
      await navigator.locks.request("rv-uploads:" + account, run);
    else await run();
  } finally {
    app.uploading = false;
    app.uploadProgress.clear();
    if (active()) await app.loadUploads();
  }
}
