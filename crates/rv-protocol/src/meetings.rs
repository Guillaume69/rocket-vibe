//! Room-authorized meetings. Shared links never contain participant tokens.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StartMeeting {
    pub operation_id: String,
    pub membership_version: String,
    pub data_epoch: String,
}

#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct JoinMeeting {
    pub membership_version: String,
    pub data_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct Meeting {
    pub id: String,
    pub room_id: String,
    pub public_url: String,
    pub created_by: String,
    pub expires_at: String,
    pub ended: bool,
}

// No Debug: the private URL contains the participant JWT.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
pub struct MeetingJoin {
    pub meeting: Meeting,
    pub url: String,
    pub expires_at: String,
}
