import type { App } from "./app";
import { ApiError, operation, segment } from "./api";
import { all, write, type Account } from "./store";
import type { Upload, Message } from "./protocol";
export interface UploadJob {
  id: string;
  account: string;
  room: string;
  file: File;
  caption: string;
  root?: string;
  slot?: string;
  complete: string;
  membership?: string | null;
  error?: string;
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
    for (const job of (await all<UploadJob>("uploads")).filter(
      (job) => job.account === account,
    )) {
      if (!active()) return;
      try {
        if (
          !app.model.rooms.has(job.room) ||
          app.model.rooms.get(job.room)?.encrypted ||
          job.membership !==
            app.model.rooms.get(job.room)?.read_state?.membership_version
        )
          throw new Error(
            "Conversation access changed. Attach this file again.",
          );
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
          if (!active()) return;
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
          if (!active()) return;
          job.slot = slot.id;
          await write("uploads", account + ":" + job.id, job);
        } else
          slot = await app.api.request<Upload>(
            "/api/v1/uploads/" + segment(job.slot),
          );
        if (!active()) return;
        if (slot.state === "expired" || slot.state === "cancelled")
          throw new Error("Upload expired");
        if (slot.state === "prepared")
          await app.api.upload(
            "/api/v1/uploads/" + segment(slot.id) + "/bytes",
            job.file,
            (fraction) => {
              if (active()) {
                app.uploadProgress.set(job.id, fraction);
                app.renderUploads();
              }
            },
          );
        if (!active()) return;
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
        if (!active()) return;
        await write("uploads", account + ":" + job.id);
        app.model.put(message);
        app.refresh();
      } catch (error) {
        if (!active()) return;
        job.error = error instanceof Error ? error.message : String(error);
        await write("uploads", account + ":" + job.id, job);
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
