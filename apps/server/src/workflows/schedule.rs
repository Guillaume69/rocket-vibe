//! When a schedule fires next, in its own time zone (daylight saving included).
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveTime, TimeZone, Utc};
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
            // The minute of `at` past every hour.
            let mut candidate =
                local
                    .naive_local()
                    .date()
                    .and_hms_opt(local.hour_of_day(), at_minute(at), 0)?;
            for _ in 0..50 {
                if let Some(time) = resolve(zone, candidate)
                    && time > after
                {
                    return Some(time);
                }
                candidate += Duration::hours(1);
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

fn at_minute(at: NaiveTime) -> u32 {
    chrono::Timelike::minute(&at)
}

trait HourOfDay {
    fn hour_of_day(&self) -> u32;
}
impl<T: chrono::Timelike> HourOfDay for T {
    fn hour_of_day(&self) -> u32 {
        self.hour()
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
}
