//! Scheduled messages (Vibez `scheduled_messages`) for the SwiftUI app:
//! the same rule and words as GTK, from `rv_core::native::scheduled`. Times
//! cross as Unix seconds; every sentence comes worded in the current language.
use crate::{model::RvError, native::NativeChat, on_tokio};
use chrono::{DateTime, Utc};
use rv_core::i18n::t;
use rv_core::native::scheduled;

/// One of my scheduled messages in the room, as the list shows it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ScheduledItem {
    pub id: String,
    pub text: String,
    /// "tomorrow at 08:00", on this device's clock.
    pub when: String,
    /// A reply in a thread.
    pub thread_reply: bool,
    /// The server could not send it; `reason` says why when it can.
    pub failed: bool,
    pub reason: Option<String>,
}

/// The menu's instants, from now (Unix seconds).
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ScheduleTimes {
    pub in_one_hour: i64,
    pub tomorrow_morning: i64,
    pub earliest: i64,
    pub latest: i64,
}

fn refusal(error: rv_core::native::Error) -> RvError {
    RvError::local(t(scheduled::error_key(error.code())))
}

#[uniffi::export]
impl NativeChat {
    /// "Send later" belongs in `room`: the server offers it, the room is not encrypted.
    pub fn can_schedule(&self, room: String) -> bool {
        self.session.can_schedule(&room)
    }
    pub fn schedule_times(&self) -> ScheduleTimes {
        let now = Utc::now();
        ScheduleTimes {
            in_one_hour: scheduled::in_one_hour(now).timestamp(),
            tomorrow_morning: scheduled::tomorrow_morning(&chrono::Local::now()).timestamp(),
            earliest: scheduled::earliest(now).timestamp(),
            latest: scheduled::latest(now).timestamp(),
        }
    }
    /// Schedules `text` (a reply in `root`'s thread when set) for `send_at`;
    /// answers the "Scheduled for …" notice. A refusal is worded.
    pub async fn schedule_message(
        &self,
        room: String,
        root: Option<String>,
        text: String,
        send_at: i64,
    ) -> Result<String, RvError> {
        let at =
            DateTime::<Utc>::from_timestamp(send_at, 0).ok_or_else(|| RvError::local(t("scheduled.error_time")))?;
        let s = self.session.clone();
        let made = on_tokio(async move { s.schedule_message(&room, root.as_deref(), &text, at).await })
            .await
            .map_err(refusal)?;
        Ok(scheduled::scheduled_notice(scheduled::send_at(&made).unwrap_or(at)))
    }
    /// My scheduled messages in `room` (only `root`'s thread when set), soonest first.
    pub async fn scheduled_messages(&self, room: String, root: Option<String>) -> Result<Vec<ScheduledItem>, RvError> {
        let s = self.session.clone();
        let list = on_tokio(async move { s.scheduled_messages(&room).await }).await.map_err(refusal)?;
        let now = chrono::Local::now();
        Ok(list
            .into_iter()
            .filter(|m| root.is_none() || m.reply_to == root)
            .map(|m| ScheduledItem {
                when: scheduled::send_at(&m).map(|at| scheduled::when(at, &now)).unwrap_or_else(|| m.send_at.clone()),
                failed: m.state == scheduled::ScheduledState::Failed,
                reason: scheduled::failure_key(m.error.as_deref()).map(|key| t(key).to_owned()),
                thread_reply: m.reply_to.is_some(),
                id: m.id,
                text: m.text,
            })
            .collect())
    }
    /// Cancels a pending one, or removes a failed one.
    pub async fn cancel_scheduled(&self, id: String) -> Result<(), RvError> {
        let s = self.session.clone();
        on_tokio(async move { s.cancel_scheduled(&id).await }).await.map_err(refusal)
    }
}
