import { ApiError, operation, secret } from "./api";
import type {
  AuthChallenge,
  FactorEmailDelivery,
  RequestFactorEmail,
  SecondFactor,
  Session,
} from "./protocol";

export interface FactorAuthIntent {
  finish?: { operation_id: string; next_token: string };
  email?: { input: RequestFactorEmail; status?: FactorEmailDelivery };
}
export interface FactorAuthRemote {
  request<T>(path: string, input: unknown): Promise<T>;
  read(): Promise<FactorAuthIntent | undefined>;
  save(value: FactorAuthIntent): Promise<void>;
}
const nonce = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: unknown,
  allowed: string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));

export function factorAuthIntent(
  value: unknown,
  challenge: AuthChallenge,
): FactorAuthIntent {
  if (!exact(value, ["finish", "email"]))
    throw Error("invalid_native_authentication");
  if (value.finish !== undefined) {
    if (
      !exact(value.finish, ["operation_id", "next_token"]) ||
      typeof value.finish.operation_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.finish.operation_id) ||
      !nonce(value.finish.next_token)
    )
      throw Error("invalid_native_authentication");
  }
  if (value.email !== undefined) {
    const email = value.email;
    if (
      !exact(email, ["input", "status"]) ||
      !exact(email.input, ["challenge_id", "delivery_id", "operation_id"]) ||
      !challenge.methods.includes("email") ||
      email.input.challenge_id !== challenge.challenge_id ||
      !nonce(email.input.challenge_id) ||
      !nonce(email.input.delivery_id) ||
      !nonce(email.input.operation_id) ||
      new Set(Object.values(email.input)).size !== 3
    )
      throw Error("invalid_native_authentication");
    if (email.status !== undefined) {
      if (
        !exact(email.status, ["expires_at", "delivery", "resend_after_seconds"])
      )
        throw Error("invalid_native_authentication");
      factorDelivery(email.status, challenge);
    }
  }
  return value as FactorAuthIntent;
}
export function factorDelivery(
  value: unknown,
  challenge: AuthChallenge,
): FactorEmailDelivery {
  if (
    !record(value) ||
    !["queued", "sending", "deferred", "accepted", "exhausted"].includes(
      String(value.delivery),
    ) ||
    !Number.isFinite(Date.parse(String(value.expires_at))) ||
    Date.parse(String(value.expires_at)) !== Date.parse(challenge.expires_at) ||
    typeof value.resend_after_seconds !== "number" ||
    !Number.isInteger(value.resend_after_seconds) ||
    value.resend_after_seconds < 0 ||
    value.resend_after_seconds > 60
  )
    throw Error("invalid_native_authentication");
  return {
    delivery: value.delivery as FactorEmailDelivery["delivery"],
    expires_at: String(value.expires_at),
    resend_after_seconds: value.resend_after_seconds,
  };
}
export function factorErrorKey(error: unknown): string | undefined {
  if (error instanceof TypeError) return "login.unreachable";
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "login.unreachable";
  if (error instanceof Error && error.message === "crypto_storage_unavailable")
    return "login.secure_storage";
  if (!(error instanceof ApiError)) return;
  if (error.code === "factor_rejected" || error.code === "invalid_factor_code")
    return "login.bad_code";
  if (error.code === "factor_expired") return "login.factor_expired";
  if (error.code === "factor_unavailable") return "login.factor_unavailable";
  if (error.code === "secure_storage_unavailable")
    return "login.secure_storage";
  if (error.status === 401) return "login.bad_code";
  if (error.status === 429) return "login.too_many";
  if (error.status === 0) return "login.unreachable";
}

/** Login errors use GTK's known captions; unknown technical strings stay out of the form. */
export function loginErrorKey(
  error: unknown,
  mode: "login" | "signup" | "recovery",
  discovering = false,
): string {
  if (error instanceof TypeError) return "login.unreachable";
  if (error instanceof DOMException && error.name === "TimeoutError")
    return "login.unreachable";
  if (error instanceof ApiError) {
    if (error.code === "invalid_request")
      return mode === "recovery"
        ? "login.recovery_help"
        : "login.invitation_help";
    const codes: Record<string, string> = {
      not_native: "login.not_rocketvibe",
      factor_rejected: "login.bad_code",
      invalid_factor_code: "login.bad_code",
      factor_expired: "login.factor_expired",
      factor_unavailable: "login.factor_unavailable",
      secure_storage_unavailable: "login.secure_storage",
      recovery_rejected: "login.recovery_rejected",
      invitation_rejected: "login.invitation_rejected",
    };
    if (Object.hasOwn(codes, error.code)) return codes[error.code];
    if (error.status === 0) return "login.unreachable";
    if (error.status === 429) return "login.too_many";
    if (error.status === 401) return "login.rejected";
  }
  if (discovering) return "login.probe_failed";
  if (mode === "recovery") return "login.recovery_help";
  if (mode === "signup") return "login.invitation_help";
  return "login.rejected";
}

/** The saved operation is written before verification; blank code can recover its receipt. */
export async function finishFactorAuth(
  challenge: AuthChallenge,
  method: SecondFactor,
  code: string,
  remote: FactorAuthRemote,
): Promise<Session> {
  const intent = factorAuthIntent((await remote.read()) ?? {}, challenge);
  if (!intent.finish) {
    intent.finish = { operation_id: operation(), next_token: secret() };
    await remote.save(intent);
  }
  return remote.request<Session>("/api/v1/auth/factors/verify", {
    ...intent.finish,
    challenge_id: challenge.challenge_id,
    method,
    code,
  });
}

/** Native explicit Send/Resume/Resend: always resolve the original delivery first. */
export async function sendFactorAuthEmail(
  challenge: AuthChallenge,
  resend: boolean,
  remote: FactorAuthRemote,
): Promise<FactorAuthIntent> {
  const intent = factorAuthIntent((await remote.read()) ?? {}, challenge);
  if (!challenge.methods.includes("email"))
    throw new ApiError(400, "factor_unavailable", 0);
  if (resend && !intent.email?.status) throw Error("credentials_changed");
  if (intent.email) {
    try {
      intent.email.status = factorDelivery(
        await remote.request(
          "/api/v1/auth/factors/email/resume",
          intent.email.input,
        ),
        challenge,
      );
      await remote.save(intent);
      if (!resend) return intent;
      if (intent.email.status.resend_after_seconds > 0)
        throw new ApiError(
          429,
          "email_resend_cooldown",
          intent.email.status.resend_after_seconds,
        );
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === "factor_rejected" &&
        !resend
      ))
        throw error;
    }
  }
  if (!intent.email || resend) {
    intent.email = {
      input: {
        challenge_id: challenge.challenge_id,
        operation_id: secret(),
        delivery_id: secret(),
      },
    };
    await remote.save(intent);
  }
  intent.email.status = factorDelivery(
    await remote.request(
      "/api/v1/auth/factors/email/start",
      intent.email.input,
    ),
    challenge,
  );
  await remote.save(intent);
  return intent;
}
