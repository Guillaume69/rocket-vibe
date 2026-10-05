//! Private conversation access for the existing message lists and composers.
//! The roster stays opaque here; clear rows are transient and never reach SQL.
use super::*;
pub use rv_protocol::{SendMessage, parity::QuoteReference};
mod quotes;
pub use quotes::{QuotePreview, QuoteSelection};
mod quote_reader;
pub use quote_reader::QuoteReader;
mod quote_composer;
pub use quote_composer::QuoteComposer;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Journaled,
    Pending,
    Accepted,
    Cancelling,
    Cancelled,
}
pub struct Message {
    pub row: crate::store::MessageRow,
    pub operation: String,
    pub position: Option<String>,
    /// Protected local observation time; not a claimed remote send timestamp.
    pub observed_at: u64,
    pub delivery: Delivery,
    pub quotes: Vec<rv_protocol::parity::QuoteReference>,
    /// Encrypted files (E2EE_FILES.md), shown as `rv-file:~<id>` attachments.
    pub files: Vec<rv_protocol::parity::EncryptedFile>,
}
pub struct View {
    pub revision: u64,
    pub can_send: bool,
    pub catching_up: bool,
    pub has_older: bool,
    pub after: String,
    pub draft: String,
    pub messages: Vec<Message>,
    pub selected_quote: Option<QuotePreview>,
}
struct State {
    revision: u64,
    roster: Option<groups::Roster>,
    admission: Option<[u8; 32]>,
    selected_quote: Option<QuoteSelection>,
    names: BTreeMap<String, String>,
}
struct Conversation {
    /// This view's token in the session's registry of openable private files.
    view: u64,
    room: super::Access,
    encrypted: bool,
    thread: Option<String>,
    state: Mutex<State>,
    serial: tokio::sync::Mutex<()>,
}
#[derive(Clone)]
pub struct Access(Arc<Conversation>);
impl super::super::Access {
    /// Opening this actor only attaches the registered coffer. It never creates
    /// an identity or opts the ordinary native outbox into plaintext sending.
    pub async fn messages(&self, room: String, thread: Option<String>) -> Result<Access> {
        self.message_access(room, thread, true).await
    }
    /// Reader-only projection of private references in an ordinary destination.
    pub async fn quote_reader(&self, room: String) -> Result<QuoteReader> {
        Ok(QuoteReader(self.message_access(room, None, false).await?))
    }
    pub async fn quote_composer(&self, room: String, thread: Option<String>) -> Result<QuoteComposer> {
        Ok(QuoteComposer(self.message_access(room, thread, false).await?))
    }
    async fn message_access(&self, room: String, thread: Option<String>, encrypted: bool) -> Result<Access> {
        if thread.as_ref().is_some_and(|id| {
            id.is_empty()
                || id.len() > 128
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        }) {
            return Err(room_changed());
        }
        let session = self.0.context.session.upgrade().ok_or_else(room_changed)?;
        if !session
            .store
            .rooms()
            .map_err(crate::native::Error::from)?
            .iter()
            .any(|r| r.id == room && r.encrypted == encrypted)
        {
            return Err(room_changed());
        }
        let room = self.room(room).await?;
        Ok(Access(Arc::new(Conversation {
            view: fastrand::u64(..),
            room,
            encrypted,
            thread,
            state: Mutex::new(State {
                revision: 0,
                roster: None,
                admission: None,
                selected_quote: None,
                names: BTreeMap::new(),
            }),
            serial: tokio::sync::Mutex::new(()),
        })))
    }
}
impl Access {
    pub fn check(&self) -> Result<()> {
        let result = self.0.room.check().and_then(|_| {
            let session = self.0.room.0.session.upgrade().ok_or_else(room_changed)?;
            if session
                .store
                .rooms()
                .map_err(crate::native::Error::from)?
                .iter()
                .any(|r| r.id == self.0.room.0.id && r.encrypted == self.0.encrypted)
            {
                Ok(())
            } else {
                Err(room_changed())
            }
        });
        if result.is_err() {
            self.close();
        }
        result
    }
    pub fn close(&self) {
        self.0.room.close();
        self.0.state.lock().unwrap().roster = None;
        self.cancel_quote();
        if let Some(session) = self.0.room.0.session.upgrade() {
            session.forget_private_files(self.0.view);
        }
    }
    /// Makes these rows' encrypted files openable while this view is open.
    fn register_files(&self, messages: &[Message]) {
        if let Some(session) = self.0.room.0.session.upgrade() {
            session.register_private_files(self.0.view, &self.0.room.0.id, messages.iter().flat_map(|m| &m.files));
        }
    }
    fn roster(&self) -> Result<groups::Roster> {
        self.check()?;
        self.0.state.lock().unwrap().roster.clone().ok_or_else(room_changed)
    }
    pub async fn set_draft(&self, text: String) -> Result<()> {
        let _serial = self.0.serial.lock().await;
        let roster = self.roster()?;
        self.0.room.0.crypto.set_draft(roster, self.0.thread.clone(), text).await?;
        self.check()
    }
    pub async fn draft(&self) -> Result<String> {
        let _serial = self.0.serial.lock().await;
        let value = self.0.room.0.crypto.draft(self.roster()?, self.0.thread.clone()).await?;
        self.check()?;
        Ok(value)
    }
    /// Consume one bounded protocol page and then project the retained prefix.
    /// A UI may poll again while catching_up; no unbounded loop owns its thread.
    pub async fn refresh(&self, before: Option<String>, limit: usize) -> Result<View> {
        let before = before
            .map(|s| {
                s.parse::<u64>()
                    .ok()
                    .filter(|v| *v > 0 && *v <= i64::MAX as u64 && v.to_string() == s)
                    .ok_or_else(room_changed)
            })
            .transpose()?;
        if !(1..=200).contains(&limit) {
            return Err(room_changed());
        }
        let _serial = self.0.serial.lock().await;
        let room = &self.0.room;
        room.current().await?;
        if before.is_none() {
            room.0.crypto.journal_page(&room.0.id).await?;
            self.check()?;
        }
        let (roster, can_send) = room.0.crypto.message_roster(&room.0.id).await?;
        self.check()?;
        let user = &room.0.crypto.scope().user;
        let own = roster.members.iter().find(|m| &m.user == user);
        let changed = {
            let state = self.0.state.lock().unwrap();
            own.is_none()
                || state.roster.as_ref().is_some_and(|previous| {
                    previous.scope != roster.scope || previous.members.iter().find(|m| &m.user == user) != own
                })
        };
        if changed {
            self.close();
            return Err(room_changed());
        }
        let projection = room
            .0
            .crypto
            .journal_projection(&room.0.id, groups::ProjectionQuery { before, limit, thread: self.0.thread.clone() })
            .await?;
        if before.is_none() {
            // New verified messages may be waiting for the history backup.
            room.0.settings.sync_history_backup_soon();
            // Old storage keys are destroyed on schedule (E2EE_STORAGE.md).
            room.0.settings.renew_storage_soon();
        }
        let can_send = can_send && (self.0.thread.is_none() || projection.root.is_some());
        self.check()?;
        if self.0.state.lock().unwrap().admission.is_some_and(|old| old != projection.admission) {
            self.close();
            return Err(room_changed());
        }
        let draft = room.0.crypto.draft(roster.clone(), self.0.thread.clone()).await?;
        let outgoing = room.0.crypto.outgoing_messages(roster.clone()).await?;
        let (names, usernames, _) = room.members().await?;
        self.check()?;
        self.0.state.lock().unwrap().names = names.clone();
        let mut messages = Vec::with_capacity(projection.messages.len() + outgoing.len() + 1);
        for entry in projection.root.into_iter().chain(projection.messages) {
            messages.push(journaled(&room.0.id, entry, &names, &usernames)?);
        }
        if before.is_none() {
            for entry in outgoing {
                if entry.header.thread != self.0.thread {
                    continue;
                }
                if let Some(target) = &entry.header.target {
                    // An unsettled amendment shows on its target, which then
                    // carries its operation for retry and cancellation.
                    if entry.cancelled || entry.receipt.is_some() {
                        continue;
                    }
                    let Some(row) = messages.iter_mut().find(|m| &m.row.id == target) else { continue };
                    let text = entry.message().map_err(rv_crypto::delivery::Error::from)?.text;
                    match entry.header.kind {
                        groups::MessageKind::Edit => edited(row, text),
                        groups::MessageKind::React | groups::MessageKind::Unreact => {
                            let me = usernames.get(&entry.header.author).unwrap_or(&entry.header.author);
                            react(row, &text, me, entry.header.kind == groups::MessageKind::React)?;
                        }
                        _ => (),
                    }
                    row.operation = entry.header.operation.clone();
                    row.delivery = if entry.cancelling { Delivery::Cancelling } else { Delivery::Pending };
                    row.row.outbox_status = Some("pending".into());
                    continue;
                }
                let delivery = if entry.cancelled {
                    Delivery::Cancelled
                } else if entry.cancelling {
                    Delivery::Cancelling
                } else if entry.receipt.is_some() {
                    Delivery::Accepted
                } else {
                    Delivery::Pending
                };
                let document = entry.message().map_err(rv_crypto::delivery::Error::from)?;
                messages.push(message(
                    &room.0.id,
                    document,
                    &entry.header.author,
                    entry.receipt.as_ref().map(|r| r.message.clone()).unwrap_or_else(|| entry.header.operation.clone()),
                    entry.receipt.as_ref().map(|r| r.position.to_string()),
                    entry.observed_at,
                    delivery,
                    &names,
                )?);
            }
        }
        for message in &mut messages {
            if message.row.thread_id.is_none() {
                message.row.thread_count = i64::from(*projection.retained_replies.get(&message.row.id).unwrap_or(&0));
            }
        }
        let had_selected_quote = self.0.state.lock().unwrap().selected_quote.is_some();
        let selected_quote = self.project_quotes(&mut messages).await?;
        if had_selected_quote || messages.iter().any(|m| !m.quotes.is_empty()) {
            // Source resolution awaits other rooms. The destination's private
            // grant must still match the prefix whose clear rows we built.
            match room.0.crypto.journal_sources(&room.0.id).await {
                Ok(current) if current.admission == projection.admission => (),
                result => {
                    self.close();
                    return Err(result.err().unwrap_or_else(room_changed));
                }
            }
        }
        self.register_files(&messages);
        let revision = {
            let mut state = self.0.state.lock().unwrap();
            state.revision += 1;
            state.roster = Some(roster);
            state.admission = Some(projection.admission);
            state.revision
        };
        self.check()?;
        Ok(View {
            revision,
            can_send,
            catching_up: !projection.complete,
            has_older: projection.has_older,
            after: projection.after.to_string(),
            draft,
            messages,
            selected_quote,
        })
    }
    /// The UI supplies a fresh operation once; failed delivery exposes the same
    /// protected intent on refresh/restart and resumes through its receipt GET.
    pub async fn send(&self, document: SendMessage) -> Result<()> {
        self.send_selected(document, vec![]).await
    }
    pub async fn send_selected(&self, document: SendMessage, selections: Vec<QuoteSelection>) -> Result<()> {
        let _serial = self.0.serial.lock().await;
        self.0.room.current().await?;
        if document.quotes != selections.iter().map(|s| s.reference.clone()).collect::<Vec<_>>() {
            return Err(crate::native::Error::Protocol("crypto_quote_selection_required").into());
        }
        self.validate_quotes(&selections).await?;
        if document.reply_to != self.0.thread {
            return Err(room_changed());
        }
        let roster = self.roster()?;
        let crypto = &self.0.room.0.crypto;
        if self.0.thread.is_some()
            && crypto
                .journal_projection(
                    &self.0.room.0.id,
                    groups::ProjectionQuery { before: None, limit: 1, thread: self.0.thread.clone() },
                )
                .await?
                .root
                .is_none()
        {
            return Err(crate::native::Error::Protocol("crypto_thread_root_not_retained").into());
        }
        for entry in crypto.outgoing_messages(roster.clone()).await? {
            if entry.header.target.is_some() {
                continue;
            }
            let original = entry.message().map_err(rv_crypto::delivery::Error::from)?;
            if !entry.cancelled
                && original.reply_to == document.reply_to
                && original.text == document.text
                && original.quotes == document.quotes
                && original.cards == document.cards
            {
                return Err(crate::native::Error::Protocol("crypto_message_already_pending").into());
            }
        }
        let text = document.text.clone();
        crypto.send_message(&self.0.room.0.id, document).await?;
        self.check()?;
        if selections.iter().any(|s| self.0.state.lock().unwrap().selected_quote.as_ref() == Some(s)) {
            self.cancel_quote();
        }
        if crypto.draft(roster.clone(), self.0.thread.clone()).await? == text {
            crypto.set_draft(roster, self.0.thread.clone(), String::new()).await?;
        }
        self.check()
    }
    /// The thread root this view writes to, if any.
    pub fn thread(&self) -> Option<&str> {
        self.0.thread.as_deref()
    }
    /// Whether the server takes files: encrypted objects ride on its uploads.
    pub fn files_available(&self) -> bool {
        self.check().is_ok() && self.0.room.0.session.upgrade().is_some_and(|s| s.files_available())
    }
    /// Seals a file on the device, uploads its opaque object, then sends it in
    /// a private message with `caption` (E2EE_FILES.md). The key and name
    /// travel only inside the encrypted document.
    pub async fn send_file(
        &self,
        path: std::path::PathBuf,
        name: String,
        media_type: String,
        caption: String,
    ) -> Result<()> {
        self.check()?;
        let room = &self.0.room;
        let session = room.0.session.upgrade().ok_or_else(room_changed)?;
        let (id, sealed) = session.upload_private_object(&room.0.id, &path).await?;
        let document = SendMessage {
            operation_id: crate::native::room_operation_id(),
            text: caption,
            reply_to: self.0.thread.clone(),
            quotes: vec![],
            cards: vec![],
            files: vec![rv_protocol::parity::EncryptedFile {
                id: id.clone(),
                key: sealed.key_text(),
                filename: name,
                media_type,
                bytes: sealed.bytes.to_string(),
                sha256: sealed.sha256_text(),
            }],
        };
        let operation = document.operation_id.clone();
        let result = self.send_selected(document, vec![]).await;
        if result.is_err() {
            // A prepared message keeps its object for the resume; otherwise
            // the reservation is released now rather than in 24 h.
            let kept = match self.roster() {
                Ok(roster) => room
                    .0
                    .crypto
                    .outgoing_messages(roster)
                    .await
                    .map(|o| o.iter().any(|m| m.header.operation == operation))
                    .unwrap_or(true),
                Err(_) => true,
            };
            if !kept {
                session.cancel_private_object(&id).await;
            }
        }
        result
    }
    /// Edits (`Some(text)`) or deletes (`None`) one of the user's own
    /// journaled messages (E2EE_AMENDMENTS.md). Readers apply it once it is
    /// journaled; until then it shows on its target like a pending send.
    pub async fn amend(&self, target: String, text: Option<String>) -> Result<()> {
        let _serial = self.0.serial.lock().await;
        self.0.room.current().await?;
        self.roster()?;
        let operation = crate::native::room_operation_id();
        self.0.room.0.crypto.amend_message(&self.0.room.0.id, target, text, operation).await?;
        self.check()
    }
    /// Reacts to any journaled message of this view with a standard or
    /// catalog emoji (`present`), or withdraws that reaction.
    pub async fn react(&self, target: String, emoji: String, present: bool) -> Result<()> {
        let _serial = self.0.serial.lock().await;
        self.0.room.current().await?;
        self.roster()?;
        let session = self.0.room.0.session.upgrade().ok_or_else(room_changed)?;
        let emoji = session.reaction_emoji(&emoji, present)?;
        let operation = crate::native::room_operation_id();
        self.0.room.0.crypto.react_message(&self.0.room.0.id, target, emoji, present, operation).await?;
        self.check()
    }
    /// Private search in this room's verified documents on the device, threads
    /// included, newest first; nothing is sent to the server.
    pub async fn search(&self, text: String) -> Result<Vec<Message>> {
        let _serial = self.0.serial.lock().await;
        let room = &self.0.room;
        room.current().await?;
        self.roster()?;
        let found = room.0.crypto.journal_search(&room.0.id, text, 50).await?;
        self.check()?;
        if self.0.state.lock().unwrap().admission.is_some_and(|old| old != found.admission) {
            self.close();
            return Err(room_changed());
        }
        let (names, usernames, _) = room.members().await?;
        self.check()?;
        let found = found
            .messages
            .into_iter()
            .map(|entry| journaled(&room.0.id, entry, &names, &usernames))
            .collect::<Result<Vec<_>>>()?;
        self.register_files(&found);
        Ok(found)
    }
    pub async fn resume(&self, operation: String) -> Result<()> {
        let _serial = self.0.serial.lock().await;
        let roster = self.roster()?;
        let crypto = &self.0.room.0.crypto;
        let original = crypto
            .outgoing_messages(roster.clone())
            .await?
            .into_iter()
            .find(|m| m.header.operation == operation && m.header.thread == self.0.thread && !m.cancelled)
            .ok_or_else(room_changed)?;
        let text = original.message().map_err(rv_crypto::delivery::Error::from)?.text;
        if original.receipt.is_none() {
            crypto.resume_message(&operation).await?;
        }
        self.check()?;
        if original.header.target.is_none() && crypto.draft(roster.clone(), self.0.thread.clone()).await? == text {
            crypto.set_draft(roster, self.0.thread.clone(), String::new()).await?;
        }
        self.check()
    }
    pub async fn cancel(&self, operation: String) -> Result<()> {
        let _serial = self.0.serial.lock().await;
        let roster = self.roster()?;
        if !self
            .0
            .room
            .0
            .crypto
            .outgoing_messages(roster)
            .await?
            .iter()
            .any(|m| m.header.operation == operation && m.header.thread == self.0.thread)
        {
            return Err(room_changed());
        }
        self.0.room.0.crypto.cancel_message(&operation).await?;
        self.check()
    }
}

/// A verified row, with its author's latest edit and current reactions.
fn journaled(
    room: &str,
    entry: groups::ProjectedMessage,
    names: &BTreeMap<String, String>,
    usernames: &BTreeMap<String, String>,
) -> Result<Message> {
    let receipt = &entry.message.receipt;
    let document = entry.message.message().map_err(rv_crypto::delivery::Error::from)?;
    let mut row = message(
        room,
        document,
        &receipt.header.author,
        receipt.message.clone(),
        Some(receipt.position.to_string()),
        entry.observed_at,
        Delivery::Journaled,
        names,
    )?;
    if let Some(edit) = &entry.edit {
        edited(&mut row, edit.text.to_string());
    }
    for reaction in &entry.reactions {
        for user in &reaction.users {
            react(&mut row, &reaction.emoji, usernames.get(user).unwrap_or(user), true)?;
        }
    }
    Ok(row)
}
/// Adds or removes one user's reaction in the row's reaction map, keyed like
/// the ordinary native rows (`{":name:": {"usernames": [...]}}`).
fn react(message: &mut Message, emoji: &str, username: &str, present: bool) -> Result<()> {
    let mut map = message
        .row
        .reactions
        .as_deref()
        .map(serde_json::from_str::<serde_json::Map<String, serde_json::Value>>)
        .transpose()
        .map_err(|_| room_changed())?
        .unwrap_or_default();
    let key = format!(":{emoji}:");
    let mut users = map
        .remove(&key)
        .and_then(|v| v.get("usernames").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    users.retain(|u| u != username);
    if present {
        users.push(username.to_owned());
    }
    if !users.is_empty() {
        map.insert(key, serde_json::json!({ "usernames": users }));
    }
    message.row.reactions =
        if map.is_empty() { None } else { Some(serde_json::to_string(&map).map_err(|_| room_changed())?) };
    Ok(())
}
fn edited(message: &mut Message, text: String) {
    message.row.md = Some(crate::native::markdown::cached_tree(None, &text));
    message.row.text = Some(text);
    message.row.edited = true;
}
#[allow(clippy::too_many_arguments)]
fn message(
    room: &str,
    document: SendMessage,
    author: &str,
    id: String,
    position: Option<String>,
    observed_at: u64,
    delivery: Delivery,
    names: &BTreeMap<String, String>,
) -> Result<Message> {
    let mut cards = crate::native::files::private_attachments(&document.files);
    cards.extend(crate::native::cards::attachments(&document.cards)?);
    let attachments =
        if cards.is_empty() { None } else { Some(serde_json::to_string(&cards).map_err(|_| room_changed())?) };
    let row = crate::store::MessageRow {
        id,
        rid: room.into(),
        ts: i64::try_from(observed_at.saturating_mul(1000)).map_err(|_| room_changed())?,
        md: Some(crate::native::markdown::cached_tree(None, &document.text)),
        text: Some(document.text),
        author: Some(names.get(author).cloned().unwrap_or_else(|| author.into())),
        author_id: author.into(),
        thread_id: document.reply_to,
        attachments,
        outbox_status: match delivery {
            Delivery::Journaled => None,
            Delivery::Cancelled => Some("failed".into()),
            _ => Some("pending".into()),
        },
        ..Default::default()
    };
    Ok(Message {
        row,
        operation: document.operation_id,
        position,
        observed_at,
        delivery,
        quotes: document.quotes,
        files: document.files,
    })
}
