import type {
  ChangeEmailFactor,
  FactorBackupCodes,
  FactorSetup,
  FactorStatus,
} from "./protocol.ts";

export type FactorIntent =
  | {
      kind: "setup";
      operation_id: string;
      setup?: FactorSetup;
      enable_operation_id?: string;
    }
  | {
      kind: "regenerate";
      operation_id: string;
      factor_version: string;
    }
  | {
      kind: "disable";
      operation_id: string;
      factor_version: string;
    }
  | { kind: "email"; enabled: boolean; input: ChangeEmailFactor }
  | { kind: "legacy-email"; input: ChangeEmailFactor }
  | { kind: "codes"; operation_id: string; codes: FactorBackupCodes };
export type FactorView =
  | { kind: "idle" }
  | {
      kind: "setup";
      intent: Extract<FactorIntent, { kind: "setup" }>;
      setup: FactorSetup;
    }
  | { kind: "codes"; intent: Extract<FactorIntent, { kind: "codes" }> }
  | { kind: "pending" | "stale"; intent: FactorIntent };
export interface FactorRemote {
  status(): Promise<FactorStatus>;
  request<T>(path: string, input: unknown): Promise<T>;
  save(intent?: FactorIntent): Promise<void>;
}
export function proofNeeded(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 403 &&
    "code" in error &&
    error.code === "reauthentication_required"
  );
}
function rejection(error: unknown, status: number, code?: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === status &&
    (!code || ("code" in error && error.code === code))
  );
}
export function factorOperation(intent: FactorIntent): string {
  return intent.kind === "email" || intent.kind === "legacy-email"
    ? intent.input.operation_id
    : intent.operation_id;
}
async function receivedCodes(
  remote: FactorRemote,
  operation_id: string,
  codes: FactorBackupCodes,
): Promise<FactorView> {
  if (
    !codes.factor_version ||
    codes.codes.length !== 10 ||
    codes.codes.some((code) => !code || code.length > 128)
  )
    throw Error("security_receipt_invalid");
  const intent: Extract<FactorIntent, { kind: "codes" }> = {
    kind: "codes",
    operation_id,
    codes,
  };
  await remote.save(intent);
  return (await remote.status()).factor_version === codes.factor_version
    ? { kind: "codes", intent }
    : { kind: "stale", intent };
}
/** Replay the saved request before proof: accepted receipts remain recoverable. */
export async function recoverFactor(
  intent: FactorIntent | undefined,
  remote: FactorRemote,
): Promise<FactorView> {
  if (!intent) return { kind: "idle" };
  const status = await remote.status();
  // Older web receipts did not record enable/disable; never guess from live status.
  if (intent.kind === "legacy-email") return { kind: "stale", intent };
  if (intent.kind === "codes")
    return status.factor_version === intent.codes.factor_version
      ? { kind: "codes", intent }
      : { kind: "stale", intent };
  try {
    if (intent.kind === "setup") {
      if (status.totp) {
        if (!intent.setup || !intent.enable_operation_id)
          return { kind: "stale", intent };
        return await receivedCodes(
          remote,
          intent.enable_operation_id,
          await remote.request<FactorBackupCodes>(
            "/api/v1/me/factors/totp/enable",
            {
              operation_id: intent.enable_operation_id,
              setup_id: intent.setup.setup_id,
              code: "",
            },
          ),
        );
      }
      const setup = await remote.request<FactorSetup>(
        "/api/v1/me/factors/totp/setup",
        { operation_id: intent.operation_id },
      );
      const updated = {
        ...intent,
        setup,
        enable_operation_id:
          intent.setup?.setup_id === setup.setup_id
            ? intent.enable_operation_id
            : undefined,
      };
      await remote.save(updated);
      return { kind: "setup", intent: updated, setup };
    }
    if (intent.kind === "disable") {
      if (status.totp) {
        if (status.factor_version !== intent.factor_version)
          return { kind: "stale", intent };
        await remote.request("/api/v1/me/factors/totp/disable", {
          factor_version: intent.factor_version,
        });
      }
      await remote.save();
      return { kind: "idle" };
    }
    if (intent.kind === "regenerate")
      return await receivedCodes(
        remote,
        intent.operation_id,
        await remote.request<FactorBackupCodes>(
          "/api/v1/me/factors/recovery/regenerate",
          {
            operation_id: intent.operation_id,
            factor_version: intent.factor_version,
          },
        ),
      );
    const receipt = await remote.request<
      import("./protocol.ts").EmailFactorChange
    >(
      "/api/v1/me/factors/email/" + (intent.enabled ? "enable" : "disable"),
      intent.input,
    );
    if (
      receipt.enabled !== intent.enabled ||
      receipt.email_version !== intent.input.email_version ||
      !receipt.factor_version ||
      receipt.codes.length !== (intent.enabled ? 10 : 0) ||
      JSON.stringify(receipt.context) !== JSON.stringify(intent.input.context)
    )
      throw Error("security_receipt_invalid");
    if (intent.enabled)
      return await receivedCodes(remote, intent.input.operation_id, {
        codes: receipt.codes,
        factor_version: receipt.factor_version,
      });
    const fresh = await remote.status();
    if (
      fresh.email ||
      (fresh.factor_version && fresh.factor_version !== receipt.factor_version)
    )
      return { kind: "stale", intent };
    await remote.save();
    return { kind: "idle" };
  } catch (error) {
    if (proofNeeded(error)) return { kind: "pending", intent };
    if (intent.kind === "email" && rejection(error, 409))
      return { kind: "stale", intent };
    if (intent.kind === "regenerate" && rejection(error, 409)) {
      if ((await remote.status()).factor_version !== intent.factor_version)
        return { kind: "stale", intent };
      throw Error("credentials_changed");
    }
    if (
      intent.kind === "setup" &&
      status.totp &&
      rejection(error, 400, "factor_rejected")
    )
      return { kind: "stale", intent };
    throw error;
  }
}
export async function enableFactor(
  intent: Extract<FactorIntent, { kind: "setup" }>,
  code: string,
  operation_id: string,
  remote: FactorRemote,
): Promise<FactorView> {
  if (!intent.setup) throw Error("security_receipt_invalid");
  const saved = {
    ...intent,
    enable_operation_id: intent.enable_operation_id || operation_id,
  };
  await remote.save(saved);
  try {
    return await receivedCodes(
      remote,
      saved.enable_operation_id,
      await remote.request<FactorBackupCodes>(
        "/api/v1/me/factors/totp/enable",
        {
          operation_id: saved.enable_operation_id,
          setup_id: intent.setup.setup_id,
          code,
        },
      ),
    );
  } catch (error) {
    if (proofNeeded(error)) return { kind: "pending", intent: saved };
    throw error;
  }
}
