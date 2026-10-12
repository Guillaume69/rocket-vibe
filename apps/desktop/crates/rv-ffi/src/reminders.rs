//! "Remind me" for the SwiftUI app (brain/features/reminders.md): rv-core's
//! device store (`rv_core::reminders`), the directory the GTK app uses on the
//! same Mac, so either app fires a reminder the other set. Times cross as Unix
//! seconds; every sentence comes worded in the current language. The app polls
//! `Client::take_due_reminders` on a timer (`reminder_wait_seconds` says when)
//! and shows each as a notification whose click opens its `link`.

use chrono::Utc;
use rv_core::reminders::{self, Reminder, Reminders};
use rv_core::session::SessionInfo;

use crate::accounts::Dirs;
use crate::model::RvError;
use crate::native::NativeChat;
use crate::{Chat, Client};

/// The menu's instants from now, and the bounds of "Pick a time".
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ReminderTimes {
    pub in_one_hour: i64,
    pub in_three_hours: i64,
    pub tomorrow_morning: i64,
    pub earliest: i64,
    pub latest: i64,
}

/// What a reminder keeps of its message.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ReminderDraft {
    pub rid: String,
    pub room_name: String,
    pub message_id: String,
    /// The thread root when the message is a reply.
    pub thread_id: Option<String>,
    pub author: String,
    pub text: Option<String>,
    pub has_attachment: bool,
}

/// A pending reminder, as the message menu and the list show it.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ReminderItem {
    pub rid: String,
    pub room_name: String,
    pub message_id: String,
    pub thread_id: Option<String>,
    pub author: String,
    pub excerpt: String,
    pub due: i64,
    /// "tomorrow at 09:00", on this device's clock.
    pub when: String,
    /// "Cancel reminder (<when>)", the message menu's entry.
    pub cancel_label: String,
    /// Opens the account, the room and the message (`AppModel.openLink`).
    pub link: Option<String>,
}

/// A reminder whose time came, removed from the store: the notification.
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct DueReminder {
    /// Unique per account and message: the notification's identifier.
    pub key: String,
    /// "Reminder".
    pub title: String,
    pub room_name: String,
    /// "<author>: <excerpt>".
    pub line: String,
    pub link: Option<String>,
}

fn store(dirs: &Dirs) -> Reminders {
    Reminders::new(&dirs.config)
}

fn item(info: &SessionInfo, reminder: Reminder) -> ReminderItem {
    ReminderItem {
        link: reminders::link(&reminders::Owner::of(info), &reminder),
        when: reminder.when(),
        cancel_label: reminders::cancel_label(&reminder),
        rid: reminder.rid,
        room_name: reminder.room_name,
        message_id: reminder.message_id,
        thread_id: reminder.thread_id,
        author: reminder.author,
        excerpt: reminder.excerpt,
        due: reminder.due,
    }
}

pub(crate) fn set(dirs: &Dirs, info: &SessionInfo, draft: ReminderDraft, due: i64) -> Result<String, RvError> {
    let reminder = Reminder::about(
        &draft.rid,
        &draft.room_name,
        &draft.message_id,
        draft.thread_id.as_deref(),
        &draft.author,
        draft.text.as_deref(),
        draft.has_attachment,
        due,
        Utc::now().timestamp(),
    );
    store(dirs).set(info, reminder).map_err(|_| RvError::local(rv_core::i18n::t("reminders.not_saved")))?;
    Ok(reminders::notice(due))
}

pub(crate) fn get(dirs: &Dirs, info: &SessionInfo, message_id: &str) -> Option<ReminderItem> {
    store(dirs).get(info, message_id).map(|r| item(info, r))
}

pub(crate) fn pending(dirs: &Dirs, info: &SessionInfo) -> Vec<ReminderItem> {
    store(dirs).pending(info).into_iter().map(|r| item(info, r)).collect()
}

pub(crate) fn cancel(dirs: &Dirs, info: &SessionInfo, message_id: &str) -> Result<String, RvError> {
    store(dirs)
        .cancel(info, message_id)
        .map(|_| rv_core::i18n::t("reminders.cancelled").to_owned())
        .map_err(|_| RvError::local(rv_core::i18n::t("reminders.not_saved")))
}

/// Signing out: the account's reminders go with it.
pub(crate) fn forget(dirs: &Dirs, info: &SessionInfo) {
    store(dirs).remove_account(info);
}

/// "In 1 hour", "In 3 hours", "Tomorrow at 09:00", and what "Pick a time" takes.
#[uniffi::export]
pub fn reminder_times() -> ReminderTimes {
    let now = Utc::now();
    ReminderTimes {
        in_one_hour: reminders::in_hours(now, 1).timestamp(),
        in_three_hours: reminders::in_hours(now, 3).timestamp(),
        tomorrow_morning: reminders::tomorrow_at_nine(&chrono::Local::now()).timestamp(),
        earliest: reminders::earliest(now).timestamp(),
        latest: reminders::latest(now).timestamp(),
    }
}

#[uniffi::export]
impl Client {
    /// Every account's reminders due now, each handed out once and removed;
    /// the missed ones at the first call, those more than 7 days late dropped.
    pub fn take_due_reminders(&self) -> Vec<DueReminder> {
        store(&self.dirs)
            .take_due(Utc::now().timestamp())
            .into_iter()
            .map(|fired| DueReminder {
                key: fired.key,
                title: reminders::title().to_owned(),
                line: fired.reminder.line(),
                room_name: fired.reminder.room_name,
                link: fired.link,
            })
            .collect()
    }

    /// Seconds until the timer should call `take_due_reminders` again.
    pub fn reminder_wait_seconds(&self) -> u64 {
        store(&self.dirs).wait(Utc::now().timestamp()).as_secs()
    }
}

#[uniffi::export]
impl Chat {
    /// Sets (or moves) the reminder about a message; answers "Reminder set for …".
    pub fn set_reminder(&self, draft: ReminderDraft, due: i64) -> Result<String, RvError> {
        set(&self.dirs, &self.session.info, draft, due)
    }
    pub fn reminder(&self, message_id: String) -> Option<ReminderItem> {
        get(&self.dirs, &self.session.info, &message_id)
    }
    /// This account's pending reminders, soonest first.
    pub fn reminders(&self) -> Vec<ReminderItem> {
        pending(&self.dirs, &self.session.info)
    }
    /// Answers "Reminder cancelled".
    pub fn cancel_reminder(&self, message_id: String) -> Result<String, RvError> {
        cancel(&self.dirs, &self.session.info, &message_id)
    }
}

#[uniffi::export]
impl NativeChat {
    pub fn set_reminder(&self, draft: ReminderDraft, due: i64) -> Result<String, RvError> {
        set(&self.dirs, &self.session.info, draft, due)
    }
    pub fn reminder(&self, message_id: String) -> Option<ReminderItem> {
        get(&self.dirs, &self.session.info, &message_id)
    }
    pub fn reminders(&self) -> Vec<ReminderItem> {
        pending(&self.dirs, &self.session.info)
    }
    pub fn cancel_reminder(&self, message_id: String) -> Result<String, RvError> {
        cancel(&self.dirs, &self.session.info, &message_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(user: &str) -> SessionInfo {
        SessionInfo {
            base_url: "https://chat.example.org".into(),
            user_id: user.into(),
            username: user.into(),
            auth_token: String::new(),
            native: None,
            mattermost: None,
        }
    }

    fn draft(id: &str) -> ReminderDraft {
        ReminderDraft {
            rid: "room1".into(),
            room_name: "general".into(),
            message_id: id.into(),
            thread_id: Some("root1".into()),
            author: "Bob".into(),
            text: None,
            has_attachment: true,
        }
    }

    #[test]
    fn the_gtk_directory_round_trips_and_fires_once() {
        let home = std::env::temp_dir().join(format!("rv-ffi-reminders-{}", std::process::id()));
        let dirs = || Dirs { config: home.join("config"), data: home.join("data"), cache: home.join("cache") };
        let (dirs, other_app) = (dirs(), dirs());
        let alice = info("alice1");
        let now = Utc::now().timestamp();
        set(&dirs, &alice, draft("m1"), now + 3600).unwrap();
        set(&dirs, &alice, draft("m2"), now - 5).unwrap();
        assert!(dirs.config.join("reminders").join("chat.example.org-alice1.json").exists(), "rv-gtk's file");
        let m1 = get(&dirs, &alice, "m1").unwrap();
        assert!(m1.link.as_deref().is_some_and(|l| l.contains("tmid=root1") && l.contains("msg=m1")));
        assert_eq!(pending(&dirs, &alice).iter().map(|r| r.message_id.as_str()).collect::<Vec<_>>(), ["m2", "m1"]);
        let client = Client::with_dirs(std::sync::Arc::new(other_app));
        let due = client.take_due_reminders();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].room_name, "general");
        assert!(due[0].line.starts_with("Bob: "));
        assert!(client.take_due_reminders().is_empty());
        assert!(client.reminder_wait_seconds() >= 1 && client.reminder_wait_seconds() <= 60);
        cancel(&dirs, &alice, "m1").unwrap();
        assert!(pending(&dirs, &alice).is_empty());
        set(&dirs, &alice, draft("m3"), now + 60).unwrap();
        forget(&dirs, &alice);
        assert!(pending(&dirs, &alice).is_empty(), "signing out forgets them");
        let times = reminder_times();
        assert!(times.earliest < times.in_one_hour && times.in_one_hour < times.in_three_hours);
        assert!(times.tomorrow_morning > now && times.latest > times.tomorrow_morning);
        let _ = std::fs::remove_dir_all(home);
    }
}
