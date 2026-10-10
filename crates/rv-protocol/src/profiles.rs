//! Public profiles and private account preferences, independently versioned.
use crate::parity::{UserPreferences, UserProfile};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct OwnProfile {
    pub profile: UserProfile,
    pub preferences: UserPreferences,
    /// Verified contact, visible only to its owner. Changes use the email proof flow.
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateProfile {
    pub operation_id: String,
    pub expected_revision: String,
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub status: crate::live::PresenceStatus,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdatePreferences {
    pub operation_id: String,
    pub expected_revision: String,
    pub language: String,
    pub clock_24h: bool,
    pub push_enabled: bool,
    pub push_mentions_only: bool,
    pub desktop_notifications: DesktopNotifications,
    /// Absent: unchanged (a client that does not know the field keeps the
    /// schedule); `null`: removed.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "keep_or_set")]
    #[schemars(with = "Option<QuietHours>")]
    pub quiet_hours: Option<Option<QuietHours>>,
    /// Absent: unchanged; `null` or a past instant: not muted. RFC 3339, at most
    /// seven days ahead.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "keep_or_set")]
    #[schemars(with = "Option<String>")]
    pub muted_until: Option<Option<String>>,
    /// Absent: unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share_read_receipts: Option<bool>,
}

pub(crate) fn shared_by_default() -> bool {
    true
}

/// A daily quiet window in the account's own time zone (an IANA name, the
/// device's when the window was saved). Minutes since midnight; a window
/// across midnight has `start_minute > end_minute`; an empty one is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct QuietHours {
    pub start_minute: u16,
    pub end_minute: u16,
    pub time_zone: String,
}

impl QuietHours {
    /// Whether `minute` (since midnight, in the window's time zone) falls in it.
    pub fn covers(&self, minute: u16) -> bool {
        if self.start_minute < self.end_minute {
            minute >= self.start_minute && minute < self.end_minute
        } else {
            minute >= self.start_minute || minute < self.end_minute
        }
    }

    /// Both ends inside a day, distinct, and a time zone named.
    pub fn valid(&self) -> bool {
        self.start_minute < 1440
            && self.end_minute < 1440
            && self.start_minute != self.end_minute
            && !self.time_zone.is_empty()
            && self.time_zone.len() <= 64
    }
}

/// `Option<Option<T>>` where an absent field (the outer `None`) differs from
/// `null` (`Some(None)`).
mod keep_or_set {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[cfg(test)]
mod quiet_tests {
    use super::*;

    fn window(start: u16, end: u16) -> QuietHours {
        QuietHours {
            start_minute: start,
            end_minute: end,
            time_zone: "Europe/Paris".into(),
        }
    }

    #[test]
    fn a_window_within_a_day_and_one_across_midnight() {
        let day = window(9 * 60, 17 * 60);
        assert!(
            day.covers(9 * 60)
                && day.covers(16 * 60 + 59)
                && !day.covers(17 * 60)
                && !day.covers(8 * 60)
        );
        let night = window(22 * 60, 8 * 60);
        assert!(night.covers(23 * 60) && night.covers(0) && night.covers(7 * 60 + 59));
        assert!(!night.covers(8 * 60) && !night.covers(12 * 60) && !night.covers(21 * 60 + 59));
        assert!(!window(60, 60).valid() && !window(1440, 0).valid() && night.valid());
    }

    #[test]
    fn an_absent_field_keeps_and_null_removes() {
        let base = r#""operation_id":"o","expected_revision":"r","language":"auto","clock_24h":true,"push_enabled":true,"push_mentions_only":false,"desktop_notifications":"default""#;
        let kept: UpdatePreferences = serde_json::from_str(&format!("{{{base}}}")).unwrap();
        assert_eq!((&kept.quiet_hours, &kept.muted_until), (&None, &None));
        let removed: UpdatePreferences = serde_json::from_str(&format!(
            r#"{{{base},"quiet_hours":null,"muted_until":null}}"#
        ))
        .unwrap();
        assert_eq!(
            (removed.quiet_hours, removed.muted_until),
            (Some(None), Some(None))
        );
        let set: UpdatePreferences = serde_json::from_str(&format!(
            r#"{{{base},"quiet_hours":{{"start_minute":1320,"end_minute":480,"time_zone":"Europe/Paris"}}}}"#
        ))
        .unwrap();
        assert_eq!(set.quiet_hours, Some(Some(window(1320, 480))));
        // The kept form serializes without the fields, so its replay fingerprint is stable.
        assert!(
            !serde_json::to_string(&kept)
                .unwrap()
                .contains("quiet_hours")
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DesktopNotifications {
    #[default]
    Default,
    All,
    Mention,
    Nothing,
}

/// Query accompanying the raw PNG/JPEG body, or DELETE. No user-supplied file path.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AvatarCommand {
    pub operation_id: String,
    pub expected_revision: String,
}

/// Replays return the original revision; clients refetch the current profile.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileReceipt {
    pub operation_id: String,
    pub applied_revision: String,
}

/// Bounded live invalidation; this never changes the durable room cursor.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ProfileStamp {
    pub user: crate::User,
    pub revision: String,
    pub avatar_file_id: Option<String>,
    pub status_text: String,
}
