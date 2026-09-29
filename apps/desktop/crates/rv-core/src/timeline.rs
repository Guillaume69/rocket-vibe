//! How a room's messages line up on screen: author groups, day separators,
//! the time in the gutter and the "new messages" marker. Shared by every UI.

use chrono::{DateTime, Local, TimeZone};

use crate::store::MessageRow;

const GROUPING_GAP_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Display {
    pub row: MessageRow,
    pub show_header: bool,
    pub show_day: bool,
    /// A continuation row whose minute differs from the row above: the time
    /// goes in the avatar gutter.
    pub gutter_time: bool,
    /// The first message I have not read: "✦ New messages" above it.
    pub new_marker: bool,
}

pub fn local(ts: i64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ts).single().unwrap_or_default()
}

/// A message with a system type other than `e2e`, which is someone's words.
pub fn is_system(row: &MessageRow) -> bool {
    row.system_type.as_deref().is_some_and(|kind| kind != "e2e")
}

pub fn group(rows: Vec<MessageRow>) -> Vec<Display> {
    let mut out: Vec<Display> = Vec::with_capacity(rows.len());
    for row in rows {
        let minute = |ts: i64| local(ts).format("%Y%m%d%H%M").to_string();
        let gutter_time = out.last().is_some_and(|prev| minute(prev.row.ts) != minute(row.ts));
        let (show_header, show_day) = match out.last() {
            None => (true, true),
            Some(prev) => {
                let new_day = local(prev.row.ts).date_naive() != local(row.ts).date_naive();
                let header = new_day
                    || is_system(&row)
                    || is_system(&prev.row)
                    || prev.row.author_id != row.author_id
                    || row.ts - prev.row.ts > GROUPING_GAP_MS;
                (header, new_day)
            }
        };
        out.push(Display { gutter_time: gutter_time && !show_header, row, show_header, show_day, new_marker: false });
    }
    out
}

/// Marks the first message after `seen` that someone else sent.
pub fn mark_new(rows: &mut [Display], seen: i64, me: &str) {
    if let Some(first) =
        rows.iter_mut().find(|d| d.row.ts > seen && d.row.author_id != me && d.row.outbox_status.is_none())
    {
        first.new_marker = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60 * 1000;

    fn at(ts: i64, author: &str) -> MessageRow {
        MessageRow { id: format!("{author}{ts}"), ts, author_id: author.into(), ..Default::default() }
    }

    fn noon() -> i64 {
        Local.with_ymd_and_hms(2026, 9, 29, 12, 0, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn same_author_within_five_minutes_groups() {
        let t = noon();
        let rows = group(vec![at(t, "a"), at(t + 10_000, "a"), at(t + 2 * MIN, "a"), at(t + 8 * MIN, "a")]);
        let headers: Vec<bool> = rows.iter().map(|d| d.show_header).collect();
        assert_eq!(headers, [true, false, false, true]);
        assert!(!rows[1].gutter_time, "same minute as the row above");
        assert!(rows[2].gutter_time);
        assert!(!rows[3].gutter_time, "a header row carries its own time");
    }

    #[test]
    fn another_author_a_system_message_or_a_new_day_breaks_the_group() {
        let t = noon();
        let mut joined = at(t + 2 * MIN, "a");
        joined.system_type = Some("uj".into());
        let mut e2e = at(t + 3 * MIN, "a");
        e2e.system_type = Some("e2e".into());
        let rows = group(vec![at(t, "a"), at(t + MIN, "b"), joined, e2e, at(t + 24 * 60 * MIN, "a")]);
        let headers: Vec<bool> = rows.iter().map(|d| d.show_header).collect();
        assert_eq!(headers, [true, true, true, true, true]);
        let days: Vec<bool> = rows.iter().map(|d| d.show_day).collect();
        assert_eq!(days, [true, false, false, false, true]);
    }

    #[test]
    fn the_marker_goes_on_the_first_unread_message_from_someone_else() {
        let t = noon();
        let mut pending = at(t + 2 * MIN, "b");
        pending.outbox_status = Some("pending".into());
        let mut rows = group(vec![at(t, "b"), at(t + MIN, "me"), pending, at(t + 3 * MIN, "b"), at(t + 4 * MIN, "b")]);
        mark_new(&mut rows, t, "me");
        let marked: Vec<bool> = rows.iter().map(|d| d.new_marker).collect();
        assert_eq!(marked, [false, false, false, true, false]);
    }
}
