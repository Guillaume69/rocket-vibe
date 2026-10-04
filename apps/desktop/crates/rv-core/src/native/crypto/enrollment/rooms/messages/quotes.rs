//! Transient reader views. Only references enter the encrypted send document.
use super::*;
use rv_protocol::parity::QuoteReference;
use serde_json::{Value, json};

#[derive(Clone, PartialEq)]
pub struct QuoteSelection {
    pub reference: QuoteReference,
    pub instance: String,
    pub data_epoch: String,
    pub membership: String,
    pub admission: [u8; 32],
}
pub struct QuotePreview {
    pub selection: QuoteSelection,
    pub author: String,
    pub text: String,
}
struct Source {
    document: SendMessage,
    position: String,
    author: String,
}
struct RoomSources {
    membership: String,
    admission: [u8; 32],
    messages: BTreeMap<String, Source>,
}
fn unavailable() -> Error {
    crate::native::Error::Protocol("crypto_quote_unavailable").into()
}
impl Access {
    fn source_membership(&self, room: &str) -> Result<Option<String>> {
        self.check()?;
        let session = self.0.room.0.session.upgrade().ok_or_else(room_changed)?;
        if !session.store.rooms().map_err(crate::native::Error::from)?.iter().any(|r| r.id == room && r.encrypted) {
            return Ok(None);
        }
        Ok(session.store.read_state(room).map_err(crate::native::Error::from)?.and_then(|s| s.membership_version))
    }
    async fn sources(&self, room: &str) -> Result<Option<RoomSources>> {
        let Some(membership) = self.source_membership(room)? else { return Ok(None) };
        let result = self.0.room.0.crypto.journal_sources(room).await;
        self.check()?;
        if self.source_membership(room)?.as_ref() != Some(&membership) {
            return Ok(None);
        }
        let projection = match result {
            Ok(value) => value,
            Err(Error::Delivery(rv_crypto::delivery::Error::Group(_))) => return Ok(None),
            Err(Error::Delivery(rv_crypto::delivery::Error::Network(rv_client::Error::Server {
                status: 403 | 404,
                ..
            }))) => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut messages = BTreeMap::new();
        let session = self.0.room.0.session.upgrade().ok_or_else(room_changed)?;
        for entry in projection.messages {
            let document = entry.message.message().map_err(rv_crypto::delivery::Error::from)?;
            let receipt = entry.message.receipt;
            // Public identity labels may come from the account cache; source
            // words and references come exclusively from this private prefix.
            let author = if room == self.0.room.0.id {
                self.0.state.lock().unwrap().names.get(&receipt.header.author).cloned()
            } else {
                None
            }
            .or_else(|| {
                session
                    .store
                    .profile_identity(&receipt.header.author)
                    .ok()
                    .flatten()
                    .map(|p| if p.user.display_name.is_empty() { p.user.username } else { p.user.display_name })
            })
            .unwrap_or_else(|| receipt.header.author.clone());
            if messages
                .insert(receipt.message, Source { document, position: receipt.position.to_string(), author })
                .is_some()
            {
                return Err(room_changed());
            }
        }
        Ok(Some(RoomSources { membership, admission: projection.admission, messages }))
    }
    fn preview(&self, selection: &QuoteSelection, source: &RoomSources) -> Option<QuotePreview> {
        let scope = self.0.room.0.crypto.scope();
        let entry = source.messages.get(&selection.reference.message_id)?;
        (selection.instance == scope.instance
            && selection.data_epoch == scope.data_epoch
            && selection.membership == source.membership
            && selection.admission == source.admission
            && selection.reference.revision == entry.position)
            .then(|| QuotePreview {
                selection: selection.clone(),
                author: entry.author.clone(),
                text: excerpt(&entry.document.text),
            })
    }
    /// A selection is tied to this installation, current personal grant and the
    /// exact retained message. Thread replies are valid sources as well.
    pub async fn select_quote(&self, id: String) -> Result<QuotePreview> {
        self.select_source_quote(self.0.room.0.id.clone(), id).await
    }
    pub async fn select_source_quote(&self, room: String, id: String) -> Result<QuotePreview> {
        let _serial = self.0.serial.lock().await;
        self.0.room.current().await?;
        let source = self.sources(&room).await?.ok_or_else(unavailable)?;
        let entry = source.messages.get(&id).ok_or_else(unavailable)?;
        let scope = self.0.room.0.crypto.scope();
        let selection = QuoteSelection {
            reference: QuoteReference { room_id: room, message_id: id, revision: entry.position.clone() },
            instance: scope.instance.clone(),
            data_epoch: scope.data_epoch.clone(),
            membership: source.membership.clone(),
            admission: source.admission,
        };
        let preview = self.preview(&selection, &source).ok_or_else(unavailable)?;
        self.check()?;
        self.0.state.lock().unwrap().selected_quote = Some(selection);
        Ok(preview)
    }
    pub fn cancel_quote(&self) {
        self.0.state.lock().unwrap().selected_quote = None;
    }
    pub(super) async fn validate_quotes(&self, selections: &[QuoteSelection]) -> Result<()> {
        if selections.len() > 8 {
            return Err(unavailable());
        }
        let mut seen = BTreeSet::new();
        let mut rooms = BTreeMap::new();
        for selected in selections {
            if !seen.insert((&selected.reference.room_id, &selected.reference.message_id)) {
                return Err(unavailable());
            }
            if !rooms.contains_key(&selected.reference.room_id) {
                rooms.insert(selected.reference.room_id.clone(), self.sources(&selected.reference.room_id).await?);
            }
            if rooms[&selected.reference.room_id].as_ref().and_then(|r| self.preview(selected, r)).is_none() {
                return Err(unavailable());
            }
        }
        for (room, sources) in rooms {
            if sources.as_ref().map(|s| &s.membership) != self.source_membership(&room)?.as_ref() {
                return Err(unavailable());
            }
        }
        self.check()
    }
    pub(super) async fn project_quotes(&self, messages: &mut [Message]) -> Result<Option<QuotePreview>> {
        let selected = self.0.state.lock().unwrap().selected_quote.clone();
        let mut references = messages.iter().flat_map(|m| m.quotes.clone()).collect::<Vec<_>>();
        if let Some(s) = &selected {
            references.push(s.reference.clone());
        }
        let mut sources = BTreeMap::new();
        // Fetch once per source room, then only the children of readable parents.
        for depth in 0..2 {
            let rooms = references.iter().map(|r| r.room_id.clone()).collect::<BTreeSet<_>>();
            for room in rooms {
                if !sources.contains_key(&room) {
                    sources.insert(room.clone(), self.sources(&room).await?);
                }
            }
            if depth == 0 {
                references = references
                    .iter()
                    .filter_map(|r| source(&sources, r))
                    .flat_map(|s| s.document.quotes.clone())
                    .collect();
            }
        }
        // A withdrawal/re-admission during resolution discards that whole source
        // room. Re-observe the signed private authority before exposing excerpts.
        for (room, value) in &mut sources {
            if let Some(previous) = value {
                let fresh = self.sources(room).await?;
                if fresh
                    .as_ref()
                    .is_none_or(|s| s.membership != previous.membership || s.admission != previous.admission)
                {
                    *value = None;
                } else {
                    *value = fresh;
                }
            }
        }
        for message in messages {
            if message.quotes.is_empty() {
                continue;
            }
            let mut attachments = message
                .row
                .attachments
                .as_deref()
                .map(serde_json::from_str::<Vec<Value>>)
                .transpose()
                .map_err(|_| room_changed())?
                .unwrap_or_default();
            let path = vec![(message.row.rid.clone(), message.row.id.clone())];
            attachments.extend(message.quotes.iter().map(|r| quote_card(&sources, r, 1, &path)));
            message.row.attachments = Some(serde_json::to_string(&attachments).map_err(|_| room_changed())?);
        }
        let preview = selected
            .as_ref()
            .and_then(|s| sources.get(&s.reference.room_id)?.as_ref().and_then(|r| self.preview(s, r)));
        {
            let mut state = self.0.state.lock().unwrap();
            if state.selected_quote == selected && preview.is_none() {
                state.selected_quote = None;
            }
        }
        self.check()?;
        Ok(preview)
    }
}
fn excerpt(text: &str) -> String {
    text.chars().take(1024).collect()
}
fn source<'a>(sources: &'a BTreeMap<String, Option<RoomSources>>, reference: &QuoteReference) -> Option<&'a Source> {
    sources.get(&reference.room_id)?.as_ref()?.messages.get(&reference.message_id)
}
fn quote_card(
    sources: &BTreeMap<String, Option<RoomSources>>,
    reference: &QuoteReference,
    depth: usize,
    path: &[(String, String)],
) -> Value {
    let entry = source(sources, reference)
        .filter(|_| !path.contains(&(reference.room_id.clone(), reference.message_id.clone())));
    let mut card =
        json!({"message_link":"", "native_reference":reference, "native_unavailable":entry.is_none(), "text":""});
    if let Some(entry) = entry {
        let text = excerpt(&entry.document.text);
        card["author_name"] = json!(entry.author);
        card["md"] = json!(crate::native::markdown::tree(&rv_protocol::markdown::parse(&text)));
        card["text"] = json!(text);
        if depth < 2 && !entry.document.quotes.is_empty() {
            let mut next = path.to_vec();
            next.push((reference.room_id.clone(), reference.message_id.clone()));
            card["attachments"] = json!(
                entry.document.quotes.iter().map(|r| quote_card(sources, r, depth + 1, &next)).collect::<Vec<_>>()
            );
        }
    }
    card
}

#[cfg(test)]
mod tests {
    use super::*;
    fn reference(room: &str, id: &str) -> QuoteReference {
        QuoteReference { room_id: room.into(), message_id: id.into(), revision: "1".into() }
    }
    fn entry(text: &str, quotes: Vec<QuoteReference>) -> Source {
        Source {
            document: SendMessage {
                operation_id: "source".into(),
                text: text.into(),
                reply_to: None,
                quotes,
                cards: vec![],
            },
            position: "9007199254740995".into(),
            author: "reader-visible-author".into(),
        }
    }
    #[test]
    fn private_quote_cards_bound_unicode_depth_cycles_and_each_source_room() {
        let parent = reference("room-a", "same-id");
        let child = reference("room-b", "same-id");
        let hidden = reference("withdrawn", "private-child");
        let grandchild = reference("room-b", "terminal");
        let mut sources = BTreeMap::new();
        sources.insert(
            "room-a".into(),
            Some(RoomSources {
                membership: "a".into(),
                admission: [1; 32],
                messages: BTreeMap::from([(
                    "same-id".into(),
                    entry(&"🐾".repeat(1025), vec![child.clone(), hidden.clone(), parent.clone()]),
                )]),
            }),
        );
        sources.insert(
            "room-b".into(),
            Some(RoomSources {
                membership: "b".into(),
                admission: [2; 32],
                messages: BTreeMap::from([
                    ("same-id".into(), entry("**current source**", vec![grandchild])),
                    ("terminal".into(), entry("must not expose a third level", vec![])),
                ]),
            }),
        );
        sources.insert("withdrawn".into(), None);
        let value = quote_card(&sources, &parent, 1, &[]);
        assert_eq!(value["text"].as_str().unwrap().chars().count(), 1024);
        assert_eq!(
            value["attachments"][0]["text"], "**current source**",
            "same IDs in different source rooms are not cycles"
        );
        assert!(value["attachments"][0].get("attachments").is_none(), "only two levels are resolved");
        for index in [1, 2] {
            let unavailable = &value["attachments"][index];
            assert_eq!(unavailable["native_unavailable"], true);
            assert_eq!(unavailable["text"], "");
            assert!(
                unavailable.get("author_name").is_none()
                    && unavailable.get("md").is_none()
                    && unavailable.get("attachments").is_none()
            );
        }
        sources.insert("room-a".into(), None);
        let unavailable = quote_card(&sources, &parent, 1, &[]);
        assert_eq!(unavailable["native_unavailable"], true);
        assert!(unavailable.get("attachments").is_none(), "withdrawn parents do not expose child references");
    }
}
