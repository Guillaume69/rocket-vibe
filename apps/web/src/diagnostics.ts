/**
 * Diagnostics: the browser's stand-in for the desktop's logs folder
 * (`rv-gtk/src/crashlog.rs`). A browser has no folder to open, so the app
 * keeps a small ring of its recent client-side events in memory (errors it
 * reported, uncaught errors, connection state changes, sign-out replays) and
 * Settings > App downloads them as a text file to send to a developer.
 *
 * Never recorded: tokens, message text, names or any other personal data.
 * An API error keeps only its status and code; any other error its type and
 * a message stripped of long opaque strings, addresses, URLs' queries and
 * anything past 200 characters. Strings shown to the user are not recorded.
 */
import { ApiError } from "./api.ts";

export interface DiagnosticEntry {
  at: string;
  kind: "error" | "connection" | "event";
  text: string;
}

/** The entries kept: the oldest goes when a new one arrives. */
export const DIAGNOSTICS_KEPT = 200;
const entries: DiagnosticEntry[] = [];

/**
 * Removes what could identify someone or open a session: long opaque runs
 * (tokens, ids, keys), email addresses, query strings and fragments.
 */
export function scrub(text: string): string {
  return text
    .replace(/"[^"]*"|'[^']*'|“[^”]*”|«[^»]*»/g, "[quoted]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[address]")
    .replace(/(\/[^\s?#]*)[?#]\S*/g, "$1")
    .replace(/[A-Za-z0-9_+=-]{20,}/g, "[opaque]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function note(kind: DiagnosticEntry["kind"], text: string): void {
  entries.push({ at: new Date().toISOString(), kind, text: scrub(text) });
  if (entries.length > DIAGNOSTICS_KEPT)
    entries.splice(0, entries.length - DIAGNOSTICS_KEPT);
}

/** Records an error the app reported (a toast); anything else is ignored. */
export function noteError(error: unknown): void {
  if (error instanceof ApiError)
    note("error", "ApiError " + error.status + " " + error.code);
  else if (error instanceof Error)
    note("error", error.name + ": " + error.message);
}

export function recent(): readonly DiagnosticEntry[] {
  return entries;
}

export function clearDiagnostics(): void {
  entries.length = 0;
}

/** The text file: the app and browser first, then the events, oldest first. */
export function diagnosticsText(context: {
  version: string;
  userAgent: string;
  language: string;
  online: boolean;
  connection: string;
  now?: Date;
}): string {
  return [
    "Vibez " + context.version,
    "Generated: " + (context.now ?? new Date()).toISOString(),
    "User agent: " + context.userAgent,
    "Language: " + context.language,
    "Browser online: " + String(context.online),
    "Connection: " + context.connection,
    "",
    ...entries.map((entry) => entry.at + " " + entry.kind + " " + entry.text),
    "",
  ].join("\n");
}

let installed = false;
/** Records uncaught errors and rejections from now on. Idempotent. */
export function installDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    const where = event.filename
      ? " at " +
        event.filename.replace(/^[a-z]+:\/\/[^/]+/i, "") +
        ":" +
        event.lineno +
        ":" +
        event.colno
      : "";
    note("error", "Uncaught " + (event.message || "error") + where);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof ApiError || reason instanceof Error) {
      noteError(reason);
      const last = entries.at(-1);
      if (last) last.text = scrub("Unhandled rejection: " + last.text);
    } else note("error", "Unhandled rejection");
  });
}

/** Saves the diagnostics as a text file through the browser's download. */
export function downloadDiagnostics(version: string, connection: string): void {
  const text = diagnosticsText({
    version,
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    connection,
  });
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download =
    "vibez-diagnostics-" +
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") +
    ".txt";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
