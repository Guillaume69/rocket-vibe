//! Muted accounts, from the desktop server rail's menu (user decision,
//! 2026-10-13): for an hour, four hours, until tomorrow 09:00, a week, or
//! until unmuted. A muted account still syncs, but shows no notification,
//! sound or ring, and its rail dot and app badge count are held back; a
//! timed mute ends by itself. Kept in `<config>/muted-accounts`, one line per
//! account, `<account key>\t<end in ms | forever>`, shared by GTK and SwiftUI.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Duration, TimeZone};

const FILE: &str = "muted-accounts";
const FOREVER: &str = "forever";

/// How long the menu's choices mute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MuteFor {
    OneHour,
    FourHours,
    /// Until 09:00 the next day, on this computer's clock.
    UntilTomorrow,
    OneWeek,
    UntilUnmuted,
}

impl MuteFor {
    pub const ALL: [MuteFor; 5] =
        [MuteFor::OneHour, MuteFor::FourHours, MuteFor::UntilTomorrow, MuteFor::OneWeek, MuteFor::UntilUnmuted];

    /// The menu entry's catalog key.
    pub fn label(self) -> &'static str {
        match self {
            MuteFor::OneHour => "mute.hour",
            MuteFor::FourHours => "mute.four_hours",
            MuteFor::UntilTomorrow => "mute.tomorrow",
            MuteFor::OneWeek => "mute.week",
            MuteFor::UntilUnmuted => "mute.forever",
        }
    }

    /// When the mute ends (ms), None for never.
    pub fn until<Tz: TimeZone>(self, now: &DateTime<Tz>) -> Option<i64> {
        let later = |d: Duration| (now.clone() + d).timestamp_millis();
        match self {
            MuteFor::OneHour => Some(later(Duration::hours(1))),
            MuteFor::FourHours => Some(later(Duration::hours(4))),
            MuteFor::UntilTomorrow => Some(crate::reminders::tomorrow_at_nine(now).timestamp_millis()),
            MuteFor::OneWeek => Some(later(Duration::days(7))),
            MuteFor::UntilUnmuted => None,
        }
    }
}

/// An account's mute: until a time (ms) or until unmuted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mute {
    Until(i64),
    Forever,
}

fn read(config: &Path) -> HashMap<String, Mute> {
    std::fs::read_to_string(config.join(FILE))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (key, end) = line.split_once('\t')?;
            let mute = if end == FOREVER { Mute::Forever } else { Mute::Until(end.parse().ok()?) };
            Some((key.to_owned(), mute))
        })
        .collect()
}

fn write(config: &Path, mutes: &HashMap<String, Mute>) {
    let mut lines: Vec<String> = mutes
        .iter()
        .map(|(key, mute)| match mute {
            Mute::Forever => format!("{key}\t{FOREVER}"),
            Mute::Until(end) => format!("{key}\t{end}"),
        })
        .collect();
    lines.sort();
    if std::fs::create_dir_all(config).is_ok() {
        let _ = std::fs::write(config.join(FILE), lines.join("\n"));
    }
}

/// The accounts muted at `now` (ms); ended mutes are forgotten.
pub fn active(config: &Path, now: i64) -> HashMap<String, Mute> {
    let mut mutes = read(config);
    let before = mutes.len();
    mutes.retain(|_, mute| matches!(mute, Mute::Forever) || matches!(mute, Mute::Until(end) if *end > now));
    if mutes.len() != before {
        write(config, &mutes);
    }
    mutes
}

/// The account's mute at `now`, if it is muted.
pub fn muted(config: &Path, key: &str, now: i64) -> Option<Mute> {
    active(config, now).get(key).copied()
}

/// Whether a key fits one line of the file: a server chooses the user id in
/// it, and a line break there would write a mute for another account.
fn fits(key: &str) -> bool {
    !key.is_empty() && !key.contains(['\n', '\r', '\t'])
}

/// Mutes the account until `until` (ms), or until unmuted with None.
pub fn mute(config: &Path, key: &str, until: Option<i64>) {
    if !fits(key) {
        return;
    }
    let mut mutes = read(config);
    mutes.insert(key.to_owned(), until.map_or(Mute::Forever, Mute::Until));
    write(config, &mutes);
}

pub fn unmute(config: &Path, key: &str) {
    let mut mutes = read(config);
    if mutes.remove(key).is_some() {
        write(config, &mutes);
    }
}

/// The earliest end of a timed mute after `now`, to show the account again then.
pub fn next_end(config: &Path, now: i64) -> Option<i64> {
    active(config, now)
        .values()
        .filter_map(|mute| match mute {
            Mute::Until(end) => Some(*end),
            Mute::Forever => None,
        })
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};

    fn dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rv-mute-{name}-{:x}", fastrand::u64(..)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn choices_end_when_they_say() {
        let paris = FixedOffset::east_opt(2 * 3600).unwrap();
        let now = paris.with_ymd_and_hms(2026, 10, 13, 22, 30, 0).unwrap();
        let ms = now.timestamp_millis();
        assert_eq!(MuteFor::OneHour.until(&now), Some(ms + 3_600_000));
        assert_eq!(MuteFor::FourHours.until(&now), Some(ms + 4 * 3_600_000));
        assert_eq!(MuteFor::OneWeek.until(&now), Some(ms + 7 * 86_400_000));
        let tomorrow = paris.with_ymd_and_hms(2026, 10, 14, 9, 0, 0).unwrap().timestamp_millis();
        assert_eq!(MuteFor::UntilTomorrow.until(&now), Some(tomorrow));
        assert_eq!(MuteFor::UntilUnmuted.until(&now), None);
    }

    #[test]
    fn a_mute_holds_until_its_end_or_an_unmute() {
        let config = dir("hold");
        mute(&config, "https://a|u1", Some(1_000));
        mute(&config, "https://b|u2", None);
        assert_eq!(muted(&config, "https://a|u1", 999), Some(Mute::Until(1_000)));
        assert_eq!(muted(&config, "https://b|u2", 999), Some(Mute::Forever));
        assert_eq!(muted(&config, "https://c|u3", 999), None);
        assert_eq!(next_end(&config, 999), Some(1_000));
        // Ended: forgotten, and gone from the file.
        assert_eq!(muted(&config, "https://a|u1", 1_000), None);
        assert!(!std::fs::read_to_string(config.join(FILE)).unwrap().contains("https://a|u1"));
        assert_eq!(next_end(&config, 1_000), None);
        unmute(&config, "https://b|u2");
        assert!(active(&config, 0).is_empty());
        let _ = std::fs::remove_dir_all(config);
    }

    #[test]
    fn a_key_never_writes_another_line() {
        let config = dir("inject");
        mute(&config, "https://evil|x\nhttps://other|u9", None);
        mute(&config, "https://evil|x\tforever", None);
        assert!(active(&config, 0).is_empty());
        assert_eq!(muted(&config, "https://other|u9", 0), None);
        // A file damaged by hand: unreadable lines are skipped, the rest holds.
        std::fs::write(config.join(FILE), "garbage\nhttps://a|u1\tnot-a-number\nhttps://b|u2\tforever").unwrap();
        assert_eq!(active(&config, 0).into_keys().collect::<Vec<_>>(), ["https://b|u2"]);
        let _ = std::fs::remove_dir_all(config);
    }
}
