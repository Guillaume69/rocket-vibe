import type { Discovery, Snapshot, SnapshotPage } from "./protocol";
import { nt } from "./native-i18n.ts";
import nativeErrors from "./native-errors.generated.json" with { type: "json" };
export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter: number;
  constructor(status: number, code: string, retryAfter = 0) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
export class Api {
  token = "";
  expired: () => void = () => {};
  async request<T>(
    path: string,
    method = "GET",
    input?: unknown,
    anonymous = false,
    revalidations = 0,
  ): Promise<T> {
    if (!path.startsWith("/api/") && path !== "/.well-known/rocketvibe")
      throw new Error("Invalid API path");
    const token = this.token;
    const headers = new Headers();
    if (token && !anonymous) headers.set("Authorization", "Bearer " + token);
    let body: BodyInit | undefined;
    if (input instanceof Blob) {
      body = input;
      headers.set("Content-Type", input.type || "application/octet-stream");
    } else if (input !== undefined) {
      body = JSON.stringify(input);
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(path, {
      method,
      headers,
      body,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => null);
      const code =
        value &&
        typeof value === "object" &&
        "code" in value &&
        typeof value.code === "string"
          ? value.code
          : "http_" + response.status;
      // A read can lose its authorization lease while the server builds it.
      // Refetch from scratch with the same active session; never replay a mutation.
      if (
        method === "GET" &&
        response.status === 409 &&
        code === "delivery_revalidate" &&
        revalidations < 2 &&
        token === this.token &&
        value &&
        typeof value === "object" &&
        "request_id" in value &&
        typeof value.request_id === "string"
      )
        return this.request<T>(
          path,
          method,
          input,
          anonymous,
          revalidations + 1,
        );
      if (
        response.status === 401 &&
        token === this.token &&
        !anonymous &&
        code === "session_rejected" &&
        value &&
        typeof value === "object" &&
        "request_id" in value &&
        typeof value.request_id === "string"
      )
        this.expired();
      const error = new ApiError(
        response.status,
        code,
        Math.min(300, Number(response.headers.get("Retry-After")) || 0),
      );
      const area = path.startsWith("/api/v1/bots")
        ? "bots"
        : /^\/api\/v1\/(workflows|forms)/.test(path)
          ? "workflows"
          : path.startsWith("/api/v1/admin/")
            ? "admin"
            : undefined;
      if (area) {
        const key = (nativeErrors[area] as Record<string, string>)[code];
        error.message = nt(
          key ??
            (area === "admin"
              ? code.startsWith("error-")
                ? "admin.error_denied"
                : "admin.failed"
              : response.status === 429
                ? "bots.error_rate_limited"
                : area === "bots"
                  ? "bots.failed"
                  : "workflows.failed"),
        );
      }
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  async upload(
    path: string,
    file: File,
    progress: (fraction: number) => void,
  ): Promise<void> {
    if (!path.startsWith("/api/v1/uploads/"))
      throw new Error("Invalid upload path");
    const token = this.token;
    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", path);
      request.timeout = 300000;
      request.setRequestHeader("Authorization", "Bearer " + token);
      request.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream",
      );
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) progress(event.loaded / event.total);
      };
      request.onerror = () => reject(new TypeError("Network unavailable"));
      request.ontimeout = () => reject(new Error("Upload timed out"));
      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          progress(1);
          resolve();
          return;
        }
        let code = "upload_failed";
        try {
          code = JSON.parse(request.responseText).code || code;
        } catch {}
        reject(new ApiError(request.status, code));
      };
      request.send(file);
    });
  }
  async blob(
    path: string,
    progress?: (received: number) => void,
  ): Promise<Blob> {
    if (!path.startsWith("/api/")) throw new Error("Invalid resource path");
    const response = await fetch(path, {
      headers: { Authorization: "Bearer " + this.token },
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(progress ? 300000 : 60000),
    });
    if (!response.ok) throw new ApiError(response.status, "download_failed");
    if (progress && response.body) {
      const reader = response.body.getReader(),
        parts: BlobPart[] = [];
      let received = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          parts.push(next.value);
          received += next.value.byteLength;
          progress(received);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      return new Blob(parts, {
        type:
          response.headers.get("content-type") || "application/octet-stream",
      });
    }
    return response.blob();
  }
  async snapshot(info: Discovery): Promise<Snapshot> {
    if (!info.capabilities.snapshot_paging)
      return this.request("/api/v1/sync/snapshot");
    let page = await this.request<SnapshotPage>(
      "/api/v1/sync/snapshots",
      "POST",
      null,
    );
    const id = page.snapshot_id;
    const snapshot: Snapshot = {
      protocol_version: 1,
      rooms: [],
      messages: [],
      cursor: "",
    };
    const seen = new Set<string>(),
      rooms = new Set<string>(),
      messages = new Set<string>();
    let size = 0;
    for (let index = 0; index < 128; index++) {
      size += JSON.stringify(page).length;
      if (
        page.protocol_version !== 1 ||
        !id ||
        page.snapshot_id !== id ||
        page.page_index !== index ||
        size > 64 * 1024 * 1024
      )
        throw new Error("Invalid snapshot");
      for (const room of page.rooms) {
        if (rooms.has(room.id)) throw new Error("Duplicate room");
        rooms.add(room.id);
      }
      for (const message of page.messages) {
        if (messages.has(message.id)) throw new Error("Duplicate message");
        messages.add(message.id);
      }
      snapshot.rooms.push(...page.rooms);
      snapshot.messages.push(...page.messages);
      if (!page.next && page.cursor) {
        snapshot.cursor = page.cursor;
        return snapshot;
      }
      if (
        !page.next ||
        page.cursor ||
        seen.has(page.next) ||
        !/^[a-zA-Z0-9_-]+$/.test(page.next)
      )
        throw new Error("Invalid page");
      seen.add(page.next);
      page = await this.request("/api/v1/sync/snapshots/" + page.next);
    }
    throw new Error("Snapshot exceeds page limit");
  }
}
export const segment = (value: string): string => encodeURIComponent(value);
export const operation = (): string => crypto.randomUUID().replaceAll("-", "");
export const secret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
