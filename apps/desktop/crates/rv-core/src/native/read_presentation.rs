//! Confirmed badges and the opening unread boundary use sequence positions.
use super::store::MessageRow;
use crate::timeline::{self, Display};
use rv_protocol::parity::ReadState;

pub const MAX_BADGE_COUNT: u64 = i32::MAX as u64;

/// Large counts are bounded for display; protocol positions remain exact.
pub fn badges(state: Option<&ReadState>) -> (i64, i64, bool) {
    let Some(state) = state else { return (0, 0, false) };
    let number = |s: &str| s.parse::<u64>().unwrap_or(0);
    let unread = number(&state.unread_roots).saturating_add(number(&state.unread_replies)).min(MAX_BADGE_COUNT);
    let mentions = number(&state.mentions).saturating_add(number(&state.group_mentions)).min(MAX_BADGE_COUNT);
    (unread as i64, mentions as i64, unread > 0 || mentions > 0)
}

/// Preserve native sequence order and the existing presentation. The caller
/// captures `after` once when opening the current membership, never at an ACK.
pub fn group(rows: Vec<MessageRow>, rid: &str, me: &str, after: Option<&str>) -> Vec<Display> {
    let boundary = after.and_then(|value| value.parse::<u64>().ok());
    let marker = boundary.and_then(|seen| {
        rows.iter()
            .find(|row| {
                row.status.is_none()
                    && row.system_type.is_none()
                    && row.author_id != me
                    && row.position.as_deref().and_then(|p| p.parse::<u64>().ok()).is_some_and(|p| p > seen)
            })
            .map(|row| row.id.clone())
    });
    let mut display = timeline::group(rows.into_iter().map(|row| row.presentation(rid, me)).collect());
    if let Some(id) = marker
        && let Some(row) = display.iter_mut().find(|row| row.row.id == id)
    {
        row.new_marker = true;
    }
    display
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_boundary_is_exact_despite_clock_order_own_messages_and_pending_rows() {
        let row = |id: &str, position: Option<&str>, ts, author: &str, status: Option<&str>| MessageRow {
            id: id.into(),
            position: position.map(String::from),
            text: "Text".into(),
            author: author.into(),
            author_id: author.into(),
            ts,
            status: status.map(String::from),
            edited: false,
            reactions: None,
            pinned: false,
            starred: false,
            reply_to: None,
            thread_replies: 0,
            body: None,
            system_type: None,
            attachments: None,
            urls: None,
            author_bot: false,
        };
        let rows = vec![
            row("read", Some("9007199254740992"), 5000, "other", None),
            row("own", Some("9007199254740993"), 4000, "me", None),
            row("first", Some("9007199254740994"), 3000, "other", None),
            row("second", Some("9007199254740995"), 2000, "other", None),
            row("pending", None, 1000, "other", Some("pending")),
        ];
        let display = group(rows, "room", "me", Some("9007199254740992"));
        assert_eq!(
            display.iter().map(|row| row.row.id.as_str()).collect::<Vec<_>>(),
            ["read", "own", "first", "second", "pending"]
        );
        assert_eq!(display.iter().map(|row| row.new_marker).collect::<Vec<_>>(), [false, false, true, false, false]);
        assert!(display.last().unwrap().row.outbox_status.is_some());
    }
    #[test]
    fn badges_sum_roots_replies_and_mentions_without_wrapping() {
        let mut state:ReadState=serde_json::from_value(serde_json::json!({"room_id":"room","revision":"1","root_position":"0","reply_position":"0","unread_roots":"2","unread_replies":"3","mentions":"1","group_mentions":"2","favorite":false})).unwrap();
        assert_eq!(badges(Some(&state)), (5, 3, true));
        state.unread_roots = u64::MAX.to_string();
        state.unread_replies = u64::MAX.to_string();
        state.mentions = u64::MAX.to_string();
        assert_eq!(badges(Some(&state)), (i32::MAX.into(), i32::MAX.into(), true));
        assert_eq!(badges(None), (0, 0, false));
    }
}
