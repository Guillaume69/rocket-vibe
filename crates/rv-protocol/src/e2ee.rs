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
pub struct PublishKeyPackages {
    pub scope: Scope,
    pub operation_id: String,
    pub device_revision: String,
    pub packages: Vec<String>,
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
