//! When a schedule fires next, in its own time zone (daylight saving included).
use chrono::{
    DateTime, Datelike, Duration, DurationRound, LocalResult, NaiveTime, TimeZone, Timelike, Utc,
};
use chrono_tz::Tz;
use rv_protocol::workflows::Every;

pub(crate) fn time(text: &str) -> Option<NaiveTime> {
    let (hours, minutes) = text.split_once(':')?;
    if hours.len() != 2 || minutes.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(hours.parse().ok()?, minutes.parse().ok()?, 0)
}

pub(crate) fn zone(name: &str) -> Option<Tz> {
    name.parse().ok()
}

/// The first firing strictly after `after`; `None` for a definition that
/// never fires (a week without days).
pub(crate) fn next(
    every: Every,
    at: NaiveTime,
    days: &[u8],
    zone: Tz,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let local = after.with_timezone(&zone);
    match every {
        Every::Hour => {
            // The minute of `at` past every real hour: walked in UTC, so a repeated
            // hour fires twice and a skipped one not at all, like the clock.
            let mut time = after.duration_trunc(Duration::minutes(1)).ok()?;
            for _ in 0..=120 {
                time += Duration::minutes(1);
                if time.with_timezone(&zone).minute() == at.minute() {
                    return Some(time);
                }
            }
            None
        }
        Every::Day | Every::Week => {
            if every == Every::Week && days.is_empty() {
                return None;
            }
            let mut date = local.date_naive();
            for _ in 0..16 {
                let weekday = date.weekday().number_from_monday() as u8;
                if (every == Every::Day || days.contains(&weekday))
                    && let Some(time) = resolve(zone, date.and_time(at))
                    && time > after
                {
                    return Some(time);
                }
                date = date.succ_opt()?;
            }
            None
        }
    }
}

/// A local time to UTC: the earlier instant when the clock repeats, the first
/// instant after the gap when it skips.
fn resolve(zone: Tz, local: chrono::NaiveDateTime) -> Option<DateTime<Utc>> {
    match zone.from_local_datetime(&local) {
        LocalResult::Single(time) => Some(time.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, _) => Some(first.with_timezone(&Utc)),
        LocalResult::None => zone
            .from_local_datetime(&(local + Duration::hours(1)))
            .earliest()
            .map(|time| time.with_timezone(&Utc)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn days_weeks_and_hours_follow_the_zone() {
        let paris = zone("Europe/Paris").unwrap();
        let nine = time("09:00").unwrap();
        // Summer: Paris is UTC+2.
        assert_eq!(
            next(Every::Day, nine, &[], paris, utc("2026-07-01T06:00:00Z")),
            Some(utc("2026-07-01T07:00:00Z"))
        );
        assert_eq!(
            next(Every::Day, nine, &[], paris, utc("2026-07-01T07:00:00Z")),
            Some(utc("2026-07-02T07:00:00Z"))
        );
        // Winter: UTC+1. 2026-10-25 is the change.
        assert_eq!(
            next(Every::Day, nine, &[], paris, utc("2026-10-24T12:00:00Z")),
            Some(utc("2026-10-25T08:00:00Z"))
        );
        // Mondays and Fridays; 2026-10-07 is a Wednesday.
        assert_eq!(
            next(
                Every::Week,
                nine,
                &[1, 5],
                paris,
                utc("2026-10-07T12:00:00Z")
            ),
            Some(utc("2026-10-09T07:00:00Z"))
        );
        assert_eq!(
            next(Every::Week, nine, &[], paris, utc("2026-10-07T12:00:00Z")),
            None
        );
        assert_eq!(
            next(
                Every::Hour,
                time("00:15").unwrap(),
                &[],
                paris,
                utc("2026-10-07T12:20:00Z")
            ),
            Some(utc("2026-10-07T13:15:00Z"))
        );
        assert!(time("9:00").is_none() && time("24:00").is_none() && zone("Mars/Base").is_none());
    }

    #[test]
    fn clock_changes_neither_skip_nor_double_a_firing() {
        let paris = zone("Europe/Paris").unwrap();
        let quarter = time("00:15").unwrap();
        // 2026-10-25: 03:00 CEST becomes 02:00 CET, 02:15 happens twice.
        assert_eq!(
            next(
                Every::Hour,
                quarter,
                &[],
                paris,
                utc("2026-10-25T00:15:00Z")
            ),
            Some(utc("2026-10-25T01:15:00Z"))
        );
        assert_eq!(
            next(
                Every::Hour,
                quarter,
                &[],
                paris,
                utc("2026-10-25T01:15:00Z")
            ),
            Some(utc("2026-10-25T02:15:00Z"))
        );
        // A repeated time fires once a day, at its first instant.
        let half_two = time("02:30").unwrap();
        assert_eq!(
            next(
                Every::Day,
                half_two,
                &[],
                paris,
                utc("2026-10-24T12:00:00Z")
            ),
            Some(utc("2026-10-25T00:30:00Z"))
        );
        // 2026-03-29: 02:00 CET becomes 03:00 CEST, 02:30 never happens: 03:30.
        assert_eq!(
            next(
                Every::Day,
                half_two,
                &[],
                paris,
                utc("2026-03-28T12:00:00Z")
            ),
            Some(utc("2026-03-29T01:30:00Z"))
        );
    }
}
