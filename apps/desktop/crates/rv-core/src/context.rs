//! A stretch of a room's history around one message, however old, read from
//! the server and never stored: the store only holds history contiguous with
//! the present, and an old page written there would hide the hole before it.

use std::collections::HashSet;

use crate::normalize::Message;
use crate::rest::RestError;
use crate::store::MessageRow;
use crate::sync::{HISTORY_PAGE, SyncEngine};

/// A range still full at this span is read back page by page instead.
const MIN_SPAN_MS: i64 = 1_000;
/// Requests one step forward may spend sizing its range.
const MAX_REQUESTS: usize = 8;

#[derive(Debug, Clone)]
pub struct Window {
    rid: String,
    kind: String,
    /// Oldest first, each id once.
    messages: Vec<Message>,
    pub has_older: bool,
    /// False once the window reaches the local history, or the present.
    pub has_newer: bool,
    /// Where reading forward resumes (everything up to it is here), and the span it tries.
    ahead: Option<(i64, i64)>,
}

impl Window {
    /// The page up to the message, then what follows it; `None` when the
    /// server answers without the message. `local_oldest`: the oldest message
    /// of the local history.
    pub async fn around(
        sync: &SyncEngine,
        rid: &str,
        kind: &str,
        id: &str,
        local_oldest: Option<i64>,
        now: i64,
    ) -> Result<Option<Window>, RestError> {
        let Some(target) = sync.fetch_message(id).await? else { return Ok(None) };
        let older = sync.history_range(rid, kind, Some(target.ts), None).await?;
        let mut window = Window {
            rid: rid.to_owned(),
            kind: kind.to_owned(),
            has_older: older.len() as i64 >= HISTORY_PAGE,
            has_newer: true,
            messages: Vec::new(),
            ahead: None,
        };
        window.add(older);
        window.add(vec![target]);
        window.newer(sync, local_oldest, now).await?;
        Ok(Some(window))
    }

    pub async fn older(&mut self, sync: &SyncEngine) -> Result<(), RestError> {
        let Some(oldest) = self.oldest_ts() else { return Ok(()) };
        let page = sync.history_range(&self.rid, &self.kind, Some(oldest), None).await?;
        self.has_older = page.len() as i64 >= HISTORY_PAGE;
        self.add(page);
        Ok(())
    }

    /// About half a page forward. The server only answers the newest page of
    /// a range, so a range is kept only when it comes back with room to
    /// spare: halved when full, doubled when sparse.
    pub async fn newer(&mut self, sync: &SyncEngine, local_oldest: Option<i64>, now: i64) -> Result<(), RestError> {
        let Some(last) = self.messages.last().map(|m| m.ts) else { return Ok(()) };
        let end = local_oldest.unwrap_or(now).min(now);
        let rest = local_oldest.filter(|l| *l < now);
        let (mut from, mut span) = self.ahead.unwrap_or((last, self.pace()));
        let mut found = 0;
        let mut rest_tried = false;
        for _ in 0..MAX_REQUESTS {
            let to = from.saturating_add(span);
            let reached = to >= end;
            let latest = if reached { rest } else { Some(to) };
            let mut page = sync.history_range(&self.rid, &self.kind, latest, Some(from)).await?;
            if page.len() as i64 >= HISTORY_PAGE {
                if span > MIN_SPAN_MS {
                    span /= 2;
                    continue;
                }
                self.fill(sync, &mut page, from).await?;
            }
            let added = self.add(page);
            found += added;
            if reached {
                self.has_newer = false;
                self.ahead = None;
                return Ok(());
            }
            from = to;
            if (added as i64) < HISTORY_PAGE / 4 {
                span = span.saturating_mul(2);
            }
            self.ahead = Some((from, span));
            if found as i64 >= HISTORY_PAGE / 2 {
                return Ok(());
            }
            // A quiet stretch can last years: all the rest at once, kept only if it is all there.
            if added == 0 && !rest_tried {
                rest_tried = true;
                let page = sync.history_range(&self.rid, &self.kind, rest, Some(from)).await?;
                if (page.len() as i64) < HISTORY_PAGE {
                    self.add(page);
                    self.has_newer = false;
                    self.ahead = None;
                    return Ok(());
                }
            }
        }
        self.ahead = Some((from, span));
        Ok(())
    }

    /// Completes the newest page of a dense range back to `from`, a page at a time.
    async fn fill(&self, sync: &SyncEngine, page: &mut Vec<Message>, from: i64) -> Result<(), RestError> {
        let mut oldest = page.iter().map(|m| m.ts).min().unwrap_or(from);
        loop {
            let more = sync.history_range(&self.rid, &self.kind, Some(oldest), Some(from)).await?;
            let full = more.len() as i64 >= HISTORY_PAGE;
            let next = more.iter().map(|m| m.ts).min().unwrap_or(oldest);
            page.extend(more);
            if !full || next >= oldest {
                return Ok(());
            }
            oldest = next;
        }
    }

    /// The span half a page took so far.
    fn pace(&self) -> i64 {
        let (Some(first), Some(last)) = (self.messages.first(), self.messages.last()) else { return MIN_SPAN_MS };
        let per_message = (last.ts - first.ts) / self.messages.len().max(1) as i64;
        (per_message * HISTORY_PAGE / 2).max(MIN_SPAN_MS)
    }

    /// Adds what is not there yet; returns how many.
    fn add(&mut self, page: Vec<Message>) -> usize {
        let before = self.messages.len();
        let mut known: HashSet<String> = self.messages.iter().map(|m| m.id.clone()).collect();
        self.messages.extend(page.into_iter().filter(|m| known.insert(m.id.clone())));
        self.messages.sort_by(|a, b| (a.ts, &a.id).cmp(&(b.ts, &b.id)));
        self.messages.len() - before
    }

    pub fn rid(&self) -> &str {
        &self.rid
    }

    pub fn messages(&self) -> &[Message] {
        &self.messages
    }

    pub fn rows(&self) -> Vec<MessageRow> {
        self.messages.iter().map(MessageRow::from).collect()
    }

    pub fn oldest_ts(&self) -> Option<i64> {
        self.messages.first().map(|m| m.ts)
    }
}
