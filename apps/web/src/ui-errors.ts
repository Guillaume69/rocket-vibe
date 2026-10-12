import { nt } from "./native-i18n.ts";
import catalog from "./native-strings.generated.json" with { type: "json" };
import errors from "./native-errors.generated.json" with { type: "json" };

export type ErrorArea = "bots" | "workflows" | "admin" | "commands";
const words = catalog as Record<string, string[]>;
const mappings = errors as Record<string, Record<string, string>>;
const lookup = (area: string, code: string) =>
  Object.hasOwn(mappings[area] ?? {}, code) ? mappings[area][code] : undefined;
export const untrustedGroupError = (code: string) =>
  [
    "crypto_peer_untrusted",
    "crypto_identity_untrusted",
    "crypto_device_unapproved",
    "crypto_device_revoked",
    "crypto_identity_changed",
    "crypto_identity_expired",
  ].includes(code);

/** Technical codes remain on the original error; only this boundary chooses UI copy. */
export function apiErrorKey(
  code: string,
  status: number,
  area?: ErrorArea,
): string {
  const mapped = area && lookup(area, code);
  if (mapped) return mapped;
  if (area === "admin")
    return code.startsWith("error-") ? "admin.error_denied" : "admin.failed";
  if (area === "bots")
    return status === 429 ? "bots.error_rate_limited" : "bots.failed";
  if (area === "workflows")
    return status === 429 ? "bots.error_rate_limited" : "workflows.failed";
  if (area === "commands") return lookup("native", code) ?? "native.error";
  if (untrustedGroupError(code)) return "crypto.group_untrusted";
  if (code === "crypto_bot_member" || code === "bot_encrypted_room")
    return lookup("bots", code)!;
  if (code.startsWith("crypto_") || code.startsWith("encrypted_file_"))
    return "crypto.failed";
  if (code === "reauthentication_required") return "devices.reauth";
  if (
    code.startsWith("security_") ||
    code === "credentials_changed" ||
    code === "authentication_view_closed"
  )
    return "security.failed";
  if (code === "download_failed") return "file.failed";
  return lookup("native", code) ?? "native.error";
}

export function errorMessage(
  error: unknown,
  fallback = "native.error",
): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const status =
      "status" in error && typeof error.status === "number" ? error.status : 0;
    const area =
      "area" in error && typeof error.area === "string"
        ? (error.area as ErrorArea)
        : undefined;
    return nt(apiErrorKey(error.code, status, area));
  }
  if (
    error instanceof TypeError ||
    (error instanceof Error &&
      ["TimeoutError", "NetworkError"].includes(error.name))
  )
    return nt("native.offline");
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (Object.hasOwn(words, message)) return nt(message);
  const translated = Object.entries(words).find(([, values]) =>
    values.includes(message),
  );
  if (translated) return nt(translated[0]);
  if (
    lookup("native", message) ||
    message.startsWith("crypto_") ||
    message.startsWith("security_") ||
    untrustedGroupError(message)
  )
    return nt(apiErrorKey(message, 0));
  // Literal strings are also used for success toasts. A machine identifier never is.
  if (
    typeof error === "string" &&
    message &&
    !/^[A-Za-z0-9_.:-]+$/.test(message)
  )
    return message;
  return nt(fallback);
}
