//! Scheduled messages (Vibez `scheduled_messages`, docs/protocol/SCHEDULED.md):
//! text the server keeps and sends for me at a chosen time, whether or not an
//! app runs then. Text only, never in an end-to-end encrypted room. An
//! attempt's operation id is kept until the server answers, so a retry after a
//! lost answer replays it rather than scheduling the message twice. The list
//! is the server's (`GET /api/v1/scheduled`), read again whenever it is shown:
//! a sent one leaves it silently.
use super::{Error, NativeSession, room_operation_id};
use chrono::{DateTime, Duration, TimeZone, Utc};
pub use rv_protocol::scheduled::{MAX_DAYS, MIN_DELAY_SECONDS, ScheduledMessage, ScheduledState};
use std::collections::HashMap;
use std::sync::Mutex;

/// The longest text the server keeps, in bytes.
pub const MAX_TEXT: usize = 32_768;

/// The words both desktop apps show, in `crate::i18n`.
pub const KEYS: &[&str] = &[
    "scheduled.send_later",
    "scheduled.in_hour",
    "scheduled.tomorrow_morning",
    "scheduled.pick",
    "scheduled.pick_hint",
    "scheduled.date",
    "scheduled.time",
    "scheduled.schedule",
    "scheduled.title",
    "scheduled.cancel",
    "scheduled.failed",
    "scheduled.remove",
    "scheduled.thread",
    "scheduled.empty",
    "scheduled.today",
    "scheduled.tomorrow",
];

/// Attempts the server has not answered yet, by (room, thread root, text):
/// their operation id, replayed by the next attempt of the same message.
#[derive(Default)]
pub(super) struct Attempts(Mutex<HashMap<AttemptKey, String>>);

/// (room, thread root, text): what makes two attempts the same message.
type AttemptKey = (String, Option<String>, String);

/// "In 1 hour".
pub fn in_one_hour(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::hours(1)
}

/// "Tomorrow at 08:00": 08:00 the next day on `now`'s clock. A day whose
/// 08:00 does not exist there (a clock change) takes the next whole hour.
pub fn tomorrow_morning<Tz: TimeZone>(now: &DateTime<Tz>) -> DateTime<Utc> {
    let today = now.date_naive();
    let day = today.succ_opt().unwrap_or(today);
    let zone = now.timezone();
    (8..12)
        .filter_map(|hour| day.and_hms_opt(hour, 0, 0))
        .find_map(|naive| zone.from_local_datetime(&naive).earliest())
        .map(|at| at.with_timezone(&Utc))
        .unwrap_or_else(|| now.with_timezone(&Utc) + Duration::days(1))
}

/// The earliest instant the server accepts from `now`.
pub fn earliest(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::seconds(MIN_DELAY_SECONDS)
}

/// The latest.
pub fn latest(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::days(MAX_DAYS)
}

/// At least a minute and at most 30 days after `now`.
pub fn accepted(at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    at >= earliest(now) && at <= latest(now)
}

/// When it leaves, on `now`'s clock: "today at 14:30", "tomorrow at 08:00",
/// else "Oct 14 at 09:00" ("14/10 à 09:00"), the year added when it differs.
pub fn when<Tz: TimeZone>(at: DateTime<Utc>, now: &DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let local = at.with_timezone(&now.timezone());
    let time = local.format("%H:%M").to_string();
    let (day, today) = (local.date_naive(), now.date_naive());
    let french = crate::i18n::current() == crate::i18n::Lang::Fr;
    let date = if day == today {
        crate::i18n::t("scheduled.today").to_owned()
    } else if today.succ_opt() == Some(day) {
        crate::i18n::t("scheduled.tomorrow").to_owned()
    } else {
        let same_year = chrono::Datelike::year(&day) == chrono::Datelike::year(&today);
        let pattern = match (french, same_year) {
            (true, true) => "%d/%m",
            (true, false) => "%d/%m/%Y",
            (false, true) => "%b %-d",
            (false, false) => "%b %-d, %Y",
        };
        local.format(pattern).to_string()
    };
    crate::i18n::tf("scheduled.at", &[("day", &date), ("time", &time)])
}

/// "Scheduled for <when>", the notice after a message was scheduled.
pub fn scheduled_notice(at: DateTime<Utc>) -> String {
    crate::i18n::tf("scheduled.done", &[("when", &when(at, &chrono::Local::now()))])
}

/// The instant a scheduled message leaves.
pub fn send_at(message: &ScheduledMessage) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&message.send_at).ok().map(|at| at.with_timezone(&Utc))
}

/// Why the server could not send a failed one, in a few words; None when its
/// code says nothing a person can act on.
pub fn failure_key(code: Option<&str>) -> Option<&'static str> {
    match code? {
        "encrypted_room" => Some("scheduled.reason_encrypted"),
        "no_session" | "session_rejected" | "account_disabled" => Some("scheduled.reason_session"),
        "permission_denied" | "not_found" | "forbidden" | "read_only" => Some("scheduled.reason_access"),
        _ => None,
    }
}

/// The sentence for a refused schedule or cancel.
pub fn error_key(code: &str) -> &'static str {
    match code {
        "scheduled_time" | "invalid_request" => "scheduled.error_time",
        "scheduled_limit" => "scheduled.error_limit",
        "encrypted_room" => "scheduled.error_encrypted",
        "scheduled_sending" => "scheduled.error_sending",
        "not_found" => "scheduled.error_gone",
        "permission_denied" => "scheduled.error_access",
        "offline" => "native.offline",
        _ => "native.error",
    }
}

impl NativeSession {
    /// The server keeps and sends scheduled messages.
    pub fn scheduled_supported(&self) -> bool {
        self.capabilities.lock().unwrap().as_ref().is_some_and(|c| c.scheduled_messages)
    }
    /// "Send later" belongs in this room: the server offers it and the room
    /// is not end-to-end encrypted (the server never holds its plaintext).
    pub fn can_schedule(&self, room: &str) -> bool {
        self.scheduled_supported() && self.store.room_encrypted(room).is_ok_and(|encrypted| !encrypted)
    }
    fn scheduled_access(&self) -> Result<(), Error> {
        self.ready()?;
        if !self.scheduled_supported() {
            return Err(Error::Protocol("unsupported_feature"));
        }
        Ok(())
    }
    /// Keeps `text` (trimmed) for the server to send in `room` (a reply in
    /// the thread of `reply_to`) at `at`.
    pub async fn schedule_message(
        &self,
        room: &str,
        reply_to: Option<&str>,
        text: &str,
        at: DateTime<Utc>,
    ) -> Result<ScheduledMessage, Error> {
        self.scheduled_access()?;
        // What the field held, without the blank lines around it.
        let text = text.trim();
        if self.store.room_encrypted(room)? {
            return Err(Error::Protocol("encrypted_room"));
        }
        if text.is_empty() || text.len() > MAX_TEXT {
            return Err(Error::Protocol("invalid_request"));
        }
        if !accepted(at, Utc::now()) {
            return Err(Error::Protocol("scheduled_time"));
        }
        self.identity().await?;
        self.scheduled_access()?;
        let key = (room.to_owned(), reply_to.map(str::to_owned), text.to_owned());
        let operation_id =
            self.scheduling.0.lock().unwrap().entry(key.clone()).or_insert_with(room_operation_id).clone();
        let input = rv_protocol::scheduled::ScheduleMessage {
            operation_id: operation_id.clone(),
            text: text.to_owned(),
            reply_to: key.1.clone(),
            send_at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        };
        let result = self.client.schedule_message(room, &input).await;
        // The server answered (made it, or refused it for good): the next
        // attempt is a new message. Without an answer the id is kept.
        let answered = match &result {
            Ok(_) => true,
            Err(rv_client::Error::Server { status, .. }) => *status < 500 && *status != 429,
            Err(_) => false,
        };
        if answered {
            let mut attempts = self.scheduling.0.lock().unwrap();
            if attempts.get(&key) == Some(&operation_id) {
                attempts.remove(&key);
            }
        }
        let scheduled = result?;
        if scheduled.room_id != room || scheduled.text != text || scheduled.reply_to.as_deref() != reply_to {
            return Err(Error::Protocol("invalid_scheduled"));
        }
        Ok(scheduled)
    }
    /// My pending and failed scheduled messages in `room`, soonest first.
    pub async fn scheduled_messages(&self, room: &str) -> Result<Vec<ScheduledMessage>, Error> {
        self.scheduled_access()?;
        let list = self.client.scheduled_messages().await?;
        self.ready()?;
        Ok(list.messages.into_iter().filter(|message| message.room_id == room).collect())
    }
    /// Cancels a pending one, or removes a failed one.
    pub async fn cancel_scheduled(&self, id: &str) -> Result<(), Error> {
        self.scheduled_access()?;
        self.identity().await?;
        self.client.cancel_scheduled(id).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn paris(text: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(text).unwrap()
    }

    #[test]
    fn tomorrow_morning_is_eight_the_next_day_on_the_local_clock() {
        let now = paris("2026-10-11T23:30:00+02:00");
        assert_eq!(tomorrow_morning(&now), paris("2026-10-12T08:00:00+02:00").with_timezone(&Utc));
        let early = paris("2026-10-11T00:10:00+02:00");
        assert_eq!(tomorrow_morning(&early), paris("2026-10-12T08:00:00+02:00").with_timezone(&Utc));
    }

    #[test]
    fn the_window_is_one_minute_to_thirty_days() {
        let now = Utc::now();
        assert!(!accepted(now + Duration::seconds(59), now));
        assert!(accepted(now + Duration::seconds(60), now));
        assert!(accepted(in_one_hour(now), now));
        assert!(accepted(now + Duration::days(30), now));
        assert!(!accepted(now + Duration::days(30) + Duration::seconds(1), now));
    }

    #[test]
    fn when_names_today_tomorrow_then_the_date() {
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        crate::i18n::set(crate::i18n::Lang::Fr);
        let now = paris("2026-10-11T10:00:00+02:00");
        let at = |text: &str| paris(text).with_timezone(&Utc);
        assert_eq!(when(at("2026-10-12T08:00:00+02:00"), &now), "demain à 08:00");
        assert_eq!(when(at("2026-10-20T09:05:00+02:00"), &now), "20/10 à 09:05");
        crate::i18n::set(crate::i18n::Lang::En);
        let now = paris("2026-10-11T10:00:00+02:00");
        let at = |text: &str| paris(text).with_timezone(&Utc);
        assert_eq!(when(at("2026-10-11T14:30:00+02:00"), &now), "today at 14:30");
        assert_eq!(when(at("2026-10-12T08:00:00+02:00"), &now), "tomorrow at 08:00");
        assert_eq!(when(at("2026-10-20T09:05:00+02:00"), &now), "Oct 20 at 09:05");
        let december = paris("2026-12-20T10:00:00+01:00");
        assert_eq!(when(at("2027-01-05T09:00:00+01:00"), &december), "Jan 5, 2027 at 09:00");
    }

    #[test]
    fn every_key_has_words_in_both_languages() {
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        let codes = ["scheduled_time", "scheduled_limit", "encrypted_room", "scheduled_sending", "not_found", "x"];
        for lang in [crate::i18n::Lang::Fr, crate::i18n::Lang::En] {
            crate::i18n::set(lang);
            for key in KEYS.iter().copied().chain(codes.iter().map(|code| error_key(code))) {
                assert!(!crate::i18n::t(key).is_empty() && crate::i18n::t(key) != "?", "{key}");
            }
            for code in ["encrypted_room", "no_session", "permission_denied"] {
                assert!(!crate::i18n::t(failure_key(Some(code)).unwrap()).is_empty());
            }
            assert!(crate::i18n::tn("scheduled.chip", 2).contains('2'));
        }
        crate::i18n::set(crate::i18n::Lang::En);
        assert_eq!(crate::i18n::tn("scheduled.chip", 1), "1 scheduled");
    }

    #[test]
    fn a_failure_says_why_only_when_it_can() {
        assert_eq!(failure_key(Some("encrypted_room")), Some("scheduled.reason_encrypted"));
        assert_eq!(failure_key(Some("no_session")), Some("scheduled.reason_session"));
        assert_eq!(failure_key(Some("permission_denied")), Some("scheduled.reason_access"));
        assert_eq!(failure_key(Some("something_else")), None);
        assert_eq!(failure_key(None), None);
    }
}
