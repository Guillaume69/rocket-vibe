//! "Remind me": a personal reminder about a message, kept on the device and
//! never on a server (brain/features/reminders.md, user decision 2026-10-11),
//! for every server kind. One JSON file per account under
//! `<config>/rocket-vibe-rs/reminders/`, the directory GTK and SwiftUI share on
//! a Mac like the quick-reaction counts: the file names its account (server,
//! user, Vibez identity) so a fired reminder can open it whichever account
//! is on screen, and signing out deletes it. Every change re-reads the file
//! under a process lock and an advisory file lock, then writes through a
//! temporary file of its own name, so the two apps merge rather than overwrite
//! and only one of them fires a given reminder.
//!
//! The UIs poll `take_due` on a timer (`wait` says when to look again): it
//! hands back what is due once and removes it, and silently drops what is more
//! than 7 days late (an app that was not running then).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::i18n::{t, tf};
use crate::session::SessionInfo;

/// The excerpt keeps the message's first characters, formatting gone.
pub const EXCERPT_CHARS: usize = 140;
/// "Pick a time" takes at least a minute ahead...
pub const MIN_DELAY_SECONDS: i64 = 60;
/// ...and at most a year.
pub const MAX_DAYS: i64 = 365;
/// A reminder found more than this late (the app was not running) is dropped.
pub const LATE_LIMIT_SECONDS: i64 = 7 * 24 * 3600;
/// Even with nothing due soon, look again this often: the other desktop app
/// may have set one in the shared directory.
const RECHECK_SECONDS: i64 = 60;
/// The notification keys of fired reminders start with this.
pub const NOTIFICATION_PREFIX: &str = "rv-reminder:";

/// The words both desktop apps show, in `crate::i18n`.
pub const KEYS: &[&str] = &[
    "reminders.remind_me",
    "reminders.in_hour",
    "reminders.in_three_hours",
    "reminders.tomorrow",
    "reminders.pick",
    "reminders.pick_hint",
    "reminders.set_for",
    "reminders.cancel_reminder",
    "reminders.cancel_at",
    "reminders.cancelled",
    "reminders.not_saved",
    "reminders.title",
    "reminders.notification",
    "reminders.empty",
    "reminders.cancel",
    "reminders.attachment",
    "reminders.message",
];

/// One reminder: what the notification and the list show, and where it leads.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reminder {
    pub rid: String,
    pub room_name: String,
    pub message_id: String,
    /// The thread root when the message is a reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// The author's display name.
    pub author: String,
    /// The first `EXCERPT_CHARS` characters, plain text (`excerpt`).
    pub excerpt: String,
    /// Unix seconds.
    pub due: i64,
    pub created: i64,
}

impl Reminder {
    /// A reminder about a message, its excerpt built from its text.
    #[allow(clippy::too_many_arguments)] // The message's own fields, then the times.
    pub fn about(
        rid: &str,
        room_name: &str,
        message_id: &str,
        thread_id: Option<&str>,
        author: &str,
        text: Option<&str>,
        has_attachment: bool,
        due: i64,
        now: i64,
    ) -> Self {
        Reminder {
            rid: rid.to_owned(),
            room_name: room_name.to_owned(),
            message_id: message_id.to_owned(),
            thread_id: thread_id.filter(|t| !t.is_empty() && *t != message_id).map(str::to_owned),
            author: author.to_owned(),
            excerpt: excerpt(text, has_attachment),
            due,
            created: now,
        }
    }

    /// The notification's second line: "<author>: <excerpt>".
    pub fn line(&self) -> String {
        if self.author.is_empty() { self.excerpt.clone() } else { format!("{}: {}", self.author, self.excerpt) }
    }

    /// When it is due, on this device's clock ("tomorrow at 09:00").
    pub fn when(&self) -> String {
        when(self.due)
    }
}

/// The account a file belongs to, enough to build a link that opens it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub base_url: String,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_epoch: Option<String>,
}

impl Owner {
    pub fn of(info: &SessionInfo) -> Self {
        Owner {
            base_url: info.base_url.clone(),
            user_id: info.user_id.clone(),
            instance_id: info.native.as_ref().map(|n| n.instance_id.clone()),
            data_epoch: info.native.as_ref().map(|n| n.data_epoch.clone()),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    account: Option<Owner>,
    #[serde(default)]
    reminders: Vec<Reminder>,
}

/// A reminder whose time came: show it, then it is gone from the store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fired {
    pub reminder: Reminder,
    /// `rocketvibe://room/<rid>?host=…&userId=…&msg=…[&tmid=…]`: opens the
    /// account, the room and the message (the thread for a reply). None when
    /// an id cannot travel in a link.
    pub link: Option<String>,
    /// Unique per account and message: the notification's tag.
    pub key: String,
}

/// The device's reminders, every account's (the files hold no secret).
#[derive(Clone, Debug)]
pub struct Reminders {
    dir: PathBuf,
}

/// One change at a time in this process; the file lock covers the other app.
static LOCK: Mutex<()> = Mutex::new(());

impl Reminders {
    /// The reminders kept under `config_dir` (`<config>/rocket-vibe-rs`).
    pub fn new(config_dir: &Path) -> Self {
        Reminders { dir: config_dir.join("reminders") }
    }

    /// The file of one account.
    pub fn path_for(&self, info: &SessionInfo) -> PathBuf {
        self.dir.join(format!("{}.json", account_key(info)))
    }

    /// Sets the reminder about its message, replacing an earlier one about the same message.
    pub fn set(&self, info: &SessionInfo, reminder: Reminder) -> std::io::Result<()> {
        self.change(&self.path_for(info), Some(info), |saved| {
            saved.reminders.retain(|r| r.message_id != reminder.message_id);
            saved.reminders.push(reminder);
            true
        })
        .map(|_| ())
    }

    /// The pending reminder about a message, if any.
    pub fn get(&self, info: &SessionInfo, message_id: &str) -> Option<Reminder> {
        read(&self.path_for(info)).reminders.into_iter().find(|r| r.message_id == message_id)
    }

    /// The account's pending reminders, soonest first.
    pub fn pending(&self, info: &SessionInfo) -> Vec<Reminder> {
        let mut list = read(&self.path_for(info)).reminders;
        list.sort_by(|a, b| a.due.cmp(&b.due).then(a.created.cmp(&b.created)));
        list
    }

    /// Cancels the reminder about a message; whether there was one.
    pub fn cancel(&self, info: &SessionInfo, message_id: &str) -> std::io::Result<bool> {
        self.change(&self.path_for(info), Some(info), |saved| {
            let before = saved.reminders.len();
            saved.reminders.retain(|r| r.message_id != message_id);
            saved.reminders.len() != before
        })
    }

    /// Signing out: the account's reminders go with it.
    pub fn remove_account(&self, info: &SessionInfo) {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _file = self.file_lock();
        let _ = std::fs::remove_file(self.path_for(info));
    }

    /// Every account's reminders due at `now` (Unix seconds), each handed out
    /// once and removed; those more than `LATE_LIMIT_SECONDS` late are dropped
    /// without a word.
    pub fn take_due(&self, now: i64) -> Vec<Fired> {
        let mut fired = Vec::new();
        for path in self.files() {
            let _ = self.change(&path, None, |saved| {
                let (due, kept): (Vec<Reminder>, Vec<Reminder>) = saved.reminders.drain(..).partition(|r| r.due <= now);
                saved.reminders = kept;
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                for reminder in due {
                    if now - reminder.due > LATE_LIMIT_SECONDS {
                        continue;
                    }
                    let link = saved.account.as_ref().and_then(|owner| link(owner, &reminder));
                    let key = format!("{NOTIFICATION_PREFIX}{stem}:{}", reminder.message_id);
                    fired.push(Fired { reminder, link, key });
                }
                true
            });
        }
        fired.sort_by_key(|f| f.reminder.due);
        fired
    }

    /// The soonest pending reminder of any account (Unix seconds).
    pub fn next_due(&self) -> Option<i64> {
        self.files().iter().flat_map(|path| read(path).reminders).map(|r| r.due).min()
    }

    /// How long a UI's timer waits before its next `take_due`: until the
    /// soonest reminder, at least a second, at most `RECHECK_SECONDS`.
    pub fn wait(&self, now: i64) -> StdDuration {
        let seconds = self.next_due().map_or(RECHECK_SECONDS, |due| (due - now).clamp(1, RECHECK_SECONDS));
        StdDuration::from_secs(seconds as u64)
    }

    fn files(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut files: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        files.sort();
        files
    }

    fn file_lock(&self) -> Option<std::fs::File> {
        std::fs::create_dir_all(&self.dir).ok()?;
        let file =
            std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(self.dir.join(".lock")).ok()?;
        file.lock().ok()?;
        Some(file)
    }

    /// Reads `path` again, applies `edit`, and writes it back when `edit`
    /// says it changed something (an empty file is deleted).
    fn change(
        &self,
        path: &Path,
        owner: Option<&SessionInfo>,
        edit: impl FnOnce(&mut Saved) -> bool,
    ) -> std::io::Result<bool> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _file = self.file_lock();
        let mut saved = read(path);
        if let Some(info) = owner {
            saved.account = Some(Owner::of(info));
        }
        if !edit(&mut saved) {
            return Ok(false);
        }
        if saved.reminders.is_empty() {
            match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
                _ => return Ok(true),
            }
        }
        write(path, &serde_json::to_string_pretty(&saved).unwrap_or_default())?;
        Ok(true)
    }
}

/// `<host>[_<port>]-<user id>[-<instance>]`, reduced to a safe file name.
fn account_key(info: &SessionInfo) -> String {
    let url = url::Url::parse(&info.base_url).ok();
    let host = url.as_ref().and_then(|u| u.host_str()).unwrap_or_default();
    let mut key = match url.as_ref().and_then(url::Url::port) {
        Some(port) => format!("{host}_{port}-{}", info.user_id),
        None => format!("{host}-{}", info.user_id),
    };
    if let Some(native) = &info.native {
        key = format!("{key}-{}", native.instance_id);
    }
    key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_' { c } else { '_' }).collect()
}

/// A missing or damaged file holds nothing.
fn read(path: &Path) -> Saved {
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn write(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}-{:016x}", std::process::id(), fastrand::u64(..)));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// The link a fired reminder opens: the account (by server, user and
/// Vibez identity), the room, the message, the thread for a reply.
pub fn link(owner: &Owner, reminder: &Reminder) -> Option<String> {
    let mut url = url::Url::parse(&format!("rocketvibe://room/{}", reminder.rid)).ok()?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("host", &crate::links::service_url(&owner.base_url)?);
        if let (Some(instance), Some(epoch)) = (&owner.instance_id, &owner.data_epoch) {
            query.append_pair("instanceId", instance).append_pair("dataEpoch", epoch);
        }
        query.append_pair("userId", &owner.user_id).append_pair("msg", &reminder.message_id);
        if let Some(root) = &reminder.thread_id {
            query.append_pair("tmid", root);
        }
    }
    crate::links::parse(url.as_str())?;
    Some(url.to_string())
}

/// The message's words on one line, formatting gone, its first
/// `EXCERPT_CHARS` characters; "Attachment" or "Message" when it has none.
pub fn excerpt(text: Option<&str>, has_attachment: bool) -> String {
    let words = text.map(|t| crate::runs::preview(crate::actions::strip_quote_prefix(t))).unwrap_or_default();
    let words = words.trim();
    if words.is_empty() {
        return t(if has_attachment { "reminders.attachment" } else { "reminders.message" }).to_owned();
    }
    words.chars().take(EXCERPT_CHARS).collect::<String>().trim_end().to_owned()
}

/// "In 1 hour", "In 3 hours".
pub fn in_hours(now: DateTime<Utc>, hours: i64) -> DateTime<Utc> {
    now + Duration::hours(hours)
}

/// "Tomorrow at 09:00": 09:00 the next day on `now`'s clock. A day whose
/// 09:00 does not exist there (a clock change) takes the next whole hour.
pub fn tomorrow_at_nine<Tz: TimeZone>(now: &DateTime<Tz>) -> DateTime<Utc> {
    let today = now.date_naive();
    let day = today.succ_opt().unwrap_or(today);
    let zone = now.timezone();
    (9..13)
        .filter_map(|hour| day.and_hms_opt(hour, 0, 0))
        .find_map(|naive| zone.from_local_datetime(&naive).earliest())
        .map(|at| at.with_timezone(&Utc))
        .unwrap_or_else(|| now.with_timezone(&Utc) + Duration::days(1))
}

/// The earliest instant "Pick a time" takes from `now`.
pub fn earliest(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::seconds(MIN_DELAY_SECONDS)
}

/// The latest.
pub fn latest(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::days(MAX_DAYS)
}

/// At least a minute and at most a year after `now`.
pub fn accepted(at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    at >= earliest(now) && at <= latest(now)
}

/// When `due` (Unix seconds) falls, on this device's clock: "today at 14:30",
/// "tomorrow at 09:00", "Oct 14 at 09:00".
pub fn when(due: i64) -> String {
    let at = DateTime::<Utc>::from_timestamp(due, 0).unwrap_or_default();
    crate::native::scheduled::when(at, &chrono::Local::now())
}

/// "Reminder set for <when>", the notice once set.
pub fn notice(due: i64) -> String {
    tf("reminders.set_for", &[("when", &when(due))])
}

/// The message menu's entry while a reminder is pending: "Cancel reminder (<when>)".
pub fn cancel_label(reminder: &Reminder) -> String {
    tf("reminders.cancel_at", &[("when", &reminder.when())])
}

/// The notification's title.
pub fn title() -> &'static str {
    t("reminders.notification")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::Identity;

    fn info(base_url: &str, user: &str, native: bool) -> SessionInfo {
        SessionInfo {
            base_url: base_url.into(),
            user_id: user.into(),
            username: user.into(),
            auth_token: "secret".into(),
            native: native.then(|| Identity { instance_id: "inst".into(), data_epoch: "epoch".into() }),
            mattermost: None,
            slack: None,
        }
    }

    fn reminder(id: &str, due: i64) -> Reminder {
        Reminder::about("room1", "general", id, None, "Bob", Some("hello **there**"), false, due, 100)
    }

    #[test]
    fn the_store_round_trips_replaces_and_cancels() {
        let dir = tempfile::tempdir().unwrap();
        let store = Reminders::new(dir.path());
        let alice = info("http://localhost:3000", "alice1", false);
        store.set(&alice, reminder("m1", 500)).unwrap();
        store.set(&alice, reminder("m2", 300)).unwrap();
        let path = store.path_for(&alice);
        assert!(path.ends_with("reminders/localhost_3000-alice1.json"), "{path:?}");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("secret"), "no token on disk");
        let again = Reminders::new(dir.path());
        assert_eq!(again.pending(&alice).iter().map(|r| r.message_id.as_str()).collect::<Vec<_>>(), ["m2", "m1"]);
        assert_eq!(again.get(&alice, "m1").unwrap().excerpt, "hello there");
        // Again on the same message: the time is replaced, not a second reminder.
        store.set(&alice, reminder("m1", 200)).unwrap();
        let pending = store.pending(&alice);
        assert_eq!(pending.len(), 2);
        assert_eq!((pending[0].message_id.as_str(), pending[0].due), ("m1", 200));
        assert!(store.cancel(&alice, "m1").unwrap());
        assert!(!store.cancel(&alice, "m1").unwrap());
        assert_eq!(store.get(&alice, "m1"), None);
        assert!(store.cancel(&alice, "m2").unwrap());
        assert!(!path.exists(), "an empty file is removed");
    }

    #[test]
    fn due_reminders_fire_once_with_their_link_and_late_ones_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let store = Reminders::new(dir.path());
        let (alice, native) =
            (info("https://chat.example.org", "alice1", false), info("https://rv.example.org/x", "u2", true));
        let now = 10 * LATE_LIMIT_SECONDS;
        store.set(&alice, reminder("soon", now + 30)).unwrap();
        store.set(&alice, reminder("missed", now - 3600)).unwrap();
        store.set(&alice, reminder("stale", now - LATE_LIMIT_SECONDS - 1)).unwrap();
        let mut reply = reminder("reply", now - 5);
        reply.thread_id = Some("root1".into());
        store.set(&native, reply).unwrap();
        assert_eq!(store.next_due(), Some(now - LATE_LIMIT_SECONDS - 1));
        let fired = store.take_due(now);
        let ids: Vec<&str> = fired.iter().map(|f| f.reminder.message_id.as_str()).collect();
        assert_eq!(ids, ["missed", "reply"], "due ones of every account, the stale one dropped");
        let link = fired[0].link.as_deref().unwrap();
        let parsed = crate::links::parse(link).unwrap();
        assert!(
            crate::links::fits(&parsed, &alice)
                && !crate::links::fits(&parsed, &info("https://chat.example.org", "bob", false))
        );
        assert_eq!((parsed.rid.as_str(), parsed.message.as_deref(), parsed.root), ("room1", Some("missed"), None));
        let parsed = crate::links::parse(fired[1].link.as_deref().unwrap()).unwrap();
        assert!(crate::links::fits(&parsed, &native));
        assert_eq!(parsed.root.as_deref(), Some("root1"));
        assert!(fired[0].key.starts_with(NOTIFICATION_PREFIX) && fired[0].key != fired[1].key);
        assert!(store.take_due(now).is_empty(), "fired once");
        assert_eq!(store.pending(&alice).iter().map(|r| r.message_id.as_str()).collect::<Vec<_>>(), ["soon"]);
        assert_eq!(store.wait(now), StdDuration::from_secs(30));
        assert_eq!(store.wait(now + 29), StdDuration::from_secs(1));
        assert_eq!(store.take_due(now + 30).len(), 1);
        assert_eq!(store.wait(now), StdDuration::from_secs(RECHECK_SECONDS as u64));
    }

    #[test]
    fn removing_an_account_removes_its_reminders_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = Reminders::new(dir.path());
        let (alice, bob) =
            (info("https://chat.example.org", "alice1", false), info("https://chat.example.org", "bob1", false));
        store.set(&alice, reminder("m1", 50)).unwrap();
        store.set(&bob, reminder("m2", 50)).unwrap();
        store.remove_account(&alice);
        assert!(store.pending(&alice).is_empty());
        assert_eq!(store.pending(&bob).len(), 1);
        assert_eq!(store.take_due(60).len(), 1);
    }

    #[test]
    fn excerpts_are_plain_and_short() {
        let _serial = crate::i18n::LANGUAGE.lock().unwrap();
        crate::i18n::set(crate::i18n::Lang::En);
        assert_eq!(excerpt(Some("*bold* and `code`"), false), "bold and code");
        let long = "a".repeat(200);
        assert_eq!(excerpt(Some(&long), false).chars().count(), EXCERPT_CHARS);
        assert_eq!(excerpt(Some("  "), true), "Attachment");
        assert_eq!(excerpt(None, false), "Message");
        crate::i18n::set(crate::i18n::Lang::Fr);
        assert_eq!(excerpt(None, true), "Pièce jointe");
        crate::i18n::set(crate::i18n::Lang::En);
        let r = Reminder::about("r", "general", "m", Some("m"), "Bob", Some("hi"), false, 1, 0);
        assert_eq!(r.thread_id, None, "a root is not its own thread");
        assert_eq!(r.line(), "Bob: hi");
        for key in KEYS {
            assert_ne!(t(key), "?");
        }
    }

    #[test]
    fn times_and_bounds() {
        let paris = chrono_tz::Europe::Paris;
        let now = paris.with_ymd_and_hms(2026, 10, 11, 22, 30, 0).unwrap();
        assert_eq!(tomorrow_at_nine(&now), paris.with_ymd_and_hms(2026, 10, 12, 9, 0, 0).unwrap().with_timezone(&Utc));
        let utc = now.with_timezone(&Utc);
        assert_eq!(in_hours(utc, 3) - utc, Duration::hours(3));
        assert!(!accepted(utc + Duration::seconds(59), utc));
        assert!(accepted(utc + Duration::seconds(60), utc));
        assert!(accepted(utc + Duration::days(365), utc));
        assert!(!accepted(utc + Duration::days(365) + Duration::seconds(1), utc));
    }
}
