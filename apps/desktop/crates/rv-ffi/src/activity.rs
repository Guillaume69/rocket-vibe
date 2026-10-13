//! The Activity view for SwiftUI (`rv_core::activity`): every signed-in
//! account's mentions of me, replies in my threads and reactions to my
//! messages, then the rooms whose unread mentions no stored message shows.

use rv_core::activity::Kind;
use rv_core::supervisor;

use crate::{Client, blocking};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ActivityKind {
    Mention,
    Reply,
    Reaction,
}

/// A room with unread mentions the device holds no message for.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityRoom {
    /// `Account::key`.
    pub account: String,
    /// The server's label, for a view gathering several accounts.
    pub server: String,
    pub rid: String,
    pub room: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityItem {
    pub account: String,
    pub server: String,
    pub kind: ActivityKind,
    pub rid: String,
    pub room: String,
    pub message_id: String,
    /// The thread a reply belongs to: it opens there.
    pub thread_id: Option<String>,
    pub author: String,
    /// The message's words, on one line.
    pub text: String,
    pub ts: i64,
    /// A reaction's other reactors and emojis (glyphs where known).
    pub reactors: Vec<String>,
    pub emojis: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ActivityView {
    pub rooms: Vec<ActivityRoom>,
    pub items: Vec<ActivityItem>,
    /// More than one account shows: each entry names its server.
    pub several: bool,
}

#[uniffi::export]
impl Client {
    /// Every running account's Activity view, as one.
    pub async fn activity(&self) -> ActivityView {
        let accounts = self.accounts.clone();
        let merged = blocking(move || accounts.activity()).await;
        let mut keys: Vec<String> = merged
            .rooms
            .iter()
            .map(|(info, _)| supervisor::key(info))
            .chain(merged.items.iter().map(|(info, _)| supervisor::key(info)))
            .collect();
        keys.sort();
        keys.dedup();
        ActivityView {
            several: keys.len() > 1,
            rooms: merged
                .rooms
                .into_iter()
                .map(|(info, room)| ActivityRoom {
                    account: supervisor::key(&info),
                    server: supervisor::server_label(&info),
                    rid: room.rid,
                    room: room.room,
                    count: room.count,
                })
                .collect(),
            items: merged
                .items
                .into_iter()
                .map(|(info, item)| {
                    let row = item.message;
                    let text = row.text.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
                    ActivityItem {
                        account: supervisor::key(&info),
                        server: supervisor::server_label(&info),
                        kind: match item.kind {
                            Kind::Mention => ActivityKind::Mention,
                            Kind::Reply => ActivityKind::Reply,
                            Kind::Reaction => ActivityKind::Reaction,
                        },
                        rid: row.rid,
                        room: item.room,
                        message_id: row.id,
                        thread_id: row.thread_id,
                        author: row.author.unwrap_or_default(),
                        text,
                        ts: row.ts,
                        reactors: item.reactors,
                        emojis: item
                            .emojis
                            .iter()
                            .map(|code| rv_core::emoji::unicode(code).map_or_else(|| code.clone(), str::to_owned))
                            .collect(),
                    }
                })
                .collect(),
        }
    }
}
