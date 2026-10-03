//! Android FCM registration and authenticated content retrieval. Push data only
//! identifies a notification; the normal private message API supplies content.
use crate::{Message, Room};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegisterPush {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PushRegistration {
    pub device_id: String,
    pub instance_id: String,
    pub data_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PushContent {
    pub notification_id: String,
    pub device_id: String,
    pub instance_id: String,
    pub data_epoch: String,
    pub room: Room,
    pub message: Message,
}
