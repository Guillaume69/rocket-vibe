// The generated native orchestration recognizes the same typed HTTP refusals.
export { ApiError as NativeError } from "../api";
import { Api, ApiError, segment } from "../api";
import type { NativeTypes } from "../protocol";
import { decodeNative } from "./shared/validation";
export class CryptoTransport {
  constructor(readonly api: Api) {}
  cryptoGroupRoster(room: string): Promise<NativeTypes["GroupRoster"]> {
    return this.request(
      "GroupRoster",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/roster`,
    );
  }
  submitCryptoGroup(
    room: string,
    input: NativeTypes["GroupSubmission"],
  ): Promise<NativeTypes["GroupReceipt"]> {
    return this.request(
      "GroupReceipt",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/transitions`,
      input,
    );
  }
  cryptoGroupState(room: string): Promise<NativeTypes["GroupState"]> {
    return this.request(
      "GroupState",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/state`,
    );
  }
  cryptoGroupEvents(
    room: string,
    after: string,
  ): Promise<NativeTypes["GroupEventPage"]> {
    return this.request(
      "GroupEventPage",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/events?after=${encodeURIComponent(after)}`,
    );
  }
  cryptoGroupOperation(
    room: string,
    operation: string,
  ): Promise<NativeTypes["GroupReceipt"]> {
    return this.request(
      "GroupReceipt",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/operations/${encodeURIComponent(operation)}`,
    );
  }
  cancelCryptoGroup(
    room: string,
    input: NativeTypes["GroupSubmission"],
  ): Promise<NativeTypes["GroupSettlement"]> {
    return this.request(
      "GroupSettlement",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/operations/${encodeURIComponent(input.operation_id)}/cancel`,
      input,
    );
  }
  submitCryptoMessage(
    room: string,
    input: NativeTypes["ApplicationSubmission"],
  ): Promise<NativeTypes["ApplicationReceipt"]> {
    return this.request(
      "ApplicationReceipt",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/messages`,
      input,
    );
  }
  cryptoMessageOperation(
    room: string,
    operation: string,
  ): Promise<NativeTypes["ApplicationReceipt"]> {
    return this.request(
      "ApplicationReceipt",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/message-operations/${encodeURIComponent(operation)}`,
    );
  }
  cancelCryptoMessage(
    room: string,
    input: NativeTypes["ApplicationSubmission"],
  ): Promise<NativeTypes["ApplicationSettlement"]> {
    return this.request(
      "ApplicationSettlement",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/message-operations/${encodeURIComponent(input.operation_id)}/cancel`,
      input,
    );
  }
  /** Opaque delivery only. The native crypto engine validates and opens each frame. */
  async cryptoDelivery(
    room: string,
    after: string,
    through?: string,
  ): Promise<NativeTypes["DeliveryPage"]> {
    for (const position of [
      after,
      ...(through === undefined ? [] : [through]),
    ]) {
      if (
        !/^(0|[1-9][0-9]{0,18})$/.test(position) ||
        BigInt(position) > 9223372036854775807n
      )
        throw new ApiError(400, "invalid_request");
    }
    return this.request(
      "DeliveryPage",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/delivery?after=${after}${through === undefined ? "" : `&through=${through}`}`,
    );
  }
  availableCryptoKeyPackage(
    room: string,
    user: string,
    device: string,
  ): Promise<NativeTypes["AvailableKeyPackage"]> {
    return this.request(
      "AvailableKeyPackage",
      `/api/v1/e2ee/rooms/${encodeURIComponent(room)}/key-packages/${encodeURIComponent(user)}/${encodeURIComponent(device)}`,
    );
  }
  registerCryptoDevice(
    input: NativeTypes["RegisterDevice"],
  ): Promise<NativeTypes["OperationReceipt"]> {
    return this.request("OperationReceipt", "/api/v1/e2ee/devices", input);
  }
  revokeCryptoDevice(
    input: NativeTypes["RevokeDevice"],
  ): Promise<NativeTypes["OperationReceipt"]> {
    return this.request("OperationReceipt", "/api/v1/e2ee/revocations", input);
  }
  /** Encrypted root only. Recovery codes stay inside the explicit native ceremony. */
  cryptoRootBackup(): Promise<NativeTypes["RootBackupState"]> {
    return this.request("RootBackupState", "/api/v1/e2ee/root-backup");
  }
  publishCryptoRootBackup(
    input: NativeTypes["PublishRootBackup"],
  ): Promise<NativeTypes["RootBackupReceipt"]> {
    return this.request("RootBackupReceipt", "/api/v1/e2ee/root-backup", input);
  }
  cryptoRootBackupOperation(
    operation: string,
  ): Promise<NativeTypes["RootBackupReceipt"]> {
    return this.request(
      "RootBackupReceipt",
      `/api/v1/e2ee/root-backup/operations/${encodeURIComponent(operation)}`,
    );
  }
  cancelCryptoRootBackup(
    input: NativeTypes["PublishRootBackup"],
  ): Promise<NativeTypes["RootBackupSettlement"]> {
    return this.request(
      "RootBackupSettlement",
      `/api/v1/e2ee/root-backup/operations/${encodeURIComponent(input.operation_id)}/cancel`,
      input,
    );
  }
  /** History backup: the key package sealed under the history code and signed records. */
  cryptoHistoryKey(): Promise<NativeTypes["HistoryKeyState"]> {
    return this.request("HistoryKeyState", "/api/v1/e2ee/history-backup");
  }
  publishCryptoHistoryKey(
    input: NativeTypes["PublishHistoryKey"],
  ): Promise<NativeTypes["HistoryKeyReceipt"]> {
    return this.request(
      "HistoryKeyReceipt",
      "/api/v1/e2ee/history-backup",
      input,
    );
  }
  cryptoHistoryKeyOperation(
    operation: string,
  ): Promise<NativeTypes["HistoryKeyReceipt"]> {
    return this.request(
      "HistoryKeyReceipt",
      `/api/v1/e2ee/history-backup/operations/${encodeURIComponent(operation)}`,
    );
  }
  cancelCryptoHistoryKey(
    input: NativeTypes["PublishHistoryKey"],
  ): Promise<NativeTypes["HistoryKeySettlement"]> {
    return this.request(
      "HistoryKeySettlement",
      `/api/v1/e2ee/history-backup/operations/${encodeURIComponent(input.operation_id)}/cancel`,
      input,
    );
  }
  cryptoHistoryBackupPeriods(
    generation: string,
    after?: string,
  ): Promise<NativeTypes["HistoryBackupPeriods"]> {
    if (
      !/^[0-9a-f]{32}$/.test(generation) ||
      (after !== undefined && !/^[0-9a-f]{64}$/.test(after))
    )
      throw new ApiError(400, "invalid_request");
    return this.request(
      "HistoryBackupPeriods",
      `/api/v1/e2ee/history-backup/periods?generation=${generation}${after === undefined ? "" : `&after=${after}`}`,
    );
  }
  uploadCryptoHistoryBackup(
    period: string,
    input: NativeTypes["UploadHistoryBackup"],
  ): Promise<NativeTypes["HistoryBackupReceipt"]> {
    return this.request(
      "HistoryBackupReceipt",
      `/api/v1/e2ee/history-backup/periods/${historyRequest(period)}/records`,
      input,
      false,
      undefined,
      "PUT",
    );
  }
  cryptoHistoryBackupRecords(
    period: string,
    after: string,
  ): Promise<NativeTypes["HistoryBackupPage"]> {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(after))
      throw new ApiError(400, "invalid_request");
    return this.request(
      "HistoryBackupPage",
      `/api/v1/e2ee/history-backup/periods/${historyRequest(period)}/records?after=${after}`,
    );
  }
  /** History shares between devices of the account: signed opaque bytes only. */
  publishCryptoHistoryRequest(
    input: NativeTypes["PublishHistoryRequest"],
  ): Promise<NativeTypes["HistoryRequestEntry"]> {
    return this.request(
      "HistoryRequestEntry",
      "/api/v1/e2ee/history/requests",
      input,
    );
  }
  cryptoHistoryRequests(): Promise<NativeTypes["HistoryRequests"]> {
    return this.request("HistoryRequests", "/api/v1/e2ee/history/requests");
  }
  uploadCryptoHistoryRecords(
    request: string,
    input: NativeTypes["UploadHistoryRecords"],
  ): Promise<NativeTypes["HistoryRecordsReceipt"]> {
    return this.request(
      "HistoryRecordsReceipt",
      `/api/v1/e2ee/history/requests/${historyRequest(request)}/records`,
      input,
      false,
      undefined,
      "PUT",
    );
  }
  commitCryptoHistoryShare(
    request: string,
    input: NativeTypes["CommitHistoryShare"],
  ): Promise<NativeTypes["HistoryShareState"]> {
    return this.request(
      "HistoryShareState",
      `/api/v1/e2ee/history/requests/${historyRequest(request)}/share`,
      input,
    );
  }
  cryptoHistoryShare(
    request: string,
  ): Promise<NativeTypes["HistoryShareState"]> {
    return this.request(
      "HistoryShareState",
      `/api/v1/e2ee/history/requests/${historyRequest(request)}/share`,
    );
  }
  cryptoHistoryRecords(
    request: string,
    period: number,
    after: string,
  ): Promise<NativeTypes["HistoryRecordsPage"]> {
    if (
      !Number.isInteger(period) ||
      period < 0 ||
      period >= 1024 ||
      !/^(0|[1-9][0-9]{0,18})$/.test(after)
    )
      throw new ApiError(400, "invalid_request");
    return this.request(
      "HistoryRecordsPage",
      `/api/v1/e2ee/history/requests/${historyRequest(request)}/records?period=${period}&after=${after}`,
    );
  }
  async acknowledgeCryptoHistory(request: string): Promise<void> {
    await this.value(
      `/api/v1/e2ee/history/requests/${historyRequest(request)}/ack`,
      {},
    );
  }
  publishKeyPackages(
    input: NativeTypes["PublishKeyPackages"],
  ): Promise<NativeTypes["OperationReceipt"]> {
    return this.request("OperationReceipt", "/api/v1/e2ee/key-packages", input);
  }
  /** Transport only: the Rust engine checks signatures, scope, pins and consent. */
  cryptoDirectory(
    user: string,
    after?: string,
  ): Promise<NativeTypes["Directory"]> {
    return this.request(
      "Directory",
      `/api/v1/e2ee/users/${encodeURIComponent(user)}${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`,
    );
  }
  cryptoOperation(operation: string): Promise<NativeTypes["OperationReceipt"]> {
    return this.request(
      "OperationReceipt",
      `/api/v1/e2ee/operations/${encodeURIComponent(operation)}`,
    );
  }

  async request<K extends keyof NativeTypes>(
    name: K,
    path: string,
    input?: unknown,
    _anonymous = false,
    _signal?: unknown,
    method = input === undefined ? "GET" : "POST",
  ): Promise<NativeTypes[K]> {
    try {
      return decodeNative(name, await this.api.request(path, method, input));
    } catch (error) {
      if (error instanceof TypeError) throw new ApiError(0, "network_error");
      throw error;
    }
  }
  async value(path: string, input?: unknown): Promise<unknown> {
    return this.api.request(path, input === undefined ? "GET" : "POST", input);
  }
}
export function historyRequest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw Error("invalid_request");
  return value;
}
export { segment };
