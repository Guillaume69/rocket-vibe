//! Do not disturb on a Vibez account, as the server applies it to push
//! and call rings (`account_quiet`): muted before `muted_until`, or inside the
//! daily `quiet_hours` window read in the window's OWN time zone (a window
//! with start > end crosses midnight). The desktop's own notifications follow
//! the same rule, with this machine's clock.
use chrono::{DateTime, Duration, Local, NaiveTime, SecondsFormat, TimeZone, Timelike, Utc};
use rv_protocol::{parity::UserPreferences, profiles::QuietHours};

/// The window's ends when none is saved: 22:00 to 08:00, as on the web.
pub const DEFAULT_START: u16 = 22 * 60;
pub const DEFAULT_END: u16 = 8 * 60;
/// "Until 08:00" ends at this hour of this machine's clock.
pub const MORNING_HOUR: u32 = 8;

/// Minutes since midnight at `now` in the IANA `zone`; this machine's local
/// time when the name does not parse.
pub fn minute_in(zone: &str, now: DateTime<Utc>) -> u16 {
    let time = match zone.parse::<chrono_tz::Tz>() {
        Ok(zone) => now.with_timezone(&zone).time(),
        Err(_) => now.with_timezone(&Local).time(),
    };
    (time.hour() * 60 + time.minute()) as u16
}

/// The end of a mute (RFC 3339) while it is ahead of `now`.
pub fn mute_ahead(muted_until: Option<&str>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let until = DateTime::parse_from_rfc3339(muted_until?).ok()?.with_timezone(&Utc);
    (until > now).then_some(until)
}

/// The end of the account's mute while it is ahead of `now`.
pub fn muted_until(preferences: &UserPreferences, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    mute_ahead(preferences.muted_until.as_deref(), now)
}

/// Whether `window` covers `now` in its own time zone.
pub fn in_quiet_hours(window: &QuietHours, now: DateTime<Utc>) -> bool {
    window.covers(minute_in(&window.time_zone, now))
}

/// Do not disturb at `now`: muted, or inside the window.
pub fn quiet(window: Option<&QuietHours>, muted_until: Option<&str>, now: DateTime<Utc>) -> bool {
    mute_ahead(muted_until, now).is_some() || window.is_some_and(|w| in_quiet_hours(w, now))
}

/// Whether the account is in do not disturb at `now`.
pub fn quiet_now(preferences: &UserPreferences, now: DateTime<Utc>) -> bool {
    quiet(preferences.quiet_hours.as_ref(), preferences.muted_until.as_deref(), now)
}

/// The next `hour`:00 on `now`'s clock, tomorrow when it has passed today.
pub fn next_morning<Z: TimeZone>(now: &DateTime<Z>, hour: u32) -> DateTime<Z> {
    let at = NaiveTime::from_hms_opt(hour.min(23), 0, 0).unwrap();
    let zone = now.timezone();
    let on = |day: chrono::NaiveDate| zone.from_local_datetime(&day.and_time(at)).earliest();
    let today = now.date_naive();
    match on(today) {
        Some(today) if today > *now => today,
        // An hour skipped by a clock change falls back to one hour from now.
        _ => today.succ_opt().and_then(on).unwrap_or_else(|| now.clone() + Duration::hours(1)),
    }
}

/// The `muted_until` a mute choice sends: `hour` for one hour, `morning`
/// until the next 08:00 on this machine's clock; None (unmute) for anything else.
pub fn mute_end(choice: &str, now: DateTime<Local>) -> Option<String> {
    let end = match choice {
        "hour" => now + Duration::hours(1),
        "morning" => next_morning(&now, MORNING_HOUR),
        _ => return None,
    };
    Some(end.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// A window from two `HH:MM` texts in this machine's time zone; None when a
/// text is no time or both ends are the same.
pub fn window(start: &str, end: &str) -> Option<QuietHours> {
    let minute = |text: &str| super::workflows::time_parts(text.trim()).map(|(h, m)| (h * 60 + m) as u16);
    let window = QuietHours {
        start_minute: minute(start)?,
        end_minute: minute(end)?,
        time_zone: super::workflows::system_time_zone(),
    };
    window.valid().then_some(window)
}

/// `22:00` for 1320.
pub fn clock(minute: u16) -> String {
    super::workflows::time_text(u32::from(minute / 60), u32::from(minute % 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
    }
    fn preferences(window: Option<(u16, u16, &str)>, muted: Option<&str>) -> UserPreferences {
        let mut p: UserPreferences = serde_json::from_value(serde_json::json!({
            "revision": "1", "language": "auto", "clock_24h": true,
            "push_enabled": true, "push_mentions_only": false,
        }))
        .unwrap();
        p.quiet_hours = window.map(|(start_minute, end_minute, zone)| QuietHours {
            start_minute,
            end_minute,
            time_zone: zone.into(),
        });
        p.muted_until = muted.map(str::to_owned);
        p
    }

    #[test]
    fn a_window_across_midnight_in_its_own_zone() {
        let night = preferences(Some((22 * 60, 8 * 60, "UTC")), None);
        assert!(quiet_now(&night, at("2026-10-10T23:30:00Z")));
        assert!(quiet_now(&night, at("2026-10-11T07:59:00Z")));
        assert!(!quiet_now(&night, at("2026-10-11T08:00:00Z")));
        assert!(!quiet_now(&night, at("2026-10-10T21:59:00Z")));
        // 21:30 UTC is 23:30 in Paris (summer time): inside a Paris window,
        // outside the same window read in UTC.
        let paris = preferences(Some((22 * 60, 8 * 60, "Europe/Paris")), None);
        assert_eq!(minute_in("Europe/Paris", at("2026-10-10T21:30:00Z")), 23 * 60 + 30);
        assert!(quiet_now(&paris, at("2026-10-10T21:30:00Z")));
        assert!(!quiet_now(&night, at("2026-10-10T21:30:00Z")));
        // 06:30 UTC is 08:30 in Paris: the Paris night is over.
        assert!(!quiet_now(&paris, at("2026-10-11T06:30:00Z")));
        // New York in winter: 03:00 UTC is 22:00 the day before.
        let york = preferences(Some((22 * 60, 23 * 60, "America/New_York")), None);
        assert!(quiet_now(&york, at("2027-01-15T03:00:00Z")));
        assert!(!quiet_now(&york, at("2027-01-15T22:30:00Z")));
    }

    #[test]
    fn an_unknown_zone_reads_the_local_clock() {
        let now = at("2026-10-10T12:00:00Z");
        let local = now.with_timezone(&Local);
        assert_eq!(minute_in("Not/A_Zone", now), (local.hour() * 60 + local.minute()) as u16);
    }

    #[test]
    fn a_mute_until_an_instant() {
        let now = at("2026-10-10T12:00:00Z");
        let muted = preferences(None, Some("2026-10-10T13:00:00Z"));
        assert!(quiet_now(&muted, now));
        assert_eq!(muted_until(&muted, now), Some(at("2026-10-10T13:00:00Z")));
        // An offset form counts the same instant; a past one is no mute.
        assert!(quiet_now(&preferences(None, Some("2026-10-10T14:30:00+02:00")), now));
        assert!(!quiet_now(&preferences(None, Some("2026-10-10T11:59:59Z")), now));
        assert!(!quiet_now(&preferences(None, Some("not a date")), now));
        assert!(!quiet_now(&preferences(None, None), now));
        // A mute wins over a window that does not cover now.
        let both = preferences(Some((1, 2, "UTC")), Some("2026-10-10T13:00:00Z"));
        assert!(quiet_now(&both, now));
    }

    #[test]
    fn the_mute_choices_and_the_window_texts() {
        let zone = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        let evening = zone.with_ymd_and_hms(2026, 10, 10, 21, 15, 0).unwrap();
        assert_eq!(next_morning(&evening, 8), zone.with_ymd_and_hms(2026, 10, 11, 8, 0, 0).unwrap());
        let dawn = zone.with_ymd_and_hms(2026, 10, 10, 6, 0, 0).unwrap();
        assert_eq!(next_morning(&dawn, 8), zone.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap());
        let eight = zone.with_ymd_and_hms(2026, 10, 10, 8, 0, 0).unwrap();
        assert_eq!(next_morning(&eight, 8), zone.with_ymd_and_hms(2026, 10, 11, 8, 0, 0).unwrap());
        let now = Local::now();
        let hour = mute_end("hour", now).unwrap();
        assert_eq!(at(&hour).timestamp(), (now + Duration::hours(1)).timestamp());
        assert!(at(&mute_end("morning", now).unwrap()) > now.with_timezone(&Utc));
        assert_eq!(mute_end("off", now), None);
        let w = window("22:00", " 08:30 ").unwrap();
        assert_eq!((w.start_minute, w.end_minute), (1320, 510));
        assert!(!w.time_zone.is_empty());
        assert!(window("22:00", "22:00").is_none() && window("24:00", "08:00").is_none() && window("8", "9").is_none());
        assert_eq!((clock(1320), clock(5)), ("22:00".to_owned(), "00:05".to_owned()));
    }
}
