//! Public delivery metadata. Opaque values are base64url without padding.
//! No recovery secret, private key, or MLS sending state enters these DTOs.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub instance_id: String,
    pub data_epoch: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegisterDevice {
    pub scope: Scope,
    pub operation_id: String,
    pub expected_root_fingerprint: Option<String>,
    pub expected_device_revision: Option<String>,
    pub request: String,
    pub grant: String,
    /// Root-signed revocation of the previous incarnation, on replacement only.
    pub revoke_previous: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RevokeDevice {
    pub scope: Scope,
    pub operation_id: String,
    /// Exact registered revision and incarnation of the sending controller.
    pub device_revision: String,
    pub incarnation: String,
    /// Root-signed target device/incarnation; contains no secret material.
    pub signed: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishKeyPackages {
    pub scope: Scope,
    pub operation_id: String,
    pub device_revision: String,
    pub packages: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishRootBackup {
    pub scope: Scope,
    pub operation_id: String,
    pub publication: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RootBackupReceipt {
    pub scope: Scope,
    pub operation_id: String,
    pub device_id: String,
    pub incarnation: String,
    pub device_revision: String,
    pub root_fingerprint: String,
    pub backup_id: String,
    pub backup_revision: String,
    pub packet_digest: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RootBackupCancellation {
    pub scope: Scope,
    pub operation_id: String,
    pub device_id: String,
    pub incarnation: String,
    pub device_revision: String,
    pub root_fingerprint: String,
    pub backup_id: String,
    pub expected_revision: Option<String>,
    pub packet_digest: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum RootBackupSettlement {
    Accepted(RootBackupReceipt),
    Cancelled(RootBackupCancellation),
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RootBackupVersion {
    pub publication: String,
    pub receipt: RootBackupReceipt,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RootBackupState {
    pub scope: Scope,
    pub active: Option<RootBackupVersion>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub user_id: String,
    pub root: String,
    pub fingerprint: String,
    pub revision: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub device_id: String,
    pub incarnation: String,
    pub certificate: String,
    pub revision: String,
    pub expires_at: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Revocation {
    pub position: String,
    pub signed: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Directory {
    pub scope: Scope,
    pub identity: Option<Identity>,
    pub devices: Vec<Device>,
    pub revocations: Vec<Revocation>,
    pub next_revocation: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OperationReceipt {
    pub scope: Scope,
    pub operation_id: String,
    pub kind: String,
    pub device_id: String,
    pub incarnation: String,
    pub device_revision: String,
    pub root_fingerprint: String,
    pub key_package_refs: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupWelcome {
    pub device_id: String,
    pub incarnation: String,
    pub key_package_ref: String,
    pub payload: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupSubmission {
    pub scope: Scope,
    pub operation_id: String,
    pub transition: String,
    pub commit: Option<String>,
    pub tree: String,
    pub welcomes: Vec<GroupWelcome>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupReceipt {
    pub scope: Scope,
    pub room_id: String,
    pub incarnation: String,
    pub operation_id: String,
    pub revision: String,
    pub epoch: String,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupCancellation {
    pub scope: Scope,
    pub room_id: String,
    pub incarnation: String,
    pub operation_id: String,
    pub device_id: String,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum GroupSettlement {
    Accepted(GroupReceipt),
    Cancelled(GroupCancellation),
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupMember {
    pub user_id: String,
    pub access_version: String,
    pub activation_version: String,
}
/// Current room authority/grants, independent from a submitted signed plan.
/// This is an observation: transition acceptance revalidates every version.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupRoster {
    pub scope: Scope,
    pub room_id: String,
    pub authority_version: String,
    pub members: Vec<GroupMember>,
    /// Public head metadata only; never a Welcome or private MLS material.
    pub group: Option<GroupReceipt>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupState {
    pub receipt: GroupReceipt,
    pub needs_rekey: bool,
    pub transition: String,
    pub tree: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupEvent {
    pub receipt: GroupReceipt,
    pub transition: String,
    pub commit: Option<String>,
    /// Present only for this device's incarnation and current membership grant.
    pub welcome: Option<GroupWelcome>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GroupEventPage {
    pub events: Vec<GroupEvent>,
    pub next: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AvailableKeyPackage {
    pub scope: Scope,
    pub user_id: String,
    pub device_id: String,
    pub incarnation: String,
    pub reference: String,
    pub wire: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationSubmission {
    pub scope: Scope,
    pub operation_id: String,
    pub proof: String,
    pub ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationReceipt {
    pub scope: Scope,
    pub room_id: String,
    pub operation_id: String,
    /// Canonical public Header JSON, base64url. Its u64 fields stay opaque to JS.
    pub header: String,
    pub fingerprint: String,
    pub message_id: String,
    pub position: String,
}
/// Durable personal abandonment of the exact original opaque intention.
/// No message ID/position: this is not a delivered message or a room event.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationCancellation {
    pub scope: Scope,
    pub room_id: String,
    pub operation_id: String,
    pub header: String,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ApplicationSettlement {
    Accepted(ApplicationReceipt),
    Cancelled(ApplicationCancellation),
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ApplicationMessage {
    pub receipt: ApplicationReceipt,
    pub proof: String,
    pub ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum DeliveryContent {
    Group(GroupEvent),
    Message(ApplicationMessage),
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeliveryEvent {
    pub position: String,
    pub content: DeliveryContent,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DeliveryPage {
    pub scope: Scope,
    pub room_id: String,
    pub incarnation: String,
    pub after: String,
    /// Fixed native position watermark; continue subsequent pages through it.
    pub through: String,
    pub events: Vec<DeliveryEvent>,
    pub next: Option<String>,
}

/// A new device's signed history request (E2EE_HISTORY.md). The share and its
/// records are named by the request fingerprint.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PublishHistoryRequest {
    pub scope: Scope,
    pub request: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryRequestEntry {
    /// Lowercase hex request fingerprint.
    pub fingerprint: String,
    pub device_id: String,
    pub request: String,
    pub expires_at: String,
    /// Device that claimed the share by uploading its first page.
    pub sharer_device_id: Option<String>,
    pub committed: bool,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryRequests {
    pub scope: Scope,
    pub requests: Vec<HistoryRequestEntry>,
}
/// Records of ranks `start + 1 ..= start + records.len()` of one manifest
/// entry: at most 200 records and 4 MiB.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UploadHistoryRecords {
    pub scope: Scope,
    pub period: u32,
    pub start: String,
    pub records: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryRecordsReceipt {
    pub period: u32,
    /// Records the server now holds for this entry.
    pub count: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CommitHistoryShare {
    pub scope: Scope,
    pub share: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryShareState {
    pub scope: Scope,
    pub fingerprint: String,
    pub sharer_device_id: String,
    pub share: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryRecordsPage {
    pub period: u32,
    pub start: String,
    pub records: Vec<String>,
    /// Start of the next page, or none at the end of the entry.
    pub next: Option<String>,
}
